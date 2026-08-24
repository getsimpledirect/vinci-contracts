import {
  fail,
  isIdentifier,
  ok,
  ownData,
  toPlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";

/**
 * What a work order may spend of a human's attention.
 *
 * Attention is the scarce resource in delegated work, and the one nothing
 * currently accounts for. Compute is metered, tokens are metered, wall-clock is
 * metered; the human being interrupted for the ninth time today is metered by
 * nothing, so the cost lands entirely outside the system that caused it. A
 * budget that is not represented cannot be exceeded, which is why it always is.
 *
 * Both quantities are counts of DEMANDS ON A PERSON, not of machine events. A
 * worker may do a thousand things unattended; what this bounds is how often it
 * may stop and require someone.
 */
export type AttentionBudget = {
  /**
   * How many times this work may interrupt a human.
   *
   * An interruption is any unsolicited demand for attention — a notification, a
   * question, a request to look. Distinct from a decision because interrupting
   * someone costs them the context they were holding whether or not they end up
   * choosing anything.
   */
  readonly interruptions: number;
  /**
   * How many decisions this work may require.
   *
   * A decision costs more than an interruption: it cannot be deferred by the
   * recipient without blocking the work, and it transfers responsibility.
   */
  readonly decisions: number;
  /** What happens when the budget is exhausted. */
  readonly onExhaustion: ExhaustionPolicy;
};

/**
 * What a work order does when it has spent its attention budget.
 *
 * THERE IS NO "PROCEED" MEMBER, and its absence is the entire design.
 *
 * Remote control of an agent is teleoperation, not autonomy. If a work order
 * could be configured to continue once it stops being able to ask, then the
 * attention budget would not be a budget — it would be a quota on how much
 * supervision the work receives before it proceeds unsupervised, which is the
 * opposite of what it is for. The dangerous configuration is not one somebody
 * would choose maliciously; it is the one somebody would choose at 2am to stop
 * being paged, and which then silently becomes the default everywhere.
 *
 * So exhaustion has exactly two honest answers: stop, or ask someone else.
 * Both keep a human in the loop. Neither can be turned off.
 */
export const EXHAUSTION_POLICIES = [
  /** Stop and wait. The work holds until someone grants more attention. */
  "block",
  /** Hand the decision up to a different, named human. */
  "escalate",
] as const;
export type ExhaustionPolicy = (typeof EXHAUSTION_POLICIES)[number];

/**
 * What a work order has actually spent.
 *
 * Kept separate from the budget because a budget is a grant and a spend is a
 * fact. Storing "remaining" instead would fuse the two, and a single bad
 * decrement would then be indistinguishable from a larger grant.
 */
export type AttentionSpend = {
  readonly workOrderId: string;
  readonly interruptionsUsed: number;
  readonly decisionsUsed: number;
};

/** How much of each budget line is left. Never negative. */
export type AttentionRemaining = {
  readonly interruptions: number;
  readonly decisions: number;
  readonly exhausted: boolean;
};

const MAX_BUDGET = 1_000;

/**
 * What remains, computed rather than stored.
 *
 * Clamped at zero: an overspend reports nothing left, never a negative that a
 * later grant could quietly cancel out.
 */
export function attentionRemaining(
  budget: AttentionBudget,
  spend: AttentionSpend,
): AttentionRemaining {
  const interruptions = Math.max(0, budget.interruptions - spend.interruptionsUsed);
  const decisions = Math.max(0, budget.decisions - spend.decisionsUsed);
  return { interruptions, decisions, exhausted: interruptions === 0 || decisions === 0 };
}

/**
 * May this work order interrupt a human right now?
 *
 * Fail-closed on anything it cannot read as a real budget and a real spend. A
 * predicate that answers "yes" for malformed input is how an unbudgeted
 * interruption gets delivered.
 */
export function mayInterrupt(budget: AttentionBudget, spend: AttentionSpend): boolean {
  if (!isWellFormedBudget(budget) || !isWellFormedSpend(spend)) return false;
  return attentionRemaining(budget, spend).interruptions > 0;
}

/** May this work order require a decision from a human right now? */
export function mayRequireDecision(budget: AttentionBudget, spend: AttentionSpend): boolean {
  if (!isWellFormedBudget(budget) || !isWellFormedSpend(spend)) return false;
  return attentionRemaining(budget, spend).decisions > 0;
}

function isCount(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;
}

function isWellFormedBudget(budget: unknown): budget is AttentionBudget {
  // ownData, not `budget.interruptions`. A direct read invokes a getter, and
  // this predicate is documented to refuse rather than throw — which it did
  // not, on the first hostile proxy a test handed it.
  return (
    isCount(ownData(budget, "interruptions"), MAX_BUDGET)
    && isCount(ownData(budget, "decisions"), MAX_BUDGET)
    && (EXHAUSTION_POLICIES as readonly unknown[]).includes(ownData(budget, "onExhaustion"))
  );
}

function isWellFormedSpend(spend: unknown): spend is AttentionSpend {
  return (
    isIdentifier(ownData(spend, "workOrderId"))
    // No upper bound on spend: an overspend is a fact to be reported, not an
    // input to be rejected. Refusing to represent it would hide it.
    && isCount(ownData(spend, "interruptionsUsed"), Number.MAX_SAFE_INTEGER)
    && isCount(ownData(spend, "decisionsUsed"), Number.MAX_SAFE_INTEGER)
  );
}

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

/** Validate an attention budget from untrusted input. */
export function validateAttentionBudget(input: unknown): ValidationResult<AttentionBudget> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  for (const key of Object.keys(record)) {
    if (!["interruptions", "decisions", "onExhaustion"].includes(key)) {
      issues.push(issue(`/${key}`, "unknown_field", "a budget carries only its declared fields"));
    }
  }
  for (const field of ["interruptions", "decisions"] as const) {
    if (!isCount(record[field], MAX_BUDGET)) {
      issues.push(
        issue(
          `/${field}`,
          "invalid_count",
          `${field} must be an integer between 0 and ${MAX_BUDGET}`,
        ),
      );
    }
  }
  if (!(EXHAUSTION_POLICIES as readonly unknown[]).includes(record.onExhaustion)) {
    issues.push(
      issue(
        "/onExhaustion",
        "invalid_enum",
        // Named explicitly, because "proceed" is the value a caller will try.
        "onExhaustion is block or escalate; there is deliberately no way to say proceed",
      ),
    );
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as AttentionBudget, {});
}

export const ATTENTION_BUDGET_SCHEMA_META: SchemaMeta = {
  id: "vinci.attention-budget",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
