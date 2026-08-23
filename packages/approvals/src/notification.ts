import {
  CONSEQUENTIAL_ACTION_LABELS,
  type ConsequentialActionClass,
  type Timestamp,
} from "@vinci/contracts";
import type { GrantShape } from "./grant.ts";
import type { ApprovalRequest, RiskLevel } from "./request.ts";

declare const sanitizedTextBrand: unique symbol;
export type SanitizedNotificationText = string & { readonly [sanitizedTextBrand]: true };

const notificationSafeBrand = Symbol("vinci.notification-safe-request");

type UnsafeNotificationFields = {
  readonly approvalId?: never;
  readonly runId?: never;
  readonly worker?: never;
  readonly runObjective?: never;
  readonly reason?: never;
  readonly requestedAction?: never;
  readonly requestedAt?: never;
  readonly affectedResource?: never;
  readonly evidenceId?: never;
  readonly estimatedCostOrImpact?: never;
  readonly controllingPolicy?: never;
  readonly grant?: never;
  readonly diff?: never;
  readonly source?: never;
  readonly rawCode?: never;
  readonly credentials?: never;
  readonly customer?: never;
  readonly personalInformation?: never;
};

/**
 * The private symbol makes this constructible only by the safe projection, and
 * explicit `never` fields stop known sensitive request fields hitching a ride
 * through an object spread. The symbol is non-enumerable at runtime.
 */
export type NotificationSafeRequest = UnsafeNotificationFields & {
  readonly [notificationSafeBrand]: true;
  readonly actionSummary: SanitizedNotificationText;
  readonly actionClass: ConsequentialActionClass;
  readonly riskLevel: RiskLevel;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly timestamp: Timestamp;
  readonly approvalDuration: SanitizedNotificationText;
};

export function notificationSafeProjection(request: ApprovalRequest): NotificationSafeRequest {
  const projection = {
    // Every string below is authored in this repository. Nothing a human typed
    // into the request — the objective, the reason, the resource name, the
    // requested action — reaches a push payload, because there is no way to
    // scrub free text reliably and a notification is the one place FR-5.4 and
    // SR-3 forbid getting it wrong.
    //
    // A regex denylist stood here previously. It passed an AWS key id, a
    // GitHub token, a person's name and a street address, all verbatim.
    actionClass: request.actionClass,
    actionSummary: (`Vinci needs approval to ${CONSEQUENTIAL_ACTION_LABELS[request.actionClass]}.`) as SanitizedNotificationText,
    riskLevel: request.riskLevel,
    policyId: request.controllingPolicy.policyId,
    policyVersion: request.controllingPolicy.policyVersion,
    timestamp: request.requestedAt,
    approvalDuration: describeGrant(request.grant),
  };
  // Frozen. The unsafe fields are declared `?: never` and the result is
  // branded, but both are compile-time only: at runtime a caller could simply
  // assign `payload.reason = "ghp_..."` and put free text back into a push
  // payload. That is the same brand-erased-at-runtime shape as a digest field
  // validated as "a non-empty string".
  Object.defineProperty(projection, notificationSafeBrand, {
    value: true,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(projection) as NotificationSafeRequest;
}

function describeGrant(grant: GrantShape): SanitizedNotificationText {
  let description: string;
  switch (grant.kind) {
    case "deny": description = "No approval duration; the action is prohibited."; break;
    case "allow-automatically": description = "No approval is required."; break;
    case "require-person": description = "Until the named approver responds."; break;
    case "require-role": description = "Until an eligible role member responds."; break;
    case "require-two-people": description = "Until two distinct people approve."; break;
    case "expire-at": description = `Until ${grant.expiresAt}.`; break;
    case "allow-once": description = "For one use only."; break;
    case "allow-remainder-of-run": description = "For the remainder of this run."; break;
    case "allow-bounded": description = `For up to ${naturalDuration(grant.durationMs)} on one resource.`; break;
  }
  return description as SanitizedNotificationText;
}

function naturalDuration(durationMs: number): string {
  if (durationMs % 3_600_000 === 0) {
    const hours = durationMs / 3_600_000;
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (durationMs % 60_000 === 0) {
    const minutes = durationMs / 60_000;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  if (durationMs % 1_000 === 0) {
    const seconds = durationMs / 1_000;
    return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }
  return `${durationMs} milliseconds`;
}
