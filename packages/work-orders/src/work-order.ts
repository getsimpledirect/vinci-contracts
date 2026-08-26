import {
  CONSEQUENTIAL_ACTION_CLASSES,
  RISK_LEVELS,
  fail,
  isCanonicalTimestamp,
  isIdentifier,
  isNonBlankText,
  ok,
  plainActor,
  safeLabel,
  toPlainRecord,
  type Actor,
  type ConsequentialActionClass,
  type RiskLevel,
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
 * The original contract fixed three things up front rather than inferring them later:
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
 *
 * A mission adds the durable accountability and recovery terms that must
 * survive a session or worker handoff: owner, risk classification, verifier
 * independence, rollback conditions, and escalation rules.
 */
export type WorkOrder = {
  readonly schemaVersion: 3;
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
  /** The human who remains accountable when requester, worker, or session changes. */
  readonly owner: Actor;
  readonly riskClassification: RiskClassification;
  readonly verifier: MissionVerifier;
  readonly rollbackConditions: readonly RollbackCondition[];
  readonly escalationRules: readonly EscalationRule[];
  readonly issuedAt: string;
  /** A grant with no end is not bounded. */
  readonly expiresAt: string;
};

export type RiskClassification = {
  readonly level: RiskLevel;
  readonly consequentialClasses: readonly ConsequentialActionClass[];
  readonly rationale: string;
};

export type MissionVerifier = {
  readonly kind: "independent" | "deterministic" | "human" | "none";
  readonly verifierId: string | null;
  readonly independence: "separate-system" | "same-worker" | "human" | "none";
};

export type RollbackCondition = {
  readonly trigger: string;
  readonly action: "pause" | "revert_to_checkpoint" | "abort";
  readonly checkpointRequired: boolean;
};

export type EscalationRule = {
  readonly when:
    | "approval_timeout"
    | "budget_exhausted"
    | "attention_exhausted"
    | "verifier_unavailable"
    | "policy_undetermined"
    | "stall";
  readonly to: Actor;
  /** Maximum response time, in seconds. */
  readonly within: number;
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
function lowestRiskLevel(): RiskLevel {
  const lowest = RISK_LEVELS[RISK_LEVELS.length - 1];
  if (lowest === undefined) throw new Error("RISK_LEVELS must contain a lowest level");
  return lowest;
}
const LOWEST_RISK_LEVEL = lowestRiskLevel();
const VERIFIER_KINDS = ["independent", "deterministic", "human", "none"] as const;
const VERIFIER_INDEPENDENCE = ["separate-system", "same-worker", "human", "none"] as const;
const ROLLBACK_ACTIONS = ["pause", "revert_to_checkpoint", "abort"] as const;
const ESCALATION_WHENS = [
  "approval_timeout",
  "budget_exhausted",
  "attention_exhausted",
  "verifier_unavailable",
  "policy_undetermined",
  "stall",
] as const;

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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  noun: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      issues.push(issue(`${path}/${key}`, "unknown_field", `${noun} carries only its declared fields`));
    }
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
    "grantedAuthority", "attentionBudget", "requestedBy", "owner", "riskClassification", "verifier",
    "rollbackConditions", "escalationRules", "issuedAt", "expiresAt",
  ];
  for (const key of Object.keys(record)) {
    if (!known.includes(key)) {
      issues.push(issue(`/${key}`, "unknown_field", "a work order carries only its declared fields"));
    }
  }
  if (record.schemaVersion !== 3) {
    issues.push(issue("/schemaVersion", "invalid_schema_version", "this schema is version 3"));
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

  const owner = plainActor(record.owner as Readonly<Record<string, unknown>>);
  if (owner === null || owner.kind !== "user") {
    issues.push(issue("/owner", "owner_must_be_human", "owner must be a valid actor of kind user"));
  }

  let riskLevel: RiskLevel | null = null;
  let consequentialClasses: readonly unknown[] | null = null;
  if (!isObjectRecord(record.riskClassification)) {
    issues.push(issue("/riskClassification", "invalid_type", "riskClassification is an object"));
  } else {
    const risk = record.riskClassification;
    rejectUnknownFields(risk, ["level", "consequentialClasses", "rationale"], "/riskClassification", "riskClassification", issues);
    if (typeof risk.level !== "string" || !(RISK_LEVELS as readonly string[]).includes(risk.level)) {
      issues.push(issue("/riskClassification/level", "unknown_risk_level", "level must come from RISK_LEVELS"));
    } else {
      riskLevel = risk.level as RiskLevel;
    }
    if (!Array.isArray(risk.consequentialClasses)) {
      issues.push(issue("/riskClassification/consequentialClasses", "invalid_type", "consequentialClasses is an array"));
    } else {
      consequentialClasses = risk.consequentialClasses;
      const seen = new Set<string>();
      risk.consequentialClasses.forEach((value, index) => {
        if (typeof value !== "string" || !(CONSEQUENTIAL_ACTION_CLASSES as readonly string[]).includes(value)) {
          issues.push(issue(`/riskClassification/consequentialClasses/${index}`, "unknown_consequential_class", "class must come from CONSEQUENTIAL_ACTION_CLASSES"));
        } else if (seen.has(value)) {
          issues.push(issue(`/riskClassification/consequentialClasses/${index}`, "duplicate_consequential_class", "a consequential class is listed twice"));
        } else {
          seen.add(value);
        }
      });
    }
    if (!isNonBlankText(risk.rationale)) {
      issues.push(issue("/riskClassification/rationale", "required_field", "risk rationale must be non-blank text"));
    }
  }
  if (riskLevel !== null && consequentialClasses !== null && riskLevel !== LOWEST_RISK_LEVEL && consequentialClasses.length === 0) {
    issues.push(issue("/riskClassification/consequentialClasses", "risk_without_classes", "risk above the lowest level must name at least one consequential class"));
  }

  if (!isObjectRecord(record.verifier)) {
    issues.push(issue("/verifier", "invalid_type", "verifier is an object"));
  } else {
    const verifier = record.verifier;
    rejectUnknownFields(verifier, ["kind", "verifierId", "independence"], "/verifier", "verifier", issues);
    const validKind = typeof verifier.kind === "string" && (VERIFIER_KINDS as readonly string[]).includes(verifier.kind);
    const validIndependence = typeof verifier.independence === "string"
      && (VERIFIER_INDEPENDENCE as readonly string[]).includes(verifier.independence);
    if (!validKind) {
      issues.push(issue("/verifier/kind", "unknown_verifier_kind", "kind must be independent, deterministic, human, or none"));
    }
    if (verifier.verifierId !== null && !isNonBlankText(verifier.verifierId)) {
      issues.push(issue("/verifier/verifierId", "invalid_verifier_id", "verifierId must be non-blank text or null"));
    }
    if (!validIndependence) {
      issues.push(issue("/verifier/independence", "unknown_verifier_independence", "independence must be separate-system, same-worker, human, or none"));
    }
    if (validKind && verifier.kind === "none" && riskLevel !== null && riskLevel !== LOWEST_RISK_LEVEL) {
      issues.push(issue("/verifier/kind", "consequential_work_needs_verifier", "only the lowest risk level may declare no verifier"));
    }
    if (validKind && validIndependence && verifier.kind === "independent" && verifier.independence !== "separate-system") {
      issues.push(issue("/verifier/independence", "self_review_is_not_independent", "an independent verifier must run in a separate system; same-worker review is not independent"));
    }
  }

  if (!Array.isArray(record.rollbackConditions)) {
    issues.push(issue("/rollbackConditions", "invalid_type", "rollbackConditions is an array"));
  } else {
    record.rollbackConditions.forEach((raw, index) => {
      const path = `/rollbackConditions/${index}`;
      if (!isObjectRecord(raw)) {
        issues.push(issue(path, "invalid_type", "a rollback condition is an object"));
        return;
      }
      rejectUnknownFields(raw, ["trigger", "action", "checkpointRequired"], path, "a rollback condition", issues);
      if (!isNonBlankText(raw.trigger)) {
        issues.push(issue(`${path}/trigger`, "required_field", "rollback trigger must be non-blank text"));
      }
      if (typeof raw.action !== "string" || !(ROLLBACK_ACTIONS as readonly string[]).includes(raw.action)) {
        issues.push(issue(`${path}/action`, "unknown_rollback_action", "action must be pause, revert_to_checkpoint, or abort"));
      }
      if (typeof raw.checkpointRequired !== "boolean") {
        issues.push(issue(`${path}/checkpointRequired`, "invalid_type", "checkpointRequired is boolean"));
      }
    });
    if (consequentialClasses !== null && consequentialClasses.length > 0 && record.rollbackConditions.length === 0) {
      issues.push(issue("/rollbackConditions", "consequential_work_needs_rollback", "consequential work must state at least one rollback condition"));
    }
  }

  const coveredEscalations = new Set<string>();
  if (!Array.isArray(record.escalationRules)) {
    issues.push(issue("/escalationRules", "invalid_type", "escalationRules is an array"));
  } else {
    record.escalationRules.forEach((raw, index) => {
      const path = `/escalationRules/${index}`;
      if (!isObjectRecord(raw)) {
        issues.push(issue(path, "invalid_type", "an escalation rule is an object"));
        return;
      }
      rejectUnknownFields(raw, ["when", "to", "within"], path, "an escalation rule", issues);
      if (typeof raw.when !== "string" || !(ESCALATION_WHENS as readonly string[]).includes(raw.when)) {
        issues.push(issue(`${path}/when`, "unknown_escalation_condition", "when must be a declared escalation condition"));
      } else {
        coveredEscalations.add(raw.when);
      }
      const target = plainActor(raw.to as Readonly<Record<string, unknown>>);
      if (target === null || target.kind !== "user") {
        issues.push(issue(`${path}/to`, "escalation_target_must_be_human", "an escalation target must be a valid actor of kind user"));
      }
      if (!Number.isSafeInteger(raw.within) || (raw.within as number) <= 0) {
        issues.push(issue(`${path}/within`, "invalid_escalation_window", "within must be a positive integer number of seconds"));
      }
    });
  }
  if (!coveredEscalations.has("verifier_unavailable") || !coveredEscalations.has("policy_undetermined")) {
    issues.push(issue("/escalationRules", "escalation_gap", "escalationRules must cover verifier_unavailable and policy_undetermined"));
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
  version: 3,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "Schema v2 orders are rejected: owner, risk classification, verifier independence, rollback conditions, and escalation rules cannot be inferred and must be supplied explicitly.",
};
