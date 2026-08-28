import {
  fail,
  isStrictlyAfter,
  ok,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { validateExecutionSpec, type ExecutionSpec } from "./execution-spec.ts";
import { validateWorkOrder, type WorkOrder } from "./work-order.ts";

/**
 * MONOTONICITY: an execution spec may ask for no more than its work order grants.
 *
 * `bindExecutionSpec` proves a spec was compiled from exactly one order. That
 * is identity, not containment: a spec bound to the right order can still ask
 * for a tool, a repository, a branch, or a deadline the order never granted.
 * This check closes that gap, and it is PURE — it reads two records and
 * returns a verdict. The Governor (or whatever compiles specs) calls it; it
 * performs no I/O and consults nothing outside its arguments.
 *
 * Positive-list semantics throughout: anything the spec asks for that the
 * order does not positively grant is a violation. Absence is not permission.
 *
 * THE MAPPING RULE. A work order's `grantedAuthority` is a list of strings
 * and its `scope` is prose; neither carries a tool vocabulary. Rather than a
 * loose "does the prose contain the word", grants are matched by an explicit,
 * exact token grammar. A grant is machine-readable when it has one of these
 * prefixes; every other grant is prose for humans and covers nothing here:
 *
 *   tool:<name>                    exact tool name, case-sensitive
 *   repo:<host>/<owner>/<name>     exact repository
 *   branch:<name>                  exact branch
 *   branch:<prefix>/*              any branch whose name starts with "<prefix>/"
 *                                  (a single trailing "/*"; no other wildcard)
 *   promotion:pull_request         the spec may open a pull request
 *
 * `scope` is NOT machine-checked. It says in words what the order covers; the
 * repo: and branch: grants are its machine-readable projection, and an order
 * whose prose scope names a repository it never grants is an order whose
 * author has not finished writing it.
 *
 * Time: `resourceBounds.deadline` may not be later than `order.expiresAt`. A
 * run that may continue past the grant's expiry is running without one.
 */

export const GRANT_PREFIXES = ["tool:", "repo:", "branch:", "promotion:"] as const;

export type WithinOrder = { readonly within: true };

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

function branchGranted(grants: ReadonlySet<string>, branch: string): boolean {
  if (grants.has(`branch:${branch}`)) return true;
  for (const grant of grants) {
    if (!grant.startsWith("branch:") || !grant.endsWith("/*")) continue;
    const prefix = grant.slice("branch:".length, -1); // keeps the trailing "/"
    if (prefix.length > 1 && branch.startsWith(prefix) && branch.length > prefix.length) return true;
  }
  return false;
}

/**
 * Every way `spec` exceeds `order`, or `{ within: true }`.
 *
 * Both inputs are validated first, so a malformed record fails here rather
 * than being compared. Violations are reported one per dimension so a caller
 * can show all of them; the check does not stop at the first.
 */
export function checkExecutionSpecWithinOrder(spec: ExecutionSpec, order: WorkOrder): ValidationResult<WithinOrder> {
  const validSpec = validateExecutionSpec(spec);
  if (!validSpec.ok) return validSpec;
  const validOrder = validateWorkOrder(order);
  if (!validOrder.ok) return fail(validOrder.issues.map((i) => issue(`/order${i.path}`, i.code, i.message)));
  const s = validSpec.value;
  const o = validOrder.value;
  const grants = new Set(o.grantedAuthority);
  const issues: ValidationIssue[] = [];

  if (isStrictlyAfter(s.resourceBounds.deadline, o.expiresAt)) {
    issues.push(issue("/resourceBounds/deadline", "deadline_exceeds_contract",
      `deadline ${s.resourceBounds.deadline} is later than the order's expiresAt ${o.expiresAt}`));
  }
  s.tools.forEach((tool, i) => {
    if (!grants.has(`tool:${tool}`)) {
      issues.push(issue(`/tools/${i}`, "tool_not_granted", `the order does not grant "tool:${tool}"`));
    }
  });
  const repo = `${s.repository.host}/${s.repository.owner}/${s.repository.name}`;
  if (!grants.has(`repo:${repo}`)) {
    issues.push(issue("/repository", "repository_not_granted", `the order does not grant "repo:${repo}"`));
  }
  if (!branchGranted(grants, s.targetBranch)) {
    issues.push(issue("/targetBranch", "branch_not_granted",
      `the order grants neither "branch:${s.targetBranch}" nor a "branch:<prefix>/*" covering it`));
  }
  if (s.evidencePolicy === "pr" && !grants.has("promotion:pull_request")) {
    issues.push(issue("/promotion", "promotion_not_granted", 'the order does not grant "promotion:pull_request"'));
  }

  if (issues.length > 0) return fail(issues);
  return ok({ within: true });
}
