import {
  fail,
  isStrictlyAfter,
  ok,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { validateExecutionSpec, type ExecutionSpec } from "./execution-spec.ts";
import { parsePathGrant, parsePathRoot, pathRootCovers, type PathRoot } from "./path-grant.ts";
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
 *   path:<root>                    WRITE SCOPE. "<root>/" grants that directory
 *                                  and everything under it; "<root>" without the
 *                                  slash grants exactly that file. Relative and
 *                                  normalised only (path-grant.ts); the root of
 *                                  the repository is not expressible, so no
 *                                  path: grant means NO write scope — the spec's
 *                                  `paths` must be ⊆ the order's path: grants,
 *                                  and a worker with none may write nothing.
 *
 * `scope` is NOT machine-checked. It says in words what the order covers; the
 * repo: and branch: grants are its machine-readable projection, and an order
 * whose prose scope names a repository it never grants is an order whose
 * author has not finished writing it.
 *
 * Time: `resourceBounds.deadline` may not be later than `order.expiresAt`. A
 * run that may continue past the grant's expiry is running without one.
 */

export const GRANT_PREFIXES = ["tool:", "repo:", "branch:", "promotion:", "path:"] as const;

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
  return checkValidatedExecutionSpecWithinOrder(validSpec.value, validOrder.value);
}

/**
 * The comparison alone, for callers that have ALREADY validated both records
 * through validateExecutionSpec / validateWorkOrder (bindExecutionSpec has).
 * Not exported from the package: a caller outside it cannot prove it validated.
 */
export function checkValidatedExecutionSpecWithinOrder(s: ExecutionSpec, o: WorkOrder): ValidationResult<WithinOrder> {
  const issues: ValidationIssue[] = [];

  // A wildcard grant with nothing before the "/*" is not a scope, it is the
  // absence of one: "branch:*" would cover every branch, which is exactly
  // what the positive-list rule exists to make impossible to say by accident.
  // It is an ERROR on the order side, not a grant that silently covers nothing.
  o.grantedAuthority.forEach((grant, i) => {
    if (grant === "branch:*" || grant === "branch:/*") {
      issues.push(issue(`/order/grantedAuthority/${i}`, "grant_wildcard_unbounded",
        `"${grant}" grants every branch; a branch wildcard needs a non-empty prefix, e.g. branch:feat/*`));
    }
  });
  const grants = new Set(o.grantedAuthority);

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
  if (s.promotion === "pull_request" && !grants.has("promotion:pull_request")) {
    issues.push(issue("/promotion", "promotion_not_granted", 'the order does not grant "promotion:pull_request"'));
  }
  // Write scope: every spec path root must sit at or under SOME path: grant
  // of the order. Both sides validated already, so every token parses; a
  // parent file grant admits only the identical file, a parent directory
  // grant admits itself and anything nested under it. No path: grants on the
  // order and a non-empty `paths` on the spec is the plain case of asking
  // for a write scope nobody granted.
  const grantedRoots: PathRoot[] = [];
  for (const grant of grants) {
    const parsed = parsePathGrant(grant);
    if (parsed !== null && parsed.ok) grantedRoots.push(parsed.value);
  }
  (s.paths ?? []).forEach((raw, i) => {
    const parsed = parsePathRoot(raw);
    if (!parsed.ok) return; // unreachable after validateExecutionSpec; never widen on a parse failure
    const child = parsed.value;
    if (!grantedRoots.some((parent) => pathRootCovers(parent, child))) {
      issues.push(issue(`/paths/${i}`, "path_not_granted",
        `no "path:" grant of the order covers "${child.root}" (a file grant admits only that file; a directory grant admits what is under it)`));
    }
  });

  if (issues.length > 0) return fail(issues);
  return ok({ within: true });
}
