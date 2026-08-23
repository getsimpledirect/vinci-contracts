import { fail, ok, type ValidationIssue, type ValidationResult } from "./result.ts";

/**
 * Turn untrusted input into a deep, inert data snapshot, or refuse it.
 *
 * Every validator in this repository must call this FIRST, and it must
 * normalise the WHOLE record, not its top level. An earlier version snapshotted
 * only own top-level properties and copied nested references unchanged, which
 * left every one of the defects it was written to prevent reachable one level
 * down:
 *
 * 1. **Inherited properties.** A nested actor whose prototype carries
 *    `workerId` reads as having one, while `Object.hasOwn` says it does not —
 *    so a verifier with an inherited `workerId` passed the field allowlist.
 *
 * 2. **Accessors.** A nested `workerId` getter returning `"w-1"` when checked
 *    and `"w-EVIL"` afterwards was read twice in one validation: it validated
 *    clean and the validated record carried the second value.
 *
 * 3. **Retained references.** The validated record held the caller's own
 *    nested objects, so mutating them AFTER validation changed what the
 *    validated record said. That defeats the point of validating at all.
 *
 * Rejecting exotic input is deliberate. These records arrive as JSON from a
 * device, a worker, or another service. None of them legitimately needs a
 * prototype, an accessor, a symbol key, a function, or a cycle, and accepting
 * them to be accommodating is what made the above reachable.
 */
export type PlainValue = string | number | boolean | null | PlainRecord | readonly PlainValue[];
export type PlainRecord = { readonly [key: string]: PlainValue };

const PLAIN_PROTOTYPES: readonly (object | null)[] = [Object.prototype, null];

/**
 * Bounded so a deeply nested input cannot exhaust the stack. Records in this
 * repository nest a handful of levels; 32 is far beyond anything legitimate
 * and far below anything dangerous.
 */
const MAX_DEPTH = 32;

/**
 * Hard cap on entries per object or array, checked BEFORE iterating.
 *
 * A hostile input can declare an enormous array cheaply — `new Array(1e9)` — and
 * without this the validator walks it, accumulating one issue per hole until it
 * exhausts memory. Refusing outright costs one comparison.
 */
const MAX_KEYS = 10_000;

/**
 * The numeric value of a canonical array index, or undefined.
 *
 * Canonical means the string round-trips: "01", "1.0", "+1" and " 1" are not
 * indices. The previous regex also accepted 4294967295, which is one past the
 * largest index any array can hold, so such a key was treated as an element and
 * then silently dropped.
 */
function canonicalIndex(key: string): number | undefined {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
  const index = Number(key);
  if (!Number.isSafeInteger(index) || index >= 2 ** 32 - 1) return undefined;
  return index;
}

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

function normalize(
  value: unknown,
  path: string,
  depth: number,
  seen: Set<object>,
  issues: ValidationIssue[],
): PlainValue | undefined {
  if (value === null) return null;

  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") {
    if (type === "number" && !Number.isFinite(value as number)) {
      issues.push(issue(path, "invalid_number", "expected a finite number"));
      return undefined;
    }
    return value as PlainValue;
  }

  if (type !== "object") {
    // functions, symbols, bigint, undefined-as-a-value
    issues.push(
      issue(path, "unsupported_value", `a data record must not carry a value of type ${type}`),
    );
    return undefined;
  }

  const object = value as object;

  if (depth > MAX_DEPTH) {
    issues.push(issue(path, "too_deep", `record nests deeper than ${MAX_DEPTH} levels`));
    return undefined;
  }
  if (seen.has(object)) {
    issues.push(issue(path, "cyclic_reference", "a data record must not contain a cycle"));
    return undefined;
  }

  seen.add(object);
  try {
    if (Array.isArray(object)) {
      // `length` is deliberately NOT consulted.
      //
      // It was read through normal property access on every loop condition, so
      // a Proxy could simply lie: reporting length 0 while its own keys held
      // three elements normalized [1,2,3] to [], silently emptying an array
      // inside a record that then validated. A length that changed between
      // reads truncated differently again. Validating `length` more carefully
      // would still be trusting a value the input controls, so it is removed
      // from the trust base instead: the elements ARE the own index keys.
      const keys = Reflect.ownKeys(object);
      if (keys.length > MAX_KEYS) {
        issues.push(
          issue(path, "too_many_keys", `a data record must not carry more than ${MAX_KEYS} entries`),
        );
        return undefined;
      }

      const indices: number[] = [];
      for (const key of keys) {
        if (typeof key === "symbol") {
          issues.push(issue(path, "symbol_key", "a data record must not carry symbol keys"));
          continue;
        }
        if (key === "length") continue;
        const index = canonicalIndex(key);
        if (index === undefined) {
          issues.push(
            issue(
              `${path}/${escapePointer(key)}`,
              "array_extra_property",
              "an array must carry only its elements; extra properties are not part of the data",
            ),
          );
          continue;
        }
        indices.push(index);
      }
      if (issues.length > 0) return undefined;

      // Elements must be a contiguous run from 0. A gap is a sparse array, and
      // an out-of-range index (the old regex accepted 4294967295, which no
      // array can hold) is not an element at all — both were dropped in
      // silence, which changes the data a caller believes it validated.
      // `length` is read ONCE, from its own data descriptor, and used only to
      // cross-check what the index keys already said. It is never the source
      // of truth: if it disagrees, the array is refused rather than trusted in
      // either direction.
      //
      // This catches both halves of the problem at once. A Proxy claiming
      // length 0 over three elements disagrees and is refused. So is a genuinely
      // sparse array — `new Array(5_000_000)` with one element set has one index
      // key and length 5000000, and normalizing it to a single-element array
      // would silently discard what the caller believed it was validating.
      const lengthDescriptor = Object.getOwnPropertyDescriptor(object, "length");
      const declaredLength =
        lengthDescriptor !== undefined && "value" in lengthDescriptor
          ? lengthDescriptor.value
          : undefined;
      if (typeof declaredLength !== "number" || declaredLength !== indices.length) {
        issues.push(
          issue(
            path,
            "array_length_mismatch",
            "an array's length must equal its element count; a sparse array or a disagreeing length is refused rather than silently reshaped",
          ),
        );
        return undefined;
      }

      indices.sort((a, b) => a - b);
      const out: PlainValue[] = [];
      for (let i = 0; i < indices.length; i += 1) {
        if (indices[i] !== i) {
          issues.push(
            issue(`${path}/${i}`, "sparse_array", "a data record must not contain a sparse array"),
          );
          return undefined;
        }
        const descriptor = Object.getOwnPropertyDescriptor(object, String(i));
        if (descriptor === undefined || !("value" in descriptor)) {
          issues.push(
            issue(`${path}/${i}`, "accessor_property", "a data record must not use getters or setters"),
          );
          return undefined;
        }
        const element = normalize(descriptor.value, `${path}/${i}`, depth + 1, seen, issues);
        if (element === undefined) return undefined;
        out.push(element);
      }
      return Object.freeze(out);
    }

    if (!PLAIN_PROTOTYPES.includes(Object.getPrototypeOf(object))) {
      issues.push(
        issue(
          path,
          "not_plain_object",
          "expected a plain data object; a record with a prototype can carry inherited fields that own-property checks do not see",
        ),
      );
      return undefined;
    }

    // Reflect.ownKeys, not Object.keys: it includes non-enumerable and symbol
    // keys, which is exactly what an unknown-field check would otherwise miss.
    // Null prototype, and assignment via defineProperty below. Building with
    // `{}` and `out[key] = value` invoked the `__proto__` SETTER when a record
    // carried that key: the value became the snapshot's prototype rather than
    // an own property, so the snapshot ended up with inherited attacker data
    // that Object.keys could not see. The normalizer reintroduced the exact
    // inherited-field problem it exists to prevent.
    const objectKeys = Reflect.ownKeys(object);
    if (objectKeys.length > MAX_KEYS) {
      issues.push(
        issue(path, "too_many_keys", `a data record must not carry more than ${MAX_KEYS} entries`),
      );
      return undefined;
    }
    const out: Record<string, PlainValue> = Object.create(null);
    for (const key of objectKeys) {
      if (typeof key === "symbol") {
        issues.push(issue(path, "symbol_key", "a data record must not carry symbol keys"));
        continue;
      }
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      if (descriptor === undefined) continue;
      if (descriptor.enumerable === false) {
        // Serialization drops these, so accepting one would mean a field
        // vanishing between what the caller sent and what was validated.
        issues.push(
          issue(
            `${path}/${escapePointer(key)}`,
            "non_enumerable_property",
            "a data record must not carry non-enumerable properties; they would be dropped rather than validated",
          ),
        );
        continue;
      }
      if (!("value" in descriptor)) {
        issues.push(
          issue(
            `${path}/${escapePointer(key)}`,
            "accessor_property",
            "a data record must not use getters or setters; an accessor can return one value when checked and another when read",
          ),
        );
        continue;
      }
      // Read exactly once, here. Nothing downstream touches the input again.
      if (key === "__proto__") {
        // Never legitimate in these records, and its presence is a strong
        // signal of an attempt at prototype pollution. Refuse rather than
        // quietly renaming or dropping it.
        issues.push(
          issue(`${path}/__proto__`, "forbidden_key", 'a data record must not carry a "__proto__" key'),
        );
        continue;
      }
      const normalized = normalize(descriptor.value, `${path}/${escapePointer(key)}`, depth + 1, seen, issues);
      if (normalized !== undefined) {
        Object.defineProperty(out, key, {
          value: normalized,
          enumerable: true,
          writable: false,
          configurable: false,
        });
      }
    }
    return Object.freeze(out);
  } finally {
    // Removed on the way out so sibling references to one object are fine;
    // only a genuine cycle (an ancestor) is refused.
    seen.delete(object);
  }
}

function escapePointer(field: string): string {
  return field.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * Maximum serialized size, checked before parsing.
 *
 * Bounds the work a hostile input can demand independently of MAX_KEYS and
 * MAX_DEPTH, both of which are only enforceable once the data is already inert.
 */
const MAX_SERIALIZED_BYTES = 1_000_000;

/**
 * Maximum values visited during serialization, enforced DURING traversal.
 *
 * A size cap checked after `JSON.stringify` returns is not a cap: the input
 * controls how much work stringify does before it returns. A Proxy that passed
 * the reflective pass by reporting `ownKeys` as `["length"]` with a descriptor
 * value of 0 could then have its `get` trap report an enormous `length`, since
 * stringify reads length through [[Get]] rather than the descriptor. Serializing
 * an array of that declared size ran to completion first — measured linear:
 * 100,000 elements cost 13ms and 4MB, so a billion costs minutes and tens of
 * gigabytes, all before any limit was consulted.
 *
 * The replacer counts every value it sees and aborts the moment this is
 * exceeded, which bounds the work *this code* performs regardless of what the
 * input claims.
 *
 * It also does not bound work JSON.stringify does before the replacer runs at
 * all. A Proxy returning two million prebuilt ownKeys costs the materialization
 * of that list — measured 843ms and 184MB — before any counter is touched.
 *
 * Counting the keys first was tried and reverted. It required reading ownKeys
 * before serialization, which is a second read of the input, and a second read
 * is precisely what let a Proxy put an uninspected field into a validated
 * record. It also only reduced the cost to 605ms and 86MB — still linear, since
 * counting a list means materializing it. Trading the one-read property for a
 * partial resource mitigation is a bad exchange: the first is soundness, the
 * second is a limit that was never going to hold against a trap anyway.
 *
 * It does not bound the work a trap does before returning. A `get` handler is
 * free to loop or allocate without ever yielding control, and no replacer can
 * interrupt it. Defending against that needs a timeout or a separate execution
 * context, neither of which belongs in a schema package — so the guarantee here
 * is deliberately the narrower one, and should not be described as bounding
 * arbitrary Proxy work.
 */
const MAX_NODES = 200_000;

/**
 * UTF-8 byte length, without assuming a Node Buffer.
 *
 * `String.prototype.length` counts UTF-16 code units, which undercounts every
 * non-ASCII character — the cap is named in bytes and must be measured in them.
 */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i += 1; // low surrogate consumed with its pair
    } else bytes += 3;
  }
  return bytes;
}

/** Distinguishes our own abort from a genuine serialization error. */
const ABORT = Symbol("vinci.normalize.abort");

export function toPlainRecord(value: unknown, path = ""): ValidationResult<PlainRecord> {
  if (typeof value !== "object" || value === null) {
    return fail([issue(path, "not_object", "expected an object")]);
  }

  // ── Read the input EXACTLY ONCE. ──────────────────────────────────────────
  //
  // Not "once per pass" — once, total. An earlier design reflected over the
  // input for precise diagnostics and then serialized it, and called that "one
  // read". It was two, and a Proxy whose `ownKeys` answered `["a"]` the first
  // time and `["a","b"]` the second put a field into the returned record that
  // validation never inspected. The guarantee was stated as a property of the
  // boundary when it was only a property of one half of it.
  //
  // So the input is serialized before anything else looks at it, and every
  // check below runs on the parsed, inert result. Whatever a hostile object
  // chooses to say, it says once, and that single answer is both what is
  // validated and what is returned.
  //
  // The cost is diagnostic, and it is worth naming. Features that cannot be
  // represented as JSON — accessors, inherited fields, symbol keys,
  // non-enumerable properties — are no longer REFUSED with a specific error;
  // serialization neutralizes them. A getter is invoked once and its value
  // becomes the data. Everything else is dropped, exactly as it would be if the
  // caller had sent the record over a wire, which is how these records actually
  // arrive. A contract that says "this is JSON data" is one this can enforce;
  // "this is a JavaScript object with no exotic features" is one it demonstrably
  // cannot.
  //
  // Reflection cannot validate a Proxy, because reflection IS the Proxy. Seven
  // rounds of hardening reflected over the input and each was defeated by a
  // trap answering differently from what the check assumed. The last one is the
  // proof: an array Proxy whose `ownKeys` returned only `length`, and whose
  // `getOwnPropertyDescriptor` reported the real non-configurable descriptor
  // with its value changed to 0, erased three elements. Both traps lied, and
  // they lied CONSISTENTLY — so a cross-check between them agreed with itself.
  // No amount of correlating one trap against another closes that, because the
  // same object authors both answers.
  //
  // Serializing once and parsing the result removes the object from the picture
  // entirely. A hostile input still gets to decide what it says, but it says it
  // once: the data that is validated and the data that is returned are the same
  // inert snapshot, so validation cannot be made to disagree with the record it
  // produced. That divergence — not the lying itself — was every one of these
  // defects.
  //
  // The checks below still run, on data that can no longer contain a prototype,
  // an accessor, a proxy or a cycle. They are cheap on inert input and they are
  // what enforces the repository's own rules: no `__proto__` key, no symbol
  // key, bounded depth, bounded width, no sparse array.
  const nonData = new Set<string>();
  let visited = 0;
  let aborted: "too_many_nodes" | "too_large" | undefined;
  let budget = 0;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, (key: string, entry: unknown) => {
      visited += 1;
      if (visited > MAX_NODES) {
        aborted = "too_many_nodes";
        throw ABORT;
      }
      // Accumulate a LOWER BOUND on the serialized size and abort the moment
      // it exceeds the cap.
      //
      // A per-string cap bounds nothing in aggregate: 200,000 permitted nodes
      // times a one-million-character limit is two hundred gigabytes. Measured
      // with forty strings of 900,000 characters — 41 nodes, every string under
      // its cap, 34.6MB allocated before the final length check ran.
      //
      // A lower bound is used rather than an estimate because it cannot
      // over-reject: JSON escaping only ever expands a string, so a record whose
      // minimum possible size already exceeds the cap could never have fit. The
      // constants are the smallest any encoding can produce — two quotes around
      // a string, three characters for a key and its colon, one for the shortest
      // literal.
      budget += typeof entry === "string" ? entry.length + 2 : 1;
      if (typeof key === "string" && key.length > 0) budget += key.length + 3;
      if (budget > MAX_SERIALIZED_BYTES) {
        aborted = "too_large";
        throw ABORT;
      }
      const type = typeof entry;
      if (type === "function" || type === "symbol" || type === "bigint" || type === "undefined") {
        nonData.add(type);
      }
      if (type === "number" && !Number.isFinite(entry as number)) nonData.add("non-finite number");
      return entry;
    });
  } catch (error) {
    if (error === ABORT) {
      return fail([
        issue(
          path,
          aborted === "too_large" ? "too_large" : "too_many_nodes",
          aborted === "too_large"
            ? `a data record must serialize to under ${MAX_SERIALIZED_BYTES} bytes`
            : `a data record must not contain more than ${MAX_NODES} values`,
        ),
      ]);
    }
    // Cycles and BigInt throw here. Reflection on a Proxy also runs user code
    // that may throw. The message is attacker-authored and is not echoed.
    return fail([
      issue(path, "not_serializable", "a data record must be inert and free of cycles"),
    ]);
  }

  if (nonData.size > 0) {
    return fail([
      issue(
        path,
        "unsupported_value",
        `a data record must not carry a value of type ${[...nonData].sort().join(", ")}`,
      ),
    ]);
  }
  if (serialized === undefined) {
    return fail([issue(path, "not_object", "expected an object")]);
  }
  // The during-traversal budget counts UTF-16 code units, which is a valid
  // LOWER bound on UTF-8 bytes and so bounds the work without over-rejecting.
  // It is not the contract: the constant says bytes, and 800,000 code units of
  // non-ASCII is 1.6MB of UTF-8 — accepted under a code-unit check. The exact
  // byte length is therefore enforced here, once, on the finished string.
  if (utf8Length(serialized) > MAX_SERIALIZED_BYTES) {
    return fail([
      issue(path, "too_large", `a data record must serialize to under ${MAX_SERIALIZED_BYTES} bytes`),
    ]);
  }

  let inert: unknown;
  try {
    inert = JSON.parse(serialized);
  } catch {
    return fail([issue(path, "not_serializable", "a data record must be inert")]);
  }
  if (typeof inert !== "object" || inert === null || Array.isArray(inert)) {
    return fail([issue(path, "not_object", "expected an object")]);
  }

  const issues: ValidationIssue[] = [];
  const normalized = normalize(inert, path, 0, new Set(), issues);
  if (issues.length > 0 || normalized === undefined) {
    return fail(issues.length > 0 ? issues : [issue(path, "not_object", "expected an object")]);
  }
  return ok(normalized as PlainRecord);
}

/**
 * Was this key present on the record?
 *
 * Use in place of `Object.hasOwn`, and in place of `x.key !== undefined`
 * anywhere. A property present and holding `undefined` is an assertion — "the
 * kind is undefined" — and is not the same as its absence.
 */
export function hasField(record: PlainRecord, field: string): boolean {
  return Object.hasOwn(record, field);
}
