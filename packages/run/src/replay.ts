import { type ValidationIssue } from "@getsimpledirect/vinci-contracts";
import {
  TERMINAL_TIERS,
  validateRunEvent,
  verifyAppend,
  type RunEvent,
  type RunEventFor,
} from "@getsimpledirect/vinci-run-events";
import { projectRunState, terminalEvidenceMissing, validateRun, type VinciRun } from "./run.ts";

/** An adapter result, never a worker event or a persisted receipt schema. */
export type CompletionObservation =
  | { readonly status: "UNCONFIRMED" }
  | {
      readonly status: "CONFIRMED";
      readonly runId: RunEvent["runId"];
      readonly workspaceId: RunEvent["workspaceId"];
      readonly organizationId: RunEvent["organizationId"];
      readonly receiptDigest: string;
      readonly terminalState: RunEventFor<"run.completed">["payload"]["terminalState"]["value"];
      readonly tierReached: VinciRun["requiredTerminal"];
    };

export type RunReplayOptions = {
  /**
   * Trusted host adapter: read the receipt and relevant CURRENT external state,
   * validate both, and establish their binding before returning CONFIRMED.
   * A receipt digest, worker narration, or a shape-valid receipt alone does not
   * establish that an action happened. Missing/unavailable/ambiguous evidence
   * must return UNCONFIRMED. Replaying re-observes terminal evidence.
   * This helper does not authenticate the adapter or authorize external writes.
   */
  readonly observeCompletion?: (
    run: VinciRun,
    event: RunEventFor<"run.completed">,
    events: readonly RunEvent[],
  ) => CompletionObservation;
  /** Metadata only: never log the event, receipt, or validator message. */
  readonly logRefusal?: (message: string, fields: { readonly code: string; readonly revision: number }) => void;
};

export type RunReplaySnapshot = {
  readonly run: VinciRun;
  /** CAS revision is the last accepted canonical event sequence, initially 0. */
  readonly revision: number;
  readonly pendingQuestionId: string | null;
  readonly pendingApprovalId: string | null;
  /** Observed response counts, not an inferred total of all human attention. */
  readonly responses: {
    readonly questions: number;
    readonly approvals: number;
    readonly humanSeconds: number;
  };
};

export type RunReplayAppendResult =
  | { readonly kind: "append" | "duplicate"; readonly snapshot: RunReplaySnapshot }
  | { readonly kind: "reject"; readonly issues: readonly ValidationIssue[]; readonly snapshot: RunReplaySnapshot };

/**
 * An in-memory admission/replay kernel over existing canonical run/events.
 * Persist the declaration and accepted events in the host's authoritative
 * store; this object is disposable and supplies neither persistence nor a
 * database transaction. A host must compare-and-append atomically there.
 * Approval events project waiting state; they NEVER grant execution authority.
 */
export class RunReplay {
  private readonly declaration: VinciRun;
  private readonly options: RunReplayOptions;
  private events: RunEvent[] = [];
  private seen = new Map<string, RunEvent>();
  private pendingQuestionId: string | null = null;
  private pendingApprovalId: string | null = null;
  private issuedQuestionIds = new Set<string>();
  private issuedApprovalIds = new Set<string>();
  private responses = { questions: 0, approvals: 0, humanSeconds: 0 };

  constructor(declaration: unknown, options: RunReplayOptions = {}) {
    this.options = options;
    const valid = validateRun(declaration);
    if (!valid.ok || valid.value.state !== "CREATED" || valid.value.startedAt !== null || valid.value.lastEventAt !== null) {
      this.log("invalid_replay_declaration");
      throw new Error("Run replay requires a valid initial CREATED declaration. Reload the original declaration and its accepted events.");
    }
    this.declaration = structuredClone(valid.value);
  }

  snapshot(): RunReplaySnapshot {
    const started = this.events.find((event) => event.type === "run.started");
    return structuredClone({
      run: {
        ...this.declaration,
        state: projectRunState(this.events).state,
        startedAt: started?.occurredAt ?? null,
        lastEventAt: this.events.at(-1)?.occurredAt ?? null,
      },
      revision: this.events.at(-1)?.sequence ?? 0,
      pendingQuestionId: this.pendingQuestionId,
      pendingApprovalId: this.pendingApprovalId,
      responses: this.responses,
    });
  }

  acceptedEvents(): readonly RunEvent[] {
    return structuredClone(this.events);
  }

  append(input: unknown, expectedRevision: number): RunReplayAppendResult {
    const valid = validateRunEvent(input);
    if (!valid.ok) return this.reject(valid.issues);
    const candidate = valid.value;
    if (candidate.runId !== this.declaration.runId) return this.refuse("wrong_run");
    const verdict = verifyAppend(this.events.at(-1) ?? null, candidate, this.seen);
    if (verdict.kind === "reject") return this.refuse(verdict.rejection.reason);
    // Exact retries succeed even with their original revision or after terminal.
    if (verdict.kind === "duplicate") return { kind: "duplicate", snapshot: this.snapshot() };
    if (expectedRevision !== this.snapshot().revision) return this.refuse("stale_revision");
    if (this.events.length === 0 && candidate.type !== "run.created") return this.refuse("creation_event_required");
    if (this.events.length > 0 && candidate.type === "run.created") return this.refuse("run_already_created");
    if (candidate.type === "run.created") {
      if (candidate.payload.workspaceId.value !== candidate.workspaceId) return this.refuse("workspace_binding_mismatch");
      if (candidate.payload.workOrderDigest?.value !== this.declaration.workOrderDigest) return this.refuse("work_order_binding_missing_or_changed");
    }
    if (candidate.type === "run.started" && this.events.some((event) => event.type === "run.started")) return this.refuse("run_already_started");
    if (candidate.type !== "run.created" && candidate.type !== "run.started" && !this.events.some((event) => event.type === "run.started")) return this.refuse("run_not_started");
    const projected = projectRunState([...this.events, candidate]);
    if (projected.issues.length > 0) return this.reject(projected.issues);
    const pending = this.pendingQuestionId !== null || this.pendingApprovalId !== null;
    if (candidate.type === "run.question" || candidate.type === "approval.requested") {
      if (pending) return this.refuse("decision_already_pending");
      if (candidate.type === "run.question" && this.issuedQuestionIds.has(candidate.payload.questionId.value)) return this.refuse("question_id_reused");
      if (candidate.type === "approval.requested" && this.issuedApprovalIds.has(candidate.payload.approvalId.value)) return this.refuse("approval_id_reused");
      if (this.snapshot().run.state !== "RUNNING") return this.refuse("run_not_running");
    }
    if (candidate.type === "run.question_answered" && candidate.payload.questionId.value !== this.pendingQuestionId) return this.refuse("question_not_pending");
    if ((candidate.type === "approval.granted" || candidate.type === "approval.denied" || candidate.type === "approval.expired") && candidate.payload.approvalId.value !== this.pendingApprovalId) return this.refuse("approval_not_pending");
    if (pending && (candidate.type === "run.resumed" || candidate.type === "run.attempt_started" || candidate.type === "run.started")) return this.refuse("decision_still_pending");
    if (candidate.type === "run.completed") {
      if (pending) return this.refuse("decision_still_pending");
      if (this.snapshot().run.state !== "RUNNING") return this.refuse("run_not_running");
      if (terminalEvidenceMissing(this.events).length > 0) return this.refuse("artifact_evidence_missing");
      let observed: CompletionObservation;
      try {
        observed = this.options.observeCompletion?.(structuredClone(this.declaration), structuredClone(candidate), this.acceptedEvents()) ?? { status: "UNCONFIRMED" };
      } catch {
        return this.refuse("completion_observation_unavailable");
      }
      if (observed.status !== "CONFIRMED") return this.refuse("completion_unconfirmed");
      if (observed.runId !== candidate.runId || observed.workspaceId !== candidate.workspaceId || observed.organizationId !== candidate.organizationId || observed.receiptDigest !== candidate.payload.receiptDigest?.value || observed.terminalState !== candidate.payload.terminalState.value) return this.refuse("completion_binding_mismatch");
      if (observed.tierReached !== candidate.payload.tierReached?.value || TERMINAL_TIERS.indexOf(observed.tierReached) < TERMINAL_TIERS.indexOf(this.declaration.requiredTerminal)) return this.refuse("required_terminal_not_observed");
    }
    // Snapshot the validator result: mutating the caller's object must not rewrite history.
    const event = structuredClone(candidate);
    this.events.push(event);
    this.seen.set(event.idempotencyKey, event);
    switch (event.type) {
      case "run.question":
        this.pendingQuestionId = event.payload.questionId.value;
        this.issuedQuestionIds.add(event.payload.questionId.value);
        break;
      case "approval.requested":
        this.pendingApprovalId = event.payload.approvalId.value;
        this.issuedApprovalIds.add(event.payload.approvalId.value);
        break;
      case "run.question_answered":
        this.pendingQuestionId = null;
        this.responses.questions += 1;
        this.responses.humanSeconds += event.payload.humanSeconds.value;
        break;
      case "approval.granted":
      case "approval.denied":
        this.pendingApprovalId = null;
        this.responses.approvals += 1;
        this.responses.humanSeconds += event.payload.humanSeconds.value;
        break;
      case "approval.expired":
        // DENY is the canonical expiry default. Clear the pending item without
        // changing projectRunState's PAUSED result or inventing human attention.
        this.pendingApprovalId = null;
        break;
      case "run.failed":
      case "run.cancelled":
        this.pendingQuestionId = null;
        this.pendingApprovalId = null;
        break;
    }
    return { kind: "append", snapshot: this.snapshot() };
  }

  private log(code: string): void {
    const message = "Run event admission was refused; reload authoritative run state and resolve the reported evidence or ordering issue before retrying.";
    const fields = { code, revision: this.events.at(-1)?.sequence ?? 0 };
    if (this.options.logRefusal) this.options.logRefusal(message, fields);
    else console.info(message, fields);
  }

  private refuse(code: string): RunReplayAppendResult {
    return this.reject([{ path: "/event", code, message: "Run event cannot be accepted. Reload authoritative run state and resolve its evidence or ordering issue before retrying." }]);
  }

  private reject(issues: readonly ValidationIssue[]): RunReplayAppendResult {
    for (const issue of issues) this.log(issue.code);
    return { kind: "reject", issues, snapshot: this.snapshot() };
  }
}

/**
 * Stop at the first refusal; never sort, renumber, skip, or invent missing events.
 * Nonempty issues make the whole reconstruction unusable for execution. The
 * returned object contains only the admitted prefix for diagnosis: preserve
 * the original stored log, surface the refusal, and never truncate that log or
 * restart a worker from this prefix. Completion currency can change even when
 * its original append-only history remains intact.
 */
export function replayRun(
  declaration: unknown,
  events: readonly unknown[],
  options: RunReplayOptions = {},
): { readonly replay: RunReplay; readonly issues: readonly ValidationIssue[] } {
  const replay = new RunReplay(declaration, options);
  for (const event of events) {
    const result = replay.append(event, replay.snapshot().revision);
    if (result.kind === "reject") return { replay, issues: result.issues };
  }
  return { replay, issues: [] };
}
