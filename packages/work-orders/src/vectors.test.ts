import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalize } from "@getsimpledirect/vinci-contracts";
import { executionSpecDigest, workOrderDigest } from "./index.ts";

/**
 * Golden vectors, shared with the Python implementation.
 *
 * Each directory under ../vectors holds an input.json, the exact canonical
 * bytes (canonical.txt) and the digest (digest.txt). This test REGENERATES both
 * from the input and compares; python/test_vinci_canonical.py does the same
 * from the other language. A change to canonicalization, to what a digest
 * covers, or to a fixture, fails here and there — which is the point: the
 * vectors are the contract, and neither implementation gets to redefine it
 * alone. Regenerate with vectors/generate.mjs only as a deliberate act.
 */
const VECTORS = join(import.meta.dirname, "..", "vectors");

const dirs = readdirSync(VECTORS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

describe("golden vectors pin the canonical bytes and digests", () => {
  it("has three work-order and three execution-spec vectors", () => {
    expect(dirs.filter((d) => d.startsWith("work-order-"))).toHaveLength(3);
    expect(dirs.filter((d) => d.startsWith("execution-spec-"))).toHaveLength(3);
    expect(dirs).toHaveLength(6);
  });

  for (const dir of dirs) {
    const kind = dir.startsWith("work-order-") ? "work-order" : "execution-spec";
    it(`${dir}: canonical bytes and digest match the committed vector`, () => {
      const input = JSON.parse(readFileSync(join(VECTORS, dir, "input.json"), "utf8"));
      const canonical = readFileSync(join(VECTORS, dir, "canonical.txt"), "utf8");
      const digest = readFileSync(join(VECTORS, dir, "digest.txt"), "utf8").trim();
      expect(canonicalize(input)).toBe(canonical);
      const computed = kind === "work-order" ? workOrderDigest(input) : executionSpecDigest(input);
      expect(computed).toBe(digest);
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    });
  }

  it("every execution-spec vector names the digest of the work-order vector it points at", () => {
    const orders = new Map<string, string>();
    for (const dir of dirs.filter((d) => d.startsWith("work-order-"))) {
      const input = JSON.parse(readFileSync(join(VECTORS, dir, "input.json"), "utf8"));
      orders.set(input.id, workOrderDigest(input));
    }
    for (const dir of dirs.filter((d) => d.startsWith("execution-spec-"))) {
      const spec = JSON.parse(readFileSync(join(VECTORS, dir, "input.json"), "utf8"));
      expect(orders.get(spec.workOrderId), dir).toBe(spec.workOrderDigest);
    }
  });
});
