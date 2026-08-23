/**
 * The lifecycle of a device pairing (`device_pairings.status`).
 *
 * A pairing starts `pending`, becomes `authorized` when a user confirms the
 * short human-typed code (gaining `user_id`), and is `consumed` once the
 * single-use device code has been redeemed for a credential.
 *
 * > **Constraint note:** unlike the `client_type` column, `status` currently
 * > has **no DB CHECK constraint**. The schema stores only these three values
 * > today, but nothing at the database layer prevents an invalid value from
 * > being written. Consumers must fail closed on anything outside this set
 * > rather than assume the store will have caught it.
 */
export const PAIRING_STATES = ["pending", "authorized", "consumed"] as const;

export type PairingState = (typeof PAIRING_STATES)[number];

export function isPairingState(value: unknown): value is PairingState {
  return typeof value === "string" && (PAIRING_STATES as readonly string[]).includes(value);
}
