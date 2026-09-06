import { describe, expect, it } from "vitest";
import { canonicalize } from "@getsimpledirect/vinci-contracts";
import {
  REPORT_COMPLETENESS,
  REPORT_COST_STATES,
  RUN_TERMINAL_STATES,
  researchReportDigest,
  validateResearchReport,
} from "./index.ts";
import { reversed, validResearchReport } from "./fixtures.test-helpers.ts";

/**
 * §5.6 and REP-02.
 *
 * The centre of this file is the absence of a rule: `reportCompleteness`,
 * `assessmentCoverage` and `runTerminalState` are never checked against each
 * other, and the sweep below asserts that as a property over every combination
 * rather than trusting that nobody added one. A single cross-rule would make
 * one of the three derivable from another, and the derivable one always ends up
 * being the one a reader wanted to see disagree.
 */

function issuesOf(result: ReturnType<typeof validateResearchReport>) {
  return result.ok ? [] : result.issues.map((i) => ({ path: i.path, code: i.code }));
}

describe("a research report round-trips and identifies itself", () => {
  it("the §22.2-shaped fixture validates and its identity survives key reordering", () => {
    const parsed = validateResearchReport(validResearchReport());
    expect(issuesOf(parsed)).toEqual([]);
    if (!parsed.ok) return;
    const shuffled = validateResearchReport(reversed(validResearchReport()));
    expect(shuffled.ok).toBe(true);
    if (shuffled.ok) expect(researchReportDigest(shuffled.value)).toBe(researchReportDigest(parsed.value));
    expect(validateResearchReport(JSON.parse(canonicalize(parsed.value)) as unknown).ok).toBe(true);
  });
});

describe("REP-02: three separate fields, none derived from another", () => {
  it("every combination of report completeness and run terminal state is a valid record", () => {
    // INV-10: a completed Run, a supported claim, an authorized action and an
    // accepted outcome are four distinct states. A COMPLETE report of an
    // ABORTED run is a real thing — the run stopped and the report still said
    // everything it set out to say — and a schema that refused it would be
    // teaching its writers to pick the flattering field.
    const base = validResearchReport();
    for (const reportCompleteness of REPORT_COMPLETENESS) {
      for (const runTerminalState of RUN_TERMINAL_STATES) {
        const result = validateResearchReport({ ...base, reportCompleteness, runTerminalState });
        expect(issuesOf(result), `${reportCompleteness}/${runTerminalState}`).toEqual([]);
      }
    }
  });

  it("a COMPLETE report with zero assessment coverage is valid, and says so in its own numbers", () => {
    // The combination REP-02 exists for: the report is finished, and NOTHING in
    // it has been independently assessed. Missing assessment must be visible to
    // every consumer, which it cannot be if the schema refuses to represent it.
    const base = validResearchReport();
    const report = {
      ...base,
      reportCompleteness: "COMPLETE",
      stopExplanation: null,
      claims: base.claims.map((entry) => ({ ...entry, assessmentRef: null })),
      assessmentCoverage: { claimsTotal: 2, claimsWithStoredAssessment: 0, claimsNotAssessed: 2 },
    };
    expect(issuesOf(validateResearchReport(report))).toEqual([]);
  });

  it("coverage that contradicts the claim list is refused at the miscounted field", () => {
    const base = validResearchReport();
    const result = validateResearchReport({
      ...base,
      assessmentCoverage: { ...base.assessmentCoverage, claimsWithStoredAssessment: 2 },
    });
    expect(issuesOf(result)).toEqual([
      {
        path: "/assessmentCoverage/claimsWithStoredAssessment",
        code: "assessment_coverage_miscounted",
      },
    ]);
  });

  it("and so is a coverage total that does not match the number of claims", () => {
    const base = validResearchReport();
    const result = validateResearchReport({
      ...base,
      assessmentCoverage: { claimsTotal: 3, claimsWithStoredAssessment: 1, claimsNotAssessed: 1 },
    });
    expect(issuesOf(result)).toEqual([
      { path: "/assessmentCoverage/claimsTotal", code: "assessment_coverage_miscounted" },
    ]);
  });

  it("POSITIVE CONTROL: the declared numbers of the unchanged fixture agree with its claims", () => {
    const report = validResearchReport();
    expect(report.assessmentCoverage).toEqual({
      claimsTotal: 2,
      claimsWithStoredAssessment: 1,
      claimsNotAssessed: 1,
    });
    expect(issuesOf(validateResearchReport(report))).toEqual([]);
  });
});

describe("§22.2: the report references a stored assessment, it does not carry one", () => {
  it("an inline assessment status on a claim entry is refused BY NAME", () => {
    // "A strict implementation must use the canonical independently stored
    // assessment rather than trusting an inline model-written
    // `assessment_status`." The dedicated code is what makes the finding
    // legible: as an unknown field it would read as a typo.
    const base = validResearchReport();
    const [first, second] = base.claims;
    if (first === undefined || second === undefined) throw new Error("fixture must carry two claims");
    const result = validateResearchReport({
      ...base,
      claims: [{ ...first, assessment_status: "SUPPORTED" }, second],
    });
    expect(issuesOf(result)).toEqual([
      { path: "/claims/0/assessment_status", code: "inline_assessment_status" },
    ]);
  });

  it("under any spelling of the same idea", () => {
    const base = validResearchReport();
    const [first, second] = base.claims;
    if (first === undefined || second === undefined) throw new Error("fixture must carry two claims");
    for (const spelling of ["assessmentStatus", "claimAssessmentStatus", "status"]) {
      const result = validateResearchReport({
        ...base,
        claims: [{ ...first, [spelling]: "SUPPORTED" }, second],
      });
      expect(issuesOf(result), spelling).toEqual([
        { path: `/claims/0/${spelling}`, code: "inline_assessment_status" },
      ]);
    }
  });

  it("POSITIVE CONTROL: a claim entry naming a stored assessment by reference is accepted", () => {
    // Without this the rule above would be satisfied by refusing every claim
    // entry, and the report type would carry no claims at all.
    const parsed = validateResearchReport(validResearchReport());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.claims[0]?.assessmentRef).toBe("oracle-assessment-1");
    expect(parsed.value.claims[1]?.assessmentRef).toBeNull();
  });
});

describe("a partial report explains what stopped, and a cost says what is known", () => {
  it("a PARTIAL report with no stop explanation is refused", () => {
    const result = validateResearchReport({ ...validResearchReport(), stopExplanation: null });
    expect(issuesOf(result)).toEqual([
      { path: "/stopExplanation", code: "incomplete_report_without_stop_explanation" },
    ]);
  });

  it("a MEASURED cost with no amount is refused, and an unavailable one carrying an amount too", () => {
    const base = validResearchReport();
    expect(
      issuesOf(validateResearchReport({ ...base, cost: { ...base.cost, state: "MEASURED" } })),
    ).toEqual([{ path: "/cost/amountMicrousd", code: "costed_state_without_amount" }]);
    expect(
      issuesOf(
        validateResearchReport({
          ...base,
          cost: { ...base.cost, amountMicrousd: 40_000 },
        }),
      ),
    ).toEqual([{ path: "/cost/amountMicrousd", code: "uncosted_state_with_amount" }]);
  });

  it("POSITIVE CONTROL: each cost state is writable in the form it belongs in", () => {
    const base = validResearchReport();
    for (const state of REPORT_COST_STATES) {
      const costed = state === "MEASURED" || state === "ESTIMATED";
      const result = validateResearchReport({
        ...base,
        cost: { state, amountMicrousd: costed ? 40_000 : null, ledgerRef: "ledger-oracle-14" },
      });
      expect(issuesOf(result), state).toEqual([]);
    }
  });

  it("a source listed twice in the manifest is refused at the second entry", () => {
    const base = validResearchReport();
    const [entry] = base.sourceManifest;
    if (entry === undefined) throw new Error("fixture must carry a manifest entry");
    const result = validateResearchReport({ ...base, sourceManifest: [entry, { ...entry }] });
    expect(issuesOf(result)).toEqual([
      { path: "/sourceManifest/1/sourceId", code: "duplicate_source_entry" },
    ]);
  });
});
