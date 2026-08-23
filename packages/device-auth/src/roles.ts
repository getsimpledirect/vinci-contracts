/**
 * The seven membership roles.
 *
 * Three are **enforced** today (`owner`, `admin`, `member`) — those are the
 * only role strings that exist anywhere in vinci-platform. The other four
 * (`operator`, `approver`, `auditor`, `viewer`) are **defined but NOT YET
 * ENFORCED**: declared so the vocabulary is shared and stable, but no
 * authorization path in any product has wired them up. See the
 * `// NOT YET ENFORCED` markers below.
 *
 * `approver` is the one whose absence blocks a functional requirement rather
 * than a reporting nicety: approval rules must be able to say "require any
 * user with a role" (FR-4.7), and the Mobile approval centre (FR-5) has no way
 * to express who may clear a request without it.
 *
 * Note `approver` is a person's role in an organization. It is unrelated to
 * the `verifier` arm of `Actor` in @vinci/contracts, which is an independent
 * verification service. Naming a role `verifier` would collide with that and
 * is deliberately avoided.
 *
 * `ROLE_SAFE_FALLBACK` records what an unenforced role degrades to on a system
 * that does not know it yet, in the direction that never over-grants.
 */
export const ENFORCED_ROLES = ["owner", "admin", "member"] as const;

/**
 * Defined for shared vocabulary use, but not yet enforced by any
 * authorization path. Marked `NOT YET ENFORCED` so a consumer does not assume
 * these grants are actually in effect.
 */
// NOT YET ENFORCED
export const UNENFORCED_ROLES = ["operator", "approver", "auditor", "viewer"] as const;

export const ROLES = [...ENFORCED_ROLES, ...UNENFORCED_ROLES] as const;

export type Role = (typeof ROLES)[number];

export type EnforcedRole = (typeof ENFORCED_ROLES)[number];

export type UnenforcedRole = (typeof UNENFORCED_ROLES)[number];

/**
 * The enforced role a not-yet-enforced role may safely fall back to, or `null`
 * when there is none.
 *
 * A fallback exists because only `owner`, `admin` and `member` are actually
 * enforced today, so a system encountering one of the four new roles has to
 * decide what to do. The direction matters: falling back must never grant more
 * than the intended role.
 *
 * `operator`, `approver` and `auditor` each add authority on top of `member`,
 * so degrading them to `member` withholds capability and is safe.
 *
 * `viewer` is the exception, and the reason this is a `Record<Role, ... | null>`
 * rather than a total mapping. Read-only viewer is strictly *narrower* than
 * `member` — it is the only role in the set that removes rather than adds. No
 * enforced role is narrower still, so there is nothing to fall back to.
 * Mapping it to `member` would silently hand a read-only user write access.
 *
 * `null` therefore means deny, not "use the default" — consistent with FR-4.8:
 * where authority cannot be determined, the action does not proceed.
 */
export const ROLE_SAFE_FALLBACK: Readonly<Record<Role, EnforcedRole | null>> = {
  owner: "owner",
  admin: "admin",
  member: "member",
  operator: "member", // NOT YET ENFORCED — member + may start and control runs
  approver: "member", // NOT YET ENFORCED — member + may resolve approval requests
  auditor: "member", // NOT YET ENFORCED — member + read-only access to evidence and receipts
  viewer: null, // NOT YET ENFORCED — strictly narrower than member; no safe fallback exists
};

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isEnforcedRole(value: unknown): value is EnforcedRole {
  return typeof value === "string" && (ENFORCED_ROLES as readonly string[]).includes(value);
}
