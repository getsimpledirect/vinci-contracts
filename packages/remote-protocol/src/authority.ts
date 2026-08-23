import type { SessionRole } from "./session.ts";

/**
 * What a remote device may ask a host to do.
 *
 * Split deliberately into two sets, because the difference is the whole point.
 */

/**
 * Commands that REDUCE what the worker may do, or stop it.
 *
 * Always available to any device with a role that can act at all. Reducing
 * authority is safe by construction: the worst outcome of an unauthorized
 * pause is that work stops, which is recoverable. Requiring an approval round
 * trip before someone can hit the brakes gets the trade backwards.
 */
export const TIGHTENING_COMMANDS = [
  "pause",
  "abort",
  "deny_pending_approval",
  "restrict_to_read_only",
] as const;

/**
 * Commands that BROADEN what the worker may do.
 *
 * `set_permission_mode: full_access` is deliberately absent, and this is the
 * central authority decision in this protocol.
 *
 * A phone that can silently raise a worker to full access turns a stolen or
 * unlocked device into a privilege escalation, and does it through a channel
 * whose entire purpose is that the human is NOT at the machine. The relay
 * cannot judge whether that is appropriate; the host cannot tell an authorized
 * tap from an unauthorized one; and the person best placed to notice is by
 * definition somewhere else.
 *
 * Broadening happens only through a bounded approval — a specific capability,
 * a specific resource, a stated scope, an expiry, and a host confirmation.
 * That path already exists in @vinci/approvals and does not need a second,
 * weaker one beside it.
 */
export const BROADENING_COMMANDS = [] as const;

export const STEERING_COMMANDS = ["send_message", "answer_question"] as const;

export type RemoteCommandKind =
  | (typeof TIGHTENING_COMMANDS)[number]
  | (typeof STEERING_COMMANDS)[number]
  | "approve_pending_approval";

/**
 * Which roles may issue which commands.
 *
 * A viewer may do nothing but watch. That is what the word means, and a viewer
 * that can steer is a collaborator with a misleading label.
 */
const PERMITTED: Readonly<Record<SessionRole, readonly RemoteCommandKind[]>> = {
  // The host is not a remote device; it receives commands rather than sending
  // them, and is listed so the map is total.
  host: [],
  owner: [
    "pause",
    "abort",
    "deny_pending_approval",
    "restrict_to_read_only",
    "send_message",
    "answer_question",
    "approve_pending_approval",
  ],
  approver: [
    "pause",
    "abort",
    "deny_pending_approval",
    "restrict_to_read_only",
    "approve_pending_approval",
  ],
  collaborator: [
    "pause",
    "abort",
    "deny_pending_approval",
    "restrict_to_read_only",
    "send_message",
    "answer_question",
  ],
  viewer: [],
};

export function mayIssue(role: SessionRole, command: RemoteCommandKind): boolean {
  return PERMITTED[role].includes(command);
}

/**
 * Is this command one that only reduces authority?
 *
 * Exported so a host can apply the rule directly rather than re-deriving it:
 * anything not on the tightening list needs the approval path, and a host that
 * hand-rolls that check will eventually disagree with this one.
 */
export function isTightening(command: RemoteCommandKind): boolean {
  return (TIGHTENING_COMMANDS as readonly string[]).includes(command);
}

/**
 * A remote decision is PROVISIONAL until the host confirms it.
 *
 * The relay carries authority requests; it does not manufacture authority. A
 * phone tap is a statement of intent that the host validates against what it
 * actually offered, whether the request is still open, and whether it has
 * expired. Treating the relay's acknowledgement as the decision would let a
 * compromised or merely buggy relay approve things nobody approved.
 */
export type RemoteDecisionState =
  | { readonly kind: "provisional"; readonly submittedAt: string }
  | { readonly kind: "confirmed"; readonly confirmedAt: string }
  | { readonly kind: "rejected_by_host"; readonly reason: RemoteDecisionRejection };

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
] as const;

export type RemoteDecisionRejection = (typeof REMOTE_DECISION_REJECTIONS)[number];
