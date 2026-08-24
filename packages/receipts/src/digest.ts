import { canonicalize } from "@getsimpledirect/vinci-contracts";

/**
 * Re-exported, not reimplemented.
 *
 * This package briefly had its own copy, and the two had already diverged
 * before anyone noticed: the shared one omits undefined-valued properties like
 * JSON does, the local one threw on them. Same input, different answer — for a
 * function whose entire job is that two implementations agree byte for byte.
 */
export { canonicalize };
import { createHash } from "node:crypto";
import type { Receipt } from "./receipt.ts";

/**
 * Deterministic encoding of a value for identity comparison.
 *
 * Sorts object keys recursively at every level, preserves array order (position is meaning),
 * and explicitly encodes numbers and strings. This differs from `toPlainRecord` which
 * preserves insertion order and is used for creating inert snapshots; canonicalization
 * creates a stable, order-independent representation suitable for hashing.
 */

/**
 * Computes the SHA-256 digest of a receipt's covered content.
 *
 * Covered: all fields except digest and signature.
 * The digest itself must be recomputed rather than stored, so digest and signature
 * are never included in the computation.
 */
export function receiptDigest(receipt: Receipt): string {
  const toHash = { ...receipt };
  const { digest: _, signature: __, ...covered } = toHash;
  return createHash("sha256").update(canonicalize(covered), "utf8").digest("hex");
}
