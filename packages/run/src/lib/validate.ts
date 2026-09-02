import {
  isCanonicalTimestamp,
  isDigest,
  isIdentifier,
  isNonBlankText,
  plainActor,
  type ValidationIssue,
} from "@getsimpledirect/vinci-contracts";

/**
 * Shared validation helpers for the vinci-run schema package.
 *
 * Every validator in this package follows the same shape as `validateWorkOrder`
 * (see packages/work-orders/src/work-order.ts): snapshot through
 * `toPlainRecord`, reject unknown fields, and fail closed. These small helpers
 * exist so the six schema files do not each carry a second private copy of the
 * same three-line rules — the same duplication this repository has already
 * paid for once with the canonicalizer.
 */

/** One validation issue, carrying a stable machine-readable code. */
export function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

/** Is `value` a plain data object (not null, not an array)? */
export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject any key on `record` that is not in `allowed`. */
export function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  noun: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.includes(key)) {
      issues.push(issue(`${path}/${key}`, "unknown_field", `${noun} carries only its declared fields`));
    }
  }
}

/** A safe integer >= 0. Negative zero is rejected. */
export function isNonNegativeInt(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0)
  );
}

/** A safe integer >= 1. */
export function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/** Non-blank text no longer than 512 characters (used for refs). */
export function isRefText(value: unknown): value is string {
  return isNonBlankText(value) && (value as string).length <= 512;
}

/**
 * A git object id: exactly 40 lowercase hex characters.
 *
 * Distinct from `isDigest` (64 hex, SHA-256) on purpose. A commit or tree id is
 * a SHA-1 object name, and accepting either width would let a 64-hex digest of
 * anything at all pass where a commit id is required — the field would then
 * assert more than the check verifies. Git's SHA-256 object format is a schema
 * version bump with its own migration, not a widened regex here.
 */
export function isGitObjectId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

/** Is `value` a member of the closed `members` set? */
export function isEnumMember(value: unknown, members: readonly string[]): value is string {
  return typeof value === "string" && (members as readonly string[]).includes(value);
}

export { isCanonicalTimestamp, isDigest, isIdentifier, isNonBlankText, plainActor };
