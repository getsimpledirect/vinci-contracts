import { describe, it, expect } from "vitest";
import {
  assertSchemaMetaComplete,
} from "@vinci/contracts";
import {
  EVIDENCE_KINDS,
  EVIDENCE_SOURCE_KINDS,
  EVIDENCE_PROVENANCE_CASES,
  VERDICT_STALENESS_TRIGGERS,
  EVIDENCE_RECORD_SCHEMA_META,
  type EvidenceProvenance,
  type EvidenceSourceKind,
  type VerdictAssessment,
  isProvenanceConsistent,
  verdictAssessmentFromBoolean,
} from "./index.ts";

describe("Evidence package", () => {
  describe("Evidence kinds", () => {
    it("should have 19 evidence kinds", () => {
      expect(EVIDENCE_KINDS).toHaveLength(19);
    });

    it("should include all required kinds", () => {
      expect(EVIDENCE_KINDS).toContain("command_execution");
      expect(EVIDENCE_KINDS).toContain("unit_test");
      expect(EVIDENCE_KINDS).toContain("screenshot");
      expect(EVIDENCE_KINDS).toContain("human_approval");
    });
  });

  describe("Evidence source kinds", () => {
    it("should have exactly two source kinds", () => {
      expect(EVIDENCE_SOURCE_KINDS).toHaveLength(2);
    });

    it("should be runner or supervised", () => {
      expect(EVIDENCE_SOURCE_KINDS).toEqual(["runner", "supervised"]);
    });

    it("should be distinct from provenance", () => {
      // Source answers "how was this collected?"
      // Provenance answers "who vouches for it?"
      // Both are kept separate (D4)
      expect(EVIDENCE_SOURCE_KINDS).not.toContain("worker_provided");
      expect(EVIDENCE_SOURCE_KINDS).not.toContain("system_observed");
    });
  });

  describe("Evidence provenance (FR-6.3)", () => {
    it("should have four provenance cases", () => {
      expect(EVIDENCE_PROVENANCE_CASES).toHaveLength(4);
    });

    it("should be distinct from each other", () => {
      const cases = [...EVIDENCE_PROVENANCE_CASES];
      expect(cases).toEqual([
        "worker_provided",
        "system_observed",
        "human_provided",
        "independent_verifier",
      ]);
    });

    it("should distinguish worker from independent_verifier", () => {
      // FR-7.3 requires disclosing non-independence
      expect(EVIDENCE_PROVENANCE_CASES).toContain("worker_provided");
      expect(EVIDENCE_PROVENANCE_CASES).toContain("independent_verifier");
    });

    it("should be orthogonal to source kinds", () => {
      // Four provenance × two sources = 8 valid combinations
      const provenances = EVIDENCE_PROVENANCE_CASES.length;
      const sources = EVIDENCE_SOURCE_KINDS.length;
      expect(provenances).toBe(4);
      expect(sources).toBe(2);
      expect(provenances * sources).toBe(8);
    });
  });

  describe("Provenance consistency validation", () => {
    it("should accept worker_provided with worker actor", () => {
      const result = isProvenanceConsistent("worker_provided", {
        kind: "worker",
        workerId: "w1" as any,
      });
      expect(result).toBe(true);
    });

    it("should reject worker_provided with system actor", () => {
      const result = isProvenanceConsistent("worker_provided", {
        kind: "system",
        component: "scheduler",
      });
      expect(result).toBe(false);
    });

    it("should accept system_observed with system actor", () => {
      const result = isProvenanceConsistent("system_observed", {
        kind: "system",
        component: "monitor",
      });
      expect(result).toBe(true);
    });

    it("should accept human_provided with user actor", () => {
      const result = isProvenanceConsistent("human_provided", {
        kind: "user",
        userId: "u1" as any,
      });
      expect(result).toBe(true);
    });

    it("should accept independent_verifier with verifier actor", () => {
      const result = isProvenanceConsistent("independent_verifier", {
        kind: "verifier",
        verifierId: "v1",
        independent: true,
      });
      expect(result).toBe(true);
    });
  });

  describe("Verdict staleness (FR-7.4)", () => {
    it("should have five staleness triggers", () => {
      expect(VERDICT_STALENESS_TRIGGERS).toHaveLength(5);
    });

    it("should express all five FR-7.4 conditions", () => {
      expect(VERDICT_STALENESS_TRIGGERS).toContain("mutation_any");
      expect(VERDICT_STALENESS_TRIGGERS).toContain("artifact_digest_changed");
      expect(VERDICT_STALENESS_TRIGGERS).toContain("policy_configuration_changed");
      expect(VERDICT_STALENESS_TRIGGERS).toContain("required_evidence_expired");
      expect(VERDICT_STALENESS_TRIGGERS).toContain("worker_resumed_and_modified");
    });

    it("should include both mutation-driven and digest-based triggers", () => {
      // Current mechanism (coarse): mutation_any
      // Future mechanism (precise): artifact_digest_changed
      expect(VERDICT_STALENESS_TRIGGERS).toContain("mutation_any");
      expect(VERDICT_STALENESS_TRIGGERS).toContain("artifact_digest_changed");
    });
  });

  describe("VerdictAssessment discriminated union", () => {
    it("should make current verdicts structurally readable", () => {
      const current: VerdictAssessment = {
        kind: "current",
        status: "VERIFIED_PASS",
      };
      // TypeScript forces the caller to check kind before accessing status
      if (current.kind === "current") {
        expect(current.status).toBe("VERIFIED_PASS");
      }
    });

    it("should make stale verdicts structurally distinguishable", () => {
      const stale: VerdictAssessment = {
        kind: "stale",
        reason: "mutation_any",
        triggers: ["mutation_any"],
      };
      // TypeScript prevents reading status on stale verdicts
      if (stale.kind === "stale") {
        expect(stale.reason).toBe("mutation_any");
        expect(stale.triggers).toContain("mutation_any");
        // @ts-expect-error Cannot access status on stale verdict
        stale.status;
      }
    });

    it("should make it impossible to accidentally read stale as current", () => {
      const assessment: VerdictAssessment = {
        kind: "stale",
        reason: "code_changed",
        triggers: ["mutation_any"],
      };
      // This is a type error if uncommented:
      // const status = assessment.status; // Error: stale has no status field
      // Caller must check kind first
      if (assessment.kind === "current") {
        // This branch never executes
        const _never = assessment.status;
      }
    });
  });

  describe("VerdictAssessment conversion", () => {
    it("should convert current boolean verdict to current assessment", () => {
      const assessment = verdictAssessmentFromBoolean("VERIFIED_PASS", false);
      expect(assessment.kind).toBe("current");
      if (assessment.kind === "current") {
        expect(assessment.status).toBe("VERIFIED_PASS");
      }
    });

    it("should convert stale boolean verdict to stale assessment", () => {
      const assessment = verdictAssessmentFromBoolean("VERIFIED_PASS", true);
      expect(assessment.kind).toBe("stale");
      if (assessment.kind === "stale") {
        expect(assessment.reason).toBe("stale");
        expect(assessment.triggers).toEqual([]);
      }
    });
  });

  describe("Schema metadata", () => {
    it("should have complete SchemaMeta for EvidenceRecord", () => {
      // This should not throw
      expect(() => assertSchemaMetaComplete(EVIDENCE_RECORD_SCHEMA_META)).not.toThrow();
    });

    it("should have correct schema id", () => {
      expect(EVIDENCE_RECORD_SCHEMA_META.id).toBe("vinci.evidence-record");
    });

    it("should be version 1", () => {
      expect(EVIDENCE_RECORD_SCHEMA_META.version).toBe(1);
    });

    it("should be additive-only compatible", () => {
      expect(EVIDENCE_RECORD_SCHEMA_META.compatibility).toBe("additive-only");
    });

    it("should preserve unknown fields", () => {
      expect(EVIDENCE_RECORD_SCHEMA_META.unknownFields).toBe("preserve");
    });

    it("should fail closed on malformed data", () => {
      expect(EVIDENCE_RECORD_SCHEMA_META.malformedData).toBe("fail-closed");
    });

    it("should have none migration at version 1", () => {
      expect(EVIDENCE_RECORD_SCHEMA_META.migration).toBe("none");
    });
  });
});
