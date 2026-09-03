import {
  CONSEQUENTIAL_ACTION_CLASSES,
  REMOTE_DECISION_REJECTIONS,
  RISK_LEVELS,
  VERDICT_STATUSES,
} from "@getsimpledirect/vinci-contracts";
import { EVIDENCE_PROVENANCE_CASES } from "@getsimpledirect/vinci-evidence";
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
 * How a run.completed came to a close, carried as a closed set so a consumer
 * can distinguish a productive terminal (work finished and its outcome is
 * worth something) from the not-doing outcomes (the run was told not to start,
 * turned out to be a duplicate, lost value, was superseded, or closed with a
 * negative result). The not-doing outcomes are PRODUCTIVE terminals, not
 * failures: nothing went wrong, the run simply had nothing worth doing — which
 * is why they ride on run.completed and not run.failed (which keeps
 * RUN_FAILURE_CODES).
 */
export const RUN_OUTCOMES = [
  "SUCCEEDED",
  "DO_NOT_START",
  "DUPLICATE",
  "NO_LONGER_VALUABLE",
  "SUPERSEDED",
  "CLOSE_WITH_NEGATIVE_RESULT",
] as const;

/**
 * The highest tier a run's output reached by the time it completed.
 * `NONE` means nothing was merged, deployed or observed.
 */
export const TERMINAL_TIERS = ["NONE", "MERGED", "DEPLOYED", "OBSERVED"] as const;

/** Why a capability was refused at the boundary (capability.refused). */
export const CAPABILITY_REFUSAL_REASONS = [
  "not_attested",
  "expired",
  "environment_mismatch",
  "runtime_mismatch",
] as const;

/** Why a new run attempt was started (run.attempt_started). */
export const ATTEMPT_REASONS = ["worker_lost", "stalled", "manual"] as const;

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
  // `workOrderDigest` is OPTIONAL, and the optionality is the whole decision.
  //
  // It arrived as a reported gap from the Python Run registry in
  // vinci-gpu-control, which binds every Run to the work order it executes and
  // could not say so in a run.created at all. A run that executes a work order
  // is a concept this contract already has (@getsimpledirect/vinci-work-orders
  // defines the digest), so the field belongs here rather than living forever
  // as a consumer's local exception — an exception that has to be re-argued
  // every time either side changes.
  //
  // Required would have been the wrong call twice over: it breaks every
  // existing producer at once, and it asserts that a run MUST execute a work
  // order, which is not true of this contract's world (an interactive session
  // run has no order). Optional says what is actually the case — some runs
  // carry a work-order identity and, when they do, this is where it goes and
  // this is its shape. A producer that always has one is free to be stricter
  // than the contract; the contract cannot be stricter than its producers.
  "run.created": {
    workspaceId: { kind: "id", required: true },
    policyId: { kind: "id", required: true },
    policyVersion: { kind: "count", required: true },
    workOrderDigest: { kind: "digest", required: false },
  },
  "run.started": { workerId: { kind: "id", required: true } },
  // RESOLVED 2026-08-24: this phase list has three members and worker.heartbeat's has
  // four, adding "waiting". Same field name, same concept, different
  // vocabularies — and nothing anywhere says whether that is deliberate.
  //
  // The defensible reading is that a progress event reports progress, so
  // "waiting" would be self-contradictory, while a heartbeat exists precisely to
  // say "still alive, doing nothing". If that is the intent it should be written
  // down; if it is an oversight, a worker that goes idle emits waiting on one
  // event type and not the other, and whoever reads the stream sees a phase
  // vanish rather than change.
  //
  // The split is deliberate and is now the decision, not an open question:
  //
  //   run.progress      planning | working | verifying
  //   worker.heartbeat  planning | working | verifying | waiting
  //
  // "waiting" stays OUT of run.progress, because a progress event claiming
  // waiting-as-progress is exactly the kind of small untruth that makes a
  // status display worthless. A run that is blocked says so through live run
  // state — WAITING_FOR_APPROVAL or WAITING_FOR_USER — which is where a reader
  // looks to find out why.
  //
  // Heartbeat keeps "waiting" because a heartbeat answers a different question:
  // is this worker alive. "Alive but currently blocked" is a real answer to
  // that and not an answer to "what progress was made".
  "run.progress": {
    phase: { kind: "enum", required: true, members: ["planning", "working", "verifying"] },
    completedSteps: { kind: "count", required: false },
  },
  // The question's TEXT is not here. It lives wherever questions live; this
  // carries its identifier. That is the whole point of the allowlist.
  "run.question": { questionId: { kind: "id", required: true } },
  "run.question_answered": {
    questionId: { kind: "id", required: true },
    humanSeconds: { kind: "count", required: true },
  },
  "approval.requested": {
    approvalId: { kind: "id", required: true },
    actionClass: { kind: "enum", required: true, members: CONSEQUENTIAL_ACTION_CLASSES },
    riskLevel: { kind: "enum", required: true, members: RISK_LEVELS },
  },
  "approval.granted": {
    approvalId: { kind: "id", required: true },
    narrowed: { kind: "flag", required: true },
    humanSeconds: { kind: "count", required: true },
  },
  "approval.denied": {
    approvalId: { kind: "id", required: true },
    humanSeconds: { kind: "count", required: true },
  },
  "device.revoked": {
    deviceId: { kind: "id", required: true },
    credentialId: { kind: "id", required: true },
    revokedBy: {
      kind: "enum",
      required: true,
      members: ["self", "dashboard", "platform"],
    },
  },
  // The host records relay availability from its own observed sequence.
  "relay.unavailable": { sinceSeq: { kind: "count", required: true } },
  "relay.restored": { gapFrames: { kind: "count", required: true } },
  // Platform records host reachability from its heartbeat view.
  "host.unreachable": { lastHeartbeatAt: { kind: "at", required: true } },
  "host.reachable": {},
  // The command kind is resolved from the command envelope named by this
  // digest. Repeating the layer-3 command vocabulary here would invert the
  // dependency graph or create a second vocabulary that can drift.
  "authority.acknowledged": {
    commandId: { kind: "id", required: true },
    commandDigest: { kind: "digest", required: true },
  },
  // Rejection reasons stay readable. A digest-only rejection would identify
  // the command without telling an operator why the host refused it.
  "authority.rejected": {
    commandId: { kind: "id", required: true },
    rejectionCode: {
      kind: "enum",
      required: true,
      members: REMOTE_DECISION_REJECTIONS,
    },
  },
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
      members: EVIDENCE_PROVENANCE_CASES,
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
    status: { kind: "enum", required: true, members: VERDICT_STATUSES },
    snapshotDigest: { kind: "digest", required: true },
    staled: { kind: "flag", required: true },
  },
  // The four attention aggregates are the HOST's claim about the run, in the
  // same sense the terminal state is: the contract cannot reconcile them against
  // the per-event humanSeconds (a consumer holding the full event stream can),
  // so a reader must treat a disagreement as the host's error, not the events'.
  "run.completed": {
    terminalState: { kind: "enum", required: true, members: ["DONE", "DONE_UNVERIFIED"] },
    receiptDigest: { kind: "digest", required: false },
    humanAttentionSeconds: { kind: "count", required: true },
    humanDecisions: { kind: "count", required: true },
    humanInterruptions: { kind: "count", required: true },
    escalations: { kind: "count", required: true },
    // v4 additions: two OPTIONAL fields. The not-doing outcomes are productive
    // terminals and belong on run.completed, not run.failed (which keeps
    // RUN_FAILURE_CODES). Both are optional so a v3-shaped run.completed event
    // remains valid at v4; a new type/field is still a version bump under the
    // frozen policy, but the version is bumped by the 24 new event types, not
    // by forcing every completed event to name an outcome.
    outcome: { kind: "enum", required: false, members: RUN_OUTCOMES },
    tierReached: { kind: "enum", required: false, members: TERMINAL_TIERS },
  },
  "run.failed": { reasonCode: { kind: "enum", required: true, members: RUN_FAILURE_CODES } },
  "run.blocked": { reasonCode: { kind: "enum", required: true, members: RUN_BLOCKED_CODES } },
  "run.stalled": {
    lastEventAt: { kind: "at", required: true },
    stallWindowS: { kind: "count", required: true },
  },
  "run.attempt_started": {
    attemptId: { kind: "id", required: true },
    previousAttemptId: { kind: "id", required: false },
    reason: { kind: "enum", required: true, members: ATTEMPT_REASONS },
  },
  "agent.turn_started": { turnId: { kind: "id", required: true } },
  "agent.turn_finished": {
    turnId: { kind: "id", required: true },
    inputTokens: { kind: "count", required: true },
    outputTokens: { kind: "count", required: true },
    costMicrousd: { kind: "count", required: true },
    modelId: { kind: "id", required: true },
  },
  "agent.compaction_started": {
    reason: { kind: "enum", required: true, members: ["manual", "threshold", "overflow"] },
    tokens: { kind: "count", required: true },
  },
  "agent.compaction_finished": { tokens: { kind: "count", required: true } },
  "agent.retry_started": {
    attempt: { kind: "count", required: true },
    maxAttempts: { kind: "count", required: true },
  },
  "agent.retry_finished": {
    attempt: { kind: "count", required: true },
    success: { kind: "flag", required: true },
  },
  "tool.requested": {
    toolCallId: { kind: "id", required: true },
    toolId: { kind: "id", required: true },
  },
  "tool.started": {
    toolCallId: { kind: "id", required: true },
    toolId: { kind: "id", required: true },
  },
  "tool.completed": {
    toolCallId: { kind: "id", required: true },
    toolId: { kind: "id", required: true },
    durationMs: { kind: "count", required: true },
    outputDigest: { kind: "digest", required: true },
  },
  "tool.failed": {
    toolCallId: { kind: "id", required: true },
    toolId: { kind: "id", required: true },
    reason: { kind: "enum", required: true, members: ["error", "refused", "timeout"] },
  },
  "tool.confirmation_required": {
    toolCallId: { kind: "id", required: true },
    approvalId: { kind: "id", required: true },
  },
  "governor.lease_acquired": {
    leaseId: { kind: "id", required: true },
    expiresAt: { kind: "at", required: true },
  },
  "governor.lease_renewed": {
    leaseId: { kind: "id", required: true },
    expiresAt: { kind: "at", required: true },
  },
  "governor.lease_lost": {
    leaseId: { kind: "id", required: true },
    reason: { kind: "enum", required: true, members: ["expired", "revoked", "superseded"] },
  },
  "artifact.persisted": {
    artifactId: { kind: "id", required: true },
    contentDigest: { kind: "digest", required: true },
    kind: {
      kind: "enum",
      required: true,
      members: ["code_patch", "report", "dataset", "evidence", "deployment_receipt"],
    },
  },
  "artifact.verified": {
    artifactId: { kind: "id", required: true },
    verifierPrincipalId: { kind: "id", required: true },
    receiptId: { kind: "id", required: true },
  },
  "approval.expired": {
    approvalId: { kind: "id", required: true },
    defaultApplied: { kind: "enum", required: true, members: ["DENY"] },
  },
  "context.loaded": {
    contextManifestDigest: { kind: "digest", required: true },
    entryCount: { kind: "count", required: true },
  },
  "context.invalidated": {
    contextManifestDigest: { kind: "digest", required: true },
    reason: { kind: "enum", required: true, members: ["superseded", "rights_restricted", "stale"] },
  },
  "capability.attested": {
    attestationDigest: { kind: "digest", required: true },
    capabilityId: { kind: "id", required: true },
    version: { kind: "count", required: true },
  },
  "capability.refused": {
    capabilityId: { kind: "id", required: true },
    reason: { kind: "enum", required: true, members: CAPABILITY_REFUSAL_REASONS },
  },
  "steer.received": {
    steerId: { kind: "id", required: true },
    instructionDigest: { kind: "digest", required: true },
    issuedByPrincipalId: { kind: "id", required: true },
  },
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
type DeclaredPayloadFor<T extends RunEventType> = {
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

export type PayloadFor<T extends RunEventType> = keyof (typeof PAYLOAD_FIELDS)[T] extends never
  ? Readonly<Record<string, never>>
  : DeclaredPayloadFor<T>;

/** Kept for the runtime validator, which walks fields generically. */
export type RunEventPayload = { readonly [field: string]: PayloadValue };

/** Every event type must declare its fields, or the allowlist has a hole. */
export function payloadSpecIsComplete(): boolean {
  return RUN_EVENT_TYPES.every((type) => Object.hasOwn(PAYLOAD_FIELDS, type));
}
