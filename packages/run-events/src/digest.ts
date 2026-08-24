import { createHash } from "node:crypto";
import { canonicalize } from "@getsimpledirect/vinci-contracts";

/** Re-exported so callers need not reach past this package for it. */
export { canonicalize };
import type { RunEvent } from "./event.ts";

/**
 * Event identity, built on the shared canonical encoding in @getsimpledirect/vinci-contracts.
 *
 * That encoding used to live here. It moved to layer 0 because @getsimpledirect/vinci-receipts
 * needs the same rule and cannot import this package — same layer — so the two
 * would have been separate hand-written implementations of one wire format.
 * Two canonicalizers that disagree by a byte cannot verify each other's
 * records, which is the whole point of having one.
 *
 * The identity of an event: every field, including `sequence`.
 *
 * Idempotency previously compared a digest the CALLER supplied, so passing the
 * same invented string for two different events made the second look like a
 * retry of the first — a changed actor, payload or sequence silently discarded
 * and reported as success. Computing it here removes the caller's ability to
 * assert identity rather than demonstrate it.
 */
export function eventDigest(event: RunEvent): string {
  return createHash("sha256").update(canonicalize(event), "utf8").digest("hex");
}
