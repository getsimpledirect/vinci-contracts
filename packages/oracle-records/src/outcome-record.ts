import {
  canonicalize,
  fail,
  isStrictlyAfter,
  ok,
  toPlainRecord,
  type Actor,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { digestValidated } from "./digest.ts";
import {
  checkSchemaVersion,
  isCanonicalTimestamp,
  isDigest,
  isEnumMember,
  isIdentifier,
  isObjectRecord,
  isProseText,
  isRefText,
  issue,
  plainActor,
  readCost,
  readEnum,
  readRefArray,
  rejectUnknownFields,
} from "./lib/validate.ts";

/**
 * §5.8. Whether the proposal actually helped, observed rather than assumed.
 *
 * OUT-01 is four distinctions in one sentence and every one of them is a place
 * this record refuses to collapse: not attempted is not failed, unavailable is
 * not zero benefit, and an experiment that DISPROVES its hypothesis can still
 * have been useful — it settled the question, which is what the experiment was
 * for. That last combination is representable here on purpose:
 * `HELPFUL_OBSERVED` with `hypothesisOutcome: "DISPROVED_BY_RESULT"` is a valid
 * record, and a schema that could not express it would quietly teach the system
 * that only confirmations count.
 */

export const OUTCOME_CLASSES = [
  "HELPFUL_OBSERVED",
  "NOT_HELPFUL_OBSERVED",
  "INCONCLUSIVE",
  "NOT_ATTEMPTED",
  "OBSERVATION_UNAVAILABLE",
] as const;
export type OutcomeClass = (typeof OUTCOME_CLASSES)[number];

/** The classes that rest on something actually having been run and watched. */
const OBSERVED_CLASSES: readonly OutcomeClass[] = ["HELPFUL_OBSERVED", "NOT_HELPFUL_OBSERVED"];

/** What the proposal's hypothesis turned out to be. OUT-01's third distinction. */
export const HYPOTHESIS_RESULTS = [
  "SUPPORTED_BY_RESULT",
  "DISPROVED_BY_RESULT",
  "NOT_APPLICABLE",
] as const;
export type HypothesisResult = (typeof HYPOTHESIS_RESULTS)[number];

/**
 * OUT-04. Whether this record takes credit for the work or for reusing it.
 *
 * "Duplicate recommendations may receive reuse credit but not multiple
 * accepted-work credits for the same underlying outcome." The two kinds are
 * separate values rather than a flag because they are separate claims.
 *
 * THE FIRST VERSION OF THIS RECORD CARRIED A `creditKey` STRING AND KEYED THE
 * RULE ON IT, and the comment there said that field was "what makes the rule
 * checkable from outside a single record". It was authored INSIDE the record it
 * was supposed to check. Two outcomes with identical `proposalRef`,
 * `proposalDigest`, `authorizedWorkRef` and `outcomeClass` — provably one
 * underlying outcome — took two accepted-work credits by writing
 * "credit-key-alpha" and "credit-key-beta". The rule established only that
 * identical strings collide, which is a property of strings.
 *
 * A consistency rule needs an ANCHOR outside the thing it is checking. Naming
 * the work order was not enough — a record writes that field too — so the
 * anchor is the authorized-work SET that `resolveOutcomeCredits` takes as its
 * second argument, resolved by the host. A work ref no host authorized resolves
 * to nothing and takes no credit.
 *
 * `NO_CREDIT` is the third member and it is not decoration: a NOT_ATTEMPTED
 * outcome authorized no work, so it holds no accepted-work credit and reuses
 * nothing. Without this member the only way to write that record would be to
 * claim one of the other two, which is how a vocabulary teaches its writers to
 * overstate.
 */
export const OUTCOME_CREDIT_KINDS = ["ACCEPTED_WORK", "REUSE", "NO_CREDIT"] as const;
export type OutcomeCreditKind = (typeof OUTCOME_CREDIT_KINDS)[number];

/**
 * OUT-03. Three evidence strengths, as three separate fields.
 *
 * Not one enum, and that is the whole rule: an enum makes them ordered
 * alternatives, so a record picks the strongest one it can defend and the
 * others vanish. They are different observations that can hold at once —
 * follow-through happened, a later event was consistent, a comparison was
 * measured — and a reader weighing causation needs to see which of the three
 * are actually present. "A later event being consistent with a recommendation
 * does not establish causation."
 */
export type OutcomeEvidence = {
  readonly linkedFollowThrough: { readonly workRef: string; readonly detail: string } | null;
  readonly temporalAssociation: { readonly observedAt: string; readonly detail: string } | null;
  readonly measuredCounterfactual: { readonly comparisonRef: string; readonly detail: string } | null;
};

export type OutcomeWindow = {
  readonly startedAt: string;
  readonly endedAt: string;
};

export type OutcomeRecord = {
  readonly schemaVersion: 1;
  readonly outcomeId: string;
  readonly proposalRef: string;
  /** The EXACT proposal. A digest, so a proposal edited afterwards cannot inherit this outcome. */
  readonly proposalDigest: string;
  readonly reportRef: string;
  readonly runRef: string;
  readonly workspaceRef: string;
  /** The work that was actually authorized, or null when none was. */
  readonly authorizedWorkRef: string | null;
  readonly executionEvidenceRefs: readonly string[];
  readonly outcomeClass: OutcomeClass;
  /** Scoped to this outcome, and required: a class without a justification is a label. */
  readonly justification: string;
  readonly observedWindow: OutcomeWindow | null;
  readonly costMicrousd: number | null;
  /**
   * Whether the ORIGINAL uncertainty was resolved. Null when nothing was
   * observed — which is a third state, not a false.
   */
  readonly uncertaintyResolved: boolean | null;
  readonly hypothesisResult: HypothesisResult;
  readonly evidence: OutcomeEvidence;
  /** Whether this record claims the work CAUSED the result. OUT-03 governs what that requires. */
  readonly causationClaimed: boolean;
  /** Who wrote the report this outcome judges. */
  readonly authoringIdentity: Actor;
  /** Who judged the usefulness. OUT-02: not the same party, for a helpful verdict. */
  readonly assessingIdentity: Actor;
  /** The rubric, predeclared. Judging against a rubric written afterwards is judging from the result. */
  readonly rubricRef: string;
  readonly creditKind: OutcomeCreditKind;
  /**
   * The outcome this record reuses, when `creditKind` is `REUSE`.
   *
   * Null on an `ACCEPTED_WORK` credit, and never this record's own id: an
   * outcome that reuses itself is a second credit wearing a different word.
   * There is deliberately no `creditKey` field beside it — see
   * `outcomeCreditAnchor` for why a self-authored dedup key was removed rather
   * than kept as a label nobody keys on.
   */
  readonly duplicateOfOutcomeRef: string | null;
  readonly issuedAt: string;
};

const OUTCOME_FIELDS = [
  "schemaVersion",
  "outcomeId",
  "proposalRef",
  "proposalDigest",
  "reportRef",
  "runRef",
  "workspaceRef",
  "authorizedWorkRef",
  "executionEvidenceRefs",
  "outcomeClass",
  "justification",
  "observedWindow",
  "costMicrousd",
  "uncertaintyResolved",
  "hypothesisResult",
  "evidence",
  "causationClaimed",
  "authoringIdentity",
  "assessingIdentity",
  "rubricRef",
  "creditKind",
  "duplicateOfOutcomeRef",
  "issuedAt",
] as const;

/** The three evidence arms, each with the one field that identifies it. */
const EVIDENCE_ARMS = [
  ["linkedFollowThrough", "workRef"],
  ["temporalAssociation", "observedAt"],
  ["measuredCounterfactual", "comparisonRef"],
] as const;

function validateEvidence(value: unknown, issues: ValidationIssue[]): void {
  if (!isObjectRecord(value)) {
    issues.push(issue("/evidence", "invalid_type", "evidence is an object"));
    return;
  }
  rejectUnknownFields(
    value,
    EVIDENCE_ARMS.map(([name]) => name),
    "/evidence",
    "outcome evidence",
    issues,
  );
  for (const [name, idField] of EVIDENCE_ARMS) {
    const arm = value[name];
    if (arm === null) continue;
    const at = `/evidence/${name}`;
    if (!isObjectRecord(arm)) {
      issues.push(issue(at, "invalid_type", `${name} is an object or explicitly null`));
      continue;
    }
    rejectUnknownFields(arm, [idField, "detail"], at, `${name}`, issues);
    if (idField === "observedAt") {
      if (!isCanonicalTimestamp(arm[idField])) {
        issues.push(issue(`${at}/${idField}`, "invalid_timestamp", "observedAt is a canonical timestamp"));
      }
    } else if (!isRefText(arm[idField])) {
      issues.push(issue(`${at}/${idField}`, "invalid_ref", `${idField} names what was observed`));
    }
    if (!isProseText(arm.detail)) {
      issues.push(issue(`${at}/detail`, "required_field", `${name} says what was observed`));
    }
  }
}

/** Validate an outcome record from untrusted input. */
export function validateOutcomeRecord(input: unknown): ValidationResult<OutcomeRecord> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  rejectUnknownFields(record, OUTCOME_FIELDS, "", "an outcome record", issues);
  checkSchemaVersion(record.schemaVersion, "/schemaVersion", issues);

  for (const field of ["outcomeId", "proposalRef", "reportRef", "runRef", "workspaceRef"] as const) {
    if (!isIdentifier(record[field])) {
      issues.push(issue(`/${field}`, "invalid_id", `${field} is a host-assigned identifier`));
    }
  }
  if (!isDigest(record.proposalDigest)) {
    issues.push(
      issue(
        "/proposalDigest",
        "invalid_digest",
        "proposalDigest binds this outcome to the EXACT proposal; without it a later edit inherits the credit",
      ),
    );
  }
  if (record.authorizedWorkRef !== null && !isRefText(record.authorizedWorkRef)) {
    issues.push(
      issue("/authorizedWorkRef", "invalid_ref", "authorizedWorkRef is a ref or explicitly null"),
    );
  }
  readRefArray(record.executionEvidenceRefs, "/executionEvidenceRefs", "executionEvidenceRefs", issues);
  readEnum(
    record.outcomeClass,
    OUTCOME_CLASSES,
    "/outcomeClass",
    "unknown_outcome_class",
    "outcomeClass must come from OUTCOME_CLASSES; these are usefulness observations, not blanket "
      + "acceptance verdicts for the underlying work",
    issues,
  );
  readEnum(
    record.hypothesisResult,
    HYPOTHESIS_RESULTS,
    "/hypothesisResult",
    "unknown_hypothesis_result",
    "hypothesisResult must come from HYPOTHESIS_RESULTS",
    issues,
  );
  readEnum(
    record.creditKind,
    OUTCOME_CREDIT_KINDS,
    "/creditKind",
    "unknown_credit_kind",
    "creditKind must come from OUTCOME_CREDIT_KINDS",
    issues,
  );
  if (!isProseText(record.justification)) {
    issues.push(
      issue(
        "/justification",
        "required_field",
        "§5.8: each class carries a scoped justification; a class on its own is a label",
      ),
    );
  }
  if (!isRefText(record.rubricRef)) {
    issues.push(
      issue(
        "/rubricRef",
        "required_field",
        "OUT-02: the rubric is predeclared. Judging against one written after the result is judging from it",
      ),
    );
  }
  if (record.duplicateOfOutcomeRef !== null && !isIdentifier(record.duplicateOfOutcomeRef)) {
    issues.push(
      issue("/duplicateOfOutcomeRef", "invalid_id", "duplicateOfOutcomeRef names another outcome, or is null"),
    );
  }
  if (typeof record.causationClaimed !== "boolean") {
    issues.push(issue("/causationClaimed", "invalid_type", "causationClaimed is a boolean"));
  }
  if (record.uncertaintyResolved !== null && typeof record.uncertaintyResolved !== "boolean") {
    issues.push(
      issue(
        "/uncertaintyResolved",
        "invalid_type",
        "uncertaintyResolved is true, false, or explicitly null when nothing was observed",
      ),
    );
  }
  if (record.costMicrousd !== null) readCost(record.costMicrousd, "/costMicrousd", issues);
  if (!isCanonicalTimestamp(record.issuedAt)) {
    issues.push(issue("/issuedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision"));
  }

  const window = record.observedWindow;
  if (window !== null) {
    if (!isObjectRecord(window)) {
      issues.push(issue("/observedWindow", "invalid_type", "observedWindow is an object or explicitly null"));
    } else {
      rejectUnknownFields(window, ["startedAt", "endedAt"], "/observedWindow", "an observed window", issues);
      for (const field of ["startedAt", "endedAt"] as const) {
        if (!isCanonicalTimestamp(window[field])) {
          issues.push(issue(`/observedWindow/${field}`, "invalid_timestamp", `${field} is a canonical timestamp`));
        }
      }
      if (isStrictlyAfter(window.startedAt, window.endedAt)) {
        issues.push(
          issue("/observedWindow/endedAt", "inverted_window", "an observation window does not end before it starts"),
        );
      }
    }
  }

  validateEvidence(record.evidence, issues);

  const authoring = isObjectRecord(record.authoringIdentity) ? plainActor(record.authoringIdentity) : null;
  const assessing = isObjectRecord(record.assessingIdentity) ? plainActor(record.assessingIdentity) : null;
  if (authoring === null) {
    issues.push(issue("/authoringIdentity", "invalid_actor", "authoringIdentity carries exactly its own kind's fields"));
  }
  if (assessing === null) {
    issues.push(issue("/assessingIdentity", "invalid_actor", "assessingIdentity carries exactly its own kind's fields"));
  }

  // --- the rules the classes exist for -------------------------------------
  if (isEnumMember(record.outcomeClass, OUTCOME_CLASSES)) {
    const outcomeClass = record.outcomeClass as OutcomeClass;
    const evidenceRefs = Array.isArray(record.executionEvidenceRefs) ? record.executionEvidenceRefs : [];

    if (OBSERVED_CLASSES.includes(outcomeClass)) {
      if (record.authorizedWorkRef === null) {
        issues.push(
          issue(
            "/authorizedWorkRef",
            "observed_outcome_without_authorized_work",
            `${outcomeClass} reports what happened when the work ran; without authorized work nothing ran`,
          ),
        );
      }
      if (evidenceRefs.length === 0) {
        issues.push(
          issue(
            "/executionEvidenceRefs",
            "observed_outcome_without_evidence",
            `${outcomeClass} is an OBSERVATION; with no execution or evaluation evidence it is an opinion`,
          ),
        );
      }
    }

    // OUT-01, first clause. Not attempted is not failed — so it carries no
    // execution evidence and claims no observation, and nothing here converts
    // it into NOT_HELPFUL_OBSERVED.
    if (outcomeClass === "NOT_ATTEMPTED") {
      if (record.authorizedWorkRef !== null || evidenceRefs.length > 0) {
        issues.push(
          issue(
            "/executionEvidenceRefs",
            "not_attempted_with_execution_evidence",
            "OUT-01: not attempted is not failed. Work that ran and produced evidence is one of the "
              + "observed classes, whatever its result",
          ),
        );
      }
      if (record.uncertaintyResolved === true) {
        issues.push(
          issue(
            "/uncertaintyResolved",
            "not_attempted_resolved_uncertainty",
            "nothing was attempted, so nothing it would have shown was learned",
          ),
        );
      }
    }

    // OUT-01, second clause. Unavailable is not zero benefit: the record says
    // the observation could not be made, and says nothing about the value of
    // the work — so `uncertaintyResolved` is null rather than false.
    if (outcomeClass === "OBSERVATION_UNAVAILABLE") {
      if (record.uncertaintyResolved !== null) {
        issues.push(
          issue(
            "/uncertaintyResolved",
            "unavailable_observation_answers_uncertainty",
            "OUT-01: unavailable is not zero benefit. The observation could not be made, so whether the "
              + "uncertainty was resolved is unknown — which is null, not false",
          ),
        );
      }
      for (const [name] of EVIDENCE_ARMS) {
        if (isObjectRecord(record.evidence) && record.evidence[name] !== null) {
          issues.push(
            issue(
              `/evidence/${name}`,
              "unavailable_observation_claims_evidence",
              "the observation was unavailable; evidence of it would be evidence of the thing that did not happen",
            ),
          );
        }
      }
    }

    // OUT-02. The report's author cannot self-certify accepted usefulness.
    //
    // Scoped to the class that CLAIMS usefulness, deliberately. A team saying
    // its own work did not help is not the failure this rule exists for, and
    // refusing that would make the rule about identity equality rather than
    // about self-certification. The positive control for that scoping is a
    // NOT_HELPFUL_OBSERVED record with the SAME pair of identities, which is
    // accepted.
    if (
      outcomeClass === "HELPFUL_OBSERVED"
      && authoring !== null
      && assessing !== null
      && canonicalize(authoring) === canonicalize(assessing)
    ) {
      issues.push(
        issue(
          "/assessingIdentity",
          "self_certified_usefulness",
          "OUT-02: the Oracle's author cannot self-certify accepted usefulness; an independent reviewer or "
            + "established verifier decides under the predeclared rubric",
        ),
      );
    }
  }

  // OUT-03. Temporal consistency is not causation.
  if (record.causationClaimed === true && isObjectRecord(record.evidence)) {
    if (record.evidence.measuredCounterfactual === null) {
      issues.push(
        issue(
          "/evidence/measuredCounterfactual",
          "causation_without_counterfactual",
          "OUT-03: a later event being consistent with a recommendation does not establish causation. A "
            + "causal claim rests on a measured comparison, not on follow-through or on timing",
        ),
      );
    }
  }

  // OUT-04, inside one record. The cross-record half is `resolveOutcomeCredits`.
  if (isEnumMember(record.creditKind, OUTCOME_CREDIT_KINDS)) {
    if (record.creditKind === "REUSE" && record.duplicateOfOutcomeRef === null) {
      issues.push(
        issue(
          "/duplicateOfOutcomeRef",
          "reuse_without_original",
          "OUT-04: reuse credit names the outcome it reuses; unnamed, it is a second accepted-work credit "
            + "wearing a different word",
        ),
      );
    }
    // The evidence-keyed half of the credit rule reads
    // `executionEvidenceRefs.find(...)`, which is `undefined` on an empty list —
    // a value guard that says nothing about absence. Two INCONCLUSIVE records
    // with no evidence and two work refs therefore took two accepted-work
    // credits, inside the guard added to close exactly that. Requiring the
    // evidence closes it by CONSTRUCTION rather than by a second check that
    // would have the same hole: an accepted-WORK credit names what was
    // executed, or there is nothing for the dedup to key on and nothing for a
    // reader to check.
    //
    // Deliberately not scoped to OBSERVED_CLASSES: an INCONCLUSIVE or
    // OBSERVATION_UNAVAILABLE outcome may legitimately carry no evidence, and
    // when it does it takes NO_CREDIT rather than accepted-work credit.
    const credited = Array.isArray(record.executionEvidenceRefs)
      ? record.executionEvidenceRefs
      : [];
    if (record.creditKind === "ACCEPTED_WORK" && credited.length === 0) {
      issues.push(
        issue(
          "/executionEvidenceRefs",
          "accepted_credit_without_execution_evidence",
          "OUT-04: an accepted-work credit names the execution it is for. With no evidence there is "
            + "nothing to dedup on, so two records could credit one run by naming two work orders",
        ),
      );
    }
    if (record.creditKind === "ACCEPTED_WORK" && record.authorizedWorkRef === null) {
      issues.push(
        issue(
          "/authorizedWorkRef",
          "accepted_credit_without_authorized_work",
          "OUT-04: an accepted-WORK credit is for work the host authorized. With none there is nothing "
            + "to credit, and NO_CREDIT is the member that says so",
        ),
      );
    }
    if (record.creditKind === "NO_CREDIT" && record.duplicateOfOutcomeRef !== null) {
      issues.push(
        issue(
          "/duplicateOfOutcomeRef",
          "no_credit_names_original",
          "this record takes no credit at all; naming an outcome it reuses contradicts that",
        ),
      );
    }
    if (record.creditKind === "ACCEPTED_WORK" && record.duplicateOfOutcomeRef !== null) {
      issues.push(
        issue(
          "/duplicateOfOutcomeRef",
          "accepted_credit_names_original",
          "an accepted-work credit is for the underlying outcome itself; naming another outcome makes it a reuse",
        ),
      );
    }
    // A reuse of ITSELF. Checkable inside one record, and it was not checked:
    // `resolveOutcomeCredits` returned early on every REUSE, so an outcome
    // naming its own id took reuse credit for work nothing else had credited.
    if (record.duplicateOfOutcomeRef !== null && record.duplicateOfOutcomeRef === record.outcomeId) {
      issues.push(
        issue(
          "/duplicateOfOutcomeRef",
          "self_referential_reuse",
          "OUT-04: an outcome does not reuse itself; a self-reference is a second credit wearing a "
            + "different word",
        ),
      );
    }
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as OutcomeRecord, {});
}

/** The identity of an outcome: SHA-256 over its canonical, validated bytes. */
export function outcomeRecordDigest(record: OutcomeRecord): string {
  return digestValidated("outcome record", validateOutcomeRecord(record));
}

/**
 * OUT-04's dedup key: the work order this outcome claims was authorized.
 *
 * A PROJECTION, and the name is the whole of what it does. The second review
 * was right that the previous comment here — "there is no field this record can
 * write to move itself out from under the rule" — was false: `authorizedWorkRef`
 * is validated by `isIdentifier` and nothing else, so two outcomes recording
 * the SAME execution (identical `executionEvidenceRefs`) took two accepted-work
 * credits by writing different work refs. The test that claimed otherwise
 * varied five fields and never varied this one; it proved a projection is
 * stable under changes to fields that are not the projection.
 *
 * The anchor is therefore NOT this function. It is the `authorizedWork`
 * argument to `resolveOutcomeCredits`, which the caller supplies from host
 * state — the same construction as `resolveCitations(citations, delivered)` and
 * `mapProposalToJobShape(proposal, allowlist)`. This function only says which
 * work order a record is claiming, so the resolver can look it up.
 */
export function outcomeCreditAnchor(record: OutcomeRecord): string | null {
  return record.authorizedWorkRef;
}

/**
 * OUT-04 across records: one underlying outcome, one accepted-work credit.
 *
 * Four outcomes, because there are four different things to say and a caller
 * that cannot tell them apart cannot act on any of them. `REFUSED` means a
 * record is malformed. `DOUBLE_CREDITED` means two accepted-work credits name
 * one underlying outcome. `MISBOUND_REUSE` means a reuse names an outcome that
 * is present here and holds no accepted-work credit to reuse: a chain of reuses
 * ending at nothing, crediting work nobody ever credited.
 *
 * `CREDITED` carries `unresolvedReuse`: reuses whose original is not in the set
 * handed in. Those are REPORTED rather than refused, because the original may
 * legitimately live in a part of the ledger the caller did not pass — but they
 * are not silently counted as sound, which is what the first version did.
 */
export type OutcomeCreditResolution =
  | {
      readonly outcome: "CREDITED";
      readonly acceptedWork: readonly string[];
      readonly reuse: readonly string[];
      readonly unresolvedReuse: readonly string[];
    }
  | { readonly outcome: "DOUBLE_CREDITED"; readonly issues: readonly ValidationIssue[] }
  | { readonly outcome: "MISBOUND_REUSE"; readonly issues: readonly ValidationIssue[] }
  | { readonly outcome: "UNAUTHORIZED_WORK"; readonly issues: readonly ValidationIssue[] }
  | { readonly outcome: "REFUSED"; readonly issues: readonly ValidationIssue[] };

/** One work order the host authorized. The anchor the credit rule is keyed on. */
export type AuthorizedWork = {
  readonly workRef: string;
  readonly runRef: string;
  readonly workspaceRef: string;
};

export function resolveOutcomeCredits(
  outcomes: unknown,
  authorizedWork: unknown,
): OutcomeCreditResolution {
  const plain = toPlainRecord({ outcomes, authorizedWork });
  if (!plain.ok) return { outcome: "REFUSED", issues: plain.issues };
  if (!Array.isArray(plain.value.outcomes)) {
    return {
      outcome: "REFUSED",
      issues: [issue("/outcomes", "invalid_type", "outcomes is an array")],
    };
  }

  if (!Array.isArray(plain.value.authorizedWork)) {
    return {
      outcome: "REFUSED",
      issues: [
        issue(
          "/authorizedWork",
          "invalid_type",
          "the authorized-work set is an array; it is the anchor this rule is keyed on and an "
            + "omitted one is not an empty one",
        ),
      ],
    };
  }
  const authorized = new Map<string, AuthorizedWork>();
  const authorizedIssues: ValidationIssue[] = [];
  plain.value.authorizedWork.forEach((raw, i) => {
    const at = `/authorizedWork/${i}`;
    if (!isObjectRecord(raw)) {
      authorizedIssues.push(issue(at, "invalid_type", "an authorized work entry is an object"));
      return;
    }
    rejectUnknownFields(raw, ["workRef", "runRef", "workspaceRef"], at, "authorized work", authorizedIssues);
    for (const field of ["workRef", "runRef", "workspaceRef"] as const) {
      if (!isIdentifier(raw[field])) {
        authorizedIssues.push(issue(`${at}/${field}`, "invalid_id", `${field} is a host-assigned identifier`));
      }
    }
    if (typeof raw.workRef === "string" && authorized.has(raw.workRef)) {
      // Last-wins was silent, and the two entries can disagree about the run
      // that authorized the work — so which one survived decided the answer.
      authorizedIssues.push(
        issue(
          `${at}/workRef`,
          "duplicate_authorized_work",
          "the authorized-work set names one work order twice; if the two entries disagree, which "
            + "survives decides the result, and a set that decides by insertion order is not an anchor",
        ),
      );
      return;
    }
    if (typeof raw.workRef === "string" && typeof raw.runRef === "string"
      && typeof raw.workspaceRef === "string") {
      authorized.set(raw.workRef, {
        workRef: raw.workRef,
        runRef: raw.runRef,
        workspaceRef: raw.workspaceRef,
      });
    }
  });
  if (authorizedIssues.length > 0) return { outcome: "REFUSED", issues: authorizedIssues };

  const refusals: ValidationIssue[] = [];
  const parsed: OutcomeRecord[] = [];
  plain.value.outcomes.forEach((raw, i) => {
    const result = validateOutcomeRecord(raw);
    if (!result.ok) {
      for (const entry of result.issues) {
        refusals.push(issue(`/outcomes/${i}${entry.path}`, entry.code, entry.message));
      }
      return;
    }
    parsed.push(result.value);
  });
  if (refusals.length > 0) return { outcome: "REFUSED", issues: refusals };

  const byId = new Map(parsed.map((record) => [record.outcomeId, record]));

  // (b) THE ANCHOR: every work ref a record claims must be one the HOST
  // authorized, in this record's own run and workspace. A ref nothing
  // authorized resolves to nothing, so inventing one no longer buys a credit —
  // it buys a refusal that names the ref.
  const unauthorized: ValidationIssue[] = [];
  parsed.forEach((record, i) => {
    if (record.authorizedWorkRef === null) return;
    const work = authorized.get(record.authorizedWorkRef);
    if (work === undefined) {
      unauthorized.push(
        issue(
          `/outcomes/${i}/authorizedWorkRef`,
          "work_never_authorized",
          `OUT-04: no host-authorized work order named ${record.authorizedWorkRef}. An outcome cannot `
            + "credit work by naming it",
        ),
      );
      return;
    }
    if (work.runRef !== record.runRef || work.workspaceRef !== record.workspaceRef) {
      unauthorized.push(
        issue(
          `/outcomes/${i}/authorizedWorkRef`,
          "work_authorized_elsewhere",
          `${record.authorizedWorkRef} was authorized in a different run or workspace`,
        ),
      );
    }
  });
  if (unauthorized.length > 0) return { outcome: "UNAUTHORIZED_WORK", issues: unauthorized };

  const acceptedByAnchor = new Map<string, string>();
  // The second dedup dimension: two records naming DIFFERENT authorized work
  // orders while citing the SAME execution evidence are still one execution.
  // It is only reachable because an ACCEPTED_WORK record is REQUIRED to carry
  // evidence — `find` on an empty list returns `undefined` and the guard would
  // pass, which is how two evidence-free records slipped through it.
  //
  // ── A DECLARED LIMIT, NOT A CLOSED RULE ─────────────────────────────────
  //
  // OUT-04 has been defeated three times here, and each repair moved the anchor
  // to a different string the record authors: `creditKey`, then
  // `authorizedWorkRef`, then these evidence refs. The third defeat is real and
  // is NOT fixed below: two ACCEPTED_WORK records, two genuinely
  // host-authorized work orders, and DISJOINT evidence — `[...-part1]` versus
  // `[...-part2]` — are two accepted-work credits for one run. Overlapping
  // evidence claims are caught; two disjoint descriptions of one execution are
  // not.
  //
  // A fourth anchor would be a fourth string in the same position, and it would
  // look closed until someone probed the new dimension. So the rule is stated
  // as what it is: it catches records that CLAIM the same work or the same
  // evidence, and it cannot tell that two differently-described runs were one
  // run. `src/cross-record-anchors.test.ts` carries the demonstration as a
  // LIMIT rather than a passing rule.
  //
  // WHAT WOULD ACTUALLY CLOSE IT: a host-attested identity for the EXECUTION
  // itself — the run or attempt the work was carried out under — resolved from
  // outside these records, so two outcomes describing one execution resolve to
  // one identity whatever they call the evidence. `packages/run-events` already
  // owns run and attempt identity; the missing piece is a host-supplied
  // authorized-work-to-execution mapping, which belongs to whatever component
  // authorizes the work, not to a contracts package. Until such a set can be
  // passed in beside `authorizedWork`, this rule is partial and says so.
  const acceptedByEvidence = new Map<string, string>();
  const duplicates: ValidationIssue[] = [];
  const acceptedWork: string[] = [];
  parsed.forEach((record, i) => {
    if (record.creditKind !== "ACCEPTED_WORK") return;
    const anchor = outcomeCreditAnchor(record);
    // Unreachable while the validator requires authorized work for this kind;
    // read the value rather than assume which guard is holding it up.
    if (anchor === null) return;
    const already = acceptedByAnchor.get(anchor);
    if (already !== undefined) {
      duplicates.push(
        issue(
          `/outcomes/${i}/authorizedWorkRef`,
          "duplicate_accepted_work_credit",
          `OUT-04: ${already} already holds the accepted-work credit for ${anchor}. A duplicate `
            + "recommendation may take reuse credit; it does not produce a second accepted-work "
            + "credit for one underlying outcome, however the two records describe themselves",
        ),
      );
      return;
    }
    const sharedEvidence = record.executionEvidenceRefs.find((ref) => acceptedByEvidence.has(ref));
    if (sharedEvidence !== undefined) {
      duplicates.push(
        issue(
          `/outcomes/${i}/executionEvidenceRefs`,
          "duplicate_accepted_work_credit",
          `OUT-04: ${acceptedByEvidence.get(sharedEvidence) ?? "another outcome"} already holds the `
            + `accepted-work credit for execution evidence ${sharedEvidence}. One execution is one `
            + "underlying outcome, whatever work orders the two records name",
        ),
      );
      return;
    }
    acceptedByAnchor.set(anchor, record.outcomeId);
    for (const ref of record.executionEvidenceRefs) acceptedByEvidence.set(ref, record.outcomeId);
    acceptedWork.push(record.outcomeId);
  });
  if (duplicates.length > 0) return { outcome: "DOUBLE_CREDITED", issues: duplicates };

  // The reuse half, which the first version never reached: it returned before
  // any comparison, so a reuse of a nonexistent outcome and a reuse of ITSELF
  // both read as sound.
  const misbound: ValidationIssue[] = [];
  const reuse: string[] = [];
  const unresolvedReuse: string[] = [];
  parsed.forEach((record, i) => {
    if (record.creditKind !== "REUSE") return;
    const originalId = record.duplicateOfOutcomeRef;
    // Null is already refused by the validator (`reuse_without_original`) and a
    // self-reference by `self_referential_reuse`, so neither reaches here.
    if (originalId === null) return;
    const original = byId.get(originalId);
    if (original === undefined) {
      // Reported, not refused: the original may legitimately live in a part of
      // the ledger this caller did not pass. Silently counting it as sound is
      // what the first version did.
      unresolvedReuse.push(record.outcomeId);
      reuse.push(record.outcomeId);
      return;
    }
    if (original.creditKind !== "ACCEPTED_WORK") {
      misbound.push(
        issue(
          `/outcomes/${i}/duplicateOfOutcomeRef`,
          "reuse_of_uncredited_outcome",
          `OUT-04: ${originalId} holds no accepted-work credit to reuse. A chain of reuses ending at `
            + "nothing credits an underlying outcome nobody ever credited",
        ),
      );
      return;
    }
    reuse.push(record.outcomeId);
  });
  if (misbound.length > 0) return { outcome: "MISBOUND_REUSE", issues: misbound };
  return { outcome: "CREDITED", acceptedWork, reuse, unresolvedReuse };
}

export const OUTCOME_RECORD_SCHEMA_META: SchemaMeta = {
  id: "vinci.oracle.outcome-record",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
