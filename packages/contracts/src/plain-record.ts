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
      const out: PlainValue[] = [];
      for (let i = 0; i < object.length; i += 1) {
        // Index access on an array can hit an accessor too, so go through the
        // descriptor rather than reading the element.
        const descriptor = Object.getOwnPropertyDescriptor(object, i);
        if (descriptor === undefined) {
          issues.push(issue(`${path}/${i}`, "sparse_array", "a data record must not contain a sparse array"));
          continue;
        }
        if (!("value" in descriptor)) {
          issues.push(
            issue(`${path}/${i}`, "accessor_property", "a data record must not use getters or setters"),
          );
          continue;
        }
        const element = normalize(descriptor.value, `${path}/${i}`, depth + 1, seen, issues);
        if (element !== undefined) out.push(element);
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
    const out: Record<string, PlainValue> = {};
    for (const key of Reflect.ownKeys(object)) {
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
      const normalized = normalize(descriptor.value, `${path}/${escapePointer(key)}`, depth + 1, seen, issues);
      if (normalized !== undefined) out[key] = normalized;
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
  const normalized = normalize(value, path, 0, new Set(), issues);
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
