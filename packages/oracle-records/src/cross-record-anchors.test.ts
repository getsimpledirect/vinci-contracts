import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contextManifestDigest, validateContextManifest } from "@getsimpledirect/vinci-run";
import {
  admitResearchRequest,
  claimRecordDigest,
  deliveredHandle,
  evidenceIsMissing,
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
 * lie succeeds. A limit nobody wrote down is the thing a fourth review finds —
 * and the fifth limit below was added because OUT-04 had been defeated three
 * times and each repair moved the anchor to a different string the record
 * authors. A fourth anchor would have looked closed until someone probed the
 * new dimension. An honest limit is worth more.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

const sourceFiles = (): string[] =>
  readdirSync(SRC).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".test-helpers.ts"),
  );

/** The enumeration. Every row is exercised below; the table is what makes it a sweep. */
const CROSS_RECORD_RULES = [
  { rule: "resolveContextBinding: binding -> manifest digest", anchor: "(a) recomputation" },
  // Split from the row above, which claimed recomputation for BOTH halves. The
  // digest half recomputes; the run half compared two untrusted inputs to each
  // other and is now anchored on the caller's own run identity. A row asserting
  // an anchor the code does not have is the failure the table exists to
  // prevent, and this was its third instance.
  { rule: "resolveContextBinding: binding + manifest -> caller run", anchor: "(b) second argument" },
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
  { rule: "resolveOutcomeCredits: one execution -> one credit", anchor: "NONE (limit)" },
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
    expect(CROSS_RECORD_RULES.filter((r) => r.anchor === "NONE (limit)")).toHaveLength(5);
  });
});

/**
 * THE SECOND INSTRUMENT: every field that REFERENCES another record.
 *
 * The resolver scan cannot see a comparison inside a validator, and the table
 * is hand-maintained — so a whole cross-record ASSERTION can exist with no rule
 * and no row, which is what happened to `ClaimAssessment.reportDigest`.
 *
 * The FIRST version of this instrument was blind to the very type the defect it
 * was built for lives on. It matched `export type X = {`, and `ClaimAssessment`
 * is an exported UNION whose fields live in a non-exported `AssessmentCommon`,
 * so claim-assessment.ts yielded 0 of its 4 fields while a `scanned > 20` floor
 * read 29 and could not notice. A review added `readonly smuggledOutcomeRef` to
 * `AssessmentCommon` and all 23 tests stayed green. It also scanned 4 of the 8
 * record-bearing files — the same hand-maintained failure mode as the table.
 *
 * So: non-exported and `interface` blocks are matched, all nine source files
 * carrying record types are scanned, and — the part that actually saves it —
 * every type is declared with the number of reference fields it must yield. A
 * total floor cannot see one file drop to zero, which is the lesson the Python
 * counts already taught.
 */

/** file -> type -> how many `*Ref`/`*Refs`/`*Digest` fields that type must yield. */
const REFERENCE_FIELD_COUNTS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  "claim.ts": { ClaimDerivation: 1, ClaimRecord: 4 },
  "claim-assessment.ts": { AssessmentCommon: 3 },
  "research-report.ts": { ReportCost: 1, ReportClaimEntry: 3, ReportSourceEntry: 1, ResearchReport: 5 },
  "outcome-record.ts": { OutcomeEvidence: 2, OutcomeRecord: 9, AuthorizedWork: 3 },
  "source-record.ts": {
    SourceContentBinding: 4,
    SourceRecord: 3,
    DeliveredSourceHandle: 2,
    SourceCitationHost: 1,
  },
  "research-request.ts": {
    ResearchRequestScope: 2,
    ResearchEffort: 1,
    RequestLineage: 1,
    ResearchRequestHost: 2,
    AdmittedRequestIdentity: 1,
  },
  "oracle-context.ts": { OracleContextBinding: 5 },
  "decision-proposal.ts": { MissingDecision: 1, DecisionProposalHost: 1, JobShapeAllowlistEntry: 1 },
  "envelope.ts": { AttestedEnvelope: 7 },
};

/** Matches exported AND non-exported type/interface blocks. */
const TYPE_BLOCK = /(?:export\s+)?(?:type|interface)\s+(\w+)(?:<[^>]*>)?\s*=?\s*\{([\s\S]*?)\n\};?/gu;

function referenceFieldsIn(source: string): Record<string, string[]> {
  const perType: Record<string, string[]> = {};
  for (const block of source.matchAll(TYPE_BLOCK)) {
    const typeName = block[1] ?? "";
    for (const field of (block[2] ?? "").matchAll(/readonly (\w*(?:Refs|Ref|Digest))\??:/gu)) {
      (perType[typeName] ??= []).push(field[1] ?? "");
    }
  }
  return perType;
}

/**
 * How each reference field is anchored.
 *
 * `anchor` is machine-checked where it names a mechanism: a `recomputed` or
 * `resolved` entry must name the module that does it, and the field name must
 * actually appear in that module's source. That is a WEAK link and it is worth
 * having — `reportDigest` claimed to be recomputed in a module whose text did
 * not contain the word, and `executionEvidenceRefs` claimed to be resolved
 * against a caller-supplied set that does not exist. Two entries found wrong by
 * reading is two too many for prose nothing checks.
 */
type FieldTreatment =
  | { readonly anchor: "recomputed"; readonly by: string; readonly note: string }
  | { readonly anchor: "resolved"; readonly by: string; readonly note: string }
  | { readonly anchor: "host-state"; readonly note: string }
  | { readonly anchor: "identity"; readonly note: string }
  | { readonly anchor: "unresolved"; readonly note: string }
  | { readonly anchor: "limit"; readonly note: string };

const CROSS_RECORD_FIELDS: Readonly<Record<string, FieldTreatment>> = {
  // ── recomputed against the referenced record's own bytes ────────────────
  "ClaimAssessment.claimDigest": { anchor: "recomputed", by: "report-binding.ts", note: "against claimRecordDigest" },
  "ClaimAssessment.reportDigest": { anchor: "recomputed", by: "report-binding.ts", note: "against researchReportDigest" },
  "ReportClaimEntry.claimDigest": { anchor: "recomputed", by: "report-binding.ts", note: "against claimRecordDigest" },
  "AdmittedRequestIdentity.requestDigest": { anchor: "recomputed", by: "research-request.ts", note: "against researchRequestDigest" },
  "OracleContextBinding.contextManifestDigest": { anchor: "recomputed", by: "oracle-context.ts", note: "against the manifest's own bytes" },
  // ── resolved against a set the caller supplies ──────────────────────────
  "OutcomeRecord.authorizedWorkRef": { anchor: "resolved", by: "outcome-record.ts", note: "against the authorizedWork argument" },
  "OutcomeRecord.duplicateOfOutcomeRef": { anchor: "resolved", by: "outcome-record.ts", note: "within the supplied outcome set" },
  "ReportClaimEntry.assessmentRef": { anchor: "resolved", by: "report-binding.ts", note: "in the supplied assessment set" },
  "ReportClaimEntry.claimRef": { anchor: "resolved", by: "report-binding.ts", note: "in the supplied claim set, and deduped by identity" },
  "ClaimAssessment.claimRef": { anchor: "resolved", by: "report-binding.ts", note: "compared to the entry against the recomputed digest" },
  "DeliveredSourceHandle.runRef": { anchor: "host-state", note: "the delivered set IS the anchor; host-supplied" },
  "DeliveredSourceHandle.workspaceRef": { anchor: "host-state", note: "the delivered set IS the anchor; host-supplied" },
  "AuthorizedWork.workRef": { anchor: "host-state", note: "the authorized set IS the anchor; host-supplied" },
  "AuthorizedWork.runRef": { anchor: "host-state", note: "the anchor's scope, compared to the outcome's run" },
  "AuthorizedWork.workspaceRef": { anchor: "host-state", note: "the anchor's scope, compared to the outcome's workspace" },
  "JobShapeAllowlistEntry.jobShapeRef": { anchor: "host-state", note: "the allowlist IS the anchor; host-supplied" },
  // ── identity: binds a record to exact bytes, no lookup ──────────────────
  "OutcomeRecord.proposalDigest": { anchor: "identity", note: "binds the outcome to the exact proposal" },
  "SourceContentBinding.rawDigest": { anchor: "identity", note: "identifies the observed bytes (INV-09)" },
  "SourceContentBinding.extractedDigest": { anchor: "identity", note: "identifies the extracted text" },
  "ClaimRecord.contextManifestDigest": { anchor: "limit", note: "compared to the report's; both are in the document" },
  "ResearchReport.contextManifestDigest": { anchor: "limit", note: "the reference point for a claim's context" },
  "AttestedEnvelope.contextManifestDigest": { anchor: "limit", note: "host-resolved; resolveContextBinding checks it where a binding is supplied" },
  // ── scoping identifiers: compared to a sibling record in the document ───
  "ClaimRecord.runRef": { anchor: "limit", note: "scope check against the report; both are in the document" },
  "ClaimRecord.workspaceRef": { anchor: "limit", note: "scope check against the report; both are in the document" },
  "ResearchReport.runRef": { anchor: "limit", note: "the reference point for a claim's run" },
  "ResearchReport.workspaceRef": { anchor: "limit", note: "the reference point for a claim's workspace" },
  "ResearchReport.proposalRef": { anchor: "limit", note: "mutual reference with the proposal; both forgeable together" },
  "DecisionProposalHost.reportRef": { anchor: "limit", note: "mutual reference with the report" },
  "OutcomeRecord.executionEvidenceRefs": {
    anchor: "limit",
    // Was filed as "resolved against a set the caller supplies", which is FALSE:
    // resolveOutcomeCredits takes one caller-supplied set and it is
    // `authorizedWork`. Nothing resolves an evidence ref against host state.
    note: "deduped between records only; DISJOINT descriptions of one run are not caught",
  },
  // ── provenance only: nothing in this package resolves them ──────────────
  "ClaimRecord.requestRef": { anchor: "unresolved", note: "provenance" },
  "ClaimDerivation.analysisRef": { anchor: "unresolved", note: "external analysis" },
  "ReportCost.ledgerRef": { anchor: "unresolved", note: "external ledger" },
  "ReportSourceEntry.citationRefs": {
    anchor: "unresolved",
    // Was "names citations resolveCitations answers for", which is unbacked:
    // nothing links a manifest entry's citationRefs to resolveCitations.
    note: "manifest bookkeeping; nothing in this package resolves these ids",
  },
  "ResearchReport.requestRef": { anchor: "unresolved", note: "provenance" },
  "OutcomeRecord.proposalRef": { anchor: "unresolved", note: "names the proposal; the DIGEST is what binds" },
  "OutcomeRecord.reportRef": { anchor: "unresolved", note: "provenance" },
  "OutcomeRecord.runRef": { anchor: "unresolved", note: "provenance" },
  "OutcomeRecord.workspaceRef": { anchor: "unresolved", note: "provenance" },
  "OutcomeRecord.rubricRef": { anchor: "unresolved", note: "external rubric" },
  "OutcomeEvidence.workRef": { anchor: "unresolved", note: "names the work follow-through was seen on" },
  "OutcomeEvidence.comparisonRef": { anchor: "unresolved", note: "external counterfactual" },
  "SourceRecord.requestRef": { anchor: "unresolved", note: "provenance" },
  "SourceRecord.runRef": { anchor: "unresolved", note: "carried into the delivered handle" },
  "SourceRecord.workspaceRef": { anchor: "unresolved", note: "carried into the delivered handle" },
  "SourceContentBinding.rawArtifactRef": { anchor: "unresolved", note: "artifact store" },
  "SourceContentBinding.extractedArtifactRef": { anchor: "unresolved", note: "artifact store" },
  "SourceCitationHost.appearsInRef": { anchor: "unresolved", note: "host-resolved location" },
  "ResearchRequestScope.repositoryRefs": { anchor: "unresolved", note: "policy intersection, host-resolved" },
  "ResearchRequestScope.evidenceRefs": { anchor: "unresolved", note: "policy intersection, host-resolved" },
  "ResearchEffort.explorationPortfolioRef": { anchor: "unresolved", note: "approved portfolio, host-resolved" },
  "RequestLineage.parentInvestigationRef": { anchor: "unresolved", note: "lineage" },
  "ResearchRequestHost.originatingEventRef": { anchor: "unresolved", note: "provenance" },
  "ResearchRequestHost.contextSnapshotRefs": { anchor: "unresolved", note: "host-resolved snapshots" },
  "OracleContextBinding.runRef": { anchor: "unresolved", note: "compared to the manifest's runId by resolveContextBinding" },
  "OracleContextBinding.missionRefs": { anchor: "unresolved", note: "ratified mission" },
  "OracleContextBinding.ratifiedPolicyRefs": { anchor: "unresolved", note: "ratified policy" },
  "OracleContextBinding.publicBriefRef": { anchor: "unresolved", note: "public brief" },
  "MissingDecision.ruleRef": { anchor: "unresolved", note: "names the rule that cannot admit" },
  "AttestedEnvelope.workspaceRef": { anchor: "host-state", note: "host-attested envelope field" },
  "AttestedEnvelope.runRef": { anchor: "host-state", note: "host-attested envelope field" },
  "AttestedEnvelope.workOrderRef": { anchor: "host-state", note: "host-attested envelope field" },
  "AttestedEnvelope.policyRef": { anchor: "host-state", note: "host-attested envelope field" },
  "AttestedEnvelope.grantRefs": { anchor: "host-state", note: "host-attested envelope field" },
  "AttestedEnvelope.budgetReservationRef": { anchor: "host-state", note: "host-attested envelope field" },
};

/** The type each field record belongs to, for the per-type checks below. */
const OWNING_TYPE: Readonly<Record<string, string>> = {
  ClaimAssessment: "AssessmentCommon",
};

describe("every cross-record FIELD is accounted for", () => {
  const scanned = new Map<string, Record<string, string[]>>();
  for (const file of Object.keys(REFERENCE_FIELD_COUNTS)) {
    scanned.set(file, referenceFieldsIn(readFileSync(join(SRC, file), "utf8")));
  }

  it("every type yields exactly the number of reference fields declared for it", () => {
    // PER TYPE, not a total. A total floor read 29 while claim-assessment.ts
    // yielded zero of its four, which is how a smuggled field stayed invisible.
    for (const [file, types] of Object.entries(REFERENCE_FIELD_COUNTS)) {
      const found = scanned.get(file) ?? {};
      for (const [typeName, expected] of Object.entries(types)) {
        expect(found[typeName] ?? [], `${file} ${typeName}`).toHaveLength(expected);
      }
    }
  });

  it("no type in a scanned file yields reference fields without being declared", () => {
    // The other direction: a NEW type carrying references is as invisible as a
    // new field on an undeclared one.
    for (const [file, types] of scanned.entries()) {
      for (const [typeName, fields] of Object.entries(types)) {
        if (fields.length === 0) continue;
        expect(
          Object.keys(REFERENCE_FIELD_COUNTS[file] ?? {}),
          `${file} declares no count for ${typeName}`,
        ).toContain(typeName);
      }
    }
  });

  it("each field has a written treatment, under the name it is READ by", () => {
    const unaccounted: string[] = [];
    for (const [file, types] of scanned.entries()) {
      for (const [typeName, fields] of Object.entries(types)) {
        for (const field of fields) {
          // A record whose fields live in a shared base is keyed by the name a
          // reader knows it as.
          const owner = Object.entries(OWNING_TYPE).find(([, base]) => base === typeName)?.[0]
            ?? typeName;
          const key = `${owner}.${field}`;
          if (!Object.hasOwn(CROSS_RECORD_FIELDS, key)) unaccounted.push(`${file} ${key}`);
        }
      }
    }
    expect(unaccounted).toEqual([]);
  });

  it("STALE-ENTRY CONTROL: every entry names a field that exists ON ITS OWN TYPE", () => {
    // The previous control checked `readonly <field>` across the four files
    // concatenated, so deleting `readonly runRef` from OutcomeRecord left the
    // entry stale and the control green — three other types carry a `runRef`.
    // The type half of the key was the half being discarded.
    for (const key of Object.keys(CROSS_RECORD_FIELDS)) {
      const [owner = "", field = ""] = key.split(".");
      const typeName = OWNING_TYPE[owner] ?? owner;
      const found = [...scanned.values()].some((types) => (types[typeName] ?? []).includes(field));
      expect(found, `${key} is in the table but not on ${typeName}`).toBe(true);
    }
  });

  it("a treatment naming a mechanism names a module whose source mentions the field", () => {
    // The weak mechanical link. `reportDigest` claimed to be recomputed in a
    // module whose text did not contain the word, and `executionEvidenceRefs`
    // claimed a caller-supplied set that does not exist. Prose nothing checks
    // has now been wrong twice.
    let checked = 0;
    for (const [key, treatment] of Object.entries(CROSS_RECORD_FIELDS)) {
      if (treatment.anchor !== "recomputed" && treatment.anchor !== "resolved") continue;
      checked += 1;
      const field = key.split(".")[1] ?? "";
      const source = readFileSync(join(SRC, treatment.by), "utf8");
      expect(source, `${key}: ${treatment.by} never mentions ${field}`).toContain(field);
    }
    expect(checked, "the link must cover a real population").toBeGreaterThanOrEqual(8);
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
    const result = resolveContextBinding(lying, manifest, "run-oracle-1");
    expect(result.outcome).toBe("MANIFEST_MISMATCH");
    // POSITIVE CONTROL on the same manifest.
    const parsed = validateContextManifest(manifest);
    if (!parsed.ok) throw new Error("fixture manifest must validate");
    expect(
      resolveContextBinding(
        { ...validContextBinding(), contextManifestDigest: contextManifestDigest(parsed.value) },
        manifest,
        "run-oracle-1",
      ).outcome,
    ).toBe("BOUND");
  });

  it("W1: a binding and a manifest agreeing on a FALSE run do not bind", () => {
    // THE CONSISTENT LIE on the rule this table lists first. The digest half is
    // satisfied honestly — the digest is recomputed from the forged manifest's
    // own bytes — and both records name the same wrong run. Comparing them to
    // each other established only that they agreed.
    const manifest = JSON.parse(
      readFileSync(join(SRC, "..", "vectors", "bound-context-manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    const forgedManifest = { ...manifest, runId: "run-somebody-else" };
    const parsed = validateContextManifest(forgedManifest);
    if (!parsed.ok) throw new Error("the forged manifest must itself be valid");
    const forgedBinding = {
      ...validContextBinding(),
      runRef: "run-somebody-else",
      contextManifestDigest: contextManifestDigest(parsed.value),
    };
    const result = resolveContextBinding(forgedBinding, forgedManifest, "run-oracle-1");
    expect(result.outcome).toBe("MANIFEST_MISMATCH");
    if (result.outcome !== "MANIFEST_MISMATCH") return;
    expect(result.issues.map((i) => i.code)).toEqual(["context_manifest_run_mismatch"]);
  });

  it("and an absent caller run identity is REFUSED, not read as 'skip the check'", () => {
    const manifest = JSON.parse(
      readFileSync(join(SRC, "..", "vectors", "bound-context-manifest.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(resolveContextBinding(validContextBinding(), manifest, undefined).outcome).toBe("REFUSED");
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

  it("LIMIT: two disjoint descriptions of one execution take two credits", () => {
    // OUT-04, defeated three times, each repair moving the anchor to another
    // string the record writes: `creditKey`, then `authorizedWorkRef`, then
    // `executionEvidenceRefs`. This is the third defeat, LEFT OPEN on purpose.
    //
    // Both work orders are genuinely host-authorized, so anchor (b) is
    // satisfied; the evidence sets are disjoint, so the between-record dedup
    // sees nothing in common. Two accepted-work credits for one run.
    const base = validOutcomeRecord();
    const AUTHORIZED = [
      { workRef: "wo-part1", runRef: base.runRef, workspaceRef: base.workspaceRef },
      { workRef: "wo-part2", runRef: base.runRef, workspaceRef: base.workspaceRef },
    ];
    const part = (id: string, work: string, evidence: string): OutcomeRecord => ({
      ...base,
      outcomeId: id,
      authorizedWorkRef: work,
      executionEvidenceRefs: [evidence],
    });
    const result = resolveOutcomeCredits(
      [
        part("oracle-outcome-a", "wo-part1", "evidence-probe-run-77-part1"),
        part("oracle-outcome-b", "wo-part2", "evidence-probe-run-77-part2"),
      ],
      AUTHORIZED,
    );
    // The lie SUCCEEDS. Closing it needs a host-attested identity for the
    // EXECUTION, resolved from outside these records — see the comment in
    // outcome-record.ts for where that belongs.
    expect(result.outcome).toBe("CREDITED");
    if (result.outcome !== "CREDITED") return;
    expect(result.acceptedWork).toEqual(["oracle-outcome-a", "oracle-outcome-b"]);

    // NON-VACUITY: the rule is not dead. The same two records with OVERLAPPING
    // evidence are caught, which is the half that is enforceable here.
    const overlapping = resolveOutcomeCredits(
      [
        part("oracle-outcome-a", "wo-part1", "evidence-probe-run-77"),
        part("oracle-outcome-b", "wo-part2", "evidence-probe-run-77"),
      ],
      AUTHORIZED,
    );
    expect(overlapping.outcome).toBe("DOUBLE_CREDITED");
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

describe("evidenceIsMissing refuses rather than throws, and fails closed", () => {
  /**
   * Its own contract says a guard must refuse rather than throw, and it threw
   * on six INNER shapes: `toPlainRecord` snapshots the top level only, and the
   * registered probe only ever fed the outer position. Three more shapes
   * answered the PERMISSIVE `false` — the direction that puts a claim under
   * "what the evidence establishes".
   */
  const THROWING_SHAPES: readonly [string, unknown][] = [
    ["claim: null", { claim: null, unresolvedSourceIds: [] }],
    ["sourceSpans: [null]", { claim: { sourceSpans: [null] }, unresolvedSourceIds: [] }],
    ["assessment: null", { claim: { sourceSpans: [] }, assessment: null, unresolvedSourceIds: [] }],
    ["assessment: 'str'", { claim: { sourceSpans: [] }, assessment: "str", unresolvedSourceIds: [] }],
    [
      "reviewedSpans: null",
      { claim: { sourceSpans: [] }, assessment: { reviewedSpans: null }, unresolvedSourceIds: [] },
    ],
    [
      "reviewedSpans: [null]",
      { claim: { sourceSpans: [] }, assessment: { reviewedSpans: [null] }, unresolvedSourceIds: [] },
    ],
  ];

  const PERMISSIVE_SHAPES: readonly [string, unknown][] = [
    // A value guard failing open on a WRONG TYPE: a non-array coerced to the
    // empty set, which reads as "nothing is unresolved".
    ["unresolvedSourceIds: 'x'", { claim: { sourceSpans: [{ sourceId: "s1" }] }, unresolvedSourceIds: "x" }],
    // `undefined` in the cited set, never in the unresolved set.
    ["a span with no sourceId", { claim: { sourceSpans: [{}] }, unresolvedSourceIds: [] }],
    // `"xy"` passed an `in` check and iterated as characters.
    [
      "reviewedSpans: 'xy'",
      { claim: { sourceSpans: [] }, assessment: { reviewedSpans: "xy" }, unresolvedSourceIds: [] },
    ],
  ];

  it("no inner shape throws", () => {
    for (const [name, shape] of THROWING_SHAPES) {
      expect(() => evidenceIsMissing(shape), name).not.toThrow();
    }
  });

  it("and every unreadable shape answers `missing`, not `present`", () => {
    for (const [name, shape] of [...THROWING_SHAPES, ...PERMISSIVE_SHAPES]) {
      expect(evidenceIsMissing(shape), name).toBe(true);
    }
  });

  it("POSITIVE REACHABILITY CONTROL: a well-formed bound claim answers `present`", () => {
    // Without this, a function returning `true` unconditionally would satisfy
    // every assertion above and put every claim in the gap section.
    const claim = validClaimRecord();
    const resolved = resolveReportBundle({
      report: {
        ...validResearchReport(),
        claims: [
          { claimRef: claim.claimId, claimDigest: claimRecordDigest(claim), assessmentRef: null },
        ],
        assessmentCoverage: { claimsTotal: 1, claimsWithStoredAssessment: 0, claimsNotAssessed: 1 },
      },
      claims: [claim],
      assessments: [],
      proposal: null,
      delivered: validDeliveredSources(),
    });
    expect(resolved.outcome).toBe("RESOLVED");
    if (resolved.outcome !== "RESOLVED") return;
    const bound = resolved.claims[0];
    if (bound === undefined) throw new Error("the bundle must carry the claim");
    expect(evidenceIsMissing(bound)).toBe(false);
    // And the same claim with its one cited id unresolved is missing, so the
    // answer tracks the input rather than the shape.
    expect(
      evidenceIsMissing({
        ...bound,
        unresolvedSourceIds: bound.claim?.sourceSpans.map((span) => span.sourceId) ?? [],
      }),
    ).toBe(true);
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
