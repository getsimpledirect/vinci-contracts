import type { Timestamp } from "@vinci/contracts";

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
  return state.kind === "accepted-by-governor" || state.kind === "acted-upon-by-worker";
}
