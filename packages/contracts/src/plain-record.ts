import { fail, type ValidationResult, ok } from "./result.ts";

/**
 * Turn untrusted input into a plain, inert data snapshot, or refuse it.
 *
 * Every validator in this repository must call this FIRST. Three classes of
 * defect all trace to validating a live JavaScript object instead of data:
 *
 * 1. **Inherited properties.** A record whose prototype carries
 *    `kind: "worker"` reads as a worker through `record.kind`, but
 *    `Object.hasOwn(record, "kind")` is false. A dispatcher using `hasOwn`
 *    sends it down the untagged path, and an untagged-identity check using
 *    `hasOwn` misses the inherited `workerId` too — so a worker-tagged
 *    credential holding the `acceptance` scope validated as untagged. Both
 *    halves of that fix used the predicate whose blind spot caused it.
 *
 * 2. **Accessors.** A `scopes` getter returning `["inference"]` on the first
 *    read and `["acceptance"]` afterwards was read three times during one
 *    validation: it validated clean and the returned credential carried
 *    `acceptance`. Any validator that reads a property more than once — to
 *    check it, then to copy it — is exploitable this way, and nearly all of
 *    them do.
 *
 * 3. **Non-enumerable and symbol keys.** `Object.keys` and `for...in` miss
 *    them, so a schema that claims to reject unknown fields silently carried
 *    them, along with an inherited `toJSON` able to change what the record
 *    becomes when serialized.
 *
 * Rejecting a non-plain object is deliberately blunt. These records arrive as
 * JSON from a device, a worker, or another service; none of them legitimately
 * needs a prototype, an accessor, or a symbol key. Accepting exotic objects to
 * be accommodating is what made all three of the above reachable.
 */
export type PlainRecord = Readonly<Record<string, unknown>>;

const PLAIN_PROTOTYPES: readonly (object | null)[] = [Object.prototype, null];

export function toPlainRecord(value: unknown, path = ""): ValidationResult<PlainRecord> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail([{ path, code: "not_object", message: "expected an object" }]);
  }

  if (!PLAIN_PROTOTYPES.includes(Object.getPrototypeOf(value))) {
    return fail([
      {
        path,
        code: "not_plain_object",
        message:
          "expected a plain data object; a record with a prototype can carry inherited fields that own-property checks do not see",
      },
    ]);
  }

  // Reflect.ownKeys, not Object.keys: it includes non-enumerable and symbol
  // keys, which is the point.
  const keys = Reflect.ownKeys(value);
  const snapshot: Record<string, unknown> = Object.create(null);

  for (const key of keys) {
    if (typeof key === "symbol") {
      return fail([
        {
          path: `${path}/${String(key)}`,
          code: "symbol_key",
          message: "a data record must not carry symbol keys",
        },
      ]);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    if (!("value" in descriptor)) {
      return fail([
        {
          path: `${path}/${key}`,
          code: "accessor_property",
          message:
            "a data record must not use getters or setters; an accessor can return one value when checked and another when read",
        },
      ]);
    }
    // Read exactly once, here. Everything downstream sees this snapshot.
    snapshot[key] = descriptor.value;
  }

  return ok(Object.freeze(snapshot));
}

/**
 * Was this key present on the record?
 *
 * Use in place of `Object.hasOwn` on a snapshot from `toPlainRecord`, and in
 * place of `x.key !== undefined` anywhere. A property present and holding
 * `undefined` is an assertion — "the kind is undefined" — and is not the same
 * as its absence.
 */
export function hasField(record: PlainRecord, field: string): boolean {
  return Object.hasOwn(record, field);
}
