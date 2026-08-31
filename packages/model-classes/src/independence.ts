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
    // Fail closed (return true = not independent) on any shape errors
    if (typeof producer !== "object" || producer === null || typeof reviewer !== "object" || reviewer === null) {
      return true; // Not independent; refuse the review
    }
    
    // Read each field exactly once
    const producerId = producer.endpointId;
    const reviewerId = reviewer.endpointId;
    const producerSourceClass = producer.sourceClass;
    const reviewerSourceClass = reviewer.sourceClass;
    
    if (producerId === reviewerId && typeof producerId === "string") return true;

    // Handle frontier_api comparison
    if (
      producerSourceClass === "frontier_api" &&
      reviewerSourceClass === "frontier_api"
    ) {
      const producerProvider = (producer as { provider?: string }).provider;
      const reviewerProvider = (reviewer as { provider?: string }).provider;
      const producerModel = (producer as { model?: unknown }).model;
      const reviewerModel = (reviewer as { model?: unknown }).model;
      return producerProvider === reviewerProvider && producerModel === reviewerModel;
    }

    // Handle open-weight comparison (both must be non-frontier_api)
    if (
      producerSourceClass !== "frontier_api" &&
      reviewerSourceClass !== "frontier_api"
    ) {
      const producerWeights = (producer as { weightsDigest?: string }).weightsDigest;
      const reviewerWeights = (reviewer as { weightsDigest?: string }).weightsDigest;
      return producerWeights === reviewerWeights;
    }

    return false;
  } catch {
    // Fail closed: if we can't read the fields safely, assume not independent
    return true;
  }
}
