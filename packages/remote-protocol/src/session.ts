import type { DeviceId, OrganizationId, RunId, WorkspaceId } from "@getsimpledirect/vinci-contracts";
export { SESSION_ROLES, isSessionRole } from "@getsimpledirect/vinci-contracts";
export type { SessionRole } from "@getsimpledirect/vinci-contracts";

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
 * The wire protocol this package speaks.
 *
 * A session binding crosses a network between two independently-deployed
 * programs: a host that may be an old Vinci Code install, and a relay that was
 * deployed this morning. Nothing in the record said which protocol either side
 * was speaking, so a version skew presented as a validation failure on whichever
 * field happened to change — or worse, as a successful parse of a record that
 * meant something else.
 *
 * The field is required and checked against this constant, so a peer speaking a
 * protocol this build does not implement is refused at the boundary with a
 * message naming the skew. That is FR-4.8 applied to the wire: if we cannot
 * determine what the other side meant, the session must not proceed.
 */
export const REMOTE_PROTOCOL_VERSION = 1;

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
  /**
   * The wire protocol both peers must agree on. Distinct from `schemaVersion`,
   * and they answer different questions: this one asks whether we can talk at
   * all, `schemaVersion` asks whether this particular record means what the
   * reader thinks it means. A protocol can add a message type without changing
   * this record's shape, and this record's shape can change within a protocol.
   */
  readonly protocolVersion: number;
  /**
   * The version of THIS record's schema, on the wire rather than only in
   * `SESSION_BINDING_SCHEMA_META`. The meta is a compile-time fact about the
   * build that read the record; a receiver needs a runtime fact about the build
   * that wrote it. The validator checks the two against each other so they
   * cannot drift.
   */
  readonly schemaVersion: number;
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
