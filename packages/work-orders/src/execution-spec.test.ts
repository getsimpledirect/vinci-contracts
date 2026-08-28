import { describe, expect, it } from "vitest";
import {
  EVIDENCE_POLICIES,
  bindExecutionSpec,
  executionSpecDigest,
  validateExecutionSpec,
  workOrderDigest,
  type ExecutionSpec,
  type WorkOrder,
} from "./index.ts";
import { reversed, validOrder, validSpec } from "./fixtures.test-helpers.ts";

describe("validateExecutionSpec fails closed", () => {
  it("accepts a well-formed spec, with and without a provider", () => {
    expect(validateExecutionSpec(validSpec()).ok).toBe(true);
    expect(validateExecutionSpec({ ...validSpec(), provider: "deepinfra" }).ok).toBe(true);
  });

  const codes = (input: unknown): string[] => {
    const r = validateExecutionSpec(input);
    return r.ok ? [] : r.issues.map((i) => `${i.path}:${i.code}`);
  };

  it("rejects unknown fields at every level", () => {
    expect(codes({ ...validSpec(), repo: "x" })).toContain("/repo:unknown_field");
    expect(codes({ ...validSpec(), repository: { ...validSpec().repository, url: "x" } })).toContain("/repository/url:unknown_field");
    expect(codes({ ...validSpec(), resourceBounds: { ...validSpec().resourceBounds, gpu: 1 } })).toContain("/resourceBounds/gpu:unknown_field");
    expect(codes({ ...validSpec(), inputArtifacts: [{ id: "a", digest: "a".repeat(64), url: "x" }] })).toContain("/inputArtifacts/0/url:unknown_field");
  });

  it("rejects each malformed field", () => {
    expect(codes({ ...validSpec(), schemaVersion: 2 })).toContain("/schemaVersion:invalid_schema_version");
    expect(codes({ ...validSpec(), workOrderDigest: "A".repeat(64) })).toContain("/workOrderDigest:invalid_digest");
    expect(codes({ ...validSpec(), baseCommit: "60bd211" })).toContain("/baseCommit:invalid_commit");
    expect(codes({ ...validSpec(), baseCommit: "60BD211A3F4C5D6E7F8091A2B3C4D5E6F7A8B9C0" })).toContain("/baseCommit:invalid_commit");
    expect(codes({ ...validSpec(), targetBranch: "feat/rate limit" })).toContain("/targetBranch:invalid_ref");
    expect(codes({ ...validSpec(), repository: { host: "GitHub.com", owner: "o", name: "n" } })).toContain("/repository/host:invalid_host");
    expect(codes({ ...validSpec(), modelClass: "" })).toContain("/modelClass:invalid_model_class");
    expect(codes({ ...validSpec(), provider: "" })).toContain("/provider:invalid_provider");
    expect(codes({ ...validSpec(), resourceBounds: { ...validSpec().resourceBounds, budgetUsd: -1 } })).toContain("/resourceBounds/budgetUsd:invalid_budget");
    // NaN is refused one layer down, by toPlainRecord; either way it never validates.
    expect(codes({ ...validSpec(), resourceBounds: { ...validSpec().resourceBounds, budgetUsd: Number.NaN } }).length).toBeGreaterThan(0);
    expect(codes({ ...validSpec(), resourceBounds: { ...validSpec().resourceBounds, maxRuntimeS: 0 } })).toContain("/resourceBounds/maxRuntimeS:invalid_runtime");
    expect(codes({ ...validSpec(), resourceBounds: { ...validSpec().resourceBounds, deadline: "2026-08-23T12:05:00.000Z" } })).toContain("/resourceBounds/deadline:deadline_not_after_issuance");
    expect(codes({ ...validSpec(), tools: ["read", "read"] })).toContain("/tools/1:duplicate_entry");
    expect(codes({ ...validSpec(), tools: [""] })).toContain("/tools/0:invalid_tool");
    expect(codes({ ...validSpec(), requiredCapabilities: ["Structured Evidence"] })).toContain("/requiredCapabilities/0:invalid_capability");
    expect(codes({ ...validSpec(), inputArtifacts: [{ id: "a", digest: "a".repeat(64) }, { id: "a", digest: "b".repeat(64) }] })).toContain("/inputArtifacts/1/id:duplicate_artifact");
    expect(codes({ ...validSpec(), inputArtifacts: [{ id: "a", digest: "nope" }] })).toContain("/inputArtifacts/0/digest:invalid_digest");
    expect(codes({ ...validSpec(), evidencePolicy: "pull_request" })).toContain("/evidencePolicy:unknown_evidence_policy");
    expect(codes({ ...validSpec(), issuedAt: "2026-08-23T12:05:00Z" })).toContain("/issuedAt:invalid_timestamp");
    expect(codes(null).length).toBeGreaterThan(0);
  });

  it("the evidence-policy vocabulary is closed and small", () => {
    expect([...EVIDENCE_POLICIES]).toEqual(["pr", "receipt", "none"]);
  });
});

describe("executionSpecDigest and the handoff triple", () => {
  it("digests are key-order independent and change on any field", () => {
    const base = executionSpecDigest(validSpec());
    expect(executionSpecDigest(reversed(validSpec()) as ExecutionSpec)).toBe(base);
    expect(executionSpecDigest({ ...validSpec(), baseCommit: "1".repeat(40) })).not.toBe(base);
    expect(executionSpecDigest({ ...validSpec(), provider: "deepinfra" })).not.toBe(base);
    expect(executionSpecDigest({ ...validSpec(), tools: ["bash", "edit", "read"] })).not.toBe(base);
  });

  it("refuses to digest an invalid spec", () => {
    expect(() => executionSpecDigest({ ...validSpec(), baseCommit: "short" })).toThrow(/invalid_commit/);
  });

  it("binds a spec to the exact order it was compiled from", () => {
    const order = validOrder();
    const result = bindExecutionSpec(validSpec(order), order);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      work_order_id: "wo-1",
      contract_digest: workOrderDigest(order),
      execution_spec_digest: executionSpecDigest(validSpec(order)),
    });
  });

  it("rejects a spec whose workOrderDigest is not the digest of the given order", () => {
    // Same id, different contract version: the dangerous pairing.
    const original = validOrder();
    const amended: WorkOrder = {
      ...original,
      contractVersion: 2,
      supersedes: { contractVersion: 1, amendmentId: "am-1" },
      scope: "The /v1 AND /v2 HTTP handlers.",
    };
    const spec = validSpec(original);
    const result = bindExecutionSpec(spec, amended);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toEqual(["work_order_digest_mismatch"]);
  });

  it("rejects an id mismatch even when the digest matches nothing", () => {
    const other = { ...validOrder(), id: "wo-2" };
    const result = bindExecutionSpec(validSpec(), other);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((i) => i.code)).toEqual(["work_order_id_mismatch", "work_order_digest_mismatch"]);
  });

  it("reports an invalid order as a binding failure, not an exception", () => {
    const broken = { ...validOrder(), acceptanceCriteria: [] };
    const result = bindExecutionSpec(validSpec(), broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe("/order/acceptanceCriteria");
  });
});
