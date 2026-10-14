import { describe, expect, it } from "vitest";
import { canonicalize, type ValidationResult } from "@getsimpledirect/vinci-contracts";
import {
  bindVeroOccurrenceV1, validateVeroAssistantV1, validateVeroResponsibilityV1,
  validateVeroOccurrenceBindingV1, validateVeroHostBindingAnchorV1,
  veroResponsibilityDigestV1, workOrderDigest,
  type VeroAssistantV1, type VeroContextReferenceV1, type VeroResponsibilityDefinitionV1,
  type VeroResponsibilityV1, type VeroOccurrenceBindingV1, type VeroHostBindingAnchorV1,
  VERO_ASSISTANT_V1_SCHEMA_META, VERO_RESPONSIBILITY_V1_SCHEMA_META,
  VERO_OCCURRENCE_BINDING_V1_SCHEMA_META, VERO_HOST_BINDING_ANCHOR_V1_SCHEMA_META,
} from "./index.ts";
import { reversed, validOrder } from "./fixtures.test-helpers.ts";

function must<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}
const assistant = () => ({ schemaVersion: 1, assistantId: "vero-1", ownerId: "owner-1", displayName: "Vero", revision: 1, pauseEpoch: 0, paused: false });
const responsibility = () => ({
  schemaVersion: 1, responsibilityId: "responsibility-1", ownerId: "owner-1", assistantId: "vero-1",
  revision: 1, pauseEpoch: 0, paused: false, revoked: false, consentedAt: "2026-08-23T12:00:00.000Z",
  definition: {
    goal: "Prepare a daily project summary", instructions: "Use only the selected project notes.",
    contexts: [{ sourceId: "source-1", sourceRevision: 1, ref: "notes:project-1", digest: "a".repeat(64), purpose: "Project status", provenance: { kind: "explicit-selection", selectedBy: "owner-1", selectedAt: "2026-08-23T12:00:00.000Z" }, revokedAt: null as string | null }],
    sourceIds: ["source-1"], permissions: ["read", "draft"],
    schedule: { kind: "daily", timeZone: "America/New_York", minuteOfDay: 540, graceMinutes: 60 },
    quietHours: { kind: "window", startMinute: 1320, endMinute: 480 }, notifyInitial: false,
    expiresAt: "2026-08-24T12:00:00.000Z", maxOccurrences: 10, maxAttempts: 2,
    budget: { maxRuntimeS: 300, maxToolCalls: 10, maxTurns: 5, maxCashCostMicrousd: 10000, maxListCostMicrousd: 20000 },
    totalBudget: { maxCashCostMicrousd: 100000, maxListCostMicrousd: 200000 },
  },
});
function fixture() {
  const a = assistant(), r = responsibility(), w = validOrder();
  const o = {
    schemaVersion: 1, occurrenceId: "occurrence-1", ownerId: "owner-1", assistantId: "vero-1", assistantRevision: 1, assistantPauseEpoch: 0,
    responsibilityId: r.responsibilityId, responsibilityRevision: r.revision, responsibilityPauseEpoch: r.pauseEpoch,
    responsibilityDigest: veroResponsibilityDigestV1(must(validateVeroResponsibilityV1(r))),
    runId: "run-1", workOrderId: w.id, workOrderVersion: w.contractVersion, workOrderDigest: workOrderDigest(w), contextManifestDigest: "b".repeat(64),
  };
  const { ownerId, ...fields } = o;
  const h = { ...fields, authenticatedOwnerId: ownerId, observedAt: "2026-08-23T13:00:00.000Z" };
  return { a, r, w, o, h };
}
const binding = (f = fixture()) => bindVeroOccurrenceV1(f.o, f.a, f.r, f.w, f.h);
function codes(result: ValidationResult<unknown>): readonly string[] {
  return result.ok ? [] : result.issues.map(i => i.code);
}

const contracts = [
  { name: "assistant", make: assistant, validate: validateVeroAssistantV1 },
  { name: "responsibility", make: responsibility, validate: validateVeroResponsibilityV1 },
  { name: "occurrence binding", make: () => fixture().o, validate: validateVeroOccurrenceBindingV1 },
  { name: "host anchor", make: () => fixture().h, validate: validateVeroHostBindingAnchorV1 },
];

describe("closed, explicit Vero v1 records", () => {
  it("exports typed immutable records from the package root", () => {
    const f = fixture();
    const a: VeroAssistantV1 = must(validateVeroAssistantV1(f.a));
    const r: VeroResponsibilityV1 = must(validateVeroResponsibilityV1(f.r));
    const d: VeroResponsibilityDefinitionV1 = r.definition;
    const c: VeroContextReferenceV1 | undefined = d.contexts[0];
    const o: VeroOccurrenceBindingV1 = must(validateVeroOccurrenceBindingV1(f.o));
    const h: VeroHostBindingAnchorV1 = must(validateVeroHostBindingAnchorV1(f.h));
    expect(c?.provenance.selectedBy).toBe(a.ownerId);
    expect(bindVeroOccurrenceV1(o, a, r, f.w, h).ok).toBe(true);
  });
  it("has frozen v1 metadata without changing existing contracts", () => {
    for (const meta of [VERO_ASSISTANT_V1_SCHEMA_META, VERO_RESPONSIBILITY_V1_SCHEMA_META, VERO_OCCURRENCE_BINDING_V1_SCHEMA_META, VERO_HOST_BINDING_ANCHOR_V1_SCHEMA_META]) {
      expect(meta.version).toBe(1);
      expect(meta.compatibility).toBe("frozen");
      expect(meta.unknownFields).toBe("reject");
      expect(meta.malformedData).toBe("fail-closed");
      expect(meta.migration).toContain("explicit host migration");
    }
    expect(validOrder().schemaVersion).toBe(3);
  });
  for (const contract of contracts) {
    it(`${contract.name}: accepts its valid record and returns a frozen snapshot`, () => {
      const input = contract.make();
      const output = must<unknown>(contract.validate(input));
      expect(output).toEqual(input);
      expect(output).not.toBe(input);
      expect(Object.isFrozen(output)).toBe(true);
    });
    it(`${contract.name}: refuses missing/unsupported versions without migration`, () => {
      const { schemaVersion: _version, ...unversioned } = contract.make();
      for (const input of [unversioned, { ...unversioned, schemaVersion: 0 }, { ...unversioned, schemaVersion: 2 }, { ...unversioned, schemaVersion: "1" }]) {
        expect(codes(contract.validate(input))).toContain("unsupported_schema_version");
      }
    });
    it(`${contract.name}: refuses extra top-level data and hostile own keys`, () => {
      expect(codes(contract.validate({ ...contract.make(), model: "placeholder" }))).toContain("unknown_field");
      expect(contract.validate({ ...contract.make(), ...JSON.parse('{"__proto__":{"polluted":true}}') }).ok).toBe(false);
    });
    it(`${contract.name}: fails closed for throwing/revoked proxies and serialization hooks`, () => {
      const revoked = Proxy.revocable(contract.make(), {}); revoked.revoke();
      for (const input of [new Proxy(contract.make(), { get() { throw new Error("hostile"); } }), revoked.proxy, { ...contract.make(), toJSON() { throw new Error("hostile"); } }, null, [], 1]) {
        expect(() => contract.validate(input)).not.toThrow();
        expect(contract.validate(input).ok).toBe(false);
      }
    });
    it(`${contract.name}: snapshots a getter once, neutralizes inherited data`, () => {
      let reads = 0;
      const input = { ...contract.make(), get schemaVersion() { reads += 1; return reads === 1 ? 1 : 2; } };
      const output = must<unknown>(contract.validate(input));
      expect(reads).toBe(1);
      expect(output).toEqual(contract.make());
      expect(contract.validate(Object.create(contract.make())).ok).toBe(false);
    });
  }
  it("persistent assistant identity has no model, provider, account, or training/privacy defaults", () => {
    for (const field of ["model", "modelClass", "provider", "agentProfile", "retention", "training", "e2eeKeys", "history", "accountId"]) {
      expect(codes(validateVeroAssistantV1({ ...assistant(), [field]: "forbidden" }))).toContain("unknown_field");
    }
    expect(validateVeroAssistantV1({ ...assistant(), paused: true, revision: 2, pauseEpoch: 1 }).ok).toBe(true);
  });
});

describe("explicit bounded responsibility and context selection", () => {
  it("accepts minimal no-context selection and explicit all-day/none quiet modes", () => {
    for (const kind of ["none", "all-day"]) {
      const r = responsibility();
      expect(validateVeroResponsibilityV1({ ...r, definition: { ...r.definition, contexts: [], sourceIds: [], permissions: ["read"], quietHours: { kind } } }).ok).toBe(true);
    }
  });
  it("accepts paused/revoked history without making it runnable", () => {
    const f = fixture(); f.r.revoked = true; f.r.paused = true;
    expect(validateVeroResponsibilityV1(f.r).ok).toBe(true);
    expect(codes(binding(f))).toContain("inactive_responsibility");
    expect(validateVeroResponsibilityV1({ ...f.r, paused: false }).ok).toBe(false);
  });
  it("rejects unknown fields at every nested boundary", () => {
    const mutations = [
      (r: ReturnType<typeof responsibility>) => Object.assign(r.definition, { retention: "default" }),
      (r: ReturnType<typeof responsibility>) => Object.assign(r.definition.contexts[0] ?? {}, { content: "history" }),
      (r: ReturnType<typeof responsibility>) => Object.assign(r.definition.contexts[0]?.provenance ?? {}, { inferred: true }),
      (r: ReturnType<typeof responsibility>) => Object.assign(r.definition.schedule, { cron: "* * * * *" }),
      (r: ReturnType<typeof responsibility>) => Object.assign(r.definition.quietHours, { ignore: true }),
      (r: ReturnType<typeof responsibility>) => Object.assign(r.definition.budget, { unlimited: true }),
      (r: ReturnType<typeof responsibility>) => Object.assign(r.definition.totalBudget, { unlimited: true }),
    ];
    for (const mutate of mutations) { const r = responsibility(); mutate(r); expect(codes(validateVeroResponsibilityV1(r))).toContain("unknown_field"); }
  });
  it("rejects unselected, duplicate, cross-owner, missing-purpose and unversioned context", () => {
    const base = responsibility(), c = base.definition.contexts[0];
    if (c === undefined) throw new Error("fixture context missing");
    const variants = [
      { ...c, sourceId: "other-source" }, { ...c, sourceRevision: 0 }, { ...c, purpose: " " }, { ...c, digest: "A".repeat(64) },
      { ...c, provenance: { ...c.provenance, selectedBy: "other-owner" } },
      { ...c, provenance: { ...c.provenance, kind: "inferred" } },
      { ...c, provenance: { ...c.provenance, selectedAt: "2026-08-23T12:00:00.001Z" } },
      { ...c, revokedAt: "2026-08-23T11:59:59.999Z" },
      (({ sourceRevision: _revision, ...rest }) => rest)(c),
      (({ revokedAt: _revocation, ...rest }) => rest)(c),
    ];
    for (const context of variants) expect(validateVeroResponsibilityV1({ ...base, definition: { ...base.definition, contexts: [context] } }).ok).toBe(false);
    expect(validateVeroResponsibilityV1({ ...base, definition: { ...base.definition, contexts: [c, c] } }).ok).toBe(false);
  });
  it("rejects missing bounds, widening permissions, unsafe money, and ambiguous timing", () => {
    const r = responsibility(), d = r.definition;
    const invalidDefinitions = [
      { ...d, permissions: [] }, { ...d, permissions: ["send"] }, { ...d, sourceIds: ["source-1", "source-1"] },
      { ...d, maxOccurrences: 0 }, { ...d, maxAttempts: Number.MAX_SAFE_INTEGER + 1 }, { ...d, expiresAt: r.consentedAt },
      { ...d, contexts: new Array(101).fill(d.contexts[0]) },
      { ...d, schedule: { ...d.schedule, minuteOfDay: 1440 } }, { ...d, schedule: { ...d.schedule, graceMinutes: 0 } },
      { ...d, schedule: { ...d.schedule, timeZone: "+02:00" } },
      { ...d, quietHours: { kind: "window", startMinute: 5, endMinute: 5 } }, { ...d, quietHours: { kind: "none", startMinute: 1 } },
      { ...d, budget: { ...d.budget, maxCashCostMicrousd: -1 } }, { ...d, budget: { ...d.budget, maxListCostMicrousd: 0.1 } },
      { ...d, budget: { ...d.budget, maxRuntimeS: 0 } }, { ...d, totalBudget: { ...d.totalBudget, maxCashCostMicrousd: 9999 } },
      (({ notifyInitial: _notify, ...rest }) => rest)(d),
      (({ contexts: _contexts, ...rest }) => rest)(d),
    ];
    for (const definition of invalidDefinitions) expect(validateVeroResponsibilityV1({ ...r, definition }).ok).toBe(false);
  });
  it("isolates mutable input deeply and hashes the complete validated snapshot", () => {
    const input = responsibility(), accepted = must(validateVeroResponsibilityV1(input));
    const before = veroResponsibilityDigestV1(accepted);
    if (input.definition.contexts[0]) input.definition.contexts[0].provenance.selectedBy = "other";
    input.definition.sourceIds.push("new"); input.definition.budget.maxCashCostMicrousd = 0;
    expect(veroResponsibilityDigestV1(accepted)).toBe(before);
    expect(Object.isFrozen(accepted.definition.contexts[0]?.provenance)).toBe(true);
    expect(veroResponsibilityDigestV1(must(validateVeroResponsibilityV1(reversed(responsibility()))))).toBe(before);
    for (const mutate of [
      (r: ReturnType<typeof responsibility>) => { r.revision += 1; },
      (r: ReturnType<typeof responsibility>) => { r.pauseEpoch += 1; },
      (r: ReturnType<typeof responsibility>) => { if (r.definition.contexts[0]) r.definition.contexts[0].purpose = "Changed purpose"; },
      (r: ReturnType<typeof responsibility>) => { if (r.definition.contexts[0]) r.definition.contexts[0].sourceRevision = 2; },
      (r: ReturnType<typeof responsibility>) => { if (r.definition.contexts[0]) r.definition.contexts[0].revokedAt = r.consentedAt; },
    ]) { const r = responsibility(); mutate(r); expect(veroResponsibilityDigestV1(must(validateVeroResponsibilityV1(r)))).not.toBe(before); }
    expect(() => veroResponsibilityDigestV1({ ...accepted, schemaVersion: 2 } as never)).toThrow("invalid Vero responsibility");
    expect(canonicalize(accepted)).toContain('"revokedAt":null');
  });
});

describe("fully bound occurrence and independent host authority anchor", () => {
  it("accepts a consistent canonical run/work-order binding, not a reserved task", () => {
    expect(binding().ok).toBe(true);
    const f = fixture();
    for (const runId of [null, "", undefined]) expect(validateVeroOccurrenceBindingV1({ ...f.o, runId }).ok).toBe(false);
    expect(validateVeroOccurrenceBindingV1({ ...f.o, taskRunId: "local-task" }).ok).toBe(false);
  });
  it("rejects every identity, digest, revision and fence mismatch against an independent anchor", () => {
    const f = fixture();
    for (const field of Object.keys(f.o).filter(f => f !== "schemaVersion") as (keyof typeof f.o)[]) {
      const value = f.o[field];
      const replacement = typeof value === "number" ? value + 1 : field.endsWith("Digest") ? "f".repeat(64) : `${value}-different`;
      expect(codes(bindVeroOccurrenceV1({ ...f.o, [field]: replacement }, f.a, f.r, f.w, f.h))).toContain("host_anchor_mismatch");
    }
  });
  it("refuses a consistent cross-owner lie in all caller records", () => {
    const f = fixture();
    f.a.ownerId = "attacker"; f.r.ownerId = "attacker";
    const c = f.r.definition.contexts[0]; if (c) c.provenance.selectedBy = "attacker";
    f.w = { ...f.w, owner: { kind: "user", userId: "attacker" } };
    f.o.ownerId = "attacker"; f.o.responsibilityDigest = veroResponsibilityDigestV1(must(validateVeroResponsibilityV1(f.r))); f.o.workOrderDigest = workOrderDigest(f.w);
    expect(validateVeroAssistantV1(f.a).ok).toBe(true); expect(validateVeroResponsibilityV1(f.r).ok).toBe(true);
    expect(codes(binding(f))).toContain("host_anchor_mismatch"); expect(codes(binding(f))).toContain("owner_mismatch");
  });
  it("refuses a consistent proxy lie even if every shape validator accepts", () => {
    const f = fixture();
    const proxy = new Proxy(f.o, { get(target, key, receiver) { return key === "contextManifestDigest" ? "c".repeat(64) : Reflect.get(target, key, receiver); } });
    expect(validateVeroOccurrenceBindingV1(proxy).ok).toBe(true);
    expect(codes(bindVeroOccurrenceV1(proxy, f.a, f.r, f.w, f.h))).toContain("host_anchor_mismatch");
  });
  it("recomputes exact responsibility and work-order digests, never accepts claimed hashes", () => {
    const f = fixture(); f.r.definition.instructions = "Do other work"; f.w = { ...f.w, request: "Do other work" };
    expect(codes(binding(f))).toContain("responsibility_binding_mismatch");
    expect(codes(binding(f))).toContain("work_order_binding_mismatch");
  });
  it("rejects revoked selections, paused assistants and expired or pre-consent records", () => {
    const paused = fixture(); paused.a.paused = true;
    expect(codes(binding(paused))).toContain("inactive_responsibility");
    const revoked = fixture(), c = revoked.r.definition.contexts[0]; if (c) c.revokedAt = revoked.r.consentedAt;
    revoked.o.responsibilityDigest = veroResponsibilityDigestV1(must(validateVeroResponsibilityV1(revoked.r)));
    revoked.h.responsibilityDigest = revoked.o.responsibilityDigest;
    expect(codes(binding(revoked))).toContain("revoked_context");
    for (const observedAt of ["2026-08-23T11:59:59.999Z", "2026-08-24T12:00:00.000Z"]) {
      const f = fixture(); f.h.observedAt = observedAt;
      expect(codes(binding(f))).toContain("outside_validity_window");
    }
  });
  it("validates every input before binding and snapshots a hostile host anchor once", () => {
    const f = fixture(), bomb = new Proxy({}, { get() { throw new Error("no"); } });
    const inputs: unknown[] = [f.o, f.a, f.r, f.w, f.h];
    for (let i = 0; i < inputs.length; i++) {
      const mutated = [...inputs]; mutated[i] = bomb;
      expect(() => bindVeroOccurrenceV1(...mutated as [unknown, unknown, unknown, unknown, unknown])).not.toThrow();
      expect(bindVeroOccurrenceV1(...mutated as [unknown, unknown, unknown, unknown, unknown]).ok).toBe(false);
    }
    let reads = 0;
    const h = { ...f.h, get authenticatedOwnerId() { reads++; return reads === 1 ? f.h.authenticatedOwnerId : "attacker"; } };
    expect(bindVeroOccurrenceV1(f.o, f.a, f.r, f.w, h).ok).toBe(true); expect(reads).toBe(1);
  });
});
