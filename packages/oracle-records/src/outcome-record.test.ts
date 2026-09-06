import { describe, expect, it } from "vitest";
import {
  OUTCOME_CLASSES,
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
  creditKey: "installed-reader-limitation-2026-09-not-attempted",
});

const observationUnavailable = (): OutcomeRecord => ({
  ...notAttempted(),
  outcomeId: "oracle-outcome-3",
  authorizedWorkRef: "wo-installed-reader-probe",
  executionEvidenceRefs: ["evidence-probe-run-78"],
  outcomeClass: "OBSERVATION_UNAVAILABLE",
  justification: "The probe ran, but the telemetry it would have been judged by was never collected.",
  creditKey: "installed-reader-limitation-2026-09-unobserved",
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
        creditKey: "installed-reader-limitation-2026-09-nothelpful",
      },
      INCONCLUSIVE: {
        ...validOutcomeRecord(),
        outcomeId: "oracle-outcome-5",
        outcomeClass: "INCONCLUSIVE",
        justification: "The probe produced a result the rubric does not classify either way.",
        uncertaintyResolved: null,
        creditKey: "installed-reader-limitation-2026-09-inconclusive",
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

  it("POSITIVE CONTROL: one accepted-work credit alongside a reuse of the same key is CREDITED", () => {
    const result = resolveOutcomeCredits([validOutcomeRecord(), reuse()]);
    expect(result).toEqual({
      outcome: "CREDITED",
      acceptedWork: ["oracle-outcome-1"],
      reuse: ["oracle-outcome-6"],
    });
  });

  it("two accepted-work credits for the same underlying outcome are DOUBLE_CREDITED, by key", () => {
    const second: OutcomeRecord = { ...validOutcomeRecord(), outcomeId: "oracle-outcome-7" };
    const result = resolveOutcomeCredits([validOutcomeRecord(), second]);
    expect(result.outcome).toBe("DOUBLE_CREDITED");
    if (result.outcome !== "DOUBLE_CREDITED") return;
    expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
      { path: "/outcomes/1/creditKey", code: "duplicate_accepted_work_credit" },
    ]);
    // Naming which one, because "some duplicate exists" is not actionable.
    expect(result.issues[0]?.message).toContain("oracle-outcome-1");
  });

  it("two accepted-work credits for DIFFERENT keys are both credited", () => {
    // The discriminating control for the rule above: it is about the key, not
    // about two records sharing a shape.
    const other: OutcomeRecord = {
      ...validOutcomeRecord(),
      outcomeId: "oracle-outcome-8",
      creditKey: "a-different-underlying-outcome",
    };
    const result = resolveOutcomeCredits([validOutcomeRecord(), other]);
    expect(result.outcome).toBe("CREDITED");
    if (result.outcome !== "CREDITED") return;
    expect(result.acceptedWork).toEqual(["oracle-outcome-1", "oracle-outcome-8"]);
  });

  it("a reuse that names no original is refused: unnamed reuse is a second credit renamed", () => {
    const result = validateOutcomeRecord({ ...reuse(), duplicateOfOutcomeRef: null });
    expect(issuesOf(result)).toEqual([
      { path: "/duplicateOfOutcomeRef", code: "reuse_without_original" },
    ]);
  });

  it("a malformed outcome is REFUSED rather than counted as a credit", () => {
    // REFUSED and DOUBLE_CREDITED are different answers; collapsing them would
    // let a broken record read as a clean ledger.
    const result = resolveOutcomeCredits([validOutcomeRecord(), { outcomeId: 7 }]);
    expect(result.outcome).toBe("REFUSED");
    for (const hostile of [null, 7, "CREDITED", { outcomes: [] }]) {
      expect(resolveOutcomeCredits(hostile).outcome).toBe("REFUSED");
    }
    // And the empty ledger is CREDITED with nothing, not refused: no outcomes
    // is a real state and not an error.
    expect(resolveOutcomeCredits([])).toEqual({ outcome: "CREDITED", acceptedWork: [], reuse: [] });
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
