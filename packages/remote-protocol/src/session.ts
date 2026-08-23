import type { DeviceId, OrganizationId, RunId, WorkspaceId } from "@vinci/contracts";

/**
 * A remote session is TRANSPORT identity. A run is WORK identity. They are not
 * the same thing and must not be conflated.
 *
 * A run is the organizational unit: an objective, an owner, a policy, a budget,
 * evidence, a receipt. It survives things a session does not — a worker
 * restarting, a host rebooting, the work moving to another machine, a session
 * dropping and being re-established.
 *
 * A session is one connection between one host and the relay. A run may have
 * several over its life; a session belongs to exactly one run.
 *
 *   Run
 *     ├── objective, workspace, policy, budget, evidence, receipt
 *     └── one or more execution sessions
 *              └── remote mirror session
 *
 * Making the session id the central identity is the mistake this type exists to
 * prevent. It reads naturally while there is one session per run, and then
 * quietly becomes wrong the first time a worker restarts: approvals, receipts
 * and evidence would all be keyed to a transport artifact that no longer
 * exists.
 */
export type SessionId = string & { readonly __brand: "SessionId" };

/**
 * What a session is a session OF.
 *
 * `organizationId` is nullable because personal workspaces are first-class
 * (FR-9.4) — but the field is REQUIRED and explicitly null, never absent. An
 * absent organization is indistinguishable from one nobody set, and a stale
 * organization context authorizing current access is exactly the failure FR-9.4
 * names.
 */
export type SessionBinding = {
  readonly sessionId: SessionId;
  readonly runId: RunId;
  readonly workspaceId: WorkspaceId;
  readonly organizationId: OrganizationId | null;
  /** The device hosting the worker. */
  readonly hostDeviceId: DeviceId;
  readonly policyId: string;
  readonly policyVersion: number;
  /** Governs what the relay may retain for this session. */
  readonly retentionClass: "zdr_0d" | "days_7" | "days_14" | "days_30";
};

/**
 * What a device connected to a session may do.
 *
 * Roles are about AUTHORITY, not about what a UI chooses to show. A viewer that
 * can send a steering command is not a viewer.
 */
export const SESSION_ROLES = ["host", "owner", "approver", "collaborator", "viewer"] as const;
export type SessionRole = (typeof SESSION_ROLES)[number];

export function isSessionRole(value: unknown): value is SessionRole {
  return typeof value === "string" && (SESSION_ROLES as readonly string[]).includes(value);
}
