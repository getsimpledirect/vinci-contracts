/**
 * The validation result every schema in this repository returns.
 *
 * It is a discriminated union rather than a thrown exception or a boolean
 * because D4 requires that malformed data fail closed *and* explain itself:
 * FR-4.8 obliges the product to show what was requested, why it was blocked,
 * and which policy controlled the decision. A boolean cannot carry that.
 *
 * `unknownFields` is carried on the success arm rather than discarded so a
 * consumer can round-trip a newer producer's record without loss.
 */
export type ValidationIssue = {
  /** JSON-pointer-style path to the offending value, e.g. `/policy/network/0`. */
  readonly path: string;
  /** Stable machine-readable code. Safe to switch on; safe to show to a user. */
  readonly code: string;
  /** Human-readable explanation. Must not embed secret values (SR-3). */
  readonly message: string;
};

export type ValidationResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      /**
       * Fields present on the input that this schema version does not know.
       * Retained verbatim so an older consumer can re-emit a newer producer's
       * record unchanged. Empty for a record produced at this exact version.
       */
      readonly unknownFields: Readonly<Record<string, unknown>>;
    }
  | {
      readonly ok: false;
      /** Never empty. A failed validation always says why. */
      readonly issues: readonly ValidationIssue[];
    };

export function ok<T>(
  value: T,
  unknownFields: Readonly<Record<string, unknown>> = {},
): ValidationResult<T> {
  return { ok: true, value, unknownFields };
}

export function fail<T>(issues: readonly ValidationIssue[]): ValidationResult<T> {
  if (issues.length === 0) {
    throw new Error("a failed ValidationResult must carry at least one issue");
  }
  return { ok: false, issues };
}
