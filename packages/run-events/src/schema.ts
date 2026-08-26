import {
  actorFieldsAreConsistent,
  fail,
  hasField,
  isActorKind,
  isCanonicalTimestamp,
  ok,
  toPlainRecord,
  type PlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
  safeLabel,
} from "@getsimpledirect/vinci-contracts";
import { isRunEventType } from "./event-types.ts";
import { PAYLOAD_FIELDS } from "./payload.ts";
import type { RunEvent } from "./event.ts";

/**
 * Re-exported from layer 0, not re-implemented.
 *
 * This rule used to live here. The verdict record in `@getsimpledirect/vinci-evidence` (layer
 * 1) needs the identical rule and cannot import upward, so the definition moved
 * to `@getsimpledirect/vinci-contracts` and this is now a re-export. The wire format is
 * unchanged — same regex, same round-trip — and there is exactly one copy, so
 * the two cannot drift the way the duplicated canonicalizer already had.
 */
export { isCanonicalTimestamp };

/** Identifiers refer to things; they are not a place to put prose. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const ENUM_PATTERN = /^[A-Za-z0-9_]{1,64}$/;

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

function validatePayloadValue(
  raw: unknown,
  field: string,
  spec: { readonly kind: string; readonly members?: readonly string[] },
  issues: ValidationIssue[],
): void {
  const path = `/payload/${field}`;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push(issue(path, "invalid_payload_value", "each payload field is a tagged value"));
    return;
  }
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "value") {
    issues.push(issue(path, "invalid_payload_value", "a tagged value carries exactly kind and value"));
    return;
  }
  if (value.kind !== spec.kind) {
    issues.push(
      issue(path, "wrong_value_kind", `this field is declared ${spec.kind}, not ${String(value.kind)}`),
    );
    return;
  }
  const inner = value.value;
  switch (spec.kind) {
    case "id":
      if (typeof inner !== "string" || !ID_PATTERN.test(inner)) {
        issues.push(issue(path, "invalid_id", "an identifier is at most 128 safe characters"));
      }
      break;
    case "digest":
      if (typeof inner !== "string" || !DIGEST_PATTERN.test(inner)) {
        issues.push(issue(path, "invalid_digest", "a digest is 64 lowercase hex characters"));
      }
      break;
    case "enum":
      if (typeof inner !== "string" || !ENUM_PATTERN.test(inner)) {
        issues.push(issue(path, "invalid_enum", "an enum member is a short symbolic token"));
      } else if (spec.members === undefined) {
        // No declared members means this is NOT a closed set, whatever the
        // field is called. ENUM_PATTERN only constrains shape, so a
        // token-shaped string of anything passes. Every enum field in
        // PAYLOAD_FIELDS now declares its members precisely so this branch is
        // unreachable; it stays as a guard against a future field being added
        // without one.
        issues.push(
          issue(path, "enum_without_members", "this field declares no closed set and cannot be validated"),
        );
      } else if (!spec.members.includes(inner)) {
        issues.push(issue(path, "unknown_enum_member", "not a member of this field's closed set"));
      }
      break;
    case "count":
      if (typeof inner !== "number" || !Number.isSafeInteger(inner) || inner < 0) {
        issues.push(issue(path, "invalid_count", "a count is a non-negative safe integer"));
      }
      break;
    case "at":
      if (!isCanonicalTimestamp(inner)) {
        issues.push(issue(path, "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z"));
      }
      break;
    case "flag":
      if (typeof inner !== "boolean") issues.push(issue(path, "invalid_flag", "a flag is a boolean"));
      break;
    default:
      issues.push(issue(path, "unknown_value_kind", "unrecognised value kind"));
  }
}

/**
 * The exact fields each actor arm requires, and their types.
 *
 * `actorFieldsAreConsistent` from @getsimpledirect/vinci-contracts answers "does this carry a
 * field its kind does not permit". That is only half the question, and relying
 * on it alone accepted `{kind:"worker"}` with no workerId at all, and
 * `{kind:"worker", workerId: 5}` with a number where an identifier belongs.
 * An allowlist of NAMES says nothing about presence or type.
 */
const ACTOR_ARMS: Readonly<
  Record<string, { readonly required: readonly string[]; readonly optionalIds: readonly string[] }>
> = {
  user: { required: ["userId"], optionalIds: ["deviceId"] },
  worker: { required: ["workerId"], optionalIds: [] },
  system: { required: ["component"], optionalIds: [] },
  policy: { required: ["policyId"], optionalIds: [] },
  verifier: { required: ["verifierId"], optionalIds: [] },
};

function validateActor(raw: unknown, issues: ValidationIssue[]): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push(issue("/actor", "invalid_actor", "an actor is an object"));
    return;
  }
  const actor = raw as Record<string, unknown>;
  if (!isActorKind(actor.kind)) {
    issues.push(issue("/actor/kind", "invalid_actor_kind", "unrecognised actor kind"));
    return;
  }
  if (!actorFieldsAreConsistent(actor)) {
    issues.push(
      issue(
        "/actor",
        "actor_identity_mismatch",
        `an actor of kind "${safeLabel(actor.kind)}" carries a field that kind does not permit`,
      ),
    );
  }

  const arm = ACTOR_ARMS[actor.kind];
  if (arm === undefined) {
    // Every Actor arm must be declared here. If contracts adds one and this is
    // not updated, refuse rather than validate nothing.
    issues.push(issue("/actor/kind", "unhandled_actor_kind", "this actor kind has no declared field rules"));
    return;
  }
  for (const field of arm.required) {
    if (!hasField(actor as PlainRecord, field)) {
      issues.push(issue(`/actor/${field}`, "required_field", `a ${actor.kind} actor requires ${field}`));
      continue;
    }
    if (typeof actor[field] !== "string" || !ID_PATTERN.test(actor[field] as string)) {
      issues.push(issue(`/actor/${field}`, "invalid_id", "an identifier is at most 128 safe characters"));
    }
  }
  for (const field of arm.optionalIds) {
    if (!hasField(actor as PlainRecord, field)) continue;
    if (typeof actor[field] !== "string" || !ID_PATTERN.test(actor[field] as string)) {
      issues.push(issue(`/actor/${field}`, "invalid_id", "an identifier is at most 128 safe characters"));
    }
  }

  // The two typed non-identifier fields the Actor union carries.
  if (actor.kind === "policy") {
    const version = actor.policyVersion;
    if (!Number.isSafeInteger(version) || (version as number) < 1) {
      issues.push(issue("/actor/policyVersion", "invalid_version", "a policy version is a positive integer"));
    }
  }
  if (actor.kind === "verifier") {
    // FR-7.3 requires non-independence to be DISCLOSED. A verifier that omits
    // the flag has disclosed nothing, so it is not optional.
    if (typeof actor.independent !== "boolean") {
      issues.push(
        issue("/actor/independent", "required_field", "a verifier must state whether it is independent"),
      );
    }
  }
}

const TOP_LEVEL_FIELDS = [
  "schemaVersion",
  "eventId",
  "runId",
  "sequence",
  "type",
  "actor",
  "occurredAt",
  "idempotencyKey",
  "traceId",
  "payload",
] as const;

/**
 * Validates a run event from untrusted input.
 *
 * TypeScript describes what a caller intends; nothing about it survives contact
 * with JSON from a device. Everything below is checked at runtime, on an inert
 * snapshot taken by `toPlainRecord`, exactly as every E0 validator does.
 */
export function validateRunEvent(input: unknown): ValidationResult<RunEvent> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;

  const issues: ValidationIssue[] = [];
  const known = new Set<string>(TOP_LEVEL_FIELDS);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      issues.push(issue(`/${key}`, "unknown_field", "an event carries only its declared fields"));
    }
  }

  if (record.schemaVersion !== 2) {
    issues.push(issue("/schemaVersion", "invalid_schema_version", "this schema is version 2"));
  }
  for (const field of ["eventId", "runId", "idempotencyKey", "traceId"] as const) {
    const value = record[field];
    if (typeof value !== "string" || !ID_PATTERN.test(value)) {
      issues.push(issue(`/${field}`, "invalid_id", "an identifier is at most 128 safe characters"));
    }
  }
  if (typeof record.sequence !== "number" || !Number.isSafeInteger(record.sequence) || record.sequence < 1) {
    // Zero is not an event. Acceptance's schema permits sequence 0 while its
    // database requires positive, and a cursor of 0 doubles as a
    // before-first-event sentinel; that ambiguity is not reproduced.
    issues.push(issue("/sequence", "invalid_sequence", "a sequence is a safe integer of at least 1"));
  }
  if (!isRunEventType(record.type)) {
    issues.push(issue("/type", "unknown_event_type", "unrecognised run event type"));
  }
  if (!isCanonicalTimestamp(record.occurredAt)) {
    issues.push(issue("/occurredAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z"));
  }
  validateActor(record.actor, issues);

  const payload = record.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    issues.push(issue("/payload", "invalid_payload", "a payload is an object"));
  } else if (isRunEventType(record.type)) {
    const spec = PAYLOAD_FIELDS[record.type];
    const fields = payload as Record<string, unknown>;
    for (const key of Object.keys(fields)) {
      if (!Object.hasOwn(spec, key)) {
        issues.push(
          issue(
            `/payload/${key}`,
            "field_not_allowed",
            `"${key}" is not a field of ${record.type}; payload fields are allowlisted per event type`,
          ),
        );
      }
    }
    for (const [key, fieldSpec] of Object.entries(spec)) {
      if (!Object.hasOwn(fields, key)) {
        if (fieldSpec.required) {
          issues.push(issue(`/payload/${key}`, "required_field", `${key} is required for ${record.type}`));
        }
        continue;
      }
      validatePayloadValue(fields[key], key, fieldSpec, issues);
    }
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as RunEvent, {});
}

export const RUN_EVENT_SCHEMA_META: SchemaMeta = {
  id: "vinci.run-event",
  version: 2,
  /**
   * FROZEN, not additive-only, and the pair below is why.
   *
   * E0 defines additive-only as "new optional fields and new union members may
   * be added; consumers must tolerate both". A validator that REJECTS unknown
   * fields does not tolerate them — an older consumer handed a newer event
   * carrying a new field refuses it outright. Declaring additive-only beside
   * `unknownFields: "reject"` claimed a compatibility this schema does not
   * provide, which is the same defect as a SchemaMeta advertising behaviour its
   * validator lacks.
   *
   * So additions are version bumps. That is a real cost — every new event type
   * or payload field becomes a coordinated change rather than a free one — and
   * it is the deliberate price of the choice below.
   */
  compatibility: "frozen",
  /**
   * Rejected, and this is a considered DEVIATION from D4, which names events
   * specifically as preserving unknown fields so an append-only log survives a
   * round trip through an older consumer.
   *
   * Two E0 principles genuinely conflict here. D4 wants preservation because
   * losing a newer producer's field costs replay fidelity. DR-3 forbids
   * operational telemetry carrying prompts, responses, files, memories,
   * evidence content or secrets, and FR-2.3 requires content-minimization.
   *
   * An unknown field is precisely a place content can sit unexamined, and the
   * payload allowlist exists to leave content nowhere to go. Preserving unknown
   * fields at the envelope would reopen at one level exactly what the allowlist
   * closes at the other, and the approvals notification already demonstrated
   * what "we will filter it later" is worth.
   *
   * Content-safety wins because DR-3 is a prohibition and replay fidelity is a
   * compatibility convenience. The cost is named rather than hidden: this log
   * does not round-trip through older consumers, and the frozen policy above is
   * how that is made survivable.
   *
   * Recorded in docs/layer2-plan.md as a deliberate deviation, not an oversight.
   */
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration:
    "version 1 events are rejected; missing historical attention measurements cannot be inferred",
};
