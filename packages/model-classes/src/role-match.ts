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
  | "evaluation_rights_required"
  | "endpoint_expired"
  | "endpoint_not_yet_valid"
  | "rights_undeclared"
  | "retention_undeclared"
  | "protected_data_not_approved"
  | "protected_data_approval_undeclared";

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
 * qualityPolicy and economicPolicy are ranking thresholds applied by a router
 * against measured performance, not eligibility preconditions, and are
 * deliberately not read here.
 */
export function matchEndpointToRole(
  role: ModelRoleSpec,
  endpoint: ModelEndpointSpec,
  now: Timestamp,
): MatchResult {
  // Fail closed if the input shapes can't be read safely
  try {
    // Validate role shape early
    if (typeof role !== "object" || role === null) {
      return {
        verdict: "ineligible",
        roleId: "unknown",
        endpointId: "unknown",
        reasons: [],
      };
    }
    
    const roleId = role.roleId;
    const minimumContextTokens = role.minimumContextTokens;
    const dataPolicy = role.dataPolicy;
    const riskClass = role.riskClass;
    const requiredCapabilities = role.requiredCapabilities;
    
    // Validate endpoint shape early
    if (typeof endpoint !== "object" || endpoint === null) {
      return {
        verdict: "ineligible",
        roleId: typeof roleId === "string" ? roleId : "unknown",
        endpointId: "unknown",
        reasons: [],
      };
    }
    
    const endpointId = endpoint.endpointId;
    const declaredCapabilities = endpoint.declaredCapabilities;
    
    // Check that declaredCapabilities is an array early
    if (!Array.isArray(declaredCapabilities)) {
      return {
        verdict: "unevaluable",
        roleId: typeof roleId === "string" ? roleId : "unknown",
        endpointId: typeof endpointId === "string" ? endpointId : "unknown",
        reasons: [],
      };
    }
    const capabilityProfile = endpoint.capabilityProfile;
    const inferenceIsExternal = endpoint.inferenceIsExternal;
    const rights = endpoint.rights;
    const approvedForProtectedData = endpoint.approvedForProtectedData;
    const expiresAt = endpoint.expiresAt;
    const validFrom = endpoint.validFrom;
    
    // Now proceed with the validation logic, knowing these reads succeeded once
    const classified: ClassifiedReason[] = [];
    const declared = new Set(declaredCapabilities);

    if (Array.isArray(requiredCapabilities)) {
      for (const capability of requiredCapabilities) {
        if (!declared.has(capability)) classified.push(missingCapability(capability));
      }
    } else {
      // requiredCapabilities is not iterable; this is a shape error
      return {
        verdict: "unevaluable",
        roleId: typeof roleId === "string" ? roleId : "unknown",
        endpointId: typeof endpointId === "string" ? endpointId : "unknown",
        reasons: [],
      };
    }

    if (typeof minimumContextTokens === "number" && typeof capabilityProfile?.contextLimit === "number" && capabilityProfile.contextLimit < minimumContextTokens) {
      classified.push({
        code: "context_too_small",
        detail: `endpoint context limit ${capabilityProfile.contextLimit} is below required ${minimumContextTokens}`,
        hardNo: true,
      });
    }

    if (dataPolicy && !dataPolicy.externalProviderAllowed) {
      const external = inferenceIsExternal;
      if (external?.kind === "unknown") {
        classified.push({
          code: "external_provider_undeclared",
          detail: "endpoint did not declare whether inference is external",
          hardNo: false,
        });
      } else if (external?.value) {
        classified.push({
          code: "external_provider_forbidden",
          detail: "role policy forbids an external inference provider",
          hardNo: true,
        });
      }
    }

    if (dataPolicy && !dataPolicy.outputRetentionAllowed) {
      const retention = rights?.outputRetainedByProvider;
      if (retention?.kind === "unknown") {
        classified.push({
          code: "retention_undeclared",
          detail: "endpoint did not declare retention policy",
          hardNo: false,
        });
      } else if (retention?.value) {
        classified.push({
          code: "retention_forbidden",
          detail: "endpoint retains output but role policy forbids retention",
          hardNo: true,
        });
      }
    }

    if (dataPolicy && dataPolicy.processesProtectedData) {
      const approval = approvedForProtectedData;
      if (approval?.kind === "unknown") {
        classified.push({
          code: "protected_data_approval_undeclared",
          detail: "endpoint did not declare whether it may process protected data",
          hardNo: false,
        });
      } else if (!approval?.value) {
        classified.push({
          code: "protected_data_not_approved",
          detail: "endpoint is not approved to process protected data",
          hardNo: true,
        });
      }
    }

    if (riskClass === "high") {
      for (const [rightName, right] of [
        ["trainingAllowed", rights?.trainingAllowed],
        ["evaluationAllowed", rights?.evaluationAllowed],
      ] as const) {
        if (right?.kind === "unknown") {
          classified.push({
            code: "rights_undeclared",
            detail: `high-risk role requires ${rightName} to be declared`,
            hardNo: false,
          });
        } else if (!right?.value) {
          classified.push({
            code:
              rightName === "evaluationAllowed"
                ? "evaluation_rights_required"
                : "training_rights_required",
            detail: `high-risk role requires ${rightName}`,
            hardNo: true,
          });
        }
      }
    }

    if (expiresAt !== null && typeof expiresAt === "string" && typeof now === "string" && expiresAt < now) {
      classified.push({
        code: "endpoint_expired",
        detail: `endpoint expired at ${expiresAt}`,
        hardNo: true,
      });
    }
    if (typeof validFrom === "string" && typeof now === "string" && validFrom > now) {
      classified.push({
        code: "endpoint_not_yet_valid",
        detail: `endpoint is not valid until ${validFrom}`,
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
      roleId: typeof roleId === "string" ? roleId : "unknown",
      endpointId: typeof endpointId === "string" ? endpointId : "unknown",
      reasons: classified.map(({ code, detail }) => ({ code, detail })),
    };
  } catch {
    // Any unexpected error: fail closed
    return {
      verdict: "ineligible",
      roleId: "unknown",
      endpointId: "unknown",
      reasons: [],
    };
  }
}
