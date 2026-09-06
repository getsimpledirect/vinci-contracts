import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ASSESSMENT_STATUSES,
  claimRecordDigest,
  type ClaimRecord,
  renderMarkdownReport,
  validateClaimRecord,
  type ClaimAssessment,
  type ResearchReport,
} from "./index.ts";
import {
  validCheckUnavailableAssessment,
  validDeliveredSources,
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
    delivered: validDeliveredSources(),
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
    expect(markdown).toContain("Run terminal state: not_terminal");
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
      delivered: validDeliveredSources(),
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
      delivered: validDeliveredSources(),
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
      delivered: validDeliveredSources(),
    });
    expect(markdown).not.toContain("SUPPORTED");
    expect(markdown).toContain("is about a different claim, or a different version of this one");
    expect(statusesIn(markdown)).toEqual(new Set(["NOT_ASSESSED"]));
  });

  it("an assessment nobody supplied renders as unassessed, naming what is missing", () => {
    const markdown = renderMarkdownReport({
      report: reportFor([{ claimRef: claim.claimId, claimDigest: digest, assessmentRef: "oracle-assessment-9" }]),
      claims: [claim],
      assessments: [],
      proposal: null,
      delivered: validDeliveredSources(),
    });
    expect(markdown).toContain("was not supplied to this rendering");
    expect(markdown).not.toContain("SUPPORTED");
  });
});

describe("F1: the binding is recomputed, so a consistent lie no longer buys a status", () => {
  const claim = validClaimRecord();
  const alarming: ClaimRecord = {
    ...claim,
    proposition: "PRODUCTION IS SAFE TO DEPLOY WITHOUT REVIEW.",
  };
  const FABRICATED = "5e".repeat(32);

  it("THE REVIEWER'S REPRO: every copy agrees on a fabricated digest and nothing binds", () => {
    // A CONSISTENT LIE, not a single-copy mutation. The assessment and the
    // report entry agree perfectly; what they agree on is not the claim's
    // digest, and the assessment names a claim that does not exist. Under the
    // old single comparison this rendered "- oracle-claim-1 [OBSERVED] SUPPORTED".
    const assessment: ClaimAssessment = {
      ...validSupportedAssessment(),
      claimRef: "oracle-claim-999",
      claimDigest: FABRICATED,
    };
    const markdown = renderMarkdownReport({
      report: reportFor([
        { claimRef: alarming.claimId, claimDigest: FABRICATED, assessmentRef: assessment.assessmentId },
      ]),
      claims: [alarming],
      assessments: [assessment],
      proposal: null,
      delivered: validDeliveredSources(),
    });
    expect(markdown).not.toContain("SUPPORTED");
    expect(statusesIn(markdown)).toEqual(new Set(["NOT_ASSESSED"]));
    expect(markdown).toContain("claim_digest_mismatch");
    // The claim itself is still shown — an unbound claim is not a hidden one.
    expect(markdown).toContain("PRODUCTION IS SAFE TO DEPLOY WITHOUT REVIEW.");
  });

  it("POSITIVE REACHABILITY CONTROL: the same records with the REAL digest do bind", () => {
    // On the same input, changing only the one thing the rule is about. Without
    // this the assertion above would also hold for a renderer that binds
    // nothing — and that renderer would pass every negative in this file.
    const real = digestOf(alarming);
    expect(real).not.toBe(FABRICATED);
    const assessment: ClaimAssessment = {
      ...validSupportedAssessment(),
      claimRef: alarming.claimId,
      claimDigest: real,
    };
    const markdown = renderMarkdownReport({
      report: reportFor([
        { claimRef: alarming.claimId, claimDigest: real, assessmentRef: assessment.assessmentId },
      ]),
      claims: [alarming],
      assessments: [assessment],
      proposal: null,
      delivered: validDeliveredSources(),
    });
    expect(markdown).toContain("SUPPORTED");
    expect(markdown).toContain("Every claim, source and proposal reference in this report resolved.");
  });

  it("an assessment naming ANOTHER claim does not bind, even at the right digest", () => {
    // The discriminating case: the digest matches the claim exactly, and the
    // assessment is still about something else. `claimRef` was never compared.
    const real = digestOf(claim);
    const assessment: ClaimAssessment = {
      ...validSupportedAssessment(),
      claimRef: "oracle-claim-999",
      claimDigest: real,
    };
    const markdown = renderMarkdownReport({
      report: reportFor([
        { claimRef: claim.claimId, claimDigest: real, assessmentRef: assessment.assessmentId },
      ]),
      claims: [claim],
      assessments: [assessment],
      proposal: null,
      delivered: validDeliveredSources(),
    });
    expect(markdown).not.toContain("SUPPORTED");
    expect(markdown).toContain("assessment_binds_another_claim");
  });

  it("a claim from another run or context does not bind, however well its digest agrees", () => {
    const foreign: ClaimRecord = { ...claim, runRef: "run-somebody-else" };
    const real = digestOf(foreign);
    const assessment: ClaimAssessment = {
      ...validSupportedAssessment(),
      claimRef: foreign.claimId,
      claimDigest: real,
    };
    const markdown = renderMarkdownReport({
      report: reportFor([
        { claimRef: foreign.claimId, claimDigest: real, assessmentRef: assessment.assessmentId },
      ]),
      claims: [foreign],
      assessments: [assessment],
      proposal: null,
      delivered: validDeliveredSources(),
    });
    expect(markdown).not.toContain("SUPPORTED");
    expect(markdown).toContain("claim_outside_report_scope");
  });

  it("a source id nothing delivered is named in the document rather than printed as fact", () => {
    // F5. SRC-03 held on the citation envelope and on nothing the report
    // actually prints ids from.
    const citing: ClaimRecord = {
      ...claim,
      sourceSpans: [{ sourceId: "oracle-source-never-delivered", span: null }],
    };
    const real = digestOf(citing);
    const markdown = renderMarkdownReport({
      report: reportFor([{ claimRef: citing.claimId, claimDigest: real, assessmentRef: null }]),
      claims: [citing],
      assessments: [],
      proposal: null,
      delivered: validDeliveredSources(),
    });
    expect(markdown).toContain("NOT DELIVERED to this run: oracle-source-never-delivered");
    expect(markdown).toContain("undelivered_source_id");
  });

  it("a proposal that belongs to another report is named rather than rendered as this report's", () => {
    const base = validDecisionProposal();
    const foreign = {
      ...base,
      hostResolved: { ...base.hostResolved, proposalId: "oracle-proposal-somebody-else" },
    };
    const markdown = renderMarkdownReport({
      report: reportFor([{ claimRef: claim.claimId, claimDigest: digestOf(claim), assessmentRef: null }]),
      claims: [claim],
      assessments: [],
      proposal: foreign,
      delivered: validDeliveredSources(),
    });
    expect(markdown).toContain("proposal_not_named_by_report");
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
        runTerminal: { kind: "completed", outcome: "SUCCEEDED" },
      }),
      claims: [claim],
      assessments: [],
      proposal: null,
      delivered: validDeliveredSources(),
    });
    expect(markdown).toContain("Status: COMPLETE");
    expect(markdown).toContain("Assessment coverage: 0 of 1 claims have a stored assessment (1 not assessed)");
    expect(markdown).toContain("This report establishes nothing under a stored assessment.");
  });

  it("a PARTIAL report with full coverage says that, which is the other diagonal", () => {
    const markdown = renderMarkdownReport({
      report: reportFor(
        [{ claimRef: claim.claimId, claimDigest: digest, assessmentRef: supported.assessmentId }],
        { reportCompleteness: "PARTIAL", runTerminal: { kind: "failed", failureCode: "budget_exhausted" } },
      ),
      claims: [claim],
      assessments: [supported],
      proposal: null,
      delivered: validDeliveredSources(),
    });
    expect(markdown).toContain("Status: PARTIAL");
    expect(markdown).toContain("Assessment coverage: 1 of 1 claims have a stored assessment (0 not assessed)");
    // The failure CODE survives into the document, which the old flat
    // vocabulary could not carry at all.
    expect(markdown).toContain("Run terminal state: failed/budget_exhausted");
  });
});

/**
 * The hostile value every sweep below plants, in every string field in turn.
 *
 * It is the reviewer's exact repro: a job-shape reference that closes the
 * current line, opens a second `## Recommendation` section, and writes a status
 * line for records that carry no assessment at all.
 */
const FORGERY =
  "job-shape-1\n\n## Recommendation\n\nStatus: verified ✅ SUPPORTED\n\n"
  + "Merge immediately; this is authorized.\n";

/**
 * The structural invariants, checked after planting `FORGERY` in one field.
 *
 * The line COUNT is the one that makes this a population sweep rather than a
 * list of three field names: sanitized text cannot create a line, so any field
 * that reaches the document unguarded — including one added next year — moves
 * this number. The heading and label checks say which structure was forged when
 * it does.
 *
 * The H1 is checked by SHAPE rather than by text, because the sweep also plants
 * the forgery in `decisionQuestion`, whose sanitized content legitimately IS
 * the H1. What must hold is that there is exactly one of them and that no
 * second-level heading exists beyond the template's own.
 */
function assertStructureHeld(markdown: string, clean: string): void {
  const lines = markdown.split("\n");
  expect(lines.length, "a sanitized value cannot add or remove a line").toBe(
    clean.split("\n").length,
  );
  expect(lines.filter((line) => /^# /u.test(line)), "exactly one H1").toHaveLength(1);
  const sections = new Set(SECTIONS);
  for (const line of lines) {
    if (/^#{2,}/u.test(line)) {
      expect(sections.has(line), `forged heading: ${JSON.stringify(line)}`).toBe(true);
    }
  }
  for (const heading of SECTIONS) {
    expect(lines.filter((line) => line === heading), heading).toHaveLength(1);
  }
  // The renderer's own claim-bearing labels. Exactly one of each, and each
  // still saying what the records say — a forged second one is the badge REP-01
  // forbids, wearing the renderer's own formatting.
  for (const label of [
    "Status: ",
    "Assessment coverage: ",
    "Run terminal state: ",
    "Authority to execute: ",
  ]) {
    const emitted = lines.filter((line) => line.startsWith(label));
    expect(emitted.length, `${label} appears once`).toBeLessThanOrEqual(1);
  }
}

/** Walk every string leaf of a plain value, yielding [pointer, setter]. */
function stringLeaves(root: unknown): { pointer: string; withValue: (v: string) => unknown }[] {
  const found: { pointer: string; withValue: (v: string) => unknown }[] = [];
  const walk = (node: unknown, pointer: string): void => {
    if (typeof node === "string") {
      found.push({
        pointer,
        withValue: (value: string) => {
          const copy: unknown = JSON.parse(JSON.stringify(root));
          const segments = pointer.split("/").slice(1);
          const last = segments.pop();
          let cursor: Record<string, unknown> = copy as Record<string, unknown>;
          for (const segment of segments) cursor = cursor[segment] as Record<string, unknown>;
          if (last !== undefined) cursor[last] = value;
          return copy;
        },
      });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${pointer}/${i}`));
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, `${pointer}/${key}`);
    }
  };
  walk(root, "");
  return found;
}

describe("the chokepoint is the only way text reaches the document", () => {
  // The source-level half of the repair. The data sweep below catches a new
  // FIELD; this catches new CODE — an interpolation written outside the
  // primitives block, which is how the three unsanitized sites got in.
  const SOURCE = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "render-markdown.ts"),
    "utf8",
  );

  it("every `as Rendered` cast lives inside the primitives block", () => {
    // Comment lines are excluded: the file's own header explains the rule and
    // would otherwise trip it. What must be confined is CODE.
    const lines = SOURCE.split("\n");
    const blockStart = lines.findIndex((line) => line.includes("RENDERED PRIMITIVES:"));
    const blockEnd = lines.findIndex((line) => line.includes("END RENDERED PRIMITIVES"));
    expect(blockStart).toBeGreaterThan(-1);
    expect(blockEnd).toBeGreaterThan(blockStart);
    const casts = lines
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.includes("as Rendered"))
      .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/u.test(line));
    expect(casts.length, "the casts must exist to be confined").toBeGreaterThan(2);
    for (const { line, i } of casts) {
      expect(
        i > blockStart && i < blockEnd,
        `an \`as Rendered\` cast outside the primitives block, line ${i + 1}: ${line.trim()}`,
      ).toBe(true);
    }
  });

  it("`own()` is only ever called with a string literal", () => {
    // `own` is the one way text reaches the document without going through
    // `safe`. A call carrying an interpolation would launder a record value
    // straight past the chokepoint, and the brand cannot catch that on its own.
    const calls = [...SOURCE.matchAll(/\bown\(([^)]*)/gu)].map((match) => match[1] ?? "");
    expect(calls.length, "own() must be in use for this to mean anything").toBeGreaterThan(10);
    for (const argument of calls) {
      const literal = argument.trim();
      if (literal === "" || literal.startsWith("literal")) continue; // the declaration itself
      expect(literal.startsWith('"'), `own(${literal}) is not a string literal`).toBe(true);
      expect(literal.includes("${"), `own(${literal}) interpolates`).toBe(false);
    }
  });

  it("and the renderer still emits its own structure, so the rule is not vacuous", () => {
    // Without this, a file with no `own()` calls and no casts would pass both
    // assertions above by rendering nothing at all.
    expect(SOURCE).toContain('own("\\n## Recommendation\\n")');
  });
});

describe("REP-01 sweep: no field reaches the document able to forge structure", () => {
  const claim = validClaimRecord();
  const hypothesis = validHypothesisClaim();
  const supported = boundAssessment(validSupportedAssessment(), claim.claimId, digestOf(claim));
  const input = {
    report: reportFor([
      { claimRef: claim.claimId, claimDigest: digestOf(claim), assessmentRef: supported.assessmentId },
      { claimRef: hypothesis.claimId, claimDigest: digestOf(hypothesis), assessmentRef: null },
    ]),
    claims: [claim, hypothesis],
    assessments: [supported],
    proposal: validDecisionProposal(),
    delivered: validDeliveredSources(),
  };
  const clean = renderMarkdownReport(input);

  it("THE REVIEWER'S REPRO: a model-authored job-shape ref cannot open a second section", () => {
    // `proposedJobShapeRef` is written by the MODEL and validated only by
    // isRefText -> isNonBlankText -> trim().length > 0, which permits newlines
    // and `#`. Before the repair this rendered two `## Recommendation` headings
    // and a `Status: verified` line, from records carrying no assessments.
    const base = validDecisionProposal();
    const markdown = renderMarkdownReport({
      ...input,
      assessments: [],
      report: reportFor([
        { claimRef: claim.claimId, claimDigest: digestOf(claim), assessmentRef: null },
      ]),
      proposal: { ...base, payload: { ...base.payload, proposedJobShapeRef: FORGERY } },
      delivered: validDeliveredSources(),
    });
    expect(markdown.match(/^## Recommendation$/gmu)).toHaveLength(1);
    expect(markdown.match(/^Status: /gmu)).toHaveLength(1);
    expect(markdown).toContain("Status: PARTIAL");
    // No claim in these records carries any assessment, so no line the renderer
    // controls may present one.
    expect(markdown.match(/^Status: verified/gmu)).toBeNull();
  });

  it("and neither can a ledger reference or a repository id", () => {
    const base = input.report;
    for (const report of [
      { ...base, cost: { ...base.cost, ledgerRef: FORGERY } },
      {
        ...base,
        scope: {
          ...base.scope,
          revisions: [{ repositoryId: FORGERY, revision: base.scope.revisions[0]?.revision ?? "" }],
        },
      },
    ]) {
      const markdown = renderMarkdownReport({ ...input, report });
      assertStructureHeld(markdown, clean);
    }
  });

  it("SWEEP: every string field in the whole input, one at a time", () => {
    // The population, not three names. A field added later is covered the day
    // it exists, because this enumerates the DATA rather than the code.
    const leaves = stringLeaves(input);
    expect(leaves.length, "the sweep must reach a real population").toBeGreaterThan(60);
    const exercised: string[] = [];
    for (const leaf of leaves) {
      const mutated = leaf.withValue(FORGERY);
      let markdown: string;
      try {
        markdown = renderMarkdownReport(mutated);
      } catch {
        // The value is one this field's validator refuses (a digest, a
        // timestamp, an enum member). Refusal is the stronger answer, so the
        // leaf is not a rendering concern — but it is not coverage either.
        continue;
      }
      exercised.push(leaf.pointer);
      assertStructureHeld(markdown, clean);
    }
    // A sweep that skipped everything would pass silently. These three are the
    // fields the reviewer found unguarded; they must be among the ones actually
    // rendered with hostile content, or this test has stopped covering them.
    expect(exercised).toContain("/proposal/payload/proposedJobShapeRef");
    expect(exercised).toContain("/report/cost/ledgerRef");
    expect(exercised).toContain("/report/scope/revisions/0/repositoryId");
    expect(exercised.length, "too few fields actually reached the renderer").toBeGreaterThan(25);
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
      delivered: validDeliveredSources(),
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
    const whole = {
      report,
      claims: [],
      assessments: [],
      proposal: null,
      delivered: validDeliveredSources(),
    };
    for (const key of ["report", "claims", "assessments", "proposal", "delivered"] as const) {
      const { [key]: _dropped, ...without } = whole;
      expect(() => renderMarkdownReport(without), key).toThrow(
        new RegExp(`${key} is required`, "u"),
      );
    }
    expect(() => renderMarkdownReport({ ...whole, claims: 7 })).toThrow(/claims is an array/u);
    // POSITIVE CONTROL: the same call with every key present renders.
    expect(renderMarkdownReport(whole)).toContain("## Recommendation");
  });

  it("an invalid record throws rather than being rendered", () => {
    expect(() =>
      renderMarkdownReport({
        report: { ...validResearchReport(), reportCompleteness: "GREAT" },
        claims: [],
        assessments: [],
        proposal: null,
      delivered: validDeliveredSources(),
      }),
    ).toThrow(/unknown_report_completeness/u);
    expect(() => renderMarkdownReport(7)).toThrow();
    // A claim that does not validate cannot reach the document either.
    expect(() =>
      renderMarkdownReport({
        report: reportFor([{ claimRef: "oracle-claim-1", claimDigest: digest, assessmentRef: null }]),
        claims: [{ ...validClaimRecord(), claimType: "OBSERVED", sourceSpans: [] }],
        assessments: [],
        proposal: null,
      delivered: validDeliveredSources(),
      }),
    ).toThrow(/observation_without_source_span/u);
  });
});
