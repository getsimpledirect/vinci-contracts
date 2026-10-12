import {
  canonicalize, fail, isCanonicalTimestamp, isDigest, isIdentifier, isNonBlankText,
  ok, toPlainRecord,
  type RunId, type SchemaMeta, type UserId,
  type ValidationIssue, type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { sha256Hex, workOrderDigest } from "./digest.ts";
import { validateWorkOrder } from "./work-order.ts";

/** Personal identity owned by an EXISTING authorized user. Never a model/provider identity. */
export type VeroAssistantV1 = {
  readonly schemaVersion: 1;
  readonly assistantId: string;
  readonly ownerId: UserId;
  readonly displayName: string;
  readonly revision: number;
  readonly pauseEpoch: number;
  readonly paused: boolean;
};

/** Explicit selection metadata only: no source content, keys, history, or inferred memory. */
export type VeroContextReferenceV1 = {
  readonly sourceId: string;
  readonly sourceRevision: number;
  readonly ref: string;
  readonly digest: string;
  readonly purpose: string;
  readonly provenance: {
    readonly kind: "explicit-selection";
    readonly selectedBy: UserId;
    readonly selectedAt: string;
  };
  /** Revocation is explicit, never absence. A revoked selection cannot bind a new occurrence. */
  readonly revokedAt: string | null;
};

export type VeroResponsibilityDefinitionV1 = {
  readonly goal: string;
  readonly instructions: string;
  readonly contexts: readonly VeroContextReferenceV1[];
  readonly sourceIds: readonly string[];
  /** Requested scope, NOT a grant. Host membership/grant checks are still required. */
  readonly permissions: readonly ("read" | "draft")[];
  readonly schedule: { readonly kind: "daily"; readonly timeZone: string; readonly minuteOfDay: number; readonly graceMinutes: number };
  readonly quietHours: { readonly kind: "none" | "all-day" } | { readonly kind: "window"; readonly startMinute: number; readonly endMinute: number };
  readonly notifyInitial: boolean;
  readonly expiresAt: string;
  readonly maxOccurrences: number;
  readonly maxAttempts: number;
  readonly budget: {
    readonly maxRuntimeS: number; readonly maxToolCalls: number; readonly maxTurns: number;
    readonly maxCashCostMicrousd: number; readonly maxListCostMicrousd: number;
  };
  readonly totalBudget: { readonly maxCashCostMicrousd: number; readonly maxListCostMicrousd: number };
};

export type VeroResponsibilityV1 = {
  readonly schemaVersion: 1;
  readonly responsibilityId: string;
  readonly ownerId: UserId;
  readonly assistantId: string;
  readonly revision: number;
  readonly pauseEpoch: number;
  readonly paused: boolean;
  readonly revoked: boolean;
  readonly consentedAt: string;
  readonly definition: VeroResponsibilityDefinitionV1;
};

/** Only a BOUND occurrence: refers to the existing canonical run/order, never a second task engine. */
export type VeroOccurrenceBindingV1 = {
  readonly schemaVersion: 1;
  readonly occurrenceId: string;
  readonly ownerId: UserId;
  readonly assistantId: string;
  readonly assistantRevision: number;
  readonly assistantPauseEpoch: number;
  readonly responsibilityId: string;
  readonly responsibilityRevision: number;
  readonly responsibilityPauseEpoch: number;
  readonly responsibilityDigest: string;
  readonly runId: RunId;
  readonly workOrderId: string;
  readonly workOrderVersion: number;
  readonly workOrderDigest: string;
  /** Opaque layer-3 reference. Host must recompute from a validated ContextManifest. */
  readonly contextManifestDigest: string;
};

/**
 * Host-supplied anchor, loaded independently of ALL client-supplied records.
 * Its shape is not its authority. Obtain owner from authenticated session;
 * identities, revisions, digests and run mapping from trusted host storage.
 * Never construct this by copying the candidate binding. Even consistent lies
 * across assistant, responsibility, order and occurrence must disagree here.
 */
export type VeroHostBindingAnchorV1 = Omit<VeroOccurrenceBindingV1, "ownerId"> & {
  readonly authenticatedOwnerId: UserId;
  /** Trusted host time; binding also refuses expired responsibility/order. */
  readonly observedAt: string;
};

type RecordValue = Record<string, unknown>;
type Issues = ValidationIssue[];
function add(issues: Issues, path: string, code: string, message: string): void {
  issues.push({ path, code, message });
}
function object(value: unknown, fields: readonly string[], path: string, issues: Issues): RecordValue | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    add(issues, path, "invalid_type", "expected an object");
    return null;
  }
  const record = value as RecordValue;
  for (const field of Object.keys(record)) {
    if (!fields.includes(field)) add(issues, `${path}/${field.replaceAll("~", "~0").replaceAll("/", "~1")}`, "unknown_field", "only declared fields are accepted");
  }
  return record;
}
function scalar(record: RecordValue, field: string, valid: (value: unknown) => boolean, path: string, issues: Issues): void {
  if (!valid(record[field])) add(issues, `${path}/${field}`, "invalid_field", "required field has an invalid value");
}
const positive = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) > 0;
const nonnegative = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 0;
const boolean = (value: unknown): boolean => typeof value === "boolean";
const text = (max: number) => (value: unknown): boolean => isNonBlankText(value) && value.length <= max;
const minute = (value: unknown): boolean => nonnegative(value) && (value as number) < 1440;
function version(record: RecordValue, issues: Issues): void {
  if (record.schemaVersion !== 1) add(issues, "/schemaVersion", "unsupported_schema_version", "schemaVersion 1 is required; no implicit migration");
}
function uniqueStrings(value: unknown, path: string, valid: (value: unknown) => boolean, issues: Issues, min = 0): void {
  if (!Array.isArray(value) || value.length < min || value.length > 100) {
    add(issues, path, "invalid_array", "expected a bounded array with at most 100 entries");
    return;
  }
  const seen = new Set<unknown>();
  value.forEach((entry, index) => {
    if (!valid(entry)) add(issues, `${path}/${index}`, "invalid_field", "invalid array entry");
    if (seen.has(entry)) add(issues, `${path}/${index}`, "duplicate_entry", "entries must be unique");
    seen.add(entry);
  });
}
function result<T>(record: RecordValue, issues: Issues): ValidationResult<T> {
  return issues.length > 0 ? fail(issues) : ok(record as unknown as T);
}

export function validateVeroAssistantV1(input: unknown): ValidationResult<VeroAssistantV1> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const issues: Issues = [];
  const r = object(plain.value, ["schemaVersion", "assistantId", "ownerId", "displayName", "revision", "pauseEpoch", "paused"], "", issues);
  if (r === null) return fail(issues);
  version(r, issues);
  for (const f of ["assistantId", "ownerId"]) scalar(r, f, isIdentifier, "", issues);
  scalar(r, "displayName", text(100), "", issues);
  scalar(r, "revision", positive, "", issues);
  scalar(r, "pauseEpoch", nonnegative, "", issues);
  scalar(r, "paused", boolean, "", issues);
  return result(r, issues);
}

function checkContext(raw: unknown, path: string, ownerId: unknown, consentedAt: unknown, issues: Issues): void {
  const r = object(raw, ["sourceId", "sourceRevision", "ref", "digest", "purpose", "provenance", "revokedAt"], path, issues);
  if (r === null) return;
  scalar(r, "sourceId", isIdentifier, path, issues);
  scalar(r, "sourceRevision", positive, path, issues);
  scalar(r, "ref", text(512), path, issues);
  scalar(r, "digest", isDigest, path, issues);
  scalar(r, "purpose", text(2000), path, issues);
  scalar(r, "revokedAt", v => v === null || isCanonicalTimestamp(v), path, issues);
  const p = object(r.provenance, ["kind", "selectedBy", "selectedAt"], `${path}/provenance`, issues);
  if (p !== null) {
    scalar(p, "kind", v => v === "explicit-selection", `${path}/provenance`, issues);
    scalar(p, "selectedBy", isIdentifier, `${path}/provenance`, issues);
    scalar(p, "selectedAt", isCanonicalTimestamp, `${path}/provenance`, issues);
    if (p.selectedBy !== ownerId) add(issues, `${path}/provenance/selectedBy`, "owner_mismatch", "selection must be attributed to the responsibility owner");
    if (isCanonicalTimestamp(p.selectedAt) && isCanonicalTimestamp(consentedAt) && p.selectedAt > consentedAt) add(issues, `${path}/provenance/selectedAt`, "selection_after_consent", "selection must precede or equal consent");
    if (isCanonicalTimestamp(p.selectedAt) && isCanonicalTimestamp(r.revokedAt) && r.revokedAt < p.selectedAt) add(issues, `${path}/revokedAt`, "revocation_before_selection", "revocation cannot precede selection");
  }
}
function checkDefinition(raw: unknown, ownerId: unknown, consentedAt: unknown, issues: Issues): void {
  const path = "/definition";
  const d = object(raw, ["goal", "instructions", "contexts", "sourceIds", "permissions", "schedule", "quietHours", "notifyInitial", "expiresAt", "maxOccurrences", "maxAttempts", "budget", "totalBudget"], path, issues);
  if (d === null) return;
  scalar(d, "goal", text(4000), path, issues);
  scalar(d, "instructions", text(16000), path, issues);
  scalar(d, "notifyInitial", boolean, path, issues);
  scalar(d, "expiresAt", isCanonicalTimestamp, path, issues);
  scalar(d, "maxOccurrences", positive, path, issues);
  scalar(d, "maxAttempts", positive, path, issues);
  if (isCanonicalTimestamp(d.expiresAt) && isCanonicalTimestamp(consentedAt) && d.expiresAt <= consentedAt) add(issues, `${path}/expiresAt`, "expiry_not_after_consent", "expiry must be after consent");
  uniqueStrings(d.sourceIds, `${path}/sourceIds`, isIdentifier, issues);
  uniqueStrings(d.permissions, `${path}/permissions`, v => v === "read" || v === "draft", issues, 1);
  if (!Array.isArray(d.contexts) || d.contexts.length > 100) {
    add(issues, `${path}/contexts`, "invalid_array", "contexts must be an explicit array with at most 100 selections");
  } else {
    const seen = new Set<unknown>();
    d.contexts.forEach((c: unknown, i: number) => {
      const p = `${path}/contexts/${i}`;
      checkContext(c, p, ownerId, consentedAt, issues);
      if (typeof c !== "object" || c === null || Array.isArray(c)) return;
      const context = c as RecordValue;
      if (seen.has(context.ref)) add(issues, `${p}/ref`, "duplicate_context", "context references must be unique");
      seen.add(context.ref);
      if (!Array.isArray(d.sourceIds) || !d.sourceIds.includes(context.sourceId)) add(issues, `${p}/sourceId`, "source_not_selected", "context source must be explicitly selected");
    });
  }
  const schedule = object(d.schedule, ["kind", "timeZone", "minuteOfDay", "graceMinutes"], `${path}/schedule`, issues);
  if (schedule !== null) {
    scalar(schedule, "kind", v => v === "daily", `${path}/schedule`, issues);
    // No evaluation of schedules here. Runtime timezone/DST rules remain host-owned.
    scalar(schedule, "timeZone", v => typeof v === "string" && v.length <= 100 && /^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+.-]+)+)$/.test(v), `${path}/schedule`, issues);
    scalar(schedule, "minuteOfDay", minute, `${path}/schedule`, issues);
    scalar(schedule, "graceMinutes", v => positive(v) && (v as number) <= 1440, `${path}/schedule`, issues);
  }
  const quiet = object(d.quietHours, ["kind", "startMinute", "endMinute"], `${path}/quietHours`, issues);
  if (quiet !== null) {
    scalar(quiet, "kind", v => v === "none" || v === "all-day" || v === "window", `${path}/quietHours`, issues);
    if (quiet.kind === "window") {
      scalar(quiet, "startMinute", minute, `${path}/quietHours`, issues);
      scalar(quiet, "endMinute", minute, `${path}/quietHours`, issues);
      if (quiet.startMinute === quiet.endMinute) add(issues, `${path}/quietHours`, "empty_quiet_window", "equal endpoints are ambiguous; use none or all-day explicitly");
    } else {
      for (const f of ["startMinute", "endMinute"]) if (Object.hasOwn(quiet, f)) add(issues, `${path}/quietHours/${f}`, "unknown_field", "only a window carries endpoints");
    }
  }
  const costs = ["maxCashCostMicrousd", "maxListCostMicrousd"];
  const budget = object(d.budget, [...costs, "maxRuntimeS", "maxToolCalls", "maxTurns"], `${path}/budget`, issues);
  const total = object(d.totalBudget, costs, `${path}/totalBudget`, issues);
  if (budget !== null) {
    for (const f of costs) scalar(budget, f, nonnegative, `${path}/budget`, issues);
    for (const f of ["maxRuntimeS", "maxToolCalls", "maxTurns"]) scalar(budget, f, positive, `${path}/budget`, issues);
  }
  if (total !== null) for (const f of costs) {
    scalar(total, f, nonnegative, `${path}/totalBudget`, issues);
    if (budget !== null && nonnegative(budget[f]) && nonnegative(total[f]) && (budget[f] as number) > (total[f] as number)) add(issues, `${path}/totalBudget/${f}`, "task_exceeds_total", "per-task budget cannot exceed lifetime budget");
  }
}

export function validateVeroResponsibilityV1(input: unknown): ValidationResult<VeroResponsibilityV1> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const issues: Issues = [];
  const r = object(plain.value, ["schemaVersion", "responsibilityId", "ownerId", "assistantId", "revision", "pauseEpoch", "paused", "revoked", "consentedAt", "definition"], "", issues);
  if (r === null) return fail(issues);
  version(r, issues);
  for (const f of ["responsibilityId", "ownerId", "assistantId"]) scalar(r, f, isIdentifier, "", issues);
  scalar(r, "revision", positive, "", issues);
  scalar(r, "pauseEpoch", nonnegative, "", issues);
  for (const f of ["paused", "revoked"]) scalar(r, f, boolean, "", issues);
  scalar(r, "consentedAt", isCanonicalTimestamp, "", issues);
  if (r.revoked === true && r.paused !== true) add(issues, "/paused", "revoked_must_be_paused", "a revoked responsibility must be paused");
  checkDefinition(r.definition, r.ownerId, r.consentedAt, issues);
  return result(r, issues);
}

const BINDING_FIELDS = ["schemaVersion", "occurrenceId", "ownerId", "assistantId", "assistantRevision", "assistantPauseEpoch", "responsibilityId", "responsibilityRevision", "responsibilityPauseEpoch", "responsibilityDigest", "runId", "workOrderId", "workOrderVersion", "workOrderDigest", "contextManifestDigest"] as const;
function checkBinding(r: RecordValue, issues: Issues, anchor: boolean): void {
  version(r, issues);
  for (const f of ["occurrenceId", anchor ? "authenticatedOwnerId" : "ownerId", "assistantId", "responsibilityId", "runId", "workOrderId"]) scalar(r, f, isIdentifier, "", issues);
  for (const f of ["assistantRevision", "responsibilityRevision", "workOrderVersion"]) scalar(r, f, positive, "", issues);
  for (const f of ["assistantPauseEpoch", "responsibilityPauseEpoch"]) scalar(r, f, nonnegative, "", issues);
  for (const f of ["responsibilityDigest", "workOrderDigest", "contextManifestDigest"]) scalar(r, f, isDigest, "", issues);
  if (anchor) scalar(r, "observedAt", isCanonicalTimestamp, "", issues);
}
export function validateVeroOccurrenceBindingV1(input: unknown): ValidationResult<VeroOccurrenceBindingV1> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const issues: Issues = [];
  const r = object(plain.value, BINDING_FIELDS, "", issues);
  if (r === null) return fail(issues);
  checkBinding(r, issues, false);
  return result(r, issues);
}
export function validateVeroHostBindingAnchorV1(input: unknown): ValidationResult<VeroHostBindingAnchorV1> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const issues: Issues = [];
  const r = object(plain.value, [...BINDING_FIELDS.filter(f => f !== "ownerId"), "authenticatedOwnerId", "observedAt"], "", issues);
  if (r === null) return fail(issues);
  checkBinding(r, issues, true);
  return result(r, issues);
}

/** Every validated field is covered, including consent, revisions, selections and revocations. */
export function veroResponsibilityDigestV1(input: VeroResponsibilityV1): string {
  const validated = validateVeroResponsibilityV1(input);
  if (!validated.ok) throw new Error("cannot digest an invalid Vero responsibility");
  return sha256Hex(canonicalize(validated.value));
}

/**
 * Pure consistency check, NOT authentication, membership, consent verification,
 * authorization, uniqueness, budget reservation, revocation service or execution.
 * The host checks current grants and ContextManifest contents before this call,
 * and atomically fences authority/reservations again before admitting work.
 */
export function bindVeroOccurrenceV1(
  occurrenceInput: unknown,
  assistantInput: unknown,
  responsibilityInput: unknown,
  orderInput: unknown,
  hostAnchorInput: unknown,
): ValidationResult<VeroOccurrenceBindingV1> {
  const o = validateVeroOccurrenceBindingV1(occurrenceInput);
  if (!o.ok) return o;
  const a = validateVeroAssistantV1(assistantInput);
  if (!a.ok) return fail(a.issues.map(i => ({ ...i, path: `/assistant${i.path}` })));
  const r = validateVeroResponsibilityV1(responsibilityInput);
  if (!r.ok) return fail(r.issues.map(i => ({ ...i, path: `/responsibility${i.path}` })));
  const w = validateWorkOrder(orderInput);
  if (!w.ok) return fail(w.issues.map(i => ({ ...i, path: `/workOrder${i.path}` })));
  const h = validateVeroHostBindingAnchorV1(hostAnchorInput);
  if (!h.ok) return fail(h.issues.map(i => ({ ...i, path: `/hostAnchor${i.path}` })));
  const binding = o.value, assistant = a.value, responsibility = r.value, order = w.value, host = h.value;
  const issues: Issues = [];
  for (const field of BINDING_FIELDS) {
    const expected = field === "ownerId" ? host.authenticatedOwnerId : host[field];
    if (binding[field] !== expected) add(issues, `/${field}`, "host_anchor_mismatch", "binding differs from independent host anchor");
  }
  const ownerId = host.authenticatedOwnerId;
  if (assistant.ownerId !== ownerId || responsibility.ownerId !== ownerId || order.owner.kind !== "user" || order.owner.userId !== ownerId) add(issues, "/ownerId", "owner_mismatch", "every bound record must belong to the authenticated owner");
  if (assistant.assistantId !== binding.assistantId || responsibility.assistantId !== binding.assistantId || assistant.revision !== binding.assistantRevision || assistant.pauseEpoch !== binding.assistantPauseEpoch) add(issues, "/assistantId", "assistant_binding_mismatch", "assistant identity or fence differs");
  if (responsibility.responsibilityId !== binding.responsibilityId || responsibility.revision !== binding.responsibilityRevision || responsibility.pauseEpoch !== binding.responsibilityPauseEpoch || veroResponsibilityDigestV1(responsibility) !== binding.responsibilityDigest) add(issues, "/responsibilityId", "responsibility_binding_mismatch", "responsibility identity, revision, fence or digest differs");
  if (order.id !== binding.workOrderId || order.contractVersion !== binding.workOrderVersion || workOrderDigest(order) !== binding.workOrderDigest) add(issues, "/workOrderId", "work_order_binding_mismatch", "work-order identity, version or recomputed digest differs");
  if (assistant.paused || responsibility.paused || responsibility.revoked) add(issues, "/responsibilityId", "inactive_responsibility", "paused or revoked records cannot bind new work");
  if (responsibility.definition.contexts.some(c => c.revokedAt !== null)) add(issues, "/responsibility/definition/contexts", "revoked_context", "revoked selections cannot bind new work");
  if (host.observedAt < responsibility.consentedAt || host.observedAt < order.issuedAt || host.observedAt >= responsibility.definition.expiresAt || host.observedAt >= order.expiresAt) add(issues, "/hostAnchor/observedAt", "outside_validity_window", "host time must be within responsibility and order validity windows");
  return issues.length > 0 ? fail(issues) : ok(binding);
}

const meta = (id: string): SchemaMeta => ({
  id, version: 1, compatibility: "frozen", unknownFields: "reject", malformedData: "fail-closed",
  migration: "Version 1 is explicit and closed. Missing or unsupported versions are rejected; experimental unversioned records require an explicit host migration and fresh validation. Existing WorkOrder and ExecutionSpec records are unchanged.",
});
export const VERO_ASSISTANT_V1_SCHEMA_META = meta("vinci.vero-assistant");
export const VERO_RESPONSIBILITY_V1_SCHEMA_META = meta("vinci.vero-responsibility");
export const VERO_OCCURRENCE_BINDING_V1_SCHEMA_META = meta("vinci.vero-occurrence-binding");
export const VERO_HOST_BINDING_ANCHOR_V1_SCHEMA_META = meta("vinci.vero-host-binding-anchor");
