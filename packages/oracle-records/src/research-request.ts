import {
  fail,
  ok,
  toPlainRecord,
  type Actor,
  type PlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { digestValidated } from "./digest.ts";
import { validateAttestedEnvelope, type AttestedEnvelope, type ModelAuthored } from "./envelope.ts";
import {
  checkSchemaVersion,
  isCanonicalTimestamp,
  isDigest,
  isEnumMember,
  isIdentifier,
  isNonNegativeInt,
  isObjectRecord,
  isPositiveInt,
  isProseText,
  isRefText,
  issue,
  plainActor,
  readCost,
  readEnum,
  readEnumArray,
  readRefArray,
  rejectUnknownFields,
} from "./lib/validate.ts";

/**
 * The immutable question contract of §5.2.
 *
 * Ten field groups, split across the CON-03 line rather than listed in one
 * object. The spec's own producer column is the split: Identity, Ownership,
 * Scope, Authority, Effort and Lineage are resolved by the admission host and
 * the authenticated runtime, while the Decision the requester states and the
 * Freshness and Completion terms they ask for are the authored half. Scope in
 * particular is a POLICY INTERSECTION and not a model choice, which is why it
 * sits under `hostResolved` and why a payload cannot express it at all.
 */

/** §5.2 Effort: what kind of investigation this is. */
export const RESEARCH_MODES = [
  "investigation",
  "verification",
  "monitoring",
  "exploration",
] as const;
export type ResearchMode = (typeof RESEARCH_MODES)[number];

/** §5.2 Decision: what the answer must contain to be usable. */
export const REQUIRED_OUTPUTS = [
  "claim_level_evidence",
  "material_unknowns",
  "alternatives_including_no_change",
  "bounded_proposal",
  "falsification_test",
] as const;
export type RequiredOutput = (typeof REQUIRED_OUTPUTS)[number];

/** §5.2 Completion: the stop rules, fixed before execution. */
export const STOP_CONDITIONS = [
  "decision_has_sufficient_evidence",
  "remaining_uncertainty_requires_internal_measurement",
  "approved_budget_or_deadline_reached",
  "acceptance_criteria_met",
  "attention_budget_exhausted",
] as const;
export type StopCondition = (typeof STOP_CONDITIONS)[number];

/**
 * §5.2 Freshness. A historical question and a current one are answered from
 * different evidence, and a source that satisfies one can be wrong for the
 * other; the request has to say which it is rather than leaving a reader to
 * infer it from a cutoff that may be absent.
 */
export const FRESHNESS_HORIZONS = ["historical", "current"] as const;
export type FreshnessHorizon = (typeof FRESHNESS_HORIZONS)[number];

/** §5.2 Scope: what class of work this request belongs to. */
export const RESEARCH_TASK_CLASSES = [
  "institutional_research",
  "source_verification",
  "incident_investigation",
  "portfolio_exploration",
] as const;
export type ResearchTaskClass = (typeof RESEARCH_TASK_CLASSES)[number];

/** §5.2 Authority: how much this request may READ. */
export const ORACLE_READ_SCOPES = ["request_scope_only", "workspace_wide"] as const;
export type OracleReadScope = (typeof ORACLE_READ_SCOPES)[number];

/**
 * §5.2 Authority: how much this request may PROPOSE.
 *
 * Both members are advisory, and that is INV-01 made structural rather than
 * documented: there is no member of this vocabulary that confers execution, so
 * a request cannot be admitted with one. A future need to execute is a new
 * authority path and a schema version, not another string here.
 */
export const ORACLE_PROPOSE_SCOPES = [
  "advisory_only",
  "advisory_with_job_shape_ref",
] as const;
export type OracleProposeScope = (typeof ORACLE_PROPOSE_SCOPES)[number];

/** §5.2 Lineage: how this request relates to its parent, if it has one. */
export const REQUEST_CHILD_RELATIONSHIPS = ["none", "refinement", "split", "recheck"] as const;
export type RequestChildRelationship = (typeof REQUEST_CHILD_RELATIONSHIPS)[number];

/** Where an admission-time assumption came from. REQ-02: assumptions are LABELED. */
export const ASSUMPTION_BASES = [
  "requester_default",
  "ratified_default",
  "prior_investigation",
] as const;
export type AssumptionBasis = (typeof ASSUMPTION_BASES)[number];

/**
 * REQ-02's four classes of thing that cannot be guessed.
 *
 * They are named separately rather than lumped into "missing required field"
 * because the remedy differs: a missing identity is answered by authenticating,
 * a missing authority by issuing a grant, a missing protected-data scope by a
 * policy decision, and a missing decision parameter by asking the requester one
 * specific question. "Please provide more context" is the answer that fits all
 * four and helps with none, which is exactly what REQ-02 forbids.
 */
export const MISSING_ELEMENT_CLASSES = [
  "authority",
  "identity",
  "protected_data_scope",
  "decision_parameter",
] as const;
export type MissingElementClass = (typeof MISSING_ELEMENT_CLASSES)[number];

/**
 * The elements REQ-02 says cannot be guessed, by exact location.
 *
 * A table rather than a set of `if` statements, so `admitResearchRequest` and
 * the assumption rule below read the SAME list. They previously could not have:
 * one function's idea of "critical" and another's is the divergence that lets
 * an assumption be labeled over an element the first function refused to guess.
 */
export const CRITICAL_ELEMENTS: readonly {
  readonly element: MissingElementClass;
  readonly path: string;
  readonly reason: string;
}[] = [
  { element: "authority", path: "/policyRef", reason: "the applicable ratified policy is resolved by the authority path, never inferred" },
  { element: "authority", path: "/grantRefs", reason: "existing grants are resolved by the authority path, never inferred" },
  { element: "authority", path: "/hostResolved/authority", reason: "the read and propose scopes are a policy intersection" },
  { element: "identity", path: "/workspaceRef", reason: "a missing workspace cannot resolve to a personal or another organization's workspace" },
  { element: "identity", path: "/principal", reason: "the requesting principal is authenticated, never asserted" },
  { element: "identity", path: "/hostResolved/missionOwner", reason: "the accountable mission owner is an identity, not a preference" },
  { element: "identity", path: "/hostResolved/intendedRecipient", reason: "delivering to a guessed recipient is a disclosure" },
  { element: "protected_data_scope", path: "/hostResolved/scope", reason: "permitted repositories, evidence and exclusions are a policy intersection" },
  { element: "decision_parameter", path: "/payload/decisionToInform", reason: "REQ-01: a request must name the decision or uncertainty it informs" },
  { element: "decision_parameter", path: "/payload/question", reason: "REQ-01: a request must state the question" },
  { element: "decision_parameter", path: "/payload/requiredOutput", reason: "what the answer must contain is fixed before execution" },
];

/**
 * The elements an admission host MAY fill with a labeled assumption.
 *
 * A closed list, and the complement of the critical table above rather than a
 * looser "anything not critical": REQ-02 permits assumptions over NONCRITICAL
 * details, and an open rule would let the next optional field added to this
 * schema become assumable without anyone deciding that it should be.
 */
export const ASSUMABLE_ELEMENTS = [
  "/hostResolved/originatingEventRef",
  "/hostResolved/lineage/parentInvestigationRef",
  "/payload/freshness/asOfCutoff",
  "/payload/completion/deliveryDestination",
] as const;
export type AssumableElement = (typeof ASSUMABLE_ELEMENTS)[number];

/** One admission-time assumption, and where it came from. */
export type LabeledAssumption = {
  readonly about: AssumableElement;
  readonly assumed: string;
  readonly basis: AssumptionBasis;
};

/** §5.2 Scope. A policy intersection, resolved by the host. */
export type ResearchRequestScope = {
  readonly repositoryRefs: readonly string[];
  readonly evidenceRefs: readonly string[];
  readonly exclusions: readonly string[];
  readonly taskClass: ResearchTaskClass;
};

/** §5.2 Authority. Read and propose scope only; see ORACLE_PROPOSE_SCOPES. */
export type ResearchRequestAuthority = {
  readonly readScope: OracleReadScope;
  readonly proposeScope: OracleProposeScope;
};

/** §5.2 Effort, including the parent budget reservation's actual size. */
export type ResearchEffort = {
  readonly mode: ResearchMode;
  readonly maxWallSeconds: number;
  readonly maxToolCalls: number;
  readonly maxBytes: number;
  readonly maxTokens: number;
  /**
   * The ceiling this request may spend, in micro-USD. Zero is a legitimate
   * value — a request that may consume no metered resource at all is how a
   * cache-only or manifest-only investigation is expressed — so it is
   * distinguished from a negative value, which is refused, and from a missing
   * one, which is refused separately (CON-02, T06).
   */
  readonly budgetMicrousd: number;
  readonly attentionBudget: {
    readonly interruptions: number;
    readonly decisions: number;
  };
  /**
   * REQ-01: broad exploration is permitted only under an explicitly approved
   * exploration portfolio. Required and explicitly null for every other mode,
   * so "no portfolio" is a statement rather than an omission.
   */
  readonly explorationPortfolioRef: string | null;
};

/** §5.2 Lineage. */
export type RequestLineage = {
  readonly parentInvestigationRef: string | null;
  readonly childRelationship: RequestChildRelationship;
  /** REQ-03. Reused with the same request digest, this returns one identity. */
  readonly idempotencyKey: string;
  readonly version: number;
};

/** Everything §5.2 assigns to the admission host or the authenticated runtime. */
export type ResearchRequestHost = {
  readonly requestId: string;
  readonly originatingEventRef: string | null;
  readonly missionOwner: Actor;
  readonly intendedRecipient: Actor;
  readonly scope: ResearchRequestScope;
  readonly authority: ResearchRequestAuthority;
  readonly contextSnapshotRefs: readonly string[];
  readonly effort: ResearchEffort;
  readonly lineage: RequestLineage;
  readonly admissionAssumptions: readonly LabeledAssumption[];
};

/**
 * Everything §5.2 assigns to the requester: the decision, the question, and the
 * terms on which an answer counts as delivered.
 *
 * `ModelAuthored` is not decoration. It is what makes "a model cannot widen its
 * own scope" a compile error rather than a review comment — adding
 * `policyRef: string` here types as `never` and the record becomes
 * unconstructable at the literal that carries it.
 */
export type ResearchRequestPayload = ModelAuthored<{
  decisionToInform: string;
  question: string;
  requiredOutput: readonly RequiredOutput[];
  consequenceOfNoAnswer: string;
  freshness: {
    horizon: FreshnessHorizon;
    asOfCutoff: string | null;
    mandatoryRechecks: readonly string[];
  };
  completion: {
    acceptanceCriteria: readonly string[];
    stopConditions: readonly StopCondition[];
    deliveryDestination: string;
  };
}>;

export type ResearchRequest = AttestedEnvelope<ResearchRequestHost, ResearchRequestPayload>;

const HOST_FIELDS = [
  "requestId",
  "originatingEventRef",
  "missionOwner",
  "intendedRecipient",
  "scope",
  "authority",
  "contextSnapshotRefs",
  "effort",
  "lineage",
  "admissionAssumptions",
] as const;

export const RESEARCH_REQUEST_PAYLOAD_FIELDS = [
  "decisionToInform",
  "question",
  "requiredOutput",
  "consequenceOfNoAnswer",
  "freshness",
  "completion",
] as const;

function readActor(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isObjectRecord(value) || plainActor(value) === null) {
    issues.push(
      issue(
        path,
        "invalid_actor",
        "expected an actor carrying exactly its own kind's fields (see ACTOR_FIELDS)",
      ),
    );
  }
}

function validateHost(
  value: unknown,
  base: string,
  issues: ValidationIssue[],
): void {
  if (!isObjectRecord(value)) return; // the envelope already said so
  const host = value;
  rejectUnknownFields(host, HOST_FIELDS, base, "the host-resolved half of a research request", issues);

  if (!isIdentifier(host.requestId)) {
    issues.push(issue(`${base}/requestId`, "invalid_id", "requestId is host-assigned"));
  }
  if (host.originatingEventRef !== null && !isRefText(host.originatingEventRef)) {
    issues.push(
      issue(
        `${base}/originatingEventRef`,
        "invalid_ref",
        "originatingEventRef is a ref or explicitly null; a request with no originating event says so",
      ),
    );
  }
  readActor(host.missionOwner, `${base}/missionOwner`, issues);
  readActor(host.intendedRecipient, `${base}/intendedRecipient`, issues);

  const scope = host.scope;
  if (!isObjectRecord(scope)) {
    issues.push(issue(`${base}/scope`, "invalid_type", "scope is an object"));
  } else {
    rejectUnknownFields(
      scope,
      ["repositoryRefs", "evidenceRefs", "exclusions", "taskClass"],
      `${base}/scope`,
      "scope",
      issues,
    );
    readRefArray(scope.repositoryRefs, `${base}/scope/repositoryRefs`, "repositoryRefs", issues);
    readRefArray(scope.evidenceRefs, `${base}/scope/evidenceRefs`, "evidenceRefs", issues);
    readRefArray(scope.exclusions, `${base}/scope/exclusions`, "exclusions", issues);
    readEnum(
      scope.taskClass,
      RESEARCH_TASK_CLASSES,
      `${base}/scope/taskClass`,
      "unknown_task_class",
      "taskClass must come from RESEARCH_TASK_CLASSES",
      issues,
    );
  }

  const authority = host.authority;
  if (!isObjectRecord(authority)) {
    issues.push(issue(`${base}/authority`, "invalid_type", "authority is an object"));
  } else {
    rejectUnknownFields(authority, ["readScope", "proposeScope"], `${base}/authority`, "authority", issues);
    readEnum(
      authority.readScope,
      ORACLE_READ_SCOPES,
      `${base}/authority/readScope`,
      "unknown_read_scope",
      "readScope must come from ORACLE_READ_SCOPES",
      issues,
    );
    readEnum(
      authority.proposeScope,
      ORACLE_PROPOSE_SCOPES,
      `${base}/authority/proposeScope`,
      "unknown_propose_scope",
      "proposeScope must come from ORACLE_PROPOSE_SCOPES; every member is advisory (INV-01)",
      issues,
    );
  }

  readRefArray(host.contextSnapshotRefs, `${base}/contextSnapshotRefs`, "contextSnapshotRefs", issues);

  const effort = host.effort;
  if (!isObjectRecord(effort)) {
    issues.push(issue(`${base}/effort`, "invalid_type", "effort is an object"));
  } else {
    rejectUnknownFields(
      effort,
      [
        "mode",
        "maxWallSeconds",
        "maxToolCalls",
        "maxBytes",
        "maxTokens",
        "budgetMicrousd",
        "attentionBudget",
        "explorationPortfolioRef",
      ],
      `${base}/effort`,
      "effort",
      issues,
    );
    readEnum(
      effort.mode,
      RESEARCH_MODES,
      `${base}/effort/mode`,
      "unknown_research_mode",
      "mode must come from RESEARCH_MODES",
      issues,
    );
    for (const limit of ["maxWallSeconds", "maxToolCalls", "maxBytes", "maxTokens"] as const) {
      if (!isPositiveInt(effort[limit])) {
        issues.push(
          issue(
            `${base}/effort/${limit}`,
            "invalid_limit",
            `${limit} is an integer of at least 1; a limit of zero is a request that cannot run`,
          ),
        );
      }
    }
    readCost(effort.budgetMicrousd, `${base}/effort/budgetMicrousd`, issues);

    const attention = effort.attentionBudget;
    if (!isObjectRecord(attention)) {
      issues.push(issue(`${base}/effort/attentionBudget`, "invalid_type", "attentionBudget is an object"));
    } else {
      rejectUnknownFields(
        attention,
        ["interruptions", "decisions"],
        `${base}/effort/attentionBudget`,
        "attentionBudget",
        issues,
      );
      for (const field of ["interruptions", "decisions"] as const) {
        if (!isNonNegativeInt(attention[field])) {
          issues.push(
            issue(
              `${base}/effort/attentionBudget/${field}`,
              "invalid_type",
              `${field} is a non-negative integer; zero means this request may not spend human attention`,
            ),
          );
        }
      }
    }

    // REQ-01. Exploration is the one mode that is not anchored to a named
    // decision, so it is admitted only against an approved portfolio. Every
    // other mode must say null rather than leave the field out, so "no
    // portfolio" is a claim the record makes and not a gap a reader fills in.
    const portfolio = effort.explorationPortfolioRef;
    if (portfolio !== null && !isRefText(portfolio)) {
      issues.push(
        issue(
          `${base}/effort/explorationPortfolioRef`,
          "invalid_ref",
          "explorationPortfolioRef is a ref or explicitly null",
        ),
      );
    } else if (effort.mode === "exploration" && portfolio === null) {
      issues.push(
        issue(
          `${base}/effort/explorationPortfolioRef`,
          "exploration_without_portfolio",
          "REQ-01: broad exploration is permitted only under an explicitly approved exploration portfolio",
        ),
      );
    }
  }

  const lineage = host.lineage;
  if (!isObjectRecord(lineage)) {
    issues.push(issue(`${base}/lineage`, "invalid_type", "lineage is an object"));
  } else {
    rejectUnknownFields(
      lineage,
      ["parentInvestigationRef", "childRelationship", "idempotencyKey", "version"],
      `${base}/lineage`,
      "lineage",
      issues,
    );
    const parent = lineage.parentInvestigationRef;
    if (parent !== null && !isRefText(parent)) {
      issues.push(
        issue(`${base}/lineage/parentInvestigationRef`, "invalid_ref", "parentInvestigationRef is a ref or explicitly null"),
      );
    }
    readEnum(
      lineage.childRelationship,
      REQUEST_CHILD_RELATIONSHIPS,
      `${base}/lineage/childRelationship`,
      "unknown_child_relationship",
      "childRelationship must come from REQUEST_CHILD_RELATIONSHIPS",
      issues,
    );
    // A root investigation says "none" AND has no parent. The two fields
    // disagreeing is a lineage nobody can follow, so it is refused rather than
    // resolved in favour of one of them.
    if (parent === null && lineage.childRelationship !== "none" && isEnumMember(lineage.childRelationship, REQUEST_CHILD_RELATIONSHIPS)) {
      issues.push(
        issue(
          `${base}/lineage/childRelationship`,
          "child_relationship_without_parent",
          "a child relationship names a parent investigation; a root investigation is \"none\"",
        ),
      );
    }
    if (!isRefText(lineage.idempotencyKey)) {
      issues.push(
        issue(`${base}/lineage/idempotencyKey`, "required_field", "REQ-03 requires an idempotency key"),
      );
    }
    if (!isPositiveInt(lineage.version)) {
      issues.push(issue(`${base}/lineage/version`, "invalid_type", "version is an integer of at least 1"));
    }
  }

  const assumptions = host.admissionAssumptions;
  if (!Array.isArray(assumptions)) {
    issues.push(issue(`${base}/admissionAssumptions`, "invalid_type", "admissionAssumptions is an array"));
  } else {
    const criticalPaths = new Set(CRITICAL_ELEMENTS.map((entry) => entry.path));
    assumptions.forEach((raw, i) => {
      const path = `${base}/admissionAssumptions/${i}`;
      if (!isObjectRecord(raw)) {
        issues.push(issue(path, "invalid_type", "an assumption is an object"));
        return;
      }
      rejectUnknownFields(raw, ["about", "assumed", "basis"], path, "an assumption", issues);
      // REQ-02, the half that is easy to leave out: it is not enough that the
      // host refuses to GUESS a critical element — it must also be unable to
      // record having assumed one. Otherwise the refusal above is bypassed by
      // admitting the request with the guess written down as an assumption.
      if (criticalPaths.has(raw.about as string)) {
        issues.push(
          issue(
            `${path}/about`,
            "assumption_over_critical_element",
            "REQ-02: authority, identity, protected-data scope and essential decision parameters cannot be guessed, labeled or otherwise",
          ),
        );
      } else if (!isEnumMember(raw.about, ASSUMABLE_ELEMENTS)) {
        issues.push(
          issue(`${path}/about`, "unknown_assumable_element", "about must name a member of ASSUMABLE_ELEMENTS"),
        );
      }
      if (!isProseText(raw.assumed)) {
        issues.push(issue(`${path}/assumed`, "required_field", "an assumption states what was assumed"));
      }
      readEnum(raw.basis, ASSUMPTION_BASES, `${path}/basis`, "unknown_assumption_basis", "basis must come from ASSUMPTION_BASES", issues);
    });
  }
}

function validatePayload(value: unknown, base: string, issues: ValidationIssue[]): void {
  if (!isObjectRecord(value)) return; // the envelope already said so
  const payload = value;
  rejectUnknownFields(
    payload,
    RESEARCH_REQUEST_PAYLOAD_FIELDS,
    base,
    "the model-authored half of a research request",
    issues,
  );

  // REQ-01: the request names a decision or uncertainty and states a question.
  if (!isProseText(payload.decisionToInform)) {
    issues.push(
      issue(
        `${base}/decisionToInform`,
        "required_field",
        "REQ-01: a request names the decision or uncertainty it informs",
      ),
    );
  }
  if (!isProseText(payload.question)) {
    issues.push(issue(`${base}/question`, "required_field", "a request states its question"));
  }
  if (!isProseText(payload.consequenceOfNoAnswer)) {
    issues.push(
      issue(
        `${base}/consequenceOfNoAnswer`,
        "required_field",
        "REQ-01: what happens if this is not answered is what makes the use operational",
      ),
    );
  }
  if (Array.isArray(payload.requiredOutput) && payload.requiredOutput.length === 0) {
    issues.push(
      issue(
        `${base}/requiredOutput`,
        "empty_required_output",
        "an empty required output is not the same as an unspecified one; say what the answer must contain",
      ),
    );
  } else {
    readEnumArray(
      payload.requiredOutput,
      REQUIRED_OUTPUTS,
      `${base}/requiredOutput`,
      "unknown_required_output",
      "requiredOutput members come from REQUIRED_OUTPUTS",
      issues,
    );
  }

  const freshness = payload.freshness;
  if (!isObjectRecord(freshness)) {
    issues.push(issue(`${base}/freshness`, "invalid_type", "freshness is an object"));
  } else {
    rejectUnknownFields(
      freshness,
      ["horizon", "asOfCutoff", "mandatoryRechecks"],
      `${base}/freshness`,
      "freshness",
      issues,
    );
    readEnum(
      freshness.horizon,
      FRESHNESS_HORIZONS,
      `${base}/freshness/horizon`,
      "unknown_freshness_horizon",
      "horizon must come from FRESHNESS_HORIZONS",
      issues,
    );
    if (freshness.asOfCutoff !== null && !isCanonicalTimestamp(freshness.asOfCutoff)) {
      issues.push(
        issue(
          `${base}/freshness/asOfCutoff`,
          "invalid_timestamp",
          "asOfCutoff is a canonical timestamp or explicitly null",
        ),
      );
    }
    readRefArray(freshness.mandatoryRechecks, `${base}/freshness/mandatoryRechecks`, "mandatoryRechecks", issues);
  }

  const completion = payload.completion;
  if (!isObjectRecord(completion)) {
    issues.push(issue(`${base}/completion`, "invalid_type", "completion is an object"));
  } else {
    rejectUnknownFields(
      completion,
      ["acceptanceCriteria", "stopConditions", "deliveryDestination"],
      `${base}/completion`,
      "completion",
      issues,
    );
    if (Array.isArray(completion.acceptanceCriteria) && completion.acceptanceCriteria.length === 0) {
      issues.push(
        issue(
          `${base}/completion/acceptanceCriteria`,
          "empty_acceptance_criteria",
          "acceptance criteria are fixed before execution; an empty list is a request nothing can complete",
        ),
      );
    } else if (!Array.isArray(completion.acceptanceCriteria)) {
      issues.push(issue(`${base}/completion/acceptanceCriteria`, "invalid_type", "acceptanceCriteria is an array"));
    } else {
      completion.acceptanceCriteria.forEach((entry, i) => {
        if (!isProseText(entry)) {
          issues.push(
            issue(`${base}/completion/acceptanceCriteria/${i}`, "invalid_type", "an acceptance criterion is a statement"),
          );
        }
      });
    }
    readEnumArray(
      completion.stopConditions,
      STOP_CONDITIONS,
      `${base}/completion/stopConditions`,
      "unknown_stop_condition",
      "stopConditions members come from STOP_CONDITIONS",
      issues,
    );
    if (!isRefText(completion.deliveryDestination)) {
      issues.push(
        issue(`${base}/completion/deliveryDestination`, "required_field", "a report is delivered somewhere named"),
      );
    }
  }
}

/** Validate a research request: the attested envelope, then both of its halves. */
export function validateResearchRequest(input: unknown): ValidationResult<ResearchRequest> {
  const envelope = validateAttestedEnvelope(input);
  if (!envelope.ok) return envelope;
  const record = envelope.value;
  const issues: ValidationIssue[] = [];

  if (record.envelopeKind !== "oracle_research_request") {
    issues.push(
      issue(
        "/envelopeKind",
        "envelope_kind_mismatch",
        "this envelope carries a different record; a discriminator is refused, not approximately matched",
      ),
    );
  }
  validateHost(record.hostResolved, "/hostResolved", issues);
  validatePayload(record.payload, "/payload", issues);

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as ResearchRequest, {});
}

/**
 * The immutable request digest of REQ-03.
 *
 * Over the WHOLE record — envelope and both halves — because the identity an
 * idempotency key resolves to must change when the scope, authority or budget
 * changes, not only when the question does. A digest over the payload alone
 * would let the same key return the same identity for a request whose
 * permitted repositories had been widened underneath it.
 */
export function researchRequestDigest(request: ResearchRequest): string {
  return digestValidated("research request", validateResearchRequest(request));
}

/** What an admission host recorded when it admitted a request. REQ-03's left-hand side. */
export type AdmittedRequestIdentity = {
  readonly schemaVersion: 1;
  readonly idempotencyKey: string;
  readonly requestId: string;
  readonly requestDigest: string;
};

export function validateAdmittedRequestIdentity(
  input: unknown,
): ValidationResult<AdmittedRequestIdentity> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  rejectUnknownFields(
    record,
    ["schemaVersion", "idempotencyKey", "requestId", "requestDigest"],
    "",
    "an admitted request identity",
    issues,
  );
  checkSchemaVersion(record.schemaVersion, "/schemaVersion", issues);
  if (!isRefText(record.idempotencyKey)) {
    issues.push(issue("/idempotencyKey", "required_field", "an admitted identity carries its idempotency key"));
  }
  if (!isIdentifier(record.requestId)) {
    issues.push(issue("/requestId", "invalid_id", "requestId is host-assigned"));
  }
  if (!isDigest(record.requestDigest)) {
    issues.push(issue("/requestDigest", "invalid_digest", "requestDigest is 64 lowercase hex characters"));
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as AdmittedRequestIdentity, {});
}

/**
 * REQ-02's three outcomes, which a consumer must be able to tell apart.
 *
 * INCOMPLETE and REFUSED are different answers to different questions, and
 * collapsing them is the failure REQ-02 names: a structurally malformed draft
 * needs fixing, while a well-formed draft missing an authority needs a grant.
 * "Please provide more context" is the sentence that fits both and helps with
 * neither.
 *
 * ADMITTED means admitted to RESEARCH. It is not approval to execute whatever
 * the research eventually recommends — see INV-01 and REQ-03.
 */
export type RequestAdmission =
  | {
      readonly outcome: "ADMITTED";
      readonly request: ResearchRequest;
      readonly requestDigest: string;
      readonly assumptions: readonly LabeledAssumption[];
    }
  | { readonly outcome: "INCOMPLETE"; readonly missing: readonly MissingElement[] }
  | { readonly outcome: "REFUSED"; readonly issues: readonly ValidationIssue[] };

/** One element REQ-02 says cannot be guessed, named precisely. */
export type MissingElement = {
  readonly element: MissingElementClass;
  readonly path: string;
  readonly reason: string;
};

/** Read a JSON-pointer path out of an already-plain record, or undefined. */
function atPointer(root: PlainRecord, pointer: string): unknown {
  let node: unknown = root;
  for (const segment of pointer.split("/").slice(1)) {
    if (!isObjectRecord(node)) return undefined;
    if (!Object.hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

/**
 * Admit a request draft, or say precisely what is missing.
 *
 * The critical-element sweep runs BEFORE full validation on purpose. Run the
 * other way round, a draft missing its policy reference and carrying a
 * malformed timestamp would be reported as a timestamp problem — the first
 * issue the validator happened to reach — and REQ-02's whole point is that the
 * answer names the element that cannot be guessed rather than whatever failed
 * first.
 *
 * ADMITTED confers no execution authority. It is the research contract's
 * acceptance, and INV-01 governs what the eventual output can do with it.
 */
export function admitResearchRequest(input: unknown): RequestAdmission {
  const plain = toPlainRecord(input);
  if (!plain.ok) return { outcome: "REFUSED", issues: plain.issues };
  const draft = plain.value;

  const missing: MissingElement[] = [];
  for (const element of CRITICAL_ELEMENTS) {
    const value = atPointer(draft, element.path);
    // Absent, null and empty are all "not stated" for a critical element, and
    // they are checked together HERE rather than folded together in the schema:
    // CON-02 keeps them distinct as values, while REQ-02 treats all three as
    // "cannot be guessed". Those are different questions about the same field.
    const stated =
      value !== undefined
      && value !== null
      && !(typeof value === "string" && value.trim() === "")
      && !(Array.isArray(value) && value.length === 0)
      // An empty OBJECT was missing from this list, and it is REQ-02's
      // headline case: `hostResolved.authority = {}` is a request that states
      // no read or propose scope, and it was reported as REFUSED with whatever
      // the validator reached first rather than as INCOMPLETE naming
      // `authority`. Three of the eleven critical elements are objects, so the
      // omission covered `authority`, `scope` and both actor fields.
      && !(
        typeof value === "object"
        && !Array.isArray(value)
        && Object.keys(value as Record<string, unknown>).length === 0
      );
    if (!stated) missing.push({ element: element.element, path: element.path, reason: element.reason });
  }
  if (missing.length > 0) return { outcome: "INCOMPLETE", missing };

  const validated = validateResearchRequest(draft);
  if (!validated.ok) return { outcome: "REFUSED", issues: validated.issues };
  return {
    outcome: "ADMITTED",
    request: validated.value,
    requestDigest: researchRequestDigest(validated.value),
    assumptions: validated.value.hostResolved.admissionAssumptions,
  };
}

/**
 * REQ-03's four answers. `KEY_CONFLICT` is the one that must never be silent:
 * reusing a key with a different immutable request is a NAMED conflict, and the
 * caller decides what to do about it. Overwriting is not offered.
 */
export type IdempotencyOutcome =
  | { readonly outcome: "SAME_REQUEST"; readonly requestId: string; readonly requestDigest: string }
  | { readonly outcome: "NEW_REQUEST"; readonly requestDigest: string }
  | { readonly outcome: "KEY_CONFLICT"; readonly issues: readonly ValidationIssue[] }
  | { readonly outcome: "REFUSED"; readonly issues: readonly ValidationIssue[] };

/**
 * Resolve an incoming request against a previously admitted identity.
 *
 * Both arguments are validated through the probed validators before anything is
 * compared, so a malformed prior identity cannot manufacture a `SAME_REQUEST`
 * by carrying whatever digest the incoming request happens to have.
 */
export function resolveIdempotency(prior: unknown, incoming: unknown): IdempotencyOutcome {
  const priorIdentity = validateAdmittedRequestIdentity(prior);
  if (!priorIdentity.ok) return { outcome: "REFUSED", issues: priorIdentity.issues };
  const request = validateResearchRequest(incoming);
  if (!request.ok) return { outcome: "REFUSED", issues: request.issues };

  const digest = researchRequestDigest(request.value);
  if (priorIdentity.value.idempotencyKey !== request.value.hostResolved.lineage.idempotencyKey) {
    return { outcome: "NEW_REQUEST", requestDigest: digest };
  }
  if (priorIdentity.value.requestDigest === digest) {
    // The prior identity's `requestId` is an assertion ALONGSIDE the digest,
    // not covered by it from this function's point of view, and it was returned
    // to the caller unchecked. A stored identity naming a different request id
    // than the record its own digest identifies is internally inconsistent, and
    // handing that id back would attach this request to whatever the caller
    // then looked up.
    if (priorIdentity.value.requestId !== request.value.hostResolved.requestId) {
      return {
        outcome: "KEY_CONFLICT",
        issues: [
          issue(
            "/requestId",
            "prior_identity_request_id_mismatch",
            "REQ-03: the stored identity's digest matches this request but its requestId names a "
              + "different one; a conflict is reported, never resolved by preferring one of them",
          ),
        ],
      };
    }
    return {
      outcome: "SAME_REQUEST",
      requestId: priorIdentity.value.requestId,
      requestDigest: digest,
    };
  }
  return {
    outcome: "KEY_CONFLICT",
    issues: [
      issue(
        "/hostResolved/lineage/idempotencyKey",
        "idempotency_key_conflict",
        "REQ-03: this key already names a request with a different immutable digest; a "
          + "conflict is reported, never resolved by replacing the earlier request",
      ),
    ],
  };
}

export const RESEARCH_REQUEST_SCHEMA_META: SchemaMeta = {
  id: "vinci.oracle.research-request",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};

export const ADMITTED_REQUEST_IDENTITY_SCHEMA_META: SchemaMeta = {
  id: "vinci.oracle.admitted-request-identity",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
