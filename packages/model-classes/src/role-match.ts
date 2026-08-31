import {
  isCanonicalTimestamp,
  isIdentifier,
  type Timestamp,
} from "@getsimpledirect/vinci-contracts";
import type { ModelEndpointSpec } from "./endpoint.ts";
import {
  REQUIRED_CAPABILITIES,
  ROLE_RISK_CLASSES,
  type ModelRoleSpec,
  type RequiredCapability,
} from "./role.ts";

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
  | "protected_data_approval_undeclared"
  | "input_not_evaluable";

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

type ExplicitBooleanSnapshot = {
  readonly kind: unknown;
  readonly value: unknown;
  readonly hasValue: boolean;
};

type ValidExplicitBooleanSnapshot =
  | { readonly kind: "unknown"; readonly value: undefined; readonly hasValue: false }
  | { readonly kind: "known"; readonly value: boolean; readonly hasValue: true };

/** More than this many declarations is hostile input, not a useful role. */
const MAX_CAPABILITY_DECLARATIONS = 100;

/** Snapshot a hostile-reachable ExplicitValue exactly once. */
function snapshotExplicitBoolean(value: unknown): ExplicitBooleanSnapshot | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    kind: record.kind,
    value: record.value,
    hasValue: Object.prototype.hasOwnProperty.call(record, "value"),
  };
}

function isExplicitBoolean(
  snapshot: ExplicitBooleanSnapshot | null,
): snapshot is ValidExplicitBooleanSnapshot {
  return snapshot !== null &&
    ((snapshot.kind === "unknown" && snapshot.value === undefined && !snapshot.hasValue) ||
      (snapshot.kind === "known" && typeof snapshot.value === "boolean" && snapshot.hasValue));
}

/** Snapshot and validate a hostile-reachable capability array without using its iterator. */
function snapshotCapabilities(value: unknown): readonly RequiredCapability[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const length = value.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CAPABILITY_DECLARATIONS) {
    return undefined;
  }

  const snapshot: RequiredCapability[] = [];
  for (let index = 0; index < length; index += 1) {
    const capability = value[index];
    if (
      typeof capability !== "string" ||
      !REQUIRED_CAPABILITIES.includes(capability as RequiredCapability)
    ) {
      return undefined;
    }
    snapshot.push(capability as RequiredCapability);
  }
  return snapshot;
}

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
  try {
    // DEFENSIVE VALIDATION PREAMBLE
    // Malformed input is not a permission grant, so it must resolve to unevaluable
    // rather than throwing or defaulting to eligible. Read each potentially-dangerous
    // field exactly once into a local to prevent hostile accessors from answering
    // differently on successive reads.

    if (typeof role !== "object" || role === null || Array.isArray(role)) {
      return {
        verdict: "unevaluable",
        roleId: "unknown",
        endpointId: "unknown",
        reasons: [{ code: "input_not_evaluable", detail: "role is not a plain object" }],
      };
    }

    if (typeof endpoint !== "object" || endpoint === null || Array.isArray(endpoint)) {
      return {
        verdict: "unevaluable",
        roleId: "unknown",
        endpointId: "unknown",
        reasons: [{ code: "input_not_evaluable", detail: "endpoint is not a plain object" }],
      };
    }

    // Check for suspicious own __proto__ property which indicates hostile input
    if (Object.prototype.hasOwnProperty.call(role, "__proto__")) {
      return {
        verdict: "unevaluable",
        roleId: "unknown",
        endpointId: "unknown",
        reasons: [{ code: "input_not_evaluable", detail: "role contains own __proto__ property" }],
      };
    }

    if (Object.prototype.hasOwnProperty.call(endpoint, "__proto__")) {
      return {
        verdict: "unevaluable",
        roleId: "unknown",
        endpointId: "unknown",
        reasons: [{ code: "input_not_evaluable", detail: "endpoint contains own __proto__ property" }],
      };
    }

    // Read all potentially-dangerous fields exactly once into locals
    const roleId = (role as Record<string, unknown>).roleId;
    const requiredCapabilities = (role as Record<string, unknown>).requiredCapabilities;
    const minimumContextTokens = (role as Record<string, unknown>).minimumContextTokens;
    const riskClass = (role as Record<string, unknown>).riskClass;
    const dataPolicy = (role as Record<string, unknown>).dataPolicy;

    const endpointId = (endpoint as Record<string, unknown>).endpointId;
    const declaredCapabilities = (endpoint as Record<string, unknown>).declaredCapabilities;
    const capabilityProfile = (endpoint as Record<string, unknown>).capabilityProfile;
    const inferenceIsExternal = (endpoint as Record<string, unknown>).inferenceIsExternal;
    const approvedForProtectedData = (endpoint as Record<string, unknown>)
      .approvedForProtectedData;
    const endpointRights = (endpoint as Record<string, unknown>).rights;
    const expiresAt = (endpoint as Record<string, unknown>).expiresAt;
    const validFrom = (endpoint as Record<string, unknown>).validFrom;

    // Validate roleId and endpointId are strings
    if (!isIdentifier(roleId) || !isIdentifier(endpointId)) {
      return {
        verdict: "unevaluable",
        roleId: isIdentifier(roleId) ? roleId : "unknown",
        endpointId: isIdentifier(endpointId) ? endpointId : "unknown",
        reasons: [
          { code: "input_not_evaluable", detail: "roleId and endpointId must be identifiers" },
        ],
      };
    }

    // Validate role structure
    const requiredCapabilitySnapshot = snapshotCapabilities(requiredCapabilities);
    if (requiredCapabilitySnapshot === undefined) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [
          {
            code: "input_not_evaluable",
            detail: "role.requiredCapabilities is not a bounded array of known capabilities",
          },
        ],
      };
    }

    if (
      typeof minimumContextTokens !== "number" ||
      !Number.isSafeInteger(minimumContextTokens) ||
      minimumContextTokens <= 0
    ) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [
          {
            code: "input_not_evaluable",
            detail: "role.minimumContextTokens is not a positive safe integer",
          },
        ],
      };
    }

    if (
      typeof riskClass !== "string" ||
      !ROLE_RISK_CLASSES.includes(riskClass as (typeof ROLE_RISK_CLASSES)[number])
    ) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [{ code: "input_not_evaluable", detail: "role.riskClass is not recognized" }],
      };
    }

    if (typeof dataPolicy !== "object" || dataPolicy === null) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [{ code: "input_not_evaluable", detail: "role.dataPolicy is not an object" }],
      };
    }

    const dataPolicyObj = dataPolicy as Record<string, unknown>;
    const externalProviderAllowed = dataPolicyObj.externalProviderAllowed;
    const outputRetentionAllowed = dataPolicyObj.outputRetentionAllowed;
    const processesProtectedData = dataPolicyObj.processesProtectedData;
    if (
      typeof externalProviderAllowed !== "boolean" ||
      typeof outputRetentionAllowed !== "boolean" ||
      typeof processesProtectedData !== "boolean"
    ) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [
          {
            code: "input_not_evaluable",
            detail: "role.dataPolicy fields are not all boolean",
          },
        ],
      };
    }

    // Validate endpoint structure
    const declaredCapabilitySnapshot = snapshotCapabilities(declaredCapabilities);
    if (declaredCapabilitySnapshot === undefined) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [
          {
            code: "input_not_evaluable",
            detail: "endpoint.declaredCapabilities is not a bounded array of known capabilities",
          },
        ],
      };
    }

    if (typeof capabilityProfile !== "object" || capabilityProfile === null) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [
          {
            code: "input_not_evaluable",
            detail: "endpoint.capabilityProfile is not an object",
          },
        ],
      };
    }

    const capProfileObj = capabilityProfile as Record<string, unknown>;
    const contextLimit = capProfileObj.contextLimit;
    if (
      typeof contextLimit !== "number" ||
      !Number.isSafeInteger(contextLimit) ||
      contextLimit <= 0
    ) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [
          {
            code: "input_not_evaluable",
            detail: "endpoint.capabilityProfile.contextLimit is not a positive safe integer",
          },
        ],
      };
    }

    // Validate ExplicitValue structures
    const external = snapshotExplicitBoolean(inferenceIsExternal);
    if (!isExplicitBoolean(external)) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [
          {
            code: "input_not_evaluable",
            detail: "endpoint.inferenceIsExternal is not a valid ExplicitValue",
          },
        ],
      };
    }

    const approval = snapshotExplicitBoolean(approvedForProtectedData);
    if (!isExplicitBoolean(approval)) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [
          {
            code: "input_not_evaluable",
            detail: "endpoint.approvedForProtectedData is not a valid ExplicitValue",
          },
        ],
      };
    }

    // Validate rights object
    if (typeof endpointRights !== "object" || endpointRights === null) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [{ code: "input_not_evaluable", detail: "endpoint.rights is not an object" }],
      };
    }

    const rightsObj = endpointRights as Record<string, unknown>;
    const rights = {
      trainingAllowed: snapshotExplicitBoolean(rightsObj.trainingAllowed),
      evaluationAllowed: snapshotExplicitBoolean(rightsObj.evaluationAllowed),
      outputRetainedByProvider: snapshotExplicitBoolean(rightsObj.outputRetainedByProvider),
    } as const;
    for (const [rightName, right] of Object.entries(rights)) {
      if (!isExplicitBoolean(right)) {
        return {
          verdict: "unevaluable",
          roleId,
          endpointId,
          reasons: [
            {
              code: "input_not_evaluable",
              detail: `endpoint.rights.${rightName} is not a valid ExplicitValue`,
            },
          ],
        };
      }
    }
    // The loop above validates every entry in this fixed record. These aliases
    // keep the captured values, rather than re-reading the caller's getters.
    const trainingAllowed = rights.trainingAllowed as ValidExplicitBooleanSnapshot;
    const evaluationAllowed = rights.evaluationAllowed as ValidExplicitBooleanSnapshot;
    const outputRetainedByProvider = rights.outputRetainedByProvider as ValidExplicitBooleanSnapshot;

    // Validate timestamps
    if (!isCanonicalTimestamp(validFrom)) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [
          { code: "input_not_evaluable", detail: "endpoint.validFrom is not canonical" },
        ],
      };
    }

    if (expiresAt !== null && !isCanonicalTimestamp(expiresAt)) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [
          {
            code: "input_not_evaluable",
            detail: "endpoint.expiresAt must be a canonical timestamp or null",
          },
        ],
      };
    }

    if (!isCanonicalTimestamp(now)) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [{ code: "input_not_evaluable", detail: "now is not a canonical timestamp" }],
      };
    }

    // All validations passed; proceed with the snapshotted values.
    const classified: ClassifiedReason[] = [];
    const declared = new Set(declaredCapabilitySnapshot);

    for (const capability of requiredCapabilitySnapshot) {
      if (!declared.has(capability)) classified.push(missingCapability(capability));
    }

    if (
      contextLimit <
      (minimumContextTokens as number)
    ) {
      classified.push({
        code: "context_too_small",
        detail: `endpoint context limit ${contextLimit} is below required ${minimumContextTokens}`,
        hardNo: true,
      });
    }

    if (!externalProviderAllowed) {
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

    if (!outputRetentionAllowed) {
      const retention = outputRetainedByProvider;
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

    if (processesProtectedData) {
      if (approval.kind === "unknown") {
        classified.push({
          code: "protected_data_approval_undeclared",
          detail: "endpoint did not declare whether it may process protected data",
          hardNo: false,
        });
      } else if (!approval.value) {
        classified.push({
          code: "protected_data_not_approved",
          detail: "endpoint is not approved to process protected data",
          hardNo: true,
        });
      }
    }

    if (riskClass === "high") {
      for (const [rightName, right] of [
        ["trainingAllowed", trainingAllowed],
        ["evaluationAllowed", evaluationAllowed],
      ] as const) {
        if (right.kind === "unknown") {
          classified.push({
            code: "rights_undeclared",
            detail: `high-risk role requires ${rightName} to be declared`,
            hardNo: false,
          });
        } else if (!right.value) {
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

    if (expiresAt !== null && (expiresAt as string) < (now as string)) {
      classified.push({
        code: "endpoint_expired",
        detail: `endpoint expired at ${expiresAt}`,
        hardNo: true,
      });
    }
    if ((validFrom as string) > (now as string)) {
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
      roleId,
      endpointId,
      reasons: classified.map(({ code, detail }) => ({ code, detail })),
    };
  } catch {
    // Any uncaught error from a hostile input must be converted to unevaluable
    return {
      verdict: "unevaluable",
      roleId: "unknown",
      endpointId: "unknown",
      reasons: [{ code: "input_not_evaluable", detail: "input processing threw an error" }],
    };
  }
}
