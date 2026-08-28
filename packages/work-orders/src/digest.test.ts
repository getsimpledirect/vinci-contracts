import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "@getsimpledirect/vinci-contracts";
import { workOrderDigest, type WorkOrder } from "./index.ts";
import { reversed, validOrder } from "./fixtures.test-helpers.ts";

describe("workOrderDigest identifies the exact contract", () => {
  it("is a lowercase hex SHA-256 of the canonical encoding", () => {
    const expected = createHash("sha256").update(canonicalize(validOrder()), "utf8").digest("hex");
    expect(workOrderDigest(validOrder())).toBe(expected);
    expect(workOrderDigest(validOrder())).toMatch(/^[0-9a-f]{64}$/);
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

