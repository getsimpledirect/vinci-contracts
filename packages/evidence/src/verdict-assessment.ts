import type { VerdictStatus } from "@vinci/contracts";

/**
 * Staleness trigger: why a verdict is no longer current.
 *
 * Tracks all five FR-7.4 staleness conditions so a verdict can express which
 * triggers made it stale. This is separate from the coarse mutation-driven flag
 * (`mutationAny`) and supports more precise invalidation.
 *
 * The digest-based comparison (trigger "artifact_digest_changed") is not
 * implemented today in vinci-code; it is modelled here as a future capability.
 * Today, verdict staleness is marked coarsely: any mutation marks all verdicts
 * stale. That mechanism is preserved in the "mutation_any" trigger.
 */
export const VERDICT_STALENESS_TRIGGERS = [
  /**
   * Files changed (coarse mutation-driven staleness). A change to any tracked
   * file marks all stored verdicts stale, regardless of whether the change
   * could affect the verdict.
   *
   * This is the current vinci-code mechanism: recordVinciMutation() sets
   * `staled: true` on every stored verdict when any mutation occurs.
   */
  "mutation_any",

  /**
   * The artifact (code or build) digest changed compared to the snapshot under
   * which the verdict was issued.
   *
   * This is the precise invalidation path. A digest comparison would catch
   * that a change happened without re-running the verdict's evidence
   * generation. NOT IMPLEMENTED TODAY, but modelled here for future use.
   */
  "artifact_digest_changed",

  /**
   * A policy that affects this verdict was updated (e.g., a policy that
   * required additional criteria, or a policy that blocked approval).
   */
  "policy_configuration_changed",

  /**
   * Evidence that the verdict depended on has expired. A verdict that required
   * `expiresAt: "2024-08-30T12:00:00Z"` evidence becomes stale if the current
   * time passes that instant.
   */
  "required_evidence_expired",

  /**
   * The worker (or human, if carrying the worker's task) resumed work and
   * modified the result under evaluation. The verdict was about a previous
   * version of the work.
   */
  "worker_resumed_and_modified",
] as const;

export type VerdictStalenessTriggger = (typeof VERDICT_STALENESS_TRIGGERS)[number];

/**
 * A verdict assessment: either a current assessment or an explicitly stale one.
 *
 * This is a discriminated union that makes it structurally impossible to read
 * a stale verdict as if it were current. A caller must first check the `kind`
 * field and explicitly handle the stale case before accessing `status`.
 *
 * This follows the pattern from @vinci/contracts/src/states.ts where
 * `VerificationOutcome` is a union: issuers cannot accidentally render "no
 * verdict" as a pass because the type forces them to handle it first.
 *
 * Here, a verdict reader cannot accidentally treat a stale verdict as current
 * because the type makes staleness visible in the `kind` discriminator.
 */
export type VerdictAssessment =
  /**
   * This is the current assessment. It carries the issued status and has not
   * become stale since it was recorded.
   */
  | {
      readonly kind: "current";
      readonly status: VerdictStatus;
    }
  /**
   * This was an assessment, but it is no longer current. It is kept as
   * historical evidence of what was evaluated and when, but must not be
   * represented to a user or used to determine whether a run passed.
   *
   * The `reason` is a human-readable explanation for the staleness. The
   * `triggers` list the conditions that made it stale, drawn from
   * `VerdictStalenessTriggger`.
   */
  | {
      readonly kind: "stale";
      /**
       * Machine-readable code explaining why: "mutation_any", "policy_changed",
       * etc. Safe to switch on; safe to display or log.
       */
      readonly reason: string;
      /**
       * The conditions that caused staleness. Each is a string from
       * `VERDICT_STALENESS_TRIGGERS`, allowing a consumer to ask "did the
       * verdict become stale because the policy changed, or because the code
       * changed?"
       */
      readonly triggers: readonly string[];
    };

/**
 * Convert a VerificationOutcome stale boolean into the discriminated-union form.
 *
 * Callers often receive a verdict with a boolean `staled` flag; this helper
 * allows migration from the boolean model to the union model while both are
 * in use.
 *
 * If `staled` is false, returns `{ kind: "current"; status }`.
 * If `staled` is true, returns `{ kind: "stale"; reason: "stale"; triggers: [] }`.
 *
 * The triggers list is empty because the boolean form does not carry which
 * triggers caused the staleness. A caller that needs that detail must look up
 * the full verdict record.
 */
export function verdictAssessmentFromBoolean(
  status: VerdictStatus,
  staled: boolean,
): VerdictAssessment {
  if (!staled) {
    return { kind: "current", status };
  }
  return {
    kind: "stale",
    reason: "stale",
    triggers: [],
  };
}
