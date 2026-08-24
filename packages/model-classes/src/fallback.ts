import type { Actor, RunId, Timestamp } from "@getsimpledirect/vinci-contracts";
import type { ExplicitValue, ModelProvider, ProcessingLocation } from "./vocabulary.ts";

type FallbackPolicyDecision = {
  readonly policyId: string;
  readonly policyVersion: number;
  readonly reasonCode: string;
};

/**
 * `outcome` and `permitted` are coupled so an applied, policy-denied fallback
 * cannot be constructed. A blocked attempt remains recordable for audit.
 */
export type FallbackRecord = {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly recordedAt: Timestamp;
  readonly recordedBy: Actor;
  readonly source: {
    readonly provider: ExplicitValue<ModelProvider>;
    readonly jurisdiction: ExplicitValue<ProcessingLocation>;
  };
  readonly destination: {
    readonly provider: ModelProvider;
    readonly jurisdiction: ProcessingLocation;
  };
} & (
  | {
      readonly outcome: "applied";
      readonly policyDecision: FallbackPolicyDecision & { readonly permitted: true };
    }
  | {
      readonly outcome: "blocked";
      readonly policyDecision: FallbackPolicyDecision & { readonly permitted: false };
    }
);

/**
 * Every provenance record carries one of these arms. A material fallback can
 * only be represented by embedding its complete audit record; `unknown` is an
 * explicit honest disclosure, never silent omission.
 */
export type MaterialFallbackDisclosure =
  | { readonly kind: "not-used" }
  | { readonly kind: "used"; readonly record: FallbackRecord }
  | { readonly kind: "unknown" };
