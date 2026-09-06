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
 * separate values rather than a flag because they are separate claims, and
 * `creditKey` is the field that makes the rule CHECKABLE from outside a single
 * record — see `resolveOutcomeCredits`.
 */
export const OUTCOME_CREDIT_KINDS = ["ACCEPTED_WORK", "REUSE"] as const;
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
   * OUT-04's dedup key: what underlying outcome this credit is for.
   *
   * Exported as a FIELD rather than derived, because the thing two duplicate
   * recommendations share is a judgement about which underlying outcome they
   * are the same as, and a derivation would have to guess it.
   */
  readonly creditKey: string;
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
  "creditKey",
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
  if (!isRefText(record.creditKey)) {
    issues.push(
      issue(
        "/creditKey",
        "required_field",
        "OUT-04: the dedup key naming the underlying outcome this credit is for",
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
    if (record.creditKind === "ACCEPTED_WORK" && record.duplicateOfOutcomeRef !== null) {
      issues.push(
        issue(
          "/duplicateOfOutcomeRef",
          "accepted_credit_names_original",
          "an accepted-work credit is for the underlying outcome itself; naming another outcome makes it a reuse",
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
 * OUT-04 across records: one underlying outcome, one accepted-work credit.
 *
 * `DOUBLE_CREDITED` is a distinct outcome from `REFUSED` for the reason
 * `resolveCitations` separates UNRESOLVED from REFUSED: a malformed record is
 * not a duplicate credit, and a caller that cannot tell them apart cannot act
 * on either. The issues name WHICH key was credited twice, because "some
 * duplicate exists" is not actionable.
 */
export type OutcomeCreditResolution =
  | {
      readonly outcome: "CREDITED";
      readonly acceptedWork: readonly string[];
      readonly reuse: readonly string[];
    }
  | { readonly outcome: "DOUBLE_CREDITED"; readonly issues: readonly ValidationIssue[] }
  | { readonly outcome: "REFUSED"; readonly issues: readonly ValidationIssue[] };

export function resolveOutcomeCredits(outcomes: unknown): OutcomeCreditResolution {
  const plain = toPlainRecord({ outcomes });
  if (!plain.ok) return { outcome: "REFUSED", issues: plain.issues };
  if (!Array.isArray(plain.value.outcomes)) {
    return {
      outcome: "REFUSED",
      issues: [issue("/outcomes", "invalid_type", "outcomes is an array")],
    };
  }

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

  const acceptedByKey = new Map<string, string>();
  const duplicates: ValidationIssue[] = [];
  const acceptedWork: string[] = [];
  const reuse: string[] = [];
  parsed.forEach((record, i) => {
    if (record.creditKind === "REUSE") {
      reuse.push(record.outcomeId);
      return;
    }
    const already = acceptedByKey.get(record.creditKey);
    if (already !== undefined) {
      duplicates.push(
        issue(
          `/outcomes/${i}/creditKey`,
          "duplicate_accepted_work_credit",
          `OUT-04: ${already} already holds the accepted-work credit for ${record.creditKey}. A duplicate `
            + "recommendation may take reuse credit; it does not produce a second accepted-work credit",
        ),
      );
      return;
    }
    acceptedByKey.set(record.creditKey, record.outcomeId);
    acceptedWork.push(record.outcomeId);
  });
  if (duplicates.length > 0) return { outcome: "DOUBLE_CREDITED", issues: duplicates };
  return { outcome: "CREDITED", acceptedWork, reuse };
}

export const OUTCOME_RECORD_SCHEMA_META: SchemaMeta = {
  id: "vinci.oracle.outcome-record",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
