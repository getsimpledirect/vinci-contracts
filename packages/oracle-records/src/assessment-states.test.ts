import { describe, expect, it } from "vitest";
import { canonicalize, type ValidationResult } from "@getsimpledirect/vinci-contracts";
import {
  ASSESSMENT_METHODS,
  ASSESSMENT_STATUSES,
  CHECK_UNAVAILABLE_REASONS,
  REVIEWER_OUTCOME_KINDS,
  claimAssessmentDigest,
  statusForReviewerOutcome,
  validateClaimAssessment,
  type AssessmentStatus,
  type ClaimAssessment,
} from "./index.ts";
import {
  validCheckUnavailableAssessment,
  validNotAssessedAssessment,
  validSupportedAssessment,
  reversed,
} from "./fixtures.test-helpers.ts";

/**
 * T04 — assessment states.
 *
 * Positive: all five states round-trip unchanged through validate →
 * canonicalize → digest → parse. Negative: a parser error, a timeout and empty
 * material each never become support, at BOTH layers that could let them —
 * the function that derives a status from a reviewer run, and the validator
 * that stores one.
 *
 * The mutation control at the bottom is the part that makes the rest mean
 * anything. It restores chat's `catch → supported` behaviour in a disposable
 * local fixture and shows the assertion above FAILS against it, for the
 * intended reason (QUAL-03). A test that only passes against the repaired code
 * cannot tell a working guard from a guard someone deleted.
 */

const SPAN = { sourceId: "oracle-source-1", span: { startOffset: 120, endOffset: 480 } } as const;

const EVALUATED = {
  evaluator: { kind: "verifier", verifierId: "oracle-provenance-checker", independent: true },
  evaluatorVersion: "provenance-check/2.0.1",
  method: "DETERMINISTIC",
  independence: "A host-run checker with no access to the claim's author.",
} as const;

/** A valid instance of every one of the five states. INV-15: none of them is a failure. */
const contradicted = (): ClaimAssessment => ({
  schemaVersion: 1,
  assessmentId: "oracle-assessment-4",
  claimRef: "oracle-claim-1",
  claimDigest: "5e".repeat(32),
  reportDigest: null,
  status: "CONTRADICTED",
  ...EVALUATED,
  limitations: [],
  reviewedSpans: [SPAN],
  conflictSummary: "The reviewed span states the opposite of the proposition, within the claim's scope.",
  issuedAt: "2026-09-06T12:20:00.000Z",
});

const insufficient = (): ClaimAssessment => ({
  schemaVersion: 1,
  assessmentId: "oracle-assessment-5",
  claimRef: "oracle-claim-1",
  claimDigest: "5e".repeat(32),
  reportDigest: null,
  status: "INSUFFICIENT_EVIDENCE",
  ...EVALUATED,
  limitations: ["The reviewed span does not reach the behaviour the claim is about."],
  reviewedSpans: [SPAN],
  whatWouldSettleIt: "An observation of the installed artifact under the unsupported format.",
  issuedAt: "2026-09-06T12:21:00.000Z",
});

const FIVE_STATES: Readonly<Record<AssessmentStatus, () => ClaimAssessment>> = {
  SUPPORTED: validSupportedAssessment,
  CONTRADICTED: contradicted,
  INSUFFICIENT_EVIDENCE: insufficient,
  CHECK_UNAVAILABLE: validCheckUnavailableAssessment,
  NOT_ASSESSED: validNotAssessedAssessment,
};

describe("T04 positive: all five states round-trip unchanged", () => {
  it("covers every member of ASSESSMENT_STATUSES, so a new state cannot go untested", () => {
    expect(Object.keys(FIVE_STATES).sort()).toEqual([...ASSESSMENT_STATUSES].sort());
  });

  for (const status of ASSESSMENT_STATUSES) {
    it(`${status}: validate → canonicalize → digest → parse returns the same record and the same digest`, () => {
      const original = FIVE_STATES[status]();
      const first = validateClaimAssessment(original);
      expect(first.ok ? [] : first.issues).toEqual([]);
      if (!first.ok) return;
      expect(first.value.status).toBe(status);

      const bytes = canonicalize(first.value);
      const reparsed: unknown = JSON.parse(bytes);
      const second = validateClaimAssessment(reparsed);
      expect(second.ok ? [] : second.issues).toEqual([]);
      if (!second.ok) return;

      // Unchanged: the same fields, the same values, and the same identity.
      expect(second.value).toEqual(first.value);
      expect(canonicalize(second.value)).toBe(bytes);
      expect(claimAssessmentDigest(second.value)).toBe(claimAssessmentDigest(first.value));
      // And key order does not change any of it, which is what makes the
      // digest an identity rather than a hash of one producer's habits.
      const shuffled = validateClaimAssessment(reversed(original));
      expect(shuffled.ok).toBe(true);
      if (shuffled.ok) expect(claimAssessmentDigest(shuffled.value)).toBe(claimAssessmentDigest(first.value));
    });
  }

  it("the five states have five distinct identities", () => {
    // Two states sharing a digest would make "round-trips unchanged" true and
    // useless: a consumer could not tell them apart by identity.
    const digests = ASSESSMENT_STATUSES.map((status) => {
      const parsed = validateClaimAssessment(FIVE_STATES[status]());
      if (!parsed.ok) throw new Error(`${status} did not validate`);
      return claimAssessmentDigest(parsed.value);
    });
    expect(new Set(digests).size).toBe(ASSESSMENT_STATUSES.length);
  });

  it("NOT_ASSESSED carries no evaluator and no method, because nothing ran", () => {
    // §5.5: NOT_ASSESSED is deliberately distinct from every other status,
    // including from a check that ran and found nothing. A record carrying an
    // evaluator would be describing an evaluation.
    const record = validNotAssessedAssessment();
    expect("evaluator" in record).toBe(false);
    expect("method" in record).toBe(false);
    // The positive control on the same property: an EVALUATED state does carry
    // both, so the absence above is the state and not a fixture that forgot.
    const supported = validSupportedAssessment();
    expect("evaluator" in supported).toBe(true);
    expect(ASSESSMENT_METHODS as readonly string[]).toContain(
      "method" in supported ? supported.method : "",
    );
  });
});

/**
 * The property under test, as a function of the thing that derives a status.
 *
 * Written this way ON PURPOSE: the mutation control below feeds it a restored
 * fail-open implementation, and a property expressed as a function is the only
 * form that can be pointed at two implementations. A copy of these assertions
 * inlined against the real function would prove nothing about the defect.
 */
function noFailureBecomesSupport(statusOf: (outcome: unknown) => AssessmentStatus): void {
  for (const kind of REVIEWER_OUTCOME_KINDS.filter((k) => k !== "COMPLETED")) {
    expect(statusOf({ kind, detail: `the reviewer reported ${kind}` }), kind).toBe("CHECK_UNAVAILABLE");
  }
  // CLM-01's other two cases, which are not reviewer FAILURES: a completed run
  // over empty material, and a document that never parsed into an outcome at
  // all.
  expect(statusOf({ kind: "COMPLETED", finding: "SUPPORTS", reviewedSpans: [] })).not.toBe("SUPPORTED");
  expect(statusOf(undefined)).not.toBe("SUPPORTED");
}

/**
 * The same property one layer down: at the STORED record rather than at the
 * status derivation.
 *
 * Both layers need their own mutation control, because they fail open
 * independently — a validator that accepted an unearned SUPPORTED would let a
 * record written by hand, or by a different producer, past a correct status
 * function.
 */
function unearnedSupportIsRefused(
  validate: (input: unknown) => ValidationResult<unknown>,
): void {
  const result = validate({ ...validSupportedAssessment(), reviewedSpans: [] });
  expect(result.ok, "a SUPPORTED assessment naming no reviewed span was accepted").toBe(false);
  if (result.ok) return;
  expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
    { path: "/reviewedSpans", code: "unearned_support" },
  ]);
}

describe("T04 negative: a parse error, a timeout and empty material never become support", () => {
  it("the reviewer-outcome vocabulary names CLM-01's cases, so the sweep above is not a corner", () => {
    expect(REVIEWER_OUTCOME_KINDS).toContain("PARSE_ERROR");
    expect(REVIEWER_OUTCOME_KINDS).toContain("TIMED_OUT");
    expect(REVIEWER_OUTCOME_KINDS).toContain("EMPTY_MATERIAL");
    expect(REVIEWER_OUTCOME_KINDS).toContain("MISSING_CITATION");
    expect(REVIEWER_OUTCOME_KINDS).toContain("INCOMPLETE_EXECUTION");
    // Every failure kind has a matching stored reason, so a CHECK_UNAVAILABLE
    // record can say which of them happened.
    expect(CHECK_UNAVAILABLE_REASONS.length).toBeGreaterThanOrEqual(
      REVIEWER_OUTCOME_KINDS.length - 1,
    );
  });

  it("no reviewer failure, and no empty-material completion, yields SUPPORTED", () => {
    noFailureBecomesSupport(statusForReviewerOutcome);
  });

  it("POSITIVE REACHABILITY CONTROL: a completed run over real spans does yield SUPPORTED", () => {
    // Without this, a `statusForReviewerOutcome` that returned CHECK_UNAVAILABLE
    // unconditionally would satisfy every assertion above — and INV-15 says a
    // package that refuses everything has not qualified.
    expect(
      statusForReviewerOutcome({ kind: "COMPLETED", finding: "SUPPORTS", reviewedSpans: [SPAN] }),
    ).toBe("SUPPORTED");
    expect(
      statusForReviewerOutcome({ kind: "COMPLETED", finding: "CONTRADICTS", reviewedSpans: [SPAN] }),
    ).toBe("CONTRADICTED");
    expect(
      statusForReviewerOutcome({ kind: "COMPLETED", finding: "UNDECIDED", reviewedSpans: [SPAN] }),
    ).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("an unrecognised outcome is CHECK_UNAVAILABLE and never throws out of an error path", () => {
    // The caller is an error path by construction. A status function that
    // throws inside a catch block is how the catch block ends up returning a
    // default instead.
    for (const hostile of [null, 7, "SUPPORTED", [], { kind: "toString" }, { kind: "COMPLETED" }]) {
      expect(statusForReviewerOutcome(hostile)).not.toBe("SUPPORTED");
    }
    expect(statusForReviewerOutcome({ kind: "toString" })).toBe("CHECK_UNAVAILABLE");
  });

  it("a stored SUPPORTED with no reviewed span is refused at /reviewedSpans with unearned_support", () => {
    // ONE field changed from a known-valid fixture, and the exact path and code
    // asserted: a negative that merely returned ok:false could be passing
    // because an earlier, unrelated check refused first.
    //
    // Expressed as a function for the same reason `noFailureBecomesSupport` is:
    // the mutation control below points it at a fail-open validator.
    unearnedSupportIsRefused(validateClaimAssessment);
  });

  it("a stored SUPPORTED whose reviewer run did not complete is refused at /execution/completed", () => {
    const result = validateClaimAssessment({
      ...validSupportedAssessment(),
      execution: { completed: false, reviewerRunRef: "reviewer-run-41" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
      { path: "/execution/completed", code: "unearned_support" },
    ]);
  });

  it("a CHECK_UNAVAILABLE record claiming reviewed spans is refused by that name, not as a typo", () => {
    // The distinction IS the finding: "this record claims a review its own
    // status says produced nothing" must not read as an unknown field.
    const result = validateClaimAssessment({
      ...validCheckUnavailableAssessment(),
      reviewedSpans: [SPAN],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
      { path: "/reviewedSpans", code: "unavailable_check_claims_review" },
    ]);
  });

  it("POSITIVE CONTROL for all three refusals: the unchanged fixtures still validate", () => {
    expect(validateClaimAssessment(validSupportedAssessment()).ok).toBe(true);
    expect(validateClaimAssessment(validCheckUnavailableAssessment()).ok).toBe(true);
  });
});

describe("T04 mutation control (QUAL-03): the assertion fails against restored fail-open behaviour", () => {
  /**
   * Chat's grader, transcribed.
   *
   * `lib/harness/grader.ts` on vinci-chat's main comments "(ok:true) on any
   * error — the grader must never block an answer" and returns
   * `{status:'supported'}` from its catch block. That is correct there and
   * catastrophic here, and this local copy exists so the difference is
   * DEMONSTRATED rather than described.
   *
   * Disposable and local: it is never exported, never reachable from the
   * package, and exists only as the thing the assertion is pointed at.
   */
  function failOpenStatus(outcome: unknown): AssessmentStatus {
    try {
      const snapshot = JSON.parse(JSON.stringify(outcome)) as { kind?: unknown };
      if (snapshot.kind !== "COMPLETED") throw new Error("the reviewer did not complete");
      return "SUPPORTED";
    } catch {
      return "SUPPORTED";
    }
  }

  it("the restored defect is genuinely the old behaviour: it answers SUPPORTED for a timeout", () => {
    // Not part of the discrimination — this is the check that the mutant is the
    // mutation it claims to be, so a failure below cannot be an import or
    // typing error wearing the costume of a caught defect.
    expect(failOpenStatus({ kind: "TIMED_OUT", detail: "wall clock exceeded" })).toBe("SUPPORTED");
    expect(failOpenStatus(undefined)).toBe("SUPPORTED");
  });

  it("noFailureBecomesSupport FAILS against it, and fails on the status, not on a setup error", () => {
    let thrown: unknown;
    try {
      noFailureBecomesSupport(failOpenStatus);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, "the assertion passed against fail-open behaviour").toBeDefined();
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    // For the INTENDED reason: the value it saw was SUPPORTED where
    // CHECK_UNAVAILABLE was required. A collection or import error would not
    // mention either.
    expect(message).toContain("SUPPORTED");
    expect(message).toContain("CHECK_UNAVAILABLE");
  });

  it("and the same assertion passes against the shipped function", () => {
    // The other half of the control. Both arms are needed: one shows the
    // assertion can fail, the other that the code under test is not the thing
    // failing.
    expect(() => noFailureBecomesSupport(statusForReviewerOutcome)).not.toThrow();
  });

  /**
   * The stored-record layer's own fail-open, because the two layers fail open
   * independently: a validator that accepted an unearned SUPPORTED would admit
   * a record written by hand, or by a producer that never called
   * `statusForReviewerOutcome` at all.
   */
  function failOpenValidate(input: unknown): ValidationResult<unknown> {
    return { ok: true, value: input, unknownFields: {} };
  }

  it("the record-level assertion FAILS against a validator that accepts unearned support", () => {
    expect(failOpenValidate({}).ok).toBe(true);
    let thrown: unknown;
    try {
      unearnedSupportIsRefused(failOpenValidate);
    } catch (error) {
      thrown = error;
    }
    expect(thrown, "the assertion passed against a fail-open validator").toBeDefined();
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    // For the intended reason, named in the assertion's own message rather
    // than by an import or collection error.
    expect(message).toContain("naming no reviewed span was accepted");
  });

  it("and passes against the shipped validator", () => {
    expect(() => unearnedSupportIsRefused(validateClaimAssessment)).not.toThrow();
  });
});
