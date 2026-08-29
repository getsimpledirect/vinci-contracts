import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GRANT_PREFIXES,
  PATH_ROOT_REFUSALS,
  bindExecutionSpec,
  checkExecutionSpecWithinOrder,
  executionSpecDigest,
  parsePathGrant,
  parsePathRoot,
  pathRootCovers,
  validateExecutionSpec,
  validateWorkOrder,
  workOrderDigest,
  type ExecutionSpec,
  type PathRootRefusal,
  type WorkOrder,
} from "./index.ts";
import { validOrder, validSpec } from "./fixtures.test-helpers.ts";

/**
 * The path: grammar's golden cases live in ../vectors/path-grant-cases.json so
 * that vinci-gpu-control's vendored Python grammar can read the same file.
 * This test is the Node side of that agreement.
 */
type Cases = {
  readonly accepted: ReadonlyArray<{ token: string; root: string; kind: "directory" | "file" }>;
  readonly refused: ReadonlyArray<{ token: string; reason: PathRootRefusal }>;
  readonly monotonicity: ReadonlyArray<{ parent: string; child: string; covers: boolean }>;
};
const cases: Cases = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "vectors", "path-grant-cases.json"), "utf8"),
);

const BASE_GRANTS = ["tool:read", "tool:edit", "tool:bash", "repo:github.com/getsimpledirect/vinci-contracts", "branch:feat/*", "promotion:pull_request"];
const orderWithPaths = (pathGrants: readonly string[]): WorkOrder =>
  ({ ...validOrder(), grantedAuthority: [...BASE_GRANTS, ...pathGrants] });
const specWithPaths = (order: WorkOrder, paths: readonly string[]): ExecutionSpec => ({ ...validSpec(order), paths });
const withinCodes = (spec: ExecutionSpec, order: WorkOrder): string[] => {
  const r = checkExecutionSpecWithinOrder(spec, order);
  return r.ok ? [] : r.issues.map((i) => `${i.path}:${i.code}`);
};
const orderCodes = (order: unknown): string[] => {
  const r = validateWorkOrder(order);
  return r.ok ? [] : r.issues.map((i) => `${i.path}:${i.code}`);
};
const specCodes = (spec: unknown): string[] => {
  const r = validateExecutionSpec(spec);
  return r.ok ? [] : r.issues.map((i) => `${i.path}:${i.code}`);
};

describe("path: grant grammar (shared cases)", () => {
  it("is a registered machine-readable prefix", () => {
    expect(GRANT_PREFIXES).toContain("path:");
  });

  it("the shared file exercises the five refusals the contract names, plus every typed reason", () => {
    const tokens = cases.refused.map((c) => c.token);
    expect(tokens).toEqual(expect.arrayContaining(["path:.", "path:/etc", "path:a/../b", "path:a\\b", "path:"]));
    const reasons = new Set(cases.refused.map((c) => c.reason));
    for (const reason of PATH_ROOT_REFUSALS) {
      if (reason === "too_long") continue; // pinned below; a 1025-character token does not belong in a JSON file
      expect(reasons.has(reason), reason).toBe(true);
    }
  });

  for (const { token, root, kind } of cases.accepted) {
    it(`accepts ${JSON.stringify(token)} as a ${kind} root`, () => {
      expect(parsePathGrant(token)).toEqual({ ok: true, value: { root, kind } });
      // As an order grant, and as a spec path entry.
      expect(orderCodes(orderWithPaths([token]))).toEqual([]);
      expect(specCodes({ ...validSpec(), paths: [root] })).toEqual([]);
    });
  }

  for (const { token, reason } of cases.refused) {
    it(`refuses ${JSON.stringify(token)} with reason ${reason}`, () => {
      expect(parsePathGrant(token)).toEqual({ ok: false, reason });
      // The order carrying it is invalid, with the reason typed into the code…
      expect(orderCodes(orderWithPaths([token]))).toEqual([`/grantedAuthority/${BASE_GRANTS.length}:path_grant_${reason}`]);
      // …and so is a spec asking for the same root directly.
      expect(specCodes({ ...validSpec(), paths: [token.slice("path:".length)] })).toEqual([`/paths/0:path_grant_${reason}`]);
      // Neither record can be digested.
      expect(() => workOrderDigest(orderWithPaths([token]))).toThrow(`path_grant_${reason}`);
      expect(() => executionSpecDigest({ ...validSpec(), paths: [token.slice("path:".length)] })).toThrow(`path_grant_${reason}`);
    });
  }

  it("refuses a root longer than 1024 characters, and accepts one of exactly 1024", () => {
    expect(parsePathRoot("a".repeat(1024))).toEqual({ ok: true, value: { root: "a".repeat(1024), kind: "file" } });
    expect(parsePathRoot("a".repeat(1025))).toEqual({ ok: false, reason: "too_long" });
  });

  it("never normalises: the refused token is refused, not rewritten", () => {
    // "a/../b" would normalise to "b", which the order below DOES grant. It is
    // still refused, because a grant that needs cleaning is a grant two
    // implementations can clean differently.
    expect(orderCodes(orderWithPaths(["path:b", "path:a/../b"]))).toEqual([`/grantedAuthority/${BASE_GRANTS.length + 1}:path_grant_dotdot_segment`]);
  });

  it("is not a path: grant at all when the prefix is absent or different", () => {
    expect(parsePathGrant("paths:src/")).toBeNull();
    expect(parsePathGrant("Path:src/")).toBeNull();
    expect(parsePathGrant("edit files under src/api")).toBeNull();
    expect(parsePathGrant(42)).toBeNull();
    expect(parsePathRoot(42)).toEqual({ ok: false, reason: "empty" });
  });

  it("dedupes exactly as the other tokens do: a repeated path root is a duplicate, not a wider grant", () => {
    expect(orderCodes(orderWithPaths(["path:src/", "path:src/"]))).toEqual([`/grantedAuthority/${BASE_GRANTS.length + 1}:duplicate_grant`]);
    expect(specCodes({ ...validSpec(), paths: ["src/", "src/"] })).toEqual(["/paths/1:duplicate_entry"]);
    // "src/" and "src" are different tokens (a directory and a file of that name), so not duplicates.
    expect(orderCodes(orderWithPaths(["path:src/", "path:src"]))).toEqual([]);
  });

  it("spec.paths is optional (fail-closed: absent = may write nothing) but, when present, is an array", () => {
    expect(specCodes(validSpec())).toEqual([]);
    expect(specCodes({ ...validSpec(), paths: [] })).toEqual([]);
    expect(specCodes({ ...validSpec(), paths: "src/" })).toEqual(["/paths:invalid_type"]);
    expect(specCodes({ ...validSpec(), paths: { 0: "src/" } })).toEqual(["/paths:invalid_type"]);
  });

  it("pathRootCovers is an authority guard: anything that is not a parsed root covers nothing and is covered by nothing", () => {
    const src = { root: "src/", kind: "directory" } as const;
    expect(pathRootCovers({ root: "", kind: "directory" }, src)).toBe(false);
    expect(pathRootCovers({ root: "src/", kind: "file" }, src)).toBe(false);
    expect(pathRootCovers({ root: "../", kind: "directory" }, src)).toBe(false);
    expect(pathRootCovers(src, { root: "", kind: "directory" })).toBe(false);
    expect(pathRootCovers(null as never, src)).toBe(false);
    expect(pathRootCovers(new Proxy({}, { get() { throw new Error("trap"); } }) as never, src)).toBe(false);
  });
});

describe("pathRootCovers (shared monotonicity cases)", () => {
  it("the shared file carries the three cases the contract names", () => {
    const key = (c: { parent: string; child: string }) => `${c.parent}>${c.child}`;
    const keys = cases.monotonicity.map(key);
    expect(keys).toEqual(expect.arrayContaining(["src/>src/", "src/x.ts>src/", "src/>docs/"]));
    expect(cases.monotonicity.find((c) => key(c) === "src/>src/")?.covers).toBe(true);
    expect(cases.monotonicity.find((c) => key(c) === "src/x.ts>src/")?.covers).toBe(false);
    expect(cases.monotonicity.find((c) => key(c) === "src/>docs/")?.covers).toBe(false);
  });

  for (const { parent, child, covers } of cases.monotonicity) {
    it(`parent ${JSON.stringify(parent)} ${covers ? "covers" : "does not cover"} child ${JSON.stringify(child)}`, () => {
      const p = parsePathRoot(parent);
      const c = parsePathRoot(child);
      expect(p.ok && c.ok).toBe(true);
      if (!p.ok || !c.ok) return;
      expect(pathRootCovers(p.value, c.value)).toBe(covers);

      // The same verdict through the public check: child spec under parent order.
      const order = orderWithPaths([`path:${parent}`]);
      expect(withinCodes(specWithPaths(order, [child]), order)).toEqual(covers ? [] : ["/paths/0:path_not_granted"]);
    });
  }
});

describe("checkExecutionSpecWithinOrder: spec.paths ⊆ order path: grants", () => {
  it("no path: grant on the order means no write scope: any spec path is refused, an empty or absent one is fine", () => {
    const order = orderWithPaths([]);
    expect(withinCodes(specWithPaths(order, ["src/"]), order)).toEqual(["/paths/0:path_not_granted"]);
    expect(withinCodes(specWithPaths(order, []), order)).toEqual([]);
    expect(withinCodes(validSpec(order), order)).toEqual([]);
    // Prose that mentions a path is not a grant of it.
    const prose: WorkOrder = { ...order, grantedAuthority: [...order.grantedAuthority, "edit files under src/"] };
    expect(withinCodes(specWithPaths(prose, ["src/"]), prose)).toEqual(["/paths/0:path_not_granted"]);
  });

  it("each child root needs SOME parent root; violations are reported per entry", () => {
    const order = orderWithPaths(["path:src/", "path:docs/README.md"]);
    expect(withinCodes(specWithPaths(order, ["src/a/", "docs/README.md", "src/b.ts"]), order)).toEqual([]);
    expect(withinCodes(specWithPaths(order, ["src/", "docs/", "README.md", "docs/README.md"]), order))
      .toEqual(["/paths/1:path_not_granted", "/paths/2:path_not_granted"]);
  });

  it("a spec may narrow but never widen: bindExecutionSpec refuses the widening under execution_exceeds_contract", () => {
    const order = orderWithPaths(["path:src/x.ts"]);
    const narrow = bindExecutionSpec(specWithPaths(order, ["src/x.ts"]), order);
    expect(narrow.ok).toBe(true);
    const wide = bindExecutionSpec(specWithPaths(order, ["src/"]), order);
    expect(wide.ok).toBe(false);
    if (!wide.ok) expect(wide.issues.map((i) => i.code)).toEqual(["execution_exceeds_contract", "path_not_granted"]);
  });
});
