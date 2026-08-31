import { isIdentifier } from "@getsimpledirect/vinci-contracts";
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
  if (!isIdentifier(snapshot.endpointId)) return undefined;
  if (
    snapshot.sourceClass !== "frontier_api" &&
    snapshot.sourceClass !== "open_weight" &&
    snapshot.sourceClass !== "vinci_pretrained"
  ) return undefined;
  return snapshot;
}

function hasLegibleArtifactIdentity(identity: EndpointIdentity): boolean {
  if (identity.sourceClass === "frontier_api") {
    return typeof identity.provider === "string" && identity.provider.length > 0 &&
      typeof identity.model === "string" && identity.model.length > 0;
  }
  return isIdentifier(identity.weightsDigest);
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
    if (!hasLegibleArtifactIdentity(p) || !hasLegibleArtifactIdentity(r)) return true;

    if (p.endpointId === r.endpointId) return true;

    // Open-weight and Vinci-pretrained are two provenance classes for the same
    // digest-identified identity scheme. The class labels may differ while the
    // weights are byte-identical, so compare their digests before considering
    // a differing source class independent.
    const pIsDigestIdentified = p.sourceClass !== "frontier_api";
    const rIsDigestIdentified = r.sourceClass !== "frontier_api";
    if (pIsDigestIdentified && rIsDigestIdentified) {
      return p.weightsDigest === r.weightsDigest;
    }

    // A frontier API identity and a digest-identified local artifact use
    // disjoint identity schemes. Both class values were snapshotted and proven
    // legible above, so the comparison cannot be changed by a hostile getter.
    if (p.sourceClass !== r.sourceClass) return false;

    if (p.sourceClass === "frontier_api") {
      // Weaker than a digest by construction: a provider may serve changed
      // weights behind an unchanged model name, so equality is a LOWER BOUND on
      // sameness and inequality does not prove independence. Until the contract
      // carries stronger identity evidence, no frontier/frontier pair can
      // establish an independent review relationship.
      return true;
    }

    // The only remaining same-class cases are digest-identified and returned
    // above. Keep this fail-closed if the source-class union grows without an
    // explicit identity rule.
    return true;
  } catch {
    return true;
  }
}
