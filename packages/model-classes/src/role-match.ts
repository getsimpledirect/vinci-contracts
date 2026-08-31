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

function missingCapability(capability: RequiredCapability): ClassifiedReason {
  return {
    code: "capability_missing",
    detail: `endpoint did not declare required capability: ${capability}`,
    hardNo: true,
  };
}

/**
 * Deep snapshot of all decision-relevant scalars.
 * 
 * This structure is created during validation and used exclusively during
 * matching logic. The purpose is to prevent hostile getters from returning
 * different values during validation (when structure is checked) versus
 * matching (when decisions are made). A shallow snapshot of top-level objects
 * is insufficient because getters can be placed on nested fields (like
 * dataPolicy.outputRetentionAllowed or rights.trainingAllowed.value), and
 * check-then-use is exactly what an accessor defeats; a shallow snapshot only
 * moves the defect one level down. This deep snapshot captures every decision
 * point exactly once, ensuring matching verdicts are deterministic and
 * consistent with validation.
 */
type DecisionSnapshot = {
  readonly roleId: string;
  readonly endpointId: string;
  readonly requiredCapabilities: readonly string[];
  readonly minimumContextTokens: number;
  readonly riskClass: string;
  readonly externalProviderAllowed: boolean;
  readonly outputRetentionAllowed: boolean;
  readonly processesProtectedData: boolean;
  readonly contextLimit: number;
  readonly declaredCapabilities: readonly string[];
  readonly validFrom: string;
  readonly expiresAt: string | null;
  readonly inferenceIsExternalKind: string;
  readonly inferenceIsExternalValue: unknown;
  readonly approvedForProtectedDataKind: string;
  readonly approvedForProtectedDataValue: unknown;
  readonly trainingAllowedKind: string;
  readonly trainingAllowedValue: unknown;
  readonly evaluationAllowedKind: string;
  readonly evaluationAllowedValue: unknown;
  readonly outputRetainedByProviderKind: string;
  readonly outputRetainedByProviderValue: unknown;
};

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
    if (typeof roleId !== "string" || typeof endpointId !== "string") {
      return {
        verdict: "unevaluable",
        roleId: typeof roleId === "string" ? roleId : "unknown",
        endpointId: typeof endpointId === "string" ? endpointId : "unknown",
        reasons: [
          { code: "input_not_evaluable", detail: "roleId and endpointId must be strings" },
        ],
      };
    }

    // Validate role structure
    if (!Array.isArray(requiredCapabilities)) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [
          { code: "input_not_evaluable", detail: "role.requiredCapabilities is not an array" },
        ],
      };
    }

    if (typeof minimumContextTokens !== "number" || !Number.isFinite(minimumContextTokens)) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [
          {
            code: "input_not_evaluable",
            detail: "role.minimumContextTokens is not a finite number",
          },
        ],
      };
    }

    if (typeof riskClass !== "string") {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [{ code: "input_not_evaluable", detail: "role.riskClass is not a string" }],
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
    // Read and validate dataPolicy fields ONCE into locals
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
    if (!Array.isArray(declaredCapabilities)) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [
          {
            code: "input_not_evaluable",
            detail: "endpoint.declaredCapabilities is not an array",
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
    // Read and validate contextLimit ONCE
    const contextLimit = capProfileObj.contextLimit;
    if (
      typeof contextLimit !== "number" ||
      !Number.isFinite(contextLimit)
    ) {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [
          {
            code: "input_not_evaluable",
            detail: "endpoint.capabilityProfile.contextLimit is not a finite number",
          },
        ],
      };
    }

    // Validate ExplicitValue structures
    if (
      typeof inferenceIsExternal !== "object" ||
      inferenceIsExternal === null ||
      (!(inferenceIsExternal as Record<string, unknown>).kind)
    ) {
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

    if (
      typeof approvedForProtectedData !== "object" ||
      approvedForProtectedData === null ||
      (!(approvedForProtectedData as Record<string, unknown>).kind)
    ) {
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
    const requiredRights = [
      "trainingAllowed",
      "evaluationAllowed",
      "outputRetainedByProvider",
    ];
    for (const rightName of requiredRights) {
      const right = rightsObj[rightName];
      if (
        typeof right !== "object" ||
        right === null ||
        (!(right as Record<string, unknown>).kind)
      ) {
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

    // Validate timestamps
    if (typeof validFrom !== "string") {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [
          { code: "input_not_evaluable", detail: "endpoint.validFrom is not a string" },
        ],
      };
    }

    if (expiresAt !== null && typeof expiresAt !== "string") {
      return {
        verdict: "unevaluable",
        roleId,
        endpointId,
        reasons: [
          {
            code: "input_not_evaluable",
            detail: "endpoint.expiresAt must be a string or null",
          },
        ],
      };
    }

    // ============================================================================
    // DEEP SNAPSHOT: Capture all decision-relevant scalars exactly once
    // After this point, role and endpoint must NOT be read again
    // ============================================================================
    const inferenceIsExternalRec = inferenceIsExternal as Record<string, unknown>;
    const approvedForProtectedDataRec = approvedForProtectedData as Record<string, unknown>;
    const trainingAllowedRec = rightsObj.trainingAllowed as Record<string, unknown>;
    const evaluationAllowedRec = rightsObj.evaluationAllowed as Record<string, unknown>;
    const outputRetainedByProviderRec = rightsObj.outputRetainedByProvider as Record<string, unknown>;

    const snapshot: DecisionSnapshot = {
      roleId,
      endpointId,
      requiredCapabilities: Array.from(requiredCapabilities as string[]),
      minimumContextTokens: minimumContextTokens as number,
      riskClass: riskClass as string,
      externalProviderAllowed: externalProviderAllowed as boolean,
      outputRetentionAllowed: outputRetentionAllowed as boolean,
      processesProtectedData: processesProtectedData as boolean,
      contextLimit: contextLimit as number,
      declaredCapabilities: Array.from(declaredCapabilities as string[]),
      validFrom: validFrom as string,
      expiresAt: expiresAt as string | null,
      inferenceIsExternalKind: inferenceIsExternalRec.kind as string,
      inferenceIsExternalValue: inferenceIsExternalRec.value,
      approvedForProtectedDataKind: approvedForProtectedDataRec.kind as string,
      approvedForProtectedDataValue: approvedForProtectedDataRec.value,
      trainingAllowedKind: trainingAllowedRec.kind as string,
      trainingAllowedValue: trainingAllowedRec.value,
      evaluationAllowedKind: evaluationAllowedRec.kind as string,
      evaluationAllowedValue: evaluationAllowedRec.value,
      outputRetainedByProviderKind: outputRetainedByProviderRec.kind as string,
      outputRetainedByProviderValue: outputRetainedByProviderRec.value,
    };

    // ============================================================================
    // DECISION LOGIC: All matching is performed against the snapshot only
    // ============================================================================
    const classified: ClassifiedReason[] = [];
    const declared = new Set(snapshot.declaredCapabilities);

    for (const capability of snapshot.requiredCapabilities) {
      if (!declared.has(capability)) classified.push(missingCapability(capability as RequiredCapability));
    }

    if (snapshot.contextLimit < snapshot.minimumContextTokens) {
      classified.push({
        code: "context_too_small",
        detail: `endpoint context limit ${snapshot.contextLimit} is below required ${snapshot.minimumContextTokens}`,
        hardNo: true,
      });
    }

    if (!snapshot.externalProviderAllowed) {
      if (snapshot.inferenceIsExternalKind === "unknown") {
        classified.push({
          code: "external_provider_undeclared",
          detail: "endpoint did not declare whether inference is external",
          hardNo: false,
        });
      } else if (snapshot.inferenceIsExternalValue) {
        classified.push({
          code: "external_provider_forbidden",
          detail: "role policy forbids an external inference provider",
          hardNo: true,
        });
      }
    }

    if (!snapshot.outputRetentionAllowed) {
      if (snapshot.outputRetainedByProviderKind === "unknown") {
        classified.push({
          code: "retention_undeclared",
          detail: "endpoint did not declare retention policy",
          hardNo: false,
        });
      } else if (snapshot.outputRetainedByProviderValue) {
        classified.push({
          code: "retention_forbidden",
          detail: "endpoint retains output but role policy forbids retention",
          hardNo: true,
        });
      }
    }

    if (snapshot.processesProtectedData) {
      if (snapshot.approvedForProtectedDataKind === "unknown") {
        classified.push({
          code: "protected_data_approval_undeclared",
          detail: "endpoint did not declare whether it may process protected data",
          hardNo: false,
        });
      } else if (!snapshot.approvedForProtectedDataValue) {
        classified.push({
          code: "protected_data_not_approved",
          detail: "endpoint is not approved to process protected data",
          hardNo: true,
        });
      }
    }

    if (snapshot.riskClass === "high") {
      for (const [rightName, rightKind, rightValue] of [
        ["trainingAllowed", snapshot.trainingAllowedKind, snapshot.trainingAllowedValue],
        ["evaluationAllowed", snapshot.evaluationAllowedKind, snapshot.evaluationAllowedValue],
      ] as const) {
        if (rightKind === "unknown") {
          classified.push({
            code: "rights_undeclared",
            detail: `high-risk role requires ${rightName} to be declared`,
            hardNo: false,
          });
        } else if (!rightValue) {
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

    if (snapshot.expiresAt !== null && snapshot.expiresAt < (now as string)) {
      classified.push({
        code: "endpoint_expired",
        detail: `endpoint expired at ${snapshot.expiresAt}`,
        hardNo: true,
      });
    }
    if (snapshot.validFrom > (now as string)) {
      classified.push({
        code: "endpoint_not_yet_valid",
        detail: `endpoint is not valid until ${snapshot.validFrom}`,
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
      roleId: snapshot.roleId,
      endpointId: snapshot.endpointId,
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
