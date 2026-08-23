import { describe, expect, it } from "vitest";
import {
  statusIsSupportedBy,
  validateVerdictRecord,
  type CriterionResult,
} from "./verdict-record.ts";

/**
 * A verdict that should be accepted, used as the base for every negative case.
 *
 * Positive controls are not decoration here. Fourteen of the checks below are
 * negative, and a validator that rejects everything satisfies all fourteen
 * while being useless. Each negative case mutates exactly one field of a record
 * proven acceptable, so a failure localises to that field rather than to any of
 * the other fourteen things the record has to get right.
 */
function validRecord(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    status: "VERIFIED_PASS",
    snapshotDigest: "a".repeat(64),
    summary: "The endpoint returns 404 for unknown ids.",
    scope: "GET /widgets/:id at commit abc123, error paths only",
    criterionResults: [
      {
        criterionId: "criterion.not-found",
        status: "supported",
        summary: "Observed 404 with an empty body for three unknown ids.",
        evidenceIds: ["evidence.exec.1"],
      },
    ],
    decisiveEvidenceIds: ["evidence.exec.1"],
    unresolvedConditions: [],
    residualRisks: [],
    notTested: [],
    policyVersion: "policy.v3",
    evaluatorVersion: "evaluator.2026-08-01",
    issuedAt: "2026-08-23T12:00:00.000Z",
    expiresAt: "2026-08-24T12:00:00.000Z",
    staleWhen: [{ trigger: "mutation_any", value: "packages/api" }],
  };
}

/** Mutate one field of an otherwise-valid record. */
function withField(field: string, value: unknown): Record<string, unknown> {
  const record = validRecord();
  record[field] = value;
  return record;
}

describe("the base record used by every negative case is actually accepted", () => {
  it("accepts a well-formed VERIFIED_PASS", () => {
    const result = validateVerdictRecord(validRecord());
    // Surface the issues on failure; a bare `.ok === true` assertion that
    // regresses tells you nothing about which of fifteen fields broke.
    expect(result.ok ? [] : result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("accepts a CONDITIONAL carrying everything a pass may not", () => {
    const record = validRecord();
    record.status = "CONDITIONAL";
    record.criterionResults = [
      {
        criterionId: "criterion.not-found",
        status: "unknown",
        summary: "Could not reach the service.",
        evidenceIds: ["evidence.exec.1"],
      },
    ];
    record.unresolvedConditions = [
      { description: "Service was unreachable", requiredAction: "Re-run against a live host" },
    ];
    record.notTested = [{ description: "Auth paths", reason: "Out of scope for this run" }];
    record.residualRisks = [{ description: "Untested auth", severity: "medium" }];
    const result = validateVerdictRecord(record);
    expect(result.ok ? [] : result.issues).toEqual([]);
  });

  it("accepts expiresAt explicitly null", () => {
    expect(validateVerdictRecord(withField("expiresAt", null)).ok).toBe(true);
  });
});

describe("statusIsSupportedBy is a gate, not a helper", () => {
  // It is exported, so external callers reach it directly without going
  // through validateVerdictRecord. Fixing only the caller leaves this open.
  it("refuses a VERIFIED_PASS backed by zero criteria", () => {
    // The vacuous pass: `.every()` on an empty array is true, so this returned
    // true and certified the single most valuable record to forge.
    expect(statusIsSupportedBy("VERIFIED_PASS", [])).toBe(false);
  });

  it("still allows a genuinely supported pass", () => {
    const supported = [
      { criterionId: "c1", status: "supported", summary: "s", evidenceIds: ["e1"] },
    ] as unknown as CriterionResult[];
    expect(statusIsSupportedBy("VERIFIED_PASS", supported)).toBe(true);
  });

  it("refuses a pass alongside a contradicted or unknown criterion", () => {
    for (const status of ["contradicted", "unknown"]) {
      const results = [
        { criterionId: "c1", status, summary: "s", evidenceIds: ["e1"] },
      ] as unknown as CriterionResult[];
      expect(statusIsSupportedBy("VERIFIED_PASS", results), status).toBe(false);
    }
  });

  it("permits non-pass statuses regardless of criteria", () => {
    expect(statusIsSupportedBy("CONDITIONAL", [])).toBe(true);
    expect(statusIsSupportedBy("BLOCKED", [])).toBe(true);
  });

  it("refuses a status that is not a status", () => {
    // The old order tested `status !== "VERIFIED_PASS"` first, so anything that
    // was not literally that string returned TRUE — garbage in, endorsement
    // out, from a predicate whose whole job is withholding endorsement.
    for (const status of ["NOT_A_STATUS", "", "verified_pass", null, 7, undefined, {}]) {
      expect(statusIsSupportedBy(status as never, []), JSON.stringify(status)).toBe(false);
    }
  });

  it("refuses an entry whose status is an accessor or inherited", () => {
    // The plain `result.status` read this replaces had two defects. The throw
    // was reported by a reviewer; the inherited case is the one that
    // manufactures a pass, and it returned TRUE.
    const hostile: Array<[string, unknown]> = [
      ["a throwing getter", { get status() { throw new Error("hostile"); } }],
      ["a proxy get trap", new Proxy({}, { get() { throw new Error("trap"); } })],
      ["a proxy gOPD trap", new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("g"); } })],
      ["an INHERITED status", Object.create({ status: "supported" })],
      ["a status getter returning supported", { get status() { return "supported"; } }],
    ];
    for (const [label, entry] of hostile) {
      expect(() => statusIsSupportedBy("VERIFIED_PASS", [entry] as never), label).not.toThrow();
      expect(statusIsSupportedBy("VERIFIED_PASS", [entry] as never), label).toBe(false);
    }
  });

  it("refuses hostile input instead of throwing", () => {
    // An external caller has not necessarily snapshotted anything.
    expect(() => statusIsSupportedBy("VERIFIED_PASS", null as never)).not.toThrow();
    expect(statusIsSupportedBy("VERIFIED_PASS", null as never)).toBe(false);
    expect(statusIsSupportedBy("VERIFIED_PASS", [null] as never)).toBe(false);
    expect(statusIsSupportedBy("VERIFIED_PASS", ["supported"] as never)).toBe(false);
  });
});

describe("a pass must be earned", () => {
  it("rejects VERIFIED_PASS with an empty criterionResults array", () => {
    const result = validateVerdictRecord(withField("criterionResults", []));
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toContain("unearned_pass");
  });

  it("rejects VERIFIED_PASS carrying unresolved conditions", () => {
    const record = withField("unresolvedConditions", [
      { description: "Flaky under load", requiredAction: "Re-run at 100rps" },
    ]);
    expect(validateVerdictRecord(record).ok).toBe(false);
  });

  it("rejects VERIFIED_PASS carrying untested items", () => {
    const record = withField("notTested", [
      { description: "Auth paths", reason: "No credentials available" },
    ]);
    expect(validateVerdictRecord(record).ok).toBe(false);
  });

  it("rejects VERIFIED_PASS naming no decisive evidence", () => {
    expect(validateVerdictRecord(withField("decisiveEvidenceIds", [])).ok).toBe(false);
  });

  it("rejects decisive evidence no criterion ever cited", () => {
    const record = withField("decisiveEvidenceIds", ["evidence.exec.1", "evidence.never-used"]);
    const result = validateVerdictRecord(record);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toContain("uncited_evidence");
  });
});

describe("exact duplicates in the descriptive arrays are refused", () => {
  it("rejects an entry identical in every field to one already present", () => {
    const record = validRecord();
    record.status = "CONDITIONAL";
    record.residualRisks = [
      { description: "Untested auth", severity: "medium" },
      { description: "Untested auth", severity: "medium" },
    ];
    const result = validateVerdictRecord(record);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toContain("duplicate_entry");
  });

  it("rejects a duplicate disguised by key order", () => {
    // Comparison is by canonical encoding, so reordering keys does not create
    // a distinct entry.
    const record = validRecord();
    record.status = "CONDITIONAL";
    record.residualRisks = [
      { description: "Untested auth", severity: "medium" },
      { severity: "medium", description: "Untested auth" },
    ];
    expect(validateVerdictRecord(record).ok).toBe(false);
  });

  it("still allows entries that differ in any field", () => {
    // Positive control, and the actual boundary of the decision: only EXACT
    // duplicates are refused. Two risks sharing a description but differing in
    // severity are two genuine risks.
    const record = validRecord();
    record.status = "CONDITIONAL";
    record.residualRisks = [
      { description: "Untested auth", severity: "medium" },
      { description: "Untested auth", severity: "high" },
    ];
    record.notTested = [
      { description: "Auth paths", reason: "No credentials" },
      { description: "Rate limits", reason: "No credentials" },
    ];
    const result = validateVerdictRecord(record);
    expect(result.ok ? [] : result.issues).toEqual([]);
  });
});

describe("every declared field is actually checked", () => {
  it("rejects a non-canonical issuedAt", () => {
    for (const issuedAt of [
      "2026-08-23T12:00:00Z",
      "2026-08-23",
      "2026-02-29T12:00:00.000Z",
      1_756_000_000_000,
      null,
    ]) {
      expect(validateVerdictRecord(withField("issuedAt", issuedAt)).ok, String(issuedAt)).toBe(false);
    }
  });

  it("rejects an expiresAt at or before issuedAt", () => {
    // A verdict born expired reads as valid to anyone who does not check a clock.
    expect(validateVerdictRecord(withField("expiresAt", "2026-08-23T12:00:00.000Z")).ok).toBe(false);
    expect(validateVerdictRecord(withField("expiresAt", "2026-08-22T12:00:00.000Z")).ok).toBe(false);
  });

  it("rejects a residual risk with an unrecognised severity", () => {
    const record = withField("residualRisks", [{ description: "d", severity: "catastrophic" }]);
    expect(validateVerdictRecord(record).ok).toBe(false);
  });

  it("rejects a staleness condition with an unrecognised trigger", () => {
    const record = withField("staleWhen", [{ trigger: "vibes_changed", value: "x" }]);
    expect(validateVerdictRecord(record).ok).toBe(false);
  });

  it("rejects a notTested item with no reason", () => {
    // "Not tested" with no reason is indistinguishable from an oversight.
    const record = validRecord();
    record.status = "CONDITIONAL";
    record.notTested = [{ description: "Auth paths", reason: "" }];
    expect(validateVerdictRecord(record).ok).toBe(false);
  });

  it("rejects an unresolved condition with no required action", () => {
    const record = validRecord();
    record.status = "CONDITIONAL";
    record.unresolvedConditions = [{ description: "Something is off", requiredAction: "  " }];
    expect(validateVerdictRecord(record).ok).toBe(false);
  });

  it("rejects decisiveEvidenceIds that is not an array of identifiers", () => {
    for (const value of ["evidence.exec.1", [1], [null], [{}], 7]) {
      expect(
        validateVerdictRecord(withField("decisiveEvidenceIds", value)).ok,
        JSON.stringify(value),
      ).toBe(false);
    }
  });

  it("rejects two results for the same criterion", () => {
    // Otherwise a contradicted finding can be paired with a supported one and
    // the reader picks whichever they prefer.
    const record = withField("criterionResults", [
      {
        criterionId: "criterion.dup",
        status: "supported",
        summary: "ok",
        evidenceIds: ["evidence.exec.1"],
      },
      {
        criterionId: "criterion.dup",
        status: "supported",
        summary: "also ok",
        evidenceIds: ["evidence.exec.1"],
      },
    ]);
    const result = validateVerdictRecord(record);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toContain("duplicate_criterion");
  });

  it("rejects unknown fields nested inside an array entry", () => {
    const record = withField("criterionResults", [
      {
        criterionId: "criterion.not-found",
        status: "supported",
        summary: "ok",
        evidenceIds: ["evidence.exec.1"],
        overrideStatus: "VERIFIED_PASS",
      },
    ]);
    const result = validateVerdictRecord(record);
    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toContain("unknown_field");
  });

  it("rejects whitespace-only text where content is required", () => {
    for (const field of ["summary", "scope", "policyVersion", "evaluatorVersion"]) {
      expect(validateVerdictRecord(withField(field, "   ")).ok, field).toBe(false);
      expect(validateVerdictRecord(withField(field, "")).ok, field).toBe(false);
    }
  });
});
