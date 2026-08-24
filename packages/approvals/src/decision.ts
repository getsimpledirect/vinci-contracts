import type {
  Actor,
  ApprovalId,
  RunId,
  SchemaMeta,
  Timestamp,
  ValidationResult,
} from "@vinci/contracts";
import { fail, ok, toPlainRecord, ownData } from "@vinci/contracts";
import type { DeliveryState, EffectiveDeliveryState } from "./delivery.ts";
import { isEffectiveDeliveryState } from "./delivery.ts";
import type { GrantShape } from "./grant.ts";
import { isGrantStrictlyNarrower, validateGrantShape } from "./grant.ts";
import type { ApprovalRequest } from "./request.ts";
import { collectActorUnknownFields } from "./request.ts";
import {
  collectUnknownFields,
  isActor,
  isNonEmptyString,
  isObject,
  isTimestamp,
  issue,
} from "./validation.ts";

export const APPROVAL_DECISION_KINDS = ["approve-once", "approve-narrower", "deny"] as const;
export type ApprovalDecisionKind = (typeof APPROVAL_DECISION_KINDS)[number];

type DecisionContext = {
  readonly approvalId: ApprovalId;
  readonly runId: RunId;
  readonly decidedBy: Actor;
  readonly decidedAt: Timestamp;
  readonly deliveryState: DeliveryState;
};

export type ApprovalDecision = DecisionContext & (
  | { readonly kind: "approve-once" }
  | {
      readonly kind: "approve-narrower";
      /**
       * Checked against the request's grant at construction AND again in
       * `applyApprovalDecision`. The second check is the load-bearing one: a
       * decision that was serialized or built by another path has not been
       * through the first.
       */
      readonly narrowedGrant: GrantShape;
    }
  | { readonly kind: "deny" }
);

export type EffectiveApprovalDecision = ApprovalDecision & {
  readonly deliveryState: EffectiveDeliveryState;
};

export type ApprovalDecisionInput =
  & { readonly decidedBy: Actor; readonly decidedAt: Timestamp }
  & (
    | { readonly kind: "approve-once" }
    | { readonly kind: "approve-narrower"; readonly narrowedGrant: GrantShape }
    | { readonly kind: "deny" }
  );

export const APPROVAL_DECISION_SCHEMA_META = {
  id: "vinci.approval-decision",
  version: 1,
  compatibility: "additive-only",
  unknownFields: "preserve",
  malformedData: "fail-closed",
  migration: "none",
} as const satisfies SchemaMeta;

/**
 * A local decision starts queued and therefore ineffective. For a narrower
 * approval, construction succeeds only when the closed subset relation can
 * prove the proposed grant is strictly smaller; uncertainty fails closed.
 */
export function createApprovalDecision(
  request: ApprovalRequest,
  input: ApprovalDecisionInput,
): ValidationResult<ApprovalDecision> {
  if (!isActor(input.decidedBy)) {
    return fail([issue("/decidedBy", "invalid_actor", "decidedBy must be a valid Actor")]);
  }
  if (!isTimestamp(input.decidedAt)) {
    return fail([issue("/decidedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z")]);
  }
  if (input.kind === "approve-narrower") {
    const narrowed = validateGrantShape(input.narrowedGrant);
    if (!narrowed.ok) return fail(narrowed.issues.map((entry) => ({ ...entry, path: `/narrowedGrant${entry.path}` })));
    if (!isGrantStrictlyNarrower(input.narrowedGrant, request.grant)) {
      return fail([
        issue(
          "/narrowedGrant",
          "scope_not_narrower",
          "the proposed grant cannot be proven strictly narrower than the requested grant",
        ),
      ]);
    }
  }
  return ok({
    ...input,
    approvalId: request.approvalId,
    runId: request.runId,
    deliveryState: { kind: "queued-locally" },
  });
}

export function isDecisionEffective(decision: ApprovalDecision): decision is EffectiveApprovalDecision {
  const deliveryState = ownData(decision, "deliveryState");
  return isEffectiveDeliveryState(deliveryState as DeliveryState);
}

export type ApprovalRecord = {
  readonly approver: Actor;
  readonly approvedAt: Timestamp;
};

export type ApprovalSatisfactionState =
  | { readonly kind: "pending" }
  | { readonly kind: "partially-approved"; readonly firstApproval: ApprovalRecord }
  | {
      readonly kind: "satisfied";
      readonly approvals: readonly [ApprovalRecord, ...ApprovalRecord[]];
    }
  | { readonly kind: "denied"; readonly deniedBy: Actor; readonly deniedAt: Timestamp };

/**
 * Governor acknowledgment is the effectiveness boundary. The two-person arm
 * records one approval as data, not truthiness, and actor identity is checked
 * before a second approval can satisfy it.
 */
export function applyApprovalDecision(
  request: ApprovalRequest,
  current: ApprovalSatisfactionState,
  decision: ApprovalDecision,
): ApprovalSatisfactionState {
  if (
    !isDecisionEffective(decision) ||
    decision.approvalId !== request.approvalId ||
    decision.runId !== request.runId ||
    current.kind === "denied" ||
    current.kind === "satisfied"
  ) {
    return current;
  }
  if (decision.kind === "deny") {
    return { kind: "denied", deniedBy: decision.decidedBy, deniedAt: decision.decidedAt };
  }
  // Re-verify the narrowing here, against this request, every time.
  //
  // createApprovalDecision checks it once at construction, which is only a
  // guarantee for a decision that never leaves the process that built it.
  // Approvals are serialized, queued while a device is offline (FR-5.6), and
  // applied later by something else entirely, so the value arriving here has
  // not necessarily been through that check — and a decision granting MORE
  // than the human was shown is the precise failure this package exists to
  // prevent. Fail closed: the approval simply does not take effect.
  if (decision.kind === "approve-narrower" && !isGrantStrictlyNarrower(decision.narrowedGrant, request.grant)) {
    return current;
  }
  const record: ApprovalRecord = {
    approver: decision.decidedBy,
    approvedAt: decision.decidedAt,
  };
  if (request.grant.kind !== "require-two-people") {
    return { kind: "satisfied", approvals: [record] };
  }
  if (current.kind === "pending") {
    return { kind: "partially-approved", firstApproval: record };
  }
  if (current.kind === "partially-approved") {
    if (actorIdentity(current.firstApproval.approver) === actorIdentity(record.approver)) return current;
    return { kind: "satisfied", approvals: [current.firstApproval, record] };
  }
  return current;
}

function actorIdentity(actor: Actor): string {
  switch (actor.kind) {
    case "user": return `user:${actor.userId}`;
    case "worker": return `worker:${actor.workerId}`;
    case "policy": return `policy:${actor.policyId}:${actor.policyVersion}`;
    case "system": return `system:${actor.component}`;
    case "verifier": return `verifier:${actor.verifierId}`;
  }
}

export function validateApprovalDecision(input: unknown): ValidationResult<ApprovalDecision> {
  // Snapshot before inspecting: rejects prototypes carrying inherited
  // fields, accessors that answer differently on each read, and symbol or
  // non-enumerable keys that an unknown-field check would not see.
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  input = plain.value;
  if (!isObject(input)) return fail([issue("/", "invalid_type", "approval decision must be an object")]);
  if (typeof input.kind !== "string" || !(APPROVAL_DECISION_KINDS as readonly string[]).includes(input.kind)) {
    return fail([issue("/kind", "invalid_discriminator", "approval decision kind is not recognized")]);
  }
  for (const field of ["approvalId", "runId"] as const) {
    if (!isNonEmptyString(input[field])) return fail([issue(`/${field}`, "required_field", `${field} must be a non-empty string`)]);
  }
  if (!isActor(input.decidedBy)) return fail([issue("/decidedBy", "invalid_actor", "decidedBy must be a valid Actor")]);
  if (!isTimestamp(input.decidedAt)) {
    return fail([issue("/decidedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z")]);
  }
  const deliveryIssue = validateDeliveryState(input.deliveryState);
  if (deliveryIssue) return fail([deliveryIssue]);
  let grantUnknown: Readonly<Record<string, unknown>> = {};
  if (input.kind === "approve-narrower") {
    const grant = validateGrantShape(input.narrowedGrant);
    if (!grant.ok) return fail(grant.issues.map((entry) => ({ ...entry, path: `/narrowedGrant${entry.path}` })));
    grantUnknown = grant.unknownFields;
  } else if (input.narrowedGrant !== undefined) {
    return fail([issue("/narrowedGrant", "unexpected_field", "narrowedGrant is valid only for approve-narrower")]);
  }

  const unknownFields: Record<string, unknown> = {};
  collectUnknownFields(
    input,
    input.kind === "approve-narrower"
      ? ["kind", "approvalId", "runId", "decidedBy", "decidedAt", "deliveryState", "narrowedGrant"]
      : ["kind", "approvalId", "runId", "decidedBy", "decidedAt", "deliveryState"],
    "",
    unknownFields,
  );
  if (isObject(input.decidedBy)) collectActorUnknownFields(input.decidedBy, "/decidedBy", unknownFields);
  if (isObject(input.deliveryState)) collectDeliveryUnknownFields(input.deliveryState, unknownFields);
  for (const [path, value] of Object.entries(grantUnknown)) unknownFields[`/narrowedGrant${path}`] = value;
  return ok(input as unknown as ApprovalDecision, unknownFields);
}

function validateDeliveryState(input: unknown): ReturnType<typeof issue> | undefined {
  if (!isObject(input)) return issue("/deliveryState", "invalid_type", "deliveryState must be an object");
  switch (input.kind) {
    case "queued-locally":
      return undefined;
    case "delivered":
      return isTimestamp(input.deliveredAt)
        ? undefined
        : issue("/deliveryState/deliveredAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z");
    case "accepted-by-governor":
      return isTimestamp(input.acceptedAt)
        ? undefined
        : issue("/deliveryState/acceptedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z");
    case "acted-upon-by-worker":
      return isTimestamp(input.actedUponAt)
        ? undefined
        : issue("/deliveryState/actedUponAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z");
    default:
      return issue("/deliveryState/kind", "invalid_discriminator", "delivery state kind is not recognized");
  }
}

function collectDeliveryUnknownFields(
  delivery: Readonly<Record<string, unknown>>,
  output: Record<string, unknown>,
): void {
  const known = delivery.kind === "queued-locally"
    ? ["kind"]
    : delivery.kind === "delivered"
      ? ["kind", "deliveredAt"]
      : delivery.kind === "accepted-by-governor"
        ? ["kind", "acceptedAt"]
        : ["kind", "actedUponAt"];
  collectUnknownFields(delivery, known, "/deliveryState", output);
}
