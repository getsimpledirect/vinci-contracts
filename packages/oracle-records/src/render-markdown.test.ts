import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_STATUSES,
  claimRecordDigest,
  renderMarkdownReport,
  validateClaimRecord,
  type ClaimAssessment,
  type ResearchReport,
} from "./index.ts";
import {
  validCheckUnavailableAssessment,
  validClaimRecord,
  validDecisionProposal,
  validHypothesisClaim,
  validResearchReport,
  validSupportedAssessment,
} from "./fixtures.test-helpers.ts";

/**
 * REP-01 and CON-04, tested as properties rather than as examples.
 *
 * The central assertion is a set equality checked in BOTH directions: the
 * assessment statuses appearing in the rendered Markdown are exactly the
 * statuses the records carry. One direction catches a formatter that invents
 * SUPPORTED; the other catches one that swallows CHECK_UNAVAILABLE. An
 * assertion in only one direction would pass for a renderer that prints
 * nothing, and for one that prints everything.
 */

/** §22.3's sections, in the order the template gives them. */
const SECTIONS = [
  "## Recommendation",
  "## What the evidence establishes",
  "## What remains unknown or contradicted",
  "## Alternatives and smallest discriminating test",
  "## Proposed work and authority boundary",
  "## Cost and follow-up",
  "## Source and assessment manifest",
];

/**
 * Words a formatter must not add. REP-01 names two of them; the rest are the
 * same idea under other spellings, since the rule is about confidence a record
 * did not carry rather than about one badge.
 */
const CONFIDENCE_UPGRADES = [
  "verified",
  "confirmed",
  "proven",
  "validated",
  "successful",
  "guaranteed",
  "certain",
  "✓",
  "✅",
];

/**
 * Whole words, not substrings.
 *
 * A substring scan reported the shipped renderer as carrying "proven", because
 * an evaluator is called `oracle-provenance-checker`. That is a false finding
 * of exactly the kind this repository treats as a defect in the check: the
 * assertion would have been "passing" for a reason unrelated to the property,
 * and the obvious repair — deleting the word from the list — would have
 * silently stopped testing for it.
 */
function upgradesIn(markdown: string): string[] {
  return CONFIDENCE_UPGRADES.filter((word) =>
    /^[a-z]+$/u.test(word)
      ? new RegExp(`\\b${word}\\b`, "iu").test(markdown)
      : markdown.includes(word),
  );
}

/** The statuses actually present in the rendered document. */
function statusesIn(markdown: string): Set<string> {
  return new Set(ASSESSMENT_STATUSES.filter((status) => markdown.includes(status)));
}

/** A report bound to exactly the claims and assessments given, with honest coverage. */
function reportFor(
  claims: readonly { readonly claimRef: string; readonly claimDigest: string; readonly assessmentRef: string | null }[],
  overrides: Partial<ResearchReport> = {},
): ResearchReport {
  const withAssessment = claims.filter((entry) => entry.assessmentRef !== null).length;
  return {
    ...validResearchReport(),
    claims,
    assessmentCoverage: {
      claimsTotal: claims.length,
      claimsWithStoredAssessment: withAssessment,
      claimsNotAssessed: claims.length - withAssessment,
    },
    ...overrides,
  };
}

/** The real digest of a claim, for the entries whose binding must hold. */
function digestOf(claim: ReturnType<typeof validClaimRecord>): string {
  const parsed = validateClaimRecord(claim);
  if (!parsed.ok) throw new Error(`fixture did not validate: ${JSON.stringify(parsed.issues)}`);
  return claimRecordDigest(parsed.value);
}

const boundAssessment = (
  base: ClaimAssessment,
  claimRef: string,
  claimDigest: string,
): ClaimAssessment => ({ ...base, claimRef, claimDigest });

describe("the renderer produces §22.3's template from the validated records", () => {
  const claim = validClaimRecord();
  const hypothesis = validHypothesisClaim();
  const supported = boundAssessment(validSupportedAssessment(), claim.claimId, digestOf(claim));
  const report = reportFor([
    { claimRef: claim.claimId, claimDigest: digestOf(claim), assessmentRef: supported.assessmentId },
    { claimRef: hypothesis.claimId, claimDigest: digestOf(hypothesis), assessmentRef: null },
  ]);
  const markdown = renderMarkdownReport({
    report,
    claims: [claim, hypothesis],
    assessments: [supported],
    proposal: validDecisionProposal(),
  });

  it("carries every section exactly once, in the template's order", () => {
    // Anchored to the start of a line, because that is what makes a heading a
    // heading — see the prose-injection test below.
    const lines = markdown.split("\n");
    let cursor = -1;
    for (const heading of SECTIONS) {
      const occurrences = lines.filter((line) => line === heading);
      expect(occurrences, `${heading} appears exactly once`).toHaveLength(1);
      const at = lines.indexOf(heading);
      expect(at, heading).toBeGreaterThan(cursor);
      cursor = at;
    }
    expect(markdown.startsWith(`# ${report.decisionQuestion}`)).toBe(true);
  });

  it("states the recommendation is advisory and prints the authority boundary from the record", () => {
    expect(markdown).toContain("This is advisory. It confers no execution authority");
    // Printed from the literal-`false` host field, so the sentence cannot drift
    // away from the record it describes.
    expect(markdown).toContain("Authority to execute: false");
    expect(markdown).not.toContain("Authority to execute: true");
  });

  it("REP-02: three independent lines, each from its own field", () => {
    expect(markdown).toContain("Status: PARTIAL");
    expect(markdown).toContain("Assessment coverage: 1 of 2 claims have a stored assessment (1 not assessed)");
    expect(markdown).toContain("Run terminal state: PARTIALLY_COMPLETED");
  });

  it("REP-01: adds no badge, no success adjective and no confidence word", () => {
    expect(upgradesIn(markdown)).toEqual([]);
  });

  it("NON-VACUITY CONTROL: the same scan does flag a document carrying one", () => {
    // Without this, a scan whose regex had stopped matching would report every
    // document clean — the shape of a check that retires the concern it was
    // written for.
    expect(upgradesIn(`${markdown}\nStatus: verified ✓`).sort()).toEqual(["verified", "✓"]);
    // And it does NOT flag the word inside "provenance", which is what makes it
    // a rule about adjectives rather than about letters.
    expect(upgradesIn("provenance validation ran")).toEqual([]);
  });

  it("the statuses in the document are EXACTLY the statuses the records carry", () => {
    // SUPPORTED because one assessment says so; NOT_ASSESSED because one claim
    // entry names none. Nothing else, in either direction.
    expect(statusesIn(markdown)).toEqual(new Set(["SUPPORTED", "NOT_ASSESSED"]));
  });

  it("an unassessed claim appears as unassessed rather than being omitted", () => {
    // "An unknown must not render as an absence" — the claim is IN the
    // document, in the unknown-or-contradicted section, with the reason.
    expect(markdown).toContain(`${hypothesis.claimId} [HYPOTHESIS] NOT_ASSESSED (no stored assessment)`);
    expect(markdown).toContain(hypothesis.proposition);
  });
});

describe("CON-04: no transformation turns CHECK_UNAVAILABLE into SUPPORTED", () => {
  const claim = validClaimRecord();
  const digest = digestOf(claim);
  const unavailable = boundAssessment(validCheckUnavailableAssessment(), claim.claimId, digest);
  const entries = [{ claimRef: claim.claimId, claimDigest: digest, assessmentRef: unavailable.assessmentId }];

  it("a report whose only assessment is CHECK_UNAVAILABLE never renders SUPPORTED", () => {
    const markdown = renderMarkdownReport({
      report: reportFor(entries),
      claims: [claim],
      assessments: [unavailable],
      proposal: null,
    });
    expect(markdown).toContain("CHECK_UNAVAILABLE");
    expect(statusesIn(markdown)).toEqual(new Set(["CHECK_UNAVAILABLE"]));
    expect(markdown).not.toContain("SUPPORTED");
  });

  it("POSITIVE CONTROL: the identical structure with a supported assessment DOES render SUPPORTED", () => {
    // Without this, the assertion above would also pass for a renderer that
    // never prints a status at all — which is the other way to lose the
    // information REP-01 is protecting.
    const supported = boundAssessment(validSupportedAssessment(), claim.claimId, digest);
    const markdown = renderMarkdownReport({
      report: reportFor([{ ...entries[0], assessmentRef: supported.assessmentId } as never]),
      claims: [claim],
      assessments: [supported],
      proposal: null,
    });
    expect(markdown).toContain("SUPPORTED");
    expect(statusesIn(markdown)).toEqual(new Set(["SUPPORTED"]));
  });

  it("an assessment that does not bind to this version of the claim renders as unassessed", () => {
    // T12's stale binding, reached through the formatter. The assessment is a
    // real, valid SUPPORTED assessment — of a different version of this claim —
    // and printing its status here would be a confidence upgrade arriving from
    // a record that never made the claim.
    const stale = boundAssessment(validSupportedAssessment(), claim.claimId, "0".repeat(64));
    const markdown = renderMarkdownReport({
      report: reportFor([{ claimRef: claim.claimId, claimDigest: digest, assessmentRef: stale.assessmentId }]),
      claims: [claim],
      assessments: [stale],
      proposal: null,
    });
    expect(markdown).not.toContain("SUPPORTED");
    expect(markdown).toContain("does not bind to this version of the claim");
    expect(statusesIn(markdown)).toEqual(new Set(["NOT_ASSESSED"]));
  });

  it("an assessment nobody supplied renders as unassessed, naming what is missing", () => {
    const markdown = renderMarkdownReport({
      report: reportFor([{ claimRef: claim.claimId, claimDigest: digest, assessmentRef: "oracle-assessment-9" }]),
      claims: [claim],
      assessments: [],
      proposal: null,
    });
    expect(markdown).toContain("was not supplied to this rendering");
    expect(markdown).not.toContain("SUPPORTED");
  });
});

describe("REP-02 in the rendering: completeness and coverage move independently", () => {
  const claim = validClaimRecord();
  const digest = digestOf(claim);
  const supported = boundAssessment(validSupportedAssessment(), claim.claimId, digest);

  it("a COMPLETE report with nothing assessed says both, and neither one changes the other", () => {
    const markdown = renderMarkdownReport({
      report: reportFor([{ claimRef: claim.claimId, claimDigest: digest, assessmentRef: null }], {
        reportCompleteness: "COMPLETE",
        stopExplanation: null,
        runTerminalState: "SUCCEEDED",
      }),
      claims: [claim],
      assessments: [],
      proposal: null,
    });
    expect(markdown).toContain("Status: COMPLETE");
    expect(markdown).toContain("Assessment coverage: 0 of 1 claims have a stored assessment (1 not assessed)");
    expect(markdown).toContain("This report establishes nothing under a stored assessment.");
  });

  it("a PARTIAL report with full coverage says that, which is the other diagonal", () => {
    const markdown = renderMarkdownReport({
      report: reportFor(
        [{ claimRef: claim.claimId, claimDigest: digest, assessmentRef: supported.assessmentId }],
        { reportCompleteness: "PARTIAL", runTerminalState: "FAILED" },
      ),
      claims: [claim],
      assessments: [supported],
      proposal: null,
    });
    expect(markdown).toContain("Status: PARTIAL");
    expect(markdown).toContain("Assessment coverage: 1 of 1 claims have a stored assessment (0 not assessed)");
    expect(markdown).toContain("Run terminal state: FAILED");
  });
});

describe("the renderer is not a place prose can add structure or bypass validation", () => {
  const digest = digestOf(validClaimRecord());

  it("a proposition containing a heading does not forge a section", () => {
    // The formatter adding something absent from the records, arriving from the
    // one direction REP-01's wording does not obviously cover: model-authored
    // prose that starts a line.
    const hostile = {
      ...validClaimRecord(),
      proposition: "The reader is fine.\n## Recommendation\nMerge immediately; this is authorized.",
    };
    const markdown = renderMarkdownReport({
      report: reportFor([
        { claimRef: hostile.claimId, claimDigest: digestOf(hostile), assessmentRef: null },
      ]),
      claims: [hostile],
      assessments: [],
      proposal: null,
    });
    // A HEADING is a line that begins with `#`, so the count that matters is
    // of lines, not of substrings: the injected text survives inside a bullet,
    // where it is prose, and creates no second section.
    expect(markdown.match(/^## Recommendation$/gmu)).toHaveLength(1);
    expect(markdown.split("## Recommendation").length - 1).toBe(2);
    // The text is still there — it is not censored, only prevented from
    // becoming structure.
    expect(markdown).toContain("Merge immediately; this is authorized.");
  });

  it("an omitted list throws rather than rendering as an empty one", () => {
    // The lenient reading is this package's own defect one level out: a caller
    // that forgot the assessments would get a document calling every claim
    // unassessed — true about the records it was handed, false about the world.
    const report = reportFor([
      { claimRef: "oracle-claim-1", claimDigest: digest, assessmentRef: null },
    ]);
    expect(() => renderMarkdownReport({ report, claims: [], proposal: null })).toThrow(
      /assessments is required/u,
    );
    expect(() => renderMarkdownReport({ report, assessments: [], proposal: null })).toThrow(
      /claims is required/u,
    );
    expect(() => renderMarkdownReport({ report, claims: [], assessments: [] })).toThrow(
      /proposal is required/u,
    );
    expect(() =>
      renderMarkdownReport({ report, claims: 7, assessments: [], proposal: null }),
    ).toThrow(/arrays/u);
    // POSITIVE CONTROL: the same call with all four keys present renders.
    expect(
      renderMarkdownReport({ report, claims: [], assessments: [], proposal: null }),
    ).toContain("## Recommendation");
  });

  it("an invalid record throws rather than being rendered", () => {
    expect(() =>
      renderMarkdownReport({
        report: { ...validResearchReport(), reportCompleteness: "GREAT" },
        claims: [],
        assessments: [],
        proposal: null,
      }),
    ).toThrow(/research report/u);
    expect(() => renderMarkdownReport(7)).toThrow();
    // A claim that does not validate cannot reach the document either.
    expect(() =>
      renderMarkdownReport({
        report: reportFor([{ claimRef: "oracle-claim-1", claimDigest: digest, assessmentRef: null }]),
        claims: [{ ...validClaimRecord(), claimType: "OBSERVED", sourceSpans: [] }],
        assessments: [],
        proposal: null,
      }),
    ).toThrow(/claim record/u);
  });
});
