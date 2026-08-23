import { toPlainRecord } from "./plain-record.ts";
import { isNonBlankText } from "./scalars.ts";
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
/**
 * What each kind of actor must carry, and of what type.
 *
 * This is the single source of truth: {@link ACTOR_FIELDS} is DERIVED from it,
 * so the permitted-field list and the required-field rules cannot disagree.
 * They already had. `plainActor` enforced only "no foreign fields" while
 * `validateEvidenceRecord` also required each arm's identity, so
 *
 *   plainActor({ kind: "worker" })                               -> a snapshot
 *   plainActor({ kind: "verifier", independent: true })          -> a snapshot
 *
 * both succeeded: a worker with no identity, and an anonymous verifier
 * asserting its own independence. The exported helper was again a more
 * permissive path to a question the validator answered strictly — the exact
 * divergence the comment in provenance.ts says was closed once already.
 *
 * "?" marks optional. Everything else must be present.
 */
const ACTOR_FIELD_RULES = {
  user: { userId: "string", deviceId: "string?" },
  worker: { workerId: "string" },
  policy: { policyId: "string", policyVersion: "positiveInteger" },
  system: { component: "string" },
  verifier: { verifierId: "string", independent: "boolean" },
} as const satisfies Record<Actor["kind"], Readonly<Record<string, string>>>;

/**
 * Which fields each kind of actor may carry. Derived, never hand-maintained.
 */
export const ACTOR_FIELDS: Readonly<Record<Actor["kind"], readonly string[]>> = Object.freeze(
  Object.fromEntries(
    Object.entries(ACTOR_FIELD_RULES).map(([kind, rules]) => [
      kind,
      Object.freeze(["kind", ...Object.keys(rules)]),
    ]),
  ),
) as Readonly<Record<Actor["kind"], readonly string[]>>;

export function isActorKind(value: unknown): value is Actor["kind"] {
  return typeof value === "string" && Object.hasOwn(ACTOR_FIELDS, value);
}

/**
 * One inert, own-data copy of an actor — or null if it is not a consistent one.
 *
 * THE POINT IS THAT THERE IS ONE READ. Callers must decide from the returned
 * snapshot and never touch the original again, because a Proxy can serve two
 * different views of itself:
 *
 *   const target = { kind: "worker", workerId: "w" };
 *   new Proxy(target, {
 *     get: (t, p) => (p === "kind" ? "verifier" : p === "independent" ? true
 *                                              : Reflect.get(t, p)),
 *     getOwnPropertyDescriptor: Reflect.getOwnPropertyDescriptor,  // honest
 *     ownKeys: Reflect.ownKeys,                                    // honest
 *   })
 *
 * Reflection saw an honest worker and said "consistent". The very next
 * property read said "independent verifier", and a worker was authorized to
 * vouch for its own output — the one thing the evidence layer must never
 * permit.
 *
 * Rewriting the check to walk descriptors did not fix that; it only moved
 * which lens was lied to. Measured against this same proxy:
 *
 *   descriptors report        { kind: "worker",   workerId: "w" }
 *   toPlainRecord reports     { kind: "verifier", workerId: "w" }
 *
 * and toPlainRecord's is the view that gets stored and validated. So the
 * record on disk said verifier while this function said worker.
 *
 * This is the E0 lesson about `toPlainRecord` arriving one layer up: you
 * cannot validate a Proxy by reflecting on it, because the reflection IS the
 * Proxy. The defence is not a better reflection — it is deferring to the ONE
 * boundary the whole repository already uses, so there is a single answer to
 * "what is this value" rather than a well-polished second one.
 */
export function plainActor(
  actor: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> | null {
  // Snapshot through the SAME boundary every validator uses.
  //
  // This used to walk own property descriptors itself, which was one read and
  // therefore safe against the check-then-decide split. But it was a DIFFERENT
  // read from the one `toPlainRecord` performs, and a Proxy can make the two
  // disagree about what the actor even is:
  //
  //   descriptors say  { kind: "worker",   workerId: "w" }
  //   serialization says { kind: "verifier", workerId: "w" }
  //
  // The serialized view is the one that gets stored and validated, so the
  // record on disk said verifier while this function's authority decision said
  // worker. Two lenses is the bug, however carefully each one is polished —
  // moving it from inside a function to across a package boundary did not fix
  // it, it just made it harder to see.
  //
  // Deferring to toPlainRecord means there is ONE definition of "what this
  // value is" in the entire repository. Accessors are invoked exactly once by
  // serialization and captured as data, which is why an accessor actor is now
  // accepted here as it always was by the validator.
  const snapshot = toPlainRecord(actor);
  if (!snapshot.ok) return null;
  const record: Readonly<Record<string, unknown>> = snapshot.value;

  const kind = record.kind;
  if (!isActorKind(kind)) return null;

  const permitted = new Set(ACTOR_FIELDS[kind]);
  for (const field of Object.keys(record)) {
    if (!permitted.has(field)) return null;
  }

  // Each arm's OWN requirements, not merely the absence of foreign fields.
  // Without this the helper accepted every malformed actor it was handed and
  // disagreed with the validator on all of them.
  const rules: Readonly<Record<string, string>> = ACTOR_FIELD_RULES[kind];
  for (const [field, rule] of Object.entries(rules)) {
    const value = record[field];
    if (value === undefined) {
      if (rule.endsWith("?")) continue;
      return null;
    }
    switch (rule) {
      case "string":
      case "string?":
        // Non-blank: an identifier of spaces names nobody while satisfying
        // both a typeof check and a length check.
        if (!isNonBlankText(value)) return null;
        break;
      case "boolean":
        // Strictly boolean. `independent: "yes"` is truthy and is not a
        // disclosure of anything.
        if (typeof value !== "boolean") return null;
        break;
      case "positiveInteger":
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
        break;
      default:
        return null;
    }
  }

  return Object.freeze(record);
}

/**
 * Does this record carry exactly the fields its own `kind` permits?
 *
 * A boolean convenience over {@link plainActor}. Prefer plainActor wherever the
 * answer is followed by a DECISION about the same actor: this returns only
 * yes/no, so a caller that then re-reads the original re-opens the two-view
 * hole described above.
 */
export function actorFieldsAreConsistent(actor: Readonly<Record<string, unknown>>): boolean {
  return plainActor(actor) !== null;
}

