import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalize } from "@getsimpledirect/vinci-contracts";
import { bindExecutionSpec, executionSpecDigest, workOrderDigest } from "./index.ts";

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
// fileURLToPath rather than import.meta.dirname: engines says node >=20 and
// import.meta.dirname arrived in 20.11.
const VECTORS = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");

const dirs = readdirSync(VECTORS, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

describe("golden vectors pin the canonical bytes and digests", () => {
  it("has four work-order and four execution-spec vectors", () => {
    expect(dirs.filter((d) => d.startsWith("work-order-"))).toHaveLength(4);
    expect(dirs.filter((d) => d.startsWith("execution-spec-"))).toHaveLength(4);
    expect(dirs).toHaveLength(8);
  });

  it("vector 4 carries path: grants on the order and a narrower paths list on the spec, both inside the digest", () => {
    // The path: token is not special-cased anywhere in canonicalization: it
    // is a string in grantedAuthority, in array order, like every other grant.
    const order = readFileSync(join(VECTORS, "work-order-4-path-grants", "canonical.txt"), "utf8");
    expect(order).toContain('"path:packages/work-orders/src/","path:packages/work-orders/README.md"');
    const spec = readFileSync(join(VECTORS, "execution-spec-4-path-grants", "canonical.txt"), "utf8");
    expect(spec).toContain('"paths":["packages/work-orders/src/path-grant.test.ts","packages/work-orders/README.md"]');
    expect(readFileSync(join(VECTORS, "execution-spec-4-path-grants", "digest.txt"), "utf8").trim())
      .toBe("0f303947b88fdbb55bbba984d7f32a888110f59cc578963bf56ff1b5e6109d89");
    expect(readFileSync(join(VECTORS, "work-order-4-path-grants", "digest.txt"), "utf8").trim())
      .toBe("23c411493b683ce9061662903ef9fa7aa6b53f9ec36af049ece547d5f517e18f");
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

  it("every execution-spec vector binds to its work-order vector: right digest, and within its grants", () => {
    const orders = new Map<string, unknown>();
    for (const dir of dirs.filter((d) => d.startsWith("work-order-"))) {
      const input = JSON.parse(readFileSync(join(VECTORS, dir, "input.json"), "utf8"));
      orders.set(input.id, input);
    }
    for (const dir of dirs.filter((d) => d.startsWith("execution-spec-"))) {
      const spec = JSON.parse(readFileSync(join(VECTORS, dir, "input.json"), "utf8"));
      const order = orders.get(spec.workOrderId);
      expect(order, dir).toBeDefined();
      const bound = bindExecutionSpec(spec, order as never);
      expect(bound.ok ? "bound" : bound.issues.map((i) => `${i.path}:${i.code}`).join(","), dir).toBe("bound");
    }
  });
});

describe("float cases are pinned for both languages", () => {
  /**
   * No fixture carries a float any more (money became an integer), so the
   * Node/Python agreement on float formatting — the place two runtimes most
   * plausibly diverge — is pinned here from a shared file that the Python
   * test reads too. The JSON text is the input; each side parses it with its
   * own JSON parser and must print the pinned bytes.
   */
  const cases: ReadonlyArray<{ input: number; canonical: string }> = JSON.parse(
    readFileSync(join(VECTORS, "float-cases.json"), "utf8"),
  );
  it("has at least the three cases both sides must agree on", () => {
    expect(cases.map((c) => c.canonical)).toEqual(expect.arrayContaining(["1e+21", "1e-7", "0.1"]));
  });
  for (const { input, canonical } of cases) {
    it(`encodes ${canonical} to exactly the pinned bytes`, () => {
      expect(canonicalize(input)).toBe(canonical);
    });
  }
});
