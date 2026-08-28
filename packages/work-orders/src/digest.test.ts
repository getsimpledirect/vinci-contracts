import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { workOrderDigest, type WorkOrder } from "./index.ts";
import { reversed, validOrder } from "./fixtures.test-helpers.ts";

const VECTOR = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors", "work-order-1-minimal");

describe("workOrderDigest identifies the exact contract", () => {
  it("matches the committed golden vector, not merely its own construction", () => {
    // Expected value comes from vectors/work-order-1-minimal/digest.txt, a
    // file the Python port also asserts against. Computing it here with the
    // same canonicalize + sha256 would only prove the function equals itself.
    const input = JSON.parse(readFileSync(join(VECTOR, "input.json"), "utf8"));
    const expected = readFileSync(join(VECTOR, "digest.txt"), "utf8").trim();
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
    expect(workOrderDigest(input)).toBe(expected);
  });

  it("does not depend on key insertion order, at any depth", () => {
    const shuffled = reversed(validOrder()) as WorkOrder;
    expect(JSON.stringify(shuffled)).not.toBe(JSON.stringify(validOrder()));
    expect(workOrderDigest(shuffled)).toBe(workOrderDigest(validOrder()));
  });

  it("changes when any field changes — issuedAt, expiresAt and supersedes included", () => {
    const base = workOrderDigest(validOrder());
    const variants: WorkOrder[] = [
      { ...validOrder(), request: "Add rate limiting to the public API!" },
      { ...validOrder(), issuedAt: "2026-08-23T12:00:00.001Z" },
      { ...validOrder(), expiresAt: "2026-08-24T12:00:00.001Z" },
      { ...validOrder(), grantedAuthority: ["run the test suite", "edit files under src/api"] },
      { ...validOrder(), attentionBudget: { interruptions: 4, decisions: 2, onExhaustion: "block" } },
      { ...validOrder(), contractVersion: 2, supersedes: { contractVersion: 1, amendmentId: "am-1" } },
      { ...validOrder(), escalationRules: [...validOrder().escalationRules].reverse() },
    ];
    const digests = variants.map(workOrderDigest);
    for (const d of digests) expect(d).not.toBe(base);
    expect(new Set(digests).size).toBe(digests.length);
  });

  it("refuses an invalid order rather than giving it an identity", () => {
    expect(() => workOrderDigest({ ...validOrder(), acceptanceCriteria: [] })).toThrow(/criteria_required/);
    expect(() => workOrderDigest({ ...validOrder(), extra: 1 } as unknown as WorkOrder)).toThrow(/unknown_field/);
  });
});

