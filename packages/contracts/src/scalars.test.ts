import { describe, expect, it } from "vitest";
import { safeLabel } from "./scalars.ts";
import {
  toAgentId, toApprovalId, toArtifactId, toDeviceId, toEvidenceId, toOrganizationId,
  toPolicyId, toReceiptId, toRunId, toUserId, toWorkerId, toWorkspaceId,
} from "./ids.ts";

describe("safeLabel never throws on anything a validator can hold", () => {
  it("survives the null-prototype object that made String() throw", () => {
    // toPlainRecord produces null-prototype objects, so this is not exotic —
    // it is what EVERY validated value looks like. String() and `${}` both
    // throw on it, which crashed a validator while it was building the error
    // message that reports the problem.
    const inert = Object.create(null) as Record<string, unknown>;
    inert.a = 1;
    expect(() => String(inert)).toThrow();
    expect(safeLabel(inert)).toBe("object");
  });

  it("returns a string for every kind of input, without throwing", () => {
    const values: unknown[] = [
      null, undefined, "", "text", 0, -0, NaN, Infinity, 1n, true, false,
      Symbol("s"), () => undefined, [], [1, 2], {}, Object.create(null),
      new Proxy({}, { get() { throw new Error("trap"); } }),
      { toString() { throw new Error("ts"); } },
      { get a() { throw new Error("getter"); } },
    ];
    for (const value of values) {
      let label: string | undefined;
      expect(() => { label = safeLabel(value); }).not.toThrow();
      expect(typeof label).toBe("string");
    }
  });

  it("describes non-primitives by shape, never by content", () => {
    // An error message is a place a value escapes to a log, and SR-3 says
    // secrets must never reach one.
    expect(safeLabel({ apiKey: "AKIAIOSFODNN7EXAMPLE" })).toBe("object");
    expect(safeLabel(["AKIAIOSFODNN7EXAMPLE"])).toBe("array");
    expect(safeLabel({ apiKey: "secret" })).not.toContain("secret");
  });

  it("truncates long strings", () => {
    expect(safeLabel("x".repeat(200)).length).toBeLessThanOrEqual(65);
    // Positive control: short strings pass through intact, or the labels in
    // every error message become useless.
    expect(safeLabel("worker")).toBe("worker");
  });
});

describe("branded id constructors validate before branding", () => {
  it("accepts a well-formed identifier and brands it", () => {
    // Positive control first: a constructor that returned null for everything
    // would satisfy every rejection case below and be useless.
    const id = toEvidenceId("evidence-1");
    expect(id).toBe("evidence-1");
    expect(toRunId("run.2026-08-23")).toBe("run.2026-08-23");
    expect(toWorkspaceId("ws:alpha")).toBe("ws:alpha");
  });

  it("refuses what an unchecked cast would have accepted", () => {
    // These are the whole reason these exist. `"" as EvidenceId` typechecks and
    // names nothing; the cast never looks at the value.
    for (const bad of ["", "   ", "\t", " leading", "trailing ", "has space"]) {
      expect(toEvidenceId(bad), JSON.stringify(bad)).toBe(null);
    }
  });

  it("refuses non-strings without throwing", () => {
    for (const bad of [null, undefined, 7, {}, [], Symbol("x"), new Proxy({}, { get() { throw new Error("t"); } })]) {
      expect(() => toEvidenceId(bad)).not.toThrow();
      expect(toEvidenceId(bad)).toBe(null);
    }
  });

  it("brands every declared id type", () => {
    // If a type is added to ids.ts without a constructor, a consumer is pushed
    // back to an unchecked cast for that one type.
    const constructors = [
      toOrganizationId, toWorkspaceId, toRunId, toWorkerId, toAgentId, toDeviceId,
      toUserId, toApprovalId, toArtifactId, toEvidenceId, toReceiptId, toPolicyId,
    ];
    expect(constructors).toHaveLength(12);
    for (const make of constructors) {
      expect(make("ok-1")).toBe("ok-1");
      expect(make("")).toBe(null);
    }
  });
});
