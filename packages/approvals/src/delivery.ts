import type { Timestamp } from "@getsimpledirect/vinci-contracts";
import { ownData } from "@getsimpledirect/vinci-contracts";

export const DELIVERY_STATE_KINDS = [
  "queued-locally",
  "delivered",
  "accepted-by-governor",
  "acted-upon-by-worker",
] as const;

export type DeliveryStateKind = (typeof DELIVERY_STATE_KINDS)[number];

export type DeliveryState =
  | { readonly kind: "queued-locally" }
  | { readonly kind: "delivered"; readonly deliveredAt: Timestamp }
  | { readonly kind: "accepted-by-governor"; readonly acceptedAt: Timestamp }
  | { readonly kind: "acted-upon-by-worker"; readonly actedUponAt: Timestamp };

export type EffectiveDeliveryState = Extract<
  DeliveryState,
  { readonly kind: "accepted-by-governor" | "acted-upon-by-worker" }
>;

export function isEffectiveDeliveryState(state: DeliveryState): state is EffectiveDeliveryState {
  const kind = ownData(state, "kind");
  return kind === "accepted-by-governor" || kind === "acted-upon-by-worker";
}

/**
 * Position in the delivery sequence. The states are ordered — a decision is
 * queued on the device, delivered to the server, accepted by Governor, then
 * acted upon by the worker (FR-5.6) — and skipping a step means claiming
 * something happened that did not.
 */
const DELIVERY_ORDER: Readonly<Record<DeliveryStateKind, number>> = {
  "queued-locally": 0,
  delivered: 1,
  "accepted-by-governor": 2,
  "acted-upon-by-worker": 3,
};

/**
 * May a delivery state move from `from` to `to`?
 *
 * Forward by exactly one step, or stay put. Not backwards, and not by jumping
 * a step: a decision that reports `acted-upon-by-worker` without ever having
 * been accepted by Governor is asserting that authority was granted when no
 * record of granting it exists. That is indistinguishable, downstream, from an
 * approval that never happened — and it reads as effective, because both of
 * the last two states are effective.
 *
 * The four states existing is not the requirement; their progression is.
 */
export function canAdvanceDelivery(from: DeliveryStateKind, to: DeliveryStateKind): boolean {
  if (!DELIVERY_STATE_KINDS.includes(from) || !DELIVERY_STATE_KINDS.includes(to)) return false;
  const delta = DELIVERY_ORDER[to] - DELIVERY_ORDER[from];
  return delta === 0 || delta === 1;
}

/**
 * The first state every decision starts in. A decision that has not been
 * anywhere is queued locally, never delivered — FR-5.6 requires that an
 * offline approval not appear successful until something confirms it.
 */
export const INITIAL_DELIVERY_STATE: DeliveryState = { kind: "queued-locally" };
