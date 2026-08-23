import {
  fail,
  ok,
  VERDICT_STATUSES,
  type ValidationIssue,
  type ValidationResult,
} from "@vinci/contracts";
import {
  EVIDENCE_KINDS,
  EVIDENCE_SOURCE_KINDS,
} from "./evidence-kinds.ts";
import type { EvidenceRecord } from "./evidence-record.ts";
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
  if (typeof value !== "string" || value.length === 0) {
    addIssue(issues, path, "invalid_string", "expected a non-empty string");
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
  // The round-trip is the load-bearing part. Date.parse normalises impossible
  // dates rather than rejecting them, so "2026-02-29T12:34:56.789Z" — a date
  // that does not exist, 2026 not being a leap year — parses to March 1 and
  // passes both the shape and the NaN check. model-classes and approvals both
  // carry this comparison; evidence did not, so the two packages disagreed
  // about what a malformed timestamp is.
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    addIssue(issues, path, "invalid_timestamp", "expected an ISO-8601 UTC timestamp with millisecond precision");
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
      requiredString(object.userId, `${path}/userId`, issues);
      if (object.deviceId !== undefined) requiredString(object.deviceId, `${path}/deviceId`, issues);
      break;
    case "worker":
      requiredString(object.workerId, `${path}/workerId`, issues);
      break;
    case "policy":
      requiredString(object.policyId, `${path}/policyId`, issues);
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
        `evidence with ${String(object.provenance)} provenance must be attested by an actor of kind "${expected}", not "${String(actor.kind)}"`,
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

export function validateEvidenceRecord(input: unknown): ValidationResult<EvidenceRecord> {
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
      "summary",
      "recordedAt",
    ],
    issues,
    unknownFields,
  );
  if (!object) return fail(issues);

  literalOne(object.schemaVersion, "/schemaVersion", issues);
  requiredString(object.id, "/id", issues);
  validateAttestation(object.attestation, issues, unknownFields);
  enumValue(object.kind, EVIDENCE_KINDS, "/kind", issues);
  enumValue(object.mode, EVIDENCE_MODES, "/mode", issues);
  enumValue(object.reliability, EVIDENCE_RELIABILITIES, "/reliability", issues);
  enumValue(object.sourceKind, EVIDENCE_SOURCE_KINDS, "/sourceKind", issues);
  requiredString(object.summary, "/summary", issues);
  timestamp(object.recordedAt, "/recordedAt", issues);

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
  if (Object.hasOwn(object, field) && object[field] !== undefined) {
    addIssue(
      issues,
      path,
      "field_not_valid_for_kind",
      `${field} does not belong on this kind of assessment and must not be carried`,
    );
  }
}

export function validateVerdictAssessment(input: unknown): ValidationResult<VerdictAssessment> {
  const issues: ValidationIssue[] = [];
  const unknownFields: UnknownFields = {};
  const object = objectValue(
    input,
    "",
    ["kind", "status", "reason", "triggers"],
    issues,
    unknownFields,
  );
  if (!object) return fail(issues);
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
    rejectPresentField(object, "status", "/status", issues);
  }

  if (issues.length > 0) return fail(issues);
  return ok(input as VerdictAssessment, unknownFields);
}
