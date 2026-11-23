import type { Actor, ReceiptId } from "@getsimpledirect/vinci-contracts";

import type { Correction } from "./correction.ts";
import type { Receipt } from "./receipt.ts";

type Assert<Condition extends true> = Condition;
type IsExactly<Left, Right> =
  [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;

export type CorrectionIdUsesCanonicalReceiptId = Assert<
  IsExactly<Correction["correctionId"], ReceiptId>
>;

export type SupersedesUsesCanonicalReceiptId = Assert<
  IsExactly<Correction["supersedes"], ReceiptId>
>;

export type CorrectedFieldsUseReadonlyStringArray = Assert<
  IsExactly<Correction["correctedFields"], readonly string[]>
>;

export type NewReceiptRequiresFullReceipt = Assert<
  IsExactly<Correction["newReceipt"], Receipt>
>;

function _checkCorrection(
  correctionId: ReceiptId,
  supersedes: ReceiptId,
  actor: Actor,
  newReceipt: Receipt,
): void {
  const details = {
    correctionId,
    supersedes,
    actor,
    correctedFields: ["objective"] as const,
    reason: "The original objective was incomplete",
  };
  const correction: Correction = { ...details, newReceipt };

  // @ts-expect-error correctionId requires a branded ReceiptId.
  const _rawCorrectionId: Correction = { ...correction, correctionId: "correction-1" };
  // @ts-expect-error supersedes requires a branded ReceiptId.
  const _rawSupersedes: Correction = { ...correction, supersedes: "receipt-1" };
  // @ts-expect-error A correction requires the corrected receipt.
  const _missingNewReceipt: Correction = details;

  // @ts-expect-error The correctedFields property cannot be reassigned.
  correction.correctedFields = ["reason"];
  // @ts-expect-error The correctedFields array cannot be mutated.
  correction.correctedFields.push("reason");
}
