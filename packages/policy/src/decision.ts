import type { Actor, PolicyId } from "@getsimpledirect/vinci-contracts";

export type PolicyReference = {
  readonly policyId: PolicyId;
  readonly version: number;
};

export type PolicyActionRequest = {
  readonly action: string;
  readonly description: string;
  readonly target?: string;
  readonly requestedBy: Actor;
};

export const POLICY_ALLOWED_REASON_CODES = ["automatic_allow", "approval_satisfied"] as const;
export type PolicyAllowedReasonCode = (typeof POLICY_ALLOWED_REASON_CODES)[number];

export const POLICY_DENIED_REASON_CODES = [
  "explicit_deny",
  "approval_required",
  "resource_limit_exceeded",
  "filesystem_denied",
  "network_denied",
  "credential_unavailable",
  "side_effect_requires_approval",
  "spend_limit_exceeded",
  "runtime_limit_exceeded",
  "retry_limit_exceeded",
  "verification_required",
] as const;
export type PolicyDeniedReasonCode = (typeof POLICY_DENIED_REASON_CODES)[number];

export const POLICY_UNDETERMINED_REASON_CODES = [
  "malformed_policy",
  "unsupported_policy_version",
  "unknown_action",
  "missing_context",
  "conflicting_rules",
  "evaluator_error",
] as const;
export type PolicyUndeterminedReasonCode = (typeof POLICY_UNDETERMINED_REASON_CODES)[number];

export const POLICY_DECISION_REASON_CODES = [
  ...POLICY_ALLOWED_REASON_CODES,
  ...POLICY_DENIED_REASON_CODES,
  ...POLICY_UNDETERMINED_REASON_CODES,
] as const;
export type PolicyDecisionReasonCode = (typeof POLICY_DECISION_REASON_CODES)[number];

export type PolicyDecisionReason<C extends PolicyDecisionReasonCode = PolicyDecisionReasonCode> = {
  readonly code: C;
  readonly explanation: string;
};

export const POLICY_DECISION_OPTION_KINDS = [
  "request_approval",
  "change_request",
  "request_policy_change",
  "retry_with_context",
  "contact_policy_owner",
  "no_action_available",
] as const;
export type PolicyDecisionOptionKind = (typeof POLICY_DECISION_OPTION_KINDS)[number];

export type PolicyDecisionOption = {
  readonly kind: PolicyDecisionOptionKind;
  readonly description: string;
};

type NonProceedingDecision<O extends "denied" | "undetermined", C extends PolicyDecisionReasonCode> = {
  readonly outcome: O;
  /** These four fields are intentionally repeated on both fail-closed outcomes. */
  readonly request: PolicyActionRequest;
  readonly reason: PolicyDecisionReason<C>;
  readonly controllingPolicy: PolicyReference;
  /** Non-empty so a UI cannot satisfy the contract with an omitted explanation of next steps. */
  readonly availableOptions: readonly [PolicyDecisionOption, ...PolicyDecisionOption[]];
};

export type PolicyDecision =
  | {
      readonly outcome: "allowed";
      readonly request: PolicyActionRequest;
      readonly reason: PolicyDecisionReason<PolicyAllowedReasonCode>;
      readonly controllingPolicy: PolicyReference;
    }
  | NonProceedingDecision<"denied", PolicyDeniedReasonCode>
  | NonProceedingDecision<"undetermined", PolicyUndeterminedReasonCode>;
