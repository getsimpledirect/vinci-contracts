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
    issuer: {
      organizationId: "organization-1",
      actor: { kind: "verifier", verifierId: "acceptance-verifier-1", independent: true },
    },
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
 * THE ISSUER. A verdict must say WHOSE conclusion it is — and an actor alone
 * does not say that.
 *
 * The shared `Actor` union's system arm is `{ kind: "system", component }`, so
 * a verdict issued by `{ kind: "system", component: "control-plane" }` names a
 * component that two unrelated organizations may each operate. Two verdicts
 * from two different authorities are then byte-identical in their attribution.
 * The same is true of every other arm: `worker-1`, `user-1` and
 * `policy.auto-accept` are names scoped to some organization and none of them
 * carries that scope. So the record carries an `issuer` object holding BOTH
 * facts, and both are required.
 *
 * The two are separately absent, and that is why there are TWO negative
 * controls below rather than one "issuer missing" case. An actor with no
 * organization is a principal nobody can scope; an organization with no actor
 * is an authority with no principal. A single test covering both would pass
 * while one of the halves was unguarded.
 *
 * Every negative case asserts the PATH and CODE it produced, not merely that
 * validation failed. A verdict has fifteen other fields with their own guards,
 * so `.ok === false` is satisfied by any of them: a mutation that broke `scope`
 * as a side effect would satisfy a bare ok-is-false assertion while proving
 * nothing about the issuer at all.
 *
 * The load-bearing assertion is `issuePaths(...)` being EXACTLY the one path
 * under test. That is what establishes the guard was REACHED rather than masked
 * by an earlier one: the base record is otherwise valid and accepted, so a
 * second path appearing would mean the mutation broke something else too and
 * the localisation was a coincidence.
 */
describe("a verdict names the authority that issued it", () => {
  /** Every distinct issue path a record produced. */
  function issuePaths(record: Record<string, unknown>): string[] {
    const result = validateVerdictRecord(record);
    return result.ok ? [] : [...new Set(result.issues.map((i) => i.path))].sort();
  }

  /** The issue codes recorded against one path specifically. */
  function codesAt(record: Record<string, unknown>, path: string): string[] {
    const result = validateVerdictRecord(record);
    return result.ok ? [] : result.issues.filter((i) => i.path === path).map((i) => i.code);
  }

  /** The base record with one top-level field deleted outright. */
  function withoutField(field: string): Record<string, unknown> {
    const record = validRecord();
    delete record[field];
    return record;
  }

  /** The base record with its issuer replaced wholesale. */
  function withIssuer(issuer: unknown): Record<string, unknown> {
    return { ...validRecord(), issuer };
  }

  const ACTOR = { kind: "verifier", verifierId: "acceptance-verifier-1", independent: true };

  // --- negative control 1: an actor with NO ORGANIZATION ------------------
  //
  // This is the case George's defect is about. Before the amendment this record
  // was ACCEPTED, and `{ kind: "system", component: "control-plane" }` from two
  // different organizations produced two indistinguishable verdicts.

  it("refuses an issuer that names an actor but no organization, and for that reason alone", () => {
    // The key is DELETED, not set to undefined. See the earlier-guard test
    // below for why that distinction decides which mechanism answers.
    const record = withIssuer({ actor: ACTOR });
    expect(issuePaths(record)).toEqual(["/issuer/organizationId"]);
    expect(codesAt(record, "/issuer/organizationId")).toEqual(["required_field"]);
  });

  it("refuses an organization identifier that is not an identifier", () => {
    // Not a typeof check: an organization id of spaces satisfies `typeof ===
    // "string"` and `.length > 0` while naming nobody, and a value carrying a
    // space or a slash is not the shape this repository's ids take.
    const malformed: readonly (readonly [string, unknown])[] = [
      ["null", null],
      ["empty", ""],
      ["whitespace", "   "],
      ["number", 7],
      ["boolean", true],
      ["array", []],
      ["object", { id: "organization-1" }],
      ["contains a space", "organization 1"],
      ["contains a slash", "organization/1"],
      ["leading punctuation", "-organization-1"],
      ["over 128 characters", "o".repeat(129)],
    ];
    for (const [label, organizationId] of malformed) {
      const record = withIssuer({ organizationId, actor: ACTOR });
      expect(issuePaths(record), label).toEqual(["/issuer/organizationId"]);
      expect(codesAt(record, "/issuer/organizationId"), label).toEqual(["invalid_id"]);
    }
  });

  // --- negative control 2: an organization with NO ACTOR ------------------
  //
  // The other half, and separable from the first: an authority with no
  // principal has nothing for §8.1's worker-versus-independent distinction to
  // read. A single "issuer missing" test would not have reached this.

  it("refuses an issuer that names an organization but no actor, and for that reason alone", () => {
    const record = withIssuer({ organizationId: "organization-1" });
    expect(issuePaths(record)).toEqual(["/issuer/actor"]);
    expect(codesAt(record, "/issuer/actor")).toEqual(["required_field"]);
  });

  it("refuses an issuing actor that is not an actor-shaped value at all", () => {
    // `null` is listed first because `typeof null === "object"` — the case a
    // hand-rolled object check forgets.
    for (const actor of [null, "acceptance-verifier-1", 7, true, []]) {
      const label = String(JSON.stringify(actor));
      const record = withIssuer({ organizationId: "organization-1", actor });
      expect(issuePaths(record), label).toEqual(["/issuer/actor"]);
      expect(codesAt(record, "/issuer/actor"), label).toEqual(["required_field"]);
    }
  });

  it("refuses an issuing actor whose own arm is malformed", () => {
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
      // Not a spelling check: a foreign field is how an actor smuggles in a
      // claim its own arm does not permit it to make.
      ["system carrying independence", { kind: "system", component: "acceptance", independent: true }],
    ];
    for (const [label, actor] of malformed) {
      const record = withIssuer({ organizationId: "organization-1", actor });
      expect(issuePaths(record), label).toEqual(["/issuer/actor"]);
      expect(codesAt(record, "/issuer/actor"), label).toEqual(["invalid_actor"]);
    }
  });

  // --- both halves missing, and the whole object missing ------------------

  it("reports BOTH halves when an issuer object is present but empty", () => {
    // Not one issue. The two facts are separately absent and separately
    // reported, so a consumer can see which one it has to supply.
    const record = withIssuer({});
    expect(issuePaths(record)).toEqual(["/issuer/actor", "/issuer/organizationId"]);
    expect(codesAt(record, "/issuer/organizationId")).toEqual(["required_field"]);
    expect(codesAt(record, "/issuer/actor")).toEqual(["required_field"]);
  });

  it("refuses a verdict with no issuer at all", () => {
    expect(issuePaths(withoutField("issuer"))).toEqual(["/issuer"]);
    expect(codesAt(withoutField("issuer"), "/issuer")).toEqual(["required_field"]);
  });

  it("refuses an issuer that is not an object at all", () => {
    for (const issuer of [null, "organization-1", 7, true, []]) {
      const label = String(JSON.stringify(issuer));
      const record = withIssuer(issuer);
      expect(issuePaths(record), label).toEqual(["/issuer"]);
      expect(codesAt(record, "/issuer"), label).toEqual(["required_field"]);
    }
  });

  it("refuses an issuer carrying a member it does not declare", () => {
    // Closed, like every other shape in this record. An unknown member is how a
    // second, unvalidated attribution rides alongside the one that was checked.
    const record = withIssuer({
      organizationId: "organization-1",
      actor: ACTOR,
      issuedBy: { kind: "worker", workerId: "w-1" },
    });
    expect(issuePaths(record)).toEqual(["/issuer/issuedBy"]);
    expect(codesAt(record, "/issuer/issuedBy")).toEqual(["unknown_field"]);
  });

  it("refuses the v2-draft spelling `issuedBy` at the top level", () => {
    // The field was called `issuedBy: Actor` in the first cut of v2, before it
    // was found not to answer the question. A record still using that spelling
    // is refused rather than half-read: it carries no organization, so silently
    // accepting it would reintroduce exactly the ambiguity being closed.
    const record = { ...validRecord(), issuedBy: ACTOR };
    expect(issuePaths(record)).toEqual(["/issuedBy"]);
    expect(codesAt(record, "/issuedBy")).toEqual(["unknown_field"]);
  });

  // --- which inputs never reach the guard --------------------------------

  it("refuses an explicitly undefined issuer EARLIER, at the record boundary", () => {
    // Written as its own case because it does NOT reach the issuer guard, and
    // filing it under the cases above would have been a false claim about which
    // mechanism answered.
    //
    // `toPlainRecord` refuses any record carrying an `undefined` value at all,
    // at the root, before a single field is inspected. So the record is
    // rejected — the outcome is right — but by the serialization boundary and
    // not by the issuer check, and the path is "" rather than "/issuer".
    //
    // This is the distinction between an ABSENT key and a key explicitly set to
    // undefined: the absent case is the one that exercises the issuer guard,
    // and it is the shape a real missing issuer takes on a record parsed from
    // JSON.
    const record = withIssuer(undefined);
    expect(issuePaths(record)).toEqual([""]);
    expect(codesAt(record, "")).toEqual(["unsupported_value"]);
  });

  it("refuses undefined issuer HALVES at the record boundary too, not at the guard", () => {
    // The same masking one level down, and it applies to both halves. This is
    // why the two negative controls above delete the key rather than set it to
    // undefined: setting it to undefined would have tested toPlainRecord and
    // been recorded as evidence about a guard it never reached.
    for (const issuer of [
      { organizationId: undefined, actor: ACTOR },
      { organizationId: "organization-1", actor: undefined },
    ]) {
      const record = withIssuer(issuer);
      expect(issuePaths(record)).toEqual([""]);
      expect(codesAt(record, "")).toEqual(["unsupported_value"]);
    }
  });

  // --- the positive control, through the SAME entry point -----------------

  it("accepts every actor kind as an issuing principal, given an organization", () => {
    // Reachability. Without this, a validator that refused EVERY issuer would
    // satisfy all of the negative cases above while making the field unusable:
    // the guard would look pinned and the record would be unconstructible.
    const actors: readonly (readonly [string, unknown])[] = [
      ["independent verifier", { kind: "verifier", verifierId: "v-1", independent: true }],
      // Accepted, and legible AS non-independent. Refusing it would push the
      // fact out of the record rather than disclose it.
      ["non-independent verifier", { kind: "verifier", verifierId: "v-1", independent: false }],
      ["worker", { kind: "worker", workerId: "worker-1" }],
      ["human", { kind: "user", userId: "user-1" }],
      ["human on a device", { kind: "user", userId: "user-1", deviceId: "device-1" }],
      // The arm the whole amendment is about: `control-plane` is only
      // unambiguous once an organization is named beside it.
      ["system", { kind: "system", component: "control-plane" }],
      ["policy", { kind: "policy", policyId: "policy.auto-accept", policyVersion: 3 }],
    ];
    for (const [label, actor] of actors) {
      const result = validateVerdictRecord(withIssuer({ organizationId: "organization-1", actor }));
      expect(result.ok ? [] : result.issues, label).toEqual([]);
      expect(result.ok, label).toBe(true);
    }
  });

  it("accepts the organization identifier shapes this repository already uses", () => {
    for (const organizationId of ["organization-1", "org.acme", "ORG:1", "o", "9", "o".repeat(128)]) {
      const result = validateVerdictRecord(withIssuer({ organizationId, actor: ACTOR }));
      expect(result.ok ? [] : result.issues, organizationId).toEqual([]);
    }
  });

  it("carries the WHOLE issuer through onto the validated record", () => {
    // The fields must SURVIVE validation, not merely be tolerated by it. A
    // validator that accepted the record and dropped the organization would
    // pass every negative case above while leaving the aggregate exactly as
    // unattributable as it was before — the defect reappearing one layer along.
    const issuer = { organizationId: "organization-9", actor: ACTOR };
    const result = validateVerdictRecord(withIssuer(issuer));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.issuer).toEqual(issuer);
    expect(result.value.issuer.organizationId).toBe("organization-9");
    expect(result.value.issuer.actor).toEqual(ACTOR);
  });

  it("carries the organization THE RECORD NAMED, not a constant that happens to match", () => {
    // A discriminating version of the check above. Asserting one expected
    // string would also pass against a validator that stamped every record with
    // that same string. Two records differing ONLY in organizationId must
    // validate to two values that still differ in organizationId.
    const first = validateVerdictRecord(withIssuer({ organizationId: "organization-a", actor: ACTOR }));
    const second = validateVerdictRecord(withIssuer({ organizationId: "organization-b", actor: ACTOR }));
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.issuer.organizationId).toBe("organization-a");
    expect(second.value.issuer.organizationId).toBe("organization-b");
    expect(first.value.issuer.organizationId).not.toBe(second.value.issuer.organizationId);
  });

  // --- the version bump, which is what made the field addable at all ------

  it("refuses a version-1 verdict rather than up-converting it", () => {
    // The migration VERDICT_RECORD_SCHEMA_META states, executed. A v1 record
    // carries no issuer and none may be invented, so it is refused. Both paths
    // are expected: it is simultaneously the wrong version and missing the
    // field, and reporting only one would hide half of why it cannot be read.
    const v1 = withoutField("issuer");
    v1.schemaVersion = 1;
    expect(issuePaths(v1)).toEqual(["/issuer", "/schemaVersion"]);
  });

  it("states a migration, because 'none' is only honest at version 1", () => {
    expect(VERDICT_RECORD_SCHEMA_META.version).toBe(2);
    // NOT relaxed to additive-only to make the new field legal. Frozen means no
    // change within a major version; the version bump is the mechanism.
    expect(VERDICT_RECORD_SCHEMA_META.compatibility).toBe("frozen");
    expect(VERDICT_RECORD_SCHEMA_META.unknownFields).toBe("reject");
    // assertSchemaMetaComplete throws on migration "none" above version 1, so
    // bumping the version forces the migration question to be answered.
    expect(() => assertSchemaMetaComplete(VERDICT_RECORD_SCHEMA_META)).not.toThrow();
    // Both halves named, because a migration mentioning only the actor would
    // understate what a re-issuer has to supply.
    expect(VERDICT_RECORD_SCHEMA_META.migration).toContain("issuer");
    expect(VERDICT_RECORD_SCHEMA_META.migration).toContain("organizationId");
    expect(VERDICT_RECORD_SCHEMA_META.migration).toContain("actor");
  });

  it("records the issuer WITHOUT claiming it is attested", () => {
    // The record states a claim about itself. Nothing here signs it, and the
    // schema must not read as though something did — an over-claim in a doc
    // comment is how a recorded issuer gets cited as a verified one.
    expect(VERDICT_RECORD_SCHEMA_META.migration).not.toMatch(/attest|signed|cryptograph/i);
  });
});
