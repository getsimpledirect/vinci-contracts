import {
  fail,
  ok,
  toPlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { digestValidated } from "./digest.ts";
import { validateAttestedEnvelope, type AttestedEnvelope, type ModelAuthored } from "./envelope.ts";
import { ORACLE_PROPOSE_SCOPES, type OracleProposeScope } from "./research-request.ts";
import {
  checkSchemaVersion,
  isEnumMember,
  isGitObjectId,
  isIdentifier,
  isObjectRecord,
  isProseText,
  isRefText,
  issue,
  readCost,
  readEnum,
  readRefArray,
  readStringList,
  rejectUnknownFields,
} from "./lib/validate.ts";

/**
 * §5.7. What the Oracle may ask for, and the boundary it may not cross.
 *
 * PROP-01 is one sentence with three examples: a STOP_PROPOSAL does not
 * terminate a job, an EXPERIMENT_PROPOSAL does not reserve a GPU, an
 * IMPLEMENTATION_PROPOSAL does not open or merge a PR. The way that is TRUE
 * here rather than promised is that a proposal is an `AttestedEnvelope`: the
 * model writes `payload` and nothing else, `ModelAuthored` maps any
 * authority-bearing key in it to `never`, and `validateAttestedEnvelope`
 * refuses one by name at any depth at runtime. There is no field on the payload
 * capable of expressing execution, and `src/advisory-boundary.test.ts` asserts
 * that over the whole declared field set rather than over one example.
 *
 * The one field that names the boundary is `authorityToExecute`, on the HOST
 * half, typed as the literal `false`. It is there because §22.2's worked
 * example carries it and a reader of the rendered report needs to see it
 * stated; it is typed `false` because a boundary that could be written `true`
 * is a setting, not a boundary.
 */

export const PROPOSAL_KINDS = [
  "ANSWER_ONLY",
  "REQUEST_OBSERVATION",
  "EXPERIMENT_PROPOSAL",
  "IMPLEMENTATION_PROPOSAL",
  "NO_CHANGE",
  "DEFER",
  "STOP_PROPOSAL",
  "ESCALATE",
] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/**
 * The kinds that propose WORK, and therefore owe an acceptance criterion fixed
 * before execution.
 *
 * INV-15 is the reason this is a subset and not the whole vocabulary:
 * NO_CHANGE, DEFER and a justified STOP_PROPOSAL are valid successful outcomes,
 * and demanding "what a completed action must demonstrate" of a proposal whose
 * whole content is that no action should be taken is how a package comes to
 * refuse the answers it exists to produce.
 */
const WORK_PROPOSING_KINDS: readonly ProposalKind[] = [
  "REQUEST_OBSERVATION",
  "EXPERIMENT_PROPOSAL",
  "IMPLEMENTATION_PROPOSAL",
];

/** §5.7 Cost/risks: how far this can be walked back. */
export const PROPOSAL_REVERSIBILITY = ["reversible", "reversible_with_cost", "irreversible"] as const;
export type ProposalReversibility = (typeof PROPOSAL_REVERSIBILITY)[number];

/**
 * PROP-02. Whether current rules can admit this proposal.
 *
 * An inadmissible proposal is RETAINED as advisory with the exact missing
 * decision named. It is not a validation failure — the record is well-formed
 * and says something true — and it is not silently dropped, which is the
 * outcome that leaves a reader unable to tell "nobody proposed anything" from
 * "somebody proposed something nobody was allowed to consider".
 */
export const PROPOSAL_ADMISSIBILITY = ["ADMISSIBLE", "INADMISSIBLE_RETAINED_AS_ADVISORY"] as const;
export type ProposalAdmissibility = (typeof PROPOSAL_ADMISSIBILITY)[number];

/** The exact decision that is missing, and who owns it. PROP-02 forbids "more context". */
export type MissingDecision = {
  readonly decision: string;
  readonly owner: string;
  readonly ruleRef: string | null;
};

export type ProposalAdmissibilityState = {
  readonly state: ProposalAdmissibility;
  readonly missingDecision: MissingDecision | null;
};

/** The host half: which report this proposal belongs to, and what it may not do. */
export type DecisionProposalHost = {
  readonly proposalId: string;
  readonly reportRef: string;
  readonly proposeScope: OracleProposeScope;
  /**
   * Structurally `false`. §22.2's `authority_to_execute: false`.
   *
   * The type is the literal, so there is no value a producer can write here
   * that says otherwise, and the runtime check below refuses anything else by
   * its own name — INV-01: no generated report, confidence score, tool argument
   * or persona statement confers execution authority.
   */
  readonly authorityToExecute: false;
  readonly admissibility: ProposalAdmissibilityState;
};

export type ProposalAlternative = {
  readonly summary: string;
  readonly whyNotChosen: string;
};

export type DecisionProposalPayload = ModelAuthored<{
  kind: ProposalKind;
  basis: {
    reportRef: string;
    claimRefs: readonly string[];
    contextBindingRef: string;
    sourceIds: readonly string[];
  };
  target: {
    decision: string;
    artifactRef: string | null;
    repositoryRevision: string | null;
    workstream: string | null;
  };
  action: string;
  acceptance: string | null;
  proposedJobShapeRef: string | null;
  cost: {
    estimatedMicrousd: number;
    estimatedWallSeconds: number;
    reversibility: ProposalReversibility;
    operationalRisks: readonly string[];
    dataNeeds: readonly string[];
  };
  alternatives: readonly ProposalAlternative[];
  falsifier: string;
  consequences: {
    onSuccess: string;
    onFailure: string;
    onInconclusive: string;
  };
  invalidationConditions: readonly string[];
}>;

export type DecisionProposal = AttestedEnvelope<DecisionProposalHost, DecisionProposalPayload>;

export const DECISION_PROPOSAL_HOST_FIELDS = [
  "proposalId",
  "reportRef",
  "proposeScope",
  "authorityToExecute",
  "admissibility",
] as const;

export const DECISION_PROPOSAL_PAYLOAD_FIELDS = [
  "kind",
  "basis",
  "target",
  "action",
  "acceptance",
  "proposedJobShapeRef",
  "cost",
  "alternatives",
  "falsifier",
  "consequences",
  "invalidationConditions",
] as const;

function validateHostHalf(host: Record<string, unknown>, issues: ValidationIssue[]): void {
  rejectUnknownFields(host, DECISION_PROPOSAL_HOST_FIELDS, "/hostResolved", "a proposal's host half", issues);
  if (!isIdentifier(host.proposalId)) {
    issues.push(issue("/hostResolved/proposalId", "invalid_id", "proposalId is host-assigned"));
  }
  if (!isIdentifier(host.reportRef)) {
    issues.push(
      issue("/hostResolved/reportRef", "invalid_id", "a proposal is bound to the report the host stored"),
    );
  }
  readEnum(
    host.proposeScope,
    ORACLE_PROPOSE_SCOPES,
    "/hostResolved/proposeScope",
    "unknown_propose_scope",
    "proposeScope must come from ORACLE_PROPOSE_SCOPES; both members are advisory, and a member that "
      + "conferred execution would be a new authority path and a schema version, not another string",
    issues,
  );
  if (host.authorityToExecute !== false) {
    issues.push(
      issue(
        "/hostResolved/authorityToExecute",
        "proposal_claims_execution_authority",
        "INV-01/PROP-01: a proposal never carries execution authority. STOP_PROPOSAL does not terminate a "
          + "job, EXPERIMENT_PROPOSAL does not reserve a GPU, IMPLEMENTATION_PROPOSAL does not open a PR",
      ),
    );
  }

  const admissibility = host.admissibility;
  if (!isObjectRecord(admissibility)) {
    issues.push(issue("/hostResolved/admissibility", "invalid_type", "admissibility is an object"));
    return;
  }
  rejectUnknownFields(
    admissibility,
    ["state", "missingDecision"],
    "/hostResolved/admissibility",
    "admissibility",
    issues,
  );
  readEnum(
    admissibility.state,
    PROPOSAL_ADMISSIBILITY,
    "/hostResolved/admissibility/state",
    "unknown_admissibility_state",
    "state must come from PROPOSAL_ADMISSIBILITY",
    issues,
  );
  const missing = admissibility.missingDecision;
  if (missing !== null) {
    if (!isObjectRecord(missing)) {
      issues.push(
        issue(
          "/hostResolved/admissibility/missingDecision",
          "invalid_type",
          "missingDecision is an object or explicitly null",
        ),
      );
    } else {
      rejectUnknownFields(
        missing,
        ["decision", "owner", "ruleRef"],
        "/hostResolved/admissibility/missingDecision",
        "a missing decision",
        issues,
      );
      if (!isProseText(missing.decision)) {
        issues.push(
          issue(
            "/hostResolved/admissibility/missingDecision/decision",
            "required_field",
            "PROP-02: name the exact missing decision. \"Please provide more context\" fits every case and helps with none",
          ),
        );
      }
      if (!isRefText(missing.owner)) {
        issues.push(
          issue(
            "/hostResolved/admissibility/missingDecision/owner",
            "required_field",
            "a missing decision has an owner, or nobody is waiting on anything",
          ),
        );
      }
      if (missing.ruleRef !== null && !isRefText(missing.ruleRef)) {
        issues.push(
          issue(
            "/hostResolved/admissibility/missingDecision/ruleRef",
            "invalid_ref",
            "ruleRef names the rule that cannot admit this, or is explicitly null",
          ),
        );
      }
    }
  }
  if (isEnumMember(admissibility.state, PROPOSAL_ADMISSIBILITY)) {
    if (admissibility.state === "INADMISSIBLE_RETAINED_AS_ADVISORY" && missing === null) {
      issues.push(
        issue(
          "/hostResolved/admissibility/missingDecision",
          "inadmissible_without_missing_decision",
          "PROP-02: an inadmissible proposal is retained as advisory WITH the exact missing decision; "
            + "without it the record says only that something is wrong",
        ),
      );
    }
    if (admissibility.state === "ADMISSIBLE" && missing !== null) {
      issues.push(
        issue(
          "/hostResolved/admissibility/missingDecision",
          "admissible_names_missing_decision",
          "an admissible proposal is missing no decision; naming one contradicts its own state",
        ),
      );
    }
  }
}

function validatePayload(
  payload: Record<string, unknown>,
  host: unknown,
  issues: ValidationIssue[],
): void {
  rejectUnknownFields(
    payload,
    DECISION_PROPOSAL_PAYLOAD_FIELDS,
    "/payload",
    "a proposal's model-authored half",
    issues,
  );
  readEnum(
    payload.kind,
    PROPOSAL_KINDS,
    "/payload/kind",
    "unknown_proposal_kind",
    "PROP-03: kind must come from PROPOSAL_KINDS; an unknown discriminator is refused by name, never "
      + "approximately matched onto the nearest one",
    issues,
  );

  const basis = payload.basis;
  if (!isObjectRecord(basis)) {
    issues.push(issue("/payload/basis", "invalid_type", "basis is an object"));
  } else {
    rejectUnknownFields(
      basis,
      ["reportRef", "claimRefs", "contextBindingRef", "sourceIds"],
      "/payload/basis",
      "a basis",
      issues,
    );
    if (!isIdentifier(basis.reportRef)) {
      issues.push(issue("/payload/basis/reportRef", "invalid_id", "basis names the report it rests on"));
    } else if (isObjectRecord(host) && host.reportRef !== basis.reportRef) {
      // CON-03 from the other side. The host resolved WHICH report this
      // proposal belongs to; the payload states which report the model thinks
      // it read. A disagreement means the proposal is being attached to
      // something other than what it was written about, and the host's answer
      // is the one that counts — so the disagreement is named rather than
      // resolved by preferring one silently.
      issues.push(
        issue(
          "/payload/basis/reportRef",
          "basis_report_mismatch",
          "the model-authored basis names a different report from the one the host bound this proposal to",
        ),
      );
    }
    readRefArray(basis.claimRefs, "/payload/basis/claimRefs", "claimRefs", issues);
    readRefArray(basis.sourceIds, "/payload/basis/sourceIds", "sourceIds", issues);
    if (!isIdentifier(basis.contextBindingRef)) {
      issues.push(
        issue(
          "/payload/basis/contextBindingRef",
          "invalid_id",
          "a proposal names the context binding it was formed under",
        ),
      );
    }
  }

  const target = payload.target;
  if (!isObjectRecord(target)) {
    issues.push(issue("/payload/target", "invalid_type", "target is an object"));
  } else {
    rejectUnknownFields(
      target,
      ["decision", "artifactRef", "repositoryRevision", "workstream"],
      "/payload/target",
      "a target",
      issues,
    );
    if (!isProseText(target.decision)) {
      issues.push(issue("/payload/target/decision", "required_field", "a proposal names the decision it addresses"));
    }
    for (const field of ["artifactRef", "workstream"] as const) {
      if (target[field] !== null && !isRefText(target[field])) {
        issues.push(issue(`/payload/target/${field}`, "invalid_ref", `${field} is a ref or explicitly null`));
      }
    }
    if (target.repositoryRevision !== null && !isGitObjectId(target.repositoryRevision)) {
      issues.push(
        issue(
          "/payload/target/repositoryRevision",
          "invalid_git_object_id",
          "a target revision is 40 lowercase hex characters, or explicitly null",
        ),
      );
    }
  }

  if (!isProseText(payload.action)) {
    issues.push(
      issue("/payload/action", "required_field", "a proposal states the bounded work it proposes"),
    );
  }
  if (payload.acceptance !== null && !isProseText(payload.acceptance)) {
    issues.push(issue("/payload/acceptance", "invalid_type", "acceptance is prose or explicitly null"));
  }
  if (payload.proposedJobShapeRef !== null && !isRefText(payload.proposedJobShapeRef)) {
    issues.push(
      issue(
        "/payload/proposedJobShapeRef",
        "invalid_ref",
        "proposedJobShapeRef names an EXISTING job shape, or is explicitly null; naming one grants nothing",
      ),
    );
  }
  if (!isProseText(payload.falsifier)) {
    issues.push(
      issue(
        "/payload/falsifier",
        "required_field",
        "a proposal says what would show the recommendation was wrong; without one it cannot be tested",
      ),
    );
  }

  const cost = payload.cost;
  if (!isObjectRecord(cost)) {
    issues.push(issue("/payload/cost", "invalid_type", "cost is an object"));
  } else {
    rejectUnknownFields(
      cost,
      ["estimatedMicrousd", "estimatedWallSeconds", "reversibility", "operationalRisks", "dataNeeds"],
      "/payload/cost",
      "a proposal cost",
      issues,
    );
    readCost(cost.estimatedMicrousd, "/payload/cost/estimatedMicrousd", issues);
    readCost(cost.estimatedWallSeconds, "/payload/cost/estimatedWallSeconds", issues);
    readEnum(
      cost.reversibility,
      PROPOSAL_REVERSIBILITY,
      "/payload/cost/reversibility",
      "unknown_reversibility",
      "reversibility must come from PROPOSAL_REVERSIBILITY",
      issues,
    );
    readStringList(cost.operationalRisks, "/payload/cost/operationalRisks", "operationalRisks", issues);
    readStringList(cost.dataNeeds, "/payload/cost/dataNeeds", "dataNeeds", issues);
  }

  if (!Array.isArray(payload.alternatives)) {
    issues.push(issue("/payload/alternatives", "invalid_type", "alternatives is an array"));
  } else {
    payload.alternatives.forEach((raw, i) => {
      const at = `/payload/alternatives/${i}`;
      if (!isObjectRecord(raw)) {
        issues.push(issue(at, "invalid_type", "an alternative is an object"));
        return;
      }
      rejectUnknownFields(raw, ["summary", "whyNotChosen"], at, "an alternative", issues);
      for (const field of ["summary", "whyNotChosen"] as const) {
        if (!isProseText(raw[field])) {
          issues.push(issue(`${at}/${field}`, "required_field", `an alternative states its ${field}`));
        }
      }
    });
    if (payload.alternatives.length === 0) {
      issues.push(
        issue(
          "/payload/alternatives",
          "proposal_without_alternative",
          "§5.7: at least one meaningful alternative, including no-change or a smaller test where relevant. "
            + "A proposal with no alternative has not been compared to anything",
        ),
      );
    }
  }

  const consequences = payload.consequences;
  if (!isObjectRecord(consequences)) {
    issues.push(issue("/payload/consequences", "invalid_type", "consequences is an object"));
  } else {
    rejectUnknownFields(
      consequences,
      ["onSuccess", "onFailure", "onInconclusive"],
      "/payload/consequences",
      "consequences",
      issues,
    );
    for (const field of ["onSuccess", "onFailure", "onInconclusive"] as const) {
      if (!isProseText(consequences[field])) {
        issues.push(
          issue(
            `/payload/consequences/${field}`,
            "required_field",
            "§5.7: which decision changes after success, failure AND an inconclusive result. An "
              + "inconclusive arm is the one a proposal without it silently reads as failure",
          ),
        );
      }
    }
  }

  readStringList(
    payload.invalidationConditions,
    "/payload/invalidationConditions",
    "invalidationConditions",
    issues,
  );

  if (isEnumMember(payload.kind, PROPOSAL_KINDS)) {
    const kind = payload.kind as ProposalKind;
    if (WORK_PROPOSING_KINDS.includes(kind) && payload.acceptance === null) {
      issues.push(
        issue(
          "/payload/acceptance",
          "work_proposal_without_acceptance",
          `§5.7: ${kind} proposes work, so what a completed action must demonstrate is fixed BEFORE `
            + "execution; deciding afterwards is deciding from the result",
        ),
      );
    }
  }
}

/** Validate a decision proposal from untrusted input. */
export function validateDecisionProposal(input: unknown): ValidationResult<DecisionProposal> {
  const envelope = validateAttestedEnvelope(input);
  if (!envelope.ok) return envelope;
  const record = envelope.value;
  const issues: ValidationIssue[] = [];

  checkSchemaVersion(record.schemaVersion, "/schemaVersion", issues);
  if (record.envelopeKind !== "oracle_decision_proposal") {
    issues.push(
      issue(
        "/envelopeKind",
        "envelope_kind_mismatch",
        "this envelope carries a different record; a discriminator is refused, not approximately matched",
      ),
    );
  }

  if (isObjectRecord(record.hostResolved)) validateHostHalf(record.hostResolved, issues);
  if (isObjectRecord(record.payload)) validatePayload(record.payload, record.hostResolved, issues);

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as DecisionProposal, {});
}

/** The identity of a proposal: SHA-256 over its canonical, validated bytes. */
export function decisionProposalDigest(proposal: DecisionProposal): string {
  return digestValidated("decision proposal", validateDecisionProposal(proposal));
}

/** One allowlisted mapping from a proposal kind to an existing job shape. */
export type JobShapeAllowlistEntry = {
  readonly kind: ProposalKind;
  readonly jobShapeRef: string;
};

/**
 * PROP-03 / T11. Whether a proposal maps onto an existing, explicitly
 * allowlisted job shape.
 *
 * Three outcomes rather than a boolean, and the middle one is the point.
 * `REFUSED` means the proposal or the allowlist is malformed; `UNMAPPED` means
 * both are well-formed and this proposal is not one an adapter may carry — a
 * different discriminator, a broader propose scope, a job shape it named
 * itself, or a proposal current rules cannot admit. Collapsing those into
 * "false" is what "approximately matched" looks like from the inside: a caller
 * that cannot tell them apart has no way to act differently.
 *
 * This is a CONTRACT and not an execution path. Nothing here dispatches, opens,
 * reserves or approves anything; S3/WO-10 consumes the answer.
 */
export type ProposalMapping =
  | { readonly outcome: "MAPPED"; readonly kind: ProposalKind; readonly jobShapeRef: string }
  | { readonly outcome: "UNMAPPED"; readonly issues: readonly ValidationIssue[] }
  | { readonly outcome: "REFUSED"; readonly issues: readonly ValidationIssue[] };

export function mapProposalToJobShape(proposal: unknown, allowlist: unknown): ProposalMapping {
  // Both arguments through the inert-snapshot boundary FIRST, as one record —
  // the construction `resolveCitations` arrived at after `Array.isArray` plus
  // `forEach` granted a pass for `new Array(1)`.
  const plain = toPlainRecord({ proposal, allowlist });
  if (!plain.ok) return { outcome: "REFUSED", issues: plain.issues };
  const snapshot = plain.value;

  if (!Array.isArray(snapshot.allowlist)) {
    return {
      outcome: "REFUSED",
      issues: [issue("/allowlist", "invalid_type", "the job-shape allowlist is an array")],
    };
  }
  const entries = new Map<string, string>();
  const refusals: ValidationIssue[] = [];
  snapshot.allowlist.forEach((raw, i) => {
    const at = `/allowlist/${i}`;
    if (!isObjectRecord(raw)) {
      refusals.push(issue(at, "invalid_type", "an allowlist entry is an object"));
      return;
    }
    if (!isEnumMember(raw.kind, PROPOSAL_KINDS)) {
      refusals.push(
        issue(`${at}/kind`, "unknown_proposal_kind", "an allowlist entry names a member of PROPOSAL_KINDS"),
      );
      return;
    }
    if (!isRefText(raw.jobShapeRef)) {
      refusals.push(issue(`${at}/jobShapeRef`, "invalid_ref", "an allowlist entry names an existing job shape"));
      return;
    }
    if (entries.has(raw.kind)) {
      refusals.push(
        issue(
          `${at}/kind`,
          "duplicate_allowlist_kind",
          "one kind maps to one job shape; two entries for one kind make the mapping depend on order",
        ),
      );
      return;
    }
    entries.set(raw.kind, raw.jobShapeRef);
  });
  if (refusals.length > 0) return { outcome: "REFUSED", issues: refusals };

  const parsed = validateDecisionProposal(snapshot.proposal);
  // An extra field, an unknown kind or a malformed record lands here, which is
  // T11's "extra fields, unknown kind, or broader authority request does not
  // approximately match" — the proposal is refused with the field named rather
  // than trimmed to fit a shape.
  if (!parsed.ok) return { outcome: "REFUSED", issues: parsed.issues };
  const record = parsed.value;

  if (record.hostResolved.admissibility.state !== "ADMISSIBLE") {
    return {
      outcome: "UNMAPPED",
      issues: [
        issue(
          "/hostResolved/admissibility/state",
          "inadmissible_proposal_not_mapped",
          "PROP-02: this proposal is retained as advisory with a named missing decision; it is not mapped "
            + "onto a job shape until that decision exists",
        ),
      ],
    };
  }
  if (record.hostResolved.proposeScope !== "advisory_with_job_shape_ref") {
    return {
      outcome: "UNMAPPED",
      issues: [
        issue(
          "/hostResolved/proposeScope",
          "propose_scope_does_not_permit_job_shape",
          "this request was admitted to propose advice only; carrying it into a job shape would widen the "
            + "authority the admission host resolved",
        ),
      ],
    };
  }

  const kind = record.payload.kind;
  const jobShapeRef = entries.get(kind);
  if (jobShapeRef === undefined) {
    return {
      outcome: "UNMAPPED",
      issues: [
        issue(
          "/payload/kind",
          "unmapped_proposal_kind",
          `PROP-03: ${kind} is not in the explicit allowlist. An unlisted kind is refused by name rather `
            + "than mapped onto whichever shape looks closest",
        ),
      ],
    };
  }
  if (record.payload.proposedJobShapeRef !== null && record.payload.proposedJobShapeRef !== jobShapeRef) {
    return {
      outcome: "UNMAPPED",
      issues: [
        issue(
          "/payload/proposedJobShapeRef",
          "job_shape_ref_mismatch",
          "the proposal names a job shape the allowlist does not map this kind to; the allowlist decides, "
            + "and a disagreement is reported rather than resolved in the model's favour",
        ),
      ],
    };
  }
  return { outcome: "MAPPED", kind, jobShapeRef };
}

export const DECISION_PROPOSAL_SCHEMA_META: SchemaMeta = {
  id: "vinci.oracle.decision-proposal",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
