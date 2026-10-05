import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { applyApprovalDecision, validateApprovalDecision, validateApprovalRequest } from "@getsimpledirect/vinci-approvals";
import { type ValidationResult } from "@getsimpledirect/vinci-contracts";
import { receiptDigest, validateReceipt, validateVerificationRecord, verificationAgainst, type Receipt } from "@getsimpledirect/vinci-receipts";
import { validateRunEvent, type RunEvent } from "@getsimpledirect/vinci-run-events";
import { RunReplay, replayRun, type RunReplayOptions } from "./index.ts";

const AT = "2026-10-05T12:00:00.000Z";
const DIGEST = "ab".repeat(32);
const id = (value: string) => ({ kind: "id", value });
const count = (value: number) => ({ kind: "count", value });
const digest = (value: string) => ({ kind: "digest", value });
const enumValue = (value: string) => ({ kind: "enum", value });
const flag = (value: boolean) => ({ kind: "flag", value });
const declaration = () => ({
  schemaVersion: 1, runId: "run-1", workOrderId: "wo-1", workOrderDigest: DIGEST,
  attemptId: "attempt-1", agent: { id: "agent-1", version: 1 },
  environment: { id: "env-1", digest: DIGEST }, sessionId: null,
  contextManifestDigest: null, harnessAttestationDigest: null, servicePrincipalId: null,
  budget: { maxToolCalls: 4, maxHumanInterruptions: 2 }, requiredTerminal: "OBSERVED",
  state: "CREATED", createdAt: AT, startedAt: null, lastEventAt: null,
});

function must<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new Error(`Invalid fixture: ${JSON.stringify(result.issues)}`);
  return result.value;
}

function event(sequence: number, type: string, payload: Record<string, unknown> = {}): RunEvent {
  return must(validateRunEvent({
    schemaVersion: 4, eventId: `event-${sequence}`, runId: "run-1",
    organizationId: null, workspaceId: "workspace-1", sequence, type,
    actor: { kind: "worker", workerId: "worker-1" }, occurredAt: AT,
    idempotencyKey: `key-${sequence}`, traceId: "trace-1", payload,
  }));
}

const initial = () => [
  event(1, "run.created", { workspaceId: id("workspace-1"), policyId: id("policy-1"), policyVersion: count(1), workOrderDigest: digest(DIGEST) }),
  event(2, "run.started", { workerId: id("worker-1") }),
];

const externalDigest = (value: string) => createHash("sha256").update(value).digest("hex");

function fixture() {
  // The worker's log and external object are separate. Neither a completion
  // event nor an approval event writes this mock external state.
  let externalObject: string | null = null;
  let observedReceipt: unknown;
  let verification: unknown = { status: "unverified" };
  const refusals: string[] = [];
  const receipt = {
    receiptVersion: 3, receiptId: "receipt-1", runId: "run-1", objective: "Write mock version 1",
    workspace: { kind: "personal", workspaceId: "workspace-1", ownerId: "owner-1" },
    requester: { kind: "user", userId: "owner-1" },
    worker: { kind: "worker", workerId: "worker-1" },
    modelId: "tela-mock-v1", providerId: "deterministic-mock", executionLocation: "test",
    policyId: "policy-1", policyVersion: 1, startedAt: AT, completedAt: AT, activeDuration: 0,
    humanAttention: { seconds: 7, interruptions: 2, decisions: 2, escalations: 0 },
    finalState: "DONE", actionSummary: "Observed mock version 1", resourcesAccessed: ["mock-object-1"],
    changesMade: ["mock-object-1"], artifactsProduced: [], approvalIds: ["approval-1"], evidenceIds: ["evidence-1"],
    verdict: "VERIFIED_PASS", spend: 0, unresolvedConditions: [], resumeInstructions: null,
    rollbackInfo: null, digest: DIGEST, signature: null,
  };
  const signedReceipt = must(validateReceipt({ ...receipt, digest: receiptDigest(receipt as unknown as Receipt) }));
  const options: RunReplayOptions = {
    logRefusal: (message, fields) => {
      expect(message).toMatch(/before retrying\.$/);
      refusals.push(fields.code);
    },
    observeCompletion: (_run, completion, events) => {
      const valid = validateReceipt(observedReceipt);
      const record = validateVerificationRecord(verification);
      if (!valid.ok || !record.ok || externalObject !== "mock-object@version-1") return { status: "UNCONFIRMED" };
      if (verificationAgainst(record.value, externalDigest(externalObject)).show !== "verified") return { status: "UNCONFIRMED" };
      const verdict = [...events].reverse().find((item) => item.type === "verdict.recorded");
      if (verdict?.type !== "verdict.recorded" || verdict.payload.staled.value || verdict.payload.status.value !== valid.value.verdict || verdict.payload.snapshotDigest.value !== externalDigest(externalObject)) return { status: "UNCONFIRMED" };
      if (valid.value.finalState !== "DONE" || valid.value.verdict !== "VERIFIED_PASS" || valid.value.unresolvedConditions.length > 0) return { status: "UNCONFIRMED" };
      if (valid.value.humanAttention.seconds !== completion.payload.humanAttentionSeconds.value) return { status: "UNCONFIRMED" };
      const workspace = valid.value.workspace;
      return {
        status: "CONFIRMED", runId: valid.value.runId, workspaceId: workspace.workspaceId,
        organizationId: workspace.kind === "organization" ? workspace.organizationId : null,
        receiptDigest: valid.value.digest, terminalState: valid.value.finalState, tierReached: "OBSERVED",
      };
    },
  };
  const events = [
    ...initial(),
    event(3, "run.question", { questionId: id("question-1") }),
    event(4, "run.question_answered", { questionId: id("question-1"), humanSeconds: count(3) }),
    event(5, "approval.requested", { approvalId: id("approval-1"), actionClass: enumValue("content_publication"), riskLevel: enumValue("medium") }),
    event(6, "approval.granted", { approvalId: id("approval-1"), narrowed: flag(false), humanSeconds: count(4) }),
    event(7, "evidence.recorded", { evidenceId: id("evidence-1"), provenance: enumValue("system_observed") }),
    event(8, "verification.started", { verificationJobId: id("verification-1") }),
    event(9, "verdict.recorded", { verificationJobId: id("verification-1"), status: enumValue("VERIFIED_PASS"), snapshotDigest: digest(externalDigest("mock-object@version-1")), staled: flag(false) }),
  ];
  const completed = event(10, "run.completed", {
    terminalState: enumValue("DONE"), receiptDigest: digest(signedReceipt.digest),
    humanAttentionSeconds: count(7), humanDecisions: count(2), humanInterruptions: count(2),
    escalations: count(0), tierReached: enumValue("OBSERVED"), outcome: enumValue("SUCCEEDED"),
  });
  const observeMockWrite = () => {
    externalObject = "mock-object@version-1";
    observedReceipt = signedReceipt;
    verification = { status: "verified", verifierId: "independent-mock", independent: true, verifiedAt: AT, subjectDigest: externalDigest(externalObject) };
  };
  return {
    events, completed, options, refusals, signedReceipt, observeMockWrite,
    setReceipt: (value: unknown) => { observedReceipt = value; },
    setVerification: (value: unknown) => { verification = value; },
    setExternalObject: (value: string) => { externalObject = value; },
  };
}

function rejectionCode(result: ReturnType<RunReplay["append"]>): string | undefined {
  expect(result.kind).toBe("reject");
  return result.kind === "reject" ? result.issues[0]?.code : undefined;
}

describe("canonical run replay admission", () => {
  it("reconstructs questions, approval waiting and responses across disposal, then finishes only after observing external state", () => {
    const f = fixture();
    const first = replayRun(declaration(), f.events.slice(0, 3), f.options);
    expect(first.issues).toEqual([]);
    expect(first.replay.snapshot().pendingQuestionId).toBe("question-1");
    const second = replayRun(declaration(), first.replay.acceptedEvents(), f.options).replay;
    for (const next of f.events.slice(3, 5)) expect(second.append(next, second.snapshot().revision).kind).toBe("append");
    expect(second.snapshot().run.state).toBe("PAUSED");
    expect(second.snapshot().pendingApprovalId).toBe("approval-1");
    const third = replayRun(declaration(), second.acceptedEvents(), f.options).replay;
    for (const next of f.events.slice(5)) expect(third.append(next, third.snapshot().revision).kind).toBe("append");
    expect(third.snapshot().responses).toEqual({ questions: 1, approvals: 1, humanSeconds: 7 });
    expect(rejectionCode(third.append(f.completed, 9))).toBe("completion_unconfirmed");
    expect(third.snapshot().run.state).toBe("RUNNING");
    f.observeMockWrite();
    expect(third.append(f.completed, 9).kind).toBe("append");
    const restored = replayRun(declaration(), third.acceptedEvents(), f.options);
    expect(restored.issues).toEqual([]);
    expect(restored.replay.snapshot()).toEqual(third.snapshot());
    expect(restored.replay.snapshot().run.state).toBe("TERMINAL");
    expect(restored.replay.snapshot().run.agent.version).toBe(1);
    expect(restored.replay.snapshot().run.environment.digest).toBe(DIGEST);
  });

  it("exact retries are no-ops with stale revisions, including after terminal; conflicting retries are refused", () => {
    const f = fixture(); f.observeMockWrite();
    const replay = replayRun(declaration(), [...f.events, f.completed], f.options).replay;
    const before = replay.snapshot();
    expect(replay.append(f.completed, 9).kind).toBe("duplicate");
    expect(replay.append(f.events[3], 3).kind).toBe("duplicate");
    expect(replay.snapshot()).toEqual(before);
    expect(rejectionCode(replay.append({ ...f.completed, traceId: "another-trace" }, 10))).toBe("idempotency_conflict");
    expect(rejectionCode(replay.append(event(11, "run.paused", { requestedBy: id("owner-1") }), 10))).toBe("event_after_terminal");
  });

  it("stale revision, gaps, wrong run, tenant changes and backwards time refuse without changing the prefix", () => {
    const f = fixture();
    const replay = replayRun(declaration(), initial(), f.options).replay;
    const before = replay.acceptedEvents();
    const question = f.events[2];
    if (!question) throw new Error("Question fixture missing. Restore the fixture.");
    for (const [candidate, revision, code] of [
      [question, 1, "stale_revision"],
      [{ ...question, sequence: 4 }, 2, "sequence_not_contiguous"],
      [{ ...question, runId: "other-run" }, 2, "wrong_run"],
      [{ ...question, workspaceId: "other-workspace" }, 2, "binding_changed_within_run"],
      [{ ...question, occurredAt: "2026-10-04T12:00:00.000Z" }, 2, "time_went_backwards"],
    ]) {
      expect(rejectionCode(replay.append(candidate, Number(revision)))).toBe(code);
      expect(replay.acceptedEvents()).toEqual(before);
    }
  });

  it("cannot resume, replace a pending decision, answer another question or finish while waiting", () => {
    const f = fixture();
    const replay = replayRun(declaration(), f.events.slice(0, 3), f.options).replay;
    expect(rejectionCode(replay.append(event(4, "run.resumed", { resumedFromSequence: count(3) }), 3))).toBe("decision_still_pending");
    expect(rejectionCode(replay.append(event(4, "run.question", { questionId: id("other-question") }), 3))).toBe("decision_already_pending");
    expect(rejectionCode(replay.append(event(4, "run.question_answered", { questionId: id("other-question"), humanSeconds: count(1) }), 3))).toBe("question_not_pending");
    expect(rejectionCode(replay.append({ ...f.completed, sequence: 4, idempotencyKey: "complete-now" }, 3))).toBe("decision_still_pending");
  });

  it("fails closed on missing, ambiguous, stale, tampered or unavailable observed outcomes", () => {
    const f = fixture();
    const replay = replayRun(declaration(), f.events, f.options).replay;
    for (const change of [
      () => f.setReceipt(undefined),
      () => f.setReceipt({ ...f.signedReceipt, actionSummary: "Worker claims done" }),
      () => f.setVerification({ status: "unverified" }),
      () => f.setVerification({ status: "verified", verifierId: "independent-mock", independent: true, verifiedAt: AT, subjectDigest: "cd".repeat(32) }),
      () => f.setExternalObject("mock-object@version-2"),
    ]) {
      f.observeMockWrite(); change();
      expect(rejectionCode(replay.append(f.completed, 9))).toBe("completion_unconfirmed");
      expect(replay.snapshot().revision).toBe(9);
    }
    const unavailable = replayRun(declaration(), f.events, { logRefusal: f.options.logRefusal, observeCompletion: () => { throw new Error("External observer unavailable"); } }).replay;
    expect(rejectionCode(unavailable.append(f.completed, 9))).toBe("completion_observation_unavailable");
    const missing = replayRun(declaration(), f.events, { logRefusal: f.options.logRefusal }).replay;
    expect(rejectionCode(missing.append(f.completed, 9))).toBe("completion_unconfirmed");
  });

  it("requires observed receipt tenant/digest/state and the declared terminal tier to match", () => {
    const f = fixture(); f.observeMockWrite();
    for (const overrides of [
      { runId: "other-run" }, { receiptDigest: "cd".repeat(32) },
      { workspaceId: "other-workspace" }, { organizationId: "other-org" }, { terminalState: "DONE_UNVERIFIED" },
    ]) {
      const options: RunReplayOptions = {
        ...f.options, observeCompletion: () => ({ status: "CONFIRMED", runId: f.completed.runId, workspaceId: f.completed.workspaceId, organizationId: null, receiptDigest: f.signedReceipt.digest, terminalState: "DONE", tierReached: "OBSERVED", ...overrides }),
      };
      expect(rejectionCode(replayRun(declaration(), f.events, options).replay.append(f.completed, 9))).toBe("completion_binding_mismatch");
    }
    const options: RunReplayOptions = { ...f.options, observeCompletion: () => ({ status: "CONFIRMED", runId: f.completed.runId, workspaceId: f.completed.workspaceId, organizationId: null, receiptDigest: f.signedReceipt.digest, terminalState: "DONE", tierReached: "MERGED" }) };
    expect(rejectionCode(replayRun(declaration(), f.events, options).replay.append(f.completed, 9))).toBe("required_terminal_not_observed");
  });

  it("announcing an artifact without persisted evidence cannot finish, even with a confirmed observer", () => {
    const f = fixture(); f.observeMockWrite();
    const replay = replayRun(declaration(), f.events, f.options).replay;
    expect(replay.append(event(10, "artifact.created", { artifactId: id("artifact-1"), artifactDigest: digest(DIGEST) }), 9).kind).toBe("append");
    expect(rejectionCode(replay.append({ ...f.completed, sequence: 11, idempotencyKey: "complete-artifact" }, 10))).toBe("artifact_evidence_missing");
    expect(replay.append(event(11, "artifact.persisted", { artifactId: id("artifact-1"), contentDigest: digest(DIGEST), kind: enumValue("report") }), 10).kind).toBe("append");
    expect(replay.append({ ...f.completed, sequence: 12, idempotencyKey: "complete-artifact" }, 11).kind).toBe("append");
  });

  it("snapshots and exported logs cannot mutate accepted history or duplicate accounting", () => {
    const f = fixture();
    const replay = replayRun(declaration(), f.events, f.options).replay;
    const before = replay.snapshot();
    const exported = replay.acceptedEvents();
    const first = exported[0];
    if (!first) throw new Error("Creation fixture missing. Restore the fixture.");
    Object.assign(first, { traceId: "mutated-export" });
    Object.assign(before.run.agent, { version: 999 });
    expect(replay.snapshot().run.agent.version).toBe(1);
    expect(replay.append(f.events[0], 0).kind).toBe("duplicate");
    expect(replay.snapshot().responses.humanSeconds).toBe(7);
  });

  it("replay stops at a corrupt prefix instead of sorting or skipping it, and schema3 stays rejected", () => {
    const f = fixture();
    const result = replayRun(declaration(), [f.events[0], f.events[2], f.events[1]], f.options);
    expect(result.issues[0]?.code).toBe("sequence_not_contiguous");
    expect(result.replay.snapshot().revision).toBe(1);
    expect(rejectionCode(new RunReplay(declaration(), f.options).append({ ...f.events[0], schemaVersion: 3 }, 0))).toBe("invalid_schema_version");
  });

  it("requires the initial declaration, create event and work-order binding", () => {
    const f = fixture();
    expect(() => new RunReplay({ ...declaration(), state: "TERMINAL" }, f.options)).toThrow(/initial CREATED/);
    expect(rejectionCode(new RunReplay(declaration(), f.options).append(event(1, "run.started", { workerId: id("worker-1") }), 0))).toBe("creation_event_required");
    expect(rejectionCode(new RunReplay(declaration(), f.options).append(event(1, "run.created", { workspaceId: id("workspace-1"), policyId: id("policy-1"), policyVersion: count(1) }), 0))).toBe("work_order_binding_missing_or_changed");
  });

  it("re-observes completion on recovery and refuses a now-stale external outcome", () => {
    const f = fixture(); f.observeMockWrite();
    const complete = replayRun(declaration(), [...f.events, f.completed], f.options);
    expect(complete.issues).toEqual([]);
    f.setExternalObject("mock-object@version-2");
    const recovered = replayRun(declaration(), complete.replay.acceptedEvents(), f.options);
    expect(recovered.issues[0]?.code).toBe("completion_unconfirmed");
    expect(recovered.replay.snapshot().run.state).toBe("RUNNING");
    expect(recovered.replay.snapshot().revision).toBe(9);
  });
});

describe("exact action approval integration gap", () => {
  it("demonstrates that same-ID action mutation is accepted by the current approval primitive; replay grants no authority", () => {
    const request = must(validateApprovalRequest({
      approvalId: "approval-1", runId: "run-1", requestedAt: AT, actionClass: "content_publication",
      requestedAction: "Write mock-object@version-1", worker: { kind: "worker", workerId: "worker-1" },
      runObjective: "Write one mock version", affectedResource: "mock-object-1", reason: "Mock write",
      riskLevel: "medium", evidenceId: "evidence-1", estimatedCostOrImpact: "0",
      controllingPolicy: { policyId: "policy-1", policyVersion: 1 }, grant: { kind: "allow-once" },
    }));
    const decision = must(validateApprovalDecision({
      kind: "approve-once", approvalId: "approval-1", runId: "run-1",
      decidedBy: { kind: "user", userId: "owner-1" }, decidedAt: AT,
      deliveryState: { kind: "accepted-by-governor", acceptedAt: AT },
    }));
    expect(applyApprovalDecision(request, { kind: "pending" }, decision).kind).toBe("satisfied");
    const changed = { ...request, requestedAction: "Write mock-object@version-2" };
    expect(applyApprovalDecision(changed, { kind: "pending" }, decision).kind).toBe("satisfied");
    // This is evidence of missing immutable/versioned request storage, not a
    // permission to execute version 2. No replay API dispatches any action.
    expect(Object.hasOwn(request, "actionDigest")).toBe(false);
    expect(Object.hasOwn(decision, "requestDigest")).toBe(false);
  });
});
