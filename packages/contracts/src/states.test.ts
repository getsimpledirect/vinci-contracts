import { describe, expect, it } from "vitest";
import {
  RUN_STATES,
  TERMINAL_STATES,
  VERDICTS,
  isTerminal,
  terminalStateOf,
  terminalStateOfVerdict,
  type TerminalState,
} from "./states.ts";

describe("terminalStateOf", () => {
  it("is total over every run state", () => {
    // A missing key would surface as `undefined`, which callers must never
    // confuse with the deliberate `null` meaning "still live".
    for (const state of RUN_STATES) {
      const result = terminalStateOf(state);
      expect(result === null || TERMINAL_STATES.includes(result)).toBe(true);
      expect(result).not.toBeUndefined();
    }
  });

  it("reaches every terminal state from some run state", () => {
    // Guards against adding a TerminalState that no run can actually end in.
    const reachable = new Set(RUN_STATES.map(terminalStateOf).filter((s): s is TerminalState => s !== null));
    expect([...reachable].sort()).toEqual([...TERMINAL_STATES].sort());
  });

  it("collapses both waiting reasons to WAITING", () => {
    expect(terminalStateOf("WAITING_FOR_APPROVAL")).toBe("WAITING");
    expect(terminalStateOf("WAITING_FOR_USER")).toBe("WAITING");
  });

  it("treats in-flight states as not ended", () => {
    for (const state of ["CREATED", "PLANNING", "RUNNING", "PAUSED", "VERIFYING"] as const) {
      expect(terminalStateOf(state)).toBeNull();
      expect(isTerminal(state)).toBe(false);
    }
  });

  it("never collapses DONE and DONE_UNVERIFIED together", () => {
    // FR-6.2: these must not become a generic "completed" state.
    expect(terminalStateOf("DONE")).not.toBe(terminalStateOf("DONE_UNVERIFIED"));
  });
});

describe("terminalStateOfVerdict", () => {
  it("preserves the mapping vinci-code already ships", () => {
    // Mirrors remoteVerdictTaskState() in vinci/extensions/lib/task-outcome.ts.
    // If this table changes, that runtime changes behaviour — which is the
    // drift this package exists to prevent.
    const fresh = { staled: false };
    expect(terminalStateOfVerdict("VERIFIED_PASS", fresh)).toBe("DONE");
    expect(terminalStateOfVerdict("BLOCKED", fresh)).toBe("BLOCKED");
    expect(terminalStateOfVerdict("CONDITIONAL", fresh)).toBe("DONE_UNVERIFIED");
    expect(terminalStateOfVerdict("FAILED", fresh)).toBe("DONE_UNVERIFIED");
    expect(terminalStateOfVerdict("CANCELLED", fresh)).toBeUndefined();
  });

  it("never reports a pass from a stale verdict", () => {
    // FR-7.4: a stale verdict stays visible as history but must not be
    // represented as current. The strongest form of that rule is that no
    // staled verdict — least of all VERIFIED_PASS — yields a state at all.
    for (const verdict of VERDICTS) {
      expect(terminalStateOfVerdict(verdict, { staled: true })).toBeUndefined();
    }
  });

  it("never turns a non-pass verdict into DONE", () => {
    // FR-6.4 / FR-7 acceptance criterion: a run that skipped a required check
    // must not read as verified.
    for (const verdict of VERDICTS) {
      if (verdict === "VERIFIED_PASS") continue;
      expect(terminalStateOfVerdict(verdict, { staled: false })).not.toBe("DONE");
    }
  });
});

describe("vinci-code compatibility", () => {
  it("keeps VinciTaskState a strict subset of TerminalState", () => {
    // Adoption in vinci-code must be additive: every value it already
    // persists has to remain valid and mean the same thing.
    const shipping = ["DONE", "DONE_UNVERIFIED", "WAITING", "BLOCKED"] as const;
    for (const state of shipping) {
      expect(TERMINAL_STATES).toContain(state);
    }
    expect(TERMINAL_STATES.length).toBeGreaterThan(shipping.length);
  });
});
