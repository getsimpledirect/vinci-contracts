import { describe, expect, expectTypeOf, it } from "vitest";
import { CONSEQUENTIAL_ACTION_CLASSES } from "@vinci/contracts";
import type { Actor, ApprovalId, EvidenceId, RunId } from "@vinci/contracts";
import {
  APPROVAL_DECISION_SCHEMA_META,
  APPROVAL_GRANT_SCHEMA_META,
  APPROVAL_REQUEST_SCHEMA_META,
  DELIVERY_STATE_KINDS,
  GRANT_SHAPE_KINDS,
  GRANT_SHAPE_SCHEMA_META,
  RUN_ACTION_SCHEMA_META,
  applyApprovalDecision,
  assertSchemaMetaComplete,
  createApprovalDecision,
  isDecisionEffective,
  notificationSafeProjection,
  validateApprovalRequest,
  type ApprovalDecision,
  type ApprovalRequest,
  type RunAction,
  canAdvanceDelivery,
  isEffectiveDeliveryState,
  INITIAL_DELIVERY_STATE,
} from "./index.ts";

const user = { kind: "user", userId: "user-1" as never } as const satisfies Actor;
const worker = { kind: "worker", workerId: "worker-1" as never } as const satisfies Actor;

const request = {
  approvalId: "approval-1" as ApprovalId,
  runId: "run-1" as RunId,
  requestedAt: "2026-08-23T12:00:00.000Z",
  actionClass: "deployment" as const,
  requestedAction: "Deploy the billing service",
  worker,
  runObjective: "Release the verified billing fix",
  affectedResource: "artifact-1" as never,
  reason: "Production changes require operator approval",
  riskLevel: "high",
  evidenceId: "evidence-1" as EvidenceId,
  estimatedCostOrImpact: "Up to 5 minutes of degraded service",
  controllingPolicy: { policyId: "production-deploys", policyVersion: 3 },
  grant: { kind: "allow-bounded", resourceId: "production/billing", durationMs: 600_000 },
} as const satisfies ApprovalRequest;

describe("approval decisions", () => {
  it("rejects a narrower-scope decision that widens duration or changes resource", () => {
    const longer = createApprovalDecision(request, {
      kind: "approve-narrower",
      decidedBy: user,
      decidedAt: "2026-08-23T12:01:00.000Z",
      narrowedGrant: {
        kind: "allow-bounded",
        resourceId: "production/billing",
        durationMs: 1_200_000,
      },
    });
    const otherResource = createApprovalDecision(request, {
      kind: "approve-narrower",
      decidedBy: user,
      decidedAt: "2026-08-23T12:01:00.000Z",
      narrowedGrant: { kind: "allow-bounded", resourceId: "production/all", durationMs: 60_000 },
    });

    expect(longer.ok).toBe(false);
    expect(otherResource.ok).toBe(false);
  });

  it("represents the first of two approvals as a distinct partial state", () => {
    const twoPersonRequest = { ...request, grant: { kind: "require-two-people" } } as const;
    const decision = createApprovalDecision(twoPersonRequest, {
      kind: "approve-once",
      decidedBy: user,
      decidedAt: "2026-08-23T12:01:00.000Z",
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;

    const acceptedDecision = {
      ...decision.value,
      deliveryState: {
        kind: "accepted-by-governor",
        acceptedAt: "2026-08-23T12:01:01.000Z",
      },
    } as const satisfies ApprovalDecision;
    const progress = applyApprovalDecision(twoPersonRequest, { kind: "pending" }, acceptedDecision);
    expect(progress).toEqual({
      kind: "partially-approved",
      firstApproval: { approver: user, approvedAt: "2026-08-23T12:01:00.000Z" },
    });
    expect(progress.kind).not.toBe("satisfied");
  });

  it("does not expose queued or merely delivered decisions as effective", () => {
    const base = {
      kind: "deny",
      approvalId: request.approvalId,
      runId: request.runId,
      decidedBy: user,
      decidedAt: "2026-08-23T12:01:00.000Z",
    } as const;
    const queued = { ...base, deliveryState: { kind: "queued-locally" } } satisfies ApprovalDecision;
    const delivered = {
      ...base,
      deliveryState: { kind: "delivered", deliveredAt: "2026-08-23T12:01:01.000Z" },
    } satisfies ApprovalDecision;
    const accepted = {
      ...base,
      deliveryState: {
        kind: "accepted-by-governor",
        acceptedAt: "2026-08-23T12:01:02.000Z",
      },
    } satisfies ApprovalDecision;

    expect(isDecisionEffective(queued)).toBe(false);
    expect(isDecisionEffective(delivered)).toBe(false);
    expect(isDecisionEffective(accepted)).toBe(true);
  });

  it("keeps run actions out of the decision union", () => {
    const action = {
      kind: "pause-run",
      runId: request.runId,
      requestedBy: user,
      requestedAt: "2026-08-23T12:01:00.000Z",
    } as const satisfies RunAction;
    expectTypeOf(action).not.toMatchTypeOf<ApprovalDecision>();
  });
});

describe("notification-safe projection", () => {
  it("contains only the fields a payload may carry", () => {
    // The previous version of this test asserted that a regex denylist
    // scrubbed secrets out of free text. It passed while the implementation
    // leaked an AWS key id and a GitHub token, because the inputs it chose
    // happened to match the patterns. Free text is gone from the payload
    // entirely now, so the assertion is about the field set itself.
    const projected = notificationSafeProjection(request);
    expect(Object.keys(projected).sort()).toEqual([
      "actionClass",
      "actionSummary",
      "approvalDuration",
      "policyId",
      "policyVersion",
      "riskLevel",
      "timestamp",
    ]);
  });
});

describe("schema contracts", () => {
  it("exposes every required grant shape and exactly four delivery states", () => {
    expect(GRANT_SHAPE_KINDS).toEqual([
      "deny",
      "allow-automatically",
      "require-person",
      "require-role",
      "require-two-people",
      "expire-at",
      "allow-once",
      "allow-remainder-of-run",
      "allow-bounded",
    ]);
    expect(DELIVERY_STATE_KINDS).toEqual([
      "queued-locally",
      "delivered",
      "accepted-by-governor",
      "acted-upon-by-worker",
    ]);
  });

  it("declares complete metadata for every exported schema", () => {
    for (const meta of [
      APPROVAL_REQUEST_SCHEMA_META,
      APPROVAL_DECISION_SCHEMA_META,
      RUN_ACTION_SCHEMA_META,
      GRANT_SHAPE_SCHEMA_META,
      APPROVAL_GRANT_SCHEMA_META,
    ]) {
      expect(() => assertSchemaMetaComplete(meta)).not.toThrow();
    }
  });

  it("fails closed on malformed required data and preserves unknown fields", () => {
    const result = validateApprovalRequest({ ...request, riskLevel: "severe", future: { a: 1 } });
    expect(result.ok).toBe(false);

    const valid = validateApprovalRequest({ ...request, future: { a: 1 } });
    expect(valid.ok).toBe(true);
    if (valid.ok) expect(valid.unknownFields).toEqual({ "/future": { a: 1 } });
  });
});

describe("notification payloads carry no free text", () => {
  // Written as a property rather than a list of patterns on purpose. The
  // previous implementation scrubbed free text with a regex denylist and
  // passed its own tests, because those tests only fed inputs the regexes
  // happened to match. It leaked an AWS key id, a GitHub token, a person's
  // name and a street address.
  //
  // This asserts the only thing that actually holds: nothing a human typed
  // into the request appears in the payload, whatever they typed.
  const SENTINELS = {
    requestedAction: "ACTION_SENTINEL_AKIAIOSFODNN7EXAMPLE",
    runObjective: "OBJECTIVE_SENTINEL_ghp_16C7e42F292c6912E7710c838347Ae178B4a",
    affectedResource: "RESOURCE_SENTINEL_10.1.2.3_internal_host",
    reason: "REASON_SENTINEL_Dr_Alice_Chen_12_Elm_Street",
    estimatedCostOrImpact: "COST_SENTINEL_customer_id_88213",
  };

  function requestWithSentinels() {
    return {
      approvalId: "apr-1" as never,
      runId: "run-1" as never,
      actionClass: "deployment" as const,
      worker: { kind: "worker" as const, workerId: "w-1" as never },
      riskLevel: "high" as const,
      evidenceId: "ev-1" as never,
      controllingPolicy: { policyId: "pol-1" as never, policyVersion: 3 },
      grant: { kind: "allow-once" as const },
      requestedAt: "2026-08-23T00:00:00.000Z" as never,
      ...SENTINELS,
    };
  }

  it("leaks no free-text field into the payload", () => {
    const payload = JSON.stringify(notificationSafeProjection(requestWithSentinels() as never));
    for (const [field, sentinel] of Object.entries(SENTINELS)) {
      expect(payload, `${field} leaked into the notification`).not.toContain(sentinel);
      // Also catch a partial copy — a truncated or scrubbed fragment is still a leak.
      expect(payload).not.toContain(sentinel.slice(0, 20));
    }
  });

  it("still says something useful, built only from the action class", () => {
    const payload = notificationSafeProjection(requestWithSentinels() as never);
    expect(payload.actionSummary).toBe("Vinci needs approval to deploy.");
    expect(payload.riskLevel).toBe("high");
  });

  it("describes every action class without touching the request", () => {
    // If a class is ever added without a label, this catches it before a
    // notification renders `undefined` to a user.
    for (const actionClass of CONSEQUENTIAL_ACTION_CLASSES) {
      const payload = notificationSafeProjection({
        ...requestWithSentinels(),
        actionClass,
      } as never);
      expect(payload.actionSummary).toMatch(/^Vinci needs approval to .+\.$/);
      expect(payload.actionSummary).not.toContain("undefined");
    }
  });

  it("rejects a request whose action class is not recognised", () => {
    const result = validateApprovalRequest({ ...requestWithSentinels(), actionClass: "whatever" });
    expect(result.ok).toBe(false);
  });
});

describe("a widened grant cannot survive persistence", () => {
  // Narrowing was checked only inside createApprovalDecision. Nothing
  // re-verified it afterwards, so a decision that had been serialized,
  // tampered with, or constructed by any other path could carry a WIDER grant
  // than was requested and still be applied. An approval that grants more than
  // the human saw is the failure this whole package exists to prevent.
  const narrowRequest = {
    ...request,
    grant: { kind: "allow-bounded" as const, resourceId: "billing-service", durationMs: 600_000 },
  };

  const widened = {
    kind: "approve-narrower" as const,
    approvalId: narrowRequest.approvalId,
    runId: narrowRequest.runId,
    decidedBy: { kind: "user" as const, userId: "user-9" as never },
    decidedAt: "2026-08-23T12:05:00.000Z" as never,
    deliveryState: { kind: "acted-upon-by-worker" as const },
    narrowedGrant: {
      kind: "allow-bounded" as const,
      resourceId: "production/all",
      durationMs: 86_400_000,
    },
  };

  it("refuses to apply a decision whose narrowed grant is wider than requested", () => {
    const result = applyApprovalDecision(narrowRequest, { kind: "pending" }, widened as never);
    expect(result.kind).not.toBe("satisfied");
  });

  it("still applies a genuinely narrower grant", () => {
    // The fix must not break the feature it protects.
    const narrower = {
      ...widened,
      narrowedGrant: {
        kind: "allow-bounded" as const,
        resourceId: "billing-service",
        durationMs: 60_000,
      },
    };
    const result = applyApprovalDecision(narrowRequest, { kind: "pending" }, narrower as never);
    expect(result.kind).toBe("satisfied");
  });
});

describe("delivery states must progress, not jump", () => {
  it("allows each single forward step and staying put", () => {
    expect(canAdvanceDelivery("queued-locally", "delivered")).toBe(true);
    expect(canAdvanceDelivery("delivered", "accepted-by-governor")).toBe(true);
    expect(canAdvanceDelivery("accepted-by-governor", "acted-upon-by-worker")).toBe(true);
    expect(canAdvanceDelivery("delivered", "delivered")).toBe(true);
  });

  it("refuses to skip Governor acceptance", () => {
    // The consequential case: both of the last two states read as effective,
    // so a decision that jumps straight to acted-upon-by-worker claims
    // authority was granted with no record of it being granted.
    expect(canAdvanceDelivery("delivered", "acted-upon-by-worker")).toBe(false);
    expect(canAdvanceDelivery("queued-locally", "accepted-by-governor")).toBe(false);
    expect(canAdvanceDelivery("queued-locally", "acted-upon-by-worker")).toBe(false);
  });

  it("refuses to move backwards", () => {
    expect(canAdvanceDelivery("acted-upon-by-worker", "delivered")).toBe(false);
    expect(canAdvanceDelivery("accepted-by-governor", "queued-locally")).toBe(false);
  });

  it("starts every decision in the one state that is not effective", () => {
    expect(INITIAL_DELIVERY_STATE.kind).toBe("queued-locally");
    expect(isEffectiveDeliveryState(INITIAL_DELIVERY_STATE)).toBe(false);
  });
});
