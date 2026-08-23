import { describe, expect, it } from "vitest";
import { assertSchemaMetaComplete } from "@vinci/contracts";
import {
  EVIDENCE_RECORD_SCHEMA_META,
  VERDICT_ASSESSMENT_SCHEMA_META,
  validateEvidenceRecord,
  validateVerdictAssessment,
} from "./index.ts";

const validEvidenceRecord = () => ({
  schemaVersion: 1,
  id: "evidence-1",
  attestation: {
    provenance: "worker_provided",
    actor: { kind: "worker", workerId: "worker-1" },
  },
  kind: "unit_test",
  mode: "execution",
  reliability: "strong",
  sourceKind: "runner",
  summary: "All unit tests passed",
  recordedAt: "2026-08-23T12:34:56.789Z",
});

function expectIssue(
  result: ReturnType<typeof validateEvidenceRecord> | ReturnType<typeof validateVerdictAssessment>,
  path: string,
  code: string,
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.issues).toContainEqual(expect.objectContaining({ path, code }));
  }
}

describe("validateEvidenceRecord", () => {
  it("accepts a complete record without changing its value", () => {
    const input = validEvidenceRecord();
    const result = validateEvidenceRecord(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(input);
      expect(result.unknownFields).toEqual({});
    }
  });

  it("rejects a missing required field at its JSON pointer", () => {
    const { summary: _summary, ...input } = validEvidenceRecord();

    expectIssue(validateEvidenceRecord(input), "/summary", "required_field");
  });

  it("rejects a field with the wrong type at its JSON pointer", () => {
    expectIssue(
      validateEvidenceRecord({ ...validEvidenceRecord(), recordedAt: 42 }),
      "/recordedAt",
      "invalid_timestamp",
    );
  });

  it("rejects an invalid schema version", () => {
    expectIssue(
      validateEvidenceRecord({ ...validEvidenceRecord(), schemaVersion: 2 }),
      "/schemaVersion",
      "invalid_literal",
    );
  });

  it.each([
    ["kind", "future_evidence", "/kind"],
    ["mode", "probabilistic", "/mode"],
    ["reliability", "perfect", "/reliability"],
    ["sourceKind", "manual", "/sourceKind"],
  ] as const)("rejects an invalid %s enum value", (field, value, path) => {
    expectIssue(
      validateEvidenceRecord({ ...validEvidenceRecord(), [field]: value }),
      path,
      "invalid_enum",
    );
  });

  it("rejects an invalid attestation provenance enum value", () => {
    expectIssue(
      validateEvidenceRecord({
        ...validEvidenceRecord(),
        attestation: {
          ...validEvidenceRecord().attestation,
          provenance: "self_asserted",
        },
      }),
      "/attestation/provenance",
      "invalid_enum",
    );
  });

  it("rejects an invalid actor kind enum value", () => {
    expectIssue(
      validateEvidenceRecord({
        ...validEvidenceRecord(),
        attestation: {
          provenance: "worker_provided",
          actor: { kind: "robot", workerId: "worker-1" },
        },
      }),
      "/attestation/actor/kind",
      "invalid_enum",
    );
  });

  it("preserves unknown fields verbatim at their JSON pointers", () => {
    const futureValue = { nested: [1, "two", { three: true }] };
    const result = validateEvidenceRecord({
      ...validEvidenceRecord(),
      futureEvidence: futureValue,
      attestation: {
        ...validEvidenceRecord().attestation,
        futureAttestation: "kept",
      },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unknownFields["/futureEvidence"]).toBe(futureValue);
      expect(result.unknownFields["/attestation/futureAttestation"]).toBe("kept");
      expect(result.value).toHaveProperty("futureEvidence", futureValue);
    }
  });
});

describe("validateVerdictAssessment", () => {
  it("accepts a current assessment and returns its status", () => {
    const input = { kind: "current", status: "VERIFIED_PASS" };
    const result = validateVerdictAssessment(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("current");
      if (result.value.kind === "current") {
        expect(result.value.status).toBe("VERIFIED_PASS");
      }
    }
  });

  it("accepts a stale assessment and returns its triggers", () => {
    const input = {
      kind: "stale",
      reason: "policy changed",
      triggers: ["policy_configuration_changed"],
    };
    const result = validateVerdictAssessment(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.kind).toBe("stale");
      if (result.value.kind === "stale") {
        expect(result.value.reason).toBe("policy changed");
        expect(result.value.triggers).toEqual(["policy_configuration_changed"]);
      }
    }
  });

  it("rejects an invalid discriminator enum value", () => {
    expectIssue(validateVerdictAssessment({ kind: "expired" }), "/kind", "invalid_enum");
  });

  it("rejects a verdict status outside the declared union", () => {
    expectIssue(
      validateVerdictAssessment({ kind: "current", status: "FAILED" }),
      "/status",
      "invalid_enum",
    );
  });

  it("rejects a staleness trigger outside the declared union", () => {
    expectIssue(
      validateVerdictAssessment({
        kind: "stale",
        reason: "changed",
        triggers: ["time_travel"],
      }),
      "/triggers/0",
      "invalid_enum",
    );
  });

  it("rejects a missing field required by the selected union arm", () => {
    expectIssue(
      validateVerdictAssessment({ kind: "stale", triggers: ["mutation_any"] }),
      "/reason",
      "required_field",
    );
  });

  it("preserves an unknown field verbatim", () => {
    const futureValue = { confidence: 0.95 };
    const result = validateVerdictAssessment({
      kind: "current",
      status: "CONDITIONAL",
      futureAssessment: futureValue,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unknownFields["/futureAssessment"]).toBe(futureValue);
      expect(result.value).toHaveProperty("futureAssessment", futureValue);
    }
  });
});

describe("a worker cannot vouch for itself as an independent verifier", () => {
  // Architectural principle 2: the worker does not issue its own verdict.
  // FR-6.3: receipts must distinguish worker-provided from independent-verifier
  // evidence. Neither holds if a record can simply assert the distinction —
  // provenance and actor were validated as two unrelated enums, so nothing
  // connected the claim to who actually made it.
  const record = (attestation: unknown) => ({ ...validEvidenceRecord(), attestation });

  it("refuses independent-verifier provenance from a worker", () => {
    const result = validateEvidenceRecord(
      record({ provenance: "independent_verifier", actor: { kind: "worker", workerId: "worker-1" } }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "provenance_actor_mismatch")).toBe(true);
  });

  it("refuses independent-verifier provenance from a verifier that is not independent", () => {
    // FR-7.3 allows the same model to work and verify, but requires the product
    // to DISCLOSE that the verifier is not independent. Letting the record
    // claim independence hides exactly what must be disclosed.
    const result = validateEvidenceRecord(
      record({
        provenance: "independent_verifier",
        actor: { kind: "verifier", verifierId: "v-1", independent: false },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "verifier_not_independent")).toBe(true);
  });

  it("accepts an actually independent verifier", () => {
    expect(
      validateEvidenceRecord(
        record({
          provenance: "independent_verifier",
          actor: { kind: "verifier", verifierId: "v-1", independent: true },
        }),
      ).ok,
    ).toBe(true);
  });

  it("pairs every provenance case with exactly one actor kind", () => {
    const pairs = [
      ["worker_provided", { kind: "worker", workerId: "w-1" }],
      ["system_observed", { kind: "system", component: "runner" }],
      ["human_provided", { kind: "user", userId: "u-1" }],
      ["independent_verifier", { kind: "verifier", verifierId: "v-1", independent: true }],
    ] as const;
    for (const [provenance, actor] of pairs) {
      expect(validateEvidenceRecord(record({ provenance, actor })).ok, provenance).toBe(true);
    }
    // and every mismatched pairing is refused
    for (const [provenance] of pairs) {
      for (const [, actor] of pairs) {
        const result = validateEvidenceRecord(record({ provenance, actor }));
        const matches = pairs.find(([p]) => p === provenance)?.[1] === actor;
        expect(result.ok, `${provenance} with ${actor.kind}`).toBe(matches);
      }
    }
  });
});

describe("a stale assessment cannot carry a live pass", () => {
  it("refuses a stale assessment that also has a status", () => {
    // The discriminant said stale; the payload said VERIFIED_PASS, and the
    // value round-tripped intact for any reader that did not know to ignore it.
    const result = validateVerdictAssessment({
      kind: "stale",
      status: "VERIFIED_PASS",
      reason: "files changed",
      triggers: ["mutation_any"],
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "field_not_valid_for_kind")).toBe(true);
  });

  it("refuses a current assessment carrying staleness fields", () => {
    const result = validateVerdictAssessment({
      kind: "current",
      status: "VERIFIED_PASS",
      reason: "files changed",
    });
    expect(result.ok).toBe(false);
  });
});

describe("timestamps", () => {
  it("refuses a date that does not exist", () => {
    // 2026 is not a leap year. Date.parse normalises this to March 1 rather
    // than rejecting it, so the round-trip comparison is what catches it —
    // and is what makes evidence agree with model-classes and approvals.
    const result = validateEvidenceRecord({
      ...validEvidenceRecord(),
      recordedAt: "2026-02-29T12:34:56.789Z",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "invalid_timestamp")).toBe(true);
  });

  it("still accepts a real one", () => {
    expect(validateEvidenceRecord(validEvidenceRecord()).ok).toBe(true);
  });
});

describe("schema metadata", () => {
  it("answers the six questions for every schema this package exports", () => {
    // The evidence package was the only one without a meta conformance test,
    // and VerdictAssessment had no SchemaMeta at all.
    for (const meta of [EVIDENCE_RECORD_SCHEMA_META, VERDICT_ASSESSMENT_SCHEMA_META]) {
      expect(() => assertSchemaMetaComplete(meta)).not.toThrow();
    }
  });
});
