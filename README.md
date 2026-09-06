# @getsimpledirect/vinci-contracts

Shared types and validators for the Vinci platform, used by five repositories (vinci-code, vinci-work, vinci-mobile, vinci-platform, vinci-chat) that currently maintain drifting local copies. This monorepo closes that divergence by defining one canonical set of record types, their shapes, and their validation rules—so teams can build against the same definitions instead of against guesses about what they meant to agree on.

Package names use the organization-owned `@getsimpledirect` scope, published to GitHub Packages for now (public npm when Vinci Code adopts these contracts). The deliberate `vinci-` prefix keeps these contracts namespaced without claiming generic package names.

## The Layer Hierarchy

This repository enforces a strict downward dependency rule: a package may depend only on packages in lower layers, never on its own layer or above. The rule is checked by the gate across package manifests, TypeScript imports, tsconfig project references, and tsconfig path aliases including extends chains. A circular dependency anywhere fails the build, because each layer's validator cannot safely invoke one from a higher layer. The table below is the layering `scripts/check-dependency-graph.mjs` enforces; if they ever disagree, the script is right and this table is stale.

| Layer | Packages |
|-------|----------|
| **0** | `contracts` (scalars, actors, IDs, base types, validation result) |
| **1** | `policy`, `model-classes`, `evidence`, `approvals`, `device-auth` |
| **2** | `receipts`, `run-events`, `work-orders` |
| **3** | `remote-protocol` (session identity, roles, the authority channel) |
| **4** | `session-stream` (the ephemeral human-facing channel of a remote session), `worker-capabilities` (what an adapter can enforce, and the trust level derived from it), `oracle-records` (the Oracle research contract, bound to an existing `ContextManifest`) |

Each layer knows everything below it; nothing above. Packages export only the types and validators they define—never re-export upward.

Three channels, three packages, deliberately not one: `run-events` (layer 2) is the durable, content-minimal record — its payload values are ids, enums, counts, digests, timestamps and flags, never free text; `remote-protocol` (layer 3) carries signed authority commands; `session-stream` (layer 4) carries what a supervising human sees while a worker runs — current action, a bounded diff, a question, a warning — with `retention: "ephemeral"` so it is never mistaken for the record.

`remote-protocol` also defines the signed [`GitHubActionAttribution` v1](docs/github-action-attribution-v1.md) envelope. It binds the central `Actor` and `SessionBindingRef` to an exact pull-request object while recording a shared GitHub login as explicitly non-authoritative transport metadata.

`oracle-records` (layer 4) carries the Oracle research contract: a `ResearchRequest`, an `OracleContextBinding`, a `SourceRecord` and a `SourceCitation`. It sits above `run` because a context binding REFERENCES an existing `ContextManifest` by digest instead of restating it, and `resolveContextBinding` recomputes that digest from the manifest's own bytes — a digest nothing recomputes is a field, not an identity. Its central idea is the envelope/payload split described under `ResearchRequest` below.

`worker-capabilities` (layer 4) answers a different question: what can THIS worker's adapter actually honour? A `WorkerDeclaration` carries a closed `CapabilityMatrix`; the trust level (`inventoried → observed → supervised → governed → assured`) is derived from the matrix, never trusted from the declaration, and a declaration that claims more than it demonstrates is rejected. A UI renders `renderableRemoteCommands(matrix, role)` — the adapter axis intersected with what remote-protocol lets the role issue — and nothing else, so a control is never shown that the system cannot enforce.

## Using the Record Types

Every major record type has a TypeScript type definition and a validation function. To use one, import both the type and its validator, construct a value, and call the validator before storing or transmitting it.

### EvidenceRecord

A single piece of evidence supporting or contradicting an acceptance criterion. Evidence records carry the actor vouching for them, the kind of evidence, and how it was produced (deterministic, execution-based, visual, model-judged, or human-approved).

```typescript
import { toEvidenceId, toWorkerId } from "@getsimpledirect/vinci-contracts";
import {
  validateEvidenceRecord,
  type EvidenceRecord,
} from "@getsimpledirect/vinci-evidence";

const evidence: EvidenceRecord = {
  schemaVersion: 1,
  id: toEvidenceId("evidence-001")!,
  attestation: {
    provenance: "worker_provided",
    actor: {
      kind: "worker",
      workerId: toWorkerId("worker-abc123")!,
    },
  },
  kind: "unit_test",
  mode: "deterministic",
  reliability: "strong",
  sourceKind: "runner",
  assessment: {
    outcome: "supports",
  },
  notTested: [],
  summary: "Unit tests passed 487/487",
  recordedAt: "2026-08-23T14:30:00.000Z",
};

const result = validateEvidenceRecord(evidence);
// Valid: true
```

### VerdictRecord

An independent assessment of whether completed work satisfied its request. Binds the conclusion to the exact artifact evaluated via `snapshotDigest`, states what it covered via `scope`, and lists what was not tested. A verdict with an unscoped or floating assessment cannot be checked later, and cannot be distinguished from a stale one.

```typescript
import { toEvidenceId } from "@getsimpledirect/vinci-contracts";
import {
  validateVerdictRecord,
  type VerdictRecord,
} from "@getsimpledirect/vinci-evidence";

const verdict: VerdictRecord = {
  schemaVersion: 1,
  status: "VERIFIED_PASS",
  snapshotDigest: "1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
  summary: "All acceptance criteria supported by decisive evidence",
  scope: "Login endpoint with OAuth2 flow",
  criterionResults: [
    {
      criterionId: "crit-001",
      status: "supported",
      summary: "OAuth2 token exchange succeeds",
      evidenceIds: [toEvidenceId("evidence-001")!],
    },
  ],
  decisiveEvidenceIds: [toEvidenceId("evidence-001")!],
  unresolvedConditions: [],
  residualRisks: [],
  notTested: [],
  policyVersion: "1.0.0",
  evaluatorVersion: "2.1.0",
  issuedAt: "2026-08-23T14:30:00.000Z",
  expiresAt: null,
  staleWhen: [],
};

const result = validateVerdictRecord(verdict);
// Valid: true
```

### WorkOrder

A durable mission contract for a bounded piece of work. It specifies what "done" means (acceptanceCriteria, fixed before work starts), what authority is granted (grantedAuthority, stated positively), and how much of a human's attention it may cost (attentionBudget). Work without pre-stated criteria is unjudgeable; work without defined authority is undefined.

A mission contract persists across sessions, models, and people: its human owner answers for the mission, its risk classification names the consequential action classes involved, verifier independence is declared rather than assumed, and rollback conditions plus escalation rules are written before execution begins.

```typescript
import { toUserId } from "@getsimpledirect/vinci-contracts";
import {
  validateWorkOrder,
  type WorkOrder,
} from "@getsimpledirect/vinci-work-orders";

const ownerId = toUserId("user-alice");
if (ownerId === null) throw new Error("invalid owner id");

const workOrder: WorkOrder = {
  schemaVersion: 3,
  contractVersion: 1,
  id: "order-001",
  request: "Review and approve the authentication module refactor",
  scope: "packages/auth only",
  acceptanceCriteria: [
    {
      id: "ac-001",
      statement: "OAuth2 flows handle token refresh correctly",
      verifiedBy: "unit tests and integration test with live provider",
    },
  ],
  grantedAuthority: ["read_code", "run_tests", "comment"],
  attentionBudget: {
    interruptions: 3,
    decisions: 1,
    onExhaustion: "block",
  },
  requestedBy: {
    kind: "user",
    userId: ownerId,
  },
  owner: {
    kind: "user",
    userId: ownerId,
  },
  riskClassification: {
    level: "low",
    consequentialClasses: [],
    rationale: "The work is a code review with no production-side action.",
  },
  verifier: {
    kind: "deterministic",
    verifierId: "auth-test-suite",
    independence: "same-worker",
  },
  rollbackConditions: [],
  escalationRules: [
    {
      when: "verifier_unavailable",
      to: { kind: "user", userId: ownerId },
      within: 900,
    },
    {
      when: "policy_undetermined",
      to: { kind: "user", userId: ownerId },
      within: 300,
    },
  ],
  issuedAt: "2026-08-23T14:00:00.000Z",
  expiresAt: "2026-08-24T14:00:00.000Z",
};

const result = validateWorkOrder(workOrder);
// Valid: true
```

Criteria are fixed before execution and change only by amendment, never by edit. `amendWorkOrder(previous, patch, { amendmentId, changedBy, changedAt, reason })` returns the next contract version (`contractVersion + 1`, `supersedes` pointing at the previous one) and a `ContractAmendment` recording who changed what and why. A criterion is never rewritten in place: change its statement and you must remove the old id and add a new one, because verdicts pin to criterion ids. `classifyMateriality` fails closed — only `request`, `attentionBudget`, `escalationRules`, and `expiresAt` are editorial; anything else is material, and `verificationIsStaleAfter(amendment)` tells a consumer to stale its current verdict (the stale verdict stays as history). A reorder of identical criteria is not a change.

### DecisionPacket

Everything a human needs to make one decision, carried rather than referenced. Carries the question, the options, what each option causes, and the evidence the choice rests on. A decision with a link and "see dashboard" charges the person twice: once to be interrupted, then again to assemble context. By then they are deciding while annoyed.

```typescript
import { toEvidenceId } from "@getsimpledirect/vinci-contracts";
import {
  validateDecisionPacket,
  type DecisionPacket,
} from "@getsimpledirect/vinci-work-orders";

const decision: DecisionPacket = {
  schemaVersion: 1,
  id: "decision-001",
  workOrderId: "order-001",
  question: "Should we deploy this change to production?",
  defaultIfUnanswered: "Block the deployment and escalate to the platform team",
  options: [
    {
      id: "opt-approve",
      label: "Approve",
      consequence: "The change is promoted to production immediately",
      irreversible: false,
    },
    {
      id: "opt-reject",
      label: "Request changes",
      consequence: "The worker is asked to revise and resubmit",
      irreversible: false,
    },
  ],
  evidenceIds: [toEvidenceId("evidence-001")!, toEvidenceId("evidence-002")!],
  raisedAt: "2026-08-23T14:30:00.000Z",
  expiresAt: "2026-08-23T15:30:00.000Z",
};

const result = validateDecisionPacket(decision);
// Valid: true
```

### RemoteDecisionState

A remote decision is provisional until the host confirms it. The relay carries authority requests; it does not manufacture authority. Treating the relay's acknowledgement as the decision would let a compromised or buggy relay approve things nobody approved.

```typescript
import {
  validateRemoteDecisionState,
  type RemoteDecisionState,
} from "@getsimpledirect/vinci-remote-protocol";

// Provisional: awaiting host confirmation
const provisional: RemoteDecisionState = {
  kind: "provisional",
  submittedAt: "2026-08-23T14:35:00.000Z",
};
let result = validateRemoteDecisionState(provisional);
// Valid: true

// Confirmed: host has validated it
const confirmed: RemoteDecisionState = {
  kind: "confirmed",
  confirmedAt: "2026-08-23T14:35:15.000Z",
};
result = validateRemoteDecisionState(confirmed);
// Valid: true

// Rejected: host refused it
const rejected: RemoteDecisionState = {
  kind: "rejected_by_host",
  reason: "expired",
};
result = validateRemoteDecisionState(rejected);
// Valid: true
```

### SessionBinding

Routes metadata for a remote session. `organizationId` is nullable (personal workspaces are first-class) but the field is REQUIRED and explicitly null, never absent. An absent organization is indistinguishable from stale context, and a stale organization context authorizing current access is a failure the structure must make impossible.

```typescript
import {
  validateSessionBinding,
  REMOTE_PROTOCOL_VERSION,
  SESSION_BINDING_SCHEMA_META,
  type SessionBinding,
} from "@getsimpledirect/vinci-remote-protocol";

const binding: SessionBinding = {
  // Both versions are required and both are refused on mismatch. A binding with
  // no version is one written before the field existed, which is the skew case
  // rather than a default — see D5.
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  schemaVersion: SESSION_BINDING_SCHEMA_META.version,
  sessionId: "session-abc123" as any,
  runId: "run-xyz789" as any,
  workspaceId: "workspace-001" as any,
  organizationId: "org-acme" as any,
  hostDeviceId: "device-host-001" as any,
  policyId: "policy-v1",
  policyVersion: 2,
  retentionClass: "days_7",
};

const result = validateSessionBinding(binding);
// Valid: true
```

### ResearchRequest

An admitted Oracle research request. Its one structural idea is worth more than its field list: the record is TWO disjoint subtrees. `hostResolved`, and every field of the envelope itself, is written by the attesting component; `payload` is everything a model or a requester wrote. There is no third place.

That split is enforced three ways, and each fails independently. `ModelAuthored<T>` maps any authority-bearing key name in a payload type to `never`, so a payload declaring one does not compile. `validateAttestedEnvelope` walks the whole payload subtree at runtime and refuses an authority-bearing key **by name**, at any depth, with its own `authority_field_in_model_payload` code — because the compiler is not present when JSON arrives from a model. And the same field name is ACCEPTED on the envelope, which is what makes this a rule about who resolved the value rather than a rule about spelling.

```typescript
import { toUserId, toWorkerId } from "@getsimpledirect/vinci-contracts";
import {
  admitResearchRequest,
  researchRequestDigest,
  validateResearchRequest,
  type ResearchRequest,
} from "@getsimpledirect/vinci-oracle-records";

const request: ResearchRequest = {
  schemaVersion: 1,
  envelopeKind: "oracle_research_request",
  // Everything from here to `attestedBy` is host-resolved. A model proposes
  // none of it, and cannot: see the payload below.
  workspaceRef: "ws-institutional-1",
  principal: { kind: "worker", workerId: toWorkerId("worker-oracle-1")! },
  runRef: "run-oracle-1",
  workOrderRef: "wo-oracle-1",
  policyRef: "policy.oracle.research",
  policyVersion: 3,
  grantRefs: ["grant-read-institutional"],
  // Required KEY, nullable VALUE: absent means the budget was never
  // considered, null means it was considered and there is none.
  budgetReservationRef: "budget-reservation-7",
  contextManifestDigest: "15d7e478560348d91f5595faded5a97f3279020640f411c816f48598c4392f94",
  issuedAt: "2026-09-06T12:00:00.000Z",
  attestedBy: { component: "oracle-admission-host", version: "1.4.0" },
  hostResolved: {
    requestId: "oracle-request-1",
    originatingEventRef: null,
    missionOwner: { kind: "user", userId: toUserId("owner-1")! },
    intendedRecipient: { kind: "worker", workerId: toWorkerId("worker-oracle-1")! },
    // Scope is a POLICY INTERSECTION, not a model choice, which is why it
    // lives here and why a payload cannot express it at all.
    scope: {
      repositoryRefs: ["repo:vinci-contracts@365fe6ce"],
      evidenceRefs: [],
      exclusions: ["personal_data", "credentials"],
      taskClass: "source_verification",
    },
    // Every member of ORACLE_PROPOSE_SCOPES is advisory. INV-01 is the
    // vocabulary, not a comment.
    authority: { readScope: "request_scope_only", proposeScope: "advisory_only" },
    contextSnapshotRefs: [],
    effort: {
      mode: "investigation",
      maxWallSeconds: 900,
      maxToolCalls: 40,
      maxBytes: 4_000_000,
      maxTokens: 200_000,
      budgetMicrousd: 0, // zero is a value: this request may spend nothing
      attentionBudget: { interruptions: 1, decisions: 0 },
      explorationPortfolioRef: null,
    },
    lineage: {
      parentInvestigationRef: null,
      childRelationship: "none",
      idempotencyKey: "idem-oracle-1",
      version: 1,
    },
    // REQ-02: a NONCRITICAL detail the requester omitted is carried as a
    // labeled assumption. Authority, identity, protected-data scope and the
    // essential decision parameters cannot be assumed even here.
    admissionAssumptions: [
      {
        about: "/payload/freshness/asOfCutoff",
        assumed: "No cutoff was stated, so the question is read as current.",
        basis: "ratified_default",
      },
    ],
  },
  payload: {
    decisionToInform: "Choose the smallest change needed for truthful source reading.",
    question: "Can the reader distinguish a complete section from a search snippet?",
    requiredOutput: ["claim_level_evidence", "material_unknowns"],
    consequenceOfNoAnswer: "Four read outcomes ship collapsed into one.",
    freshness: { horizon: "current", asOfCutoff: null, mandatoryRechecks: [] },
    completion: {
      acceptanceCriteria: ["Each read outcome is distinguishable from the record alone."],
      stopConditions: ["decision_has_sufficient_evidence"],
      deliveryDestination: "run-oracle-1/report",
    },
    // Adding `policyRef` here would not compile: ModelAuthored maps it to
    // `never`. Arriving over the wire, it is refused as
    // authority_field_in_model_payload rather than as an unknown field.
  },
};

const result = validateResearchRequest(request);
// Valid: true

// ADMITTED means admitted to RESEARCH. It is not approval to execute whatever
// the research eventually recommends.
const admission = admitResearchRequest(request);
// admission.outcome === "ADMITTED"

// REQ-03: the digest covers the WHOLE record, so reusing an idempotency key
// after the scope was widened is a named conflict, not the same request.
const digest = researchRequestDigest(request);
```

### SourceRecord

What was actually observed, and how far that observation reaches. A failed read is a typed result rather than a success record with empty text, and `FULL_REQUESTED_RANGE` never means "the whole document" unless the request was for the whole document.

```typescript
import {
  deliveredHandle,
  resolveCitations,
  validateSourceRecord,
  type SourceRecord,
} from "@getsimpledirect/vinci-oracle-records";

const unreadable: SourceRecord = {
  schemaVersion: 1,
  sourceId: "oracle-source-3",
  requestRef: "oracle-request-1",
  runRef: "run-oracle-1",
  workspaceRef: "ws-institutional-1",
  sourceKind: "web_document",
  // Presentation numbering is a rendering artefact and is not a reference.
  presentationIndex: null,
  origin: {
    locator: "https://example.invalid/sealed.pdf",
    repositoryId: null,
    repositoryPath: null,
    repositoryRevision: null,
    publisher: null,
  },
  // Four times, four different facts. Each is set only when actually known.
  time: {
    retrievedAt: "2026-09-06T11:47:00.000Z",
    publishedAt: null,
    updatedAt: null,
    eventAt: null,
  },
  observation: {
    mode: "INDEPENDENT_RETRIEVAL",
    adapterVersion: "http-read/3.0.0",
    contentType: "application/pdf",
    encoding: "binary",
    observedBytesDigest: "3d".repeat(32),
    retrievedRange: null,
    retrievalCostMicrousd: null,
  },
  requestedRange: { kind: "entire_document" },
  completeness: "NOT_OBTAINED",
  // null, not false: nothing was obtained, so the question has no answer.
  coversEntireDocument: null,
  readOutcome: "UNSUPPORTED_FORMAT",
  matchState: "NOT_SEARCHED",
  // Null exactly when the read obtained nothing. An empty text here is the
  // shape SRC-04 exists to refuse.
  content: null,
  limitations: ["unsupported_format"],
  policy: {
    classification: "public",
    permittedAudiences: ["institutional_workspace"],
    retentionRule: "retention:days_90",
    researchUse: "permitted",
    // A third state, distinct from permitted and prohibited: nobody looked.
    trainingUse: "unknown",
  },
  relationships: [],
};

const parsed = validateSourceRecord(unreadable);
// Valid: true — a failed read is a record, not an error

// A model may cite only a source it was actually handed. An invented id, an
// id from another run or workspace, and the presentation NUMBER each get
// their own refusal code.
if (parsed.ok) {
  const resolution = resolveCitations([], [deliveredHandle(parsed.value)]);
  // resolution.outcome === "RESOLVED"
}
```

### ClaimRecord and ClaimAssessment

A claim states one proposition, scoped narrowly enough that something could check it. An assessment says what a check found — and it is the record this package exists for.

`vinci-chat`'s `lib/harness/grader.ts` returns `{status:'supported'}` from a catch block, and its comment explains why: "the grader must never block an answer". That is correct for a nonblocking consumer chat checker, where a false negative costs a refused reply. It is catastrophic as an institutional assessment, where the costs invert: a check that could not run would report that the claim is supported, and every consumer downstream inherits a conclusion nothing established.

So the two behaviours are separated by construction, not by a comment. `ClaimAssessment` is a union discriminated on `status`, and the `SUPPORTED` arm is the only one carrying `reviewedSpans` and `execution` — a supported assessment cannot be WRITTEN without naming the spans that were read and the reviewer run that completed. `StatusForOutcome` maps every reviewer failure to `CHECK_UNAVAILABLE` at the type level, so an error path that tries to produce `SUPPORTED` does not compile. And `statusForReviewerOutcome` is the runtime half, for the JSON that arrives with no compiler present.

```typescript
import {
  statusForReviewerOutcome,
  validateClaimAssessment,
  type ClaimAssessment,
} from "@getsimpledirect/vinci-oracle-records";

// Every reviewer failure, and every input the function cannot recognise.
statusForReviewerOutcome({ kind: "TIMED_OUT", detail: "wall clock exceeded" });
// "CHECK_UNAVAILABLE"
statusForReviewerOutcome({ kind: "COMPLETED", finding: "SUPPORTS", reviewedSpans: [] });
// "INSUFFICIENT_EVIDENCE" — a completed run over empty material is not support
statusForReviewerOutcome(undefined);
// "CHECK_UNAVAILABLE" — never a throw, because the caller is an error path

const supported: ClaimAssessment = {
  schemaVersion: 1,
  assessmentId: "oracle-assessment-1",
  claimRef: "oracle-claim-1",
  claimDigest: "5e".repeat(32),
  reportDigest: null,
  status: "SUPPORTED",
  evaluator: { kind: "verifier", verifierId: "oracle-provenance-checker", independent: true },
  evaluatorVersion: "provenance-check/2.0.1",
  // CLM-02: which method produced this result, so a consumer can filter on it.
  method: "DETERMINISTIC",
  independence: "A host-run checker with no access to the claim's author.",
  limitations: ["Provenance validation is not semantic fact-checking."],
  // The evidence that earns the status. Neither field exists on any arm a
  // failure can reach, which is what makes SUPPORTED unwritable without them.
  reviewedSpans: [{ sourceId: "oracle-source-1", span: { startOffset: 120, endOffset: 480 } }],
  execution: { completed: true, reviewerRunRef: "reviewer-run-41" },
  issuedAt: "2026-09-06T12:12:00.000Z",
};

validateClaimAssessment(supported).ok;
// true

// And the stored record refuses the same thing the status function does, at the field:
validateClaimAssessment({ ...supported, reviewedSpans: [] });
// { ok: false, issues: [{ path: "/reviewedSpans", code: "unearned_support", ... }] }
```

`NOT_ASSESSED` is deliberately distinct from every other status, including from a check that ran and found nothing. Its arm carries no evaluator and no method at all, because none ran. Absence of assessment must never read as absence of problems.

A `HYPOTHESIS` claim is valid with NO source spans: it is not required to be true before it is investigated, and a validator demanding source support for the future outcome of a proposed experiment would refuse the record the Oracle exists to produce. What it must carry is a discriminating test naming both arms — what would support it AND what would refute it, because one arm is a plan to find agreement.

### ResearchReport and DecisionProposal

A report's completeness, its assessment coverage and its run's terminal state are **three separate fields**, and nothing here derives one from another. A `COMPLETE` report of a run that ended `SUPERSEDED`, with zero assessments, is a valid record — the run stopped being worth doing, and the report still said everything it set out to say. A schema with one `status` field forces whoever writes it to pick one, and the one they pick is the flattering one.

`runTerminal` reuses `packages/run-events`' own vocabularies rather than a fourth private list: `{ kind: "completed", outcome }` from `RUN_OUTCOMES`, `{ kind: "failed", failureCode }` from `RUN_FAILURE_CODES`, or `{ kind: "not_terminal" }` for a report written while the run is still open. The first version of this field was a private four-member list that contradicted run-events on five of its six members, so a report could not say a run ended `SUPERSEDED` or `DUPLICATE` at all — and those are productive terminals, not failures.

Coverage is counts, not a label, and the counts are cross-checked against the claim list: a report cannot declare coverage its own claims contradict. Claim entries REFERENCE a stored assessment; a field named `assessmentStatus` on one is refused by that name (`inline_assessment_status`), because §22.2's warning is that a strict implementation uses the canonical independently stored assessment rather than an inline model-written status.

A `DecisionProposal` is an `AttestedEnvelope`, so the model writes only `payload` — where an authority-bearing key does not compile and is refused at runtime. `authorityToExecute` lives on the host half, typed as the literal `false`: a boundary that could be written `true` is a setting, not a boundary. `mapProposalToJobShape` is the S3 contract and has three answers, not two: `REFUSED` (malformed), `UNMAPPED` (well-formed and not on the allowlist), `MAPPED`. Collapsing the first two into "false" is what "approximately matched" looks like from the inside.

`NO_CHANGE`, `DEFER` and a justified `STOP_PROPOSAL` are valid, complete proposals. A package that refuses everything has not qualified.

### OutcomeRecord

Whether the proposal actually helped, observed rather than assumed. Four distinctions, each of which the record refuses to collapse:

- **Not attempted is not failed.** `NOT_ATTEMPTED` carries no execution evidence, and nothing converts it into `NOT_HELPFUL_OBSERVED`.
- **Unavailable is not zero benefit.** `OBSERVATION_UNAVAILABLE` leaves `uncertaintyResolved` null — unknown, not false.
- **A disproved hypothesis can still be helpful.** `HELPFUL_OBSERVED` with `hypothesisResult: "DISPROVED_BY_RESULT"` is a valid record: it settled the question the report was written to settle.
- **Temporal consistency is not causation.** `linkedFollowThrough`, `temporalAssociation` and `measuredCounterfactual` are three separate fields rather than one ranked enum, and a record claiming causation without a measured comparison is refused.

The report's author cannot self-certify accepted usefulness: a `HELPFUL_OBSERVED` record whose assessing identity equals its authoring identity is refused. That rule is scoped to the class that claims usefulness — the same pair of identities is accepted on `NOT_HELPFUL_OBSERVED`, because a team reporting that its own work did not help is not the failure OUT-02 exists for.

`resolveOutcomeCredits(outcomes, authorizedWork)` answers the cross-record half, and the anchor is its **second argument** — the work orders the host authorized — exactly as `resolveCitations` takes `delivered`. The first version carried a `creditKey` string on the record and keyed on that, which meant two outcomes with identical `proposalRef`, `proposalDigest`, `authorizedWorkRef` and `outcomeClass` took two accepted-work credits by spelling the key differently. A consistency rule is defeated by a consistent lie unless it is anchored to something outside the record making the claim, so the field was removed rather than kept as a label nothing keys on. Naming the work order on the record was not enough either — a record writes that field too — so the resolver looks every claimed work ref up in the set it is handed, and two outcomes citing the same execution evidence are one credit however many work orders they name.

Five answers, not two: `REFUSED` (malformed), `UNAUTHORIZED_WORK` (a work ref no host authorized), `DOUBLE_CREDITED` (two accepted-work credits for one underlying outcome, naming which record already holds it), `MISBOUND_REUSE` (a reuse naming an outcome that holds no credit to reuse), and `CREDITED` — which carries `unresolvedReuse`, the reuses whose original is not in the set handed in. Those are reported rather than refused, because the original may live in a part of the ledger the caller did not pass.

### Cross-record bindings

Every rule in this package that compares one record to another is anchored on something neither record can write, and `src/cross-record-anchors.test.ts` enumerates all of them with the anchor each one uses. There are three anchors and only three: **recomputation** (derive the value from the referenced record's own bytes — `resolveContextBinding`, `resolveIdempotency`, `resolveReportBundle`), **a second argument** the caller supplies from host state (`resolveCitations`, `mapProposalToJobShape`, `resolveOutcomeCredits`), and **the envelope split** (a host-attested half against a model-authored half).

`resolveReportBundle` is what a renderer must go through. It recomputes each claim's digest with `claimRecordDigest` and returns an assessment **only** for a claim it actually binds, so a report and an assessment that agree on a fabricated digest bind nothing. Every negative for these rules is built as a *consistent lie* — all copies made to agree — because a single-copy mutation is what the defeated versions of these rules already passed.

The rules that have **no** anchor are listed in that file too, as limits, each with a test demonstrating the lie succeeding: a report and its claims can agree on a run neither belongs to; a proposal and a report can name each other while both are forged; one party can write both identities on an outcome; and a `ClaimAssessment`'s `claimDigest` is an assertion its own validator cannot check. See `claim-assessment.ts` for why an attested envelope would not close the authoring path either.

## Handling Validation Failures

Every validator returns a `ValidationResult<T>`, which is either `{ ok: true, value: T }` or `{ ok: false, issues: ValidationIssue[] }`. Never check the result after using it—always check first.

A `ValidationIssue` has three fields:
- **path**: JSONPath-like string (`/scope`, `/acceptanceCriteria/0/id`) pointing to the field that failed
- **code**: Machine-readable code safe to switch on (`required_field`, `invalid_timestamp`, `unknown_field`)
- **message**: Human-readable explanation of what went wrong

Here is actual output from a malformed WorkOrder:

```
Valid: false

Issues (path, code, message):
  path: "/scope"
  code: "required_field"
  message: "scope must say what this covers; an unscoped order grants everything"

  path: "/acceptanceCriteria"
  code: "invalid_type"
  message: "acceptanceCriteria is an array"

  path: "/grantedAuthority"
  code: "invalid_type"
  message: "grantedAuthority is an array"

  path: "/attentionBudget"
  code: "not_object"
  message: "expected an object"

  path: "/requestedBy"
  code: "invalid_actor"
  message: "requestedBy must be an actor of kind user, worker, policy, system or verifier, carrying exactly that kind's fields (see ACTOR_FIELDS)"

  path: "/expiresAt"
  code: "invalid_timestamp"
  message: "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z"
```

## Rules That Will Surprise You

### Timestamps: ISO-8601 UTC, Millisecond Precision

Always `YYYY-MM-DDTHH:MM:SS.sssZ` — six digits after the decimal point, exactly. Ordering timestamps as strings is only sound in this exact canonical form. An unvalidated timestamp makes `"2026-1-1"` sort before `"2026-01-02"`, and a non-UTC offset sorts by its text rather than by the instant it represents. The round-trip validation also rejects dates that do not exist—Date.parse normalizes February 29 in a non-leap year to March 1 instead of refusing it, so the pattern alone would admit an impossible date.

### Digests: 64 Lowercase Hex, No Prefix

Always `[0-9a-f]{64}`, never uppercase or with a `sha256:` prefix. Uppercase is rejected so digests compare bytewise without case-folding overhead. A stored digest that drifts to uppercase has drifted, and a receiver must detect the difference, not normalize it away.

### Actors Carry Exactly Their Kind's Fields, No More

Every actor arm has its own field set, enforced by the validator. Five kinds exist:

- **user**: `userId` (required), `deviceId` (optional)
- **worker**: `workerId` (required)
- **policy**: `policyId` (required), `policyVersion` (required, positive integer)
- **system**: `component` (required)
- **verifier**: `verifierId` (required), `independent` (required, boolean)

An actor with foreign fields—a worker carrying `independent: true`, a user with a `workerId`—is rejected. The `kind` field itself is never listed but is always present. Hand-listing which fields are FOREIGN to an arm was tried and failed twice: the list omitted `independent` and `policyVersion`, so a worker could assert its own independence. An allowlist of what BELONGS cannot have that hole.

### Unknown Fields Are Rejected

Most records refuse unknown fields. Silence about coverage reads as coverage: a verdict listing five passing criteria and omitting two it could not evaluate is understood as "all seven are fine", which is precisely the unearned pass this system exists to prevent. Accepting unknown fields would invite the same problem at the record level.

### VERIFIED_PASS Requires All of These

A verdict cannot claim `VERIFIED_PASS` if:
- It has zero criterion results (at least one criterion must be tested)
- Any criterion result is not `"supported"` (all must support the pass)
- There are unresolved conditions (things that must be done before passing)
- There is untested coverage (things that could not be evaluated must be listed, not omitted)
- `decisiveEvidenceIds` is empty (there must be evidence cited for the pass)

These rules exist to prevent the false confidence that an unscoped verdict, an incomplete evaluation, or a missing caveat would produce. A VERIFIED_PASS means "we checked what matters, we found no problems, and here is the evidence."

### An Attention Budget Cannot Say "Proceed Without a Human"

The `ExhaustionPolicy` has exactly two values: `"block"` (stop and wait for more attention) and `"escalate"` (hand the decision up to a different human). There is deliberately no `"proceed"` option.

Remote control of an agent is teleoperation, not autonomy. If a work order could be configured to continue once it stops being able to ask, then the budget would not be a budget—it would be a quota on how much supervision the work receives before proceeding unsupervised, which is the opposite of what it is for. The dangerous configuration is not one somebody would choose maliciously; it is the one somebody would choose at 2am to stop being paged, and which then silently becomes the default everywhere. Both block and escalate keep a human in the loop. Neither can be turned off.

## Running the Gate

The gate is an eleven-part check suite. It runs in GitHub Actions on every
pull request and every push to `main`.

Running is not enforcing, and the difference is the whole point of this file
existing: a workflow that runs on a push reports on a commit that has already
landed. The enforcement lives in branch protection on `main`, where `gate` and
`consumer-install` are configured as required status checks with "up to date
with base" on. That configuration is repository settings, not code in this
repository, so it can be changed without a commit — which is worth knowing
before trusting the word "required" here.

One gap is deliberate and open: `enforce_admins` is off, so a repository admin
can still push directly to `main`. Turning it on makes the requirement true for
everyone at the cost of needing a settings toggle for an emergency fix.

Run the gate locally with:

```bash
npm run gate
```

The eleven checks, in order:

1. **build** — TypeScript compiles without errors or unused variables
2. **lint** — ESLint rules pass (style, naming, common mistakes)
3. **tests** — All unit tests pass
4. **digest vectors (python)** — `packages/work-orders/vectors` is shared between a Node implementation (exercised by `tests`, via `vitest`) and a Python one; this step runs the Python side (`packages/work-orders/python`) against the same vector files so the two languages are checked to agree, not just checked separately
5. **dependency graph** — Layering is respected across four edge mechanisms: manifest dependencies, source imports, tsconfig project references, and tsconfig path aliases including `extends` chains. Also checks transitive reachability and cycles
6. **SchemaMeta conformance** — Every record type exports schema metadata, with closed vocabularies and positive integer versions actually enforced rather than merely present
7. **hostile-key conformance** — Every exported validator and authority guard is probed with inherited property names, accessors, proxies, sparse arrays and prototype tricks. Each guard carries a real allow **and** deny control, because a positive control that cannot fail is not a control
8. **rights-gap reason mapping** — Every unevaluable-rights code (e.g. `rights_undeclared`) maps to a specific field and a specific citing document (e.g. `trainingAllowed` / "OpenRouter terms of service"), so a caller is told exactly what's missing and where it would be declared, never just "rights unknown"
9. **duplicate vocabularies** — No closed string vocabulary is declared twice, comparing const arrays, bare string unions, and inline object-property arrays of three or more members. Thirteen duplications have been found in this codebase; every one agreed when written and would have drifted later
10. **lockstep versions** — All packages share one version and internal dependencies pin to it exactly, so a consumer cannot resolve a combination that was never tested together. Checks every dependency section including `optionalDependencies`, and refuses a manifest carrying a section it does not recognise — a typo like `dependancies` would otherwise be skipped by every check here while looking like a clean scan
11. **no stray scripts** — Repository root holds exactly its allowed files

Several checks report how much they examined and fail if that count is
implausibly low. A scanner that finds nothing looks exactly like a codebase with
nothing to find, and that confusion has hidden real defects here.

A floor turned out not to be enough on its own. Deleting a package made the
lockstep check report "9 packages all at 0.1.0" and exit 0, which reads exactly
like success — a scan that reports on whatever it happens to find cannot tell
you it found less than it should have. The inventory in
`scripts/expected-packages.json` is compared exactly, so adding or removing a
package has to be done deliberately, in the same commit.

A twelfth check runs in CI but not in `npm run gate`, because it installs from the
network and takes minutes:

```bash
npm run check:pack
```

It packs all twelve packages, installs the tarballs into an empty directory outside
this repository, and both type-checks and runs a program that imports every one
of them. Everything else here resolves package names to source through tsconfig
path aliases and project references; a consumer gets `files`, `main` and `types`
instead, and a package can pass the entire gate while being unusable the moment
it is installed. Removing `dist` from one package's `files` list, or pointing
`types` at a file that was never emitted, both pass the gate and both fail this.

If any check fails, the gate exits with code 1 and names the failure.

### `battery/`: adversarial evidence, not a gate step

`battery/` is not part of `npm run gate` or `check:pack` — nothing in this repository
invokes it. It holds six manual probe scripts (`cls.mjs`, `cross.mjs`, `getter.mjs`,
`once.mjs`, `proxy.mjs`, `throw.mjs`) committed as the evidence trail for a
`model-classes` independence-guard fix (#35): "repaired battery finds no further
escape." Each imports a *built* `model-classes/dist/index.js` and probes
`violatesIndependence`/the endpoint guards directly with adversarial inputs — inherited
properties, proxies, sparse arrays — the same hostile-key shapes the gate's own
`hostile-key conformance` step checks, but run by hand against the installed artifact
rather than the source.

As committed, none of them run as-is: every file hardcodes the absolute path an
earlier session imported `dist/index.js` from, on a machine this one isn't. Point the
import at your own `packages/model-classes/dist/index.js` (`npm run build` first) before
running one. Treat these as a historical verification record to read, not a suite to
execute unmodified.
