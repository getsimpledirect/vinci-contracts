/**
 * Why a consequential remote command can be rejected.
 *
 * This vocabulary lives at layer 0 because both the layer-2 durable event log
 * and the layer-3 remote protocol need the same readable reason. A digest can
 * identify the rejected command, but it cannot tell an operator why the host
 * refused it.
 */
export const REMOTE_DECISION_REJECTIONS = [
  /** The chosen option was not one the host offered. */
  "option_not_offered",
  /** The approval expired before the decision arrived. */
  "expired",
  /** The request was already settled, locally or by another device. */
  "already_settled",
  /** The device's role does not permit this decision. */
  "not_permitted",
  /** The session moved on; the request no longer exists. */
  "session_changed",
  /** The credential was revoked before the command could take effect. */
  "credential_revoked",
  /** The command's organization, workspace, run, or session binding differed. */
  "binding_mismatch",
] as const;

export type RemoteDecisionRejection = (typeof REMOTE_DECISION_REJECTIONS)[number];
