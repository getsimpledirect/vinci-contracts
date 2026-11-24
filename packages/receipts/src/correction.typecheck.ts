import type { Actor, ReceiptId } from "@getsimpledirect/vinci-contracts";

import type { Correction } from "./correction.ts";
import type { Receipt } from "./receipt.ts";

type Assert<Condition extends true> = Condition;
// Mutual assignability is not exactness: `any` is assignable both ways to every
// type. Comparing two deferred conditional types is true only for identical types.
type IsExactly<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends (<T>() => T extends Right ? 1 : 2) ? true : false;
type IsFalse<Condition extends false> = Condition;
// `any` without the lint-banned keyword: JSON.parse is declared to return it.
type AnyValue = ReturnType<typeof JSON.parse>;

export type AnyValueIsAny = Assert<0 extends 1 & AnyValue ? true : false>;

export type ExactnessRejectsAnyOnTheLeft = IsFalse<IsExactly<AnyValue, Receipt>>;
export type ExactnessRejectsAnyOnTheRight = IsFalse<IsExactly<Receipt, AnyValue>>;
export type ExactnessRejectsUnknown = IsFalse<IsExactly<unknown, Receipt>>;
export type ExactnessRejectsNever = IsFalse<IsExactly<never, Receipt>>;
export type ExactnessAcceptsItself = Assert<IsExactly<Receipt, Receipt>>;

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
