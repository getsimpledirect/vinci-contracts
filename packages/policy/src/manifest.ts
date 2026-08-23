import {
  CONSEQUENTIAL_ACTION_CLASSES,
  type ConsequentialActionClass,
  type PolicyId,
  type RunId,
  type Timestamp,
  type UserId,
} from "@vinci/contracts";

export const SYMLINK_HANDLING = ["deny", "allow_within_roots", "read_target_only"] as const;
export type SymlinkHandling = (typeof SYMLINK_HANDLING)[number];

export type ResourcePolicy = {
  readonly allowedKinds: readonly string[];
  readonly maximumCpuCores: number;
  readonly maximumMemoryBytes: number;
  readonly maximumStorageBytes: number;
};

export type FilesystemPolicy = {
  readonly readOnlyRoots: readonly string[];
  readonly writableRoots: readonly string[];
  readonly deniedRoots: readonly string[];
  readonly temporaryWorkspace: string;
  readonly protectedPaths: readonly string[];
  readonly maximumChangedFileCount: number;
  readonly maximumChangedByteVolume: number;
  readonly symlinkHandling: SymlinkHandling;
  readonly generatedArtifactPaths: readonly string[];
};

export const APPLICATION_DEFAULT_ACTIONS = ["deny"] as const;
export type ApplicationDefaultAction = (typeof APPLICATION_DEFAULT_ACTIONS)[number];

export type ApplicationPolicy = {
  /** An omitted application rule cannot silently become permission to launch it. */
  readonly defaultAction: ApplicationDefaultAction;
  readonly allowedApplications: readonly string[];
  readonly deniedApplications: readonly string[];
};

export const NETWORK_DEFAULT_ACTIONS = ["deny"] as const;
export type NetworkDefaultAction = (typeof NETWORK_DEFAULT_ACTIONS)[number];

export const NETWORK_PROTOCOLS = ["http", "https", "tcp", "udp"] as const;
export type NetworkProtocol = (typeof NETWORK_PROTOCOLS)[number];

export const DNS_POLICIES = ["deny", "system_resolver", "allowed_domains_only"] as const;
export type DnsPolicy = (typeof DNS_POLICIES)[number];

export const PRIVATE_NETWORK_ACCESS_POLICIES = ["deny", "allow_listed_ranges"] as const;
export type PrivateNetworkAccessPolicy = (typeof PRIVATE_NETWORK_ACCESS_POLICIES)[number];

export type NetworkPolicy = {
  /** Literal `deny` makes the baseline explicit; there is no unrestricted member to fall into. */
  readonly defaultAction: NetworkDefaultAction;
  readonly allowedDomains: readonly string[];
  readonly allowedIpRanges: readonly string[];
  readonly allowedProtocols: readonly NetworkProtocol[];
  readonly dnsPolicy: DnsPolicy;
  readonly maximumOutboundRequests: number;
  readonly privateNetworkAccess: PrivateNetworkAccessPolicy;
  readonly noNetwork: boolean;
};

/**
 * These names are deliberately forbidden even as optional properties. TypeScript
 * normally permits structurally wider values, which could otherwise let a token
 * hitch a ride on an object that is intended to contain reference metadata only.
 */
export type CredentialMaterialExclusions = {
  readonly secret?: never;
  readonly secretValue?: never;
  readonly value?: never;
  readonly token?: never;
  readonly accessToken?: never;
  readonly refreshToken?: never;
  readonly password?: never;
  readonly apiKey?: never;
  readonly privateKey?: never;
  readonly credential?: never;
  readonly credentialValue?: never;
  readonly material?: never;
};

export const CREDENTIAL_LIFETIMES = ["run_limited", "short_lived", "provider_managed"] as const;
export type CredentialLifetime = (typeof CREDENTIAL_LIFETIMES)[number];

export type CredentialBinding =
  | { readonly kind: "run"; readonly runId: RunId }
  | { readonly kind: "capability"; readonly capability: string };

type CredentialReferenceMetadata = CredentialMaterialExclusions & {
  /** Provider-side identifier only. It must be safe to display and revoke. */
  readonly credentialId: string;
  readonly issuer: string;
  readonly scopes: readonly string[];
  readonly revocable: true;
  readonly boundTo: CredentialBinding;
};

export type CredentialReference = CredentialReferenceMetadata &
  (
    | { readonly lifetime: "short_lived"; readonly expiresAt: Timestamp }
    | { readonly lifetime: "run_limited"; readonly expiresAt?: Timestamp }
    | { readonly lifetime: "provider_managed"; readonly expiresAt?: Timestamp }
  );

export type CredentialPolicy = CredentialMaterialExclusions & {
  readonly references: readonly CredentialReference[];
};

/**
 * Re-exported from @vinci/contracts rather than defined here. @vinci/approvals
 * needs the same vocabulary to describe a pending request without quoting free
 * text, and two copies of a list this specific would drift.
 */
export const EXTERNAL_SIDE_EFFECT_CLASSES = CONSEQUENTIAL_ACTION_CLASSES;
export type ExternalSideEffectClass = ConsequentialActionClass;

export type ExternalSideEffectRule = {
  readonly actionClass: ExternalSideEffectClass;
  /** Consequential actions may be made stricter, but never silently auto-approved. */
  readonly approval: "required" | "denied";
};

export type ExternalSideEffectsPolicy = {
  /** Covers a newly introduced class until a versioned manifest names it explicitly. */
  readonly defaultAction: "require_approval";
  readonly rules: readonly ExternalSideEffectRule[];
};

export type MoneyLimit = {
  readonly currency: string;
  /** Integer minor units avoid floating-point ambiguity at a policy boundary. */
  readonly minorUnits: number;
};

export type SpendPolicy = {
  readonly maximumSpend: MoneyLimit;
  readonly maximumVerificationCost: MoneyLimit;
};

export type RuntimePolicy = {
  readonly maximumActiveRuntimeSeconds: number;
  readonly maximumWallClockRuntimeSeconds: number;
  readonly maximumModelCalls: number;
  readonly maximumWorkerCount: number;
  readonly maximumExternalActions: number;
};

export type RetryPolicy = {
  readonly maximumRetries: number;
};

export type ApprovalRuleTarget =
  | { readonly kind: "any_action" }
  | { readonly kind: "capability"; readonly capability: string }
  | { readonly kind: "external_side_effect"; readonly actionClass: ExternalSideEffectClass };

export type ApprovalPrincipal =
  | { readonly kind: "named_person"; readonly userId: UserId }
  | { readonly kind: "role"; readonly role: string };

export type ApprovalRequirement =
  | ApprovalPrincipal
  | {
      readonly kind: "two_people";
      readonly eligible: { readonly kind: "any_user" } | { readonly kind: "role"; readonly role: string };
    };

export type ApprovalGrant =
  | { readonly kind: "once"; readonly expiresAfterSeconds: number }
  | { readonly kind: "remainder_of_run"; readonly expiresAfterSeconds: number }
  | {
      readonly kind: "bounded";
      readonly resource: string;
      readonly maximumDurationSeconds: number;
      readonly expiresAfterSeconds: number;
    };

export type ApprovalRuleDecision =
  | { readonly kind: "allow_automatically" }
  | { readonly kind: "deny" }
  | {
      readonly kind: "require_approval";
      readonly approver: ApprovalRequirement;
      readonly grant: ApprovalGrant;
    };

export type ApprovalRule = {
  /** Stable within one policy id and version; runtime approval records reference this id. */
  readonly id: string;
  readonly description: string;
  readonly appliesTo: ApprovalRuleTarget;
  readonly decision: ApprovalRuleDecision;
};

export type ApprovalPolicy = {
  readonly rules: readonly ApprovalRule[];
};

export type VerificationPolicy = {
  readonly required: boolean;
  readonly requirements: readonly string[];
  readonly independentVerifierRequired: boolean;
};

/** Matches the retention vocabulary already shipped by vinci-platform. */
export const RETENTION_CLASSES = ["zdr_0d", "days_7", "days_14", "days_30"] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

export type RetentionPolicy = {
  readonly class: RetentionClass;
};

export const POLICY_MANIFEST_SECTION_NAMES = [
  "resources",
  "filesystem",
  "applications",
  "network",
  "credentials",
  "external_side_effects",
  "spend",
  "runtime",
  "retries",
  "approvals",
  "verification",
  "retention",
] as const;
export type PolicyManifestSectionName = (typeof POLICY_MANIFEST_SECTION_NAMES)[number];

export type PolicyManifest = {
  readonly policyId: PolicyId;
  readonly version: number;
  readonly displayName: string;
  readonly resources: ResourcePolicy;
  readonly filesystem: FilesystemPolicy;
  readonly applications: ApplicationPolicy;
  /** Required so omission is malformed, never an implicit unrestricted policy. */
  readonly network: NetworkPolicy;
  readonly credentials: CredentialPolicy;
  readonly external_side_effects: ExternalSideEffectsPolicy;
  readonly spend: SpendPolicy;
  readonly runtime: RuntimePolicy;
  readonly retries: RetryPolicy;
  readonly approvals: ApprovalPolicy;
  readonly verification: VerificationPolicy;
  readonly retention: RetentionPolicy;
};
