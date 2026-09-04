import {
  fail,
  ok,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";

class StrictJsonError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Kept aligned with the repository's inert-snapshot boundary. */
export const MAX_SIGNED_JSON_BYTES = 1_000_000;
export const MAX_SIGNED_JSON_DEPTH = 32;
export const MAX_SIGNED_JSON_NODES = 200_000;
export const MAX_SIGNED_JSON_MEMBERS = 10_000;
export const MAX_SIGNED_JSON_STRING_BYTES = 262_144;

/**
 * A deliberately small JSON parser for signed wire inputs.
 *
 * JSON.parse cannot report duplicate object names: it silently keeps the last
 * value. That is unsafe at a signature boundary because another decoder may
 * keep the first value. This parser rejects duplicates after escape decoding,
 * rejects lone surrogates, and accepts only safe JSON integers. The review
 * attribution schema has no floating-point fields, so accepting exponent or
 * fractional spellings would only introduce canonicalization hazards.
 */
class StrictJsonParser {
  private offset = 0;
  private nodes = 0;

  constructor(private readonly source: string) {}

  parse(): unknown {
    this.space();
    const value = this.value(0);
    this.space();
    if (this.offset !== this.source.length) {
      throw new StrictJsonError("invalid_json", "unexpected data after the JSON value");
    }
    return value;
  }

  private value(depth: number): unknown {
    if (depth > MAX_SIGNED_JSON_DEPTH) {
      throw new StrictJsonError("too_deep", `signed JSON must not nest deeper than ${MAX_SIGNED_JSON_DEPTH} levels`);
    }
    this.nodes += 1;
    if (this.nodes > MAX_SIGNED_JSON_NODES) {
      throw new StrictJsonError("too_many_nodes", `signed JSON must not contain more than ${MAX_SIGNED_JSON_NODES} values`);
    }
    const token = this.source[this.offset];
    if (token === "{") return this.object(depth);
    if (token === "[") return this.array(depth);
    if (token === '"') return this.string();
    if (token === "t") return this.literal("true", true);
    if (token === "f") return this.literal("false", false);
    if (token === "n") return this.literal("null", null);
    if (token === "-" || (token !== undefined && token >= "0" && token <= "9")) {
      return this.integer();
    }
    throw new StrictJsonError("invalid_json", "expected a JSON value");
  }

  private object(depth: number): Readonly<Record<string, unknown>> {
    this.offset += 1;
    this.space();
    const result: Record<string, unknown> = Object.create(null);
    const names = new Set<string>();
    if (this.source[this.offset] === "}") {
      this.offset += 1;
      return Object.freeze(result);
    }
    while (true) {
      if (this.source[this.offset] !== '"') {
        throw new StrictJsonError("invalid_json", "an object member name must be a JSON string");
      }
      const name = this.string();
      if (names.has(name)) {
        throw new StrictJsonError("duplicate_field", "duplicate object member names are forbidden");
      }
      names.add(name);
      if (names.size > MAX_SIGNED_JSON_MEMBERS) {
        throw new StrictJsonError("too_many_keys", `a signed JSON object must not contain more than ${MAX_SIGNED_JSON_MEMBERS} members`);
      }
      this.space();
      if (this.source[this.offset] !== ":") {
        throw new StrictJsonError("invalid_json", "expected ':' after an object member name");
      }
      this.offset += 1;
      this.space();
      Object.defineProperty(result, name, {
        value: this.value(depth + 1),
        enumerable: true,
        configurable: false,
        writable: false,
      });
      this.space();
      const delimiter = this.source[this.offset];
      if (delimiter === "}") {
        this.offset += 1;
        return Object.freeze(result);
      }
      if (delimiter !== ",") {
        throw new StrictJsonError("invalid_json", "expected ',' or '}' in an object");
      }
      this.offset += 1;
      this.space();
    }
  }

  private array(depth: number): readonly unknown[] {
    this.offset += 1;
    this.space();
    const result: unknown[] = [];
    if (this.source[this.offset] === "]") {
      this.offset += 1;
      return Object.freeze(result);
    }
    while (true) {
      if (result.length >= MAX_SIGNED_JSON_MEMBERS) {
        throw new StrictJsonError("too_many_keys", `a signed JSON array must not contain more than ${MAX_SIGNED_JSON_MEMBERS} members`);
      }
      result.push(this.value(depth + 1));
      this.space();
      const delimiter = this.source[this.offset];
      if (delimiter === "]") {
        this.offset += 1;
        return Object.freeze(result);
      }
      if (delimiter !== ",") {
        throw new StrictJsonError("invalid_json", "expected ',' or ']' in an array");
      }
      this.offset += 1;
      this.space();
    }
  }

  private string(): string {
    this.offset += 1;
    let result = "";
    while (this.offset < this.source.length) {
      const char = this.source[this.offset];
      if (char === '"') {
        this.offset += 1;
        if (new TextEncoder().encode(result).byteLength > MAX_SIGNED_JSON_STRING_BYTES) {
          throw new StrictJsonError("too_large", `a signed JSON string must not exceed ${MAX_SIGNED_JSON_STRING_BYTES} UTF-8 bytes`);
        }
        return result;
      }
      if (char === "\\") {
        this.offset += 1;
        const escape = this.source[this.offset];
        this.offset += 1;
        const simple: Readonly<Record<string, string>> = {
          '"': '"',
          "\\": "\\",
          "/": "/",
          b: "\b",
          f: "\f",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        if (escape !== undefined && Object.hasOwn(simple, escape)) {
          result += simple[escape];
          continue;
        }
        if (escape !== "u") {
          throw new StrictJsonError("invalid_json", "invalid JSON string escape");
        }
        const first = this.hexCodeUnit();
        if (first >= 0xd800 && first <= 0xdbff) {
          if (this.source.slice(this.offset, this.offset + 2) !== "\\u") {
            throw new StrictJsonError("invalid_unicode", "a high surrogate must be followed by a low surrogate");
          }
          this.offset += 2;
          const second = this.hexCodeUnit();
          if (second < 0xdc00 || second > 0xdfff) {
            throw new StrictJsonError("invalid_unicode", "a high surrogate must be followed by a low surrogate");
          }
          result += String.fromCharCode(first, second);
          continue;
        }
        if (first >= 0xdc00 && first <= 0xdfff) {
          throw new StrictJsonError("invalid_unicode", "a lone low surrogate is not a Unicode scalar value");
        }
        result += String.fromCharCode(first);
        continue;
      }
      if (char === undefined || char.charCodeAt(0) < 0x20) {
        throw new StrictJsonError("invalid_json", "an unescaped control character is forbidden in a JSON string");
      }
      const first = char.charCodeAt(0);
      if (first >= 0xd800 && first <= 0xdbff) {
        const next = this.source.charCodeAt(this.offset + 1);
        if (next < 0xdc00 || next > 0xdfff) {
          throw new StrictJsonError("invalid_unicode", "a high surrogate must be followed by a low surrogate");
        }
        result += this.source.slice(this.offset, this.offset + 2);
        this.offset += 2;
        continue;
      }
      if (first >= 0xdc00 && first <= 0xdfff) {
        throw new StrictJsonError("invalid_unicode", "a lone low surrogate is not a Unicode scalar value");
      }
      result += char;
      this.offset += 1;
    }
    throw new StrictJsonError("invalid_json", "unterminated JSON string");
  }

  private hexCodeUnit(): number {
    const hex = this.source.slice(this.offset, this.offset + 4);
    if (!/^[0-9A-Fa-f]{4}$/.test(hex)) {
      throw new StrictJsonError("invalid_json", "a Unicode escape must contain four hexadecimal digits");
    }
    this.offset += 4;
    return Number.parseInt(hex, 16);
  }

  private integer(): number {
    const rest = this.source.slice(this.offset);
    const match = /^-?(?:0|[1-9][0-9]*)/.exec(rest);
    if (match === null) throw new StrictJsonError("invalid_json", "invalid JSON number");
    const token = match[0];
    const following = rest[token.length];
    if (following === "." || following === "e" || following === "E") {
      throw new StrictJsonError(
        "ambiguous_number",
        "signed review attribution JSON permits only safe integers, never fractions or exponents",
      );
    }
    const value = Number(token);
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new StrictJsonError("unsafe_integer", "JSON integers must be safe integers other than -0");
    }
    this.offset += token.length;
    return value;
  }

  private literal<T>(token: string, value: T): T {
    if (this.source.slice(this.offset, this.offset + token.length) !== token) {
      throw new StrictJsonError("invalid_json", "invalid JSON literal");
    }
    this.offset += token.length;
    return value;
  }

  private space(): void {
    while (
      this.source[this.offset] === " "
      || this.source[this.offset] === "\n"
      || this.source[this.offset] === "\r"
      || this.source[this.offset] === "\t"
    ) {
      this.offset += 1;
    }
  }
}

export function parseStrictSignedJson(input: string | Uint8Array): ValidationResult<unknown> {
  let source: string;
  if (typeof input === "string") {
    if (input.length > MAX_SIGNED_JSON_BYTES) {
      return fail([{ path: "/", code: "too_large", message: `signed JSON must not exceed ${MAX_SIGNED_JSON_BYTES} UTF-8 bytes` }]);
    }
    source = input;
  } else if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_SIGNED_JSON_BYTES) {
      return fail([{ path: "/", code: "too_large", message: `signed JSON must not exceed ${MAX_SIGNED_JSON_BYTES} UTF-8 bytes` }]);
    }
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      return fail([{ path: "/", code: "invalid_utf8", message: "signed JSON bytes must be valid UTF-8" }]);
    }
  } else {
    return fail([{ path: "/", code: "invalid_json_input", message: "expected a JSON string or UTF-8 byte array" }]);
  }

  if (new TextEncoder().encode(source).byteLength > MAX_SIGNED_JSON_BYTES) {
    return fail([{ path: "/", code: "too_large", message: `signed JSON must not exceed ${MAX_SIGNED_JSON_BYTES} UTF-8 bytes` }]);
  }

  try {
    return ok(new StrictJsonParser(source).parse());
  } catch (error) {
    if (error instanceof StrictJsonError) {
      return fail([{ path: "/", code: error.code, message: error.message }]);
    }
    if (error instanceof RangeError) {
      return fail([{ path: "/", code: "too_deep", message: `signed JSON must not nest deeper than ${MAX_SIGNED_JSON_DEPTH} levels` }]);
    }
    return fail([{ path: "/", code: "invalid_json", message: "signed JSON could not be parsed" }]);
  }
}
