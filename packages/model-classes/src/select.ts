import type { Timestamp } from "@getsimpledirect/vinci-contracts";
import type { ModelEndpointSpec } from "./endpoint.ts";
import type { ModelRoleSpec } from "./role.ts";
import { matchEndpointToRole, type MatchResult } from "./role-match.ts";

/** The complete, disjoint eligibility partition for a role. */
export type Selection = {
  readonly roleId: string;
  readonly eligible: readonly MatchResult[];
  readonly unevaluable: readonly MatchResult[];
  readonly ineligible: readonly MatchResult[];
};

/**
 * Classify every endpoint for a role without ranking candidates or choosing a
 * winner. Unevaluable results remain separate so unknown facts cannot grant or
 * deny eligibility.
 */
export function selectForRole(
  role: ModelRoleSpec,
  endpoints: readonly ModelEndpointSpec[],
  now: Timestamp,
): Selection {
  // Fail closed if inputs can't be read safely
  try {
    // Validate role shape
    if (typeof role !== "object" || role === null) {
      return {
        roleId: "unknown",
        eligible: [],
        unevaluable: [],
        ineligible: [],
      };
    }
    
    const roleId = role.roleId;
    
    // Validate endpoints shape
    if (!Array.isArray(endpoints)) {
      return {
        roleId: typeof roleId === "string" ? roleId : "unknown",
        eligible: [],
        unevaluable: [],
        ineligible: [],
      };
    }

    const eligible: MatchResult[] = [];
    const unevaluable: MatchResult[] = [];
    const ineligible: MatchResult[] = [];

    for (const endpoint of endpoints) {
      const result = matchEndpointToRole(role, endpoint, now);
      if (result.verdict === "eligible") eligible.push(result);
      else if (result.verdict === "unevaluable") unevaluable.push(result);
      else ineligible.push(result);
    }

    return { roleId: typeof roleId === "string" ? roleId : "unknown", eligible, unevaluable, ineligible };
  } catch {
    // Fail closed on any unexpected error
    return {
      roleId: "unknown",
      eligible: [],
      unevaluable: [],
      ineligible: [],
    };
  }
}
