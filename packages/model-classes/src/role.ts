export const ROLE_RISK_CLASSES = ["low", "medium", "high"] as const;
export type RoleRiskClass = (typeof ROLE_RISK_CLASSES)[number];

export const REQUIRED_CAPABILITIES = [
  "structured_tool_use",
  "repository_editing",
  "long_horizon_recovery",
  "evidence_citation",
  "vision",
  "audio",
] as const;
export type RequiredCapability = (typeof REQUIRED_CAPABILITIES)[number];

export type ModelRoleDataPolicy = {
  readonly externalProviderAllowed: boolean;
  readonly outputRetentionAllowed: boolean;
  readonly protectedDataAllowed: boolean;
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
  readonly requiredCapabilities: readonly RequiredCapability[];
  readonly minimumContextTokens: number;
  readonly riskClass: RoleRiskClass;
  readonly dataPolicy: ModelRoleDataPolicy;
  readonly qualityPolicy: ModelRoleQualityPolicy;
  readonly economicPolicy: ModelRoleEconomicPolicy;
  readonly fallbackRoleIds: readonly string[];
};
