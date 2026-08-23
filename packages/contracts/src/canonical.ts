/**
 * A deterministic encoding, shared by every package that needs a stable
 * identity for a record.
 *
 * This lives in layer 0 for a specific reason. `@vinci/run-events` needs it to
 * compare two events; `@vinci/receipts` needs it to digest a receipt. They are
 * the same layer, so they cannot import each other — and two hand-written
 * canonicalizers producing subtly different bytes is exactly the drift this
 * repository exists to prevent. A digest is a wire format: two implementations
 * that disagree by one byte cannot verify each other's records, which defeats
 * the point of having a digest at all.
 *
 * `toPlainRecord` does NOT do this and is not a substitute. It serializes and
 * reparses, which preserves JSON property order: `{b:1,a:2}` and `{a:2,b:1}`
 * come back as different byte sequences. It produces an inert snapshot; this
 * produces a stable identity. Both are needed and they are not the same job.
 *
 * Rules, stated so an independent implementation can agree byte for byte:
 *
 *  - object keys sorted by code unit, recursively, at every level;
 *  - arrays keep their order, because position in an array is meaning;
 *  - `undefined`-valued properties omitted, matching JSON;
 *  - numbers encoded by `JSON.stringify`, which is exact for the safe integers
 *    these records carry;
 *  - strings escaped by `JSON.stringify`;
 *  - non-finite numbers and unsupported types throw rather than encode, because
 *    silently encoding them would make two records with different content share
 *    an identity.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  const type = typeof value;
  if (type === "number") {
    if (!Number.isFinite(value as number)) {
      throw new Error("cannot canonicalize a non-finite number");
    }
    return JSON.stringify(value);
  }
  if (type === "boolean" || type === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (type === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
  }
  throw new Error(`cannot canonicalize a value of type ${type}`);
}
