import type { Timestamp } from "@getsimpledirect/vinci-contracts";
import type { ModelEndpointSpec } from "./endpoint.ts";
import type { ModelRoleSpec, RequiredCapability } from "./role.ts";

export const MATCH_VERDICTS = ["eligible", "ineligible", "unevaluable"] as const;
export type MatchVerdict = (typeof MATCH_VERDICTS)[number];

export type MatchReasonCode =
  | "capability_missing"
  | "context_too_small"
  | "external_provider_forbidden"
  | "external_provider_undeclared"
  | "retention_forbidden"
  | "training_rights_required"
  | "endpoint_expired"
  | "endpoint_not_yet_valid"
  | "rights_undeclared"
  | "retention_undeclared";

export type MatchReason = {
  readonly code: MatchReasonCode;
  readonly detail: string;
};

export type MatchResult = {
  readonly verdict: MatchVerdict;
  readonly roleId: string;
  readonly endpointId: string;
  readonly reasons: readonly MatchReason[];
};

type ClassifiedReason = MatchReason & { readonly hardNo: boolean };

function missingCapability(capability: RequiredCapability): ClassifiedReason {
  return {
    code: "capability_missing",
    detail: `endpoint did not declare required capability: ${capability}`,
    hardNo: true,
  };
}

/**
 * Applies policy as three-valued logic. Unknown declarations never become an
 * implicit yes, and any hard no outranks otherwise unevaluable conditions.
 */
export function matchEndpointToRole(
  role: ModelRoleSpec,
  endpoint: ModelEndpointSpec,
  now: Timestamp,
): MatchResult {
  const classified: ClassifiedReason[] = [];
  const declared = new Set(endpoint.declaredCapabilities);

  for (const capability of role.requiredCapabilities) {
    if (!declared.has(capability)) classified.push(missingCapability(capability));
  }

  if (endpoint.capabilityProfile.contextLimit < role.minimumContextTokens) {
    classified.push({
      code: "context_too_small",
      detail: `endpoint context limit ${endpoint.capabilityProfile.contextLimit} is below required ${role.minimumContextTokens}`,
      hardNo: true,
    });
  }

  if (!role.dataPolicy.externalProviderAllowed) {
    const external = endpoint.inferenceIsExternal;
    if (external.kind === "unknown") {
      classified.push({
        code: "external_provider_undeclared",
        detail: "endpoint did not declare whether inference is external",
        hardNo: false,
      });
    } else if (external.value) {
      classified.push({
        code: "external_provider_forbidden",
        detail: "role policy forbids an external inference provider",
        hardNo: true,
      });
    }
  }

  if (!role.dataPolicy.outputRetentionAllowed) {
    const retention = endpoint.rights.outputRetainedByProvider;
    if (retention.kind === "unknown") {
      classified.push({
        code: "retention_undeclared",
        detail: "endpoint did not declare retention policy",
        hardNo: false,
      });
    } else if (retention.value) {
      classified.push({
        code: "retention_forbidden",
        detail: "endpoint retains output but role policy forbids retention",
        hardNo: true,
      });
    }
  }

  if (role.riskClass === "high") {
    for (const [rightName, right] of [
      ["trainingAllowed", endpoint.rights.trainingAllowed],
      ["evaluationAllowed", endpoint.rights.evaluationAllowed],
    ] as const) {
      if (right.kind === "unknown") {
        classified.push({
          code: "rights_undeclared",
          detail: `high-risk role requires ${rightName} to be declared`,
          hardNo: false,
        });
      } else if (!right.value) {
        classified.push({
          code: "training_rights_required",
          detail: `high-risk role requires ${rightName}`,
          hardNo: true,
        });
      }
    }
  }

  if (endpoint.expiresAt !== null && endpoint.expiresAt < now) {
    classified.push({
      code: "endpoint_expired",
      detail: `endpoint expired at ${endpoint.expiresAt}`,
      hardNo: true,
    });
  }
  if (endpoint.validFrom > now) {
    classified.push({
      code: "endpoint_not_yet_valid",
      detail: `endpoint is not valid until ${endpoint.validFrom}`,
      hardNo: true,
    });
  }

  const verdict: MatchVerdict = classified.some(({ hardNo }) => hardNo)
    ? "ineligible"
    : classified.length > 0
      ? "unevaluable"
      : "eligible";

  return {
    verdict,
    roleId: role.roleId,
    endpointId: endpoint.endpointId,
    reasons: classified.map(({ code, detail }) => ({ code, detail })),
  };
}
