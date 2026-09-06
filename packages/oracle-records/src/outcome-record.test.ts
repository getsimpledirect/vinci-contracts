import { describe, expect, it } from "vitest";
import {
  OUTCOME_CLASSES,
  outcomeCreditAnchor,
  outcomeRecordDigest,
  resolveOutcomeCredits,
  validateOutcomeRecord,
  type OutcomeRecord,
} from "./index.ts";
import { reversed, validOutcomeRecord } from "./fixtures.test-helpers.ts";

/**
 * §5.8, OUT-01 to OUT-04.
 *
 * OUT-01 is four distinctions and each is tested from BOTH sides: the
 * combination is representable, and the collapse is refused. A test that only
 * showed the refusals would be satisfied by a schema that refuses everything,
 * which is the other way this record can fail.
 */

/**
 * The work orders the HOST authorized. The anchor the credit rule is keyed on,
 * supplied as a second argument exactly as `resolveCitations` takes `delivered`.
 */
const AUTHORIZED = [
  { workRef: "wo-installed-reader-probe", runRef: "run-oracle-1", workspaceRef: "ws-institutional-1" },
  { workRef: "wo-a-different-piece-of-work", runRef: "run-oracle-1", workspaceRef: "ws-institutional-1" },
];

function issuesOf(result: ReturnType<typeof validateOutcomeRecord>) {
  return result.ok ? [] : result.issues.map((i) => ({ path: i.path, code: i.code }));
}

const notAttempted = (): OutcomeRecord => ({
  ...validOutcomeRecord(),
  outcomeId: "oracle-outcome-2",
  authorizedWorkRef: null,
  executionEvidenceRefs: [],
  outcomeClass: "NOT_ATTEMPTED",
  justification: "The release window closed before the probe was scheduled.",
  observedWindow: null,
  costMicrousd: 0,
  uncertaintyResolved: null,
  hypothesisResult: "NOT_APPLICABLE",
  evidence: { linkedFollowThrough: null, temporalAssociation: null, measuredCounterfactual: null },
  creditKind: "NO_CREDIT",
  duplicateOfOutcomeRef: null,
});

const observationUnavailable = (): OutcomeRecord => ({
  ...notAttempted(),
  outcomeId: "oracle-outcome-3",
  authorizedWorkRef: "wo-installed-reader-probe",
  executionEvidenceRefs: ["evidence-probe-run-78"],
  outcomeClass: "OBSERVATION_UNAVAILABLE",
  justification: "The probe ran, but the telemetry it would have been judged by was never collected.",
});

describe("OUT-01: not attempted is not failed, and unavailable is not zero benefit", () => {
  it("an experiment that DISPROVED its hypothesis is still representable as HELPFUL_OBSERVED", () => {
    // The combination a careless schema cannot express. It settled the question
    // the report was written to settle, which is what the experiment was for —
    // and a record type that refused this would teach the system that only
    // confirmations count.
    const record = validOutcomeRecord();
    expect(record.outcomeClass).toBe("HELPFUL_OBSERVED");
    expect(record.hypothesisResult).toBe("DISPROVED_BY_RESULT");
    expect(issuesOf(validateOutcomeRecord(record))).toEqual([]);
  });

  it("every outcome class can be written as a valid record", () => {
    const built: Record<string, OutcomeRecord> = {
      HELPFUL_OBSERVED: validOutcomeRecord(),
      NOT_HELPFUL_OBSERVED: {
        ...validOutcomeRecord(),
        outcomeId: "oracle-outcome-4",
        outcomeClass: "NOT_HELPFUL_OBSERVED",
        justification: "The probe ran and told the decision nothing it did not already have.",
        uncertaintyResolved: false,
      },
      INCONCLUSIVE: {
        ...validOutcomeRecord(),
        outcomeId: "oracle-outcome-5",
        outcomeClass: "INCONCLUSIVE",
        justification: "The probe produced a result the rubric does not classify either way.",
        uncertaintyResolved: null,
      },
      NOT_ATTEMPTED: notAttempted(),
      OBSERVATION_UNAVAILABLE: observationUnavailable(),
    };
    expect(Object.keys(built).sort()).toEqual([...OUTCOME_CLASSES].sort());
    for (const [name, record] of Object.entries(built)) {
      expect(issuesOf(validateOutcomeRecord(record)), name).toEqual([]);
    }
  });

  it("NOT_ATTEMPTED carrying execution evidence is refused: work that ran is an observed class", () => {
    const result = validateOutcomeRecord({
      ...notAttempted(),
      executionEvidenceRefs: ["evidence-probe-run-77"],
    });
    expect(issuesOf(result)).toEqual([
      { path: "/executionEvidenceRefs", code: "not_attempted_with_execution_evidence" },
    ]);
  });

  it("OBSERVATION_UNAVAILABLE answering the uncertainty is refused: unknown is null, not false", () => {
    const result = validateOutcomeRecord({
      ...observationUnavailable(),
      uncertaintyResolved: false,
    });
    expect(issuesOf(result)).toEqual([
      { path: "/uncertaintyResolved", code: "unavailable_observation_answers_uncertainty" },
    ]);
  });

  it("an observed class with no execution evidence is refused: an observation needs something observed", () => {
    const result = validateOutcomeRecord({ ...validOutcomeRecord(), executionEvidenceRefs: [] });
    expect(issuesOf(result)).toEqual([
      { path: "/executionEvidenceRefs", code: "observed_outcome_without_evidence" },
    ]);
  });
});

describe("OUT-02: the author cannot self-certify accepted usefulness", () => {
  it("a HELPFUL_OBSERVED record assessed by its own author is refused at /assessingIdentity", () => {
    const base = validOutcomeRecord();
    const result = validateOutcomeRecord({ ...base, assessingIdentity: base.authoringIdentity });
    expect(issuesOf(result)).toEqual([
      { path: "/assessingIdentity", code: "self_certified_usefulness" },
    ]);
  });

  it("POSITIVE CONTROL: a genuinely independent assessor IS accepted on the same record", () => {
    expect(issuesOf(validateOutcomeRecord(validOutcomeRecord()))).toEqual([]);
  });

  it("SCOPING CONTROL: the same identical pair is accepted on NOT_HELPFUL_OBSERVED", () => {
    // This is what makes the refusal a rule about SELF-CERTIFICATION rather
    // than about identity equality. A team reporting that its own work did not
    // help is not the failure OUT-02 exists for, and a rule that refused it
    // would be reaching a different mechanism from the one it claims.
    const base = validOutcomeRecord();
    const result = validateOutcomeRecord({
      ...base,
      outcomeClass: "NOT_HELPFUL_OBSERVED",
      justification: "The team's own review found the probe told the decision nothing new.",
      uncertaintyResolved: false,
      assessingIdentity: base.authoringIdentity,
    });
    expect(issuesOf(result)).toEqual([]);
  });
});

describe("OUT-03: temporal consistency is not causation", () => {
  it("a causal claim resting only on timing is refused at the counterfactual", () => {
    const result = validateOutcomeRecord({
      ...validOutcomeRecord(),
      causationClaimed: true,
      evidence: {
        linkedFollowThrough: null,
        temporalAssociation: {
          observedAt: "2026-09-07T10:00:00.000Z",
          detail: "The regression stopped appearing the week after the recommendation.",
        },
        measuredCounterfactual: null,
      },
    });
    expect(issuesOf(result)).toEqual([
      { path: "/evidence/measuredCounterfactual", code: "causation_without_counterfactual" },
    ]);
  });

  it("POSITIVE CONTROL: the same causal claim with a measured comparison is accepted", () => {
    const result = validateOutcomeRecord({
      ...validOutcomeRecord(),
      causationClaimed: true,
      evidence: {
        linkedFollowThrough: null,
        temporalAssociation: {
          observedAt: "2026-09-07T10:00:00.000Z",
          detail: "The regression stopped appearing the week after the recommendation.",
        },
        measuredCounterfactual: {
          comparisonRef: "experiment-holdout-12",
          detail: "A held-out arm without the change kept regressing over the same window.",
        },
      },
    });
    expect(issuesOf(result)).toEqual([]);
  });

  it("and the three strengths stay three fields, so all of them can be present at once", () => {
    // Non-collapsibility, checked from the data: an enum would have forced this
    // record to pick one and lose the other two.
    const record = validOutcomeRecord();
    expect(Object.keys(record.evidence).sort()).toEqual([
      "linkedFollowThrough",
      "measuredCounterfactual",
      "temporalAssociation",
    ]);
  });
});

describe("OUT-04: reuse credit, but never a second accepted-work credit", () => {
  const reuse = (): OutcomeRecord => ({
    ...validOutcomeRecord(),
    outcomeId: "oracle-outcome-6",
    creditKind: "REUSE",
    duplicateOfOutcomeRef: "oracle-outcome-1",
    justification: "The same recommendation was reissued for a second repository and reused the result.",
  });

  it("POSITIVE CONTROL: one accepted-work credit alongside a reuse of it is CREDITED", () => {
    const result = resolveOutcomeCredits([validOutcomeRecord(), reuse()], AUTHORIZED);
    expect(result).toEqual({
      outcome: "CREDITED",
      acceptedWork: ["oracle-outcome-1"],
      reuse: ["oracle-outcome-6"],
      unresolvedReuse: [],
    });
  });

  it("two accepted-work credits for the same underlying outcome are DOUBLE_CREDITED", () => {
    const second: OutcomeRecord = { ...validOutcomeRecord(), outcomeId: "oracle-outcome-7" };
    const result = resolveOutcomeCredits([validOutcomeRecord(), second], AUTHORIZED);
    expect(result.outcome).toBe("DOUBLE_CREDITED");
    if (result.outcome !== "DOUBLE_CREDITED") return;
    expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
      { path: "/outcomes/1/authorizedWorkRef", code: "duplicate_accepted_work_credit" },
    ]);
    // Naming which one, because "some duplicate exists" is not actionable.
    expect(result.issues[0]?.message).toContain("oracle-outcome-1");
  });

  it("THE REVIEWER'S REPRO: two records that differ ONLY in what they call themselves", () => {
    // The defect the first version shipped. `creditKey` was a free string on
    // the record, so two outcomes with identical proposalRef, proposalDigest,
    // authorizedWorkRef and outcomeClass — provably one underlying outcome —
    // took two accepted-work credits by writing different keys. The rule
    // established that identical strings collide, which is a property of
    // strings and not of outcomes.
    //
    // The anchor is now the work order the HOST authorized, so there is nothing
    // left for the two records to disagree about.
    const alpha: OutcomeRecord = { ...validOutcomeRecord(), outcomeId: "oracle-outcome-alpha" };
    const beta: OutcomeRecord = { ...validOutcomeRecord(), outcomeId: "oracle-outcome-beta" };
    expect(alpha.proposalDigest).toBe(beta.proposalDigest);
    expect(alpha.authorizedWorkRef).toBe(beta.authorizedWorkRef);
    expect(outcomeCreditAnchor(alpha)).toBe(outcomeCreditAnchor(beta));
    const result = resolveOutcomeCredits([alpha, beta], AUTHORIZED);
    expect(result.outcome).toBe("DOUBLE_CREDITED");
  });

  it("the anchor is the AUTHORIZED SET, and varying the field the record writes proves it", () => {
    // The test this replaces varied outcomeId, justification, rubricRef,
    // issuedAt and hypothesisResult — and never varied `authorizedWorkRef`,
    // the field it claimed nothing could move. It proved a projection is
    // stable under changes to fields that are not the projection. The review
    // was right, and the name asserting the property is what got it accepted.
    //
    // So: vary the field itself. The projection MOVES, which is the honest
    // fact about it...
    const base = validOutcomeRecord();
    const renamed: OutcomeRecord = { ...base, authorizedWorkRef: "wo-a-different-piece-of-work" };
    expect(outcomeCreditAnchor(renamed)).not.toBe(outcomeCreditAnchor(base));

    // ...and the RULE does not, because the resolver looks the ref up in the
    // host-authorized set rather than trusting it. A ref nothing authorized
    // takes no credit at all.
    const invented: OutcomeRecord = { ...base, authorizedWorkRef: "wo-i-made-this-up" };
    expect(resolveOutcomeCredits([invented], AUTHORIZED).outcome).toBe("UNAUTHORIZED_WORK");

    // POSITIVE REACHABILITY CONTROL on the same input: the unchanged record,
    // whose ref IS in the set, is credited.
    const credited = resolveOutcomeCredits([base], AUTHORIZED);
    expect(credited.outcome).toBe("CREDITED");
    if (credited.outcome !== "CREDITED") return;
    expect(credited.acceptedWork).toEqual(["oracle-outcome-1"]);
  });

  it("an ACCEPTED_WORK credit with no authorized work is refused: there is nothing to credit", () => {
    const result = validateOutcomeRecord({
      ...notAttempted(),
      creditKind: "ACCEPTED_WORK",
      duplicateOfOutcomeRef: null,
    });
    expect(issuesOf(result)).toEqual([
      { path: "/authorizedWorkRef", code: "accepted_credit_without_authorized_work" },
    ]);
  });

  it("two accepted-work credits for genuinely different work are both credited", () => {
    // The discriminating control for the rule above: it is about the underlying
    // outcome, not about two records sharing a shape. Different authorized work
    // AND different execution evidence — a second work order that reused the
    // first one's evidence would be the same execution wearing a second name,
    // which the rule below covers.
    const other: OutcomeRecord = {
      ...validOutcomeRecord(),
      outcomeId: "oracle-outcome-8",
      authorizedWorkRef: "wo-a-different-piece-of-work",
      executionEvidenceRefs: ["evidence-probe-run-91"],
    };
    const result = resolveOutcomeCredits([validOutcomeRecord(), other], AUTHORIZED);
    expect(result.outcome).toBe("CREDITED");
    if (result.outcome !== "CREDITED") return;
    expect(result.acceptedWork).toEqual(["oracle-outcome-1", "oracle-outcome-8"]);
  });

  it("THE SECOND REVIEW'S REPRO: an invented work ref takes no credit", () => {
    // The anchor used to be `authorizedWorkRef` read off the record, so two
    // outcomes recording the SAME execution took two accepted-work credits by
    // writing different work refs. The resolver now looks each one up in the
    // host-authorized set it is handed.
    const base = validOutcomeRecord();
    const a: OutcomeRecord = { ...base, outcomeId: "oracle-outcome-a", authorizedWorkRef: "wo-alpha" };
    const b: OutcomeRecord = { ...base, outcomeId: "oracle-outcome-b", authorizedWorkRef: "wo-beta" };
    // Both name the SAME execution evidence, which is what makes them one
    // underlying outcome however they describe the work.
    expect(a.executionEvidenceRefs).toEqual(b.executionEvidenceRefs);
    const result = resolveOutcomeCredits([a, b], AUTHORIZED);
    expect(result.outcome).toBe("UNAUTHORIZED_WORK");
    if (result.outcome !== "UNAUTHORIZED_WORK") return;
    expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
      { path: "/outcomes/0/authorizedWorkRef", code: "work_never_authorized" },
      { path: "/outcomes/1/authorizedWorkRef", code: "work_never_authorized" },
    ]);
  });

  it("and even when BOTH work refs are host-authorized, one execution is one credit", () => {
    // The case the work-ref lookup alone does not close: a host that authorized
    // two work orders, and two outcomes citing the same execution evidence.
    const base = validOutcomeRecord();
    const a: OutcomeRecord = { ...base, outcomeId: "oracle-outcome-a" };
    const b: OutcomeRecord = {
      ...base,
      outcomeId: "oracle-outcome-b",
      authorizedWorkRef: "wo-a-different-piece-of-work",
    };
    const result = resolveOutcomeCredits([a, b], AUTHORIZED);
    expect(result.outcome).toBe("DOUBLE_CREDITED");
    if (result.outcome !== "DOUBLE_CREDITED") return;
    expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
      { path: "/outcomes/1/executionEvidenceRefs", code: "duplicate_accepted_work_credit" },
    ]);
  });

  it("work authorized in another run does not count here", () => {
    const foreign = [
      { workRef: "wo-installed-reader-probe", runRef: "run-somebody-else", workspaceRef: "ws-institutional-1" },
    ];
    const result = resolveOutcomeCredits([validOutcomeRecord()], foreign);
    expect(result.outcome).toBe("UNAUTHORIZED_WORK");
    if (result.outcome !== "UNAUTHORIZED_WORK") return;
    expect(result.issues.map((i) => i.code)).toEqual(["work_authorized_elsewhere"]);
  });

  it("an omitted authorized-work set is REFUSED, not read as an empty one", () => {
    expect(resolveOutcomeCredits([validOutcomeRecord()], undefined).outcome).toBe("REFUSED");
    const malformed = resolveOutcomeCredits([validOutcomeRecord()], [{ workRef: "wo-x" }]);
    expect(malformed.outcome).toBe("REFUSED");
  });

  it("a reuse that names no original is refused: unnamed reuse is a second credit renamed", () => {
    const result = validateOutcomeRecord({ ...reuse(), duplicateOfOutcomeRef: null });
    expect(issuesOf(result)).toEqual([
      { path: "/duplicateOfOutcomeRef", code: "reuse_without_original" },
    ]);
  });

  it("a reuse of ITSELF is refused", () => {
    // The first version returned before any comparison for every REUSE, so an
    // outcome naming its own id took reuse credit for work nothing else had
    // credited. Checkable inside one record, and it was not checked.
    const self = reuse();
    const result = validateOutcomeRecord({ ...self, duplicateOfOutcomeRef: self.outcomeId });
    expect(issuesOf(result)).toEqual([
      { path: "/duplicateOfOutcomeRef", code: "self_referential_reuse" },
    ]);
  });

  it("a reuse of an outcome that holds no credit to reuse is MISBOUND_REUSE", () => {
    // A chain of reuses ending at nothing credits an underlying outcome nobody
    // ever credited.
    const first = reuse();
    const second: OutcomeRecord = {
      ...reuse(),
      outcomeId: "oracle-outcome-10",
      duplicateOfOutcomeRef: first.outcomeId,
    };
    const result = resolveOutcomeCredits([validOutcomeRecord(), first, second], AUTHORIZED);
    expect(result.outcome).toBe("MISBOUND_REUSE");
    if (result.outcome !== "MISBOUND_REUSE") return;
    expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
      { path: "/outcomes/2/duplicateOfOutcomeRef", code: "reuse_of_uncredited_outcome" },
    ]);
  });

  it("a reuse whose original is not in the set is REPORTED rather than silently credited", () => {
    // Not refused: the original may live in a part of the ledger this caller
    // did not pass. But the first version returned CREDITED with nothing said,
    // which is the silence this package exists to remove.
    const dangling: OutcomeRecord = {
      ...reuse(),
      duplicateOfOutcomeRef: "oracle-outcome-nowhere",
    };
    const result = resolveOutcomeCredits([validOutcomeRecord(), dangling], AUTHORIZED);
    expect(result.outcome).toBe("CREDITED");
    if (result.outcome !== "CREDITED") return;
    expect(result.unresolvedReuse).toEqual(["oracle-outcome-6"]);
    expect(result.reuse).toEqual(["oracle-outcome-6"]);
    // POSITIVE CONTROL: the resolvable reuse leaves the list empty, so the
    // field means something rather than always being populated.
    const resolvedResult = resolveOutcomeCredits([validOutcomeRecord(), reuse()], AUTHORIZED);
    expect(resolvedResult.outcome === "CREDITED" ? resolvedResult.unresolvedReuse : null).toEqual([]);
  });

  it("a malformed outcome is REFUSED rather than counted as a credit", () => {
    // REFUSED and DOUBLE_CREDITED are different answers; collapsing them would
    // let a broken record read as a clean ledger.
    const result = resolveOutcomeCredits([validOutcomeRecord(), { outcomeId: 7 }], AUTHORIZED);
    expect(result.outcome).toBe("REFUSED");
    for (const hostile of [null, 7, "CREDITED", { outcomes: [] }]) {
      expect(resolveOutcomeCredits(hostile, AUTHORIZED).outcome).toBe("REFUSED");
    }
    // And the empty ledger is CREDITED with nothing, not refused: no outcomes
    // is a real state and not an error.
    expect(resolveOutcomeCredits([], AUTHORIZED)).toEqual({
      outcome: "CREDITED",
      acceptedWork: [],
      reuse: [],
      unresolvedReuse: [],
    });
  });
});

describe("OUT-04 mutation control (QUAL-03): the assertions fail against the old behaviour", () => {
  /**
   * The shipped defect, restored.
   *
   * The first version keyed the accepted-work rule on `creditKey`, a free
   * string the record wrote about itself, and returned early on every REUSE
   * before any comparison. This is that logic, with a local key field standing
   * in for the removed one, so the assertions above can be pointed at it.
   *
   * Disposable and local: never exported, never reachable from the package.
   */
  type Keyed = OutcomeRecord & { readonly creditKey: string };
  function resolveByAuthoredKey(records: readonly Keyed[]): {
    outcome: string;
    acceptedWork: string[];
  } {
    const acceptedByKey = new Map<string, string>();
    const acceptedWork: string[] = [];
    for (const record of records) {
      if (record.creditKind === "REUSE") continue; // returned before any comparison
      if (acceptedByKey.has(record.creditKey)) return { outcome: "DOUBLE_CREDITED", acceptedWork };
      acceptedByKey.set(record.creditKey, record.outcomeId);
      acceptedWork.push(record.outcomeId);
    }
    return { outcome: "CREDITED", acceptedWork };
  }

  // The two records, VALID under the shipped schema. The old dedup key is added
  // only where the old resolver is called: the field no longer exists, and
  // `validateOutcomeRecord` refuses it as an unknown field — which is itself
  // part of the repair, so the fixtures must not carry it into the new path.
  const alpha: OutcomeRecord = { ...validOutcomeRecord(), outcomeId: "oracle-outcome-alpha" };
  const beta: OutcomeRecord = { ...validOutcomeRecord(), outcomeId: "oracle-outcome-beta" };
  const keyed = (record: OutcomeRecord, creditKey: string): Keyed => ({ ...record, creditKey });

  it("the restored defect is genuinely the old behaviour: it credits both", () => {
    // Not the discrimination — the check that the mutant is the mutation it
    // claims to be, so a failure below cannot be a typing or setup error
    // wearing the costume of a caught defect.
    const old = resolveByAuthoredKey([
      keyed(alpha, "credit-key-alpha"),
      keyed(beta, "credit-key-beta"),
    ]);
    expect(old.outcome).toBe("CREDITED");
    expect(old.acceptedWork).toEqual(["oracle-outcome-alpha", "oracle-outcome-beta"]);
    // And the two records ARE one underlying outcome, by every host-bound
    // field there is.
    expect(alpha.proposalRef).toBe(beta.proposalRef);
    expect(alpha.proposalDigest).toBe(beta.proposalDigest);
    expect(alpha.authorizedWorkRef).toBe(beta.authorizedWorkRef);
    expect(alpha.outcomeClass).toBe(beta.outcomeClass);
  });

  it("the shipped resolver DOUBLE_CREDITS them, for the intended reason", () => {
    const result = resolveOutcomeCredits([alpha, beta], AUTHORIZED);
    expect(result.outcome).toBe("DOUBLE_CREDITED");
    if (result.outcome !== "DOUBLE_CREDITED") return;
    expect(result.issues.map((i) => i.code)).toEqual(["duplicate_accepted_work_credit"]);
    // Named at the host-bound field the rule now keys on, not at a string the
    // record chose.
    expect(result.issues[0]?.path).toBe("/outcomes/1/authorizedWorkRef");
  });

  it("and the old resolver credited a self-referential reuse, which is now refused", () => {
    // MEDIUM-3's half: the early return meant no REUSE was ever compared, so an
    // outcome naming its own id took reuse credit for work nothing credited.
    const self: OutcomeRecord = {
      ...validOutcomeRecord(),
      outcomeId: "oracle-outcome-self",
      creditKind: "REUSE",
      duplicateOfOutcomeRef: "oracle-outcome-self",
    };
    expect(resolveByAuthoredKey([keyed(self, "credit-key-self")]).outcome).toBe("CREDITED");
    // The repair refuses it one layer earlier, at the record.
    const stored = validateOutcomeRecord(self);
    expect(issuesOf(stored)).toEqual([
      { path: "/duplicateOfOutcomeRef", code: "self_referential_reuse" },
    ]);
    expect(resolveOutcomeCredits([self], AUTHORIZED).outcome).toBe("REFUSED");
    // And the removed field is genuinely gone: a record still carrying it is
    // refused rather than quietly ignored, so no producer keeps writing one.
    const stillKeyed = validateOutcomeRecord(keyed(validOutcomeRecord(), "credit-key-legacy"));
    expect(issuesOf(stillKeyed)).toEqual([{ path: "/creditKey", code: "unknown_field" }]);
  });
});

describe("an outcome record identifies itself", () => {
  it("key order does not change its identity", () => {
    const parsed = validateOutcomeRecord(validOutcomeRecord());
    const shuffled = validateOutcomeRecord(reversed(validOutcomeRecord()));
    expect(parsed.ok && shuffled.ok).toBe(true);
    if (!parsed.ok || !shuffled.ok) return;
    expect(outcomeRecordDigest(shuffled.value)).toBe(outcomeRecordDigest(parsed.value));
  });
});
