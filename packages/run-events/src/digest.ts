import { createHash } from "node:crypto";
import type { RunEvent } from "./event.ts";

/**
 * A deterministic encoding of an event, for comparing two events for identity.
 *
 * Keys are sorted recursively; arrays keep their order, since position in an
 * array is meaning rather than incidental. Numbers and booleans are written
 * through JSON's own encoding, which is exact for the safe-integer counts and
 * booleans a payload may contain — a payload cannot hold a float or a bigint,
 * so the usual traps of numeric canonicalization do not arise here.
 *
 * `toPlainRecord` in @vinci/contracts does NOT do this. It serializes and
 * reparses, which preserves JSON property order: `{b:1,a:2}` and `{a:2,b:1}`
 * come back as different byte sequences. It is the right tool for producing an
 * inert snapshot and the wrong one for producing a stable identity.
 *
 * Scope note, stated because the alternative would be to overclaim: this
 * encoding exists to compare events WITHIN this package. It is not offered as
 * the platform's canonical form, and nothing persists it. A shared canonical
 * encoder belongs in layer 0 beside `toPlainRecord`, and layer 0 is frozen — so
 * if `@vinci/receipts` needs the same routine, that is a decision to unfreeze
 * E0, not something to duplicate quietly here and let drift.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("cannot canonicalize a non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  throw new Error(`cannot canonicalize a value of type ${typeof value}`);
}

/**
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
