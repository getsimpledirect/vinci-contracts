/**
 * Evidence classification and qualities.
 *
 * These types are reused from vinci-acceptance (packages/protocol/src/types.ts)
 * where they are already defined and shipped. This package re-exports them for
 * consistency and to centralise the definitions they appear in with other
 * evidence-related contracts.
 */

/**
 * The nineteen kinds of evidence that can support an acceptance criterion.
 *
 * Each kind carries different reliability signals and drives different
 * verification strategies. A criterion requiring `unit_test` evidence cannot
 * be satisfied by `screenshot` alone.
 */
export const EVIDENCE_KINDS = [
  "command_execution",
  "build_result",
  "unit_test",
  "integration_test",
  "generated_test",
  "api_request_response",
  "browser_dom_assertion",
  "browser_network_observation",
  "browser_console_observation",
  "screenshot",
  "visual_comparison",
  "trace",
  "mobile_test",
  "database_invariant",
  "permission_check",
  "security_scan",
  "human_approval",
  "model_interpretation",
  "environment_diagnostic",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * How evidence was produced: whether it is the outcome of a deterministic
 * operation, the result of executing something and observing, purely visual
 * comparison, a model's assessment, or a human's.
 *
 * This drives what re-verification strategy is appropriate. A `deterministic`
 * evidence item can be re-checked by re-running its generating command. A
 * `human_approval` can only be stale if a new approval is asked for.
 *
 * Exported as a const array with the type DERIVED from it, not as a bare union.
 * There were two definitions of this vocabulary inside this package: the union
 * here, and a private `EVIDENCE_MODES` array in schema.ts that the validator
 * actually enforced. They agreed, and nothing made them keep agreeing — adding a
 * member to one would have left the other silently refusing it.
 *
 * A consumer needs the array too. Acceptance had to re-declare this vocabulary
 * because a type union cannot be iterated or validated against at runtime, which
 * is the drift this package exists to end, caused by the package itself.
 */
export const EVIDENCE_MODES = [
  "deterministic",
  "execution",
  "visual",
  "model_judgment",
  "human_approval",
] as const;

export type EvidenceMode = (typeof EVIDENCE_MODES)[number];

/**
 * How much weight this evidence carries in an assessment.
 *
 * `authoritative` evidence cannot be overridden; if a criterion requires it
 * and no authoritative evidence exists, the criterion is unverified.
 * `weak` evidence supports a verdict but does not alone justify it.
 *
 * Same treatment as EVIDENCE_MODES above, and for the same reason: schema.ts
 * held a private array the validator enforced while this file held a union the
 * types referred to.
 */
export const EVIDENCE_RELIABILITIES = [
  "authoritative",
  "strong",
  "supporting",
  "weak",
] as const;

export type EvidenceReliability = (typeof EVIDENCE_RELIABILITIES)[number];

/**
 * How evidence was collected: either by a runner (Vinci's controlled execution
 * environment) or under supervision (a human watching or approving the outcome).
 *
 * This is distinct from `EvidenceProvenance` below, which answers "who vouches
 * for this?" (`EvidenceSourceKind` answers "how was this collected?"). Both are
 * real and both are kept separate because evidence can be worker-provided but
 * runner-collected, or human-provided but supervised.
 */
export const EVIDENCE_SOURCE_KINDS = ["runner", "supervised"] as const;

export type EvidenceSourceKind = (typeof EVIDENCE_SOURCE_KINDS)[number];
