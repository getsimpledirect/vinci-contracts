import type { Timestamp } from "@getsimpledirect/vinci-contracts";
import type { ModelEndpointSpec } from "./endpoint.ts";
import type { ModelRoleSpec } from "./role.ts";
import { matchEndpointToRole, type MatchResult } from "./role-match.ts";

/** A supply population larger than this is not a fleet; it is a hostile argument. */
const MAX_ENDPOINTS = 10_000;

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
    // Array.isArray is TRUE for `Object.assign([], {length: 2 ** 32 - 1})` -- a
    // real Array that claims four billion entries and holds none. Iterating it
    // exhausts the heap before any verdict is reached, so an unbounded loop here
    // is a denial of service reachable from a single hostile argument. A length
    // check is not a style preference: it is the guard. MAX_ENDPOINTS is far
    // above any real supply population (the live registry declares three) and
    // far below the point where iteration costs anything.
    if (!Array.isArray(endpoints) || endpoints.length > MAX_ENDPOINTS) {
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
