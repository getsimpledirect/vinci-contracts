import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalize } from "./canonical.ts";

/**
 * RFC 8785 (JSON Canonicalization Scheme) conformance, for the value domain
 * these records use: objects, arrays, strings, finite numbers, booleans, null.
 *
 * `canonicalize` was written from its own documented rule, not from the RFC.
 * The rule happens to be the RFC's — keys sorted by UTF-16 code unit, arrays
 * in order, ES `Number::toString` for numbers, `JSON.stringify` escaping for
 * strings, no whitespace — and these vectors, taken from the RFC's own text,
 * pin that agreement rather than assume it. They matter because the Python
 * implementation in packages/work-orders/python is written to the RFC; if the
 * two ever disagreed, every digest would exist in two versions.
 *
 * Deviations are NOT fixed here. Changing canonicalization changes every
 * digest already issued; a deviation is recorded as a `test.skip` with its
 * reason and reported, not silently corrected.
 */

/** A double from its IEEE-754 hex representation, as the RFC's number table gives them. */
function fromHex(hex: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
}

describe("RFC 8785 §3.2.2.3 number serialization (ES Number::toString)", () => {
  // The RFC's table, Section 3.2.2.3: IEEE-754 hex -> expected JSON.
  const TABLE: ReadonlyArray<readonly [string, string]> = [
    ["0000000000000000", "0"],
    ["8000000000000000", "0"], // -0 serializes as 0
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"],
    ["444b1ae4d6e2ef4f", "999999999999999900000"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555553", "333333333.3333332"],
    ["41b3de4355555554", "333333333.33333325"],
    ["41b3de4355555555", "333333333.3333333"],
    ["41b3de4355555556", "333333333.3333334"],
    ["41b3de4355555557", "333333333.33333343"],
    ["becbf647612f3696", "-0.0000033333333333333333"],
    ["43143ff3c1cb0959", "1424953923781206.2"],
  ];
  for (const [hex, expected] of TABLE) {
    it(`encodes ${hex} as ${expected}`, () => {
      expect(canonicalize(fromHex(hex))).toBe(expected);
    });
  }

  it("rejects NaN and Infinity, which JCS cannot represent either", () => {
    expect(() => canonicalize(fromHex("7fffffffffffffff"))).toThrow();
    expect(() => canonicalize(fromHex("7ff0000000000000"))).toThrow();
  });

  it("matches the RFC's prose examples: 1E+30, 0.0000001, 10000000000000000000, -0", () => {
    expect(canonicalize(1e30)).toBe("1e+30");
    expect(canonicalize(0.0000001)).toBe("1e-7");
    expect(canonicalize(10000000000000000000)).toBe("10000000000000000000");
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(56.0)).toBe("56");
  });
});

describe("RFC 8785 §3.2.2.2 string serialization", () => {
  it("escapes only what JSON requires, in lowercase \\u form, and leaves '/' alone", () => {
    // The RFC's example string, written with the RFC's own escapes.
    const input = "\u20ac$\u000f\u000aA'\u0042\u0022\u005c\\\"\/";
    expect(canonicalize(input)).toBe('"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"');
  });

  it("uses the short escapes for the control characters that have them", () => {
    expect(canonicalize("\b\f\n\r\t")).toBe('"\\b\\f\\n\\r\\t"');
    expect(canonicalize("\u0000\u001f")).toBe('"\\u0000\\u001f"');
  });

  it("emits non-ASCII as raw code points, not escapes — including U+007F and U+0080", () => {
    expect(canonicalize("ö€😀")).toBe('"ö€😀"');
    expect(canonicalize("\u007f\u0080")).toBe('"\u007f\u0080"');
  });

  it("escapes a lone surrogate rather than emitting an invalid code point", () => {
    // Well-formed JSON.stringify (ES2019). Python must match this byte for byte.
    expect(canonicalize("\ud800")).toBe('"\\ud800"');
    expect(canonicalize("x\udfffy")).toBe('"x\\udfffy"');
  });
});

describe("RFC 8785 §3.2.3 / Appendix A key sorting by UTF-16 code unit", () => {
  it("orders the RFC's Appendix A keys exactly as the RFC does", () => {
    const input = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    // U+1F600 is D83D DE00 in UTF-16, so it sorts BEFORE U+FB33 — code
    // unit order, not code point order. A Python implementation sorting by
    // code point would put the emoji last and disagree with every JS digest.
    expect(canonicalize(input)).toBe(
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control","ö":"Latin Small Letter O With Diaeresis",'
      + '"€":"Euro Sign","😀":"Emoji: Grinning Face","דּ":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  it("sorts the raw key, not its escaped form", () => {
    // "\n" (0x0A) sorts before "1" (0x31) even though escaped it begins with "\\" (0x5C).
    expect(canonicalize({ "1": 1, "\n": 2 })).toBe('{"\\n":2,"1":1}');
  });
});

describe("RFC 8785 Appendix B full example", () => {
  it("produces the RFC's expected output byte for byte", () => {
    const input = {
      "1": { f: { f: "hi", F: 5 }, "\n": 56.0 },
      "10": {},
      "": "empty",
      a: {},
      "111": [{ e: "yes", E: "no" }],
      A: {},
    };
    expect(canonicalize(input)).toBe(
      '{"":"empty","1":{"\\n":56,"f":{"F":5,"f":"hi"}},"10":{},"111":[{"E":"no","e":"yes"}],"A":{},"a":{}}',
    );
  });

  it("the RFC §3.2.3 sample (numbers, string, literals) canonicalizes to the RFC's bytes", () => {
    const bytes = canonicalize({
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: "\u20ac$\u000f\u000aA'\u0042\u0022\u005c\\\"\/",
      literals: [null, true, false],
    });
    expect(bytes).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],'
      + '"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
    expect(createHash("sha256").update(bytes, "utf8").digest("hex")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("value-domain boundaries relative to JCS", () => {
  it("booleans and null are literal", () => {
    expect(canonicalize([true, false, null])).toBe("[true,false,null]");
  });

  it("undefined-valued properties are omitted — outside JCS's domain, matching JSON.stringify", () => {
    // JCS takes JSON text as input, which has no undefined. The only value in
    // this domain that is not JSON is `undefined`, and it is dropped exactly as
    // JSON.stringify drops it, so the encoded bytes are always a JCS encoding
    // of some JSON value.
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});
