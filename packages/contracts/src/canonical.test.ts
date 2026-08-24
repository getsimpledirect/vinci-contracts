import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonical.ts";

describe("canonicalize produces a stable identity", () => {
  it("sorts object keys recursively", () => {
    expect(canonicalize({ b: 1, a: { z: 1, y: { q: 1, p: 2 } } })).toBe(
      canonicalize({ a: { y: { p: 2, q: 1 }, z: 1 } , b: 1 }),
    );
  });

  it("is not what toPlainRecord does — that preserves insertion order", () => {
    // The reason this lives here rather than being assumed from the E0
    // boundary. JSON.stringify is the shape toPlainRecord leaves behind.
    expect(JSON.stringify({ b: 1, a: 2 })).not.toBe(JSON.stringify({ a: 2, b: 1 }));
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("preserves array order, because position is meaning", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("omits undefined properties, matching JSON", () => {
    expect(canonicalize({ a: 1, b: undefined })).toBe(canonicalize({ a: 1 }));
  });

  it("throws rather than silently encoding a value it cannot represent", () => {
    // Encoding these would let two records with different content share an
    // identity, which is worse than refusing.
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      expect(() => canonicalize({ a: bad })).toThrow();
    }
    expect(() => canonicalize({ a: () => 1 })).toThrow();
    expect(() => canonicalize({ a: 1n })).toThrow();
  });

  it("distinguishes records that differ anywhere", () => {
    const base = { a: 1, b: { c: [1, 2] } };
    for (const variant of [
      { a: 2, b: { c: [1, 2] } },
      { a: 1, b: { c: [2, 1] } },
      { a: 1, b: { c: [1, 2, 3] } },
      { a: 1, b: { d: [1, 2] } },
    ]) {
      expect(canonicalize(variant)).not.toBe(canonicalize(base));
    }
  });
});

describe("the canonical byte output is pinned, not merely deterministic", () => {
  /**
   * Golden vectors. These exist because a mutation survived the rest of this
   * file: REVERSING the key comparator kept the encoder perfectly
   * deterministic, perfectly stable, and self-consistent, so every
   * property-based test above still passed while the bytes on the wire had
   * changed completely.
   *
   * That mutation is not hypothetical. `canonicalize` is what `receiptDigest`
   * hashes. A comparator that silently flipped would change the digest of every
   * record in existence: previously-issued receipts would fail verification,
   * and an independent implementation written from the documented rule would
   * disagree with this one about what a receipt says — which is the whole thing
   * the canonical encoding was introduced to prevent.
   *
   * Properties cannot catch this. Only bytes can. Each expected string below
   * was checked by hand against the documented rule (keys ascending by UTF-16
   * code unit, arrays order-preserving) rather than copied from the output,
   * which would have pinned whatever the code happened to do.
   */
  const GOLDEN: ReadonlyArray<readonly [string, unknown, string]> = [
    [
      // "10" sorts BEFORE "2": the rule is code unit, not numeric. Uppercase
      // before underscore before lowercase, per ASCII.
      "mixed key order, sorted by code unit and not numerically",
      { b: 1, a: 2, C: 3, _: 4, "10": 5, "2": 6 },
      '{"10":5,"2":6,"C":3,"_":4,"a":2,"b":1}',
    ],
    [
      "arrays preserve order while nested object keys are sorted",
      { z: [3, 1, 2], a: [{ b: 1, a: 2 }] },
      '{"a":[{"a":2,"b":1}],"z":[3,1,2]}',
    ],
    [
      // A (0x41) < à (0xE0) < é (0xE9).
      "non-ASCII keys sort by code unit, and quotes/backslashes escape",
      { "é": 'a"b', A: "\\", "à": 1 },
      '{"A":"\\\\","à":1,"é":"a\\"b"}',
    ],
    [
      "empty object, empty array, null and empty string all survive distinctly",
      { a: {}, b: [], c: null, d: "" },
      '{"a":{},"b":[],"c":null,"d":""}',
    ],
    [
      // -0 normalizes to 0, so a receipt cannot carry two encodings of zero.
      "numeric formatting, including negative zero and exponent form",
      { a: 0, b: -0, c: 1e21, d: 0.1, e: -5 },
      '{"a":0,"b":0,"c":1e+21,"d":0.1,"e":-5}',
    ],
  ];

  for (const [label, input, expected] of GOLDEN) {
    it(`encodes ${label} to exactly the pinned bytes`, () => {
      expect(canonicalize(input)).toBe(expected);
    });
  }

  it("pins the digest-relevant property: reordering input keys changes nothing", () => {
    // The companion to the golden vectors. Together they say the encoding
    // depends on the key SET and not on insertion order, AND that the resulting
    // order is this specific one.
    expect(canonicalize({ a: 1, b: 2 })).toBe(canonicalize({ b: 2, a: 1 }));
    expect(canonicalize({ a: 1, b: 2 })).toBe('{"a":1,"b":2}');
  });
});
