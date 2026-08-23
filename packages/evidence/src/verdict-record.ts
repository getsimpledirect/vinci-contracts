import {
  fail,
  isVerdictStatus,
  ok,
  canonicalize,
  isCanonicalTimestamp,
  isDigest,
  isIdentifier,
  isNonBlankText,
  isStrictlyAfter,
  toPlainRecord,
  type EvidenceId,
  type SchemaMeta,
  type Timestamp,
  type ValidationIssue,
  type ValidationResult,
  type VerdictStatus,
} from "@vinci/contracts";
import type { NotTestedItem } from "./attribution.ts";
import { VERDICT_STALENESS_TRIGGERS, type VerdictStalenessTrigger } from "./verdict-assessment.ts";

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
  // This predicate is exported, so it is a public gate and not merely a helper
  // that `validateVerdictRecord` happens to call. It must not assume its caller
  // already validated anything: an external caller reaches it directly with
  // whatever it has, including a hostile array.
  if (!Array.isArray(criterionResults)) return false;

  // Establish the status is a status BEFORE applying status semantics.
  //
  // The old order asked `status !== "VERIFIED_PASS"` first, so every value that
  // is not literally that string — "NOT_A_STATUS", "", null, 7, undefined —
  // returned TRUE. For a predicate named "is this status supported by these
  // criteria", answering true for a status that does not exist is the same
  // unearned-confidence failure as the vacuous pass, reached from the other
  // side: garbage in, endorsement out. A caller checking a status it failed to
  // validate was told yes.
  if (!isVerdictStatus(status)) return false;

  if (status !== "VERIFIED_PASS") return true;

  // The vacuous pass. `.every()` on an empty array is `true`, so the previous
  // version certified a VERIFIED_PASS backed by ZERO criteria — the single most
  // valuable record to forge, admitted by the most ordinary line of code in the
  // file. "No criterion contradicted the work" and "the work was checked" are
  // different statements, and only the second justifies a pass.
  if (criterionResults.length === 0) return false;

  return criterionResults.every((result) => {
    if (typeof result !== "object" || result === null || Array.isArray(result)) return false;

    // Read the OWN data property, without ever invoking a getter.
    //
    // Two defects lived in the plain `result.status` read this replaces, and
    // the second is the dangerous one:
    //
    //   [{ get status() { throw } }]        -> threw, from a function whose
    //                                          comment promises it does not
    //   [Object.create({status:"supported"})] -> TRUE. An object with NO own
    //                                          status, inheriting one from its
    //                                          prototype, counted as a
    //                                          supported criterion.
    //
    // The second one manufactures a pass. An attacker supplying criterion
    // results does not need a supported criterion, only a prototype that
    // claims one. getOwnPropertyDescriptor answers the question actually
    // meant — does this object ITSELF carry status as data — and an accessor
    // or an inherited value both fail it.
    let descriptor: PropertyDescriptor | undefined;
    try {
      // A Proxy can throw from its own getOwnPropertyDescriptor trap. Narrow
      // catch: it wraps ONE read of caller-supplied data, not any logic of
      // ours, so it cannot swallow a bug of our own the way a broad catch
      // around the whole predicate would.
      descriptor = Object.getOwnPropertyDescriptor(result, "status");
    } catch {
      return false;
    }
    if (descriptor === undefined || !("value" in descriptor)) return false;
    return descriptor.value === "supported";
  });
}

/** Closed-shape check for one nested object: declared keys, nothing else. */
function nested(
  raw: unknown,
  path: string,
  keys: readonly string[],
  add: (path: string, code: string, message: string) => void,
): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    add(path, "invalid_type", "expected an object");
    return null;
  }
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      add(`${path}/${key}`, "unknown_field", "this record carries only its declared fields");
    }
  }
  return value;
}

/** Validate an array field, or record why it is not one. Never throws. */
function eachEntry(
  raw: unknown,
  path: string,
  add: (path: string, code: string, message: string) => void,
  visit: (entry: unknown, entryPath: string) => void,
): boolean {
  if (!Array.isArray(raw)) {
    add(path, "invalid_type", "expected an array");
    return false;
  }
  raw.forEach((entry, i) => visit(entry, `${path}/${i}`));
  return true;
}

/**
 * Validate a verdict record from untrusted input.
 *
 * Fail-closed, on an inert snapshot, as every validator in this repository is.
 *
 * Every field declared on `VerdictRecord` is checked here. That sentence used
 * to be false: seven fields — `decisiveEvidenceIds`, `unresolvedConditions`,
 * `residualRisks`, `notTested`, `issuedAt`, `expiresAt` and `staleWhen` — were
 * declared in the type, documented in prose, and never looked at once, so the
 * cast at the end promised a shape the function had not established. A type
 * assertion is not a check; it is a claim that a check already happened.
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
  if (!isDigest(record.snapshotDigest)) {
    add("/snapshotDigest", "invalid_digest", "a verdict binds to the exact artifact it evaluated");
  }
  for (const field of ["summary", "scope", "policyVersion", "evaluatorVersion"] as const) {
    if (!isNonBlankText(record[field])) {
      add(
        `/${field}`,
        "required_field",
        field === "scope"
          ? "scope must say what this verdict covers; a verdict that will not say is claiming everything"
          : `${field} must be a non-empty string`,
      );
    }
  }

  // --- criterion results -------------------------------------------------
  const results: CriterionResult[] = [];
  const citedEvidence = new Set<string>();
  const seenCriterionIds = new Set<string>();
  const criteriaAreArray = eachEntry(record.criterionResults, "/criterionResults", add, (raw, path) => {
    const r = nested(raw, path, ["criterionId", "status", "summary", "evidenceIds"], add);
    if (r === null) return;
    if (!(CRITERION_RESULT_STATUSES as readonly unknown[]).includes(r.status)) {
      add(`${path}/status`, "invalid_enum", "unrecognised criterion result status");
    }
    if (!isIdentifier(r.criterionId)) {
      add(`${path}/criterionId`, "required_field", "criterionId must be an identifier");
    } else if (seenCriterionIds.has(r.criterionId)) {
      // Two results for one criterion let a contradicted finding be paired with
      // a supported one and the reader pick whichever they prefer.
      add(`${path}/criterionId`, "duplicate_criterion", "a criterion may have exactly one result");
    } else {
      seenCriterionIds.add(r.criterionId);
    }
    if (!isNonBlankText(r.summary)) {
      add(`${path}/summary`, "required_field", "summary must be a non-empty string");
    }
    // A conclusion resting on no evidence is an opinion.
    if (!Array.isArray(r.evidenceIds) || r.evidenceIds.length === 0) {
      add(`${path}/evidenceIds`, "evidence_required", "a criterion result must cite the evidence it rests on");
    } else {
      const seen = new Set<string>();
      r.evidenceIds.forEach((id, j) => {
        if (!isIdentifier(id)) {
          add(`${path}/evidenceIds/${j}`, "invalid_id", "an evidence id is an identifier");
          return;
        }
        if (seen.has(id)) {
          add(`${path}/evidenceIds/${j}`, "duplicate_id", "an evidence id appears once per result");
        }
        seen.add(id);
        citedEvidence.add(id);
      });
    }
    results.push(r as unknown as CriterionResult);
  });

  // --- decisive evidence -------------------------------------------------
  const decisiveIds: string[] = [];
  eachEntry(record.decisiveEvidenceIds, "/decisiveEvidenceIds", add, (id, path) => {
    if (!isIdentifier(id)) {
      add(path, "invalid_id", "an evidence id is an identifier");
      return;
    }
    if (decisiveIds.includes(id)) add(path, "duplicate_id", "a decisive evidence id appears once");
    decisiveIds.push(id);
  });

  // --- conditions, risks, coverage, staleness ----------------------------
  eachEntry(record.unresolvedConditions, "/unresolvedConditions", add, (raw, path) => {
    const c = nested(raw, path, ["description", "requiredAction"], add);
    if (c === null) return;
    if (!isNonBlankText(c.description)) add(`${path}/description`, "required_field", "description must be non-empty");
    // A condition with no action is a worry, not a finding.
    if (!isNonBlankText(c.requiredAction)) {
      add(`${path}/requiredAction`, "required_field", "a condition must say what someone must DO");
    }
  });

  eachEntry(record.residualRisks, "/residualRisks", add, (raw, path) => {
    const r = nested(raw, path, ["description", "severity"], add);
    if (r === null) return;
    if (!isNonBlankText(r.description)) add(`${path}/description`, "required_field", "description must be non-empty");
    if (!(RISK_SEVERITIES as readonly unknown[]).includes(r.severity)) {
      add(`${path}/severity`, "invalid_enum", "severity is low, medium, high or critical");
    }
  });

  eachEntry(record.notTested, "/notTested", add, (raw, path) => {
    const n = nested(raw, path, ["description", "reason"], add);
    if (n === null) return;
    if (!isNonBlankText(n.description)) add(`${path}/description`, "required_field", "description must be non-empty");
    // "not tested" with no reason is indistinguishable from an oversight.
    if (!isNonBlankText(n.reason)) add(`${path}/reason`, "required_field", "say why it was not tested");
  });

  eachEntry(record.staleWhen, "/staleWhen", add, (raw, path) => {
    const s = nested(raw, path, ["trigger", "value"], add);
    if (s === null) return;
    if (!(VERDICT_STALENESS_TRIGGERS as readonly unknown[]).includes(s.trigger)) {
      add(`${path}/trigger`, "invalid_enum", "unrecognised staleness trigger");
    }
    if (!isNonBlankText(s.value)) add(`${path}/value`, "required_field", "a staleness condition watches a value");
  });

  // --- time --------------------------------------------------------------
  if (!isCanonicalTimestamp(record.issuedAt)) {
    add("/issuedAt", "invalid_timestamp", "issuedAt is ISO-8601 UTC with millisecond precision");
  }
  if (record.expiresAt !== null) {
    if (!isCanonicalTimestamp(record.expiresAt)) {
      add("/expiresAt", "invalid_timestamp", "expiresAt is a canonical timestamp or explicitly null");
    } else if (!isStrictlyAfter(record.expiresAt, record.issuedAt)) {
      // An expiry at or before issuance is a verdict born expired, which reads
      // to a consumer as "valid" for as long as nobody checks the clock.
      add("/expiresAt", "expiry_not_after_issuance", "expiresAt must be strictly later than issuedAt");
    }
  }

  // --- the anti-unearned-pass rule, enforced rather than documented -------
  if (isVerdictStatus(record.status) && criteriaAreArray) {
    if (!statusIsSupportedBy(record.status, results)) {
      add(
        "/status",
        "unearned_pass",
        "VERIFIED_PASS requires at least one criterion and every criterion supported; CONDITIONAL and BLOCKED exist for anything less",
      );
    }
    if (record.status === "VERIFIED_PASS") {
      // A pass is a claim that nothing is outstanding. Each of these says
      // something IS outstanding, in the same record.
      if (Array.isArray(record.unresolvedConditions) && record.unresolvedConditions.length > 0) {
        add("/status", "unearned_pass", "a pass with unresolved conditions is a CONDITIONAL verdict");
      }
      if (Array.isArray(record.notTested) && record.notTested.length > 0) {
        add("/status", "unearned_pass", "a pass cannot leave criteria untested; that is CONDITIONAL");
      }
      if (decisiveIds.length === 0) {
        add("/decisiveEvidenceIds", "evidence_required", "a pass must name the evidence that decided it");
      }
    }
  }

  // Exact duplicates in the descriptive arrays are refused.
  //
  // This was an open question in the repair matrix, so here is the decision and
  // its reasoning rather than silence. An entry identical in EVERY field to one
  // already present carries no information: it cannot describe a second,
  // different risk or condition, because everything that distinguishes one from
  // another is the same. Its only effect is to inflate a count, which matters
  // because "three residual risks" reads as more thorough scrutiny than "one".
  //
  // Deliberately EXACT duplicates only. Two risks sharing a description but
  // differing in severity are two genuine risks and are allowed, as are two
  // untested items with the same reason and different descriptions. Comparison
  // is by canonical encoding so key order cannot be used to smuggle a duplicate
  // past a shallow check.
  for (const field of ["unresolvedConditions", "residualRisks", "notTested", "staleWhen"] as const) {
    const entries = record[field];
    if (!Array.isArray(entries)) continue;
    const seen = new Set<string>();
    entries.forEach((entry, i) => {
      let key: string;
      try {
        key = canonicalize(entry);
      } catch {
        // Not canonicalizable; the shape checks above have already recorded why.
        return;
      }
      if (seen.has(key)) {
        add(`/${field}/${i}`, "duplicate_entry", "an identical entry is already present and adds nothing");
      }
      seen.add(key);
    });
  }

  // Decisive evidence must actually appear in the reasoning. Otherwise a record
  // can cite an impressive id that no criterion ever used.
  for (const [i, id] of decisiveIds.entries()) {
    if (!citedEvidence.has(id)) {
      add(
        `/decisiveEvidenceIds/${i}`,
        "uncited_evidence",
        "decisive evidence must be cited by a criterion result",
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
