import { createHash } from "node:crypto";
import { canonicalize } from "@getsimpledirect/vinci-contracts";
import { validateWorkOrder, type WorkOrder } from "./work-order.ts";

/**
 * The identity of a work order: SHA-256, lowercase hex, over the canonical
 * encoding (see `canonicalize` in @getsimpledirect/vinci-contracts) of the
 * VALIDATED order.
 *
 * What is covered: EVERYTHING the order carries, including `supersedes`,
 * `contractVersion`, `issuedAt` and `expiresAt`. The digest identifies the
 * exact contract, not the request behind it. Two contracts that differ only in
 * when they were issued, or in which amendment produced them, are different
 * grants of authority — a worker holding one must not be able to present it as
 * the other. If a "same request, any version" identity is ever needed it is a
 * different function with a different name; this one does not exclude fields.
 *
 * Validation runs first, and an invalid order throws rather than digests. A
 * digest of an unvalidated object would give a stable identity to something
 * that is not a work order, and the identity is what a worker is handed in
 * place of the order. Validation also normalises the input through
 * `toPlainRecord`, so an accessor or an inherited property cannot make the
 * bytes hashed differ from the bytes validated.
 *
 * This is the same construction `receiptDigest` and `eventDigest` use. It is
 * reproduced in python/vinci_canonical.py, and vectors/ pins both to the byte.
 */
export function workOrderDigest(order: WorkOrder): string {
  const validated = validateWorkOrder(order);
  if (!validated.ok) {
    const first = validated.issues[0];
    throw new Error(
      `cannot digest an invalid work order: ${first?.path ?? "/"} ${first?.code ?? "invalid"}`,
    );
  }
  return sha256Hex(canonicalize(validated.value));
}

/** SHA-256 of the UTF-8 bytes of `text`, as lowercase hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
