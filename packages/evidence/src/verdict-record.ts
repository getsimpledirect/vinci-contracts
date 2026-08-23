import {
  fail,
  isVerdictStatus,
  ok,
  toPlainRecord,
  type EvidenceId,
  type SchemaMeta,
  type Timestamp,
  type ValidationIssue,
  type ValidationResult,
  type VerdictStatus,
} from "@vinci/contracts";
import type { NotTestedItem } from "./attribution.ts";
import type { VerdictStalenessTrigger } from "./verdict-assessment.ts";

/**
 * What a verdict concluded about one acceptance criterion.
 *
 * `unverified` is deliberately absent from the result set. A criterion nobody
 * evaluated does not belong in a list of results — it belongs in `notTested`,
 * where the reader can see it was skipped and why. Letting "unverified" sit
 * among results is how a criterion that was never checked gets counted as
 * having been looked at.
 */
export const CRITERION_RESULT_STATUSES = ["supported", "contradicted", "unknown"] as const;
export type CriterionResultStatus = (typeof CRITERION_RESULT_STATUSES)[number];

export type CriterionResult = {
  readonly criterionId: string;
  readonly status: CriterionResultStatus;
  readonly summary: string;
  /** The evidence this conclusion actually rests on. Empty is not permitted. */
  readonly evidenceIds: readonly EvidenceId[];
};

export type UnresolvedCondition = {
  readonly description: string;
  /** What someone must DO. A condition with no action is a worry, not a finding. */
  readonly requiredAction: string;
};

export const RISK_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

export type ResidualRisk = {
  readonly description: string;
  readonly severity: RiskSeverity;
};

export type StalenessCondition = {
  readonly trigger: VerdictStalenessTrigger;
  /** The value being watched — a digest, a policy version, a path. */
  readonly value: string;
};

/**
 * An independent assessment of whether completed work satisfied its request.
 *
 * This is the artifact the business is sold on, and until now it existed only
 * inside `vinci-acceptance/packages/protocol` while `@vinci/contracts` held the
 * status and the staleness rules but not the record carrying them. That is the
 * drift this repository exists to close, sitting on the one thing customers buy.
 *
 * Two properties matter more than the field list.
 *
 * `scope` is required and non-empty because a verdict is a statement about
 * something specific. "The code is correct" is not a verdict anyone can rely
 * on; "the requested endpoint returns 404 for unknown ids, verified by
 * execution against commit abc123" is. A verdict that will not say what it
 * covered is claiming everything.
 *
 * `snapshotDigest` binds the conclusion to the exact artifact evaluated. A
 * verdict that floats free of what it examined cannot be checked later, and
 * cannot be told apart from a stale one.
 */
export type VerdictRecord = {
  readonly schemaVersion: 1;
  readonly status: VerdictStatus;
  /** Exactly what was evaluated. */
  readonly snapshotDigest: string;
  readonly summary: string;
  /** What this verdict covers — and by implication, what it does not. */
  readonly scope: string;
  readonly criterionResults: readonly CriterionResult[];
  /** The evidence that actually decided it, not everything gathered. */
  readonly decisiveEvidenceIds: readonly EvidenceId[];
  readonly unresolvedConditions: readonly UnresolvedCondition[];
  readonly residualRisks: readonly ResidualRisk[];
  /** What was not checked, and why. Silence about coverage reads as coverage. */
  readonly notTested: readonly NotTestedItem[];
  readonly policyVersion: string;
  /** Which evaluator produced this, so a bad one can be found later. */
  readonly evaluatorVersion: string;
  readonly issuedAt: Timestamp;
  readonly expiresAt: Timestamp | null;
  readonly staleWhen: readonly StalenessCondition[];
};

/**
 * May this status be issued given these criterion results?
 *
 * The anti-unearned-pass rule, in one place. A VERIFIED_PASS alongside a
 * contradicted criterion is incoherent — something was found not to work and
 * the verdict says it all works. `CONDITIONAL` exists precisely for "it holds,
 * with caveats", and `BLOCKED` for "this could not be settled".
 *
 * An `unknown` criterion also bars a pass: unknown means the check ran and
 * settled nothing, which is not evidence of success. Treating unknown as
 * passing is how an evaluator issues confidence it did not earn — the failure
 * the strategy calls worse than having no evaluator at all.
 */
export function statusIsSupportedBy(
  status: VerdictStatus,
  criterionResults: readonly CriterionResult[],
): boolean {
  if (status !== "VERIFIED_PASS") return true;
  return criterionResults.every((result) => result.status === "supported");
}

/**
 * Validate a verdict record from untrusted input.
 *
 * Fail-closed, on an inert snapshot, as every validator in this repository is.
 */
export function validateVerdictRecord(input: unknown): ValidationResult<VerdictRecord> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];
  const add = (path: string, code: string, message: string) => issues.push({ path, code, message });

  const known = new Set([
    "schemaVersion", "status", "snapshotDigest", "summary", "scope", "criterionResults",
    "decisiveEvidenceIds", "unresolvedConditions", "residualRisks", "notTested",
    "policyVersion", "evaluatorVersion", "issuedAt", "expiresAt", "staleWhen",
  ]);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) add(`/${key}`, "unknown_field", "a verdict carries only its declared fields");
  }

  if (record.schemaVersion !== 1) add("/schemaVersion", "invalid_schema_version", "this schema is version 1");
  if (!isVerdictStatus(record.status)) {
    add("/status", "invalid_enum", "a verdict status is VERIFIED_PASS, CONDITIONAL or BLOCKED");
  }
  if (typeof record.snapshotDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.snapshotDigest)) {
    add("/snapshotDigest", "invalid_digest", "a verdict binds to the exact artifact it evaluated");
  }
  for (const field of ["summary", "scope", "policyVersion", "evaluatorVersion"] as const) {
    const value = record[field];
    if (typeof value !== "string" || value.trim() === "") {
      add(
        `/${field}`,
        "required_field",
        field === "scope"
          ? "scope must say what this verdict covers; a verdict that will not say is claiming everything"
          : `${field} must be a non-empty string`,
      );
    }
  }

  const results: CriterionResult[] = [];
  if (!Array.isArray(record.criterionResults)) {
    add("/criterionResults", "invalid_type", "criterionResults is an array");
  } else {
    record.criterionResults.forEach((raw, i) => {
      const path = `/criterionResults/${i}`;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        add(path, "invalid_type", "each result is an object");
        return;
      }
      const r = raw as Record<string, unknown>;
      if (!(CRITERION_RESULT_STATUSES as readonly unknown[]).includes(r.status)) {
        add(`${path}/status`, "invalid_enum", "unrecognised criterion result status");
      }
      if (typeof r.criterionId !== "string" || r.criterionId.trim() === "") {
        add(`${path}/criterionId`, "required_field", "criterionId must be a non-empty string");
      }
      if (typeof r.summary !== "string" || r.summary.trim() === "") {
        add(`${path}/summary`, "required_field", "summary must be a non-empty string");
      }
      // A conclusion resting on no evidence is an opinion.
      if (!Array.isArray(r.evidenceIds) || r.evidenceIds.length === 0) {
        add(
          `${path}/evidenceIds`,
          "evidence_required",
          "a criterion result must cite the evidence it rests on",
        );
      }
      results.push(r as unknown as CriterionResult);
    });
  }

  // The anti-unearned-pass rule, enforced rather than documented.
  if (isVerdictStatus(record.status) && Array.isArray(record.criterionResults)) {
    if (!statusIsSupportedBy(record.status, results)) {
      add(
        "/status",
        "unearned_pass",
        "VERIFIED_PASS cannot be issued while a criterion is contradicted or unknown; CONDITIONAL and BLOCKED exist for those",
      );
    }
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as VerdictRecord, {});
}

export const VERDICT_RECORD_SCHEMA_META: SchemaMeta = {
  id: "vinci.verdict-record",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
