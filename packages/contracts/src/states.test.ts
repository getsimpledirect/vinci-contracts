import { isOrganizationWorkspace } from "./ids.ts";
import { terminalStateOfVerification } from "./states.ts";
import { describe, expect, it } from "vitest";
import {
  RUN_STATES,
  TERMINAL_STATES,
  VERDICT_STATUSES,
  isTerminal,
  terminalStateOf,
  terminalStateOfVerification,
  type TerminalState,
  type VerdictStatus,
  type VerificationOutcome,
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

describe("terminalStateOfVerification", () => {
  it("preserves the mapping vinci-code ships, for every input it can receive", () => {
    // Mirrors remoteVerdictTaskState() in vinci/extensions/lib/task-outcome.ts.
    // If this table changes, that runtime changes behaviour.
    const fresh = (status: VerdictStatus) => ({ kind: "issued", status, staled: false }) as const;
    expect(terminalStateOfVerification(fresh("VERIFIED_PASS"))).toBe("DONE");
    expect(terminalStateOfVerification(fresh("BLOCKED"))).toBe("BLOCKED");
    expect(terminalStateOfVerification(fresh("CONDITIONAL"))).toBe("DONE_UNVERIFIED");
  });

  it("returns no state when the job produced no assessment", () => {
    // vinci-code's FAILED and CANCELLED switch arms are unreachable from a real
    // Acceptance verdict; here those cases are a different shape entirely, so a
    // consumer must handle "there is no verdict" before reading a status.
    expect(terminalStateOfVerification({ kind: "not-issued", reason: "FAILED" })).toBeUndefined();
    expect(terminalStateOfVerification({ kind: "not-issued", reason: "CANCELLED" })).toBeUndefined();
  });

  it("never reports a pass from a stale verdict", () => {
    // FR-7.4: a stale verdict stays visible as history but must not be
    // represented as current.
    for (const status of VERDICT_STATUSES) {
      expect(terminalStateOfVerification({ kind: "issued", status, staled: true })).toBeUndefined();
    }
  });

  it("reaches DONE only from a fresh VERIFIED_PASS", () => {
    // The strongest statement of FR-6.4 this type can make: enumerate every
    // possible outcome and assert exactly one of them yields DONE.
    const all: VerificationOutcome[] = [
      ...VERDICT_STATUSES.flatMap((status) => [
        { kind: "issued", status, staled: false } as const,
        { kind: "issued", status, staled: true } as const,
      ]),
      { kind: "not-issued", reason: "FAILED" },
      { kind: "not-issued", reason: "CANCELLED" },
    ];
    const done = all.filter((o) => terminalStateOfVerification(o) === "DONE");
    expect(done).toEqual([{ kind: "issued", status: "VERIFIED_PASS", staled: false }]);
  });

  it("matches the only statuses the producer can emit", () => {
    // vinci-acceptance packages/protocol/src/types.ts:
    //   export type VerdictStatus = "VERIFIED_PASS" | "BLOCKED" | "CONDITIONAL";
    // If Acceptance ever widens that union, this test is the tripwire.
    expect([...VERDICT_STATUSES].sort()).toEqual(["BLOCKED", "CONDITIONAL", "VERIFIED_PASS"]);
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

describe("contracts predicates refuse hostile input instead of throwing", () => {
  const hostile: Array<[string, unknown]> = [
    ["the string toString", "toString"],
    ["the string constructor", "constructor"],
    ["the string __proto__", "__proto__"],
    ["null", null],
    ["undefined", undefined],
    ["a number", 7],
    ["an array", []],
    ["a sparse array", new Array(1)],
    ["a symbol", Symbol("x")],
    ["a throwing-get proxy", new Proxy({}, { get() { throw new Error("trap"); } })],
    ["a throwing getter", { get kind(): never { throw new Error("g"); } }],
    ["an inherited kind", Object.create({ kind: "organization", workspaceId: "w", organizationId: "o" })],
  ];

  it("isOrganizationWorkspace never throws and never says yes to hostile input", () => {
    for (const [label, value] of hostile) {
      expect(() => isOrganizationWorkspace(value as never), label).not.toThrow();
      expect(isOrganizationWorkspace(value as never), label).not.toBe(true);
    }
  });

  it("terminalStateOfVerification never throws and never invents a terminal state", () => {
    for (const [label, value] of hostile) {
      expect(() => terminalStateOfVerification(value as never), label).not.toThrow();
      expect(terminalStateOfVerification(value as never), label).toBeUndefined();
    }
  });

  it("still answers correctly for genuine input", () => {
    // Positive controls. Returning false/undefined for everything satisfies
    // both cases above and makes each function useless.
    expect(isOrganizationWorkspace({
      kind: "organization", workspaceId: "w", organizationId: "o",
    } as never)).toBe(true);
    expect(isOrganizationWorkspace({ kind: "personal", workspaceId: "w", ownerId: "u" } as never)).toBe(false);
    expect(terminalStateOfVerification({
      kind: "issued", staled: false, status: "VERIFIED_PASS",
    } as never)).toBeDefined();
    expect(terminalStateOfVerification({ kind: "not-issued", reason: "FAILED" } as never)).toBeUndefined();
  });
});
