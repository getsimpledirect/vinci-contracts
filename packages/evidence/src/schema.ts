import {
  fail,
  ok,
  VERDICT_STATUSES,
  type ValidationIssue,
  type ValidationResult,
  toPlainRecord,
  isCanonicalTimestamp,
  isIdentifier,
  isNonBlankText,
  safeLabel,
} from "@vinci/contracts";
import {
  EVIDENCE_KINDS,
  EVIDENCE_SOURCE_KINDS,
} from "./evidence-kinds.ts";
import type { EvidenceRecord } from "./evidence-record.ts";
import { actorFieldsAreConsistent } from "@vinci/contracts";
import { EVIDENCE_OUTCOMES, isFailureOwner } from "./attribution.ts";
import { EVIDENCE_PROVENANCE_CASES, type EvidenceProvenance } from "./provenance.ts";
import {
  VERDICT_STALENESS_TRIGGERS,
  type VerdictAssessment,
} from "./verdict-assessment.ts";

type JsonObject = Record<string, unknown>;
type UnknownFields = Record<string, unknown>;

const EVIDENCE_MODES = [
  "deterministic",
  "execution",
  "visual",
  "model_judgment",
  "human_approval",
] as const;

const EVIDENCE_RELIABILITIES = [
  "authoritative",
  "strong",
  "supporting",
  "weak",
] as const;

function pointer(path: string, field: string): string {
  const escaped = field.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${escaped}`;
}

function addIssue(
  issues: ValidationIssue[],
  path: string,
  code: string,
  message: string,
): void {
  issues.push({ path: path || "/", code, message });
}

function objectValue(
  value: unknown,
  path: string,
  knownFields: readonly string[],
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
): JsonObject | undefined {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    addIssue(issues, path, "invalid_type", "expected an object");
    return undefined;
  }
  const result = value as JsonObject;
  const known = new Set(knownFields);
  for (const [field, fieldValue] of Object.entries(result)) {
    if (!known.has(field)) unknownFields[pointer(path, field)] = fieldValue;
  }
  return result;
}

function requiredString(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  // trim, not length. `"   "` has a non-zero length and carries nothing: it
  // satisfies a typeof check and a length check while telling a reader
  // nothing, which is exactly the shape a field takes when a schema demanded
  // it and the producer had nothing to put there. This helper backs every
  // actor identifier on an evidence record, so a blank workerId or verifierId
  // was attributable to nobody while still passing validation.
  if (!isNonBlankText(value)) {
    addIssue(issues, path, "invalid_string", "expected a non-empty, non-blank string");
    return false;
  }
  return true;
}

function identifier(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (!isIdentifier(value)) {
    addIssue(issues, path, "invalid_identifier", "expected an identifier of at most 128 safe characters");
    return false;
  }
  return true;
}

function requiredBoolean(value: unknown, path: string, issues: ValidationIssue[]): value is boolean {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (typeof value !== "boolean") {
    addIssue(issues, path, "invalid_type", "expected a boolean");
    return false;
  }
  return true;
}

function positiveInteger(value: unknown, path: string, issues: ValidationIssue[]): value is number {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (!Number.isInteger(value) || (value as number) < 1) {
    addIssue(issues, path, "invalid_integer", "expected a positive integer");
    return false;
  }
  return true;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
  issues: ValidationIssue[],
): value is T[number] {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (typeof value !== "string" || !values.includes(value)) {
    addIssue(issues, path, "invalid_enum", `expected one of: ${values.join(", ")}`);
    return false;
  }
  return true;
}

function literalOne(value: unknown, path: string, issues: ValidationIssue[]): value is 1 {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (value !== 1) {
    addIssue(issues, path, "invalid_literal", "expected literal value 1");
    return false;
  }
  return true;
}

function timestamp(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (!isCanonicalTimestamp(value)) {
    addIssue(issues, path, "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z");
    return false;
  }
  return true;
}

function enumArray<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
  issues: ValidationIssue[],
): value is readonly T[number][] {
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      path,
      value === undefined ? "required_field" : "invalid_type",
      value === undefined ? `${path.slice(path.lastIndexOf("/") + 1)} is required` : "expected an array",
    );
    return false;
  }
  let valid = true;
  value.forEach((entry, index) => {
    if (!enumValue(entry, values, pointer(path, String(index)), issues)) valid = false;
  });
  return valid;
}

function validateActor(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
): void {
  const object = objectValue(
    value,
    path,
    [
      "kind",
      "userId",
      "deviceId",
      "workerId",
      "policyId",
      "policyVersion",
      "component",
      "verifierId",
      "independent",
    ],
    issues,
    unknownFields,
  );
  if (!object) return;
  if (!enumValue(object.kind, ["user", "worker", "policy", "system", "verifier"] as const, `${path}/kind`, issues)) {
    return;
  }
  switch (object.kind) {
    case "user":
      identifier(object.userId, `${path}/userId`, issues);
      if (object.deviceId !== undefined) identifier(object.deviceId, `${path}/deviceId`, issues);
      break;
    case "worker":
      identifier(object.workerId, `${path}/workerId`, issues);
      break;
    case "policy":
      identifier(object.policyId, `${path}/policyId`, issues);
      positiveInteger(object.policyVersion, `${path}/policyVersion`, issues);
      break;
    case "system":
      requiredString(object.component, `${path}/component`, issues);
      break;
    case "verifier":
      requiredString(object.verifierId, `${path}/verifierId`, issues);
      requiredBoolean(object.independent, `${path}/independent`, issues);
      break;
  }
}

function validateAttestation(
  value: unknown,
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
): void {
  const path = "/attestation";
  const object = objectValue(value, path, ["provenance", "actor"], issues, unknownFields);
  if (!object) return;
  const provenanceValid = enumValue(
    object.provenance,
    EVIDENCE_PROVENANCE_CASES,
    `${path}/provenance`,
    issues,
  );
  validateActor(object.actor, `${path}/actor`, issues, unknownFields);

  // Provenance and actor were validated as two independent enums, which made
  // the pairing between them meaningless: a worker could claim
  // `independent_verifier` provenance, and a verifier explicitly flagged
  // `independent: false` could too. Both were accepted.
  //
  // That is the one thing this vocabulary exists to prevent. Architectural
  // principle 2 says the worker does not issue its own verdict, and FR-6.3
  // requires receipts to distinguish worker-provided from independent-verifier
  // evidence. Neither holds if the record can simply assert the distinction.
  if (provenanceValid && isJsonObject(object.actor)) {
    const actor = object.actor;
    const expected = ACTOR_KIND_FOR_PROVENANCE[object.provenance as EvidenceProvenance];
    if (actor.kind !== expected) {
      addIssue(
        issues,
        `${path}/actor/kind`,
        "provenance_actor_mismatch",
        `evidence with ${safeLabel(object.provenance)} provenance must be attested by an actor of kind "${expected}", not "${safeLabel(actor.kind)}"`,
      );
    }
    // An actor must carry exactly the fields its own kind permits.
    //
    // This was a hand-written list of FOREIGN fields per kind, and it omitted
    // `independent` and `policyVersion` — so a worker could carry
    // `independent: true` and assert its own independence. A denylist of
    // foreign fields has that failure mode by construction; an allowlist of
    // permitted ones, derived from the Actor union in @vinci/contracts, does
    // not.
    //
    // What this still cannot do is establish that whoever submitted the record
    // IS the actor it names. That needs authenticated issuer identity and
    // belongs to whatever accepts these records. This narrows the claim; it
    // does not establish independence.
    if (!actorFieldsAreConsistent(actor)) {
      addIssue(
        issues,
        `${path}/actor`,
        "actor_identity_mismatch",
        `an actor of kind "${safeLabel(actor.kind)}" carries a field that kind does not permit`,
      );
    }
    if (object.provenance === "independent_verifier" && actor.independent !== true) {
      addIssue(
        issues,
        `${path}/actor/independent`,
        "verifier_not_independent",
        "evidence cannot claim independent-verifier provenance from a verifier that is not independent; FR-7.3 requires that non-independence be disclosed, not hidden",
      );
    }
  }
}

/**
 * Which actor kind may vouch for each provenance case.
 *
 * The mapping was previously stated in a comment on EVIDENCE_PROVENANCE_CASES
 * and enforced nowhere.
 */
const ACTOR_KIND_FOR_PROVENANCE: Readonly<Record<EvidenceProvenance, string>> = {
  worker_provided: "worker",
  system_observed: "system",
  human_provided: "user",
  independent_verifier: "verifier",
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A failing outcome must name an owner.
 *
 * The structural rule this package exists to enforce: there is no shape for
 * "this failed and I am not saying whose failure it is". An unattributed
 * failure gets read as the author's fault, and a false accusation costs more
 * than a missed finding because it is paid every time.
 */
function validateAssessment(raw: unknown, issues: ValidationIssue[]): void {
  const path = "/assessment";
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    addIssue(issues, path, "invalid_assessment", "an assessment is an object");
    return;
  }
  const value = raw as Record<string, unknown>;
  const outcome = value.outcome;
  if (!(EVIDENCE_OUTCOMES as readonly unknown[]).includes(outcome)) {
    addIssue(issues, `${path}/outcome`, "invalid_enum", "unrecognised evidence outcome");
    return;
  }
  const needsOwner = outcome === "contradicts" || outcome === "invalid";
  const keys = Object.keys(value).sort().join(",");
  const expected = needsOwner ? "failureOwner,outcome" : "outcome";
  if (keys !== expected) {
    addIssue(
      issues,
      path,
      needsOwner ? "failure_owner_required" : "field_not_valid_for_outcome",
      needsOwner
        ? "evidence that contradicts or is invalid must name whose failure it is"
        : "a non-failing outcome carries no failure owner",
    );
    return;
  }
  if (needsOwner && !isFailureOwner(value.failureOwner)) {
    addIssue(issues, `${path}/failureOwner`, "invalid_enum", "unrecognised failure owner");
  }
}

/** "Not tested" without a reason is indistinguishable from an oversight. */
function validateNotTested(raw: unknown, issues: ValidationIssue[]): void {
  if (!Array.isArray(raw)) {
    addIssue(issues, "/notTested", "invalid_type", "notTested is an array, empty if everything was checked");
    return;
  }
  raw.forEach((item, index) => {
    const path = `/notTested/${index}`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      addIssue(issues, path, "invalid_type", "each entry is an object");
      return;
    }
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).sort().join(",") !== "description,reason") {
      addIssue(issues, path, "invalid_shape", "each entry carries exactly a description and a reason");
      return;
    }
    for (const field of ["description", "reason"] as const) {
      const v = entry[field];
      if (typeof v !== "string" || v.trim() === "") {
        addIssue(issues, `${path}/${field}`, "required_field", `${field} must be a non-empty string`);
      }
    }
  });
}

export function validateEvidenceRecord(input: unknown): ValidationResult<EvidenceRecord> {
  // Snapshot before inspecting: rejects prototypes carrying inherited
  // fields, accessors that answer differently on each read, and symbol or
  // non-enumerable keys that an unknown-field check would not see.
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  input = plain.value;
  const issues: ValidationIssue[] = [];
  const unknownFields: UnknownFields = {};
  const object = objectValue(
    input,
    "",
    [
      "schemaVersion",
      "id",
      "attestation",
      "kind",
      "mode",
      "reliability",
      "sourceKind",
      "assessment",
      "notTested",
      "summary",
      "recordedAt",
    ],
    issues,
    unknownFields,
  );
  if (!object) return fail(issues);

  literalOne(object.schemaVersion, "/schemaVersion", issues);
  identifier(object.id, "/id", issues);
  validateAttestation(object.attestation, issues, unknownFields);
  enumValue(object.kind, EVIDENCE_KINDS, "/kind", issues);
  enumValue(object.mode, EVIDENCE_MODES, "/mode", issues);
  enumValue(object.reliability, EVIDENCE_RELIABILITIES, "/reliability", issues);
  enumValue(object.sourceKind, EVIDENCE_SOURCE_KINDS, "/sourceKind", issues);
  requiredString(object.summary, "/summary", issues);
  timestamp(object.recordedAt, "/recordedAt", issues);

  validateAssessment(object.assessment, issues);
  validateNotTested(object.notTested, issues);

  if (issues.length > 0) return fail(issues);
  return ok(input as EvidenceRecord, unknownFields);
}

/**
 * Reject a field belonging to a different arm of a discriminated union.
 *
 * Silently ignoring it is not equivalent: the value survives into the record
 * and is readable by anything that does not know it should not be there.
 */
function rejectPresentField(
  object: Record<string, unknown>,
  field: string,
  path: string,
  issues: ValidationIssue[],
): void {
  // Presence alone, not presence-with-a-value: `{ kind: "stale", status: undefined }`
  // still asserts the field belongs on this arm, and survives serialization
  // round-trips inconsistently.
  if (Object.hasOwn(object, field)) {
    addIssue(
      issues,
      path,
      "field_not_valid_for_kind",
      `${field} does not belong on this kind of assessment and must not be carried`,
    );
  }
}

export function validateVerdictAssessment(input: unknown): ValidationResult<VerdictAssessment> {
  // Snapshot before inspecting: refuses prototypes carrying inherited fields,
  // accessors that can answer differently on each read, and symbol or
  // non-enumerable keys an unknown-field check would never see.
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  input = plain.value;
  const issues: ValidationIssue[] = [];
  const unknownFields: UnknownFields = {};
  // VERDICT_ASSESSMENT_SCHEMA_META declares unknownFields: "reject", and this
  // previously preserved them — the metadata asserted a guarantee the code did
  // not provide, which is the exact defect this package was corrected for one
  // commit earlier. An unrecognised field on an assessment could carry
  // something like `verified: true` alongside a stale record, readable by
  // anything that does not know to ignore it.
  const object = objectValue(input, "", ["kind", "status", "reason", "triggers"], issues, unknownFields);
  if (!object) return fail(issues);
  for (const key of Object.keys(unknownFields)) {
    addIssue(
      issues,
      key,
      "unknown_assessment_field",
      "unrecognised field on a verdict assessment; an assessment decides whether something may be called verified, so it carries only what it declares",
    );
  }
  if (!enumValue(object.kind, ["current", "stale"] as const, "/kind", issues)) {
    return fail(issues);
  }

  // Each arm must reject the OTHER arm's fields, not merely ignore them.
  //
  // Both arms previously shared one known-field list, so a stale assessment
  // could carry `status: "VERIFIED_PASS"` and validate. The value round-tripped
  // intact, which means every downstream reader saw a live pass sitting inside
  // a record whose whole purpose is to say the pass is no longer current
  // (FR-7.4). The discriminant said stale; the payload said verified.
  if (object.kind === "current") {
    enumValue(object.status, VERDICT_STATUSES, "/status", issues);
    rejectPresentField(object, "reason", "/reason", issues);
    rejectPresentField(object, "triggers", "/triggers", issues);
  } else {
    requiredString(object.reason, "/reason", issues);
    enumArray(object.triggers, VERDICT_STALENESS_TRIGGERS, "/triggers", issues);
    // A stale verdict that names no trigger records nothing about why it went
    // stale, which defeats the point of keeping it visible as history.
    if (Array.isArray(object.triggers) && object.triggers.length === 0) {
      addIssue(
        issues,
        "/triggers",
        "empty_staleness_triggers",
        "a stale assessment must name at least one staleness trigger",
      );
    }
    rejectPresentField(object, "status", "/status", issues);
  }

  if (issues.length > 0) return fail(issues);
  return ok(input as VerdictAssessment, unknownFields);
}
