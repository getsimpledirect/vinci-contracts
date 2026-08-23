import type { WorkspaceRef } from "@vinci/contracts";
import type {
  ExplicitValue,
  ModelCapabilityProfile,
  ModelIdentifier,
  ProcessingLocation,
} from "./vocabulary.ts";

/**
 * Both arms identify where authentication is obtained and intentionally have
 * no field capable of carrying credential material such as a token or API key.
 */
export type CustomerEndpointAuthenticationSource =
  | { readonly kind: "managed-credential"; readonly credentialId: string }
  | { readonly kind: "environment-variable"; readonly variableName: string };

export type CustomerEndpointConfig = {
  readonly schemaVersion: 1;
  readonly endpointId: string;
  readonly workspace: WorkspaceRef;
  readonly baseUrl: string;
  readonly modelIdentifier: ModelIdentifier;
  readonly capabilityProfile: ModelCapabilityProfile;
  readonly retentionDeclaration: ExplicitValue<string>;
  readonly jurisdiction: ExplicitValue<ProcessingLocation>;
  /** Strictly validated: unknown fields anywhere below this key are rejected. */
  readonly credentials: {
    readonly source: CustomerEndpointAuthenticationSource;
  };
};
