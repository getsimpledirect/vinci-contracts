import { createHash } from "node:crypto";
import { canonicalize, type ValidationResult } from "@getsimpledirect/vinci-contracts";

/**
 * The identity of every Oracle record: SHA-256, lowercase hex, over the
 * canonical encoding (see `canonicalize` in @getsimpledirect/vinci-contracts) of
 * the VALIDATED record.
 *
 * Validation runs first, and an invalid record throws rather than digests. That
 * ordering carries weight here beyond the general rule: REQ-03 makes the
 * request digest the thing an idempotency key is compared against, so a digest
 * computed over an unvalidated record would give a stable identity to something
 * that was never admitted — and a second, different, unvalidated record could
 * then claim the first one's key without conflict.
 *
 * `canonicalize` throws on a non-finite number by design, so nothing downstream
 * can encode one. That is a backstop, not the guard: every validator here
 * refuses a non-finite value at its own field, with a path, long before a
 * record reaches this function. A backstop that throws is a worse diagnostic
 * than a refusal that names the field.
 *
 * Deliberately a per-package copy of the same thirty lines `packages/run` and
 * `packages/work-orders` each carry, for the reason set out in
 * `src/lib/validate.ts`.
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
