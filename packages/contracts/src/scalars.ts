/**
 * Scalar shapes shared by every layer.
 *
 * These live at layer 0 for one reason: they were about to be written twice.
 * `isCanonicalTimestamp` started in run-events (layer 2), and the verdict
 * record in evidence (layer 1) needs the identical rule but cannot import
 * upward. The last time a helper was duplicated across that boundary — the
 * canonicalizer — the two copies had already diverged before anyone noticed.
 * A validator that means something slightly different in two packages is worse
 * than no validator, because both callers believe they agree.
 */

/**
 * ISO-8601 UTC, millisecond precision, and a date that actually exists.
 *
 * Mandatory, not advisory. Ordering compares timestamps as strings, which is
 * sound ONLY for this exact canonical form — an unvalidated timestamp makes
 * `"2026-1-1"` sort before `"2026-01-02"`, and a non-UTC offset sort by its
 * text rather than by its instant. The round-trip also rejects dates that do
 * not exist: Date.parse normalizes 2026-02-29 to March 1 rather than refusing
 * it, so the pattern alone would admit a day that never happened.
 */
export function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === "string"
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && !Number.isNaN(Date.parse(value))
    && new Date(value).toISOString() === value
  );
}

/**
 * Strictly-later comparison for two canonical timestamps.
 *
 * Both operands must be canonical. Passing an unvalidated string here is a
 * caller error, and the function refuses rather than comparing text that may
 * not order by instant.
 */
export function isStrictlyAfter(later: unknown, earlier: unknown): boolean {
  if (!isCanonicalTimestamp(later) || !isCanonicalTimestamp(earlier)) return false;
  return Date.parse(later) > Date.parse(earlier);
}

/** Identifiers refer to things; they are not a place to put prose. */
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** Lowercase hex SHA-256. Uppercase is rejected so digests compare bytewise. */
export function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/** A closed-vocabulary token: no spaces, no punctuation, no smuggled prose. */
export function isEnumToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value);
}

/**
 * Human-readable text that carries actual content.
 *
 * `""` and `"   "` are both rejected, and so is `" "`. A summary made of
 * whitespace satisfies a `typeof === "string"` check and a `.length > 0` check
 * while telling a reader nothing, which is precisely the shape a record takes
 * when a field was required by a schema and had nothing to put in it. Trimming
 * covers Unicode whitespace, not just ASCII spaces.
 */

/**
 * IDENTIFIER SHAPE, confirmed against the real identity provider 2026-08-24.
 *
 * `isIdentifier` below rejects anything outside [A-Za-z0-9._:-], which means it
 * rejects `auth0|abc123` and every email-shaped id. That was an assumption when
 * written; it is now checked. vinci-chat authenticates with better-auth, whose
 * default id generation is opaque alphanumeric and passes cleanly — there is no
 * custom generateId override in lib/auth/auth.ts.
 *
 * If the identity provider ever changes, re-check this BEFORE adopting: five
 * repositories validate identifiers against this rule, and loosening it after
 * they do is a migration rather than an edit.
 */
export function isNonBlankText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * A short, safe label for an unexpected value, for use in error messages.
 *
 * Never throws. `String(x)` and `${x}` both throw "Cannot convert object to
 * primitive value" on a null-prototype object — and every value a validator
 * inspects is null-prototype, because that is exactly what `toPlainRecord`
 * produces. So a validator handed `{ kind: {...} }` crashed while building the
 * message that reports the problem: the diagnostic path was the one path that
 * had never been exercised, since it only runs when input is already wrong.
 *
 * Non-primitives are described by shape rather than content. That is
 * deliberate beyond avoiding the throw: an error message is a place a value
 * can escape to a log, and SR-3 says secrets must never reach one. A caller
 * learns "object", not what was in it. Strings are truncated for the same
 * reason a log line is.
 */
export function safeLabel(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  switch (typeof value) {
    case "string":
      return value.length > 64 ? `${value.slice(0, 64)}…` : value;
    case "number":
    case "boolean":
    case "bigint":
      return String(value);
    case "symbol":
      return "symbol";
    case "function":
      return "function";
    default:
      return Array.isArray(value) ? "array" : "object";
  }
}

/**
 * Read one own DATA property, or undefined.
 *
 * Never invokes a getter, never follows a prototype, never throws. The three
 * ways a value can lie about itself, refused in one place.
 *
 * This lives at layer 0 because it was about to exist twice. A private copy in
 * `@getsimpledirect/vinci-evidence` already guards attribution, and the first thing written
 * against a new package needed the identical rule — a direct `budget.decisions`
 * read threw on a proxy whose get trap throws, in a predicate documented to
 * refuse rather than throw. Every duplicated helper in this repository has
 * drifted; this one is shared before it gets the chance.
 */
export function ownData(source: unknown, field: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(source, field);
  } catch {
    return undefined;
  }
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}
