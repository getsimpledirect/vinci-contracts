import { REQUIRED_OUTPUTS } from "./research-request.ts";
import { claimRecordDigest, validateClaimRecord, type ClaimRecord } from "./claim.ts";
import type { ClaimAssessment } from "./claim-assessment.ts";
import type { DecisionProposal } from "./decision-proposal.ts";
import type { OracleContextBinding } from "./oracle-context.ts";
import type { OutcomeRecord } from "./outcome-record.ts";
import type { ResearchReport } from "./research-report.ts";
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

/**
 * The digests the report's claim entries bind to, COMPUTED from the claims.
 *
 * These were fabricated literals — `"5e".repeat(32)` — pinned into both the
 * assessment and the report entry, with a comment explaining that a computed
 * digest "agrees with itself however wrong both are". That reasoning was right
 * about a vector test and wrong here, and a review showed why: the production
 * binding compared those two assertions to each other and never to the claim,
 * so the honest-path positive control exercised no binding at all. A fixture
 * whose digests are made up cannot demonstrate a rule about digests.
 *
 * Computed, so the positive controls bind for real. The NEGATIVES that need a
 * wrong digest state one explicitly at the point of use, where it is visible as
 * the lie it is.
 */
const claimDigestOf = (claim: ClaimRecord): string => {
  const parsed = validateClaimRecord(claim);
  if (!parsed.ok) throw new Error(`fixture claim is invalid: ${JSON.stringify(parsed.issues)}`);
  return claimRecordDigest(parsed.value);
};

/** §5.5's OBSERVED arm: something was read, and the record says where. */
export const validClaimRecord = (): ClaimRecord => ({
  schemaVersion: 1,
  claimId: "oracle-claim-1",
  requestRef: "oracle-request-1",
  runRef: "run-oracle-1",
  workspaceRef: "ws-institutional-1",
  contextManifestDigest: BOUND_MANIFEST_DIGEST,
  claimType: "OBSERVED",
  proposition: "The captured reader refuses an unsupported format rather than returning empty text.",
  applicability: {
    subject: "packages/oracle-records/src/source-record.ts",
    revision: "365fe6ce6adaed1753e322d4e75331f331930131",
    applicableFrom: null,
    applicableUntil: null,
    scope: "captured_source_revision_only; nothing here is a statement about a deployed reader",
  },
  materiality: "DECISION_CHANGING",
  sourceSpans: [{ sourceId: "oracle-source-1", span: { startOffset: 120, endOffset: 480 } }],
  contradictingEvidence: [],
  assumptions: ["The captured revision is the one that would be deployed."],
  derivation: null,
  discriminatingTest: null,
  author: { kind: "worker", workerId: "worker-oracle-1" },
  invalidationConditions: ["The source revision changes.", "The extraction version changes."],
  issuedAt: "2026-09-06T12:10:00.000Z",
});

/**
 * CLM-04's arm, and the one INV-15 exists for: a hypothesis with NO source
 * spans, which is valid because nothing has observed the future outcome of a
 * proposed experiment yet.
 */
export const validHypothesisClaim = (): ClaimRecord => ({
  ...validClaimRecord(),
  claimId: "oracle-claim-2",
  claimType: "HYPOTHESIS",
  proposition: "The installed reader exhibits the same limitation as the captured source.",
  materiality: "SUPPORTING",
  sourceSpans: [],
  applicability: {
    subject: "the installed oracle-records reader",
    revision: null,
    applicableFrom: null,
    applicableUntil: null,
    scope: "installed_artifact; not observed by this run",
  },
  discriminatingTest: {
    test: "Run the approved positive and unavailable-format reader fixtures against the installed artifact.",
    wouldSupport: "The installed reader returns a typed unavailable result for the unsupported format.",
    wouldRefute: "The installed reader returns an empty success record.",
  },
});

/** CLM-03's arm: an inference that says what it rests on. */
export const validInferredClaim = (): ClaimRecord => ({
  ...validClaimRecord(),
  claimId: "oracle-claim-3",
  claimType: "INFERRED",
  proposition: "A consumer reading only `completeness` cannot tell a snippet from a full document.",
  sourceSpans: [{ sourceId: "oracle-source-1", span: null }],
  derivation: {
    premises: [
      "`completeness` describes the requested range, not the document.",
      "`coversEntireDocument` is a separate field.",
    ],
    reasoningSummary:
      "Two fields carry the distinction, so a consumer reading one of them has half of it.",
    analysisRef: null,
  },
});

/** The SUPPORTED arm, which cannot be written without the evidence that earns it. */
export const validSupportedAssessment = (): ClaimAssessment => ({
  schemaVersion: 1,
  assessmentId: "oracle-assessment-1",
  claimRef: "oracle-claim-1",
  claimDigest: claimDigestOf(validClaimRecord()),
  reportDigest: null,
  status: "SUPPORTED",
  evaluator: { kind: "verifier", verifierId: "oracle-provenance-checker", independent: true },
  evaluatorVersion: "provenance-check/2.0.1",
  method: "DETERMINISTIC",
  independence:
    "A provenance checker run by the host, with no access to the claim's author or to the report prose.",
  limitations: ["CLM-02: provenance validation is not semantic fact-checking."],
  reviewedSpans: [{ sourceId: "oracle-source-1", span: { startOffset: 120, endOffset: 480 } }],
  execution: { completed: true, reviewerRunRef: "reviewer-run-41" },
  issuedAt: "2026-09-06T12:12:00.000Z",
});

/** CLM-01's arm: the intended check produced nothing usable, and says which way. */
export const validCheckUnavailableAssessment = (): ClaimAssessment => ({
  schemaVersion: 1,
  assessmentId: "oracle-assessment-2",
  claimRef: "oracle-claim-2",
  claimDigest: claimDigestOf(validHypothesisClaim()),
  reportDigest: null,
  status: "CHECK_UNAVAILABLE",
  evaluator: { kind: "verifier", verifierId: "oracle-installed-reader-probe", independent: true },
  evaluatorVersion: "installed-probe/0.3.0",
  method: "EXECUTION",
  independence: "A probe executing the installed artifact, independent of the run that wrote the claim.",
  limitations: ["The probe never started, so nothing about the installed reader was observed."],
  unavailableReason: "timed_out",
  detail: "The installed-reader probe exceeded its wall clock before producing a result.",
  issuedAt: "2026-09-06T12:13:00.000Z",
});

/** The state that means nobody looked. It carries no evaluator, because there was none. */
export const validNotAssessedAssessment = (): ClaimAssessment => ({
  schemaVersion: 1,
  assessmentId: "oracle-assessment-3",
  claimRef: "oracle-claim-3",
  // The digest of the claim it NAMES. It used to carry claim one's digest while
  // naming claim three — an inconsistency nothing looked at, because nothing
  // compared claimRef either.
  claimDigest: claimDigestOf(validInferredClaim()),
  reportDigest: null,
  status: "NOT_ASSESSED",
  limitations: [],
  notAssessedReason: "No evaluator was scheduled for this claim before the run's budget was reached.",
  issuedAt: "2026-09-06T12:14:00.000Z",
});

/** §22.2's shape: a partial report carrying an unassessed claim, said out loud. */
export const validResearchReport = (): ResearchReport => ({
  schemaVersion: 1,
  reportId: "oracle-report-1",
  requestRef: "oracle-request-1",
  runRef: "run-oracle-1",
  workspaceRef: "ws-institutional-1",
  contextManifestDigest: BOUND_MANIFEST_DIGEST,
  decisionQuestion: "Can the reader distinguish a complete requested section from a search snippet?",
  summary:
    "The captured implementation distinguishes the read outcomes; deployed behaviour was not observed, "
    + "so the smallest next step is a bounded installed-reader test.",
  scope: {
    subject: "institutional source reading",
    observationWindow: {
      startedAt: "2026-09-06T11:40:00.000Z",
      endedAt: "2026-09-06T11:58:00.000Z",
    },
    revisions: [
      { repositoryId: "vinci-contracts", revision: "365fe6ce6adaed1753e322d4e75331f331930131" },
    ],
  },
  reportCompleteness: "PARTIAL",
  assessmentCoverage: { claimsTotal: 2, claimsWithStoredAssessment: 1, claimsNotAssessed: 1 },
  runTerminal: { kind: "not_terminal" },
  claims: [
    { claimRef: "oracle-claim-1", claimDigest: claimDigestOf(validClaimRecord()), assessmentRef: "oracle-assessment-1" },
    { claimRef: "oracle-claim-2", claimDigest: claimDigestOf(validHypothesisClaim()), assessmentRef: null },
  ],
  sourceManifest: [
    {
      sourceId: "oracle-source-1",
      citationRefs: ["oracle-citation-1"],
      completeness: "FULL_REQUESTED_RANGE",
      observationMode: "INDEPENDENT_RETRIEVAL",
      retrievedAt: "2026-09-06T11:42:00.000Z",
    },
  ],
  alternatives: [
    "Change nothing and accept that the installed behaviour is unobserved.",
    "Run the smaller installed-reader fixture instead of the full suite.",
  ],
  contradictions: [],
  materialUnknowns: ["Whether the installed artifact behaves as the captured source does."],
  proposalRef: "oracle-proposal-1",
  stopExplanation: "The installed-reader probe timed out, so the second claim was never assessed.",
  cost: { state: "RECONCILIATION_PENDING", amountMicrousd: null, ledgerRef: "ledger-oracle-14" },
  invalidationConditions: ["The installed artifact is rebuilt.", "The source revision changes."],
  issuedAt: "2026-09-06T12:15:00.000Z",
});

/** §22.2's proposal: a bounded observation request that authorizes nothing. */
export const validDecisionProposal = (): DecisionProposal => ({
  schemaVersion: 1,
  envelopeKind: "oracle_decision_proposal",
  workspaceRef: "ws-institutional-1",
  principal: { kind: "worker", workerId: "worker-oracle-1" },
  runRef: "run-oracle-1",
  workOrderRef: "wo-oracle-1",
  policyRef: "policy.oracle.research",
  policyVersion: 3,
  grantRefs: ["grant-propose-advisory"],
  budgetReservationRef: null,
  contextManifestDigest: BOUND_MANIFEST_DIGEST,
  issuedAt: "2026-09-06T12:16:00.000Z",
  attestedBy: { component: "oracle-report-host", version: "1.4.0" },
  hostResolved: {
    proposalId: "oracle-proposal-1",
    reportRef: "oracle-report-1",
    proposeScope: "advisory_with_job_shape_ref",
    authorityToExecute: false,
    admissibility: { state: "ADMISSIBLE", missingDecision: null },
  },
  payload: {
    kind: "REQUEST_OBSERVATION",
    basis: {
      reportRef: "oracle-report-1",
      claimRefs: ["oracle-claim-1", "oracle-claim-2"],
      contextBindingRef: "oracle-context-binding-1",
      sourceIds: ["oracle-source-1"],
    },
    target: {
      decision: "Whether the installed reader needs a change before the next release.",
      artifactRef: "artifact-installed-reader",
      repositoryRevision: "365fe6ce6adaed1753e322d4e75331f331930131",
      workstream: null,
    },
    action: "Run the approved positive and unavailable-format reader fixtures against the installed artifact.",
    acceptance: "Report actual outcomes and coverage from the installed artifact, including a positive control.",
    proposedJobShapeRef: "job-shape-installed-reader-probe",
    cost: {
      estimatedMicrousd: 40_000,
      estimatedWallSeconds: 600,
      reversibility: "reversible",
      operationalRisks: ["The probe shares a runner with the release gate."],
      dataNeeds: ["Read access to the installed artifact."],
    },
    alternatives: [
      {
        summary: "Change nothing and record the installed behaviour as unobserved.",
        whyNotChosen: "The unknown is the one the decision turns on.",
      },
    ],
    falsifier: "The installed reader returns a typed unavailable result, making the hypothesis wrong.",
    consequences: {
      onSuccess: "The release proceeds with the installed behaviour observed.",
      onFailure: "The reader is changed before the release.",
      onInconclusive: "The probe is rerun with a longer wall clock, or the claim stays unassessed.",
    },
    invalidationConditions: ["The installed artifact is rebuilt."],
  },
});

/** INV-15's arm: no change is a valid, complete answer, and it still owes an alternative. */
export const validNoChangeProposal = (): DecisionProposal => ({
  ...validDecisionProposal(),
  hostResolved: {
    proposalId: "oracle-proposal-2",
    reportRef: "oracle-report-1",
    proposeScope: "advisory_only",
    authorityToExecute: false,
    admissibility: { state: "ADMISSIBLE", missingDecision: null },
  },
  payload: {
    ...validDecisionProposal().payload,
    kind: "NO_CHANGE",
    action: "Keep the current reader and record the installed behaviour as unobserved.",
    acceptance: null,
    proposedJobShapeRef: null,
    alternatives: [
      {
        summary: "Run the installed-reader probe now.",
        whyNotChosen: "The decision it informs is not due until the next release.",
      },
    ],
  },
});

/**
 * OUT-01's combination that a careless schema cannot express: an experiment
 * that DISPROVED its hypothesis and was helpful anyway, because it settled the
 * question the report was written to settle.
 */
export const validOutcomeRecord = (): OutcomeRecord => ({
  schemaVersion: 1,
  outcomeId: "oracle-outcome-1",
  proposalRef: "oracle-proposal-1",
  proposalDigest: DIGEST_B,
  reportRef: "oracle-report-1",
  runRef: "run-oracle-1",
  workspaceRef: "ws-institutional-1",
  authorizedWorkRef: "wo-installed-reader-probe",
  executionEvidenceRefs: ["evidence-probe-run-77"],
  outcomeClass: "HELPFUL_OBSERVED",
  justification:
    "The probe ran and showed the installed reader does NOT share the limitation, which settled the "
    + "question the report was written to settle.",
  observedWindow: { startedAt: "2026-09-07T09:00:00.000Z", endedAt: "2026-09-07T09:12:00.000Z" },
  costMicrousd: 38_000,
  uncertaintyResolved: true,
  hypothesisResult: "DISPROVED_BY_RESULT",
  evidence: {
    linkedFollowThrough: {
      workRef: "wo-installed-reader-probe",
      detail: "The proposed fixtures were the ones that ran.",
    },
    temporalAssociation: null,
    measuredCounterfactual: null,
  },
  causationClaimed: false,
  authoringIdentity: { kind: "worker", workerId: "worker-oracle-1" },
  assessingIdentity: { kind: "verifier", verifierId: "release-verifier-2", independent: true },
  rubricRef: "rubric:oracle-usefulness-v1",
  creditKind: "ACCEPTED_WORK",
  duplicateOfOutcomeRef: null,
  issuedAt: "2026-09-07T09:30:00.000Z",
});

/**
 * The sources the host delivered to this run.
 *
 * Every source id the fixture claims cite. Required by the render bundle, so a
 * test that forgets it fails loudly instead of rendering ids nothing resolved.
 */
export const validDeliveredSources = () => [
  {
    sourceId: "oracle-source-1",
    runRef: "run-oracle-1",
    workspaceRef: "ws-institutional-1",
    presentationIndex: 1,
  },
];

/** Reverse every object's key order, recursively. Same content, different insertion order. */
export function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]));
  }
  return value;
}
