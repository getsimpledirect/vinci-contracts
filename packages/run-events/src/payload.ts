import { CONSEQUENTIAL_ACTION_CLASSES, RISK_LEVELS } from "@getsimpledirect/vinci-contracts";
import { RUN_EVENT_TYPES, type RunEventType } from "./event-types.ts";

/**
 * Why a run failed, was blocked, or a worker warned.
 *
 * These were declared as enums with no members, which meant the shape check
 * accepted any token-shaped string — an open set wearing a closed set's label,
 * and exactly the "asserted rather than enforced" shape this repository keeps
 * finding. Codes are closed here so the claim is true; adding one is a
 * deliberate, visible change.
 *
 * They carry no detail on purpose. A reason code says WHAT KIND of thing went
 * wrong; the particulars live where the run's own records live, not in an
 * append-only stream that DR-3 says must not carry content.
 */
export const RUN_FAILURE_CODES = [
  "worker_crashed",
  "worker_unreachable",
  "provider_error",
  "budget_exhausted",
  "runtime_exceeded",
  "internal_error",
] as const;

export const RUN_BLOCKED_CODES = [
  "awaiting_approval",
  "policy_denied",
  "policy_undetermined",
  "credential_unavailable",
  "external_dependency_unavailable",
  "verification_unavailable",
] as const;

export const WORKER_WARNING_CODES = [
  "retry_exhausted",
  "provider_stalled",
  "heartbeat_late",
  "budget_nearly_exhausted",
  "capability_denied",
  "evidence_collection_failed",
] as const;

/**
 * What a payload field may hold. Never free text.
 *
 * These refer to content without being it: an identifier, a member of a closed
 * set, a number, a content digest, an instant, a boolean.
 */
export const VALUE_KINDS = ["id", "enum", "count", "digest", "at", "flag"] as const;
export type ValueKind = (typeof VALUE_KINDS)[number];

export type PayloadValue =
  | { readonly kind: "id"; readonly value: string }
  | { readonly kind: "enum"; readonly value: string }
  | { readonly kind: "count"; readonly value: number }
  | { readonly kind: "digest"; readonly value: string }
  | { readonly kind: "at"; readonly value: string }
  | { readonly kind: "flag"; readonly value: boolean };

type FieldSpec = {
  readonly kind: ValueKind;
  readonly required: boolean;
  /** For `enum` fields: the closed set of permitted members. */
  readonly members?: readonly string[];
};

/**
 * The exact fields each event type may carry.
 *
 * An earlier draft allowed ARBITRARY field names as long as each value was
 * tagged with a kind. That does not exclude content, and I wrote it into this
 * package after writing a plan saying content must be structurally excluded:
 * `{ prompt: { kind: "id", value: "<a secret>" } }` typechecked. A tag on a
 * value says what the author claims it is, not what it holds — the same shape
 * as a denylist of secret-ish field names, and the same failure.
 *
 * An allowlist cannot fail that way. `prompt` is not a field of any event type,
 * so adding one means adding it here, in the open, where the question "can this
 * carry content?" is asked once.
 *
 * WHAT THIS DOES NOT DO, stated because the opposite was claimed here before.
 *
 * It does not put content beyond reach. `id` values are shape-checked — a
 * bounded length and a restricted alphabet — and that stops free-form prose,
 * not token-shaped content. Verified: an AWS key id, a GitHub personal access
 * token, a base64 blob and dotted pseudo-prose all satisfy the identifier shape
 * and are accepted; only whitespace and length over 128 are refused.
 *
 * So a producer that puts a secret in `questionId` succeeds. What the schema
 * enforces is that there is no FIELD whose purpose is to carry content, that
 * every field's kind and alphabet are constrained, and that enumerated fields
 * are closed sets. Whether an identifier is genuinely an identifier is a
 * producer-side property — identifier issuance and authenticity are a separate
 * trust boundary that no regex here can establish, and inventing one that
 * appeared to would be worse than saying so.
 */
export const PAYLOAD_FIELDS = {
  "run.created": {
    workspaceId: { kind: "id", required: true },
    policyId: { kind: "id", required: true },
    policyVersion: { kind: "count", required: true },
  },
  "run.started": { workerId: { kind: "id", required: true } },
  "run.progress": {
    phase: { kind: "enum", required: true, members: ["planning", "working", "verifying"] },
    completedSteps: { kind: "count", required: false },
  },
  // The question's TEXT is not here. It lives wherever questions live; this
  // carries its identifier. That is the whole point of the allowlist.
  "run.question": { questionId: { kind: "id", required: true } },
  "approval.requested": {
    approvalId: { kind: "id", required: true },
    actionClass: { kind: "enum", required: true, members: CONSEQUENTIAL_ACTION_CLASSES },
    riskLevel: { kind: "enum", required: true, members: RISK_LEVELS },
  },
  "approval.granted": {
    approvalId: { kind: "id", required: true },
    narrowed: { kind: "flag", required: true },
  },
  "approval.denied": { approvalId: { kind: "id", required: true } },
  "capability.used": {
    capabilityId: { kind: "id", required: true },
    resourceDigest: { kind: "digest", required: false },
  },
  "artifact.created": {
    artifactId: { kind: "id", required: true },
    artifactDigest: { kind: "digest", required: true },
    byteCount: { kind: "count", required: false },
  },
  "evidence.recorded": {
    evidenceId: { kind: "id", required: true },
    provenance: {
      kind: "enum",
      required: true,
      members: ["worker_provided", "system_observed", "human_provided", "independent_verifier"],
    },
  },
  "worker.heartbeat": {
    phase: { kind: "enum", required: true, members: ["planning", "working", "verifying", "waiting"] },
    activeMs: { kind: "count", required: true },
    safeToInterrupt: { kind: "flag", required: true },
  },
  // A warning's text is not carried. A closed reason code is.
  "worker.warning": {
    reasonCode: { kind: "enum", required: true, members: WORKER_WARNING_CODES },
    occurrences: { kind: "count", required: false },
  },
  "run.paused": { requestedBy: { kind: "id", required: true } },
  "run.resumed": { resumedFromSequence: { kind: "count", required: true } },
  "run.cancelled": {
    requestedBy: { kind: "id", required: true },
    acknowledged: { kind: "flag", required: true },
    cleanupCompleted: { kind: "flag", required: true },
  },
  "verification.started": { verificationJobId: { kind: "id", required: true } },
  "verdict.recorded": {
    verificationJobId: { kind: "id", required: true },
    status: { kind: "enum", required: true, members: ["VERIFIED_PASS", "CONDITIONAL", "BLOCKED"] },
    snapshotDigest: { kind: "digest", required: true },
    staled: { kind: "flag", required: true },
  },
  "run.completed": {
    terminalState: { kind: "enum", required: true, members: ["DONE", "DONE_UNVERIFIED"] },
    receiptDigest: { kind: "digest", required: false },
  },
  "run.failed": { reasonCode: { kind: "enum", required: true, members: RUN_FAILURE_CODES } },
  "run.blocked": { reasonCode: { kind: "enum", required: true, members: RUN_BLOCKED_CODES } },
} satisfies Record<RunEventType, Record<string, FieldSpec>>;

/** The value type a declared field kind produces. */
type ValueFor<K extends ValueKind> = Extract<PayloadValue, { kind: K }>;

/**
 * The payload type for one event, derived from the allowlist rather than
 * declared beside it.
 *
 * An earlier draft typed payloads as `{ [field: string]: PayloadValue }` — an
 * arbitrary index signature — so `{ prompt: { kind: "id", value: "<secret>" } }`
 * typechecked even though the runtime allowlist rejected it. A structural claim
 * that only holds at runtime is not a structural claim; it is a runtime check
 * with a comment attached, and this repository has shipped that mistake before.
 *
 * Deriving from PAYLOAD_FIELDS means the two cannot drift: adding a field to the
 * allowlist adds it to the type, and a field absent from the allowlist does not
 * exist in the type.
 */
export type PayloadFor<T extends RunEventType> = {
  readonly [F in keyof (typeof PAYLOAD_FIELDS)[T] as (typeof PAYLOAD_FIELDS)[T][F] extends {
    required: true;
  }
    ? F
    : never]: ValueFor<(typeof PAYLOAD_FIELDS)[T][F] extends { kind: infer K extends ValueKind } ? K : never>;
} & {
  readonly [F in keyof (typeof PAYLOAD_FIELDS)[T] as (typeof PAYLOAD_FIELDS)[T][F] extends {
    required: false;
  }
    ? F
    : never]?: ValueFor<(typeof PAYLOAD_FIELDS)[T][F] extends { kind: infer K extends ValueKind } ? K : never>;
};

/** Kept for the runtime validator, which walks fields generically. */
export type RunEventPayload = { readonly [field: string]: PayloadValue };

/** Every event type must declare its fields, or the allowlist has a hole. */
export function payloadSpecIsComplete(): boolean {
  return RUN_EVENT_TYPES.every((type) => Object.hasOwn(PAYLOAD_FIELDS, type));
}
