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
 * A verdict is not a run state. A run may be `DONE_UNVERIFIED` with no verdict
 * at all, or `DONE` carrying a verdict that has since gone stale (FR-7.4).
 * Keeping the types separate is what stops a worker's own claim from being
 * rendered as independent verification (§8.1, principle 2).
 */
export const VERDICTS = [
  "VERIFIED_PASS",
  "CONDITIONAL",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
] as const;

export type Verdict = (typeof VERDICTS)[number];

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
 * The terminal state implied by an Acceptance verdict, or `undefined` when the
 * verdict does not change the run's own state.
 *
 * This is the behaviour vinci-code already ships in `remoteVerdictTaskState()`
 * (`vinci/extensions/lib/task-outcome.ts`), preserved exactly and moved here so
 * that Code and Acceptance cannot drift apart by hand-copied switch statement.
 *
 * The two `undefined` cases are deliberate and load-bearing:
 *  - a `CANCELLED` verdict says the *verification* was cancelled, which tells
 *    us nothing about the work itself;
 *  - a staled verdict (FR-7.4) is historical evidence and must not be
 *    represented as current, so callers must pass `staled: true` and get
 *    `undefined` rather than silently re-applying an outdated pass.
 *
 * In both cases the run's locally-determined state remains authoritative.
 */
export function terminalStateOfVerdict(
  verdict: Verdict,
  options: { readonly staled: boolean },
): TerminalState | undefined {
  if (options.staled) return undefined;
  switch (verdict) {
    case "VERIFIED_PASS":
      return "DONE";
    case "BLOCKED":
      return "BLOCKED";
    case "CONDITIONAL":
    case "FAILED":
      // A conditional verdict is not a pass. FR-7 requires that a run which
      // skipped a required check reads as unverified rather than done.
      return "DONE_UNVERIFIED";
    case "CANCELLED":
      return undefined;
  }
}

export function isRunState(value: unknown): value is RunState {
  return typeof value === "string" && (RUN_STATES as readonly string[]).includes(value);
}

export function isTerminalState(value: unknown): value is TerminalState {
  return typeof value === "string" && (TERMINAL_STATES as readonly string[]).includes(value);
}

export function isVerdict(value: unknown): value is Verdict {
  return typeof value === "string" && (VERDICTS as readonly string[]).includes(value);
}
