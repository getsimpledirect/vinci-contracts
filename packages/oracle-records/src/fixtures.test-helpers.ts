import { REQUIRED_OUTPUTS } from "./research-request.ts";
import type { OracleContextBinding } from "./oracle-context.ts";
import type { ResearchRequest } from "./research-request.ts";
import type { SourceCitation, SourceRecord } from "./source-record.ts";

/**
 * Shared VALID fixtures. Not exported from the package; tests only.
 *
 * Every negative test in this package is built by spreading one of these and
 * changing exactly one field. That is not a style preference — QUAL-02 says a
 * negative must reach the mechanism it claims to test, and a hand-written
 * "invalid" object typically fails for three reasons at once, of which the
 * intended one may not even be reached. Same construction as
 * `packages/work-orders/src/fixtures.test-helpers.ts`.
 */

/**
 * The digest of `vectors/bound-context-manifest.json`, pinned here as a literal
 * so `resolveContextBinding` is exercised against a REAL manifest rather than
 * against a digest that matches only because both sides came from the same
 * call. `src/vectors.test.ts` recomputes it from the committed manifest and
 * fails if this drifts.
 */
const BOUND_MANIFEST_DIGEST =
  "15d7e478560348d91f5595faded5a97f3279020640f411c816f48598c4392f94";
const DIGEST_B = "2e".repeat(32);
const DIGEST_C = "3d".repeat(32);

export const validResearchRequest = (): ResearchRequest => ({
  schemaVersion: 1,
  envelopeKind: "oracle_research_request",
  workspaceRef: "ws-institutional-1",
  principal: { kind: "worker", workerId: "worker-oracle-1" },
  runRef: "run-oracle-1",
  workOrderRef: "wo-oracle-1",
  policyRef: "policy.oracle.research",
  policyVersion: 3,
  grantRefs: ["grant-read-institutional", "grant-propose-advisory"],
  budgetReservationRef: "budget-reservation-7",
  contextManifestDigest: BOUND_MANIFEST_DIGEST,
  issuedAt: "2026-09-06T12:00:00.000Z",
  attestedBy: { component: "oracle-admission-host", version: "1.4.0" },
  hostResolved: {
    requestId: "oracle-request-1",
    originatingEventRef: "run-event-114",
    missionOwner: { kind: "user", userId: "owner-1" },
    intendedRecipient: { kind: "worker", workerId: "worker-oracle-1" },
    scope: {
      repositoryRefs: ["repo:vinci-contracts@365fe6ce"],
      evidenceRefs: ["evidence-dev-441"],
      exclusions: ["personal_data", "sealed_evaluation", "credentials"],
      taskClass: "source_verification",
    },
    authority: { readScope: "request_scope_only", proposeScope: "advisory_only" },
    contextSnapshotRefs: ["snapshot-context-1"],
    effort: {
      mode: "investigation",
      maxWallSeconds: 900,
      maxToolCalls: 40,
      maxBytes: 4_000_000,
      maxTokens: 200_000,
      budgetMicrousd: 2_500_000,
      attentionBudget: { interruptions: 1, decisions: 0 },
      explorationPortfolioRef: null,
    },
    lineage: {
      parentInvestigationRef: null,
      childRelationship: "none",
      idempotencyKey: "idem-oracle-1",
      version: 1,
    },
    admissionAssumptions: [
      {
        about: "/payload/freshness/asOfCutoff",
        assumed: "No cutoff was stated, so the question is read as being about the current state.",
        basis: "ratified_default",
      },
    ],
  },
  payload: {
    decisionToInform:
      "Choose the smallest change needed for truthful institutional source reading.",
    question:
      "At the captured source revision, can the reader distinguish a complete requested section "
      + "from a search snippet, a truncated page, a failed fetch and an unsupported PDF?",
    // Spread from the vocabulary rather than retyped: a second literal copy of
    // a closed vocabulary is the duplication `scripts/check-duplicate-vocabularies.mjs`
    // exists to refuse. The COMMITTED vector holds the literal list, which is
    // where the independent pin belongs.
    requiredOutput: [...REQUIRED_OUTPUTS],
    consequenceOfNoAnswer:
      "The reader ships with four read outcomes collapsed into one, and every claim built on it "
      + "inherits an unstated limitation.",
    freshness: {
      horizon: "current",
      asOfCutoff: null,
      mandatoryRechecks: ["repo:vinci-contracts@365fe6ce"],
    },
    completion: {
      acceptanceCriteria: [
        "Each of the four read outcomes is distinguishable from the delivered record alone.",
      ],
      stopConditions: [
        "decision_has_sufficient_evidence",
        "approved_budget_or_deadline_reached",
      ],
      deliveryDestination: "run-oracle-1/report",
    },
  },
});

export const validAdmittedIdentity = (requestDigest: string) => ({
  schemaVersion: 1 as const,
  idempotencyKey: "idem-oracle-1",
  requestId: "oracle-request-1",
  requestDigest,
});

export const validContextBinding = (): OracleContextBinding => ({
  schemaVersion: 1,
  bindingId: "oracle-context-binding-1",
  runRef: "run-oracle-1",
  contextManifestDigest: BOUND_MANIFEST_DIGEST,
  compiledAt: "2026-09-06T11:59:00.000Z",
  compilerVersion: "oracle-context-compiler/2.1.0",
  completeness: "CONTEXT_COMPLETE",
  missionRefs: ["mission-truthful-source-reading"],
  ratifiedPolicyRefs: ["policy.oracle.research@3"],
  observationWindow: {
    startedAt: "2026-09-06T11:40:00.000Z",
    endedAt: "2026-09-06T11:58:00.000Z",
  },
  revisionVector: [
    {
      repositoryId: "vinci-contracts",
      revision: "365fe6ce6adaed1753e322d4e75331f331930131",
      revisionKind: "git_object_id",
      observedAt: "2026-09-06T11:41:00.000Z",
    },
    {
      repositoryId: "vinci-gpu-control",
      revision: "snapshot-2026-09-06T11:57Z",
      revisionKind: "api_snapshot_id",
      observedAt: "2026-09-06T11:57:00.000Z",
    },
  ],
  unavailableSections: [
    {
      section: "institutional_state/ledger",
      reason: "access_denied",
      detail: "The ledger service refused the read; the binding records the gap rather than an empty section.",
    },
  ],
  dataClassifications: [
    { ref: "repo:vinci-contracts@365fe6ce", classification: "internal" },
    { ref: "evidence-dev-441", classification: "confidential" },
  ],
  publicBriefRef: "public-brief-source-reading",
  selectionDecisions: [
    {
      ref: "repo:vinci-contracts@365fe6ce/README.md",
      decision: "included_truncated",
      reason: "Only the layering section bears on the question; the remainder was dropped to fit.",
    },
  ],
  droppedMandatoryConstraints: [],
  omittedCriticalContradictions: [],
});

export const validSourceRecord = (): SourceRecord => ({
  schemaVersion: 1,
  sourceId: "oracle-source-1",
  requestRef: "oracle-request-1",
  runRef: "run-oracle-1",
  workspaceRef: "ws-institutional-1",
  sourceKind: "repository_file",
  presentationIndex: 1,
  origin: {
    locator: "repo:vinci-contracts/packages/run/src/context-manifest.ts",
    repositoryId: "vinci-contracts",
    repositoryPath: "packages/run/src/context-manifest.ts",
    repositoryRevision: "365fe6ce6adaed1753e322d4e75331f331930131",
    publisher: null,
  },
  time: {
    retrievedAt: "2026-09-06T11:42:00.000Z",
    publishedAt: null,
    updatedAt: null,
    eventAt: null,
  },
  observation: {
    mode: "INDEPENDENT_RETRIEVAL",
    adapterVersion: "git-read/1.2.0",
    contentType: "text/x-typescript",
    encoding: "utf-8",
    observedBytesDigest: DIGEST_B,
    retrievedRange: "lines 1-172",
    retrievalCostMicrousd: 0,
  },
  requestedRange: { kind: "line_range", startLine: 1, endLine: 172 },
  completeness: "FULL_REQUESTED_RANGE",
  coversEntireDocument: false,
  readOutcome: "READ_COMPLETE",
  matchState: "MATCHED",
  content: {
    rawArtifactRef: "artifact-raw-1",
    rawDigest: DIGEST_B,
    extractedArtifactRef: "artifact-extracted-1",
    extractedDigest: DIGEST_C,
    extractionVersion: "text-extract/0.9.1",
    textOffsets: { startOffset: 0, endOffset: 6144 },
    pageLocations: [],
  },
  limitations: [],
  policy: {
    classification: "internal",
    permittedAudiences: ["institutional_workspace"],
    retentionRule: "retention:days_90",
    researchUse: "permitted",
    trainingUse: "unknown",
  },
  relationships: [],
});

/** SRC-02's other arm: the vendor said so, and that is all this record claims. */
export const validProviderReportedSource = (): SourceRecord => ({
  ...validSourceRecord(),
  sourceId: "oracle-source-2",
  sourceKind: "provider_research_response",
  presentationIndex: 2,
  origin: {
    locator: "https://example.invalid/whitepaper",
    repositoryId: null,
    repositoryPath: null,
    repositoryRevision: null,
    publisher: "Example Standards Body",
  },
  // Four times that are genuinely four different facts: retrieved today,
  // published in 2019, revised in 2021, about an event in 2014.
  time: {
    retrievedAt: "2026-09-06T11:45:00.000Z",
    publishedAt: "2019-03-01T00:00:00.000Z",
    updatedAt: "2021-07-14T00:00:00.000Z",
    eventAt: "2014-11-02T00:00:00.000Z",
  },
  observation: {
    mode: "PROVIDER_REPORTED",
    providerId: "provider-research-1",
    providerReceiptRef: "provider-receipt-88",
    retrievedRange: null,
    retrievalCostMicrousd: 1500,
  },
  requestedRange: { kind: "search_query", query: "requested range versus full document" },
  completeness: "SNIPPET_ONLY",
  coversEntireDocument: false,
  readOutcome: "READ_PARTIAL",
  matchState: "MATCHED",
  limitations: ["provider_only_attribution", "truncated"],
  content: {
    rawArtifactRef: "artifact-raw-2",
    rawDigest: DIGEST_C,
    extractedArtifactRef: null,
    extractedDigest: null,
    extractionVersion: "provider-passthrough/1.0.0",
    textOffsets: null,
    pageLocations: [2, 3],
  },
});

/** SRC-04's failed arm: a typed read result, not a success with empty text. */
export const validFailedReadSource = (): SourceRecord => ({
  ...validSourceRecord(),
  sourceId: "oracle-source-3",
  sourceKind: "web_document",
  presentationIndex: null,
  origin: {
    locator: "https://example.invalid/sealed.pdf",
    repositoryId: null,
    repositoryPath: null,
    repositoryRevision: null,
    publisher: null,
  },
  observation: {
    mode: "INDEPENDENT_RETRIEVAL",
    adapterVersion: "http-read/3.0.0",
    contentType: "application/pdf",
    encoding: "binary",
    observedBytesDigest: DIGEST_C,
    retrievedRange: null,
    retrievalCostMicrousd: null,
  },
  requestedRange: { kind: "entire_document" },
  completeness: "NOT_OBTAINED",
  coversEntireDocument: null,
  readOutcome: "UNSUPPORTED_FORMAT",
  matchState: "NOT_SEARCHED",
  content: null,
  limitations: ["unsupported_format"],
});

export const validSourceCitation = (): SourceCitation => ({
  schemaVersion: 1,
  envelopeKind: "oracle_source_citation",
  workspaceRef: "ws-institutional-1",
  principal: { kind: "worker", workerId: "worker-oracle-1" },
  runRef: "run-oracle-1",
  workOrderRef: "wo-oracle-1",
  policyRef: "policy.oracle.research",
  policyVersion: 3,
  grantRefs: ["grant-read-institutional"],
  budgetReservationRef: null,
  contextManifestDigest: BOUND_MANIFEST_DIGEST,
  issuedAt: "2026-09-06T12:05:00.000Z",
  attestedBy: { component: "oracle-report-host", version: "1.4.0" },
  hostResolved: {
    citationId: "oracle-citation-1",
    appearsInRef: "oracle-report-1#findings/0",
  },
  payload: {
    sourceId: "oracle-source-1",
    quotedSpan: { startOffset: 120, endOffset: 480 },
    offeredFor: "The manifest requires a trust label on every entry.",
  },
});

/** Reverse every object's key order, recursively. Same content, different insertion order. */
export function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]));
  }
  return value;
}
