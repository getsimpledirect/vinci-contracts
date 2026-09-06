import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contextManifestDigest, validateContextManifest } from "@getsimpledirect/vinci-run";
import {
  admitResearchRequest,
  claimRecordDigest,
  deliveredHandle,
  mapProposalToJobShape,
  resolveCitations,
  resolveContextBinding,
  resolveIdempotency,
  resolveOutcomeCredits,
  resolveReportBundle,
  validateClaimAssessment,
  validateClaimRecord,
  validateOutcomeRecord,
  validateResearchReport,
  validateSourceRecord,
} from "./index.ts";
import {
  validClaimRecord,
  validContextBinding,
  validDecisionProposal,
  validDeliveredSources,
  validHypothesisClaim,
  validReportBoundAssessment,
  validOutcomeRecord,
  validResearchReport,
  validResearchRequest,
  validSourceCitation,
  validSourceRecord,
  validSupportedAssessment,
} from "./fixtures.test-helpers.ts";

/**
 * THE POPULATION: every cross-record rule in this package, and what anchors it.
 *
 * Two reviews found the same defect class in two different places — a rule that
 * compares one record's assertion to another record's assertion and calls the
 * agreement evidence. Both times the fix was local and the class stayed open.
 * This file is the sweep: it enumerates EVERY place in the package where one
 * record's field is compared to another's, or a set is checked for internal
 * agreement, names the anchor each one uses, and tests it with a CONSISTENT LIE
 * — every copy made to agree — rather than a single-copy mutation. A
 * single-copy mutation is what both defeated rules already passed.
 *
 * The three anchors available, and the only three:
 *
 *   (a) RECOMPUTATION — derive the value from the referenced record's own bytes.
 *   (b) A SECOND ARGUMENT the caller supplies from host state.
 *   (c) THE ENVELOPE SPLIT — host-attested half against model-authored half.
 *
 * Rules that have NO anchor are listed too, as LIMITS, with a test showing the
 * lie succeeds. A limit nobody wrote down is the thing a fourth review finds.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

const sourceFiles = (): string[] =>
  readdirSync(SRC).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".test-helpers.ts"),
  );

/** The enumeration. Every row is exercised below; the table is what makes it a sweep. */
const CROSS_RECORD_RULES = [
  { rule: "resolveContextBinding: binding -> manifest", anchor: "(a) recomputation" },
  { rule: "resolveIdempotency: prior identity -> request", anchor: "(a) recomputation" },
  { rule: "resolveReportBundle: report entry -> claim", anchor: "(a) recomputation" },
  { rule: "resolveReportBundle: assessment -> claim", anchor: "(a) recomputation" },
  { rule: "resolveReportBundle: assessment -> report", anchor: "(a) recomputation" },
  { rule: "resolveCitations: citation -> delivered source", anchor: "(b) second argument" },
  { rule: "resolveReportBundle: claim span -> delivered source", anchor: "(b) second argument" },
  // The local helper inside resolveReportBundle that does it. Named because the
  // scan finds definitions, not exports — a cross-record rule hidden in a
  // non-exported helper is exactly one of the shapes a review smuggled past the
  // old scan.
  { rule: "resolveSpanIds: span id -> delivered source", anchor: "(b) second argument" },
  { rule: "resolveOutcomeCredits: outcome -> authorized work", anchor: "(b) second argument" },
  { rule: "mapProposalToJobShape: proposal -> job-shape allowlist", anchor: "(b) second argument" },
  { rule: "validateDecisionProposal: payload basis -> host reportRef", anchor: "(c) envelope split" },
  { rule: "validateResearchReport: coverage -> claim entries", anchor: "internal, identity-keyed" },
  { rule: "validateResearchReport: manifest sourceId uniqueness", anchor: "internal, identity-keyed" },
  { rule: "validateOracleContextBinding: revision vector + window", anchor: "internal, identity-keyed" },
  {
    rule: "resolveOutcomeCredits: reuse -> original outcome",
    // TRANSITIVELY anchored, and the reasoning was written nowhere: a reuse
    // must name an outcome that itself holds an ACCEPTED_WORK credit, and that
    // credit was only granted after its work ref was found in the
    // host-authorized set. So the reuse rests on anchor (b) one hop away.
    anchor: "(b) second argument, transitively via the original's credit",
  },
  { rule: "validateOutcomeRecord: assessing -> authoring identity", anchor: "NONE (limit)" },
  { rule: "resolveReportBundle: claim scope -> report scope", anchor: "NONE (limit)" },
  { rule: "resolveReportBundle: proposal <-> report", anchor: "NONE (limit)" },
  { rule: "validateClaimAssessment: claimDigest assertion", anchor: "NONE (limit)" },
] as const;

/**
 * Resolver-shaped DEFINITIONS in a source file.
 *
 * Extracted and exported to the test below because the previous version was a
 * canary wearing a sweep's title. It required `(` immediately after the name,
 * so `export function resolveGeneric<T>(a, b)` defeated it, as did
 * `export async function`, a non-exported helper, an arrow const and a class
 * method — a review smuggled a cross-record rule past it in five shapes. Four
 * of the table's own rows are `validate*` functions it structurally cannot
 * reach, which is the clearest evidence that this scan is ONE instrument and
 * not the sweep.
 */
export function resolverNamesIn(source: string): string[] {
  const names = new Set<string>();
  const NAME = "(?:resolve|mapProposal)[A-Za-z0-9_]*";
  const patterns = [
    // function declarations: exported or not, async or not, generic or not
    new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+(${NAME})\\s*[<(]`, "gu"),
    // const/let arrow or function expressions, with or without a type annotation
    // The right-hand side must START a function: `const resolved = ...` is a
    // local variable, not a resolver, and matching it made the scan report a
    // name no table could ever carry.
    new RegExp(
      `(?:export\\s+)?(?:const|let|var)\\s+(${NAME})\\s*(?::[^=;]+)?=\\s*(?:async\\s+)?(?:function\\b|<|\\()`,
      "gu",
    ),
    // object literal or class methods
    new RegExp(`^\\s+(?:public\\s+|private\\s+|static\\s+|async\\s+)*(${NAME})\\s*[<(]`, "gmu"),
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined && name !== "") names.add(name);
    }
  }
  return [...names].sort();
}

describe("the resolver scan is an instrument, and the instrument is checked", () => {
  it("finds a cross-record rule smuggled in every shape a review got past the old one", () => {
    // The five shapes, verbatim as cases. A scan that stops finding one of
    // these fails here rather than reporting a clean package.
    const smuggled = [
      "export function resolveGeneric<T>(a: T, b: T) { return a === b; }",
      "export async function resolveLater(a: unknown, b: unknown) { return a === b; }",
      "function resolveHelper(a: unknown, b: unknown) { return a === b; }",
      "const resolveArrow = (a: unknown, b: unknown) => a === b;",
      "export const resolveTyped: Guard = async (a, b) => a === b;",
      "class Binder {\n  resolveMethod(a: unknown, b: unknown) { return a === b; }\n}",
    ];
    const expected = [
      "resolveGeneric",
      "resolveLater",
      "resolveHelper",
      "resolveArrow",
      "resolveTyped",
      "resolveMethod",
    ];
    smuggled.forEach((source, i) => {
      expect(resolverNamesIn(source), source).toContain(expected[i]);
    });
  });

  it("NON-VACUITY CONTROL: it does not find a name that is not there", () => {
    // Without this a scan returning every identifier would pass the test above.
    expect(resolverNamesIn("const somethingElse = (a) => a;")).toEqual([]);
    expect(resolverNamesIn("// resolveInAComment(a, b)\nconst x = 1;")).toEqual([]);
  });

  it("every resolver-shaped definition in src/ is a row in the table", () => {
    // WHAT THIS DOES NOT DO, since the title used to overclaim: it finds
    // resolver-shaped DEFINITIONS. A cross-record comparison written inside a
    // `validate*` function is invisible to it — four table rows are exactly
    // that — which is why the FIELD scan below exists as the second instrument.
    const found = new Set<string>();
    for (const file of sourceFiles()) {
      for (const name of resolverNamesIn(readFileSync(join(SRC, file), "utf8"))) found.add(name);
    }
    const named = CROSS_RECORD_RULES.map((row) => row.rule.split(":")[0] ?? "");
    for (const resolver of found) {
      expect(named, `${resolver} is not named in CROSS_RECORD_RULES`).toContain(resolver);
    }
    expect(found.size).toBeGreaterThanOrEqual(5);
  });

  it("names an anchor for every row, and marks the ones that have none", () => {
    for (const row of CROSS_RECORD_RULES) {
      expect(row.anchor, row.rule).not.toBe("");
    }
    expect(CROSS_RECORD_RULES.filter((r) => r.anchor === "NONE (limit)")).toHaveLength(4);
  });
});

/**
 * THE SECOND INSTRUMENT: every field that REFERENCES another record.
 *
 * The resolver scan cannot see a comparison inside a validator, and the table
 * is hand-maintained — so a whole cross-record ASSERTION can exist with no rule
 * and no row, which is what happened. `ClaimAssessment.reportDigest` was
 * documented as "the report this assessment was issued against", shape-checked,
 * never recomputed, and absent from the table and from the limits alike. A
 * third review found it one field over from the defect the second review found.
 *
 * So the fields are enumerated mechanically and each must be accounted for.
 * Adding a `*Ref` or `*Digest` field to a record now fails this test until
 * somebody writes down how it is anchored — which is the moment to think about
 * it, rather than the moment a reviewer does.
 */
const CROSS_RECORD_FIELDS: Readonly<Record<string, string>> = {
  // Recomputed against the referenced record's own bytes.
  "ClaimAssessment.claimDigest": "(a) recomputed in resolveReportBundle",
  "ClaimAssessment.reportDigest": "(a) recomputed in resolveReportBundle",
  "ReportClaimEntry.claimDigest": "(a) recomputed in resolveReportBundle",
  "ClaimRecord.contextManifestDigest": "(a) compared to the report's in resolveReportBundle",
  "ResearchReport.contextManifestDigest": "the reference point for a claim's context",
  "OutcomeRecord.proposalDigest": "binds the outcome to the exact proposal; identity, not a lookup",
  // Resolved against a set the caller supplies.
  "OutcomeRecord.authorizedWorkRef": "(b) resolved against `authorizedWork` in resolveOutcomeCredits",
  "OutcomeRecord.executionEvidenceRefs": "(b) the second dedup dimension; required for an accepted credit",
  "AuthorizedWork.workRef": "the anchor ITSELF: host state, not a record field",
  "AuthorizedWork.runRef": "the anchor's scope; compared to the outcome's run",
  "AuthorizedWork.workspaceRef": "the anchor's scope; compared to the outcome's workspace",
  "OutcomeEvidence.workRef": "names the work the follow-through was observed on; not resolved here",
  "OutcomeEvidence.comparisonRef": "external counterfactual; nothing in this package resolves it",
  // Scoping identifiers: compared to the report's, which is a declared LIMIT.
  "ClaimRecord.runRef": "scope check against the report (LIMIT: both are in the document)",
  "ClaimRecord.workspaceRef": "scope check against the report (LIMIT: both are in the document)",
  "ClaimRecord.requestRef": "provenance only; nothing resolves it",
  "ReportClaimEntry.claimRef": "the entry's own key; deduped by identity",
  "ReportClaimEntry.assessmentRef": "looked up in the supplied assessment set",
  "ResearchReport.proposalRef": "mutual reference with the proposal (LIMIT: both forgeable together)",
  "ResearchReport.requestRef": "provenance only; nothing resolves it",
  "ResearchReport.runRef": "the reference point for a claim's run",
  "ResearchReport.workspaceRef": "the reference point for a claim's workspace",
  "ReportSourceEntry.citationRefs": "names citations resolveCitations answers for",
  "ReportCost.ledgerRef": "external ledger; nothing in this package resolves it",
  "OutcomeRecord.proposalRef": "names the proposal; the DIGEST is what binds",
  "OutcomeRecord.reportRef": "provenance only; nothing resolves it",
  "OutcomeRecord.runRef": "provenance only; nothing resolves it",
  "OutcomeRecord.workspaceRef": "provenance only; nothing resolves it",
  "OutcomeRecord.duplicateOfOutcomeRef": "resolved within the supplied outcome set",
  "OutcomeRecord.rubricRef": "external rubric; nothing in this package resolves it",
  "ClaimDerivation.analysisRef": "external analysis; nothing resolves it",
};

describe("every cross-record FIELD is accounted for", () => {
  it("each *Ref/*Digest field on a record type has a written treatment", () => {
    const files = ["claim.ts", "claim-assessment.ts", "research-report.ts", "outcome-record.ts"];
    const unaccounted: string[] = [];
    let scanned = 0;
    for (const file of files) {
      const text = readFileSync(join(SRC, file), "utf8");
      // `export type X = {` ... `}` blocks, and the fields inside them.
      for (const block of text.matchAll(/export type (\w+) = \{([\s\S]*?)\n\};/gu)) {
        const typeName = block[1] ?? "";
        for (const field of (block[2] ?? "").matchAll(/readonly (\w*(?:Ref|Refs|Digest))\??:/gu)) {
          scanned += 1;
          const key = `${typeName}.${field[1] ?? ""}`;
          if (!Object.hasOwn(CROSS_RECORD_FIELDS, key)) unaccounted.push(key);
        }
      }
    }
    // A floor, so a regex that stopped matching cannot report a clean package.
    expect(scanned, "the field scan must reach a real population").toBeGreaterThan(20);
    expect(unaccounted).toEqual([]);
  });

  it("NON-VACUITY CONTROL: the table does not carry entries for fields that vanished", () => {
    // The other direction. A stale entry is how a table stops describing the
    // code without anyone noticing — the same failure as a stale comment.
    const text = ["claim.ts", "claim-assessment.ts", "research-report.ts", "outcome-record.ts"]
      .map((f) => readFileSync(join(SRC, f), "utf8"))
      .join("\n");
    for (const key of Object.keys(CROSS_RECORD_FIELDS)) {
      const field = key.split(".")[1] ?? "";
      expect(text, `${key} is in the table but not in the source`).toContain(`readonly ${field}`);
    }
  });
});

describe("(a) RECOMPUTATION: the anchor is the referenced record's own bytes", () => {
  it("resolveContextBinding refuses a binding and a manifest that agree on a false digest", () => {
    const manifest = JSON.parse(
      readFileSync(join(SRC, "..", "vectors", "bound-context-manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    // THE CONSISTENT LIE: the binding says digest X. Nothing in the manifest
    // contradicts it — a manifest does not carry its own digest — so the only
    // way to catch it is to compute the manifest's digest, which is what this
    // function does.
    const lying = { ...validContextBinding(), contextManifestDigest: "0".repeat(64) };
    const result = resolveContextBinding(lying, manifest);
    expect(result.outcome).toBe("MANIFEST_MISMATCH");
    // POSITIVE CONTROL on the same manifest.
    const parsed = validateContextManifest(manifest);
    if (!parsed.ok) throw new Error("fixture manifest must validate");
    expect(
      resolveContextBinding(
        { ...validContextBinding(), contextManifestDigest: contextManifestDigest(parsed.value) },
        manifest,
      ).outcome,
    ).toBe("BOUND");
  });

  it("resolveIdempotency refuses a stored identity whose digest is not the request's", () => {
    const request = validResearchRequest();
    const admitted = admitResearchRequest(request);
    if (admitted.outcome !== "ADMITTED") throw new Error("fixture must be admissible");
    // THE CONSISTENT LIE: the prior identity is internally coherent — key, id
    // and digest all present and well-formed — and its digest is simply not the
    // one this request's bytes produce.
    const lying = {
      schemaVersion: 1 as const,
      idempotencyKey: request.hostResolved.lineage.idempotencyKey,
      requestId: request.hostResolved.requestId,
      requestDigest: "0".repeat(64),
    };
    expect(resolveIdempotency(lying, request).outcome).toBe("KEY_CONFLICT");
    // POSITIVE CONTROL.
    expect(
      resolveIdempotency({ ...lying, requestDigest: admitted.requestDigest }, request).outcome,
    ).toBe("SAME_REQUEST");
  });

  it("resolveReportBundle refuses a report and an assessment that agree on a false claim digest", () => {
    // The F1 lie, at the bundle rather than through the renderer.
    const claim = validClaimRecord();
    const FABRICATED = "5e".repeat(32);
    const bundle = {
      report: {
        ...validResearchReport(),
        claims: [
          { claimRef: claim.claimId, claimDigest: FABRICATED, assessmentRef: "oracle-assessment-1" },
        ],
        assessmentCoverage: { claimsTotal: 1, claimsWithStoredAssessment: 1, claimsNotAssessed: 0 },
      },
      claims: [claim],
      assessments: [{ ...validSupportedAssessment(), claimDigest: FABRICATED }],
      proposal: null,
      delivered: validDeliveredSources(),
    };
    const result = resolveReportBundle(bundle);
    expect(result.outcome).toBe("RESOLVED");
    if (result.outcome !== "RESOLVED") return;
    expect(result.claims[0]?.state).toBe("CLAIM_DIGEST_MISMATCH");
    expect(result.claims[0]?.assessment).toBeUndefined();

    // POSITIVE CONTROL: the identical bundle with the computed digest binds.
    const real = claimRecordDigest(claim);
    const honest = {
      ...bundle,
      report: { ...bundle.report, claims: [{ ...bundle.report.claims[0], claimDigest: real }] },
      assessments: [{ ...validSupportedAssessment(), claimDigest: real }],
    };
    const bound = resolveReportBundle(honest);
    expect(bound.outcome).toBe("RESOLVED");
    if (bound.outcome !== "RESOLVED") return;
    expect(bound.claims[0]?.state).toBe("BOUND");
    expect(bound.claims[0]?.assessment?.status).toBe("SUPPORTED");
  });
});

describe("E2: the OTHER digest an assessment asserts", () => {
  const claim = validClaimRecord();
  const reportFor = (assessmentId: string) => ({
    ...validResearchReport(),
    claims: [{ claimRef: claim.claimId, claimDigest: claimRecordDigest(claim), assessmentRef: assessmentId }],
    assessmentCoverage: { claimsTotal: 1, claimsWithStoredAssessment: 1, claimsNotAssessed: 0 },
  });
  const bundleWith = (assessment: unknown) =>
    resolveReportBundle({
      report: reportFor("oracle-assessment-1"),
      claims: [claim],
      assessments: [assessment],
      proposal: null,
      delivered: validDeliveredSources(),
    });

  it("a fabricated reportDigest does not bind", () => {
    // Shape-checked and never recomputed, in the module whose subject is
    // recomputing the digest beside it, with the report and
    // `researchReportDigest` both in scope. Every fixture pinned it null, so no
    // test exercised a non-null value at all.
    const result = bundleWith({ ...validSupportedAssessment(), reportDigest: "aa".repeat(32) });
    expect(result.outcome).toBe("RESOLVED");
    if (result.outcome !== "RESOLVED") return;
    expect(result.claims[0]?.state).toBe("ASSESSMENT_BINDS_ANOTHER_REPORT");
    expect(result.claims[0]?.assessment).toBeUndefined();
  });

  it("POSITIVE REACHABILITY CONTROL: the computed reportDigest binds", () => {
    // Against the report the fixture's digest was computed FROM. That coupling
    // is the point: a report-bound assessment binds to one report and to no
    // other, which is what the negative above shows from the other side.
    const result = resolveReportBundle({
      report: validResearchReport(),
      claims: [validClaimRecord(), validHypothesisClaim()],
      assessments: [validReportBoundAssessment()],
      proposal: null,
      delivered: validDeliveredSources(),
    });
    expect(result.outcome).toBe("RESOLVED");
    if (result.outcome !== "RESOLVED") return;
    expect(result.claims[0]?.state).toBe("BOUND");
    expect(result.claims[0]?.assessment?.status).toBe("SUPPORTED");
  });

  it("a report-bound assessment does NOT bind to a different report", () => {
    // The same record, the same computed digest, a report with one claim
    // instead of two. Nothing about the assessment changed; the report did.
    const result = bundleWith(validReportBoundAssessment());
    expect(result.outcome).toBe("RESOLVED");
    if (result.outcome !== "RESOLVED") return;
    expect(result.claims[0]?.state).toBe("ASSESSMENT_BINDS_ANOTHER_REPORT");
  });

  it("and null still binds: standing alone is a different claim from naming a report", () => {
    // CON-02. Null says this assessment was not issued against a report; a
    // WRONG digest says it was issued against another one. Refusing both would
    // make the field unwritable.
    const result = bundleWith(validSupportedAssessment());
    expect(result.outcome).toBe("RESOLVED");
    if (result.outcome !== "RESOLVED") return;
    expect(result.claims[0]?.state).toBe("BOUND");
  });
});

describe("(b) A SECOND ARGUMENT: the anchor is host state the records cannot write", () => {
  it("resolveCitations refuses a citation whose source id nothing delivered", () => {
    const citation = validSourceCitation();
    const parsed = validateSourceRecord(validSourceRecord());
    if (!parsed.ok) throw new Error("fixture must validate");
    // THE CONSISTENT LIE: the citation is a perfectly formed, internally
    // coherent envelope naming a source id that was never handed to this run.
    const lying = {
      ...citation,
      payload: { ...citation.payload, sourceId: "oracle-source-invented" },
    };
    expect(resolveCitations([lying], [deliveredHandle(parsed.value)]).outcome).toBe("UNRESOLVED");
    // POSITIVE CONTROL.
    expect(resolveCitations([citation], [deliveredHandle(parsed.value)]).outcome).toBe("RESOLVED");
  });

  it("resolveReportBundle refuses a claim span whose source id nothing delivered", () => {
    const citing = {
      ...validClaimRecord(),
      sourceSpans: [{ sourceId: "oracle-source-invented", span: null }],
    };
    const result = resolveReportBundle({
      report: {
        ...validResearchReport(),
        claims: [
          { claimRef: citing.claimId, claimDigest: claimRecordDigest(citing), assessmentRef: null },
        ],
        assessmentCoverage: { claimsTotal: 1, claimsWithStoredAssessment: 0, claimsNotAssessed: 1 },
      },
      claims: [citing],
      assessments: [],
      proposal: null,
      delivered: validDeliveredSources(),
    });
    expect(result.outcome).toBe("RESOLVED");
    if (result.outcome !== "RESOLVED") return;
    expect(result.claims[0]?.unresolvedSourceIds).toEqual(["oracle-source-invented"]);
    expect(result.issues.map((i) => i.code)).toContain("undelivered_source_id");
  });

  it("resolveOutcomeCredits refuses a work ref no host authorized", () => {
    const AUTHORIZED = [
      {
        workRef: "wo-installed-reader-probe",
        runRef: "run-oracle-1",
        workspaceRef: "ws-institutional-1",
      },
    ];
    // THE CONSISTENT LIE: a well-formed outcome naming a work order that does
    // not exist. Nothing inside the record contradicts it.
    const lying = { ...validOutcomeRecord(), authorizedWorkRef: "wo-i-made-this-up" };
    expect(resolveOutcomeCredits([lying], AUTHORIZED).outcome).toBe("UNAUTHORIZED_WORK");
    // POSITIVE CONTROL.
    expect(resolveOutcomeCredits([validOutcomeRecord()], AUTHORIZED).outcome).toBe("CREDITED");
  });

  it("mapProposalToJobShape refuses a kind the allowlist does not carry", () => {
    const ALLOWLIST = [
      { kind: "REQUEST_OBSERVATION", jobShapeRef: "job-shape-installed-reader-probe" },
    ];
    const base = validDecisionProposal();
    const lying = {
      ...base,
      payload: { ...base.payload, kind: "IMPLEMENTATION_PROPOSAL" as const },
    };
    expect(mapProposalToJobShape(lying, ALLOWLIST).outcome).toBe("UNMAPPED");
    expect(mapProposalToJobShape(base, ALLOWLIST).outcome).toBe("MAPPED");
  });
});

describe("(c) THE ENVELOPE SPLIT: the anchor is the host half of one record", () => {
  it("a proposal whose model-authored basis names another report is refused", () => {
    const base = validDecisionProposal();
    const lying = {
      ...base,
      payload: { ...base.payload, basis: { ...base.payload.basis, reportRef: "oracle-report-9" } },
    };
    const result = mapProposalToJobShape(lying, [
      { kind: "REQUEST_OBSERVATION", jobShapeRef: "job-shape-installed-reader-probe" },
    ]);
    expect(result.outcome).toBe("REFUSED");
    if (result.outcome !== "REFUSED") return;
    expect(result.issues.map((i) => i.code)).toContain("basis_report_mismatch");
  });
});

describe("LIMITS: rules with no anchor, demonstrated rather than described", () => {
  /**
   * Every test here shows a consistent lie SUCCEEDING. That is the point. A
   * limit stated in a comment is a limit a reader has to take on trust; a limit
   * with a passing test that shows the hole is one nobody can misread, and it
   * fails the day somebody closes it — which is the right time to revisit the
   * comment.
   */

  it("LIMIT: a report and its claims can agree on a run neither belongs to", () => {
    // The bundle checks the claim's run against the REPORT's run, and both are
    // records in the same document. Move both and the check agrees. Closing
    // this needs the caller's own run identity as a second argument, which this
    // package does not take today.
    const claim = { ...validClaimRecord(), runRef: "run-somebody-else" };
    const result = resolveReportBundle({
      report: {
        ...validResearchReport(),
        runRef: "run-somebody-else",
        claims: [
          { claimRef: claim.claimId, claimDigest: claimRecordDigest(claim), assessmentRef: null },
        ],
        assessmentCoverage: { claimsTotal: 1, claimsWithStoredAssessment: 0, claimsNotAssessed: 1 },
      },
      claims: [claim],
      assessments: [],
      proposal: null,
      // The delivered set IS anchored, so the source ids still fail to resolve —
      // which is the one part of this document that is checked from outside it.
      delivered: validDeliveredSources(),
    });
    expect(result.outcome).toBe("RESOLVED");
    if (result.outcome !== "RESOLVED") return;
    expect(result.claims[0]?.state).not.toBe("CLAIM_OUTSIDE_REPORT_SCOPE");
    expect(result.issues.map((i) => i.code)).toContain("foreign_run_source");
  });

  it("LIMIT: a proposal and a report can name each other while both are forged", () => {
    // The mutual reference detects a MISMATCH, not a forgery. Two records
    // written together agree by construction.
    const base = validDecisionProposal();
    const result = resolveReportBundle({
      report: { ...validResearchReport(), reportId: "oracle-report-invented", proposalRef: "oracle-proposal-1" },
      claims: [validClaimRecord(), validHypothesisClaim()],
      assessments: [validSupportedAssessment()],
      // The lie has to be consistent in the proposal too: the envelope split
      // (c) catches a payload basis that disagrees with the host half, so a
      // forger updates both. That is exactly what makes this a LIMIT of the
      // mutual reference and not of the envelope.
      proposal: {
        ...base,
        hostResolved: { ...base.hostResolved, reportRef: "oracle-report-invented" },
        payload: { ...base.payload, basis: { ...base.payload.basis, reportRef: "oracle-report-invented" } },
      },
      delivered: validDeliveredSources(),
    });
    expect(result.outcome).toBe("RESOLVED");
    if (result.outcome !== "RESOLVED") return;
    expect(result.issues.map((i) => i.code)).not.toContain("proposal_not_named_by_report");
    expect(result.issues.map((i) => i.code)).not.toContain("proposal_bound_to_another_report");
  });

  it("LIMIT: one party can write both identities on an outcome under two names", () => {
    // Demonstrated AT THE VALIDATOR, which is where the rule lives. The
    // previous version of this test went through `resolveOutcomeCredits` — an
    // entry point the table row does not name — so it demonstrated the limit
    // through the wrong door.
    const base = validOutcomeRecord();
    const lying = {
      ...base,
      assessingIdentity: {
        kind: "verifier" as const,
        verifierId: "the-author-in-a-hat",
        independent: true,
      },
    };
    // The lie SUCCEEDS: OUT-02 compares two fields of one record, and one party
    // writing both sides simply picks two identifiers.
    expect(validateOutcomeRecord(lying).ok).toBe(true);
    // NON-VACUITY: the rule is not dead — the SAME record with the identities
    // literally equal is refused, which is all the comparison can see.
    const caught = validateOutcomeRecord({ ...base, assessingIdentity: base.authoringIdentity });
    expect(caught.ok).toBe(false);
    if (caught.ok) return;
    expect(caught.issues.map((i) => i.code)).toEqual(["self_certified_usefulness"]);
  });

  it("LIMIT: a claim assessment's claimDigest is an assertion its own validator cannot check", () => {
    // Demonstrated AT `validateClaimAssessment`, which is the row's subject.
    // The previous version called `resolveReportBundle`, asserted the lie was
    // CAUGHT, and returned true — which the test read as "the lie succeeded".
    // It demonstrated the opposite of its own claim.
    const lying = { ...validSupportedAssessment(), claimDigest: "0".repeat(64) };
    // The lie SUCCEEDS at the validator: one record is in front of it and the
    // claim that digest is about is not.
    expect(validateClaimAssessment(lying).ok).toBe(true);
    // And is CAUGHT at the bundle, which is where the anchor lives. Both halves
    // stated, because "the validator cannot check it" is only reassuring
    // alongside "something else does".
    const claim = validClaimRecord();
    const bundle = resolveReportBundle({
      report: {
        ...validResearchReport(),
        claims: [
          {
            claimRef: claim.claimId,
            claimDigest: claimRecordDigest(claim),
            assessmentRef: lying.assessmentId,
          },
        ],
        assessmentCoverage: { claimsTotal: 1, claimsWithStoredAssessment: 1, claimsNotAssessed: 0 },
      },
      claims: [claim],
      assessments: [lying],
      proposal: null,
      delivered: validDeliveredSources(),
    });
    expect(bundle.outcome).toBe("RESOLVED");
    if (bundle.outcome !== "RESOLVED") return;
    expect(bundle.claims[0]?.state).toBe("ASSESSMENT_BINDS_ANOTHER_CLAIM");
  });
});

describe("the validators still admit what they should", () => {
  it("POSITIVE CONTROL for the whole sweep: every fixture record validates", () => {
    // Without this, a package that refused everything would satisfy every
    // negative above.
    expect(validateClaimRecord(validClaimRecord()).ok).toBe(true);
    expect(validateResearchReport(validResearchReport()).ok).toBe(true);
    expect(validateSourceRecord(validSourceRecord()).ok).toBe(true);
  });
});
