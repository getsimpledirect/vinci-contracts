import type { Actor, RunId, Timestamp } from "@getsimpledirect/vinci-contracts";
import type { MaterialFallbackDisclosure } from "./fallback.ts";
import type {
  ExplicitValue,
  ModelCapabilityProfile,
  ModelClassId,
  ModelIdentifier,
  ModelProvider,
  ModelReasoningMode,
} from "./vocabulary.ts";

/** This shape intentionally matches the RequestedModel already shipped by vinci-code. */
export type RequestedModel = {
  readonly provider: ModelProvider;
  readonly model: ModelIdentifier;
};

export type ModelRequest =
  | { readonly kind: "model-class"; readonly modelClass: ModelClassId }
  | { readonly kind: "model"; readonly requestedModel: RequestedModel };

export const RESOLUTION_EVIDENCE = [
  "gateway-header",
  "response-stream",
  "requested-model",
] as const;
export type ResolutionEvidence = (typeof RESOLUTION_EVIDENCE)[number];

/**
 * The provider is present in addition to vinci-code's resolved model. This is
 * the intentional FR-8.4 gap closure: model name alone cannot establish who
 * processed the request.
 */
export type ResolvedRoute = {
  readonly provider: ExplicitValue<ModelProvider>;
  readonly model: ExplicitValue<ModelIdentifier>;
  readonly modelVersion: ExplicitValue<string>;
  readonly evidence: ResolutionEvidence;
};

type ProvenanceCommon = {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly recordedAt: Timestamp;
  readonly recordedBy: Actor;
  readonly request: ModelRequest;
  readonly materialFallback: MaterialFallbackDisclosure;
  readonly reasoningMode: ExplicitValue<ModelReasoningMode>;
  readonly capabilityProfile: ExplicitValue<ModelCapabilityProfile>;
};

/**
 * Event names and progression match vinci-code's shipping provenance record:
 * selection, observed resolution, and later drift from a prior route.
 */
export type ModelProvenanceRecord =
  | (ProvenanceCommon & { readonly event: "selected" })
  | (ProvenanceCommon & { readonly event: "resolved"; readonly route: ResolvedRoute })
  | (ProvenanceCommon & {
      readonly event: "drift";
      readonly previousRoute: ResolvedRoute;
      readonly observedRoute: ResolvedRoute;
    });
