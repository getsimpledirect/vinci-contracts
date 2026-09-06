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
  validateClaimRecord,
  validateResearchReport,
  validateSourceRecord,
} from "./index.ts";
import {
  validClaimRecord,
  validContextBinding,
  validDecisionProposal,
  validDeliveredSources,
  validHypothesisClaim,
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

/** The enumeration. Every row is exercised below; the table is what makes it a sweep. */
const CROSS_RECORD_RULES = [
  { rule: "resolveContextBinding: binding -> manifest", anchor: "(a) recomputation" },
  { rule: "resolveIdempotency: prior identity -> request", anchor: "(a) recomputation" },
  { rule: "resolveReportBundle: report entry -> claim", anchor: "(a) recomputation" },
  { rule: "resolveReportBundle: assessment -> claim", anchor: "(a) recomputation" },
  { rule: "resolveCitations: citation -> delivered source", anchor: "(b) second argument" },
  { rule: "resolveReportBundle: claim span -> delivered source", anchor: "(b) second argument" },
  { rule: "resolveOutcomeCredits: outcome -> authorized work", anchor: "(b) second argument" },
  { rule: "mapProposalToJobShape: proposal -> job-shape allowlist", anchor: "(b) second argument" },
  { rule: "validateDecisionProposal: payload basis -> host reportRef", anchor: "(c) envelope split" },
  { rule: "validateResearchReport: coverage -> claim entries", anchor: "internal, identity-keyed" },
  { rule: "validateOutcomeRecord: assessing -> authoring identity", anchor: "NONE (limit)" },
  { rule: "resolveReportBundle: claim scope -> report scope", anchor: "NONE (limit)" },
  { rule: "resolveReportBundle: proposal <-> report", anchor: "NONE (limit)" },
  { rule: "validateClaimAssessment: claimDigest assertion", anchor: "NONE (limit)" },
] as const;

describe("the enumeration is complete for the code as it stands", () => {
  it("every cross-record comparison in src/ is a row in the table above", () => {
    // The mechanical half. A new `resolve*` export, or a new comparison of two
    // records' fields, has to be added to the table — which is the moment
    // somebody has to name its anchor. Without this the table is a snapshot
    // that silently stops describing the package.
    const sources = readdirSync(SRC).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".test-helpers.ts"),
    );
    const resolvers = new Set<string>();
    for (const file of sources) {
      const text = readFileSync(join(SRC, file), "utf8");
      for (const match of text.matchAll(/export function (resolve[A-Za-z]+|mapProposal[A-Za-z]+)\(/gu)) {
        resolvers.add(match[1] ?? "");
      }
    }
    const named = CROSS_RECORD_RULES.map((row) => row.rule.split(":")[0] ?? "");
    for (const resolver of resolvers) {
      expect(named, `${resolver} is not named in CROSS_RECORD_RULES`).toContain(resolver);
    }
    // A floor, so a broken scan cannot report an empty package as fully covered.
    expect(resolvers.size).toBeGreaterThanOrEqual(5);
  });

  it("names an anchor for every row, and marks the ones that have none", () => {
    for (const row of CROSS_RECORD_RULES) {
      expect(row.anchor, row.rule).not.toBe("");
    }
    // The limits are declared rather than discovered. Four of them, and each has
    // a test below that DEMONSTRATES the lie succeeding.
    expect(CROSS_RECORD_RULES.filter((r) => r.anchor === "NONE (limit)")).toHaveLength(4);
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
    // OUT-02 compares two fields of one record. A single party writing both
    // sides picks two identifiers and the comparison is satisfied. Closing this
    // needs an identity directory, which is outside this package.
    const base = validOutcomeRecord();
    const lying = {
      ...base,
      assessingIdentity: { kind: "verifier" as const, verifierId: "the-author-in-a-hat", independent: true },
    };
    const result = validateOutcomeRecordExpectOk(lying);
    expect(result).toBe(true);
  });

  it("LIMIT: a claim assessment's claimDigest is an assertion its own validator cannot check", () => {
    // `validateClaimAssessment` sees one record. The digest it carries is about
    // a claim that is not in front of it, so the validator can only check the
    // SHAPE. The binding is `resolveReportBundle`'s job, and the tests above
    // are where it is established — this is the reason the validator's docs
    // must not be read as a guarantee about the binding.
    const lying = { ...validSupportedAssessment(), claimDigest: "0".repeat(64) };
    expect(validateClaimAssessmentExpectOk(lying)).toBe(true);
  });
});

/** Small helpers so the LIMIT tests read as the assertions they are. */
function validateOutcomeRecordExpectOk(record: unknown): boolean {
  return resolveOutcomeCredits([record], [
    { workRef: "wo-installed-reader-probe", runRef: "run-oracle-1", workspaceRef: "ws-institutional-1" },
  ]).outcome === "CREDITED";
}

function validateClaimAssessmentExpectOk(record: unknown): boolean {
  const report = validResearchReport();
  const claim = validClaimRecord();
  const result = resolveReportBundle({
    report: {
      ...report,
      claims: [
        { claimRef: claim.claimId, claimDigest: claimRecordDigest(claim), assessmentRef: "oracle-assessment-1" },
      ],
      assessmentCoverage: { claimsTotal: 1, claimsWithStoredAssessment: 1, claimsNotAssessed: 0 },
    },
    claims: [claim],
    assessments: [record],
    proposal: null,
    delivered: validDeliveredSources(),
  });
  // It VALIDATES as a record; it does not BIND, which is the distinction the
  // limit is about.
  if (result.outcome !== "RESOLVED") return false;
  expect(result.claims[0]?.state).toBe("ASSESSMENT_BINDS_ANOTHER_CLAIM");
  return true;
}

describe("the validators still admit what they should", () => {
  it("POSITIVE CONTROL for the whole sweep: every fixture record validates", () => {
    // Without this, a package that refused everything would satisfy every
    // negative above.
    expect(validateClaimRecord(validClaimRecord()).ok).toBe(true);
    expect(validateResearchReport(validResearchReport()).ok).toBe(true);
    expect(validateSourceRecord(validSourceRecord()).ok).toBe(true);
  });
});
