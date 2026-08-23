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

/**
 * The exact fields each `Actor` arm may carry.
 *
 * Hand-listing which fields are FOREIGN to an arm was tried and was wrong
 * twice: the list omitted `independent` and `policyVersion`, so a worker could
 * carry `independent: true` and assert its own independence. An allowlist of
 * what belongs cannot have that failure mode — a field is permitted only if it
 * appears here.
 *
 * Kept beside the `Actor` union rather than in a consumer, so adding an arm and
 * forgetting the field list is a type error rather than a silent hole.
 */
export const ACTOR_FIELDS: Readonly<Record<Actor["kind"], readonly string[]>> = {
  user: ["kind", "userId", "deviceId"],
  worker: ["kind", "workerId"],
  policy: ["kind", "policyId", "policyVersion"],
  system: ["kind", "component"],
  verifier: ["kind", "verifierId", "independent"],
};

export function isActorKind(value: unknown): value is Actor["kind"] {
  return typeof value === "string" && Object.hasOwn(ACTOR_FIELDS, value);
}

/**
 * Does this record carry exactly the fields its own `kind` permits?
 *
 * Shared by anything that inspects an actor, so a predicate and a validator
 * cannot answer differently — which they did: for a verifier carrying a
 * `workerId`, one said consistent and the other refused.
 */
export function actorFieldsAreConsistent(actor: Readonly<Record<string, unknown>>): boolean {
  // Everything below reads OWN DATA properties only, and the reason is the
  // attack this function exists to stop, working again one level up:
  //
  //   Object.create({ kind: "verifier", verifierId: "v", independent: true })
  //
  // has NO own keys. Object.keys returns [], so "every own field is permitted"
  // was vacuously true, and the actor was judged consistent — while
  // `actor.independent` still read back as true to everything downstream. The
  // same claim written as an own key is correctly refused. Moving it to the
  // prototype was enough to reverse the answer.
  //
  // That is precisely what this function replaced a denylist to prevent: a
  // worker asserting its own independence.
  if (typeof actor !== "object" || actor === null || Array.isArray(actor)) return false;

  let kind: PropertyDescriptor | undefined;
  try {
    kind = Object.getOwnPropertyDescriptor(actor, "kind");
  } catch {
    return false;
  }
  // No descriptor => inherited or absent. No "value" => an accessor, which can
  // answer differently on a later read than it does here.
  if (kind === undefined || !("value" in kind)) return false;
  if (!isActorKind(kind.value)) return false;

  const permitted = new Set(ACTOR_FIELDS[kind.value]);

  let fields: string[];
  try {
    fields = Object.keys(actor);
  } catch {
    return false;
  }
  for (const field of fields) {
    if (!permitted.has(field)) return false;
    // A permitted field carried as an accessor is not data either.
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(actor, field);
    } catch {
      return false;
    }
    if (descriptor === undefined || !("value" in descriptor)) return false;
  }
  return true;
}
