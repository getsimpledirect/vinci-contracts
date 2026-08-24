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
  // Snapshot through the SAME boundary the validator uses, before anything is
  // read. Array.isArray was chosen here because it inspects an internal slot and
  // runs no trap; that is true and was not enough.
  //
  // A Proxy whose TARGET is empty can report length 1 and hand back a fabricated
  // descriptor for index 0, and this returned true — a VERIFIED_PASS over zero
  // actual criteria, while the same value serialized to []. The stored record
  // and the predicate described different things. That is the identical
  // two-view defect already fixed for actors, in the one predicate the product's
  // commercial claim rests on. A revoked Proxy also threw, from Array.isArray
  // itself, out of a function documented never to throw.
  //
  // Deferring to toPlainRecord removes the second view rather than guarding it:
  // whatever serialization captures is the only thing anyone sees, so a
  // fabricating trap can only fabricate into an inert copy that then fails on
  // its own merits. It also ends a disagreement with validateVerdictRecord at
  // exactly 10,000 criteria, where this helper said yes and the validator said
  // no, because both now share one limit instead of maintaining two.
  const snapshot = toPlainRecord({ criterionResults });
  if (!snapshot.ok) return false;
  const inert = (snapshot.value as { criterionResults?: unknown }).criterionResults;
  if (!Array.isArray(inert)) return false;
  const results: readonly unknown[] = inert;

  // Establish the status is a status BEFORE applying status semantics.
  //
  // The old order asked `status !== "VERIFIED_PASS"` first, so every value that
  // is not literally that string — "NOT_A_STATUS", "", null, 7, undefined —
  // returned TRUE. For a predicate named "is this status supported by these
  // criteria", answering true for a status that does not exist is the same
  // unearned-confidence failure as the vacuous pass, reached from the other
  // side: garbage in, endorsement out.
  if (!isVerdictStatus(status)) return false;

  if (status !== "VERIFIED_PASS") return true;

  return everyEntryIsSupported(results);
}

/**
 * A verdict may not have more criteria than this.
 *
 * Not a real limit on verdicts — it is a refusal to walk an attacker-chosen
 * length. A hostile object can report a length of 2^32-1 and this loop would
 * run for hours. Fail closed instead.
 */
const MAX_CRITERIA = 10_000;

/**
 * Traverse the results WITHOUT calling anything the input supplied.
 *
 * `.every()` is not usable here, and the reasons stack up:
 *
 *   new Array(1)                     length 1, every() SKIPS the hole -> true
 *   arr.every = () => true           our callback never runs -> true
 *   Proxy with a throwing length/index trap  -> threw
 *
 * The first is the serious one. It is the vacuous pass again — VERIFIED_PASS
 * with zero actual criterion objects — arriving through a third door after
 * being closed twice, because a sparse array reports a non-zero length while
 * containing nothing. A length check and an `.every()` together still say yes.
 *
 * So every index from 0 to length-1 must be an OWN DATA property. A hole fails
 * (no descriptor), an accessor fails (no `value`), and an inherited element
 * fails. Nothing the caller provided — no `every`, no getter, no trap — is ever
 * invoked except reflective reads, which are wrapped narrowly.
 */
function everyEntryIsSupported(criterionResults: readonly unknown[]): boolean {
  let length: unknown;
  try {
    length = (criterionResults as { readonly length?: unknown }).length;
  } catch {
    return false;
  }
  if (typeof length !== "number" || !Number.isInteger(length) || length < 0) return false;
  // A pass backed by no criteria is not a pass. See the vacuous-pass note above.
  if (length === 0 || length > MAX_CRITERIA) return false;

  for (let index = 0; index < length; index += 1) {
    let entry: PropertyDescriptor | undefined;
    try {
      entry = Object.getOwnPropertyDescriptor(criterionResults, index);
    } catch {
      return false;
    }
    // undefined => a hole. No "value" => an accessor. Both refuse.
    if (entry === undefined || !("value" in entry)) return false;

    const result: unknown = entry.value;
    if (typeof result !== "object" || result === null || Array.isArray(result)) return false;

    // Read the OWN data property, without ever invoking a getter.
    //
    //   { get status() { throw } }          -> threw, from a function whose
    //                                          comment promises it does not
    //   Object.create({status:"supported"}) -> TRUE. An object with NO own
    //                                          status, inheriting one from its
    //                                          prototype, counted as supported.
    //
    // The second manufactures a pass: an attacker needs not a supported
    // criterion but a prototype that claims one.
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(result, "status");
    } catch {
      return false;
    }
    if (descriptor === undefined || !("value" in descriptor)) return false;
    if (descriptor.value !== "supported") return false;
  }

  return true;
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
    add("/snapshotDigest", "invalid_digest", "snapshotDigest must be 64 lowercase hex characters (sha-256, no prefix); "
          + "a verdict binds to the exact artifact it evaluated");
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
    add("/issuedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z");
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
