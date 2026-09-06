import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize, type ValidationResult } from "@getsimpledirect/vinci-contracts";
import { contextManifestDigest, validateContextManifest } from "@getsimpledirect/vinci-run";
import {
  ASSESSMENT_STATUSES,
  ATTESTED_ENVELOPE_KINDS,
  CLAIM_TYPES,
  CONTEXT_COMPLETENESS,
  CONTEXT_REVISION_KINDS,
  CONTEXT_SELECTION_DECISIONS,
  CONTEXT_UNAVAILABLE_REASONS,
  ORACLE_DATA_CLASSIFICATIONS,
  ORACLE_PROPOSE_SCOPES,
  OUTCOME_CLASSES,
  PROPOSAL_ADMISSIBILITY,
  PROPOSAL_KINDS,
  REQUIRED_OUTPUTS,
  RESEARCH_MODES,
  SOURCE_COMPLETENESS,
  SOURCE_MATCH_STATES,
  SOURCE_OBSERVATION_MODES,
  SOURCE_READ_OUTCOMES,
  STOP_CONDITIONS,
  claimAssessmentDigest,
  claimRecordDigest,
  decisionProposalDigest,
  oracleContextBindingDigest,
  outcomeRecordDigest,
  researchReportDigest,
  researchRequestDigest,
  resolveContextBinding,
  sourceCitationDigest,
  sourceRecordDigest,
  validateClaimAssessment,
  validateClaimRecord,
  validateDecisionProposal,
  validateOracleContextBinding,
  validateOutcomeRecord,
  validateResearchReport,
  validateResearchRequest,
  validateSourceCitation,
  validateSourceRecord,
} from "./index.ts";

/**
 * Golden vectors, shared with the Python implementation.
 *
 * Each directory under ../vectors holds an input.json, the exact canonical
 * bytes (canonical.txt) and the digest (digest.txt). This test regenerates both
 * from the input and compares; python/test_oracle_vectors.py does the same from
 * the other language, reusing packages/work-orders/python/vinci_canonical.py.
 * A change to canonicalization, to what a digest covers, or to a fixture, fails
 * here and there — which is the point: the vectors are the contract, and
 * neither implementation gets to redefine it alone. Regenerate with
 * vectors/generate.mjs only as a deliberate act.
 *
 * Same construction as packages/run/src/vectors.test.ts, deliberately.
 */
// fileURLToPath rather than import.meta.dirname: engines says node >=20 and
// import.meta.dirname arrived in 20.11.
const VECTORS = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");

const EXPECTED_VECTORS = [
  "claim-assessment-1-supported",
  "claim-assessment-2-check-unavailable",
  "claim-assessment-3-not-assessed",
  "claim-record-1-observed",
  "claim-record-2-hypothesis",
  "context-binding-1-complete",
  "context-binding-2-incomplete",
  "decision-proposal-1-request-observation",
  "decision-proposal-2-no-change",
  "outcome-record-1-helpful-disproved",
  "research-report-1-partial",
  "research-request-1-admitted",
  "research-request-2-unicode-numbers",
  "source-citation-1-delivered",
  "source-record-1-repository-read",
  "source-record-2-provider-reported",
  "source-record-3-unsupported-format",
] as const;

/**
 * The digests, pinned IN SOURCE as well as in each vector's digest.txt.
 *
 * digest.txt is written by vectors/generate.mjs, so a comparison against it
 * alone cannot distinguish "the vectors are unchanged" from "someone re-ran the
 * generator and the fixture moved underneath us" — the regenerated file agrees
 * with the regenerated fixture by construction. These literals are the second,
 * independent pin, and python/test_oracle_vectors.py carries the same values,
 * so the two languages cannot drift apart quietly either.
 */
const PINNED_DIGESTS: Readonly<Record<(typeof EXPECTED_VECTORS)[number], string>> = {
  "claim-assessment-1-supported": "6aa5ad100be98f6fbcedd1460da2e98b26076f8f0a23d09eee3849cbb2eaeb61",
  "claim-assessment-2-check-unavailable": "cc9a5d13aacaf7362d3ca979387a3d53d4f0592419148c3f22ddabc7a4739e68",
  "claim-assessment-3-not-assessed": "0a9d9e27219a3a6f33e06f1663506e5eceb0aa0e99ba1a1e48b3311ee62b282c",
  "claim-record-1-observed": "afbf2347a919afb2b8799c8f5329a30b0de1ec7f383c43ba1a88860d4c2fb637",
  "claim-record-2-hypothesis": "6851e2e45c793affef1e8ee3496bd45defa876e82ca528c9d054a52bd7e9289b",
  "decision-proposal-1-request-observation":
    "2b1a89a24fd1254e4afd578271bc42dbd8f074e4a4bcadda3df9889063179cf0",
  "decision-proposal-2-no-change": "8262f70dc99b4ccee8da357a29dec6a043145b03ff5656237ab8aebbdb3ceed6",
  "outcome-record-1-helpful-disproved":
    "44ce14449cb847a37b9786f91500cdc7f6a2eb91289f382aa9aa073c9767a8b6",
  "research-report-1-partial": "77dfc2c019b9f0bf604b936f9d95b4ba36e09d6dd31a970ab58899990c3f59ce",
  "context-binding-1-complete": "95c49a42f4ce350d3113ea6ba5210a6db7a8c12096c36150dcf4b293132389f7",
  "context-binding-2-incomplete": "362feb622e1e54719d884e5ddf893332a9408e3c85a8f156a2b4907015096497",
  "research-request-1-admitted": "a722101e72a63e022944a3a7fc336d86c6410efb93751a015d74f94017a34bb0",
  "research-request-2-unicode-numbers": "aecd39c102b9e188400e47438286a4d5c36640700e4161be7ebae74c51268451",
  "source-citation-1-delivered": "b2544375f40901d9090c2aeb64c0602edb9652bf0025b1104c4d6c37ec95f208",
  "source-record-1-repository-read": "37facd652807911463cd52bb021d0d18af3fe2cd600911fe6939edd20e3ef19d",
  "source-record-2-provider-reported": "48039508f1f51d7e8e20f99cf131e5c5028c7377e6d666ac79ff79f43a25b202",
  "source-record-3-unsupported-format": "32cf1b46f8ad43128a37de1012bd36b53320812a6be042cb505ff2a4ee539c2b",
};

const dirs = readdirSync(VECTORS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

function digested<T>(result: ValidationResult<T>, digest: (value: T) => string): string {
  if (!result.ok) throw new Error(`vector did not validate: ${JSON.stringify(result.issues)}`);
  return digest(result.value);
}

/**
 * The schema that owns a vector directory, by name prefix.
 *
 * An unrecognised directory throws rather than being skipped: a vector nobody
 * digests is a vector nobody checks, and a silent skip is how a fixture stops
 * being covered without anyone seeing it happen.
 */
function digestForVector(dir: string, input: unknown): string {
  if (dir.startsWith("claim-assessment-")) {
    return digested(validateClaimAssessment(input), claimAssessmentDigest);
  }
  if (dir.startsWith("claim-record-")) {
    return digested(validateClaimRecord(input), claimRecordDigest);
  }
  if (dir.startsWith("decision-proposal-")) {
    return digested(validateDecisionProposal(input), decisionProposalDigest);
  }
  if (dir.startsWith("outcome-record-")) {
    return digested(validateOutcomeRecord(input), outcomeRecordDigest);
  }
  if (dir.startsWith("research-report-")) {
    return digested(validateResearchReport(input), researchReportDigest);
  }
  if (dir.startsWith("context-binding-")) {
    return digested(validateOracleContextBinding(input), oracleContextBindingDigest);
  }
  if (dir.startsWith("research-request-")) {
    return digested(validateResearchRequest(input), researchRequestDigest);
  }
  if (dir.startsWith("source-citation-")) {
    return digested(validateSourceCitation(input), sourceCitationDigest);
  }
  if (dir.startsWith("source-record-")) {
    return digested(validateSourceRecord(input), sourceRecordDigest);
  }
  throw new Error(`${dir}: no schema owns this vector directory`);
}

function validates(dir: string, input: unknown): boolean {
  if (dir.startsWith("claim-assessment-")) return validateClaimAssessment(input).ok;
  if (dir.startsWith("claim-record-")) return validateClaimRecord(input).ok;
  if (dir.startsWith("decision-proposal-")) return validateDecisionProposal(input).ok;
  if (dir.startsWith("outcome-record-")) return validateOutcomeRecord(input).ok;
  if (dir.startsWith("research-report-")) return validateResearchReport(input).ok;
  if (dir.startsWith("context-binding-")) return validateOracleContextBinding(input).ok;
  if (dir.startsWith("research-request-")) return validateResearchRequest(input).ok;
  if (dir.startsWith("source-citation-")) return validateSourceCitation(input).ok;
  if (dir.startsWith("source-record-")) return validateSourceRecord(input).ok;
  throw new Error(`${dir}: no schema owns this vector directory`);
}

const HEX_64 = /^[0-9a-f]{64}$/;

/**
 * Flip ONE character of the first 64-hex string in a deep copy of `value`.
 *
 * Deliberately a hex-to-hex flip inside a digest field: the mutated fixture is
 * still a VALID record of the same schema, so a digest that changes can only
 * have changed because the bytes changed — not because validation refused the
 * mutant and something downstream swallowed the refusal. `mutated` is asserted
 * valid alongside every mutation test below, which is the positive reachability
 * control for that claim.
 */
function flipOneHexCharacter(value: unknown): { mutated: unknown; changed: boolean } {
  let changed = false;
  function walk(node: unknown): unknown {
    if (typeof node === "string") {
      if (!changed && HEX_64.test(node)) {
        changed = true;
        const last = node.slice(-1);
        return node.slice(0, -1) + (last === "0" ? "1" : "0");
      }
      return node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        out[key] = walk(child);
      }
      return out;
    }
    return node;
  }
  const mutated = walk(value);
  return { mutated, changed };
}

const readVector = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(VECTORS, dir, "input.json"), "utf8")) as Record<string, unknown>;

const readFile = (name: string): unknown =>
  JSON.parse(readFileSync(join(VECTORS, name), "utf8")) as unknown;

describe("golden vectors pin the canonical bytes and digests", () => {
  it("holds exactly the seventeen committed vectors, and every one of them is pinned in source", () => {
    expect(dirs).toEqual([...EXPECTED_VECTORS]);
    // A pin map missing an entry would silently stop pinning that vector.
    expect(Object.keys(PINNED_DIGESTS).sort()).toEqual([...EXPECTED_VECTORS].sort());
    // Seventeen distinct fixtures must have seventeen distinct identities: a
    // copy-paste slip in the literals above would otherwise read as a passing pin.
    expect(new Set(Object.values(PINNED_DIGESTS)).size).toBe(EXPECTED_VECTORS.length);
  });

  for (const dir of dirs) {
    it(`${dir}: canonical bytes and digest match the committed vector`, () => {
      const input: unknown = readVector(dir);
      const canonical = readFileSync(join(VECTORS, dir, "canonical.txt"), "utf8");
      const digest = readFileSync(join(VECTORS, dir, "digest.txt"), "utf8").trim();
      expect(canonicalize(input)).toBe(canonical);
      expect(digestForVector(dir, input)).toBe(digest);
      expect(digest).toMatch(HEX_64);
      // The source-side pin. digest.txt is regenerated by the generator; this
      // literal is not, so a regeneration that moves a digest fails here until
      // someone changes it on purpose.
      expect(digest).toBe(PINNED_DIGESTS[dir as (typeof EXPECTED_VECTORS)[number]]);
    });

    // THE CONNECTED-INSTRUMENT CONTROL.
    //
    // A vector test that never sees a mismatch cannot tell a working comparison
    // from a comparison someone deleted. This copies the fixture in memory,
    // flips a single character of one digest field, and requires BOTH the
    // canonical bytes and the digest to move — while the mutant stays valid, so
    // the difference is attributable to the bytes and not to a refusal.
    it(`${dir}: one flipped character changes the canonical bytes and the digest`, () => {
      const input: unknown = readVector(dir);
      const pinnedCanonical = readFileSync(join(VECTORS, dir, "canonical.txt"), "utf8");
      const pinnedDigest = readFileSync(join(VECTORS, dir, "digest.txt"), "utf8").trim();
      const { mutated, changed } = flipOneHexCharacter(input);
      expect(changed, "every vector must carry a 64-hex field to mutate").toBe(true);
      // Positive reachability: the mutant is still a valid record of this
      // schema, so the digest below is computed and not refused.
      expect(validates(dir, mutated)).toBe(true);
      expect(canonicalize(mutated)).not.toBe(pinnedCanonical);
      expect(digestForVector(dir, mutated)).not.toBe(pinnedDigest);
      // And the original is untouched: the mutation ran on a copy.
      expect(canonicalize(input)).toBe(pinnedCanonical);
    });
  }
});

const sorted = (values: readonly string[]): string[] => [...values].sort();

describe("the vectors exercise the closed vocabularies, not a corner of each", () => {
  /**
   * A fixture that happens to use two of seven labels pins two of seven rules.
   * These assertions make coverage a checked property rather than a claim in a
   * commit message: adding a member to a vocabulary without extending a vector
   * fails here.
   */
  it("the two research-request vectors cover every required output and every stop condition", () => {
    const requests = ["research-request-1-admitted", "research-request-2-unicode-numbers"].map(readVector);
    const outputs = new Set<string>();
    const stops = new Set<string>();
    for (const request of requests) {
      const payload = request.payload as Record<string, unknown>;
      for (const output of payload.requiredOutput as string[]) outputs.add(output);
      const completion = payload.completion as Record<string, unknown>;
      for (const stop of completion.stopConditions as string[]) stops.add(stop);
      expect(ATTESTED_ENVELOPE_KINDS as readonly string[]).toContain(request.envelopeKind as string);
      const effort = (request.hostResolved as Record<string, unknown>).effort as Record<string, unknown>;
      expect(RESEARCH_MODES as readonly string[]).toContain(effort.mode as string);
    }
    expect(sorted([...outputs])).toEqual(sorted(REQUIRED_OUTPUTS));
    // Not every stop condition, but more than one, and every one a member.
    expect(stops.size).toBeGreaterThan(1);
    for (const stop of stops) expect(STOP_CONDITIONS as readonly string[]).toContain(stop);
  });

  it("the context-binding vectors cover both completeness states and both revision kinds", () => {
    const bindings = ["context-binding-1-complete", "context-binding-2-incomplete"].map(readVector);
    expect(sorted(bindings.map((b) => b.completeness as string))).toEqual(sorted(CONTEXT_COMPLETENESS));
    const kinds = new Set<string>();
    for (const b of bindings) {
      for (const entry of b.revisionVector as Record<string, string>[]) {
        kinds.add(entry.revisionKind as string);
      }
      for (const entry of b.unavailableSections as Record<string, string>[]) {
        expect(CONTEXT_UNAVAILABLE_REASONS as readonly string[]).toContain(entry.reason);
      }
      for (const entry of b.dataClassifications as Record<string, string>[]) {
        expect(ORACLE_DATA_CLASSIFICATIONS as readonly string[]).toContain(entry.classification);
      }
      for (const entry of b.selectionDecisions as Record<string, string>[]) {
        expect(CONTEXT_SELECTION_DECISIONS as readonly string[]).toContain(entry.decision);
      }
    }
    expect(sorted([...kinds])).toEqual(sorted(CONTEXT_REVISION_KINDS));
    // CTX-01 is exercised rather than merely present: the vectors read TWO
    // repositories at two different instants inside one window, which is the
    // shape a single `snapshotAt` field would have collapsed.
    const vector = bindings[0]?.revisionVector as Record<string, string>[];
    expect(vector).toHaveLength(2);
    expect(new Set(vector.map((entry) => entry.observedAt)).size).toBe(2);
  });

  it("the source-record vectors cover both observation modes and three distinct read outcomes", () => {
    const sources = [
      "source-record-1-repository-read",
      "source-record-2-provider-reported",
      "source-record-3-unsupported-format",
    ].map(readVector);
    const modes = new Set(
      sources.map((s) => (s.observation as Record<string, string>).mode),
    );
    expect(sorted([...modes])).toEqual(sorted(SOURCE_OBSERVATION_MODES));
    expect(new Set(sources.map((s) => s.readOutcome as string)).size).toBe(3);
    for (const source of sources) {
      expect(SOURCE_READ_OUTCOMES as readonly string[]).toContain(source.readOutcome as string);
      expect(SOURCE_MATCH_STATES as readonly string[]).toContain(source.matchState as string);
      expect(SOURCE_COMPLETENESS as readonly string[]).toContain(source.completeness as string);
    }
    // SRC-04's three states, present as data rather than as a claim: nothing
    // obtained, something obtained in part, and everything requested obtained.
    expect(sorted(sources.map((s) => s.completeness as string))).toEqual([
      "FULL_REQUESTED_RANGE",
      "NOT_OBTAINED",
      "SNIPPET_ONLY",
    ]);
  });

  it("the assessment vectors carry the two states an error path could be tempted to skip", () => {
    // CLM-01, as committed data rather than as a rule in a file: an assessment
    // that could not run, and one nobody ran. Both must survive canonicalization
    // with their own identity, or a consumer reading the vectors cannot tell
    // them apart from support.
    const assessments = [
      "claim-assessment-1-supported",
      "claim-assessment-2-check-unavailable",
      "claim-assessment-3-not-assessed",
    ].map(readVector);
    expect(sorted(assessments.map((a) => a.status as string))).toEqual([
      "CHECK_UNAVAILABLE",
      "NOT_ASSESSED",
      "SUPPORTED",
    ]);
    for (const assessment of assessments) {
      expect(ASSESSMENT_STATUSES as readonly string[]).toContain(assessment.status as string);
    }
    // The SUPPORTED vector carries the evidence that earns it, and neither of
    // the other two carries any: the structural rule, visible in the bytes.
    const [supported, unavailable, notAssessed] = assessments;
    expect((supported?.reviewedSpans as unknown[]).length).toBeGreaterThan(0);
    expect(supported?.execution).toEqual({ completed: true, reviewerRunRef: "reviewer-run-41" });
    for (const record of [unavailable, notAssessed]) {
      expect(record === undefined ? true : "reviewedSpans" in record).toBe(false);
      expect(record === undefined ? true : "execution" in record).toBe(false);
    }
    // NOT_ASSESSED names no evaluator, because none ran; CHECK_UNAVAILABLE does,
    // because one did and produced nothing usable.
    expect("evaluator" in (notAssessed ?? {})).toBe(false);
    expect("evaluator" in (unavailable ?? {})).toBe(true);
  });

  it("the claim vectors cover an observation and a hypothesis with no source at all", () => {
    const claims = ["claim-record-1-observed", "claim-record-2-hypothesis"].map(readVector);
    expect(sorted(claims.map((c) => c.claimType as string))).toEqual(["HYPOTHESIS", "OBSERVED"]);
    for (const claim of claims) {
      expect(CLAIM_TYPES as readonly string[]).toContain(claim.claimType as string);
    }
    // CLM-04 in the data: the hypothesis has NO source spans and IS a committed
    // valid vector, which is the shape a validator demanding source support for
    // a proposed experiment would have made unrepresentable.
    const hypothesis = claims[1];
    expect(hypothesis?.sourceSpans).toEqual([]);
    expect(hypothesis?.discriminatingTest).not.toBeNull();
    expect((claims[0]?.sourceSpans as unknown[]).length).toBeGreaterThan(0);
  });

  it("the proposal vectors cover both propose scopes and both admissibility states", () => {
    const proposals = [
      "decision-proposal-1-request-observation",
      "decision-proposal-2-no-change",
    ].map(readVector);
    const hosts = proposals.map((p) => p.hostResolved as Record<string, unknown>);
    expect(sorted(hosts.map((h) => h.proposeScope as string))).toEqual(sorted(ORACLE_PROPOSE_SCOPES));
    expect(
      sorted(hosts.map((h) => (h.admissibility as Record<string, string>).state)),
    ).toEqual(sorted(PROPOSAL_ADMISSIBILITY));
    for (const host of hosts) {
      // PROP-01, pinned in the committed bytes: neither vector carries a true.
      expect(host.authorityToExecute).toBe(false);
    }
    for (const proposal of proposals) {
      const payload = proposal.payload as Record<string, unknown>;
      expect(PROPOSAL_KINDS as readonly string[]).toContain(payload.kind as string);
      expect((payload.alternatives as unknown[]).length).toBeGreaterThan(0);
    }
    // The report vector says PARTIAL while its run says PARTIALLY_COMPLETED and
    // its coverage says one of two: REP-02's three fields, disagreeing on
    // purpose, in committed data.
    const report = readVector("research-report-1-partial");
    expect(report.reportCompleteness).toBe("PARTIAL");
    // SUPERSEDED is the case the private vocabulary could not express at all:
    // a productive terminal that is not a success and not a failure.
    expect(report.runTerminal).toEqual({ kind: "completed", outcome: "SUPERSEDED" });
    expect(report.assessmentCoverage).toEqual({
      claimsTotal: 2,
      claimsWithStoredAssessment: 1,
      claimsNotAssessed: 1,
    });
    // OUT-01's combination, in committed data: disproved and helpful.
    const outcome = readVector("outcome-record-1-helpful-disproved");
    expect(OUTCOME_CLASSES as readonly string[]).toContain(outcome.outcomeClass as string);
    expect(outcome.outcomeClass).toBe("HELPFUL_OBSERVED");
    expect(outcome.hypothesisResult).toBe("DISPROVED_BY_RESULT");
  });

  it("the unicode vector carries characters and numbers a naive encoder gets wrong", () => {
    const payload = readVector("research-request-2-unicode-numbers").payload as Record<string, string>;
    const text = `${payload.decisionToInform}${payload.question}`;
    // An astral-plane character (a surrogate PAIR in UTF-16), a combining mark,
    // a right-to-left script, a zero-width joiner and a control character. Each
    // is a place the two encoders could disagree by a byte.
    expect(text).toContain("\u{1D11E}");
    expect(text).toContain("́");
    expect(text).toContain("ע");
    expect(text).toContain("‍");
    expect(text).toContain("");
    const effort = (readVector("research-request-2-unicode-numbers").hostResolved as Record<string, unknown>)
      .effort as Record<string, number>;
    expect(effort.maxBytes).toBe(Number.MAX_SAFE_INTEGER);
    // T06: zero is a value. It reaches the canonical bytes as `0`, not as an
    // absent field, and the record is valid because of that.
    expect(effort.budgetMicrousd).toBe(0);
    const canonical = readFileSync(join(VECTORS, "research-request-2-unicode-numbers", "canonical.txt"), "utf8");
    expect(canonical).toContain('"budgetMicrousd":0');
    expect(canonical).toContain('"maxBytes":9007199254740991');
    expect(canonical).toContain("\\u0001");
  });
});

type RefusalCase = {
  readonly label: string;
  readonly kind: string;
  readonly record: unknown;
  readonly expectedIssue: { readonly path: string; readonly code: string };
  readonly vocabulary?: string;
};

const refusals = readFile("refusal-cases.json") as {
  readonly schemaVersion: number;
  readonly cases: readonly RefusalCase[];
};

const VOCABULARIES: Readonly<Record<string, readonly string[]>> = {
  ASSESSMENT_STATUSES,
  ATTESTED_ENVELOPE_KINDS,
  CLAIM_TYPES,
  OUTCOME_CLASSES,
  PROPOSAL_KINDS,
  RESEARCH_MODES,
  SOURCE_MATCH_STATES,
  SOURCE_READ_OUTCOMES,
};

function validateByKind(kind: string, record: unknown): ValidationResult<unknown> {
  if (kind === "research-request") return validateResearchRequest(record);
  if (kind === "context-binding") return validateOracleContextBinding(record);
  if (kind === "source-record") return validateSourceRecord(record);
  if (kind === "source-citation") return validateSourceCitation(record);
  if (kind === "claim-record") return validateClaimRecord(record);
  if (kind === "claim-assessment") return validateClaimAssessment(record);
  if (kind === "research-report") return validateResearchReport(record);
  if (kind === "decision-proposal") return validateDecisionProposal(record);
  if (kind === "outcome-record") return validateOutcomeRecord(record);
  throw new Error(`${kind}: no validator owns this refusal case`);
}

/** Read a JSON pointer out of a plain value, for the vocabulary controls below. */
function atPointer(root: unknown, pointer: string): unknown {
  let node: unknown = root;
  for (const segment of pointer.split("/").slice(1)) {
    if (Array.isArray(node)) {
      node = node[Number(segment)];
      continue;
    }
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

describe("the shared refusal vectors reach the mechanism each one names", () => {
  it("carries a broad set of refusals, not one shape repeated", () => {
    expect(refusals.schemaVersion).toBe(1);
    expect(refusals.cases.length).toBeGreaterThanOrEqual(20);
    // Non-vacuity. Twenty copies of "unknown field" would exercise one branch of
    // one allowlist and read as full coverage.
    const codes = new Set(refusals.cases.map((c) => c.expectedIssue.code));
    expect(codes.size).toBeGreaterThanOrEqual(15);
    expect(codes).toContain("authority_field_in_model_payload");
    expect(codes).toContain("credential_field_in_context");
    expect(codes).toContain("unsupported_schema_version");
    expect(codes).toContain("negative_cost");
    // CLM-01 and REP-01's codes, named here so deleting the case that carries
    // one is a failure rather than a quieter file.
    expect(codes).toContain("unearned_support");
    expect(codes).toContain("unavailable_check_claims_review");
    expect(codes).toContain("inline_assessment_status");
    expect(codes).toContain("proposal_claims_execution_authority");
    expect(codes).toContain("self_certified_usefulness");
    // Every kind is exercised, so a validator cannot quietly stop being covered.
    expect(sorted([...new Set(refusals.cases.map((c) => c.kind))])).toEqual([
      "claim-assessment",
      "claim-record",
      "context-binding",
      "decision-proposal",
      "outcome-record",
      "research-report",
      "research-request",
      "source-citation",
      "source-record",
    ]);
    // Labels are unique: two cases sharing one would make a deleted case
    // invisible in the report.
    expect(new Set(refusals.cases.map((c) => c.label)).size).toBe(refusals.cases.length);
  });

  for (const testCase of refusals.cases) {
    it(`${testCase.label}: refused with exactly ${testCase.expectedIssue.code}`, () => {
      const result = validateByKind(testCase.kind, testCase.record);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // EXACTLY one issue, and it is the intended one.
      //
      // QUAL-02. Asserting "some issue mentions this code" would pass when an
      // earlier, unrelated guard refused first — which is the case where the
      // mechanism under test was never reached at all. Each of these records is
      // a committed VALID vector with one field changed, so one issue is the
      // right number and any second issue means the fixture carries a defect it
      // was not built to carry.
      expect(result.issues.map((i) => ({ path: i.path, code: i.code }))).toEqual([
        { path: testCase.expectedIssue.path, code: testCase.expectedIssue.code },
      ]);
    });
  }

  it("every enum-drift case names a value outside its vocabulary, and the vector it came from names one inside", () => {
    const drifts = refusals.cases.filter((c) => c.vocabulary !== undefined);
    expect(drifts.length).toBeGreaterThanOrEqual(4);
    for (const testCase of drifts) {
      const vocabulary = VOCABULARIES[testCase.vocabulary as string];
      expect(vocabulary, `${testCase.vocabulary} is not an exported vocabulary`).toBeDefined();
      const drifted = atPointer(testCase.record, testCase.expectedIssue.path);
      expect(vocabulary).not.toContain(drifted);
    }
    // THE POSITIVE CONTROL, on the same fields: every enum-valued field the
    // drift cases point at holds a member in the valid vectors. Without it,
    // "not a member" would also pass for a vocabulary that is empty or a path
    // that resolves to undefined everywhere.
    for (const dir of EXPECTED_VECTORS) {
      const record = readVector(dir);
      for (const testCase of drifts) {
        const value = atPointer(record, testCase.expectedIssue.path);
        if (value === undefined) continue;
        const vocabulary = VOCABULARIES[testCase.vocabulary as string];
        expect(vocabulary, `${dir}${testCase.expectedIssue.path}`).toContain(value);
      }
    }
  });
});

describe("a context binding is bound to the manifest it names", () => {
  const manifest = readFile("bound-context-manifest.json");

  it("the committed manifest is a valid vinci-run context manifest", () => {
    const parsed = validateContextManifest(manifest);
    expect(parsed.ok ? [] : parsed.issues).toEqual([]);
  });

  it("the complete binding resolves against it", () => {
    // This is why oracle-records sits above @getsimpledirect/vinci-run: the digest on
    // the binding is a claim about identity, and nothing verifies it unless
    // something recomputes it from the manifest's own bytes.
    const parsed = validateContextManifest(manifest);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const binding = readVector("context-binding-1-complete");
    expect(binding.contextManifestDigest).toBe(contextManifestDigest(parsed.value));
    expect(resolveContextBinding(binding, manifest)).toEqual({
      outcome: "BOUND",
      contextManifestDigest: binding.contextManifestDigest,
      completeness: "CONTEXT_COMPLETE",
    });
  });

  it("a binding naming a different manifest does not resolve, and says which way it failed", () => {
    const binding = {
      ...readVector("context-binding-1-complete"),
      contextManifestDigest: "0".repeat(64),
    };
    const result = resolveContextBinding(binding, manifest);
    expect(result.outcome).toBe("MANIFEST_MISMATCH");
    if (result.outcome !== "MANIFEST_MISMATCH") return;
    expect(result.issues.map((i) => i.code)).toEqual(["context_manifest_digest_mismatch"]);
  });

  it("a manifest belonging to another run does not resolve, even at the right digest", () => {
    // The discriminating case: the digest MATCHES and the binding is still
    // refused, so the run check is doing work the digest check cannot.
    const foreign = { ...(manifest as Record<string, unknown>), runId: "run-somebody-else" };
    const binding = {
      ...readVector("context-binding-1-complete"),
      contextManifestDigest: contextManifestDigest(
        (() => {
          const parsed = validateContextManifest(foreign);
          if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
          return parsed.value;
        })(),
      ),
    };
    const result = resolveContextBinding(binding, foreign);
    expect(result.outcome).toBe("MANIFEST_MISMATCH");
    if (result.outcome !== "MANIFEST_MISMATCH") return;
    expect(result.issues.map((i) => i.code)).toEqual(["context_manifest_run_mismatch"]);
  });

  it("a malformed manifest is REFUSED rather than reported as a mismatch", () => {
    const result = resolveContextBinding(readVector("context-binding-1-complete"), { runId: 7 });
    expect(result.outcome).toBe("REFUSED");
  });
});
