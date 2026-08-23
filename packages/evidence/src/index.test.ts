import { describe, expect, it } from "vitest";
import {
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
