import { describe, expect, it } from "vitest";
import { toPlainRecord } from "./plain-record.ts";

describe("toPlainRecord normalizes the whole record, not its top level", () => {
  // An earlier version snapshotted only own top-level properties and copied
  // nested references unchanged, which left every defect it existed to prevent
  // reachable one level down.

  it("refuses a nested object with a prototype", () => {
    const nested = Object.create({ inherited: "value" }) as Record<string, unknown>;
    nested.own = "x";
    const result = toPlainRecord({ outer: { middle: nested } });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "not_plain_object")).toBe(true);
    expect(result.ok === false && result.issues[0]?.path).toBe("/outer/middle");
  });

  it("refuses a nested accessor, without reading it", () => {
    let reads = 0;
    const input = {
      outer: {
        get sneaky() {
          reads += 1;
          return reads === 1 ? "safe" : "evil";
        },
      },
    };
    const result = toPlainRecord(input);
    expect(result.ok).toBe(false);
    expect(reads).toBe(0);
  });

  it("refuses an accessor inside an array element", () => {
    const input = { items: [{ get x() { return "evil"; } }] };
    expect(toPlainRecord(input).ok).toBe(false);
  });

  it("shares no object with its input, at any depth", () => {
    const deep = { b: { c: { d: [1, { e: "leaf" }] } } };
    const input = { a: deep };
    const result = toPlainRecord(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.a).not.toBe(deep);
    expect(result.value).toEqual(input);

    // Mutating the input afterwards must not change the snapshot. Retaining the
    // caller's nested objects let a validated record change meaning after it
    // had been validated.
    deep.b.c.d[1] = { e: "MUTATED" };
    expect(JSON.stringify(result.value)).not.toContain("MUTATED");
  });

  it("freezes every level", () => {
    const result = toPlainRecord({ a: { b: [1, { c: 2 }] } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const a = result.value.a as Record<string, unknown>;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(a.b)).toBe(true);
    expect(Object.isFrozen((a.b as unknown[])[1])).toBe(true);
  });

  it("refuses a cycle rather than recursing forever", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const result = toPlainRecord(cyclic);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "cyclic_reference")).toBe(true);
  });

  it("allows the same object to appear twice as siblings", () => {
    // Only an ancestor is a cycle. Two references to one object side by side
    // are ordinary data and must not be refused.
    const shared = { v: 1 };
    const result = toPlainRecord({ left: shared, right: shared });
    expect(result.ok).toBe(true);
  });

  it("refuses input nested deeper than the bound", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 40; i += 1) deep = { next: deep };
    const result = toPlainRecord(deep);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "too_deep")).toBe(true);
  });

  it("refuses symbol keys, functions, and non-finite numbers at depth", () => {
    const withSymbol: Record<string | symbol, unknown> = { a: {} };
    (withSymbol.a as Record<symbol, unknown>)[Symbol("s")] = 1;
    expect(toPlainRecord(withSymbol).ok).toBe(false);
    expect(toPlainRecord({ a: { fn: () => 1 } }).ok).toBe(false);
    expect(toPlainRecord({ a: { n: Number.NaN } }).ok).toBe(false);
  });

  it("reports a safe JSON pointer path, escaping / and ~", () => {
    const input: Record<string, unknown> = { "a/b~c": Object.create({ x: 1 }) };
    const result = toPlainRecord(input);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues[0]?.path).toBe("/a~1b~0c");
  });
});
