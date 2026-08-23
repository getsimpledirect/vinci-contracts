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

export function toPlainRecord(value: unknown, path = ""): ValidationResult<PlainRecord> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail([issue(path, "not_object", "expected an object")]);
  }
  const issues: ValidationIssue[] = [];
  let normalized: PlainValue | undefined;
  try {
    normalized = normalize(value, path, 0, new Set(), issues);
  } catch {
    // Reflection on a Proxy runs user code: ownKeys, getOwnPropertyDescriptor
    // and getPrototypeOf can all throw. Letting that escape turns a validation
    // call into a crash, so a caller written to handle fail-closed results
    // gets an exception instead. The message is not echoed — it is
    // attacker-authored.
    return fail([
      issue(
        path,
        "hostile_object",
        "inspecting this value raised an error; a data record must be inert",
      ),
    ]);
  }
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
