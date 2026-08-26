import { describe, expect, it } from "vitest";
import {
  CONTRACT_AMENDMENT_SCHEMA_META,
  EXHAUSTION_POLICIES,
  WORK_ORDER_SCHEMA_META,
  amendWorkOrder,
  attentionRemaining,
  classifyMateriality,
  mayInterrupt,
  mayRequireDecision,
  validateAttentionBudget,
  validateContractAmendment,
  validateDecisionPacket,
  validateWorkOrder,
  verificationIsStaleAfter,
  type WorkOrder,
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
  schemaVersion: 3 as const,
  contractVersion: 1,
  id: "wo-1",
  request: "Add rate limiting to the public API.",
  scope: "The /v1 HTTP handlers only; no infrastructure or DNS changes.",
  acceptanceCriteria: [
    { id: "c.limits", statement: "Requests over 100/min receive 429.", verifiedBy: "Integration test against a live handler." },
  ],
  grantedAuthority: ["edit files under src/api", "run the test suite"],
  attentionBudget: budget(),
  requestedBy: { kind: "user", userId: "u-1" },
  owner: { kind: "user", userId: "owner-1" } as const,
  riskClassification: {
    level: "low" as const,
    consequentialClasses: [],
    rationale: "Changes are confined to local request handling and are fully testable.",
  },
  verifier: { kind: "none", verifierId: null, independence: "none" } as const,
  rollbackConditions: [],
  escalationRules: [
    { when: "verifier_unavailable", to: { kind: "user", userId: "owner-1" }, within: 900 },
    { when: "policy_undetermined", to: { kind: "user", userId: "owner-1" }, within: 300 },
  ] as const,
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
  it("accepts a low-risk mission with no verifier and no rollback", () => {
    const result = validateWorkOrder(validOrder());
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it("refuses contract v2 without supersedes", () => {
    const result = validateWorkOrder({ ...validOrder(), contractVersion: 2 });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toContain("supersedes_required");
  });

  it("refuses a supersedes contractVersion that is not the immediate predecessor", () => {
    const result = validateWorkOrder({
      ...validOrder(),
      contractVersion: 2,
      supersedes: { contractVersion: 2, amendmentId: "amendment-1" },
    });
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toContain("supersedes_version_mismatch");
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

describe("a mission contract carries durable accountability and recovery", () => {
  const issueCodes = (input: unknown) => {
    const result = validateWorkOrder(input);
    return result.ok ? [] : result.issues.map((problem) => problem.code);
  };

  it("rejects worker and verifier owners with owner_must_be_human", () => {
    for (const owner of [
      { kind: "worker", workerId: "worker-1" },
      { kind: "verifier", verifierId: "verifier-1", independent: true },
    ]) {
      expect(issueCodes({ ...validOrder(), owner })).toContain("owner_must_be_human");
    }
  });

  it("rejects non-low risk that names no consequential class", () => {
    expect(issueCodes({
      ...validOrder(),
      riskClassification: {
        level: "medium",
        consequentialClasses: [],
        rationale: "The work may affect production behavior.",
      },
    })).toContain("risk_without_classes");
  });

  it("rejects consequential work with no verifier", () => {
    expect(issueCodes({
      ...validOrder(),
      riskClassification: {
        level: "high",
        consequentialClasses: ["deployment"],
        rationale: "The mission deploys to production.",
      },
      rollbackConditions: [
        { trigger: "Deployment health check fails.", action: "revert_to_checkpoint", checkpointRequired: true },
      ],
    })).toContain("consequential_work_needs_verifier");
  });

  it("rejects same-worker review presented as independent", () => {
    expect(issueCodes({
      ...validOrder(),
      verifier: { kind: "independent", verifierId: "verifier-1", independence: "same-worker" },
    })).toContain("self_review_is_not_independent");
  });

  it("rejects a consequential order without rollback", () => {
    expect(issueCodes({
      ...validOrder(),
      riskClassification: {
        level: "medium",
        consequentialClasses: ["external_communication"],
        rationale: "The mission sends a message outside the organization.",
      },
      verifier: { kind: "human", verifierId: "user-reviewer", independence: "human" },
      rollbackConditions: [],
    })).toContain("consequential_work_needs_rollback");
  });

  it("rejects escalation rules that leave an undecidable case uncovered", () => {
    expect(issueCodes({
      ...validOrder(),
      escalationRules: [
        { when: "verifier_unavailable", to: { kind: "user", userId: "owner-1" }, within: 900 },
      ],
    })).toContain("escalation_gap");
  });
});

describe("work-contract amendments are append-only", () => {
  const attribution = () => ({
    amendmentId: "amendment-1",
    changedBy: "user-2",
    changedAt: "2026-08-23T13:00:00.000Z",
    reason: "The limit must cover burst traffic discovered during planning.",
  });

  it("replaces a changed criterion id and stales current verification", () => {
    const previous = validOrder() as WorkOrder;
    const replacement = {
      id: "c.limits.v2",
      statement: "Requests over 120/min receive 429.",
      verifiedBy: "Integration test against a live handler.",
    };
    const { next, amendment } = amendWorkOrder(
      previous,
      { acceptanceCriteria: [replacement] },
      attribution(),
    );

    expect(next.id).toBe(previous.id);
    expect(next.contractVersion).toBe(2);
    expect(next.supersedes).toEqual({ contractVersion: 1, amendmentId: "amendment-1" });
    expect(next.acceptanceCriteria.map((criterion) => criterion.id)).toEqual(["c.limits.v2"]);
    expect(amendment.changes).toEqual([
      { path: "acceptanceCriteria", kind: "removed" },
      { path: "acceptanceCriteria", kind: "added" },
    ]);
    expect(verificationIsStaleAfter(amendment)).toBe(true);
    expect(amendment.materiality).toBe("material");
  });

  it("classifies a request-only amendment as editorial without staling verification", () => {
    const { amendment } = amendWorkOrder(
      validOrder() as WorkOrder,
      { request: "Add rate limiting and document the result for the public API." },
      attribution(),
    );

    expect(amendment.changes).toEqual([{ path: "request", kind: "modified" }]);
    expect(amendment.materiality).toBe("editorial");
    expect(verificationIsStaleAfter(amendment)).toBe(false);
  });

  it("makes a verifier amendment material and stales current verification", () => {
    const { amendment } = amendWorkOrder(
      validOrder() as WorkOrder,
      { verifier: { kind: "deterministic", verifierId: "test-suite", independence: "same-worker" } },
      attribution(),
    );

    expect(amendment.changes).toEqual([{ path: "verifier", kind: "modified" }]);
    expect(amendment.materiality).toBe("material");
    expect(verificationIsStaleAfter(amendment)).toBe(true);
  });

  it("keeps an escalation-rules amendment editorial without staling verification", () => {
    const previous = validOrder() as WorkOrder;
    const { amendment } = amendWorkOrder(
      previous,
      {
        escalationRules: previous.escalationRules.map((rule) =>
          rule.when === "policy_undetermined" ? { ...rule, within: 120 } : rule,
        ),
      },
      attribution(),
    );

    expect(amendment.changes).toEqual([{ path: "escalationRules", kind: "modified" }]);
    expect(amendment.materiality).toBe("editorial");
    expect(verificationIsStaleAfter(amendment)).toBe(false);
  });

  it("rejects rewriting a criterion under its existing id", () => {
    const oldCriterion = validOrder().acceptanceCriteria[0];
    expect(() => amendWorkOrder(
      validOrder() as WorkOrder,
      {
        acceptanceCriteria: [{
          ...oldCriterion,
          statement: "Requests over 120/min receive 429.",
        }],
      },
      attribution(),
    )).toThrow(/criterion_rewritten_in_place/);
  });

  it("never mutates the previous work order", () => {
    const previous = validOrder() as WorkOrder;
    const snapshot = structuredClone(previous);

    amendWorkOrder(
      previous,
      { request: "Add rate limiting to every public /v1 handler." },
      attribution(),
    );

    expect(previous).toEqual(snapshot);
  });

  it("validates amendment attribution, consecutive versions, paths, and derived materiality", () => {
    const { amendment } = amendWorkOrder(
      validOrder() as WorkOrder,
      { scope: "All /v1 HTTP handlers; no infrastructure or DNS changes." },
      attribution(),
    );
    expect(validateContractAmendment(amendment).ok).toBe(true);
    expect(validateContractAmendment({ ...amendment, changedAt: "tomorrow" }).ok).toBe(false);
    expect(validateContractAmendment({ ...amendment, toVersion: 9 }).ok).toBe(false);
    expect(validateContractAmendment({ ...amendment, materiality: "editorial" }).ok).toBe(false);
    expect(validateContractAmendment({
      ...amendment,
      changes: [{ path: "requestedBy", kind: "modified" }],
    }).ok).toBe(false);
  });

  it("exports the materiality rule and complete schema metadata", () => {
    expect(classifyMateriality([{ path: "grantedAuthority", kind: "modified" }])).toBe("material");
    expect(classifyMateriality([{ path: "attentionBudget", kind: "modified" }])).toBe("editorial");
    expect(WORK_ORDER_SCHEMA_META).toMatchObject({ version: 3, compatibility: "frozen" });
    expect(CONTRACT_AMENDMENT_SCHEMA_META).toMatchObject({ version: 1, compatibility: "frozen" });
  });
});

describe("materiality boundary (review fixes)", () => {
  const twoCriteria = () => ({
    ...validOrder(),
    acceptanceCriteria: [
      ...validOrder().acceptanceCriteria,
      { id: "c.docs", statement: "The limit is documented.", verifiedBy: "Docs review." },
    ],
  });
  const meta = { amendmentId: "amend-reorder", changedBy: "george", changedAt: "2026-08-26T00:00:00.000Z", reason: "tidy" };

  it("a reorder-only patch is not an amendment at all", () => {
    const previous = twoCriteria();
    expect(() =>
      amendWorkOrder(previous, { acceptanceCriteria: [...previous.acceptanceCriteria].reverse() }, meta),
    ).toThrow(/no_contract_changes/);
  });

  it("reordering identical criteria alongside an editorial change stays editorial", () => {
    const previous = twoCriteria();
    const { amendment } = amendWorkOrder(
      previous,
      { acceptanceCriteria: [...previous.acceptanceCriteria].reverse(), request: "Add rate limiting to the public API (v2 wording)." },
      meta,
    );
    expect(amendment.changes.map((c) => c.path)).toEqual(["request"]);
    expect(amendment.materiality).toBe("editorial");
    expect(verificationIsStaleAfter(amendment)).toBe(false);
  });

  it("fails closed: a path outside EDITORIAL_PATHS is material", () => {
    expect(classifyMateriality([{ path: "scope", kind: "modified" }])).toBe("material");
    expect(classifyMateriality([{ path: "not-a-known-path" as never, kind: "modified" }])).toBe("material");
    expect(classifyMateriality([{ path: "request", kind: "modified" }])).toBe("editorial");
  });
});

describe("mission contract fields (review fixes)", () => {
  const codes = (order: unknown) => {
    const r = validateWorkOrder(order);
    return r.ok ? [] : r.issues.map((i) => i.code);
  };

  it("closes the verifier independence matrix", () => {
    const base = validOrder();
    expect(codes({ ...base, verifier: { ...base.verifier, kind: "none", independence: "separate-system" } })).toContain("verifier_independence_incoherent");
    expect(codes({ ...base, verifier: { ...base.verifier, kind: "human", independence: "separate-system" } })).toContain("verifier_independence_incoherent");
    expect(codes({ ...base, verifier: { ...base.verifier, kind: "deterministic", independence: "human" } })).toContain("verifier_independence_incoherent");
    expect(codes({ ...base, verifier: { ...base.verifier, kind: "deterministic", independence: "same-worker" } })).not.toContain("verifier_independence_incoherent");
  });

  it("drives the escalation window and target guards", () => {
    const base = validOrder();
    const [first, ...rest] = base.escalationRules;
    expect(codes({ ...base, escalationRules: [{ ...first, within: 0 }, ...rest] })).toContain("invalid_escalation_window");
    expect(codes({ ...base, escalationRules: [{ ...first, within: -0 }, ...rest] })).toContain("invalid_escalation_window");
    expect(codes({ ...base, escalationRules: [{ ...first, within: 1e21 }, ...rest] })).toContain("invalid_escalation_window");
    expect(codes({ ...base, escalationRules: [{ ...first, to: { kind: "worker", workerId: "w-1" } }, ...rest] })).toContain("escalation_target_must_be_human");
  });
});
