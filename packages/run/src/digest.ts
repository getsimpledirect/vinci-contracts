import { createHash } from "node:crypto";
import { canonicalize, type ValidationResult } from "@getsimpledirect/vinci-contracts";

/**
 * The identity of every run-contract object: SHA-256, lowercase hex, over the
 * canonical encoding (see `canonicalize` in @getsimpledirect/vinci-contracts) of
 * the VALIDATED object.
 *
 * Validation runs first, and an invalid object throws rather than digests — a
 * digest of an unvalidated object would give a stable identity to something
 * that is not a contract object, and the identity is what a consumer is handed
 * in place of the object. Validation also normalises through `toPlainRecord`,
 * so an accessor or an inherited property cannot make the bytes hashed differ
 * from the bytes validated.
 *
 * This is the same construction `workOrderDigest`, `receiptDigest` and
 * `eventDigest` use.
 */
export function digestValidated<T>(label: string, result: ValidationResult<T>): string {
  if (!result.ok) {
    const first = result.issues[0];
    throw new Error(
      `cannot digest an invalid ${label}: ${first?.path ?? "/"} ${first?.code ?? "invalid"}`,
    );
  }
  return sha256Hex(canonicalize(result.value));
}

/** SHA-256 of the UTF-8 bytes of `text`, as lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
