import type { Timestamp } from "@vinci/contracts";

/**
 * Whether a receipt may be shown as verified.
 *
 * FR-6.4 permits the word only when THREE things hold: an approved verifier
 * evaluated the relevant CURRENT state, the evidence is bound to the correct
 * artifact version, and nothing has invalidated it since.
 *
 * An earlier version of this file carried that sentence as a comment above a
 * union whose verified arm held a verifier id and a timestamp. That is one
 * condition — who, and when. It bound nothing to an artifact version, and gave
 * a holder no way to tell whether anything had changed since. The comment
 * asserted what the type did not do, which is the failure mode this repository
 * keeps producing.
 *
 * So the binding is in the type, and currency cannot be assumed:
 *
 *  - `subjectDigest` records exactly WHAT was evaluated (condition 2);
 *  - `independent` records whether the verifier was independent of the worker,
 *    because FR-7.3 requires non-independence to be disclosed rather than
 *    quietly permitted;
 *  - and there is no way to read a verified answer without supplying the
 *    CURRENT digest to compare against (condition 3) — see
 *    `verificationAgainst` below.
 */
export type VerificationRecord =
  | { readonly status: "unverified" }
  | {
      readonly status: "verified";
      readonly verifierId: string;
      readonly independent: boolean;
      readonly verifiedAt: Timestamp;
      /** The exact content this verdict was issued against. */
      readonly subjectDigest: string;
    }
  | { readonly status: "invalidated"; readonly reason: string };

/**
 * What a consumer may display, given the state as it is NOW.
 *
 * The current digest is a required argument. That is the point: a caller
 * cannot obtain "verified" while holding only the record, because the record
 * alone cannot answer whether it is still current. A stale verdict remains
 * visible as history (FR-7.4) and is never reported as current.
 */
export type VerificationDisplay =
  | { readonly show: "verified"; readonly independent: boolean; readonly verifiedAt: Timestamp }
  | { readonly show: "not_verified"; readonly because: "never_verified" }
  | { readonly show: "not_verified"; readonly because: "invalidated"; readonly reason: string }
  | {
      readonly show: "not_verified";
      readonly because: "stale";
      readonly verifiedDigest: string;
      readonly currentDigest: string;
    };

export function verificationAgainst(
  record: VerificationRecord,
  currentDigest: string,
): VerificationDisplay {
  if (record.status === "unverified") return { show: "not_verified", because: "never_verified" };
  if (record.status === "invalidated") {
    return { show: "not_verified", because: "invalidated", reason: record.reason };
  }
  if (record.subjectDigest !== currentDigest) {
    return {
      show: "not_verified",
      because: "stale",
      verifiedDigest: record.subjectDigest,
      currentDigest,
    };
  }
  return { show: "verified", independent: record.independent, verifiedAt: record.verifiedAt };
}
