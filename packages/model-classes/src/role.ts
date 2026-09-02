export const ROLE_RISK_CLASSES = ["low", "medium", "high"] as const;
export type RoleRiskClass = (typeof ROLE_RISK_CLASSES)[number];

/**
 * Endpoint capabilities are properties of the served model reachable over an API.
 * These capabilities describe what the inference endpoint itself can do.
 */
export const ENDPOINT_CAPABILITIES = [
  "structured_tool_use",
  "vision",
  "audio",
] as const;
export type EndpointCapability = (typeof ENDPOINT_CAPABILITIES)[number];

/**
 * Harness capabilities are properties of the calling system that invokes the model.
 * These capabilities describe what the harness/framework can provide (e.g., edit files,
 * construct citations). They are NOT properties of the endpoint itself and cannot be
 * evaluated by matchEndpointToRole.
 */
export const HARNESS_CAPABILITIES = [
  "repository_editing",
  "long_horizon_recovery",
  "evidence_citation",
] as const;
export type HarnessCapability = (typeof HARNESS_CAPABILITIES)[number];

/**
 * All capability names across both endpoint and harness domains.
 * This is kept for backward compatibility with role-match.ts validation.
 * @deprecated Use EndpointCapability or HarnessCapability instead.
 */
export const REQUIRED_CAPABILITIES = [
  ...ENDPOINT_CAPABILITIES,
  ...HARNESS_CAPABILITIES,
] as const;
export type RequiredCapability = (typeof REQUIRED_CAPABILITIES)[number];

export type ModelRoleDataPolicy = {
  readonly externalProviderAllowed: boolean;
  readonly outputRetentionAllowed: boolean;
  /** Does this role's work involve protected data? */
  readonly processesProtectedData: boolean;
};

export type ModelRoleQualityPolicy = {
  /** Inclusive rate in the range 0..1. */
  readonly minimumVerifiedSuccessRate: number;
  /** Inclusive rate in the range 0..1. */
  readonly maximumFalseClaimRate: number;
};

export type ModelRoleEconomicPolicy = {
  readonly maximumCostPerVerifiedSuccessUsd: number;
  readonly maximumP95WallSeconds: number;
};

/** An institution's model requirements, independent of any concrete supplier. */
export type ModelRoleSpec = {
  readonly schemaVersion: 1;
  readonly roleId: string;
  readonly taskClass: string;
  /**
   * Endpoint capabilities required by this role. These are properties of the served model
   * that matchEndpointToRole will validate against the endpoint's declaredCapabilities.
   */
  readonly requiredCapabilities: readonly EndpointCapability[];
  /**
   * Harness capabilities required by this role. These are properties of the calling system
   * and are deliberately NOT evaluated by matchEndpointToRole. A harness must ensure these
   * capabilities are available separately; the endpoint matcher cannot provide them.
   * This field is defined for documentation and policy purposes only.
   */
  readonly requiredHarnessCapabilities: readonly HarnessCapability[];
  readonly minimumContextTokens: number;
  readonly riskClass: RoleRiskClass;
  readonly dataPolicy: ModelRoleDataPolicy;
  /** Ranking thresholds for router selection; not eligibility preconditions evaluated by matchEndpointToRole. */
  readonly qualityPolicy: ModelRoleQualityPolicy;
  /** Ranking thresholds for router selection; not eligibility preconditions evaluated by matchEndpointToRole. */
  readonly economicPolicy: ModelRoleEconomicPolicy;
  readonly fallbackRoleIds: readonly string[];
};
