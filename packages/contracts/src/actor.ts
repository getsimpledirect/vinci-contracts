import type { DeviceId, UserId, WorkerId } from "./ids.ts";

/**
 * Who caused something to happen.
 *
 * Every state transition must record an actor (FR-2.2), and receipts must
 * distinguish worker-provided from human-provided from system-observed records
 * (FR-6.3). A union — rather than a `string` name — is what makes those
 * distinctions survive serialization instead of depending on a display
 * convention.
 *
 * `policy` is a distinct actor from `system`: an action taken because a policy
 * rule fired is attributable to the policy version that fired it, which is what
 * FR-4.8 requires the user be shown when something is blocked.
 */
export type Actor =
  | { readonly kind: "user"; readonly userId: UserId; readonly deviceId?: DeviceId }
  | { readonly kind: "worker"; readonly workerId: WorkerId }
  | { readonly kind: "policy"; readonly policyId: string; readonly policyVersion: number }
  | { readonly kind: "system"; readonly component: string }
  /**
   * An independent verifier. Kept separate from `system` because §8.1 forbids
   * the worker issuing its own verdict, and separate from `worker` because a
   * verifier that happens to run the same model is still not the worker — the
   * product must disclose non-independence (FR-7.3) rather than hide it behind
   * a shared actor kind.
   */
  | { readonly kind: "verifier"; readonly verifierId: string; readonly independent: boolean };

/**
 * ISO-8601 instant, UTC, millisecond precision. Stored as a string because
 * receipts and events are exported and compared across systems (FR-6.5), where
 * a `Date` would not survive the round trip.
 */
export type Timestamp = string;

/**
 * A recorded state transition (FR-2.2). Every field there is required is
 * required here — including the human-readable explanation, which is what
 * makes a receipt legible to a developer who did not observe the run (FR-6).
 */
export type StateTransition<S extends string> = {
  readonly at: Timestamp;
  readonly actor: Actor;
  /** Stable machine-readable code, safe to switch on and safe to display. */
  readonly reasonCode: string;
  readonly explanation: string;
  readonly previousState: S | null;
  readonly nextState: S;
};
