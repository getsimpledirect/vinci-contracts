import type { EvidenceId, Timestamp } from "@getsimpledirect/vinci-contracts";
import type { EvidenceOutcome, NotTestedItem } from "./attribution.ts";
import type { EvidenceKind, EvidenceMode, EvidenceReliability, EvidenceSourceKind } from "./evidence-kinds.ts";
import type { EvidenceAttestation } from "./provenance.ts";

/**
 * A single piece of evidence supporting or contradicting an acceptance criterion.
 *
 * Evidence records carry the Actor who vouches for them (FR-6.3), the kind
 * of evidence, and a reference to the artifacts that demonstrate it.
 *
 * This is the base contract that all evidence items must satisfy.
 */
export type EvidenceRecord = {
  readonly schemaVersion: 1;
  readonly id: EvidenceId;
  /**
   * Who vouches for this evidence: the worker, the system, a human, or an
   * independent verifier. This is the FR-6.3 distinction that receipts must
   * preserve.
   */
  readonly attestation: EvidenceAttestation;
  /**
   * What kind of evidence this is: `unit_test`, `screenshot`, etc.
   * Drives what criteria it can satisfy and how it must be re-verified.
   */
  readonly kind: EvidenceKind;
  /**
   * How this evidence was produced: deterministic, execution-based, visual,
   * model-judged, or human-approved.
   */
  readonly mode: EvidenceMode;
  /**
   * How much weight this carries in an assessment.
   */
  readonly reliability: EvidenceReliability;
  /**
   * How this evidence was collected: by a runner, or under supervision.
   *
   * This is distinct from `attestation.provenance` (who vouches) and from
   * `attestation.actor` (who did it). A worker can instruct a runner to collect
   * evidence, so it can be `worker_provided` and `runner` collected
   * simultaneously. Another piece can be `human_provided` and `supervised`
   * (a human took an action under observation).
   */
  readonly sourceKind: EvidenceSourceKind;
  /**
   * A summary of what this evidence shows: "Unit tests passed 487/487" or
   * "Signed off by @alice".
   */
  /**
   * What this evidence says, and whose failure it is if it says something
   * failed. Not an optional field: see EvidenceOutcome.
   */
  readonly assessment: EvidenceOutcome;
  /**
   * What was NOT checked while gathering this evidence, and why.
   *
   * Silence about coverage reads as coverage. A record listing what passed and
   * omitting what could not be evaluated is understood as "everything was
   * checked", which is the unearned pass this system exists to prevent.
   */
  readonly notTested: readonly NotTestedItem[];
  readonly summary: string;
  /**
   * When this evidence was recorded. Used to determine if evidence has expired.
   */
  readonly recordedAt: Timestamp;
};
