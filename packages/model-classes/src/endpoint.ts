import type { Timestamp } from "@getsimpledirect/vinci-contracts";
import type { CustomerEndpointAuthenticationSource } from "./customer-endpoint.ts";
import type { RequiredCapability } from "./role.ts";
import type {
  ExplicitValue,
  ModelCapabilityProfile,
  ModelIdentifier,
  ProcessingLocation,
} from "./vocabulary.ts";

export const ENDPOINT_SOURCE_CLASSES = [
  "frontier_api",
  "open_weight",
  "vinci_pretrained",
] as const;
export type EndpointSourceClass = (typeof ENDPOINT_SOURCE_CLASSES)[number];

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
  readonly declaredCapabilities: readonly RequiredCapability[];
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
  readonly rights: EndpointRights;
  readonly validFrom: Timestamp;
  readonly expiresAt: Timestamp | null;
};

/**
 * `frontier_api` identity is OBSERVATIONAL only; never treat it as equally
 * strong as the cryptographic digests carried by locally identified endpoints.
 */
export type FrontierApiEndpoint = ModelEndpointCommon & {
  readonly sourceClass: "frontier_api";
  readonly provider: string;
  readonly model: ModelIdentifier;
  readonly modelRevision: ExplicitValue<string>;
  readonly jurisdiction: ExplicitValue<ProcessingLocation>;
};

type DigestIdentifiedEndpoint = ModelEndpointCommon & {
  readonly weightsDigest: string;
  readonly tokenizerDigest: string;
  readonly architectureDigest: string;
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
