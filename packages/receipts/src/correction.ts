import type { Actor } from "@vinci/contracts";
import type { Receipt, ReceiptId } from "./receipt.ts";

/**
 * A new record carrying a corrected receipt.
 *
 * A correction appends rather than overwrites. Lineage is checkable via `supersedes`,
 * and a chain that rewrites the same receipt id rather than appending new ids is detectable.
 *
 * Append-only enforcement is a consumer responsibility (database triggers, etc.);
 * this package makes violations visible rather than preventing them.
 */
export type Correction = {
  readonly correctionId: ReceiptId;
  readonly supersedes: ReceiptId;
  readonly actor: Actor;
  readonly correctedFields: readonly string[];
  readonly reason: string;
  readonly newReceipt: Receipt;
};
