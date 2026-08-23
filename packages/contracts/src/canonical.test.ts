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
