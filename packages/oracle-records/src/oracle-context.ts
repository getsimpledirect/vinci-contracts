import {
  fail,
  isStrictlyAfter,
  ok,
  toPlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { contextManifestDigest, validateContextManifest } from "@getsimpledirect/vinci-run";
import { digestValidated } from "./digest.ts";
import {
  CONTEXT_SECRET_TERMS,
  checkSchemaVersion,
  isCanonicalTimestamp,
  isDigest,
  isEnumMember,
  isGitObjectId,
  isIdentifier,
  isObjectRecord,
  isProseText,
  isRefText,
  issue,
  readRefArray,
  readStringList,
  rejectForbiddenKeysDeep,
  rejectUnknownFields,
} from "./lib/validate.ts";

/**
 * §5.3, as a BINDING onto the context manifest that already exists.
 *
 * `packages/run` owns `ContextManifest` — what was loaded into a run, where
 * each piece came from, and how far it is trusted — and its SchemaMeta is
 * `compatibility: "frozen"`. CON-01 says new Oracle records extend the system
 * rather than duplicating it, so this record does not restate any of that. It
 * references a manifest by `contextManifestDigest` and adds exactly the fields
 * §5.3 requires that the manifest does not carry: when the context was
 * compiled and by what version of what compiler, which institutional mission
 * and ratified policy it was compiled against, WHICH REVISION OF WHICH
 * REPOSITORY was read and WHEN, what was unavailable and why, how each piece is
 * classified, what may leave the building, and which selection and truncation
 * decisions were taken to fit.
 *
 * Two duplications were considered and rejected. The manifest's `entries` are
 * the included artifact references §5.3 asks for, and its `excluded` list is
 * not the same thing as `unavailableSections` here — "we chose to leave this
 * out" and "we could not get this" are different facts, and the existing
 * `EXCLUSION_REASONS` vocabulary says only the first.
 */

/**
 * CTX-02. A context that had to drop a mandatory constraint or omit critical
 * contradictory evidence is not a smaller complete context; it is an incomplete
 * one, and every consumer must handle it as such.
 */
export const CONTEXT_COMPLETENESS = ["CONTEXT_COMPLETE", "CONTEXT_INCOMPLETE"] as const;
export type ContextCompleteness = (typeof CONTEXT_COMPLETENESS)[number];

/**
 * How a repository revision is named.
 *
 * A git object id is verifiable — the same id names the same tree forever. An
 * API snapshot id is whatever the system handed back and is only as stable as
 * that system, so the two are labeled rather than blended into one "revision"
 * string that a reader would have to guess about.
 */
export const CONTEXT_REVISION_KINDS = ["git_object_id", "api_snapshot_id"] as const;
export type ContextRevisionKind = (typeof CONTEXT_REVISION_KINDS)[number];

/** Why a section §5.3 expected is not here. */
export const CONTEXT_UNAVAILABLE_REASONS = [
  "fetch_failed",
  "access_denied",
  "not_found",
  "unsupported_format",
  "budget_truncated",
  "rights_restricted",
] as const;
export type ContextUnavailableReason = (typeof CONTEXT_UNAVAILABLE_REASONS)[number];

/** §5.3 data classifications, most open first. */
export const ORACLE_DATA_CLASSIFICATIONS = [
  "public",
  "internal",
  "confidential",
  "protected",
  "sealed",
] as const;
export type OracleDataClassification = (typeof ORACLE_DATA_CLASSIFICATIONS)[number];

/** §5.3 context selection and truncation decisions. */
export const CONTEXT_SELECTION_DECISIONS = [
  "included_full",
  "included_truncated",
  "summarized",
  "omitted",
] as const;
export type ContextSelectionDecision = (typeof CONTEXT_SELECTION_DECISIONS)[number];

/**
 * One repository, at one revision, observed at one instant.
 *
 * CTX-01. The observation time is PER REPOSITORY, and there is no field
 * anywhere on this record for "the instant the whole context was captured".
 * That absence is the mechanism: separate API reads are not one atomic
 * cross-system snapshot, and a type with a single `snapshotAt` would let a
 * compiler state that they were without lying about any individual field.
 */
export type RepositoryRevision = {
  readonly repositoryId: string;
  readonly revision: string;
  readonly revisionKind: ContextRevisionKind;
  readonly observedAt: string;
};

/**
 * The window inside which every observation on this record was taken.
 *
 * Start AND end, both required. A single timestamp would be the atomic-snapshot
 * claim under another name; a window says only what is true — the reads
 * happened somewhere in here, and anything that changed in between is not
 * captured.
 */
export type ObservationWindow = {
  readonly startedAt: string;
  readonly endedAt: string;
};

export type UnavailableSection = {
  readonly section: string;
  readonly reason: ContextUnavailableReason;
  readonly detail: string;
};

export type DataClassificationEntry = {
  readonly ref: string;
  readonly classification: OracleDataClassification;
};

export type ContextSelectionEntry = {
  readonly ref: string;
  readonly decision: ContextSelectionDecision;
  readonly reason: string;
};

/**
 * The Oracle-specific binding onto an existing, immutable context manifest.
 *
 * CTX-03: there is no field here for a credential or an opaque authority token,
 * and the validator refuses one by name at any depth rather than merely as an
 * unknown field. The record is a description of what was read, and a secret is
 * not something that was read — it is something that was used to read.
 */
export type OracleContextBinding = {
  readonly schemaVersion: 1;
  readonly bindingId: string;
  readonly runRef: string;
  readonly contextManifestDigest: string;
  readonly compiledAt: string;
  readonly compilerVersion: string;
  readonly completeness: ContextCompleteness;
  readonly missionRefs: readonly string[];
  readonly ratifiedPolicyRefs: readonly string[];
  readonly observationWindow: ObservationWindow;
  readonly revisionVector: readonly RepositoryRevision[];
  readonly unavailableSections: readonly UnavailableSection[];
  readonly dataClassifications: readonly DataClassificationEntry[];
  /** §5.3 allowed outbound research brief, or explicitly null when nothing may leave. */
  readonly publicBriefRef: string | null;
  readonly selectionDecisions: readonly ContextSelectionEntry[];
  /** CTX-02. Non-empty only under CONTEXT_INCOMPLETE. */
  readonly droppedMandatoryConstraints: readonly string[];
  /** CTX-02. Non-empty only under CONTEXT_INCOMPLETE. */
  readonly omittedCriticalContradictions: readonly string[];
};

const BINDING_FIELDS = [
  "schemaVersion",
  "bindingId",
  "runRef",
  "contextManifestDigest",
  "compiledAt",
  "compilerVersion",
  "completeness",
  "missionRefs",
  "ratifiedPolicyRefs",
  "observationWindow",
  "revisionVector",
  "unavailableSections",
  "dataClassifications",
  "publicBriefRef",
  "selectionDecisions",
  "droppedMandatoryConstraints",
  "omittedCriticalContradictions",
] as const;

const CREDENTIAL_IN_CONTEXT_CODE = "credential_field_in_context";

/** Inclusive: an observation may be taken at either edge of its own window. */
function withinWindow(at: string, startedAt: string, endedAt: string): boolean {
  return !isStrictlyAfter(startedAt, at) && !isStrictlyAfter(at, endedAt);
}

/** Validate an Oracle context binding from untrusted input. */
export function validateOracleContextBinding(
  input: unknown,
): ValidationResult<OracleContextBinding> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  // CTX-03 FIRST, and over the whole record.
  //
  // First because the code matters: run after the field allowlist, a key named
  // `apiToken` would be reported as an unknown field, and a consumer switching
  // on the code would learn that this record has a typo rather than that
  // something tried to put a secret in the model's context. Over the whole
  // record because every nested shape here is closed too, so a top-level-only
  // check would be a rule the allowlist already enforced.
  const secretIssues: ValidationIssue[] = [];
  rejectForbiddenKeysDeep(
    record,
    "",
    CONTEXT_SECRET_TERMS,
    CREDENTIAL_IN_CONTEXT_CODE,
    (key, term) =>
      `a context binding may not carry ${key}: the term "${term}" names a secret, and CTX-03 `
      + "keeps credentials and opaque authority tokens outside the model's context",
    secretIssues,
  );
  const reportedPaths = new Set(secretIssues.map((entry) => entry.path));
  issues.push(...secretIssues);

  rejectUnknownFields(record, BINDING_FIELDS, "", "a context binding", issues, reportedPaths);
  checkSchemaVersion(record.schemaVersion, "/schemaVersion", issues);

  if (!isIdentifier(record.bindingId)) {
    issues.push(issue("/bindingId", "invalid_id", "bindingId is host-assigned"));
  }
  if (!isIdentifier(record.runRef)) {
    issues.push(issue("/runRef", "invalid_id", "runRef is host-assigned"));
  }
  if (!isDigest(record.contextManifestDigest)) {
    issues.push(
      issue(
        "/contextManifestDigest",
        "invalid_digest",
        "contextManifestDigest names the immutable manifest this binding extends (see @getsimpledirect/vinci-run)",
      ),
    );
  }
  if (!isCanonicalTimestamp(record.compiledAt)) {
    issues.push(issue("/compiledAt", "invalid_timestamp", "compiledAt is a canonical timestamp"));
  }
  if (!isRefText(record.compilerVersion)) {
    issues.push(
      issue(
        "/compilerVersion",
        "required_field",
        "CON-04: the compiler version is part of what this context means",
      ),
    );
  }
  if (!isEnumMember(record.completeness, CONTEXT_COMPLETENESS)) {
    issues.push(
      issue("/completeness", "unknown_completeness", "completeness must come from CONTEXT_COMPLETENESS"),
    );
  }
  readRefArray(record.missionRefs, "/missionRefs", "missionRefs", issues);
  readRefArray(record.ratifiedPolicyRefs, "/ratifiedPolicyRefs", "ratifiedPolicyRefs", issues);

  const window = record.observationWindow;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  if (!isObjectRecord(window)) {
    issues.push(issue("/observationWindow", "invalid_type", "observationWindow is an object"));
  } else {
    rejectUnknownFields(
      window,
      ["startedAt", "endedAt"],
      "/observationWindow",
      "observationWindow",
      issues,
      reportedPaths,
    );
    if (!isCanonicalTimestamp(window.startedAt)) {
      issues.push(issue("/observationWindow/startedAt", "invalid_timestamp", "startedAt is a canonical timestamp"));
    } else {
      startedAt = window.startedAt;
    }
    if (!isCanonicalTimestamp(window.endedAt)) {
      issues.push(issue("/observationWindow/endedAt", "invalid_timestamp", "endedAt is a canonical timestamp"));
    } else {
      endedAt = window.endedAt;
    }
    if (startedAt !== null && endedAt !== null && isStrictlyAfter(startedAt, endedAt)) {
      issues.push(
        issue(
          "/observationWindow/endedAt",
          "observation_window_inverted",
          "an observation window ends no earlier than it starts",
        ),
      );
    }
  }

  // CTX-01, the multi-repository revision vector.
  if (!Array.isArray(record.revisionVector)) {
    issues.push(issue("/revisionVector", "invalid_type", "revisionVector is an array"));
  } else if (record.revisionVector.length === 0) {
    issues.push(
      issue(
        "/revisionVector",
        "empty_revision_vector",
        "a context compiled from no repository at all states which sources it did read; an empty vector is not the same as an unstated one",
      ),
    );
  } else {
    const seen = new Set<string>();
    record.revisionVector.forEach((raw, i) => {
      const path = `/revisionVector/${i}`;
      if (!isObjectRecord(raw)) {
        issues.push(issue(path, "invalid_type", "a revision entry is an object"));
        return;
      }
      rejectUnknownFields(
        raw,
        ["repositoryId", "revision", "revisionKind", "observedAt"],
        path,
        "a revision entry",
        issues,
        reportedPaths,
      );
      if (!isIdentifier(raw.repositoryId)) {
        issues.push(issue(`${path}/repositoryId`, "invalid_id", "repositoryId is an identifier"));
      } else if (seen.has(raw.repositoryId)) {
        issues.push(
          issue(
            `${path}/repositoryId`,
            "duplicate_repository_revision",
            "one repository, one revision: two entries for the same repository is a context read twice at two states",
          ),
        );
      } else {
        seen.add(raw.repositoryId);
      }
      if (!isEnumMember(raw.revisionKind, CONTEXT_REVISION_KINDS)) {
        issues.push(
          issue(`${path}/revisionKind`, "unknown_revision_kind", "revisionKind must come from CONTEXT_REVISION_KINDS"),
        );
      } else if (raw.revisionKind === "git_object_id") {
        if (!isGitObjectId(raw.revision)) {
          issues.push(
            issue(
              `${path}/revision`,
              "invalid_git_object_id",
              "a git revision is 40 lowercase hex characters; a 64-hex digest is not a commit id",
            ),
          );
        }
      } else if (!isRefText(raw.revision)) {
        issues.push(issue(`${path}/revision`, "invalid_ref", "an api snapshot id is a ref"));
      }
      if (!isCanonicalTimestamp(raw.observedAt)) {
        issues.push(issue(`${path}/observedAt`, "invalid_timestamp", "observedAt is a canonical timestamp"));
      } else if (startedAt !== null && endedAt !== null && !withinWindow(raw.observedAt, startedAt, endedAt)) {
        issues.push(
          issue(
            `${path}/observedAt`,
            "observation_outside_window",
            "every observation falls inside the window this binding declares; one outside it means the window does not describe the reads",
          ),
        );
      }
    });
  }

  if (!Array.isArray(record.unavailableSections)) {
    issues.push(issue("/unavailableSections", "invalid_type", "unavailableSections is an array"));
  } else {
    record.unavailableSections.forEach((raw, i) => {
      const path = `/unavailableSections/${i}`;
      if (!isObjectRecord(raw)) {
        issues.push(issue(path, "invalid_type", "an unavailable section is an object"));
        return;
      }
      rejectUnknownFields(raw, ["section", "reason", "detail"], path, "an unavailable section", issues, reportedPaths);
      if (!isRefText(raw.section)) {
        issues.push(issue(`${path}/section`, "invalid_ref", "section names what is missing"));
      }
      if (!isEnumMember(raw.reason, CONTEXT_UNAVAILABLE_REASONS)) {
        issues.push(
          issue(`${path}/reason`, "unknown_unavailable_reason", "reason must come from CONTEXT_UNAVAILABLE_REASONS"),
        );
      }
      if (!isProseText(raw.detail)) {
        issues.push(issue(`${path}/detail`, "required_field", "an unavailable section says what was tried"));
      }
    });
  }

  if (!Array.isArray(record.dataClassifications)) {
    issues.push(issue("/dataClassifications", "invalid_type", "dataClassifications is an array"));
  } else {
    record.dataClassifications.forEach((raw, i) => {
      const path = `/dataClassifications/${i}`;
      if (!isObjectRecord(raw)) {
        issues.push(issue(path, "invalid_type", "a classification entry is an object"));
        return;
      }
      rejectUnknownFields(raw, ["ref", "classification"], path, "a classification entry", issues, reportedPaths);
      if (!isRefText(raw.ref)) {
        issues.push(issue(`${path}/ref`, "invalid_ref", "a classification names what it classifies"));
      }
      if (!isEnumMember(raw.classification, ORACLE_DATA_CLASSIFICATIONS)) {
        issues.push(
          issue(`${path}/classification`, "unknown_classification", "classification must come from ORACLE_DATA_CLASSIFICATIONS"),
        );
      }
    });
  }

  if (record.publicBriefRef !== null && !isRefText(record.publicBriefRef)) {
    issues.push(
      issue(
        "/publicBriefRef",
        "invalid_ref",
        "publicBriefRef is the approved outbound brief, or explicitly null when nothing may leave",
      ),
    );
  }

  if (!Array.isArray(record.selectionDecisions)) {
    issues.push(issue("/selectionDecisions", "invalid_type", "selectionDecisions is an array"));
  } else {
    record.selectionDecisions.forEach((raw, i) => {
      const path = `/selectionDecisions/${i}`;
      if (!isObjectRecord(raw)) {
        issues.push(issue(path, "invalid_type", "a selection decision is an object"));
        return;
      }
      rejectUnknownFields(raw, ["ref", "decision", "reason"], path, "a selection decision", issues, reportedPaths);
      if (!isRefText(raw.ref)) {
        issues.push(issue(`${path}/ref`, "invalid_ref", "a selection decision names what it decided about"));
      }
      if (!isEnumMember(raw.decision, CONTEXT_SELECTION_DECISIONS)) {
        issues.push(
          issue(`${path}/decision`, "unknown_selection_decision", "decision must come from CONTEXT_SELECTION_DECISIONS"),
        );
      }
      if (!isProseText(raw.reason)) {
        issues.push(issue(`${path}/reason`, "required_field", "a truncation decision says why"));
      }
    });
  }

  const dropped = readStringList(
    record.droppedMandatoryConstraints,
    "/droppedMandatoryConstraints",
    "droppedMandatoryConstraints",
    issues,
  );
  const omitted = readStringList(
    record.omittedCriticalContradictions,
    "/omittedCriticalContradictions",
    "omittedCriticalContradictions",
    issues,
  );

  // CTX-02, in both directions.
  //
  // Forwards: a binding that dropped a mandatory constraint or left out
  // critical contradictory evidence cannot call itself complete, because a
  // consumer reading CONTEXT_COMPLETE stops asking what is missing.
  //
  // Backwards, and just as important: CONTEXT_INCOMPLETE with nothing listed is
  // the vague answer REQ-02 forbids one level up — it tells a consumer to
  // handle a gap it cannot name. A refusal that says nothing is how a fleet
  // fails silently.
  if (record.completeness === "CONTEXT_COMPLETE") {
    if (dropped !== undefined && dropped.length > 0) {
      issues.push(
        issue(
          "/droppedMandatoryConstraints",
          "mandatory_context_dropped_under_complete",
          "CTX-02: a mandatory constraint dropped to fit a budget makes the context INCOMPLETE, not smaller",
        ),
      );
    }
    if (omitted !== undefined && omitted.length > 0) {
      issues.push(
        issue(
          "/omittedCriticalContradictions",
          "mandatory_context_dropped_under_complete",
          "CTX-02: critical contradictory evidence omitted to fit a budget makes the context INCOMPLETE",
        ),
      );
    }
  } else if (record.completeness === "CONTEXT_INCOMPLETE") {
    if (dropped !== undefined && omitted !== undefined && dropped.length === 0 && omitted.length === 0) {
      issues.push(
        issue(
          "/completeness",
          "incomplete_without_named_gap",
          "CONTEXT_INCOMPLETE names what is missing; an unexplained incompleteness cannot be acted on",
        ),
      );
    }
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as OracleContextBinding, {});
}

/** The identity of a context binding: SHA-256 over its canonical, validated bytes. */
export function oracleContextBindingDigest(binding: OracleContextBinding): string {
  return digestValidated("oracle context binding", validateOracleContextBinding(binding));
}

/**
 * Whether a binding actually refers to the manifest it names.
 *
 * This is the reason `oracle-records` sits above `@getsimpledirect/vinci-run`:
 * the binding carries a digest, and a digest is a claim about identity that
 * nothing verifies unless something recomputes it. `MANIFEST_MISMATCH` is a
 * distinct outcome from `REFUSED` because they call for different actions — a
 * mismatched pair means the context moved under the request, while a refusal
 * means one of the two records is not a record at all.
 */
export type ContextBindingResolution =
  | {
      readonly outcome: "BOUND";
      readonly contextManifestDigest: string;
      readonly completeness: ContextCompleteness;
    }
  | { readonly outcome: "MANIFEST_MISMATCH"; readonly issues: readonly ValidationIssue[] }
  | { readonly outcome: "REFUSED"; readonly issues: readonly ValidationIssue[] };

export function resolveContextBinding(
  binding: unknown,
  manifest: unknown,
): ContextBindingResolution {
  const bound = validateOracleContextBinding(binding);
  if (!bound.ok) return { outcome: "REFUSED", issues: bound.issues };
  const parsedManifest = validateContextManifest(manifest);
  if (!parsedManifest.ok) return { outcome: "REFUSED", issues: parsedManifest.issues };

  const actual = contextManifestDigest(parsedManifest.value);
  if (actual !== bound.value.contextManifestDigest) {
    return {
      outcome: "MANIFEST_MISMATCH",
      issues: [
        issue(
          "/contextManifestDigest",
          "context_manifest_digest_mismatch",
          "this binding names a different manifest than the one supplied; a digest identifies bytes, and these are not those bytes",
        ),
      ],
    };
  }
  // The run reference must agree too. A binding bound to the right manifest but
  // to someone else's run resolves a real digest onto the wrong investigation,
  // which is the shape T05 refuses one record over.
  if (bound.value.runRef !== parsedManifest.value.runId) {
    return {
      outcome: "MANIFEST_MISMATCH",
      issues: [
        issue(
          "/runRef",
          "context_manifest_run_mismatch",
          "the manifest belongs to a different run; a matching digest does not make it this run's context",
        ),
      ],
    };
  }
  return {
    outcome: "BOUND",
    contextManifestDigest: actual,
    completeness: bound.value.completeness,
  };
}

/** Exported for the conformance test that checks no declared field name is secret-shaped. */
export const ORACLE_CONTEXT_BINDING_FIELDS: readonly string[] = BINDING_FIELDS;

export const ORACLE_CONTEXT_BINDING_SCHEMA_META: SchemaMeta = {
  id: "vinci.oracle.context-binding",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
