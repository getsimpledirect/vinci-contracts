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
export function isNonBlankText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
