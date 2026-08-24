import { plainActor, type Actor } from "@getsimpledirect/vinci-contracts";

/**
 * Who vouches for this evidence. This is the FR-6.3 requirement to distinguish
 * receipts that record worker-provided, system-observed, human-provided, and
 * independent-verifier evidence.
 *
 * This is ORTHOGONAL to `EvidenceSourceKind` ("runner" | "supervised"), which
 * answers the question "how was this collected?" Provenance answers "who is
 * claiming this is true?" An evidence item can be worker-provided but
 * runner-collected (the worker instructed the runner to execute something).
 * Another can be system-observed under supervision (Vinci watched a human
 * action and recorded it). Both dimensions are real and are kept separate to
 * preserve the information each conveys.
 *
 * Four cases:
 * - `worker_provided`: The worker (an AI agent or human) created this evidence
 *   or performed the action that generated it. The worker is accountable for
 *   its accuracy.
 * - `system_observed`: Vinci's system observed this without worker instruction.
 *   The system is accountable; the worker did not ask for it or arrange it.
 * - `human_provided`: A human (not the worker, not a verifier) created this
 *   evidence or performed the action. The human is accountable.
 * - `independent_verifier`: An independent verifier (not the worker) produced
 *   this evidence. This is a distinct case because FR-7.3 requires the product
 *   disclose when an assessment comes from someone other than the worker, and
 *   the verifier's independence is part of the claim.
 *
 * Each case maps to the `Actor` type from @getsimpledirect/vinci-contracts in the way that
 * makes sense: `worker_provided` uses `Actor.kind: "worker"`, `human_provided`
 * uses `Actor.kind: "user"`, `system_observed` uses `Actor.kind: "system"`,
 * and `independent_verifier` uses `Actor.kind: "verifier"` with the
 * `independent` flag.
 */
export const EVIDENCE_PROVENANCE_CASES = [
  "worker_provided",
  "system_observed",
  "human_provided",
  "independent_verifier",
] as const;

export type EvidenceProvenance = (typeof EVIDENCE_PROVENANCE_CASES)[number];

/**
 * The actor who vouches for this evidence, derived from provenance.
 *
 * This is the responsibility party: the one who can be asked to explain or
 * re-verify the evidence if needed.
 */
export type EvidenceAttestation = {
  readonly provenance: EvidenceProvenance;
  readonly actor: Actor;
};

/**
 * Validate that provenance and actor are consistent.
 *
 * Returns true if the combination makes sense (e.g., `worker_provided` with
 * `Actor.kind: "worker"`), false otherwise.
 */
export function isProvenanceConsistent(
  provenance: EvidenceProvenance,
  actor: Actor,
): boolean {
  // Shares the field check with the validator rather than re-deriving a
  // weaker version of it. These two answered differently for a verifier
  // carrying a workerId — the helper said consistent, the validator refused —
  // which made the helper an alternate, more permissive path to the same
  // question. A test asserting they agree existed, and varied only the
  // independence flag.
  // Snapshot ONCE, then decide from the snapshot. The previous version checked
  // consistency by reflection and then authorized from fresh `actor.kind` /
  // `actor.independent` reads, so a Proxy served an honest worker to the check
  // and an independent verifier to the decision — and was authorized as one.
  const snapshot = plainActor(actor as unknown as Readonly<Record<string, unknown>>);
  if (snapshot === null) return false;

  switch (provenance) {
    case "worker_provided":
      return snapshot.kind === "worker";
    case "system_observed":
      return snapshot.kind === "system";
    case "human_provided":
      return snapshot.kind === "user";
    case "independent_verifier":
      // The independence flag is part of the invariant, not a detail beside
      // it. FR-7.3 permits a non-independent verifier and requires that it be
      // DISCLOSED; evidence claiming independent-verifier provenance is the
      // opposite of disclosing it.
      return snapshot.kind === "verifier" && snapshot.independent === true;
    default:
      // An unrecognised provenance is not consistent with anything.
      //
      // Without this the switch fell through and the function returned
      // `undefined` from a signature declaring `boolean`. It is falsy, so it
      // failed closed by luck rather than by design, and any caller comparing
      // `=== false` — a reasonable thing to do with a predicate — got the
      // wrong answer. TypeScript accepted the omission because the switch is
      // exhaustive over the DECLARED union, which says nothing about what
      // arrives at runtime.
      return false;
  }
}
