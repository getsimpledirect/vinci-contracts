import { isOrganizationWorkspace } from "./ids.ts";
import { terminalStateOfVerification } from "./states.ts";
import { describe, expect, it } from "vitest";
import {
  ASSURANCE_STATES,
  EVIDENCE_STATES,
  EXECUTION_STATES,
  PROMOTION_STATES,
  RUN_STATES,
  STATE_DIMENSIONS,
  TERMINAL_STATES,
  VERDICT_STATUSES,
  WORKER_TERMINAL_STATES,
  canTransition,
  deriveLegacyTerminal,
  isOutcomeTriple,
  isTerminal,
  legalTransitionsFrom,
  terminalStateOf,
  terminalStateOfVerification,
  type AssuranceState,
  type EvidenceState,
  type ExecutionState,
  type OutcomeTriple,
  type PromotionState,
  type StateDimension,
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

// ---------------------------------------------------------------------------
// The three outcome dimensions.
// ---------------------------------------------------------------------------

/** Every triple there is: 7 x 5 x 5 x 5 = 875. */
function everyTriple(): OutcomeTriple[] {
  const out: OutcomeTriple[] = [];
  for (const execution of EXECUTION_STATES) {
    for (const assurance of ASSURANCE_STATES) {
      for (const promotion of PROMOTION_STATES) {
        for (const evidence of EVIDENCE_STATES) {
          out.push({ execution, assurance, promotion, evidence });
        }
      }
    }
  }
  return out;
}

describe("the four vocabularies", () => {
  it("are the rulings, member for member and in order", () => {
    // The ruling is the spec. If a member is added, renamed or reordered this
    // is where it is noticed, before any legality table silently widens.
    expect([...EXECUTION_STATES]).toEqual([
      "PENDING", "LEASED", "RUNNING", "ARTIFACT_PRODUCED", "BLOCKED", "FAILED", "LOST",
    ]);
    expect([...ASSURANCE_STATES]).toEqual([
      "NOT_EVALUATED", "SELF_CHECKED", "VERIFIED_PASS", "CONDITIONAL", "BLOCKED",
    ]);
    expect([...PROMOTION_STATES]).toEqual([
      "NOT_ELIGIBLE", "ELIGIBLE", "APPROVED", "APPLIED", "REVOKED",
    ]);
    expect([...EVIDENCE_STATES]).toEqual([
      "NOT_ATTEMPTED", "DECLARED", "VERIFIED", "MISMATCH", "UNAVAILABLE",
    ]);
    expect([...WORKER_TERMINAL_STATES]).toEqual([
      "COMPLETED", "UNVERIFIED", "BLOCKED", "FAILED", "LOST",
    ]);
    expect([...STATE_DIMENSIONS]).toEqual(["execution", "assurance", "promotion", "evidence"]);
  });

  it("embeds every verifier verdict as an assurance state, verbatim", () => {
    // A verdict becomes an assurance state without translation. If Acceptance
    // widens VerdictStatus this fails, and the legality table must be revisited.
    for (const status of VERDICT_STATUSES) expect(ASSURANCE_STATES).toContain(status);
  });

  it("has no member named COMPLETED, DONE or WAITING in any dimension", () => {
    // The whole ruling: no single global "completed". The only place the word
    // appears is the legacy collapse, which has to earn it.
    for (const vocabulary of [EXECUTION_STATES, ASSURANCE_STATES, PROMOTION_STATES, EVIDENCE_STATES]) {
      for (const banned of ["COMPLETED", "DONE", "WAITING"]) expect(vocabulary).not.toContain(banned);
    }
  });
});

describe("canTransition — every cell", () => {
  // These tables are written out here a second time, by hand, on purpose. A
  // test that reads the production table and checks it against itself passes
  // for any table. Each cell below is a decision; the test is the record of it.
  const EXPECTED_EXECUTION: Record<ExecutionState, readonly ExecutionState[]> = {
    PENDING: ["LEASED", "LOST"],
    LEASED: ["RUNNING", "PENDING", "FAILED", "LOST"],
    RUNNING: ["ARTIFACT_PRODUCED", "BLOCKED", "FAILED", "LOST"],
    ARTIFACT_PRODUCED: [],
    BLOCKED: [],
    FAILED: [],
    LOST: [],
  };
  const EXPECTED_ASSURANCE: Record<AssuranceState, readonly AssuranceState[]> = {
    NOT_EVALUATED: ["SELF_CHECKED", "VERIFIED_PASS", "CONDITIONAL", "BLOCKED"],
    SELF_CHECKED: ["VERIFIED_PASS", "CONDITIONAL", "BLOCKED"],
    VERIFIED_PASS: ["NOT_EVALUATED", "CONDITIONAL", "BLOCKED"],
    CONDITIONAL: ["NOT_EVALUATED", "VERIFIED_PASS", "BLOCKED"],
    BLOCKED: ["NOT_EVALUATED", "VERIFIED_PASS", "CONDITIONAL"],
  };
  const EXPECTED_PROMOTION: Record<PromotionState, readonly PromotionState[]> = {
    NOT_ELIGIBLE: ["ELIGIBLE"],
    ELIGIBLE: ["APPROVED", "NOT_ELIGIBLE"],
    APPROVED: ["APPLIED", "REVOKED"],
    APPLIED: ["REVOKED"],
    REVOKED: [],
  };
  const EXPECTED_EVIDENCE: Record<EvidenceState, readonly EvidenceState[]> = {
    NOT_ATTEMPTED: ["DECLARED", "UNAVAILABLE"],
    DECLARED: ["VERIFIED", "MISMATCH", "UNAVAILABLE"],
    VERIFIED: ["MISMATCH", "UNAVAILABLE"],
    MISMATCH: [],
    UNAVAILABLE: ["DECLARED"],
  };

  const cases: Array<[StateDimension, readonly string[], Record<string, readonly string[]>]> = [
    ["execution", EXECUTION_STATES, EXPECTED_EXECUTION],
    ["assurance", ASSURANCE_STATES, EXPECTED_ASSURANCE],
    ["promotion", PROMOTION_STATES, EXPECTED_PROMOTION],
    ["evidence", EVIDENCE_STATES, EXPECTED_EVIDENCE],
  ];

  it.each(cases)("%s: every from x to cell matches the recorded decision", (dimension, states, expected) => {
    let cells = 0;
    for (const from of states) {
      for (const to of states) {
        cells += 1;
        const legal = from !== to && (expected[from] ?? []).includes(to);
        expect(canTransition(dimension, from, to), `${dimension}: ${from} -> ${to}`).toBe(legal);
      }
      expect([...legalTransitionsFrom(dimension, from)].sort()).toEqual([...(expected[from] ?? [])].sort());
    }
    expect(cells).toBe(states.length * states.length);
  });

  it("never treats staying put as a transition", () => {
    for (const [dimension, states] of cases) {
      for (const state of states) expect(canTransition(dimension, state, state)).toBe(false);
    }
  });

  it("has at least one legal arc per dimension (the table is not empty)", () => {
    // Positive control. Returning false everywhere satisfies every "illegal"
    // assertion above; this makes sure the function can say yes at all.
    expect(canTransition("execution", "PENDING", "LEASED")).toBe(true);
    expect(canTransition("assurance", "NOT_EVALUATED", "VERIFIED_PASS")).toBe(true);
    expect(canTransition("promotion", "APPROVED", "APPLIED")).toBe(true);
    expect(canTransition("evidence", "DECLARED", "VERIFIED")).toBe(true);
  });

  it("never lets a verifier verdict be displaced by a self-check", () => {
    for (const verdict of VERDICT_STATUSES) {
      expect(canTransition("assurance", verdict, "SELF_CHECKED")).toBe(false);
    }
  });

  it("lets every verdict stale back to NOT_EVALUATED (FR-7.4)", () => {
    for (const verdict of VERDICT_STATUSES) {
      expect(canTransition("assurance", verdict, "NOT_EVALUATED")).toBe(true);
    }
  });

  it("INVARIANT: a verdict reaches SELF_CHECKED only via an explicit stale to NOT_EVALUATED", () => {
    // The two-step path is the ONLY path. Step one is taken by a staling
    // event (verdict.recorded, staled: true), never by the worker; there is no
    // revocation member on this axis, and the doc says so.
    for (const verdict of VERDICT_STATUSES) {
      expect(canTransition("assurance", verdict, "SELF_CHECKED"), `${verdict} -> SELF_CHECKED`).toBe(false);
      expect(canTransition("assurance", verdict, "NOT_EVALUATED"), `${verdict} -> NOT_EVALUATED`).toBe(true);
    }
    expect(canTransition("assurance", "NOT_EVALUATED", "SELF_CHECKED")).toBe(true);
    // No state other than NOT_EVALUATED leads to SELF_CHECKED.
    const sources = ASSURANCE_STATES.filter((from) => canTransition("assurance", from, "SELF_CHECKED"));
    expect(sources).toEqual(["NOT_EVALUATED"]);
    expect(ASSURANCE_STATES).not.toContain("REVOKED");
  });

  it("re-enters unavailable evidence only through DECLARED, never straight to VERIFIED", () => {
    expect(canTransition("evidence", "UNAVAILABLE", "VERIFIED")).toBe(false);
    expect(canTransition("evidence", "UNAVAILABLE", "MISMATCH")).toBe(false);
    expect(canTransition("evidence", "UNAVAILABLE", "DECLARED")).toBe(true);
    expect(canTransition("evidence", "DECLARED", "VERIFIED")).toBe(true);
    expect(legalTransitionsFrom("evidence", "UNAVAILABLE")).toEqual(["DECLARED"]);
    expect(EVIDENCE_STATES).not.toContain("REVOKED");
  });

  it("makes the four execution ends, REVOKED and MISMATCH terminal", () => {
    for (const from of ["ARTIFACT_PRODUCED", "BLOCKED", "FAILED", "LOST"]) {
      expect(legalTransitionsFrom("execution", from)).toEqual([]);
    }
    expect(legalTransitionsFrom("promotion", "REVOKED")).toEqual([]);
    expect(legalTransitionsFrom("evidence", "MISMATCH")).toEqual([]);
  });

  it("answers false, never throws, for an unknown dimension, state or hostile value", () => {
    const hostile: unknown[] = [
      "toString", "constructor", "__proto__", "valueOf", "hasOwnProperty",
      null, undefined, 7, [], Symbol("x"), {},
    ];
    for (const value of hostile) {
      expect(() => canTransition(value as never, "PENDING", "LEASED")).not.toThrow();
      expect(canTransition(value as never, "PENDING", "LEASED")).toBe(false);
      expect(() => canTransition("execution", value as never, "LEASED")).not.toThrow();
      expect(canTransition("execution", value as never, "LEASED")).toBe(false);
      expect(() => canTransition("execution", "PENDING", value as never)).not.toThrow();
      expect(canTransition("execution", "PENDING", value as never)).toBe(false);
      expect(legalTransitionsFrom(value as never, "PENDING")).toEqual([]);
      expect(legalTransitionsFrom("execution", value as never)).toEqual([]);
    }
    // A state from the wrong dimension is unknown to this one.
    expect(canTransition("execution", "NOT_EVALUATED", "VERIFIED_PASS")).toBe(false);
  });
});

describe("deriveLegacyTerminal", () => {
  const live: readonly ExecutionState[] = ["PENDING", "LEASED", "RUNNING"];
  const all = everyTriple();

  it("enumerates every triple exactly once", () => {
    expect(all.length).toBe(7 * 5 * 5 * 5);
    expect(new Set(all.map((t) => JSON.stringify(t))).size).toBe(all.length);
  });

  it("is total: never undefined, and null exactly while execution is live", () => {
    for (const triple of all) {
      const result = deriveLegacyTerminal(triple);
      expect(result, JSON.stringify(triple)).not.toBeUndefined();
      if (live.includes(triple.execution)) {
        expect(result, JSON.stringify(triple)).toBeNull();
      } else {
        expect(result !== null && WORKER_TERMINAL_STATES.includes(result), JSON.stringify(triple)).toBe(true);
      }
    }
  });

  it("PROPERTY: no triple maps to COMPLETED without VERIFIED_PASS", () => {
    // FR-6.4 for this vocabulary. Every one of the 875 points, not a sample.
    const completed = all.filter((t) => deriveLegacyTerminal(t) === "COMPLETED");
    expect(completed.length).toBeGreaterThan(0);
    for (const triple of completed) {
      expect(triple.assurance, JSON.stringify(triple)).toBe("VERIFIED_PASS");
      expect(triple.execution, JSON.stringify(triple)).toBe("ARTIFACT_PRODUCED");
    }
  });

  it("PROPERTY: no triple maps to COMPLETED without evidence VERIFIED", () => {
    // Evidence the server never verified must not yield the strongest word.
    // NOT_ATTEMPTED, DECLARED and UNAVAILABLE are all "nobody checked", which
    // is not a weaker form of checked.
    const completed = all.filter((t) => deriveLegacyTerminal(t) === "COMPLETED");
    expect(completed.length).toBeGreaterThan(0);
    for (const triple of completed) {
      expect(triple.evidence, JSON.stringify(triple)).toBe("VERIFIED");
    }
  });

  it("PROPERTY: COMPLETED is exactly the documented rule, on every triple", () => {
    // The rule, restated independently of the implementation.
    const rule = (t: OutcomeTriple): boolean =>
      t.execution === "ARTIFACT_PRODUCED"
      && t.assurance === "VERIFIED_PASS"
      && ["ELIGIBLE", "APPROVED", "APPLIED"].includes(t.promotion)
      && t.evidence === "VERIFIED";
    for (const triple of all) {
      expect(deriveLegacyTerminal(triple) === "COMPLETED", JSON.stringify(triple)).toBe(rule(triple));
    }
    // 1 x 1 x 3 x 1 points earn the word.
    expect(all.filter(rule).length).toBe(3);
  });

  it("maps BLOCKED, FAILED and LOST execution 1:1 regardless of the other dimensions", () => {
    for (const triple of all) {
      if (triple.execution === "BLOCKED") expect(deriveLegacyTerminal(triple)).toBe("BLOCKED");
      if (triple.execution === "FAILED") expect(deriveLegacyTerminal(triple)).toBe("FAILED");
      if (triple.execution === "LOST") expect(deriveLegacyTerminal(triple)).toBe("LOST");
    }
  });

  it("maps a produced artifact with NOT_EVALUATED or SELF_CHECKED assurance to UNVERIFIED", () => {
    for (const triple of all) {
      if (
        triple.execution === "ARTIFACT_PRODUCED"
        && (triple.assurance === "NOT_EVALUATED" || triple.assurance === "SELF_CHECKED")
      ) {
        expect(deriveLegacyTerminal(triple), JSON.stringify(triple)).toBe("UNVERIFIED");
      }
    }
  });

  it("maps a produced artifact with a BLOCKED verdict to BLOCKED, as terminalStateOfVerification does", () => {
    for (const triple of all) {
      if (triple.execution === "ARTIFACT_PRODUCED" && triple.assurance === "BLOCKED") {
        expect(deriveLegacyTerminal(triple), JSON.stringify(triple)).toBe("BLOCKED");
      }
    }
  });

  it("treats CONDITIONAL as not a pass, as terminalStateOfVerification does", () => {
    for (const triple of all) {
      if (triple.execution === "ARTIFACT_PRODUCED" && triple.assurance === "CONDITIONAL") {
        expect(deriveLegacyTerminal(triple), JSON.stringify(triple)).toBe("UNVERIFIED");
      }
    }
  });

  it("denies COMPLETED to a VERIFIED_PASS whose promotion was refused or revoked", () => {
    const base = { execution: "ARTIFACT_PRODUCED", assurance: "VERIFIED_PASS", evidence: "VERIFIED" } as const;
    expect(deriveLegacyTerminal({ ...base, promotion: "NOT_ELIGIBLE" })).toBe("UNVERIFIED");
    expect(deriveLegacyTerminal({ ...base, promotion: "REVOKED" })).toBe("UNVERIFIED");
    expect(deriveLegacyTerminal({ ...base, promotion: "ELIGIBLE" })).toBe("COMPLETED");
    expect(deriveLegacyTerminal({ ...base, promotion: "APPROVED" })).toBe("COMPLETED");
    expect(deriveLegacyTerminal({ ...base, promotion: "APPLIED" })).toBe("COMPLETED");
  });

  it("denies COMPLETED to a VERIFIED_PASS whose evidence the server did not itself verify", () => {
    const base = { execution: "ARTIFACT_PRODUCED", assurance: "VERIFIED_PASS", promotion: "APPLIED" } as const;
    for (const evidence of ["NOT_ATTEMPTED", "DECLARED", "MISMATCH", "UNAVAILABLE"] as const) {
      expect(deriveLegacyTerminal({ ...base, evidence }), evidence).toBe("UNVERIFIED");
    }
    expect(deriveLegacyTerminal({ ...base, evidence: "VERIFIED" })).toBe("COMPLETED");
  });

  it("reaches every legacy terminal state from some triple", () => {
    const reachable = new Set(all.map(deriveLegacyTerminal).filter((s) => s !== null));
    expect([...reachable].sort()).toEqual([...WORKER_TERMINAL_STATES].sort());
  });

  it("never throws and never invents a terminal state for hostile input", () => {
    const hostile: unknown[] = [
      null, undefined, 7, [], "ARTIFACT_PRODUCED",
      { execution: "toString" }, { execution: "constructor" }, { execution: "__proto__" },
      Object.create({ execution: "FAILED", assurance: "BLOCKED", promotion: "APPLIED", evidence: "VERIFIED" }),
      new Proxy({}, { get() { throw new Error("trap"); } }),
      { get execution(): never { throw new Error("g"); } },
    ];
    for (const value of hostile) {
      expect(() => deriveLegacyTerminal(value as never)).not.toThrow();
      expect(deriveLegacyTerminal(value as never)).toBeNull();
      expect(isOutcomeTriple(value)).toBe(false);
    }
    // A produced artifact whose other members are hostile is UNVERIFIED, never COMPLETED.
    expect(deriveLegacyTerminal({
      execution: "ARTIFACT_PRODUCED", assurance: "VERIFIED_PASS", promotion: "toString", evidence: "constructor",
    } as never)).toBe("UNVERIFIED");
  });

  it("isOutcomeTriple accepts every real triple and refuses any member from another dimension", () => {
    for (const triple of all) expect(isOutcomeTriple(triple)).toBe(true);
    expect(isOutcomeTriple({ execution: "VERIFIED_PASS", assurance: "VERIFIED_PASS", promotion: "APPLIED", evidence: "VERIFIED" })).toBe(false);
    expect(isOutcomeTriple({ execution: "RUNNING", assurance: "RUNNING", promotion: "APPLIED", evidence: "VERIFIED" })).toBe(false);
  });
});
