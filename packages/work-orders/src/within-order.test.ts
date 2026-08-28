import { describe, expect, it } from "vitest";
import { bindExecutionSpec, checkExecutionSpecWithinOrder, type ExecutionSpec, type WorkOrder } from "./index.ts";
import { validOrder, validSpec } from "./fixtures.test-helpers.ts";

const codes = (spec: ExecutionSpec, order: WorkOrder): string[] => {
  const r = checkExecutionSpecWithinOrder(spec, order);
  return r.ok ? [] : r.issues.map((i) => `${i.path}:${i.code}`);
};
const withGrants = (grants: readonly string[]): WorkOrder => ({ ...validOrder(), grantedAuthority: grants });
const bounds = (deadline: string) => ({ ...validSpec().resourceBounds, deadline });

describe("checkExecutionSpecWithinOrder: execution authority ⊆ contract authority", () => {
  it("passes when every dimension is within the order", () => {
    const r = checkExecutionSpecWithinOrder(validSpec(), validOrder());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ within: true });
  });

  it("rejects a deadline later than the order's expiresAt, and accepts one equal to it", () => {
    // validOrder expires 2026-08-24T12:00:00.000Z.
    expect(codes({ ...validSpec(), resourceBounds: bounds("2026-08-24T12:00:00.001Z") }, validOrder()))
      .toEqual(["/resourceBounds/deadline:deadline_exceeds_contract"]);
    expect(codes({ ...validSpec(), resourceBounds: bounds("2026-08-24T12:00:00.000Z") }, validOrder())).toEqual([]);
  });

  it("rejects a tool the order does not grant as tool:<name>, exactly and case-sensitively", () => {
    expect(codes({ ...validSpec(), tools: ["read", "deploy"] }, validOrder())).toEqual(["/tools/1:tool_not_granted"]);
    expect(codes({ ...validSpec(), tools: ["Read"] }, validOrder())).toEqual(["/tools/0:tool_not_granted"]);
    // Prose that mentions the tool is not a grant of it.
    const prose = withGrants(["may use the read tool", "repo:github.com/getsimpledirect/vinci-contracts", "branch:feat/*", "promotion:pull_request"]);
    expect(codes({ ...validSpec(), tools: ["read"] }, prose)).toEqual(["/tools/0:tool_not_granted"]);
  });

  it("rejects a repository the order does not grant as repo:<host>/<owner>/<name>", () => {
    expect(codes({ ...validSpec(), repository: { host: "github.com", owner: "getsimpledirect", name: "vinci-chat" } }, validOrder()))
      .toEqual(["/repository:repository_not_granted"]);
  });

  it("rejects a branch outside the branch: grants; a branch:<prefix>/* grant covers only that prefix", () => {
    expect(codes({ ...validSpec(), targetBranch: "main" }, validOrder())).toEqual(["/targetBranch:branch_not_granted"]);
    expect(codes({ ...validSpec(), targetBranch: "feat" }, validOrder())).toEqual(["/targetBranch:branch_not_granted"]);
    expect(codes({ ...validSpec(), targetBranch: "feature/x" }, validOrder())).toEqual(["/targetBranch:branch_not_granted"]);
    expect(codes({ ...validSpec(), targetBranch: "feat/x/y" }, validOrder())).toEqual([]);
    const exact = withGrants(["tool:read", "tool:edit", "tool:bash", "repo:github.com/getsimpledirect/vinci-contracts", "branch:release", "promotion:pull_request"]);
    expect(codes({ ...validSpec(), targetBranch: "release" }, exact)).toEqual([]);
    expect(codes({ ...validSpec(), targetBranch: "release/1" }, exact)).toEqual(["/targetBranch:branch_not_granted"]);
  });

  it("a bare branch:* (or branch:/*) grant is an error on the order side, not a grant that silently covers nothing", () => {
    const star = withGrants(["tool:read", "tool:edit", "tool:bash", "repo:github.com/getsimpledirect/vinci-contracts", "branch:*", "promotion:pull_request"]);
    expect(codes(validSpec(), star)).toEqual(["/order/grantedAuthority/4:grant_wildcard_unbounded", "/targetBranch:branch_not_granted"]);
    const slashStar = withGrants(["tool:read", "tool:edit", "tool:bash", "repo:github.com/getsimpledirect/vinci-contracts", "branch:/*", "branch:feat/*", "promotion:pull_request"]);
    expect(codes(validSpec(), slashStar)).toEqual(["/order/grantedAuthority/4:grant_wildcard_unbounded"]);
    // bindExecutionSpec refuses it too, under execution_exceeds_contract.
    const bound = bindExecutionSpec(validSpec(star), star);
    expect(bound.ok).toBe(false);
    if (!bound.ok) expect(bound.issues.map((i) => i.code)).toContain("grant_wildcard_unbounded");
  });

  it("rejects a pull-request promotion the order does not grant", () => {
    const noPromo = withGrants(["tool:read", "tool:edit", "tool:bash", "repo:github.com/getsimpledirect/vinci-contracts", "branch:feat/*"]);
    expect(codes(validSpec(), noPromo)).toEqual(["/promotion:promotion_not_granted"]);
  });

  it("reports every violated dimension, not just the first", () => {
    const bare = withGrants(["edit files under src/api"]);
    expect(codes({ ...validSpec(), resourceBounds: bounds("2026-09-01T00:00:00.000Z") }, bare)).toEqual([
      "/resourceBounds/deadline:deadline_exceeds_contract",
      "/tools/0:tool_not_granted", "/tools/1:tool_not_granted", "/tools/2:tool_not_granted",
      "/repository:repository_not_granted",
      "/targetBranch:branch_not_granted",
      "/promotion:promotion_not_granted",
    ]);
  });

  it("fails closed on a malformed spec or order rather than comparing it", () => {
    expect(checkExecutionSpecWithinOrder({ ...validSpec(), baseCommit: "x" }, validOrder()).ok).toBe(false);
    const r = checkExecutionSpecWithinOrder(validSpec(), { ...validOrder(), acceptanceCriteria: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues[0]?.path).toBe("/order/acceptanceCriteria");
  });
});

describe("bindExecutionSpec refuses a spec that exceeds its order", () => {
  it("returns execution_exceeds_contract first, followed by the specific violations", () => {
    const r = bindExecutionSpec({ ...validSpec(), tools: ["read", "deploy"] }, validOrder());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toEqual(["execution_exceeds_contract", "tool_not_granted"]);
    expect(r.issues[0]?.message).toContain("/tools/1 tool_not_granted");
  });

  it("still checks identity first: a digest mismatch is reported as such, not as excess", () => {
    const r = bindExecutionSpec({ ...validSpec(), tools: ["deploy"] }, { ...validOrder(), scope: "changed" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toEqual(["work_order_digest_mismatch"]);
  });
});
