import type { ReceiptId, toReceiptId } from "@getsimpledirect/vinci-contracts";

import type { Receipt } from "./receipt.ts";

type Assert<Condition extends true> = Condition;
type IsExactly<Left, Right> =
  [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

/** Compile-time guard: receipts must use the canonical contracts ReceiptId brand. */
export type ReceiptUsesCanonicalReceiptId = Assert<
  IsExactly<Receipt["receiptId"], ReceiptId>
>;

/** Compile-time guard: the checked constructor must produce Receipt-compatible ids. */
export type CheckedReceiptIdFitsReceipt = Assert<
  Exclude<ReturnType<typeof toReceiptId>, null> extends Receipt["receiptId"] ? true : false
>;
