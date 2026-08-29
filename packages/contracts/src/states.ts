/**
 * The three state vocabularies, and the total mappings between them.
 *
 * This module is the reason this repository exists. The E0 exit gate is
 * "no repository independently defines conflicting run states" (§17), and
 * before this file there were three overlapping definitions: FR-2.2's twelve
 * live states, FR-6.2's six receipt final states, and the four-member
 * `VinciTaskState` shipping in vinci-code.
 *
 * They are three types, not one. See docs/E0-decisions.md, D1.
 */

import { ownData } from "./scalars.ts";

/**
 * The live state machine (FR-2.2). What a run *is* right now.
 *
 * Note there is no `WAITING` member: while a run is live, the reason it is
 * waiting is what matters, because it determines whether the run appears in
 * Mobile's pending-decision queue (FR-5.1) and who can clear it.
 */
export const RUN_STATES = [
  "CREATED",
  "PLANNING",
  "RUNNING",
  "WAITING_FOR_APPROVAL",
  "WAITING_FOR_USER",
  "PAUSED",
  "VERIFYING",
  "DONE",
  "DONE_UNVERIFIED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
] as const;

export type RunState = (typeof RUN_STATES)[number];

/**
 * The final state recorded on a receipt (FR-6.2). What a run *ended as*.
 *
 * FR-6.2 forbids collapsing these into a generic "completed" state, so this
 * type has no `COMPLETE` member and never will. `DONE` and `DONE_UNVERIFIED`
 * are distinct outcomes, not a detail of one.
 *
 * vinci-code's shipping `VinciTaskState` is a strict subset of this type
 * (`DONE`, `DONE_UNVERIFIED`, `WAITING`, `BLOCKED`), so adopting it there is
 * additive and no persisted value changes meaning.
 */
export const TERMINAL_STATES = [
  "DONE",
  "DONE_UNVERIFIED",
  "WAITING",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
] as const;

export type TerminalState = (typeof TERMINAL_STATES)[number];

/**
 * An assessment issued by Acceptance or another designated verifier (FR-7.2).
 *
 * FR-7.2 names five "verdicts": VERIFIED_PASS, CONDITIONAL, BLOCKED, FAILED and
 * CANCELLED. Only the first three are assessments. The producer proves it:
 * `vinci-acceptance` declares
 * `VerdictStatus = "VERIFIED_PASS" | "BLOCKED" | "CONDITIONAL"`
 * (packages/protocol/src/types.ts) and nothing else can ever be issued.
 *
 * FAILED and CANCELLED are states of the verification *job*, not judgements
 * about the work. A job that crashes or is cancelled produces no assessment at
 * all — `AcceptanceJob.verdict` is optional precisely because of this.
 *
 * Modelling all five as one union is what lets a consumer write a switch arm
 * for a value the producer cannot emit. `vinci-code`'s
 * `remoteVerdictTaskState()` has exactly that shape today: its FAILED and
 * CANCELLED arms are unreachable from a real Acceptance verdict.
 *
 * So the five names are preserved, and split across the two things they
 * actually describe.
 */
export const VERDICT_STATUSES = ["VERIFIED_PASS", "CONDITIONAL", "BLOCKED"] as const;

/** What a verifier can actually issue. */
export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

/**
 * The outcome of asking for verification: either an assessment was issued, or
 * the job ended without producing one.
 *
 * A consumer cannot read a status without first handling the case where there
 * is none, which is the property that makes "no verdict" impossible to render
 * as a pass (FR-6.4).
 */
export type VerificationOutcome =
  | {
      readonly kind: "issued";
      readonly status: VerdictStatus;
      /**
       * The evaluated state has since changed (FR-7.4). A staled verdict stays
       * visible as history and must not be represented as current.
       */
      readonly staled: boolean;
    }
  | {
      readonly kind: "not-issued";
      /** The job's own terminal state. Says nothing about the work itself. */
      readonly reason: "FAILED" | "CANCELLED";
    };

const TERMINAL_BY_RUN_STATE: Readonly<Record<RunState, TerminalState | null>> = {
  CREATED: null,
  PLANNING: null,
  RUNNING: null,
  PAUSED: null,
  VERIFYING: null,
  // Both waiting reasons collapse to one terminal state: the distinction drives
  // live supervision and stops mattering once the receipt is written.
  WAITING_FOR_APPROVAL: "WAITING",
  WAITING_FOR_USER: "WAITING",
  DONE: "DONE",
  DONE_UNVERIFIED: "DONE_UNVERIFIED",
  BLOCKED: "BLOCKED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
};

/**
 * The terminal state a run in `state` would be recorded as, or `null` if the
 * run has not ended.
 *
 * `null` is an answer, not an error: it means "this run is still live". A
 * caller writing a receipt for a `null` result is the bug, and callers should
 * treat `null` as "no receipt yet" rather than defaulting to any state — least
 * of all `DONE`.
 */
export function terminalStateOf(state: RunState): TerminalState | null {
  return TERMINAL_BY_RUN_STATE[state];
}

export function isTerminal(state: RunState): boolean {
  return TERMINAL_BY_RUN_STATE[state] !== null;
}

/**
 * The terminal state implied by a verification outcome, or `undefined` when the
 * outcome does not change the run's own state.
 *
 * This preserves the behaviour `vinci-code` already ships in
 * `remoteVerdictTaskState()` (`vinci/extensions/lib/task-outcome.ts`) for every
 * input that function can actually receive, and moves it here so Code and
 * Acceptance cannot drift apart by hand-copied switch statement.
 *
 * `undefined` means "the run's locally-determined state remains authoritative":
 *  - a staled verdict (FR-7.4) is history, not a current assessment;
 *  - a job that FAILED or was CANCELLED tells us about the verification, not
 *    about the work — the run is no more and no less done than it already was.
 *
 * Note what is absent: there is no input for which this returns `DONE` other
 * than a fresh VERIFIED_PASS. That is the whole point (FR-6.4, §8.1).
 */
export function terminalStateOfVerification(
  outcome: VerificationOutcome,
): TerminalState | undefined {
  const kind = ownData(outcome, "kind");
  if (kind === "not-issued") return undefined;
  const staled = ownData(outcome, "staled");
  if (staled) return undefined;
  const status = ownData(outcome, "status");
  switch (status) {
    case "VERIFIED_PASS":
      return "DONE";
    case "BLOCKED":
      return "BLOCKED";
    case "CONDITIONAL":
      // A conditional verdict is not a pass. FR-7's acceptance criterion: a run
      // that skipped a required integration test must not read as verified.
      return "DONE_UNVERIFIED";
  }
}

export function isRunState(value: unknown): value is RunState {
  return typeof value === "string" && (RUN_STATES as readonly string[]).includes(value);
}

export function isTerminalState(value: unknown): value is TerminalState {
  return typeof value === "string" && (TERMINAL_STATES as readonly string[]).includes(value);
}

export function isVerdictStatus(value: unknown): value is VerdictStatus {
  return typeof value === "string" && (VERDICT_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The three outcome dimensions (Worker plan ruling, 2026-08-28).
//
// There is no single global "completed". A run's outcome is a point in three
// independent dimensions — what execution produced, what assurance was
// established about it, and whether it was promoted — plus the server's own
// record of whether the evidence the worker declared could be verified. Each
// dimension has its own closed vocabulary and its own legality table; the only
// place they meet is `deriveLegacyTerminal`, which collapses a triple onto the
// Worker's older single-axis terminal vocabulary for consumers that still read
// one word.
//
// These vocabularies do not replace `RunState`/`TerminalState`/`VerdictStatus`
// above. Those describe a run as the FR-2.2 live machine and the FR-6.2
// receipt see it. These describe a work-order ATTEMPT as the Worker and the
// authority ledger see it. `ASSURANCE_STATES` deliberately embeds the three
// `VerdictStatus` members by name so a verifier's verdict is an assurance state
// without translation.
// ---------------------------------------------------------------------------

/**
 * What execution did. Owned by the worker (and by the lease machinery for
 * PENDING/LEASED/LOST).
 *
 * ARTIFACT_PRODUCED is the strongest thing execution can say: an artifact
 * exists. It says nothing about whether the artifact is any good — that is the
 * assurance dimension's question, and keeping it out of this vocabulary is the
 * point of having three.
 *
 * BLOCKED, FAILED, LOST and ARTIFACT_PRODUCED are terminal for the ATTEMPT. A
 * retry is a new attempt with its own execution state, never a resumption; the
 * legality table below has no arc out of any of them.
 */
export const EXECUTION_STATES = [
  "PENDING",
  "LEASED",
  "RUNNING",
  "ARTIFACT_PRODUCED",
  "BLOCKED",
  "FAILED",
  "LOST",
] as const;

export type ExecutionState = (typeof EXECUTION_STATES)[number];

/**
 * What has been established about the artifact. Owned by verifiers.
 *
 * SELF_CHECKED is the worker's own claim that its checks passed. It is
 * recorded because it is information, and it is ranked below every verifier
 * verdict because a worker checking its own work is not verification (FR-7.3
 * requires independence to be disclosed; this vocabulary makes non-independence
 * a different word). The three remaining members are `VERDICT_STATUSES`
 * verbatim.
 */
export const ASSURANCE_STATES = [
  "NOT_EVALUATED",
  "SELF_CHECKED",
  "VERIFIED_PASS",
  "CONDITIONAL",
  "BLOCKED",
] as const;

export type AssuranceState = (typeof ASSURANCE_STATES)[number];

/**
 * Whether the artifact was allowed to take effect. Owned by the authority
 * ledger (promotion.* entries), never by the worker.
 *
 * ELIGIBLE means the assurance dimension permits promotion; APPROVED means a
 * holder of authority said yes; APPLIED means it took effect. REVOKED is
 * terminal: a revoked promotion is history, and re-promotion is a new cycle
 * on a new attempt.
 */
export const PROMOTION_STATES = [
  "NOT_ELIGIBLE",
  "ELIGIBLE",
  "APPROVED",
  "APPLIED",
  "REVOKED",
] as const;

export type PromotionState = (typeof PROMOTION_STATES)[number];

/**
 * The server's verification of the evidence the worker DECLARED.
 *
 * This is not a fourth dimension of the outcome; it is the server's annotation
 * of the evidence behind it. DECLARED is the worker's claim; VERIFIED and
 * MISMATCH are the server's finding on fetching the referenced content and
 * comparing digests; UNAVAILABLE means the server could not fetch it, which is
 * neither a match nor a mismatch and must never be read as either.
 */
export const EVIDENCE_STATES = [
  "NOT_ATTEMPTED",
  "DECLARED",
  "VERIFIED",
  "MISMATCH",
  "UNAVAILABLE",
] as const;

export type EvidenceState = (typeof EVIDENCE_STATES)[number];

/**
 * The Worker's single-axis terminal vocabulary, kept for consumers that read
 * one word. Nothing in this repository produces one of these except
 * `deriveLegacyTerminal`, and that is deliberate: the only way to reach
 * COMPLETED is through a triple that earns it.
 */
export const WORKER_TERMINAL_STATES = [
  "COMPLETED",
  "UNVERIFIED",
  "BLOCKED",
  "FAILED",
  "LOST",
] as const;

export type WorkerTerminalState = (typeof WORKER_TERMINAL_STATES)[number];

export const STATE_DIMENSIONS = ["execution", "assurance", "promotion", "evidence"] as const;

export type StateDimension = (typeof STATE_DIMENSIONS)[number];

/**
 * The full outcome of one attempt: a point in the three dimensions plus the
 * server's evidence annotation.
 *
 * Named a triple because three of its members are the outcome; `evidence` rides
 * along because every consumer that wants the triple wants to know whether the
 * evidence behind it held up, and carrying it separately invited exactly the
 * "verified, but against what?" reading FR-6.4 forbids.
 */
export type OutcomeTriple = {
  readonly execution: ExecutionState;
  readonly assurance: AssuranceState;
  readonly promotion: PromotionState;
  readonly evidence: EvidenceState;
};

/** The states a dimension may move to from each state. Absent key = terminal. */
type LegalityTable<S extends string> = Readonly<Record<S, readonly S[]>>;

/**
 * An attempt moves forward only. The two arcs that look like going backwards
 * are not: LEASED -> PENDING is a lease expiring without the worker ever
 * starting, which returns the order to the queue as the same attempt; and
 * nothing leaves a terminal state.
 */
const EXECUTION_TRANSITIONS: LegalityTable<ExecutionState> = {
  PENDING: ["LEASED", "LOST"],
  LEASED: ["RUNNING", "PENDING", "FAILED", "LOST"],
  RUNNING: ["ARTIFACT_PRODUCED", "BLOCKED", "FAILED", "LOST"],
  ARTIFACT_PRODUCED: [],
  BLOCKED: [],
  FAILED: [],
  LOST: [],
};

/**
 * A verifier verdict supersedes any earlier assurance, including an earlier
 * verdict (re-verification). Two things are deliberately impossible:
 *
 *  - no verdict state moves to SELF_CHECKED, because a worker's own check
 *    cannot displace a verifier's finding;
 *  - every verdict state can fall back to NOT_EVALUATED, because a verdict
 *    stales when what it evaluated changes (FR-7.4), and a staled verdict is
 *    history, not current assurance.
 */
const ASSURANCE_TRANSITIONS: LegalityTable<AssuranceState> = {
  NOT_EVALUATED: ["SELF_CHECKED", ...VERDICT_STATUSES],
  SELF_CHECKED: [...VERDICT_STATUSES],
  VERIFIED_PASS: ["NOT_EVALUATED", "CONDITIONAL", "BLOCKED"],
  CONDITIONAL: ["NOT_EVALUATED", "VERIFIED_PASS", "BLOCKED"],
  BLOCKED: ["NOT_EVALUATED", "VERIFIED_PASS", "CONDITIONAL"],
};

/**
 * Eligibility follows assurance and can be withdrawn while nobody has acted
 * on it; once approved, the only way out is APPLIED or REVOKED. REVOKED is
 * terminal — see `PROMOTION_STATES`.
 */
const PROMOTION_TRANSITIONS: LegalityTable<PromotionState> = {
  NOT_ELIGIBLE: ["ELIGIBLE"],
  ELIGIBLE: ["APPROVED", "NOT_ELIGIBLE"],
  APPROVED: ["APPLIED", "REVOKED"],
  APPLIED: ["REVOKED"],
  REVOKED: [],
};

/**
 * The server may retry an unavailable fetch and may re-check verified
 * evidence later (and find it changed). MISMATCH is terminal: once the
 * declared content has been shown not to match, no later fetch can un-show it.
 */
const EVIDENCE_TRANSITIONS: LegalityTable<EvidenceState> = {
  NOT_ATTEMPTED: ["DECLARED", "UNAVAILABLE"],
  DECLARED: ["VERIFIED", "MISMATCH", "UNAVAILABLE"],
  VERIFIED: ["MISMATCH", "UNAVAILABLE"],
  MISMATCH: [],
  UNAVAILABLE: ["VERIFIED", "MISMATCH"],
};

const TRANSITIONS: Readonly<Record<StateDimension, Readonly<Record<string, readonly string[]>>>> = {
  execution: EXECUTION_TRANSITIONS,
  assurance: ASSURANCE_TRANSITIONS,
  promotion: PROMOTION_TRANSITIONS,
  evidence: EVIDENCE_TRANSITIONS,
};

/**
 * May `dimension` move from `from` to `to`?
 *
 * Pure and total: an unknown dimension, an unknown state, or a hostile value
 * answers `false` rather than throwing, and `from === to` is `false` because
 * staying put is not a transition. Lookups are own-data reads so a value such
 * as `"constructor"` cannot reach `Object.prototype` and answer with a
 * function.
 */
export function canTransition(dimension: StateDimension, from: string, to: string): boolean {
  if (typeof from !== "string" || typeof to !== "string" || from === to) return false;
  const table = ownData(TRANSITIONS, dimension);
  if (typeof table !== "object" || table === null) return false;
  const targets = ownData(table, from);
  if (!Array.isArray(targets)) return false;
  return (targets as readonly unknown[]).includes(to);
}

/** Legal successors of `from` in `dimension`; empty for a terminal or unknown state. */
export function legalTransitionsFrom(dimension: StateDimension, from: string): readonly string[] {
  const table = ownData(TRANSITIONS, dimension);
  if (typeof table !== "object" || table === null) return [];
  const targets = ownData(table, from);
  return Array.isArray(targets) ? [...(targets as readonly string[])] : [];
}

/**
 * Promotion states under which a VERIFIED_PASS artifact counts as COMPLETED in
 * the legacy vocabulary. NOT_ELIGIBLE and REVOKED are the two ways the
 * promotion side says no, and either denies the word.
 */
const PROMOTION_STATES_NOT_DENYING: readonly PromotionState[] = ["ELIGIBLE", "APPROVED", "APPLIED"];

/**
 * The Worker's single-word terminal state for a triple, or `null` while the
 * attempt is still live.
 *
 * The exact rule:
 *
 *   COMPLETED   iff execution = ARTIFACT_PRODUCED
 *               and assurance = VERIFIED_PASS
 *               and promotion in {ELIGIBLE, APPROVED, APPLIED}
 *               and evidence != MISMATCH
 *   BLOCKED     iff execution = BLOCKED,
 *               or execution = ARTIFACT_PRODUCED and assurance = BLOCKED
 *   FAILED      iff execution = FAILED
 *   LOST        iff execution = LOST
 *   UNVERIFIED  iff execution = ARTIFACT_PRODUCED and none of the above
 *   null        iff execution in {PENDING, LEASED, RUNNING}
 *
 * Every arm is what it says. The one that matters most is UNVERIFIED being the
 * residue: an artifact with NOT_EVALUATED or SELF_CHECKED assurance is the
 * obvious case, but so is CONDITIONAL (a conditional verdict is not a pass —
 * the same rule `terminalStateOfVerification` applies), a VERIFIED_PASS whose
 * promotion was denied or revoked, and a VERIFIED_PASS whose declared evidence
 * the server found to MISMATCH. The legacy vocabulary cannot say "verified but
 * not promotable" or "verified against evidence that did not hold"; when it
 * cannot say the precise thing, it says the weaker one.
 *
 * Note what is absent: there is no path to COMPLETED that does not pass
 * through VERIFIED_PASS. That is FR-6.4 restated for this vocabulary, and the
 * property test in states.test.ts enumerates every triple to hold it.
 */
export function deriveLegacyTerminal(triple: OutcomeTriple): WorkerTerminalState | null {
  const execution = ownData(triple, "execution");
  switch (execution) {
    case "PENDING":
    case "LEASED":
    case "RUNNING":
      return null;
    case "BLOCKED":
      return "BLOCKED";
    case "FAILED":
      return "FAILED";
    case "LOST":
      return "LOST";
    case "ARTIFACT_PRODUCED":
      break;
    default:
      // Not an execution state. Refusing to name a terminal state is the
      // correct answer; inventing one — least of all COMPLETED — is not.
      return null;
  }
  const assurance = ownData(triple, "assurance");
  const promotion = ownData(triple, "promotion");
  const evidence = ownData(triple, "evidence");
  if (
    assurance === "VERIFIED_PASS"
    && isPromotionState(promotion)
    && PROMOTION_STATES_NOT_DENYING.includes(promotion)
    && isEvidenceState(evidence)
    && evidence !== "MISMATCH"
  ) {
    return "COMPLETED";
  }
  if (assurance === "BLOCKED") return "BLOCKED";
  return "UNVERIFIED";
}

export function isExecutionState(value: unknown): value is ExecutionState {
  return typeof value === "string" && (EXECUTION_STATES as readonly string[]).includes(value);
}

export function isAssuranceState(value: unknown): value is AssuranceState {
  return typeof value === "string" && (ASSURANCE_STATES as readonly string[]).includes(value);
}

export function isPromotionState(value: unknown): value is PromotionState {
  return typeof value === "string" && (PROMOTION_STATES as readonly string[]).includes(value);
}

export function isEvidenceState(value: unknown): value is EvidenceState {
  return typeof value === "string" && (EVIDENCE_STATES as readonly string[]).includes(value);
}

export function isWorkerTerminalState(value: unknown): value is WorkerTerminalState {
  return typeof value === "string" && (WORKER_TERMINAL_STATES as readonly string[]).includes(value);
}

export function isStateDimension(value: unknown): value is StateDimension {
  return typeof value === "string" && (STATE_DIMENSIONS as readonly string[]).includes(value);
}

/** Every member is a known state of its dimension. Own-data reads only. */
export function isOutcomeTriple(value: unknown): value is OutcomeTriple {
  return (
    isExecutionState(ownData(value, "execution"))
    && isAssuranceState(ownData(value, "assurance"))
    && isPromotionState(ownData(value, "promotion"))
    && isEvidenceState(ownData(value, "evidence"))
  );
}
