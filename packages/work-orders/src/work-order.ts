import {
  fail,
  isCanonicalTimestamp,
  isIdentifier,
  isNonBlankText,
  ok,
  plainActor,
  safeLabel,
  toPlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { validateAttentionBudget, type AttentionBudget } from "./attention.ts";

/**
 * A bounded grant of authority to do a specific piece of work.
 *
 * The durable object delegation has been missing. Today a request is a message:
 * it says what to do, and everything else — how far the authority extends, what
 * would count as done, how much of someone's day it may consume — lives in
 * whoever happened to read it. That is workable between two people who already
 * share context and fails completely the moment one party is an agent, because
 * the agent has no context to fall back on and will substitute its own.
 *
 * Three things are therefore required up front rather than inferred later:
 *
 *   acceptanceCriteria — what "done" means, fixed BEFORE the work starts. A
 *   criterion written afterwards is a description of what happened, and cannot
 *   fail. Amendments therefore create a new contract version, and a changed
 *   criterion receives a new id rather than rewriting the meaning of an id that
 *   may already have a verdict pinned to it.
 *
 *   attentionBudget — how much of a human this may cost. See attention.ts.
 *
 *   grantedAuthority — what the worker may do, stated positively. Absence of a
 *   prohibition is not a grant; anything not listed is not permitted.
 */
export type WorkOrder = {
  readonly schemaVersion: 2;
  /** Monotonic version of this work's contract; the work order id stays stable. */
  readonly contractVersion: number;
  /** Required after v1 and points to the immediately preceding contract version. */
  readonly supersedes?: WorkOrderSupersedes;
  readonly id: string;
  /** What was asked for, in the requester's words. */
  readonly request: string;
  /** What this covers, and by implication what it does not. */
  readonly scope: string;
  /** Fixed before work begins. Non-empty. */
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
  /** Stated positively: anything absent is not granted. */
  readonly grantedAuthority: readonly string[];
  readonly attentionBudget: AttentionBudget;
  /** Who asked. Snapshotted through plainActor, so a proxy cannot lie about it. */
  readonly requestedBy: Readonly<Record<string, unknown>>;
  readonly issuedAt: string;
  /** A grant with no end is not bounded. */
  readonly expiresAt: string;
};

export type WorkOrderSupersedes = {
  readonly contractVersion: number;
  readonly amendmentId: string;
};

export type AcceptanceCriterion = {
  readonly id: string;
  /** What must be true, stated so that it could turn out false. */
  readonly statement: string;
  /**
   * How it will be checked.
   *
   * Required, because a criterion nobody can check is a wish. Writing the
   * method down before the work starts is also what stops "we checked it" from
   * being decided after the fact by whoever is reporting.
   */
  readonly verifiedBy: string;
};

const MAX_CRITERIA = 100;
const MAX_AUTHORITY = 100;

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

function validateCriterion(
  raw: unknown,
  path: string,
  issues: ValidationIssue[],
  seen: Set<string>,
): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push(issue(path, "invalid_type", `expected an object, got ${safeLabel(raw)}`));
    return;
  }
  const c = raw as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (!["id", "statement", "verifiedBy"].includes(key)) {
      issues.push(issue(`${path}/${key}`, "unknown_field", "a criterion carries only its declared fields"));
    }
  }
  if (!isIdentifier(c.id)) {
    issues.push(issue(`${path}/id`, "invalid_id", "a criterion id is an identifier"));
  } else if (seen.has(c.id)) {
    issues.push(issue(`${path}/id`, "duplicate_criterion", "two criteria share an id"));
  } else {
    seen.add(c.id);
  }
  if (!isNonBlankText(c.statement)) {
    issues.push(issue(`${path}/statement`, "required_field", "a criterion must state what must be true"));
  }
  if (!isNonBlankText(c.verifiedBy)) {
    issues.push(
      issue(`${path}/verifiedBy`, "required_field", "say how this will be checked; an uncheckable criterion is a wish"),
    );
  }
}

/** Validate a work order from untrusted input. */
export function validateWorkOrder(input: unknown): ValidationResult<WorkOrder> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  const known = [
    "schemaVersion", "contractVersion", "supersedes", "id", "request", "scope", "acceptanceCriteria",
    "grantedAuthority", "attentionBudget", "requestedBy", "issuedAt", "expiresAt",
  ];
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) {
      issues.push(issue(`/${key}`, "unknown_field", "a work order carries only its declared fields"));
    }
  }
  if (record.schemaVersion !== 2) {
    issues.push(issue("/schemaVersion", "invalid_schema_version", "this schema is version 2"));
  }
  if (!Number.isSafeInteger(record.contractVersion) || (record.contractVersion as number) < 1) {
    issues.push(issue("/contractVersion", "invalid_contract_version", "contractVersion is an integer at least 1"));
  }

  const hasSupersedes = Object.hasOwn(record, "supersedes");
  if (record.contractVersion === 1 && hasSupersedes) {
    issues.push(issue("/supersedes", "supersedes_forbidden", "contract version 1 supersedes nothing"));
  } else if (typeof record.contractVersion === "number" && record.contractVersion > 1) {
    if (!hasSupersedes) {
      issues.push(issue("/supersedes", "supersedes_required", "contract versions after 1 must identify their predecessor"));
    } else if (typeof record.supersedes !== "object" || record.supersedes === null || Array.isArray(record.supersedes)) {
      issues.push(issue("/supersedes", "invalid_type", "supersedes is an object"));
    } else {
      const supersedes = record.supersedes as Record<string, unknown>;
      for (const key of Object.keys(supersedes)) {
        if (!["contractVersion", "amendmentId"].includes(key)) {
          issues.push(issue(`/supersedes/${key}`, "unknown_field", "supersedes carries only its declared fields"));
        }
      }
      if (supersedes.contractVersion !== record.contractVersion - 1) {
        issues.push(
          issue(
            "/supersedes/contractVersion",
            "supersedes_version_mismatch",
            "supersedes.contractVersion must be exactly one less than contractVersion",
          ),
        );
      }
      if (!isIdentifier(supersedes.amendmentId)) {
        issues.push(issue("/supersedes/amendmentId", "invalid_id", "amendmentId is an identifier"));
      }
    }
  }
  if (!isIdentifier(record.id)) {
    issues.push(issue("/id", "invalid_id", "id is an identifier"));
  }
  for (const field of ["request", "scope"] as const) {
    if (!isNonBlankText(record[field])) {
      issues.push(
        issue(
          `/${field}`,
          "required_field",
          field === "scope"
            ? "scope must say what this covers; an unscoped order grants everything"
            : "request must say what was asked for",
        ),
      );
    }
  }

  const seenCriteria = new Set<string>();
  if (!Array.isArray(record.acceptanceCriteria)) {
    issues.push(issue("/acceptanceCriteria", "invalid_type", "acceptanceCriteria is an array"));
  } else if (record.acceptanceCriteria.length === 0) {
    issues.push(
      issue(
        "/acceptanceCriteria",
        "criteria_required",
        // Without this the order can never fail, only be reinterpreted.
        "fix what done means BEFORE the work starts; criteria written afterwards cannot fail",
      ),
    );
  } else if (record.acceptanceCriteria.length > MAX_CRITERIA) {
    issues.push(issue("/acceptanceCriteria", "too_many", `at most ${MAX_CRITERIA} criteria`));
  } else {
    record.acceptanceCriteria.forEach((c, i) =>
      validateCriterion(c, `/acceptanceCriteria/${i}`, issues, seenCriteria),
    );
  }

  if (!Array.isArray(record.grantedAuthority)) {
    issues.push(issue("/grantedAuthority", "invalid_type", "grantedAuthority is an array"));
  } else if (record.grantedAuthority.length > MAX_AUTHORITY) {
    issues.push(issue("/grantedAuthority", "too_many", `at most ${MAX_AUTHORITY} grants`));
  } else {
    const seenGrants = new Set<string>();
    record.grantedAuthority.forEach((grant, i) => {
      if (!isNonBlankText(grant)) {
        issues.push(issue(`/grantedAuthority/${i}`, "invalid_grant", "a grant is a non-blank string"));
        return;
      }
      if (seenGrants.has(grant)) {
        issues.push(issue(`/grantedAuthority/${i}`, "duplicate_grant", "a grant is listed twice"));
      }
      seenGrants.add(grant);
    });
  }

  const budget = validateAttentionBudget(record.attentionBudget);
  if (!budget.ok) {
    for (const problem of budget.issues) {
      issues.push(issue(`/attentionBudget${problem.path}`, problem.code, problem.message));
    }
  }

  // plainActor, not a local check: the requester's identity decides whose
  // authority this order carries, and a second implementation of that question
  // is a second answer to it.
  if (plainActor(record.requestedBy as Readonly<Record<string, unknown>>) === null) {
    issues.push(issue("/requestedBy", "invalid_actor", "requestedBy must be an actor of kind user, worker, policy, system or verifier, "
        + "carrying exactly that kind's fields (see ACTOR_FIELDS)"));
  }

  for (const field of ["issuedAt", "expiresAt"] as const) {
    if (!isCanonicalTimestamp(record[field])) {
      issues.push(issue(`/${field}`, "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z"));
    }
  }
  if (
    isCanonicalTimestamp(record.issuedAt)
    && isCanonicalTimestamp(record.expiresAt)
    && Date.parse(record.expiresAt) <= Date.parse(record.issuedAt)
  ) {
    issues.push(issue("/expiresAt", "expiry_not_after_issuance", "expiresAt must be strictly later than issuedAt"));
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as WorkOrder, {});
}

export const WORK_ORDER_SCHEMA_META: SchemaMeta = {
  id: "vinci.work-order",
  version: 2,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "Rewrite schema v1 records explicitly as schema v2 contract version 1 records without supersedes; validation never defaults the new field.",
};
