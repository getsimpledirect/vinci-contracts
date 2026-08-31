import type { ModelEndpointSpec } from "./endpoint.ts";

/**
 * Report whether a reviewer shares an endpoint identity with the producer.
 *
 * Endpoint ids identify the same configured lane. Open-weight and
 * Vinci-pretrained endpoints are also identical when their weights digests
 * match, even across those two source classes. Frontier API identity uses the
 * observable provider/model pair. That pair is only a lower bound on sameness:
 * different labels or providers can still conceal shared underlying weights.
 */
/**
 * Every field identity depends on, read EXACTLY ONCE, into a plain record no
 * accessor can reach again.
 *
 * This is not defensive style. An earlier form of this function validated the
 * endpoint and then re-read the same fields to compare them, so a getter could
 * return a legible enum member to the check and a different one to the
 * comparison -- passing legibility, making the two source classes differ, and
 * being granted independence while the stable identity was a shared
 * weightsDigest that must block. Check-then-use is exactly what an accessor
 * defeats; the snapshot is what closes it.
 */
type EndpointIdentity = {
  readonly endpointId: unknown;
  readonly sourceClass: unknown;
  readonly provider: unknown;
  readonly model: unknown;
  readonly weightsDigest: unknown;
};

function snapshotIdentity(value: unknown): EndpointIdentity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const snapshot: EndpointIdentity = {
    endpointId: record["endpointId"],
    sourceClass: record["sourceClass"],
    provider: record["provider"],
    model: record["model"],
    weightsDigest: record["weightsDigest"],
  };
  if (typeof snapshot.endpointId !== "string" || snapshot.endpointId.length === 0) return undefined;
  if (
    snapshot.sourceClass !== "frontier_api" &&
    snapshot.sourceClass !== "open_weight" &&
    snapshot.sourceClass !== "vinci_pretrained"
  ) return undefined;
  return snapshot;
}

export function violatesIndependence(
  producer: ModelEndpointSpec,
  reviewer: ModelEndpointSpec,
): boolean {
  try {
    // May only answer "independent" when BOTH identities are legible. An absent
    // identity is not a different identity: comparing absent fields silently
    // succeeds, which is how every earlier version of this bug worked.
    const p = snapshotIdentity(producer);
    const r = snapshotIdentity(reviewer);
    if (p === undefined || r === undefined) return true;

    if (p.endpointId === r.endpointId) return true;

    // Both source classes are proven legible above and cannot change now --
    // they are values in a record we own, not reads through the caller's
    // object. Two DIFFERENT ones cannot name the same artifact, so this
    // establishes independence. On an unsnapshotted argument the same
    // comparison is a fail-open.
    if (p.sourceClass !== r.sourceClass) return false;

    if (p.sourceClass === "frontier_api") {
      if (
        typeof p.provider !== "string" || typeof r.provider !== "string" ||
        typeof p.model !== "string" || typeof r.model !== "string"
      ) return true;
      // Weaker than a digest by construction: a provider may serve changed
      // weights behind an unchanged model name, so equality is a LOWER BOUND on
      // sameness and inequality does not prove independence.
      return p.provider === r.provider && p.model === r.model;
    }

    if (typeof p.weightsDigest !== "string" || typeof r.weightsDigest !== "string") return true;
    return p.weightsDigest === r.weightsDigest;
  } catch {
    return true;
  }
}
