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
 * exceeded, which bounds the work regardless of what the input claims.
 */
const MAX_NODES = 200_000;

/** Distinguishes our own abort from a genuine serialization error. */
const ABORT = Symbol("vinci.normalize.abort");

export function toPlainRecord(value: unknown, path = ""): ValidationResult<PlainRecord> {
  if (typeof value !== "object" || value === null) {
    return fail([issue(path, "not_object", "expected an object")]);
  }

  // ── Pass 1: reflect, for precise errors. ──────────────────────────────────
  //
  // Runs against the ORIGINAL input and produces the diagnostics this
  // repository's rules call for — no inherited fields, no accessors, no symbol
  // keys, no extra array properties, no sparse arrays, no cycles. For an honest
  // caller this is the whole story, and it runs BEFORE serialization so a
  // getter is refused rather than invoked.
  const issues: ValidationIssue[] = [];
  try {
    normalize(value, path, 0, new Set(), issues);
  } catch {
    return fail([
      issue(path, "hostile_object", "inspecting this value raised an error; a data record must be inert"),
    ]);
  }
  if (issues.length > 0) return fail(issues);


  // ── Pass 2: serialize once, for truth. ────────────────────────────────────
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
  let aborted: "too_many_nodes" | "string_too_long" | undefined;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, (_key, entry: unknown) => {
      visited += 1;
      if (visited > MAX_NODES) {
        aborted = "too_many_nodes";
        throw ABORT;
      }
      if (typeof entry === "string" && entry.length > MAX_SERIALIZED_BYTES) {
        aborted = "string_too_long";
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
          aborted === "string_too_long" ? "too_large" : "too_many_nodes",
          aborted === "string_too_long"
            ? `a data record must not contain a string longer than ${MAX_SERIALIZED_BYTES} characters`
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
  if (serialized.length > MAX_SERIALIZED_BYTES) {
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

  const inertIssues: ValidationIssue[] = [];
  const normalized = normalize(inert, path, 0, new Set(), inertIssues);
  if (inertIssues.length > 0 || normalized === undefined) {
    return fail(
      inertIssues.length > 0 ? inertIssues : [issue(path, "not_object", "expected an object")],
    );
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
