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
export function violatesIndependence(
  producer: ModelEndpointSpec,
  reviewer: ModelEndpointSpec,
): boolean {
  try {
    // THE RULE: this may only answer "independent" when BOTH identities are
    // legible. An absent identity is not a different identity. Every earlier
    // shape of this function compared fields that were `undefined` on a hostile
    // argument, found them unequal to a real digest, and concluded independence
    // -- authorising a review on the strength of a value nobody supplied. That
    // is the fail-open this whole package exists to prevent, and returning
    // `false` here is what grants the permission.
    if (!isLegibleEndpoint(producer) || !isLegibleEndpoint(reviewer)) return true;

    // Read each field exactly once: an accessor that answers differently on a
    // second read is one of the probed hostile shapes.
    const producerId = producer.endpointId;
    const reviewerId = reviewer.endpointId;
    const producerSourceClass = producer.sourceClass;
    const reviewerSourceClass = reviewer.sourceClass;

    if (producerId === reviewerId) return true;

    // Both source classes are already proven legible by isLegibleEndpoint, so
    // they are real enum members rather than absent fields. Two DIFFERENT ones
    // cannot name the same artifact -- a frontier API model and a pod-served
    // open-weight model are different models -- so this establishes
    // independence rather than blocking it. This is safe only because
    // legibility was checked first; on an unchecked argument the same
    // comparison would read `undefined !== "open_weight"` and grant.
    if (producerSourceClass !== reviewerSourceClass) return false;

    if (producerSourceClass === "frontier_api") {
      const producerProvider = (producer as { provider?: unknown }).provider;
      const reviewerProvider = (reviewer as { provider?: unknown }).provider;
      const producerModel = (producer as { model?: unknown }).model;
      const reviewerModel = (reviewer as { model?: unknown }).model;
      if (
        typeof producerProvider !== "string" || typeof reviewerProvider !== "string" ||
        typeof producerModel !== "string" || typeof reviewerModel !== "string"
      ) return true;
      // Weaker than a digest by construction: one provider may serve changed
      // weights behind an unchanged model name, so equality here is a LOWER
      // BOUND on sameness and inequality does not prove independence.
      return producerProvider === reviewerProvider && producerModel === reviewerModel;
    }

    const producerWeights = (producer as { weightsDigest?: unknown }).weightsDigest;
    const reviewerWeights = (reviewer as { weightsDigest?: unknown }).weightsDigest;
    if (typeof producerWeights !== "string" || typeof reviewerWeights !== "string") return true;
    return producerWeights === reviewerWeights;
  } catch {
    return true;
  }
}

/**
 * An endpoint is legible when the fields identity depends on can actually be
 * read as the types they claim. Anything else -- a null-prototype object, an
 * array, a proxy, a record missing sourceClass -- is refused rather than
 * compared, because comparing absent fields silently succeeds.
 */
function isLegibleEndpoint(value: unknown): value is ModelEndpointSpec {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as { endpointId?: unknown; sourceClass?: unknown };
  if (typeof record.endpointId !== "string" || record.endpointId.length === 0) return false;
  return (
    record.sourceClass === "frontier_api" ||
    record.sourceClass === "open_weight" ||
    record.sourceClass === "vinci_pretrained"
  );
}
