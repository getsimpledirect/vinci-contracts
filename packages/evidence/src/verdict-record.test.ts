import { describe, expect, it } from "vitest";
import { assertSchemaMetaComplete } from "@getsimpledirect/vinci-contracts";
import {
  statusIsSupportedBy,
  validateVerdictRecord,
  VERDICT_RECORD_SCHEMA_META,
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
    schemaVersion: 2,
    status: "VERIFIED_PASS",
    issuedBy: { kind: "verifier", verifierId: "acceptance-verifier-1", independent: true },
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

  it("refuses a hostile ARRAY, not just hostile entries", () => {
    // The container, not the contents. A sparse array reports a non-zero
    // length while holding nothing, and Array.prototype.every SKIPS holes — so
    // length>0 plus .every() together still said yes. That is the vacuous pass
    // arriving through a third door after being closed twice.
    const ownEvery: unknown[] = [];
    (ownEvery as { every: () => boolean }).every = () => true;
    (ownEvery as { length: number }).length = 3;

    const hostile: Array<[string, unknown]> = [
      ["new Array(1)", new Array(1)],
      ["new Array(5)", new Array(5)],
      ["a sparse literal", [, ,]],
      ["an array supplying its own every()", ownEvery],
      ["a proxy throwing from length", new Proxy([], { get(t, k) { if (k === "length") throw new Error("len"); return (t as never)[k]; } })],
      ["a proxy throwing from an index", new Proxy([{}], { get(t, k) { if (k === "0") throw new Error("idx"); return (t as never)[k]; } })],
      ["a proxy throwing from gOPD", new Proxy([{}], { getOwnPropertyDescriptor() { throw new Error("gopd"); } })],
      ["a huge claimed length", Object.assign([], { length: 2 ** 32 - 1 })],
      ["a hole among real entries", Object.assign([{ status: "supported" }], { length: 3 })],
    ];
    for (const [label, results] of hostile) {
      expect(() => statusIsSupportedBy("VERIFIED_PASS", results as never), label).not.toThrow();
      expect(statusIsSupportedBy("VERIFIED_PASS", results as never), label).toBe(false);
    }
  });

  it("still accepts a dense array of genuinely supported criteria", () => {
    // Positive control for the traversal. Refusing every array would satisfy
    // every case above.
    expect(statusIsSupportedBy("VERIFIED_PASS", [
      { status: "supported" }, { status: "supported" }, { status: "supported" },
    ] as never)).toBe(true);
    expect(statusIsSupportedBy("VERIFIED_PASS", [
      { status: "supported" }, { status: "contradicted" },
    ] as never)).toBe(false);
  });

  it("captures an accessor once, and still refuses an inherited status", () => {
    // These two used to be treated the same and are not the same.
    //
    // Routing through toPlainRecord means serialization invokes a getter EXACTLY
    // ONCE and stores the result as data, so there is no later read for it to
    // answer differently — and the validator has always accepted the same value.
    // A helper stricter than the validator about the same input is the defect
    // this file exists to prevent, in whichever direction it points.
    expect(statusIsSupportedBy("VERIFIED_PASS", [{ get status() { return "supported"; } }] as never)).toBe(true);
    expect(statusIsSupportedBy("VERIFIED_PASS", [{ get status() { return "unknown"; } }] as never)).toBe(false);

    // An INHERITED status is still refused, and for a reason that survives the
    // change: an object with no own keys serializes to {}, so there is no status
    // at all once the snapshot is taken. A prototype cannot supply a criterion.
    expect(JSON.stringify(Object.create({ status: "supported" }))).toBe("{}");
    expect(statusIsSupportedBy("VERIFIED_PASS", [Object.create({ status: "supported" })] as never)).toBe(false);
  });

  it("refuses a Proxy that fabricates criteria its target does not hold", () => {
    // Found by review. A Proxy over an EMPTY array reporting length 1 and a
    // fabricated descriptor at index 0 was granted VERIFIED_PASS — a pass over
    // zero actual criteria, while the same value serialized to []. The stored
    // record and the predicate described different things.
    const target: unknown[] = [];
    const fabricating = new Proxy(target, {
      get(t, prop, receiver) {
        return prop === "length" ? 1 : Reflect.get(t, prop, receiver);
      },
      getOwnPropertyDescriptor(t, prop) {
        if (prop === "0") {
          return { value: { status: "supported" }, writable: true, enumerable: true, configurable: true };
        }
        if (prop === "length") {
          return { value: 1, writable: true, enumerable: false, configurable: false };
        }
        return Reflect.getOwnPropertyDescriptor(t, prop);
      },
    });
    expect(statusIsSupportedBy("VERIFIED_PASS", fabricating as never)).toBe(false);
    expect(target).toEqual([]);
  });

  it("refuses a revoked Proxy instead of throwing", () => {
    // Array.isArray itself throws on a revoked proxy, out of a function
    // documented never to throw.
    const revocable = Proxy.revocable([], {});
    revocable.revoke();
    expect(() => statusIsSupportedBy("VERIFIED_PASS", revocable.proxy as never)).not.toThrow();
    expect(statusIsSupportedBy("VERIFIED_PASS", revocable.proxy as never)).toBe(false);
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

/**
 * THE ISSUER. A verdict must say whose conclusion it is.
 *
 * Every negative case below asserts the PATH and CODE it produced, not merely
 * that validation failed. A verdict has fifteen other fields with their own
 * guards, so `.ok === false` is satisfied by any of them: a mutation that broke
 * `scope` as a side effect would satisfy a bare ok-is-false assertion while
 * proving nothing about the issuer at all.
 *
 * The load-bearing assertion is `issuePaths(...)` being EXACTLY `["/issuedBy"]`.
 * That is what establishes the guard was REACHED rather than masked by an
 * earlier one: the base record is otherwise valid and accepted, so a second
 * path appearing would mean the mutation broke something else too and the
 * localisation was a coincidence.
 */
describe("a verdict names who issued it", () => {
  /** Every distinct issue path a record produced. */
  function issuePaths(record: Record<string, unknown>): string[] {
    const result = validateVerdictRecord(record);
    return result.ok ? [] : [...new Set(result.issues.map((i) => i.path))].sort();
  }

  /** The issue codes recorded against /issuedBy specifically. */
  function issuedByCodes(record: Record<string, unknown>): string[] {
    const result = validateVerdictRecord(record);
    return result.ok ? [] : result.issues.filter((i) => i.path === "/issuedBy").map((i) => i.code);
  }

  /** The base record with one field deleted outright, not set to undefined. */
  function withoutField(field: string): Record<string, unknown> {
    const record = validRecord();
    delete record[field];
    return record;
  }

  // --- the negative control, and proof of WHY it is red -------------------

  it("refuses a verdict with no issuer at all, and for that reason alone", () => {
    expect(issuePaths(withoutField("issuedBy"))).toEqual(["/issuedBy"]);
    expect(issuedByCodes(withoutField("issuedBy"))).toEqual(["required_field"]);
  });

  it("refuses an issuer that is not an actor-shaped value at all", () => {
    // `null` is listed first because `typeof null === "object"` — the case a
    // hand-rolled object check forgets. `undefined` is deliberately NOT in this
    // list; see the test below for where it actually lands.
    for (const issuedBy of [null, "acceptance-verifier-1", 7, true, []]) {
      const label = String(JSON.stringify(issuedBy));
      const record = { ...validRecord(), issuedBy };
      expect(issuePaths(record), label).toEqual(["/issuedBy"]);
      expect(issuedByCodes(record), label).toEqual(["required_field"]);
    }
  });

  it("refuses an explicitly undefined issuer EARLIER, at the record boundary", () => {
    // Written as its own case because it does NOT reach the issuer guard, and
    // filing it under the case above would have been a false claim about which
    // mechanism answered.
    //
    // `toPlainRecord` refuses any record carrying an `undefined` value at all,
    // at the root, before a single field is inspected. So the record is
    // rejected — the outcome is right — but by the serialization boundary and
    // not by the issuer check, and the path is "" rather than "/issuedBy".
    //
    // This is the distinction between an ABSENT key and a key explicitly set to
    // undefined: the absent case (the test above this block) is the one that
    // exercises the issuer guard, and it is the shape a real missing issuer
    // takes on a record that was parsed from JSON.
    const record = { ...validRecord(), issuedBy: undefined };
    expect(issuePaths(record)).toEqual([""]);
    const result = validateVerdictRecord(record);
    expect(result.ok ? [] : result.issues.map((i) => i.code)).toEqual(["unsupported_value"]);
  });

  it("refuses an actor whose own arm is malformed", () => {
    const malformed: readonly (readonly [string, unknown])[] = [
      ["unknown kind", { kind: "auditor", auditorId: "a-1" }],
      ["no kind", { verifierId: "v-1", independent: true }],
      ["verifier with no id", { kind: "verifier", independent: true }],
      // FR-7.3: a verifier that will not say whether it was independent has not
      // disclosed non-independence, it has omitted the question.
      ["verifier with no independence flag", { kind: "verifier", verifierId: "v-1" }],
      // Truthy but not boolean. "yes" is not a disclosure of anything.
      ["independent: 'yes'", { kind: "verifier", verifierId: "v-1", independent: "yes" }],
      // A worker asserting its own independence — the one thing the evidence
      // layer must never accept. `independent` is foreign to the worker arm.
      ["worker claiming independence", { kind: "worker", workerId: "w-1", independent: true }],
      ["blank identifier", { kind: "verifier", verifierId: "   ", independent: true }],
      ["worker with no id", { kind: "worker" }],
    ];
    for (const [label, issuedBy] of malformed) {
      const record = { ...validRecord(), issuedBy };
      expect(issuePaths(record), label).toEqual(["/issuedBy"]);
      expect(issuedByCodes(record), label).toEqual(["invalid_actor"]);
    }
  });

  it("refuses an issuer carrying a field foreign to its own kind", () => {
    // Not a spelling check: a foreign field is how an actor smuggles in a claim
    // its own arm does not permit it to make.
    const record = {
      ...validRecord(),
      issuedBy: { kind: "system", component: "acceptance", independent: true },
    };
    expect(issuePaths(record)).toEqual(["/issuedBy"]);
    expect(issuedByCodes(record)).toEqual(["invalid_actor"]);
  });

  // --- the positive control, through the SAME entry point -----------------

  it("accepts every actor kind as an issuer", () => {
    // Reachability. Without this, a validator that refused EVERY issuer would
    // satisfy all of the negative cases above while making the field unusable:
    // the guard would look pinned and the record would be unconstructible.
    const issuers: readonly (readonly [string, unknown])[] = [
      ["independent verifier", { kind: "verifier", verifierId: "v-1", independent: true }],
      // Accepted, and legible AS non-independent. Refusing it would push the
      // fact out of the record rather than disclose it.
      ["non-independent verifier", { kind: "verifier", verifierId: "v-1", independent: false }],
      ["worker", { kind: "worker", workerId: "worker-1" }],
      ["human", { kind: "user", userId: "user-1" }],
      ["human on a device", { kind: "user", userId: "user-1", deviceId: "device-1" }],
      ["system", { kind: "system", component: "acceptance-runner" }],
      ["policy", { kind: "policy", policyId: "policy.auto-accept", policyVersion: 3 }],
    ];
    for (const [label, issuedBy] of issuers) {
      const result = validateVerdictRecord({ ...validRecord(), issuedBy });
      expect(result.ok ? [] : result.issues, label).toEqual([]);
      expect(result.ok, label).toBe(true);
    }
  });

  it("carries the issuer through onto the validated record", () => {
    // The field must SURVIVE validation, not merely be tolerated by it. A
    // validator that accepted the record and dropped the issuer would pass
    // every case above while leaving the aggregate unattributed — this defect
    // reappearing one layer further along.
    const issuedBy = { kind: "verifier", verifierId: "acceptance-verifier-1", independent: true };
    const result = validateVerdictRecord({ ...validRecord(), issuedBy });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.issuedBy).toEqual(issuedBy);
  });

  // --- the version bump, which is what made the field addable at all ------

  it("refuses a version-1 verdict rather than up-converting it", () => {
    // The migration VERDICT_RECORD_SCHEMA_META states, executed. A v1 record
    // carries no issuer and none may be invented, so it is refused. Both paths
    // are expected: it is simultaneously the wrong version and missing the
    // field, and reporting only one would hide half of why it cannot be read.
    const v1 = withoutField("issuedBy");
    v1.schemaVersion = 1;
    expect(issuePaths(v1)).toEqual(["/issuedBy", "/schemaVersion"]);
  });

  it("states a migration, because 'none' is only honest at version 1", () => {
    expect(VERDICT_RECORD_SCHEMA_META.version).toBe(2);
    expect(VERDICT_RECORD_SCHEMA_META.compatibility).toBe("frozen");
    // assertSchemaMetaComplete throws on migration "none" above version 1, so
    // bumping the version forces the migration question to be answered.
    expect(() => assertSchemaMetaComplete(VERDICT_RECORD_SCHEMA_META)).not.toThrow();
    expect(VERDICT_RECORD_SCHEMA_META.migration).toContain("issuedBy");
  });
});
