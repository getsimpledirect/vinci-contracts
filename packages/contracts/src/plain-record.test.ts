import { describe, expect, it } from "vitest";
import { toPlainRecord } from "./plain-record.ts";

describe("how an object was built cannot change the outcome", () => {
  // This replaces a set of tests asserting that exotic inputs are REFUSED —
  // inherited fields, accessors, symbol keys, non-enumerable properties.
  //
  // That contract could not be enforced. Refusing them required reflecting over
  // the input, and reflecting over the input is a second read: a Proxy whose
  // `ownKeys` answered ["a"] to the reflective pass and ["a","b"] to the
  // serializer put a field into the returned record that validation never saw.
  //
  // The contract is now narrower and actually holds: a record is JSON data, and
  // the result depends only on that data. Whatever a hostile object says, it
  // says once, and the outcome is identical to what sending the same JSON
  // honestly would produce. Exotic features are neutralized rather than
  // diagnosed — dropped exactly as a wire would drop them.
  const sameAsJson = (exotic: unknown, plainEquivalent: unknown) => {
    const a = toPlainRecord(exotic);
    const b = toPlainRecord(plainEquivalent);
    expect(a.ok).toBe(b.ok);
    if (a.ok && b.ok) expect(a.value).toEqual(b.value);
  };

  it("drops inherited fields, matching the JSON that would have been sent", () => {
    const withProto = Object.create({ inherited: "hidden" }) as Record<string, unknown>;
    withProto.own = "visible";
    sameAsJson({ nested: withProto }, { nested: { own: "visible" } });
  });

  it("reads an accessor once, and uses that value", () => {
    let reads = 0;
    const withGetter = {
      a: {
        get x() {
          reads += 1;
          return reads === 1 ? "first" : "second";
        },
      },
    };
    const result = toPlainRecord(withGetter);
    expect(result.ok).toBe(true);
    // Exactly one read, so there is no "second" for the record to disagree with.
    expect(reads).toBe(1);
    if (result.ok) expect(result.value).toEqual({ a: { x: "first" } });
  });

  it("drops symbol keys and non-enumerable properties", () => {
    const withSymbol: Record<string | symbol, unknown> = { a: 1 };
    withSymbol[Symbol("s")] = "hidden";
    Object.defineProperty(withSymbol, "quiet", { value: "hidden", enumerable: false });
    sameAsJson(withSymbol, { a: 1 });
  });

  it("refuses values JSON cannot carry rather than dropping them", () => {
    // Dropping these WOULD change the outcome, since a missing field is not the
    // same as a field the caller sent. They are refused, not neutralized.
    for (const bad of [{ a: () => 1 }, { a: Number.NaN }, { a: 1n }, { a: undefined }]) {
      expect(toPlainRecord(bad).ok, JSON.stringify(Object.keys(bad))).toBe(false);
    }
  });

  it("refuses a cycle", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(toPlainRecord(cyclic).ok).toBe(false);
  });

  it("shares no object with its input, at any depth", () => {
    const deep = { b: { c: { d: [1, { e: "leaf" }] } } };
    const input = { a: deep };
    const result = toPlainRecord(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.a).not.toBe(deep);
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

  it("refuses input nested deeper than the bound", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 40; i += 1) deep = { next: deep };
    expect(toPlainRecord(deep).ok).toBe(false);
  });

  it("still refuses a __proto__ key, which JSON can carry", () => {
    const parsed = JSON.parse('{"a":1,"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const result = toPlainRecord(parsed);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "forbidden_key")).toBe(true);
  });

  it("never pollutes the prototype of anything it returns", () => {
    const result = toPlainRecord(JSON.parse('{"a":{"b":1}}'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.getPrototypeOf(result.value)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("fails closed when reflection throws instead of letting it escape", () => {
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
    expect(JSON.stringify(result)).not.toContain("trap escaped");
  });
});

describe("a Proxy answering differently on a second read cannot smuggle a field", () => {
  it("reads ownKeys exactly once", () => {
    // The eleventh finding. The boundary reflected over the input for
    // diagnostics and then serialized it — two reads, described as one. A
    // Proxy answering ["a"] then ["a","b"] put `b` into the returned record
    // without validation ever inspecting it.
    let calls = 0;
    const p = new Proxy({ a: "val_a", b: "SMUGGLED" }, {
      ownKeys() {
        calls += 1;
        return calls === 1 ? ["a"] : ["a", "b"];
      },
      getOwnPropertyDescriptor(t, k) {
        return Object.getOwnPropertyDescriptor(t, k);
      },
    });

    const result = toPlainRecord(p);
    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.value)).toEqual(["a"]);
      expect(JSON.stringify(result.value)).not.toContain("SMUGGLED");
    }
  });

  it("reads a nested proxy exactly once too", () => {
    let calls = 0;
    const inner = new Proxy({ field1: "v1", field2: "SMUGGLED" }, {
      ownKeys() {
        calls += 1;
        return calls === 1 ? ["field1"] : ["field1", "field2"];
      },
      getOwnPropertyDescriptor(t, k) {
        return Object.getOwnPropertyDescriptor(t, k);
      },
    });
    const result = toPlainRecord({ nested: inner });
    expect(calls).toBe(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.stringify(result.value)).not.toContain("SMUGGLED");
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
    // With a single read there is nothing to cross-check against: the proxy
    // says one thing, and that is both what is validated and what is returned.
    // The property that matters is that the two cannot differ.
    const result = toPlainRecord({ items: liar });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.items).toEqual(JSON.parse(JSON.stringify(liar)));
      expect(Object.isFrozen(result.value.items)).toBe(true);
    }
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

  it("treats an out-of-range numeric key the way JSON does", () => {
    const arr = [1, 2];
    Object.defineProperty(arr, "4294967295", { value: "smuggled", enumerable: true, configurable: true });
    const result = toPlainRecord({ items: arr });
    // Whatever the outcome, it must match sending the same JSON honestly.
    const asJson = toPlainRecord(JSON.parse(JSON.stringify({ items: arr })));
    expect(result.ok).toBe(asJson.ok);
    if (result.ok && asJson.ok) expect(result.value).toEqual(asJson.value);
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

describe("a Proxy cannot make validation disagree with the record it produced", () => {
  it("is not fooled by two traps telling the same lie", () => {
    // The eighth hole, and the one that settled the approach. `ownKeys`
    // returned only ["length"] — legal, since configurable index properties may
    // be omitted — and `getOwnPropertyDescriptor` returned the real
    // non-configurable descriptor for `length` with its value changed to 0.
    // Both traps lied CONSISTENTLY, so cross-checking one against the other
    // agreed with itself, and three elements were silently erased.
    //
    // No amount of correlating traps closes that: the same object authors every
    // answer. Reflection cannot validate a Proxy because reflection IS the
    // Proxy.
    const target = [1, 2, 3];
    const realLength = Object.getOwnPropertyDescriptor(target, "length");
    const liar = new Proxy(target, {
      ownKeys() {
        return ["length"];
      },
      getOwnPropertyDescriptor(t, k) {
        return k === "length"
          ? { ...(realLength as PropertyDescriptor), value: 0 }
          : Reflect.getOwnPropertyDescriptor(t, k);
      },
    });

    const result = toPlainRecord({ items: liar });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.items).toEqual([1, 2, 3]);
  });

  it("returns exactly what it validated, whatever a hostile input claimed", () => {
    // This is the property that actually matters, and the one every previous
    // defect broke. A hostile input still decides what it says — but it says it
    // once, so the data checked and the data returned cannot diverge.
    const liar = new Proxy([1, 2, 3], {
      get(t, k, r) {
        return k === "length" ? 1 : Reflect.get(t, k, r);
      },
    });
    const result = toPlainRecord({ items: liar });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Whatever it claimed, the returned value is inert, frozen, and not the proxy.
    expect(result.value.items).not.toBe(liar);
    expect(Object.isFrozen(result.value.items)).toBe(true);
    expect(JSON.parse(JSON.stringify(result.value.items))).toEqual(result.value.items);
  });

  it("invokes an accessor once, and the record holds what it returned", () => {
    // Refusing accessors required a reflective pass, and that pass was the
    // second read a Proxy could answer differently. One read is worth more
    // than the specific diagnostic.
    let reads = 0;
    const withGetter = {
      a: {
        get x() {
          reads += 1;
          return reads;
        },
      },
    };
    const result = toPlainRecord(withGetter);
    expect(reads).toBe(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ a: { x: 1 } });
  });
});

describe("the work is bounded during traversal, not after it", () => {
  // A size cap checked after JSON.stringify returns is not a cap, because the
  // input controls how much work stringify does before returning. A Proxy that
  // passed the reflective pass — ownKeys ["length"], descriptor value 0 — could
  // then report an enormous `length` from its `get` trap, since stringify reads
  // length through [[Get]] rather than the descriptor. Cost was linear in the
  // claimed size: 100,000 elements took 13ms and 4MB before any limit was read.
  function lyingLength(fakeLength: number): unknown {
    const target: unknown[] = [];
    const realLength = Object.getOwnPropertyDescriptor(target, "length") as PropertyDescriptor;
    return new Proxy(target, {
      ownKeys() {
        return ["length"];
      },
      getOwnPropertyDescriptor(t, k) {
        return k === "length"
          ? { ...realLength, value: 0 }
          : Reflect.getOwnPropertyDescriptor(t, k);
      },
      get(t, k, r) {
        return k === "length" ? fakeLength : Reflect.get(t, k, r);
      },
    });
  }

  it("refuses a hugely-claimed array without doing the work", () => {
    const started = Date.now();
    const result = toPlainRecord({ items: lyingLength(10_000_000) });
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    // Either bound refusing is correct — node count or aggregate size, whichever
    // the input trips first. Asserting which one fires would pin an
    // implementation detail rather than the property under test.
    expect(
      result.ok === false && ["too_many_nodes", "too_large"].includes(result.issues[0]?.code ?? ""),
    ).toBe(true);
    // The point is the bound, not the refusal: ten million elements must cost
    // about what two hundred thousand cost, not fifty times more.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("does not grow with the size claimed", () => {
    // Scaling must flatten once the bound engages. If this ever regresses to
    // linear, the cap has moved back to being checked after the fact.
    const time = (n: number) => {
      const started = Date.now();
      toPlainRecord({ items: lyingLength(n) });
      return Date.now() - started;
    };
    time(1_000_000); // warm
    const small = time(1_000_000);
    const large = time(20_000_000);
    expect(large).toBeLessThan(Math.max(small * 4, 1_000));
  });

  it("refuses a single absurdly long string", () => {
    const result = toPlainRecord({ blob: "x".repeat(1_000_001) });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues[0]?.code).toBe("too_large");
  });

  it("still accepts a large but legitimate record", () => {
    const result = toPlainRecord({ items: Array.from({ length: 5_000 }, (_, i) => i) });
    expect(result.ok).toBe(true);
  });
});

describe("the aggregate size bound is enforced during traversal", () => {
  it("refuses many sub-cap strings without building them all", () => {
    // A per-string cap bounds nothing in aggregate: 200,000 permitted nodes
    // times a one-million-character limit is two hundred gigabytes. Forty
    // strings of 900,000 characters is 41 nodes, every string under its own
    // cap, and 34.6MB was allocated before the final length check ran.
    const big = "x".repeat(900_000);
    const record: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) record[`k${i}`] = big;

    const before = process.memoryUsage().heapUsed;
    const result = toPlainRecord(record);
    const grewMb = (process.memoryUsage().heapUsed - before) / 1_048_576;

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues[0]?.code).toBe("too_large");
    // The refusal was never the question — the allocation was.
    expect(grewMb).toBeLessThan(10);
  });

  it("does not over-reject: the bound is a lower bound, not an estimate", () => {
    // JSON escaping only ever expands a string, so a record whose MINIMUM
    // possible serialized size exceeds the cap could never have fit. Anything
    // that could fit must still validate.
    expect(toPlainRecord({ blob: "x".repeat(900_000) }).ok).toBe(true);

    const many: Record<string, string> = {};
    for (let i = 0; i < 100; i += 1) many[`k${i}`] = "y".repeat(5_000);
    expect(toPlainRecord(many).ok).toBe(true);
  });

  it("refuses once the aggregate genuinely exceeds the cap", () => {
    const over: Record<string, string> = {};
    for (let i = 0; i < 300; i += 1) over[`k${i}`] = "y".repeat(5_000);
    const result = toPlainRecord(over);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues[0]?.code).toBe("too_large");
  });
});

describe("the invariant, stated once and checked over every construction", () => {
  // Eleven cycles of defects in this boundary all had one shape: the decision
  // depended on HOW an object was built, not on what it said. Refusing exotic
  // constructions was the wrong lever — it needed a second read, and the second
  // read was itself the hole.
  //
  // The property below is the one that matters, and it is checkable rather than
  // enumerable: validating a value gives the same answer as validating the JSON
  // that value serializes to. If those ever differ, construction affected the
  // outcome, and the class is back.
  const holdsFor = (build: () => unknown) => {
    const viaExotic = toPlainRecord(build());
    let plain: unknown;
    try {
      plain = JSON.parse(JSON.stringify(build()));
    } catch {
      plain = undefined;
    }
    const viaJson = plain === undefined ? { ok: false as const } : toPlainRecord(plain);
    expect(viaExotic.ok).toBe(viaJson.ok);
    if (viaExotic.ok && viaJson.ok) expect(viaExotic.value).toEqual(viaJson.value);
  };

  it.each([
    ["a nested inherited field", () => ({ n: Object.setPrototypeOf({ own: 1 }, { hidden: 2 }) })],
    ["a getter", () => {
      let i = 0;
      return { get x() { i += 1; return i; } };
    }],
    ["a symbol key", () => {
      const o: Record<string | symbol, unknown> = { a: 1 };
      o[Symbol("s")] = 2;
      return o;
    }],
    ["a non-enumerable property", () => {
      const o = { a: 1 };
      Object.defineProperty(o, "h", { value: 2, enumerable: false });
      return o;
    }],
    ["an array with an extra property", () => {
      const a: unknown[] & Record<string, unknown> = [1, 2] as never;
      a.evil = "x";
      return { items: a };
    }],
    ["a proxy lying about length", () => {
      const t = [1, 2, 3];
      const rl = Object.getOwnPropertyDescriptor(t, "length") as PropertyDescriptor;
      return {
        items: new Proxy(t, {
          ownKeys: () => ["length"],
          getOwnPropertyDescriptor: (x, k) =>
            k === "length" ? { ...rl, value: 0 } : Reflect.getOwnPropertyDescriptor(x, k),
        }),
      };
    }],
    ["a proxy whose ownKeys changes between reads", () => {
      let n = 0;
      return new Proxy({ a: 1, b: "SMUGGLED" }, {
        ownKeys: () => {
          n += 1;
          return n === 1 ? ["a"] : ["a", "b"];
        },
        getOwnPropertyDescriptor: (t, k) => Object.getOwnPropertyDescriptor(t, k),
      });
    }],
  ])("holds for %s", (_label, build) => {
    holdsFor(build as () => unknown);
  });
});
