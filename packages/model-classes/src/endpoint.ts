import type { Timestamp } from "@getsimpledirect/vinci-contracts";
import type { CustomerEndpointAuthenticationSource } from "./customer-endpoint.ts";
import type { EndpointCapability } from "./role.ts";
import type {
  ExplicitValue,
  ModelCapabilityProfile,
  ModelIdentifier,
  ModelProvider,
  ProcessingLocation,
} from "./vocabulary.ts";

export const ENDPOINT_SOURCE_CLASSES = [
  "frontier_api",
  "open_weight",
  "vinci_pretrained",
] as const;
/**
 * EndpointSourceClass describes artifact provenance: what the weights are and where they come from.
 * This is independent of who serves the endpoint (vinci-hosted vs third-party).
 * - frontier_api: proprietary model weights from Anthropic or other frontier provider
 * - open_weight: weights from open-source model release (e.g. GLM-5.2, DeepSeek)
 * - vinci_pretrained: Vinci's own first-party trained weights
 */
export type EndpointSourceClass = (typeof ENDPOINT_SOURCE_CLASSES)[number];

export const ENDPOINT_SERVING_KINDS = ["vinci_hosted", "third_party_api"] as const;
export type EndpointServingKind = (typeof ENDPOINT_SERVING_KINDS)[number];

/**
 * ServingDescriptor specifies where and how inference runs.
 * - vinci_hosted: served on Vinci-controlled infrastructure (inferenceIsExternal will be false)
 * - third_party_api: served by external provider (inferenceIsExternal will be true unless overridden)
 */
export type ServingDescriptor =
  | { readonly kind: "vinci_hosted" }
  | {
      readonly kind: "third_party_api";
      readonly provider: ModelProvider;
      readonly model: ModelIdentifier;
      readonly modelRevision: ExplicitValue<string>;
      readonly jurisdiction: ExplicitValue<ProcessingLocation>;
    };

export type EndpointRights = {
  readonly trainingAllowed: ExplicitValue<boolean>;
  readonly evaluationAllowed: ExplicitValue<boolean>;
  readonly redistributionAllowed: ExplicitValue<boolean>;
  readonly outputRetainedByProvider: ExplicitValue<boolean>;
  readonly policySnapshotDigest: ExplicitValue<string>;
};

type ModelEndpointCommon = {
  readonly schemaVersion: 1;
  readonly endpointId: string;
  readonly capabilityProfile: ModelCapabilityProfile;
  readonly declaredCapabilities: readonly EndpointCapability[];
  /** Strictly validated: unknown fields anywhere below this key are rejected. */
  readonly credentials: {
    readonly source: CustomerEndpointAuthenticationSource;
  };
  /**
   * Whether inference leaves Vinci-controlled infrastructure. Independent of
   * sourceClass — an open-weight model served through a third-party API is
   * external, and a frontier-family model served on Vinci hardware is not.
   * Deriving this from sourceClass would let an undeclared fact grant a
   * permission.
   */
  readonly inferenceIsExternal: ExplicitValue<boolean>;
  /** Has this endpoint been approved to process protected data? */
  readonly approvedForProtectedData: ExplicitValue<boolean>;
  readonly rights: EndpointRights;
  readonly validFrom: Timestamp;
  readonly expiresAt: Timestamp | null;
  readonly serving: ServingDescriptor;
};

/**
 * A `frontier_api` provider/model identity is observational only. Its separate
 * served-artifact declaration supplies the evidence used across identity
 * schemes.
 */
export type FrontierApiEndpoint = ModelEndpointCommon & {
  readonly sourceClass: "frontier_api";
  readonly servedArtifact: ExplicitValue<
    | { readonly kind: "digest"; readonly value: string }
    | { readonly kind: "proprietary" }
  >;
};

type DigestIdentifiedEndpoint = ModelEndpointCommon & {
  readonly weightsDigest: ExplicitValue<string>;
  readonly tokenizerDigest: ExplicitValue<string>;
  readonly architectureDigest: ExplicitValue<string>;
  readonly servingImageDigest: ExplicitValue<string>;
  readonly quantizationDigest: ExplicitValue<string>;
};

export type OpenWeightEndpoint = DigestIdentifiedEndpoint & {
  readonly sourceClass: "open_weight";
};

export type VinciPretrainedEndpoint = DigestIdentifiedEndpoint & {
  readonly sourceClass: "vinci_pretrained";
};

export type ModelEndpointSpec =
  | FrontierApiEndpoint
  | OpenWeightEndpoint
  | VinciPretrainedEndpoint;
