import {
  fail,
  toPlainRecord,
  type PlainRecord,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { issue } from "./lib/validate.ts";

/**
 * Strict JSON ingress for Oracle records.
 *
 * `JSON.parse` cannot report a duplicate object name: it silently keeps the
 * last value. CON-02 lists "duplicate JSON keys where ambiguity affects
 * interpretation" among the things that must be REJECTED, and for these records
 * the ambiguity always affects interpretation — a document carrying
 * `"completeness":"NOT_OBTAINED"` twice, once with each value, is read one way
 * by Node and the other way by a decoder that keeps the first. Both readings
 * digest differently, so one of them cites bytes the other never saw.
 *
 * This is deliberately NOT the parser in
 * `packages/remote-protocol/src/strict-json.ts`. That one is scoped to a signed
 * wire format with no floating-point fields and is private to its package;
 * importing another package's internals is the coupling the layer rule exists
 * to prevent. This one does the smaller job: it lets `JSON.parse` decide what
 * is valid JSON and only answers the one question `JSON.parse` cannot.
 */

/**
 * Bounded so a hostile document cannot make the scan below the expensive part
 * of a request. A megabyte is far beyond any record in this package and far
 * below anything that would matter.
 */
export const MAX_ORACLE_JSON_BYTES = 1_000_000;

type Frame = {
  readonly kind: "object" | "array";
  readonly path: string;
  readonly keys: Set<string>;
  index: number;
  currentKey: string | null;
};

/**
 * The JSON pointer of the first duplicated object name in `text`, or null.
 *
 * `text` must already have parsed, so this scan can assume well-formed JSON and
 * answer only the duplicate question. Keys are compared AFTER escape decoding,
 * because `"a"` and `"a"` are the same name and a byte comparison would
 * miss the interesting case.
 */
function firstDuplicateKey(text: string): string | null {
  const stack: Frame[] = [];
  let offset = 0;

  const childPath = (): string => {
    const top = stack[stack.length - 1];
    if (top === undefined) return "";
    return top.kind === "object" ? `${top.path}/${top.currentKey ?? ""}` : `${top.path}/${top.index}`;
  };

  while (offset < text.length) {
    const char = text[offset];
    if (char === undefined) break;

    if (char === '"') {
      // Lex the whole string token, honouring escapes, then decide what it is.
      const start = offset;
      offset += 1;
      while (offset < text.length) {
        const inner = text[offset];
        if (inner === "\\") {
          offset += 2;
          continue;
        }
        offset += 1;
        if (inner === '"') break;
      }
      const raw = text.slice(start, offset);
      // A string inside an object that is followed by a colon is a NAME. A
      // string value never is: valid JSON has no other place for a colon.
      let after = offset;
      while (after < text.length && /\s/.test(text[after] ?? "")) after += 1;
      const top = stack[stack.length - 1];
      if (text[after] === ":" && top !== undefined && top.kind === "object") {
        let name: string;
        try {
          name = JSON.parse(raw) as string;
        } catch {
          return null; // not our question; JSON.parse already accepted the document
        }
        if (top.keys.has(name)) return `${top.path}/${name}`;
        top.keys.add(name);
        top.currentKey = name;
      }
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push({
        kind: char === "{" ? "object" : "array",
        path: childPath(),
        keys: new Set<string>(),
        index: 0,
        currentKey: null,
      });
      offset += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      stack.pop();
      offset += 1;
      continue;
    }
    if (char === ",") {
      const top = stack[stack.length - 1];
      if (top !== undefined) {
        if (top.kind === "array") top.index += 1;
        else top.currentKey = null;
      }
      offset += 1;
      continue;
    }
    offset += 1;
  }
  return null;
}

/**
 * Parse one Oracle record from JSON text, refusing an ambiguous document.
 *
 * The result is an inert plain snapshot, ready for any of this package's
 * validators. Refusals carry their own codes — `invalid_json`,
 * `duplicate_json_key`, `oversize_document` — so a consumer can tell "this is
 * not JSON" from "this JSON says two different things", which is the
 * distinction CON-02 is about.
 */
export function parseOracleRecordJson(text: unknown): ValidationResult<PlainRecord> {
  if (typeof text !== "string") {
    return fail([issue("", "invalid_type", "an Oracle record is parsed from JSON text")]);
  }
  if (text.length > MAX_ORACLE_JSON_BYTES) {
    return fail([
      issue("", "oversize_document", `an Oracle record is at most ${MAX_ORACLE_JSON_BYTES} characters`),
    ]);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail([issue("", "invalid_json", "the document is not well-formed JSON")]);
  }
  const duplicate = firstDuplicateKey(text);
  if (duplicate !== null) {
    return fail([
      issue(
        duplicate,
        "duplicate_json_key",
        "CON-02: this name appears twice, and two decoders will disagree about which value it has; "
          + "the document is refused rather than read one of the two ways",
      ),
    ]);
  }
  return toPlainRecord(parsed) as ValidationResult<PlainRecord>;
}
