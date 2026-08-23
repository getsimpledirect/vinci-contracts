import { describe, expect, it } from "vitest";
import {
  EXHAUSTION_POLICIES,
  attentionRemaining,
  mayInterrupt,
  mayRequireDecision,
  validateAttentionBudget,
  validateDecisionPacket,
  validateWorkOrder,
} from "./index.ts";

const budget = () => ({ interruptions: 3, decisions: 2, onExhaustion: "block" as const });
const spend = (i: number, d: number) => ({ workOrderId: "wo-1", interruptionsUsed: i, decisionsUsed: d });

const validPacket = () => ({
  schemaVersion: 1 as const,
  id: "dp-1",
  workOrderId: "wo-1",
  question: "Should the worker be allowed to delete the staging bucket?",
  defaultIfUnanswered: "No action is taken and the run blocks.",
  options: [
    { id: "allow", label: "Allow", consequence: "The staging bucket and its 400 objects are deleted.", irreversible: true },
    { id: "deny", label: "Deny", consequence: "The run stops and reports a blocked verdict.", irreversible: false },
  ],
  evidenceIds: ["evidence.plan.1"],
  raisedAt: "2026-08-23T12:00:00.000Z",
  expiresAt: "2026-08-23T13:00:00.000Z",
});

const validOrder = () => ({
  schemaVersion: 1 as const,
  id: "wo-1",
  request: "Add rate limiting to the public API.",
  scope: "The /v1 HTTP handlers only; no infrastructure or DNS changes.",
  acceptanceCriteria: [
    { id: "c.limits", statement: "Requests over 100/min receive 429.", verifiedBy: "Integration test against a live handler." },
  ],
  grantedAuthority: ["edit files under src/api", "run the test suite"],
  attentionBudget: budget(),
  requestedBy: { kind: "user", userId: "u-1" },
  issuedAt: "2026-08-23T12:00:00.000Z",
  expiresAt: "2026-08-24T12:00:00.000Z",
});

describe("attention is a budget that cannot be spent past zero", () => {
  it("accepts a well-formed budget and counts what is left", () => {
    expect(validateAttentionBudget(budget()).ok).toBe(true);
    expect(attentionRemaining(budget(), spend(1, 0))).toEqual({
      interruptions: 2, decisions: 2, exhausted: false,
    });
  });

  it("clamps an overspend at zero rather than going negative", () => {
    // A negative remaining would let a later grant silently cancel an
    // overspend, so the overspend would never be visible to anyone.
    expect(attentionRemaining(budget(), spend(99, 99))).toEqual({
      interruptions: 0, decisions: 0, exhausted: true,
    });
  });

  it("refuses to interrupt or ask once the relevant line is spent", () => {
    expect(mayInterrupt(budget(), spend(3, 0))).toBe(false);
    expect(mayRequireDecision(budget(), spend(0, 2))).toBe(false);
    // Positive control: with budget left, both are permitted.
    expect(mayInterrupt(budget(), spend(2, 0))).toBe(true);
    expect(mayRequireDecision(budget(), spend(0, 1))).toBe(true);
  });

  it("refuses hostile budgets and spends instead of throwing", () => {
    // Labelled, NOT JSON.stringify'd. The first version of this test used
    // JSON.stringify(hostile) as the assertion message, and stringify performs
    // a `toJSON` lookup — which the get-trap proxy throws from. The test failed
    // and the code under test was innocent: my own diagnostic was the thing
    // that could not survive hostile input.
    const hostile: Array<[string, unknown]> = [
      ["null", null],
      ["undefined", undefined],
      ["a numeric string", "3"],
      ["a number", 7],
      ["an array", []],
      ["a negative count", { interruptions: -1, decisions: 1, onExhaustion: "block" }],
      ["a fractional count", { interruptions: 1.5, decisions: 1, onExhaustion: "block" }],
      ["onExhaustion: proceed", { interruptions: 1, decisions: 1, onExhaustion: "proceed" }],
      ["a throwing-get proxy", new Proxy({}, { get() { throw new Error("trap"); } })],
      ["an inherited budget", Object.create({ interruptions: 9, decisions: 9, onExhaustion: "block" })],
      ["counts via accessors", { get interruptions() { return 9; }, decisions: 9, onExhaustion: "block" }],
    ];
    for (const [label, value] of hostile) {
      expect(() => mayInterrupt(value as never, spend(0, 0)), label).not.toThrow();
      expect(mayInterrupt(value as never, spend(0, 0)), label).toBe(false);
      expect(mayRequireDecision(value as never, spend(0, 0)), label).toBe(false);
    }
  });

  it("offers no way to configure proceeding without a human", () => {
    // The design claim, pinned. If "proceed" is ever added, this fails and
    // whoever added it has to argue with this test rather than around it.
    expect([...EXHAUSTION_POLICIES]).toEqual(["block", "escalate"]);
    expect(validateAttentionBudget({ ...budget(), onExhaustion: "proceed" }).ok).toBe(false);
    expect(validateAttentionBudget({ ...budget(), onExhaustion: "continue" }).ok).toBe(false);
    expect(validateAttentionBudget({ ...budget(), onExhaustion: "auto" }).ok).toBe(false);
  });
});

describe("a decision packet must be answerable without going elsewhere", () => {
  it("accepts a complete packet", () => {
    const result = validateDecisionPacket(validPacket());
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it("refuses a single-option 'decision'", () => {
    const packet = { ...validPacket(), options: [validPacket().options[0]] };
    const result = validateDecisionPacket(packet);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toContain("not_a_decision");
  });

  it("refuses an option that says what it is called but not what it does", () => {
    const packet = validPacket();
    const result = validateDecisionPacket({
      ...packet,
      options: [{ ...packet.options[0], consequence: "  " }, packet.options[1]],
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a packet with no stated default", () => {
    // Silence is an answer whether or not anyone chose it.
    expect(validateDecisionPacket({ ...validPacket(), defaultIfUnanswered: "" }).ok).toBe(false);
  });

  it("refuses a packet citing no evidence, and one that expires when raised", () => {
    expect(validateDecisionPacket({ ...validPacket(), evidenceIds: [] }).ok).toBe(false);
    expect(
      validateDecisionPacket({ ...validPacket(), expiresAt: validPacket().raisedAt }).ok,
    ).toBe(false);
  });

  it("refuses duplicate option ids", () => {
    const packet = validPacket();
    expect(
      validateDecisionPacket({
        ...packet,
        options: [packet.options[0], { ...packet.options[1], id: "allow" }],
      }).ok,
    ).toBe(false);
  });
});

describe("a work order fixes what done means before work starts", () => {
  it("accepts a complete order", () => {
    const result = validateWorkOrder(validOrder());
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it("refuses an order with no acceptance criteria", () => {
    const result = validateWorkOrder({ ...validOrder(), acceptanceCriteria: [] });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toContain("criteria_required");
  });

  it("refuses a criterion nobody can check", () => {
    const order = validOrder();
    expect(
      validateWorkOrder({
        ...order,
        acceptanceCriteria: [{ ...order.acceptanceCriteria[0], verifiedBy: "   " }],
      }).ok,
    ).toBe(false);
  });

  it("refuses an unscoped order", () => {
    expect(validateWorkOrder({ ...validOrder(), scope: "" }).ok).toBe(false);
  });

  it("refuses an order whose attention budget is malformed", () => {
    // The budget is validated through the same function that validates it
    // standalone, so the two cannot drift into disagreeing.
    const result = validateWorkOrder({
      ...validOrder(),
      attentionBudget: { interruptions: 1, decisions: 1, onExhaustion: "proceed" },
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((i) => i.path)).toContain("/attentionBudget/onExhaustion");
  });

  it("refuses a requester that is not a consistent actor", () => {
    for (const requestedBy of [
      { kind: "worker" },                                   // no identity
      { kind: "verifier", independent: true },              // anonymous, self-declared
      Object.create({ kind: "user", userId: "u-1" }),       // all fields inherited
      { kind: "user", userId: "u-1", workerId: "w" },       // foreign field
    ]) {
      expect(validateWorkOrder({ ...validOrder(), requestedBy }).ok, JSON.stringify(requestedBy)).toBe(false);
    }
  });

  it("refuses an unbounded or already-expired grant", () => {
    expect(validateWorkOrder({ ...validOrder(), expiresAt: validOrder().issuedAt }).ok).toBe(false);
    expect(validateWorkOrder({ ...validOrder(), expiresAt: "not a date" }).ok).toBe(false);
  });

  it("refuses hostile input instead of throwing", () => {
    for (const hostile of [null, undefined, 7, "order", [], new Array(1)]) {
      expect(() => validateWorkOrder(hostile)).not.toThrow();
      expect(validateWorkOrder(hostile).ok).toBe(false);
    }
  });
});
