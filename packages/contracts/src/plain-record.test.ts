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

describe("the normalizer does not reintroduce what it prevents", () => {
  it('refuses a "__proto__" key parsed from JSON', () => {
    // Building the snapshot with `{}` and `out[key] = value` invoked the
    // __proto__ SETTER: the value became the snapshot's prototype rather than
    // an own property, so the snapshot carried inherited attacker data that
    // Object.keys could not see — the exact inherited-field problem this
    // function exists to prevent, reintroduced by the function itself.
    const parsed = JSON.parse('{"a":1,"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.hasOwn(parsed, "__proto__")).toBe(true);

    const result = toPlainRecord(parsed);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "forbidden_key")).toBe(true);
  });

  it("never pollutes the prototype of anything it returns", () => {
    const result = toPlainRecord(JSON.parse('{"a":{"b":1}}'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Null prototype: nothing is inherited, so an own-property check sees
    // everything there is.
    expect(Object.getPrototypeOf(result.value)).toBeNull();
    expect(Object.getPrototypeOf(result.value.a)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("fails closed when reflection itself throws", () => {
    // Reflection on a Proxy runs user code. Letting it escape turns a
    // validation call into a crash, so a caller written for fail-closed
    // results gets an exception instead of a refusal.
    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error("trap escaped validation");
      },
    });
    let result: ReturnType<typeof toPlainRecord> | undefined;
    expect(() => {
      result = toPlainRecord({ nested: hostile });
    }).not.toThrow();
    expect(result?.ok).toBe(false);
    // The thrown message is attacker-authored and must not be echoed back.
    expect(JSON.stringify(result)).not.toContain("trap escaped");
  });

  it.each([
    ["getPrototypeOf", { getPrototypeOf() { throw new Error("x"); } }],
    ["getOwnPropertyDescriptor", { getOwnPropertyDescriptor() { throw new Error("x"); } }],
  ])("fails closed when the %s trap throws", (_label, handler) => {
    const hostile = new Proxy({ a: 1 }, handler as ProxyHandler<object>);
    expect(() => toPlainRecord({ nested: hostile })).not.toThrow();
    expect(toPlainRecord({ nested: hostile }).ok).toBe(false);
  });

  it("refuses an array carrying properties that are not elements", () => {
    // Iterating 0..length-1 dropped these silently. Silent dropping is data
    // loss at best and a smuggling channel at worst.
    const arr: unknown[] & Record<string, unknown> = [1, 2] as never;
    arr.evil = "smuggled";
    const result = toPlainRecord({ items: arr });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "array_extra_property")).toBe(true);
  });

  it("refuses a non-enumerable property on an array", () => {
    const arr = [1, 2];
    Object.defineProperty(arr, "hidden", { value: "smuggled", enumerable: false });
    expect(toPlainRecord({ items: arr }).ok).toBe(false);
  });

  it("still accepts an ordinary array", () => {
    const result = toPlainRecord({ items: [1, "two", { three: true }] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items).toEqual([1, "two", { three: true }]);
  });
});

describe("an array's length is cross-checked, never trusted", () => {
  it("refuses a Proxy that lies about length", () => {
    // `length` was read through normal property access on every loop
    // condition, so a Proxy reporting 0 over three elements normalized
    // [1,2,3] to [] — silently emptying an array inside a record that then
    // validated clean.
    const liar = new Proxy([1, 2, 3], {
      get(t, k, r) {
        return k === "length" ? 0 : Reflect.get(t, k, r);
      },
      getOwnPropertyDescriptor(t, k) {
        return k === "length"
          ? { value: 0, writable: true, enumerable: false, configurable: false }
          : Reflect.getOwnPropertyDescriptor(t, k);
      },
    });
    const result = toPlainRecord({ items: liar });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "array_length_mismatch")).toBe(true);
  });

  it("is unaffected by a length that changes between reads", () => {
    // Reading it twice truncated differently each time. It is now read once,
    // from its descriptor, and only as a cross-check.
    let reads = 0;
    const shifty = new Proxy([1, 2, 3], {
      get(t, k, r) {
        if (k === "length") {
          reads += 1;
          return reads < 2 ? 3 : 0;
        }
        return Reflect.get(t, k, r);
      },
    });
    const result = toPlainRecord({ items: shifty });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items).toEqual([1, 2, 3]);
  });

  it("refuses an out-of-range numeric key", () => {
    // The old regex accepted "4294967295", one past the largest index any
    // array can hold, so the key was treated as an element and then dropped.
    const arr = [1, 2];
    Object.defineProperty(arr, "4294967295", { value: "smuggled", enumerable: true, configurable: true });
    expect(toPlainRecord({ items: arr }).ok).toBe(false);
  });

  it("refuses a sparse array rather than reshaping it", () => {
    // A 5,000,000-length array with one element set has one index key.
    // Normalizing that to a single-element array silently discards what the
    // caller believed it was validating.
    const sparse = new Array(5_000_000);
    sparse[0] = 1;
    const result = toPlainRecord({ items: sparse });
    expect(result.ok).toBe(false);
  });

  it("refuses an oversized record before walking it", () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 10_001; i += 1) wide[`k${i}`] = i;
    const result = toPlainRecord(wide);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "too_many_keys")).toBe(true);
  });

  it("still accepts ordinary and empty arrays", () => {
    const result = toPlainRecord({ items: [1, "two", { three: true }], empty: [] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toEqual([1, "two", { three: true }]);
      expect(result.value.empty).toEqual([]);
    }
  });
});
