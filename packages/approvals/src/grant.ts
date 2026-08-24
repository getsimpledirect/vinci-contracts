import type { Actor, RunId, SchemaMeta, Timestamp, ValidationResult } from "@getsimpledirect/vinci-contracts";
import { fail, ok, toPlainRecord, ownData } from "@getsimpledirect/vinci-contracts";
import {
  collectUnknownFields,
  isActor,
  isNonEmptyString,
  isObject,
  isPositiveInteger,
  isTimestamp,
  issue,
} from "./validation.ts";

export const GRANT_SHAPE_KINDS = [
  "deny",
  "allow-automatically",
  "require-person",
  "require-role",
  "require-two-people",
  "expire-at",
  "allow-once",
  "allow-remainder-of-run",
  "allow-bounded",
] as const;

export type GrantShapeKind = (typeof GRANT_SHAPE_KINDS)[number];

export type GrantShape =
  | { readonly kind: "deny" }
  | { readonly kind: "allow-automatically" }
  | { readonly kind: "require-person"; readonly person: Actor }
  | { readonly kind: "require-role"; readonly roleId: string }
  | { readonly kind: "require-two-people" }
  | { readonly kind: "expire-at"; readonly expiresAt: Timestamp }
  | { readonly kind: "allow-once" }
  | { readonly kind: "allow-remainder-of-run"; readonly runId: RunId }
  | {
      readonly kind: "allow-bounded";
      readonly resourceId: string;
      readonly durationMs: number;
    };

export type ApprovalGrant = {
  readonly shape: GrantShape;
  readonly approver?: Actor;
  readonly approvedAt?: Timestamp;
};

export const GRANT_SHAPE_SCHEMA_META = {
  id: "vinci.grant-shape",
  version: 1,
  compatibility: "additive-only",
  unknownFields: "preserve",
  malformedData: "fail-closed",
  migration: "none",
} as const satisfies SchemaMeta;

export const APPROVAL_GRANT_SCHEMA_META = {
  id: "vinci.approval-grant",
  version: 1,
  compatibility: "additive-only",
  unknownFields: "preserve",
  malformedData: "fail-closed",
  migration: "none",
} as const satisfies SchemaMeta;

export function validateGrantShape(input: unknown): ValidationResult<GrantShape> {
  // Snapshot before inspecting: refuses prototypes carrying inherited fields,
  // accessors that can answer differently on each read, and symbol or
  // non-enumerable keys an unknown-field check would never see.
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  input = plain.value;
  if (!isObject(input)) return fail([issue("/", "invalid_type", "grant shape must be an object")]);
  if (typeof input.kind !== "string" || !(GRANT_SHAPE_KINDS as readonly string[]).includes(input.kind)) {
    return fail([issue("/kind", "invalid_discriminator", "grant shape kind is not recognized")]);
  }

  const unknownFields: Record<string, unknown> = {};
  let known = ["kind"];
  switch (input.kind as GrantShapeKind) {
    case "deny":
    case "allow-automatically":
    case "require-two-people":
    case "allow-once":
      break;
    case "require-person":
      known = [...known, "person"];
      if (!isActor(input.person)) {
        return fail([issue("/person", "invalid_actor", "person must be a valid Actor")]);
      }
      collectUnknownFields(input.person, actorFields(input.person), "/person", unknownFields);
      break;
    case "require-role":
      known = [...known, "roleId"];
      if (!isNonEmptyString(input.roleId)) {
        return fail([issue("/roleId", "invalid_value", "roleId must be a non-empty string")]);
      }
      break;
    case "expire-at":
      known = [...known, "expiresAt"];
      if (!isTimestamp(input.expiresAt)) {
        return fail([issue("/expiresAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z")]);
      }
      break;
    case "allow-remainder-of-run":
      known = [...known, "runId"];
      if (!isNonEmptyString(input.runId)) {
        return fail([issue("/runId", "invalid_id", "runId must be a non-empty branded id")]);
      }
      break;
    case "allow-bounded":
      known = [...known, "resourceId", "durationMs"];
      if (!isNonEmptyString(input.resourceId)) {
        return fail([issue("/resourceId", "invalid_id", "resourceId must be a non-empty string")]);
      }
      if (!isPositiveInteger(input.durationMs)) {
        return fail([issue("/durationMs", "invalid_duration", "durationMs must be a positive integer")]);
      }
      break;
  }
  collectUnknownFields(input, known, "", unknownFields);
  return ok(input as GrantShape, unknownFields);
}

export function validateApprovalGrant(input: unknown): ValidationResult<ApprovalGrant> {
  // Snapshot before inspecting: refuses prototypes carrying inherited fields,
  // accessors that can answer differently on each read, and symbol or
  // non-enumerable keys an unknown-field check would never see.
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  input = plain.value;
  if (!isObject(input)) return fail([issue("/", "invalid_type", "approval grant must be an object")]);
  const shape = validateGrantShape(input.shape);
  if (!shape.ok) return fail(shape.issues.map((entry) => ({ ...entry, path: `/shape${entry.path}` })));
  if (input.approver !== undefined && !isActor(input.approver)) {
    return fail([issue("/approver", "invalid_actor", "approver must be a valid Actor")]);
  }
  if (input.approvedAt !== undefined && !isTimestamp(input.approvedAt)) {
    return fail([issue("/approvedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z")]);
  }
  const unknownFields: Record<string, unknown> = {};
  collectUnknownFields(input, ["shape", "approver", "approvedAt"], "", unknownFields);
  for (const [path, value] of Object.entries(shape.unknownFields)) unknownFields[`/shape${path}`] = value;
  if (isObject(input.approver)) {
    collectUnknownFields(input.approver, actorFields(input.approver), "/approver", unknownFields);
  }
  return ok(input as ApprovalGrant, unknownFields);
}

function actorFields(actor: Readonly<Record<string, unknown>>): readonly string[] {
  switch (actor.kind) {
    case "user": return ["kind", "userId", "deviceId"];
    case "worker": return ["kind", "workerId"];
    case "policy": return ["kind", "policyId", "policyVersion"];
    case "system": return ["kind", "component"];
    case "verifier": return ["kind", "verifierId", "independent"];
    default: return ["kind"];
  }
}

/**
 * This is deliberately a closed, conservative subset relation. If a new shape
 * cannot be proven to grant no more authority, it is rejected instead of being
 * guessed safe; callers therefore cannot turn "narrower" into an escalation.
 */
export function isGrantStrictlyNarrower(candidate: GrantShape, requested: GrantShape): boolean {
  const candidateKind = ownData(candidate, "kind");
  const requestedKind = ownData(requested, "kind");
  
  if (candidateKind === "deny") return requestedKind !== "deny";
  if (requestedKind === "deny") return false;
  if (requestedKind === "allow-automatically") return candidateKind !== "allow-automatically";

  if (candidateKind === "allow-bounded" && requestedKind === "allow-bounded") {
    const candidateResourceId = ownData(candidate, "resourceId");
    const requestedResourceId = ownData(requested, "resourceId");
    const candidateDurationMs = ownData(candidate, "durationMs");
    const requestedDurationMs = ownData(requested, "durationMs");
    return candidateResourceId === requestedResourceId && typeof candidateDurationMs === "number" && typeof requestedDurationMs === "number" && candidateDurationMs < requestedDurationMs;
  }
  if (candidateKind === "expire-at" && requestedKind === "expire-at") {
    const candidateExpiresAt = ownData(candidate, "expiresAt");
    const requestedExpiresAt = ownData(requested, "expiresAt");
    if (typeof candidateExpiresAt !== "string" || typeof requestedExpiresAt !== "string") return false;
    return Date.parse(candidateExpiresAt) < Date.parse(requestedExpiresAt);
  }
  if (requestedKind === "allow-remainder-of-run") {
    if (candidateKind === "allow-once" || candidateKind === "allow-bounded" || candidateKind === "expire-at") {
      return true;
    }
    return false;
  }
  return false;
}
