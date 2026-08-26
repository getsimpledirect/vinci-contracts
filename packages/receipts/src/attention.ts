import type { Receipt } from "./receipt.ts";

export type AttentionPerVerifiedOutcome = {
  readonly verifiedOutcomes: number;
  readonly humanSeconds: number;
  readonly secondsPerVerifiedOutcome: number | null;
};

/**
 * Measures institutional cost per verified consequential outcome, not a person.
 *
 * The input records seconds decisions took, never what a person did during
 * them, and carries no per-human identity. Every receipt contributes attention
 * to the numerator; only `VERIFIED_PASS` contributes an outcome. With no
 * verified outcomes the ratio is `null`, never infinity or a misleading zero.
 *
 * A receipt carries no staleness: pass the CURRENT receipt per run. Feeding a
 * superseded receipt and its correction together counts the outcome twice —
 * deduplicating by run is the caller's job, and this function does not guess.
 */
export function attentionPerVerifiedOutcome(
  receipts: readonly Receipt[],
): AttentionPerVerifiedOutcome {
  let verifiedOutcomes = 0;
  let humanSeconds = 0;

  for (const receipt of receipts) {
    humanSeconds += receipt.humanAttention.seconds;
    if (receipt.verdict === "VERIFIED_PASS") verifiedOutcomes += 1;
  }

  return {
    verifiedOutcomes,
    humanSeconds,
    secondsPerVerifiedOutcome:
      verifiedOutcomes === 0 ? null : humanSeconds / verifiedOutcomes,
  };
}
