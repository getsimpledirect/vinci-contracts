import {
  fail,
  ok,
  toPlainRecord,
  type Actor,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import type { ClaimSourceSpan } from "./claim.ts";
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
  readEnum,
  readSourceSpans,
  readStringList,
  rejectUnknownFields,
} from "./lib/validate.ts";

/**
 * §5.5 ClaimAssessment, and CLM-01 — the reason this package exists.
 *
 * vinci-chat's `lib/harness/grader.ts` returns `{status:'supported'}` from a
 * catch block, and its comment says why: "the grader must never block an
 * answer". That is CORRECT for a nonblocking consumer chat checker, where the
 * cost of a false negative is a refused reply and the cost of a false positive
 * is a slightly worse answer. As an institutional assessment the same line is
 * catastrophic, because the costs invert: a check that could not run reports
 * that the claim is supported, and every consumer downstream — a report, a
 * proposal, an outcome credit — inherits a conclusion nothing established.
 *
 * So the two behaviours are kept apart by CONSTRUCTION rather than by a comment
 * asking the next author to remember, in three layers:
 *
 *   1. `ClaimAssessment` is a union discriminated on `status`, and the
 *      `SUPPORTED` arm is the only one carrying `reviewedSpans` and
 *      `execution`. A `SUPPORTED` assessment cannot be WRITTEN without naming
 *      the spans that were read and the reviewer run that completed.
 *   2. `StatusForOutcome` maps every reviewer failure to `CHECK_UNAVAILABLE` at
 *      the TYPE level, so an error path that tries to produce `SUPPORTED` does
 *      not compile. The proofs are below, in this file, where `tsc --build`
 *      checks them.
 *   3. `statusForReviewerOutcome` is the runtime half, for the JSON that
 *      arrives from a model or a tool with no compiler present. Every input it
 *      cannot recognise — hostile, malformed, truncated, absent — is
 *      `CHECK_UNAVAILABLE`. There is no branch in it that returns `SUPPORTED`
 *      without a completed run and at least one reviewed span, which is the
 *      only form of "cannot fail open" that survives a future edit.
 *
 * `NOT_ASSESSED` is deliberately not reachable from any of that. It means
 * nobody looked, which is a different fact from a look that settled nothing,
 * and its arm carries no evaluator at all — because there was none.
 */

/** §5.5's five statuses. None of them is a default. */
export const ASSESSMENT_STATUSES = [
  "SUPPORTED",
  "CONTRADICTED",
  "INSUFFICIENT_EVIDENCE",
  "CHECK_UNAVAILABLE",
  "NOT_ASSESSED",
] as const;
export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

/**
 * CLM-02. What kind of thing produced this result.
 *
 * "Deterministic provenance validation is not semantic fact-checking. A model
 * critic's assessment is not executable proof." Those are two different
 * sentences about two different methods, and a consumer that cannot filter on
 * this field cannot act on either — which is why it is a required field on
 * every arm where a check actually ran, rather than a note in `limitations`.
 */
export const ASSESSMENT_METHODS = ["DETERMINISTIC", "EXECUTION", "MODEL", "HUMAN"] as const;
export type AssessmentMethod = (typeof ASSESSMENT_METHODS)[number];

/**
 * Why the intended check yielded nothing usable.
 *
 * This vocabulary is CLM-01's list, made enumerable: parse errors, timeouts,
 * empty material, missing citations and incomplete reviewer execution are the
 * five cases the requirement names, and each of them is a reason a check is
 * UNAVAILABLE rather than a reason a claim is supported.
 */
export const CHECK_UNAVAILABLE_REASONS = [
  "parse_error",
  "timed_out",
  "empty_material",
  "missing_citation",
  "incomplete_reviewer_execution",
  "evaluator_unavailable",
] as const;
export type CheckUnavailableReason = (typeof CHECK_UNAVAILABLE_REASONS)[number];

/** What a reviewer execution actually produced, before anything interprets it. */
export const REVIEWER_OUTCOME_KINDS = [
  "COMPLETED",
  "PARSE_ERROR",
  "TIMED_OUT",
  "EMPTY_MATERIAL",
  "MISSING_CITATION",
  "INCOMPLETE_EXECUTION",
] as const;
export type ReviewerOutcomeKind = (typeof REVIEWER_OUTCOME_KINDS)[number];
export type ReviewerFailureKind = Exclude<ReviewerOutcomeKind, "COMPLETED">;

/** What a COMPLETED reviewer run concluded. */
export const REVIEWER_FINDINGS = ["SUPPORTS", "CONTRADICTS", "UNDECIDED"] as const;
export type ReviewerFinding = (typeof REVIEWER_FINDINGS)[number];

/**
 * The result of one reviewer execution.
 *
 * A discriminated union rather than a result-plus-error pair, because the pair
 * is what makes a catch block able to fill in a success: `{ok, error}` has a
 * shape for "failed but supported" and this does not.
 */
export type ReviewerOutcome =
  | {
      readonly kind: "COMPLETED";
      readonly finding: ReviewerFinding;
      readonly reviewedSpans: readonly ClaimSourceSpan[];
    }
  | { readonly kind: ReviewerFailureKind; readonly detail: string };

/**
 * The statuses a given reviewer outcome may produce, at the type level.
 *
 * `SUPPORTED` appears in exactly one arm of this mapping, and it is the arm for
 * a run that completed. An error path is typed `StatusForOutcome<"TIMED_OUT">`,
 * which is the single-member type `"CHECK_UNAVAILABLE"`, so assigning
 * `"SUPPORTED"` to it is a compile error at the line that wrote it rather than
 * a review comment about a catch block someone has to notice.
 */
export type StatusForOutcome<K extends ReviewerOutcomeKind> = K extends "COMPLETED"
  ? "SUPPORTED" | "CONTRADICTED" | "INSUFFICIENT_EVIDENCE"
  : "CHECK_UNAVAILABLE";

// The compile-time half of CLM-01, proven in a file `tsc --build` compiles. A
// *.test.ts is excluded from the build and this repository's eslint config is
// not type-aware, so the same lines written as a test would be checked by
// nothing at all. Same construction, and the same reason, as envelope.ts's
// `_authorityKeyIsNever`.
//
// NO failure kind can produce SUPPORTED — asserted over the whole union at
// once, so a kind added later is covered without anyone remembering to add a
// line here.
type _FailureStatuses = StatusForOutcome<ReviewerFailureKind>;
const _noFailureSupports: "SUPPORTED" extends _FailureStatuses ? false : true = true;
// One kind spelled out, because a union that had silently become `never` would
// satisfy the assertion above vacuously.
const _timeoutIsUnavailable: StatusForOutcome<"TIMED_OUT"> extends "CHECK_UNAVAILABLE"
  ? true
  : false = true;
// THE REACHABILITY CONTROL. Without it, a mapping that sent every outcome to
// CHECK_UNAVAILABLE would satisfy both proofs above and make the type useless:
// a package that can never say SUPPORTED has not qualified either (INV-15).
const _completedCanSupport: "SUPPORTED" extends StatusForOutcome<"COMPLETED"> ? true : false = true;

/**
 * The status a reviewer outcome earns, at runtime.
 *
 * Total, and never throws: the caller is an error path by construction, and a
 * status function that throws inside a catch block is how the catch block ends
 * up returning a default instead. Every unrecognised input — a hostile object,
 * a truncated JSON document, `undefined` — is `CHECK_UNAVAILABLE`, which is the
 * honest reading of "we cannot tell what the reviewer did".
 *
 * Note what is NOT here: no branch returns `NOT_ASSESSED`. An assessment that
 * ran and failed is not an assessment that was never performed, and the two
 * must stay tellable apart (§5.5).
 */
export function statusForReviewerOutcome(outcome: unknown): AssessmentStatus {
  // Through the same inert-snapshot boundary every validator uses, FIRST. A
  // Proxy that answers `kind` differently on two reads would otherwise be able
  // to pass a check as COMPLETED and be stored as something else.
  const plain = toPlainRecord(outcome);
  if (!plain.ok) return "CHECK_UNAVAILABLE";
  const snapshot = plain.value;
  if (snapshot.kind !== "COMPLETED") return "CHECK_UNAVAILABLE";

  const finding = snapshot.finding;
  if (finding === "CONTRADICTS") return "CONTRADICTED";
  if (finding !== "SUPPORTS") return "INSUFFICIENT_EVIDENCE";

  // CLM-01's "empty material" case, and the reason it is a length check rather
  // than a presence check: a completed run that read nothing has the same
  // finding field as one that read the source, and only the span list tells
  // them apart.
  const spans = snapshot.reviewedSpans;
  if (!Array.isArray(spans)) return "INSUFFICIENT_EVIDENCE";
  const usable = spans.filter((span) => isObjectRecord(span) && isIdentifier(span.sourceId));
  if (usable.length === 0) return "INSUFFICIENT_EVIDENCE";
  return "SUPPORTED";
}

/** The fields every assessment carries, whatever its status. */
type AssessmentCommon = {
  readonly schemaVersion: 1;
  readonly assessmentId: string;
  readonly claimRef: string;
  /** The exact claim assessed. A digest, so a later edit to the claim breaks the binding. */
  readonly claimDigest: string;
  /** The report this assessment was issued against, or null when it stands alone. */
  readonly reportDigest: string | null;
  readonly limitations: readonly string[];
  readonly issuedAt: string;
};

/** The fields an assessment carries when a check actually ran. CLM-02. */
type AssessmentEvaluated = {
  readonly evaluator: Actor;
  readonly evaluatorVersion: string;
  readonly method: AssessmentMethod;
  /** How independent this evaluator was of the claim's author. Prose, and required. */
  readonly independence: string;
};

/**
 * One assessment of one claim.
 *
 * The arms differ in FIELDS, not only in a status string, and that is the whole
 * mechanism: `reviewedSpans` and `execution` exist on `SUPPORTED` and nowhere a
 * failure can reach, while `evaluator` and `method` exist on every arm where
 * something ran and not on `NOT_ASSESSED`, where nothing did.
 */
export type ClaimAssessment =
  | (AssessmentCommon
    & AssessmentEvaluated & {
      readonly status: "SUPPORTED";
      /** What the evaluator ACTUALLY reviewed. Never empty on this arm. */
      readonly reviewedSpans: readonly ClaimSourceSpan[];
      readonly execution: { readonly completed: true; readonly reviewerRunRef: string };
    })
  | (AssessmentCommon
    & AssessmentEvaluated & {
      readonly status: "CONTRADICTED";
      readonly reviewedSpans: readonly ClaimSourceSpan[];
      readonly conflictSummary: string;
    })
  | (AssessmentCommon
    & AssessmentEvaluated & {
      readonly status: "INSUFFICIENT_EVIDENCE";
      readonly reviewedSpans: readonly ClaimSourceSpan[];
      readonly whatWouldSettleIt: string;
    })
  | (AssessmentCommon
    & AssessmentEvaluated & {
      readonly status: "CHECK_UNAVAILABLE";
      readonly unavailableReason: CheckUnavailableReason;
      readonly detail: string;
    })
  | (AssessmentCommon & {
    readonly status: "NOT_ASSESSED";
    readonly notAssessedReason: string;
  });

const COMMON_FIELDS = [
  "schemaVersion",
  "assessmentId",
  "claimRef",
  "claimDigest",
  "reportDigest",
  "status",
  "limitations",
  "issuedAt",
] as const;

const EVALUATED_FIELDS = ["evaluator", "evaluatorVersion", "method", "independence"] as const;

/** The complete field set of each arm, derived nowhere else. */
const STATUS_FIELDS: Readonly<Record<AssessmentStatus, readonly string[]>> = {
  SUPPORTED: [...COMMON_FIELDS, ...EVALUATED_FIELDS, "reviewedSpans", "execution"],
  CONTRADICTED: [...COMMON_FIELDS, ...EVALUATED_FIELDS, "reviewedSpans", "conflictSummary"],
  INSUFFICIENT_EVIDENCE: [...COMMON_FIELDS, ...EVALUATED_FIELDS, "reviewedSpans", "whatWouldSettleIt"],
  CHECK_UNAVAILABLE: [...COMMON_FIELDS, ...EVALUATED_FIELDS, "unavailableReason", "detail"],
  NOT_ASSESSED: [...COMMON_FIELDS, "notAssessedReason"],
};

/** The statuses on which a check ran, and therefore owe an evaluator and a method. */
const EVALUATED_STATUSES: readonly AssessmentStatus[] = [
  "SUPPORTED",
  "CONTRADICTED",
  "INSUFFICIENT_EVIDENCE",
  "CHECK_UNAVAILABLE",
];

/** The fields that assert a review happened, refused by name where none did. */
const REVIEW_CLAIMING_FIELDS = ["reviewedSpans", "execution"] as const;

/** Validate a claim assessment from untrusted input. */
export function validateClaimAssessment(input: unknown): ValidationResult<ClaimAssessment> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  const status = record.status;
  if (!isEnumMember(status, ASSESSMENT_STATUSES)) {
    // Everything below depends on the arm, so an unrecognised discriminator is
    // refused on its own rather than producing a page of findings about a
    // record whose one real problem is that nobody knows what it is.
    return fail([
      issue(
        "/status",
        "unknown_assessment_status",
        "status must come from ASSESSMENT_STATUSES; an unrecognised status is refused, never read as "
          + "the nearest one, and never as support",
      ),
    ]);
  }
  const assessed = status as AssessmentStatus;

  // CLM-01, with its own code and BEFORE the allowlist.
  //
  // Run the other way round, `reviewedSpans` on a CHECK_UNAVAILABLE record
  // would be reported as an unknown field, and "this record claims a review its
  // own status says did not produce anything" would be indistinguishable from a
  // misspelling. The distinction IS the finding. Same construction as
  // `provider_reported_claims_independent_retrieval` in source-record.ts.
  const claimed: string[] = [];
  if (assessed === "CHECK_UNAVAILABLE" || assessed === "NOT_ASSESSED") {
    for (const field of REVIEW_CLAIMING_FIELDS) {
      if (Object.hasOwn(record, field)) {
        claimed.push(field);
        issues.push(
          issue(
            `/${field}`,
            "unavailable_check_claims_review",
            `CLM-01: ${assessed} says the check produced no usable assessment; ${field} asserts a review `
              + "that did happen, and the two cannot both be true of one record",
          ),
        );
      }
    }
  }
  rejectUnknownFields(
    record,
    STATUS_FIELDS[assessed],
    "",
    `a ${assessed} claim assessment`,
    issues,
    new Set(claimed.map((field) => `/${field}`)),
  );

  checkSchemaVersion(record.schemaVersion, "/schemaVersion", issues);
  for (const field of ["assessmentId", "claimRef"] as const) {
    if (!isIdentifier(record[field])) {
      issues.push(issue(`/${field}`, "invalid_id", `${field} is a host-assigned identifier`));
    }
  }
  if (!isDigest(record.claimDigest)) {
    issues.push(
      issue(
        "/claimDigest",
        "invalid_digest",
        "claimDigest is 64 lowercase hex characters; an assessment binds to the exact claim it read",
      ),
    );
  }
  if (record.reportDigest !== null && !isDigest(record.reportDigest)) {
    issues.push(
      issue("/reportDigest", "invalid_digest", "reportDigest is 64 lowercase hex characters or explicitly null"),
    );
  }
  readStringList(record.limitations, "/limitations", "limitations", issues);
  if (!isCanonicalTimestamp(record.issuedAt)) {
    issues.push(issue("/issuedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision"));
  }

  if (EVALUATED_STATUSES.includes(assessed)) {
    if (!isObjectRecord(record.evaluator) || plainActor(record.evaluator) === null) {
      issues.push(
        issue(
          "/evaluator",
          "invalid_actor",
          "a check that ran was run by someone; evaluator carries exactly its own kind's fields",
        ),
      );
    }
    if (!isRefText(record.evaluatorVersion)) {
      issues.push(
        issue(
          "/evaluatorVersion",
          "required_field",
          "CON-04: the evaluator that produced this result is versioned, or the result cannot be reproduced",
        ),
      );
    }
    readEnum(
      record.method,
      ASSESSMENT_METHODS,
      "/method",
      "unknown_assessment_method",
      "CLM-02: method must come from ASSESSMENT_METHODS so a consumer can tell a deterministic check "
        + "from a model critic and filter on the difference",
      issues,
    );
    if (!isProseText(record.independence)) {
      issues.push(
        issue(
          "/independence",
          "required_field",
          "an assessment states how independent its evaluator was; unstated independence reads as independence",
        ),
      );
    }
  }

  if (assessed === "SUPPORTED" || assessed === "CONTRADICTED" || assessed === "INSUFFICIENT_EVIDENCE") {
    readSourceSpans(record.reviewedSpans, "/reviewedSpans", "reviewedSpans", issues);
  }

  // --- the anti-unearned-support rules, enforced rather than documented ----
  if (assessed === "SUPPORTED") {
    if (Array.isArray(record.reviewedSpans) && record.reviewedSpans.length === 0) {
      issues.push(
        issue(
          "/reviewedSpans",
          "unearned_support",
          "CLM-01: SUPPORTED names the spans that were actually reviewed; empty material is "
            + "INSUFFICIENT_EVIDENCE, and a check that could not read is CHECK_UNAVAILABLE",
        ),
      );
    }
    const execution = record.execution;
    if (!isObjectRecord(execution)) {
      issues.push(
        issue(
          "/execution",
          "unearned_support",
          "CLM-01: SUPPORTED names the reviewer run that completed; without one nothing ran",
        ),
      );
    } else {
      rejectUnknownFields(execution, ["completed", "reviewerRunRef"], "/execution", "an execution", issues);
      if (execution.completed !== true) {
        // The literal `true` is the type, and this is the same rule at
        // runtime: an incomplete reviewer execution cannot carry a SUPPORTED
        // status, which is CLM-01's fifth case verbatim.
        issues.push(
          issue(
            "/execution/completed",
            "unearned_support",
            "CLM-01: incomplete reviewer execution cannot return SUPPORTED; the honest status is CHECK_UNAVAILABLE",
          ),
        );
      }
      if (!isRefText(execution.reviewerRunRef)) {
        issues.push(
          issue("/execution/reviewerRunRef", "required_field", "a completed run is identified by its reference"),
        );
      }
    }
  }

  if (assessed === "CONTRADICTED") {
    if (Array.isArray(record.reviewedSpans) && record.reviewedSpans.length === 0) {
      issues.push(
        issue(
          "/reviewedSpans",
          "contradiction_without_review",
          "CONTRADICTED means retrieved evidence conflicts with the claim; without a reviewed span there is no evidence",
        ),
      );
    }
    if (!isProseText(record.conflictSummary)) {
      issues.push(
        issue("/conflictSummary", "required_field", "a contradiction says what conflicts with what"),
      );
    }
  }

  if (assessed === "INSUFFICIENT_EVIDENCE" && !isProseText(record.whatWouldSettleIt)) {
    issues.push(
      issue(
        "/whatWouldSettleIt",
        "required_field",
        "the check ran and settled nothing; saying what WOULD settle it is the difference between a "
          + "result and a shrug",
      ),
    );
  }

  if (assessed === "CHECK_UNAVAILABLE") {
    readEnum(
      record.unavailableReason,
      CHECK_UNAVAILABLE_REASONS,
      "/unavailableReason",
      "unknown_unavailable_reason",
      "unavailableReason must come from CHECK_UNAVAILABLE_REASONS; CLM-01's cases are enumerable and "
        + "each of them is a reason a check is unavailable, never a reason a claim is supported",
      issues,
    );
    if (!isProseText(record.detail)) {
      issues.push(issue("/detail", "required_field", "an unavailable check says what happened"));
    }
  }

  if (assessed === "NOT_ASSESSED" && !isProseText(record.notAssessedReason)) {
    issues.push(
      issue(
        "/notAssessedReason",
        "required_field",
        "NOT_ASSESSED says why nobody looked; absence of assessment must never read as absence of problems",
      ),
    );
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as ClaimAssessment, {});
}

/** The identity of an assessment: SHA-256 over its canonical, validated bytes. */
export function claimAssessmentDigest(assessment: ClaimAssessment): string {
  return digestValidated("claim assessment", validateClaimAssessment(assessment));
}

export const CLAIM_ASSESSMENT_SCHEMA_META: SchemaMeta = {
  id: "vinci.oracle.claim-assessment",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
