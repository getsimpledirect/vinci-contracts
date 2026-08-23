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

/**
 * Backwards-compatible alias. `Verdict` in the glossary (§7) means the
 * assessment, which is `VerdictStatus`.
 */
export type Verdict = VerdictStatus;

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
  if (outcome.kind === "not-issued") return undefined;
  if (outcome.staled) return undefined;
  switch (outcome.status) {
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
