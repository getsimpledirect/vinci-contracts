/**
 * Roles granted to an authenticated participant in a remote session.
 *
 * This vocabulary lives in layer 0 so both the layer-1 device-auth token
 * contract and the layer-3 remote protocol can use the same closed list.
 * Organization membership roles are a different vocabulary and must never be
 * used to infer one of these grants.
 */
export const SESSION_ROLES = ["host", "owner", "approver", "collaborator", "viewer"] as const;

export type SessionRole = (typeof SESSION_ROLES)[number];

export function isSessionRole(value: unknown): value is SessionRole {
  return typeof value === "string" && (SESSION_ROLES as readonly string[]).includes(value);
}
