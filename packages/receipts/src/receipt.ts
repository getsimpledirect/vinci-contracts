import type {
  Actor,
  ReceiptId,
  RunId,
  TerminalState,
  Timestamp,
  VerdictStatus,
  WorkspaceRef,
} from "@getsimpledirect/vinci-contracts";

export type { ReceiptId } from "@getsimpledirect/vinci-contracts";

export type HumanAttention = {
  readonly seconds: number;
  readonly interruptions: number;
  readonly decisions: number;
  readonly escalations: number;
};

/**
 * A receipt records what a run accomplished, with evidence and digest for verification.
 *
 * All identifier fields reference records by id only, never embedding them.
 * The digest covers every field except digest and signature.
 *
 * Version 3 (from 2): `verdict` may be `null`. Version 2 required one of the
 * three verifier statuses on every receipt, including receipts whose
 * `finalState` says the run never produced anything to assess — a FAILED run
 * had to carry a verdict about work that does not exist. That is the latent
 * contradiction the three outcome dimensions (contracts `OutcomeTriple`)
 * make explicit: assurance is a separate axis from execution, and when
 * execution ended in WAITING, BLOCKED, FAILED or CANCELLED there is nothing
 * for the assurance axis to say. `null` is that statement. It is permitted
 * ONLY on those final states — see `validateReceipt` — so a DONE or
 * DONE_UNVERIFIED receipt still cannot be written without saying what a
 * verifier concluded.
 *
 * WAITING is in that set for the same reason as the other three: a run paused
 * for approval has produced nothing a verifier has assessed, so requiring a
 * verdict would force the receipt to state a conclusion no verifier reached.
 */
export type Receipt = {
  readonly receiptVersion: 3;
  readonly receiptId: ReceiptId;
  readonly runId: RunId;
  readonly objective: string;
  readonly workspace: WorkspaceRef;
  readonly requester: Actor;
  readonly worker: Actor;
  readonly modelId: string;
  readonly providerId: string;
  readonly executionLocation: string;
  readonly policyId: string;
  readonly policyVersion: number;
  readonly startedAt: Timestamp;
  readonly completedAt: Timestamp;
  readonly activeDuration: number;
  /**
   * Institutional-cost measurement, never a measurement of a person.
   *
   * `seconds` records how long presented decisions took. It never records what
   * a person did during that time, and this block carries no per-human identity.
   */
  readonly humanAttention: HumanAttention;
  readonly finalState: TerminalState;
  readonly actionSummary: string;
  readonly resourcesAccessed: readonly string[];
  readonly changesMade: readonly string[];
  readonly artifactsProduced: readonly string[];
  readonly approvalIds: readonly string[];
  readonly evidenceIds: readonly string[];
  /**
   * What a verifier concluded, or `null` when execution ended without an
   * artifact to assess. Never `null` on a DONE or DONE_UNVERIFIED receipt.
   */
  readonly verdict: VerdictStatus | null;
  readonly spend: number;
  readonly unresolvedConditions: readonly string[];
  readonly resumeInstructions: string | null;
  readonly rollbackInfo: string | null;
  readonly digest: string;
  readonly signature: string | null;
};

/** Every field declared by the receipt schema, including the two not digested. */
export const RECEIPT_DECLARED_FIELDS = [
  "receiptVersion",
  "receiptId",
  "runId",
  "objective",
  "workspace",
  "requester",
  "worker",
  "modelId",
  "providerId",
  "executionLocation",
  "policyId",
  "policyVersion",
  "startedAt",
  "completedAt",
  "activeDuration",
  "humanAttention",
  "finalState",
  "actionSummary",
  "resourcesAccessed",
  "changesMade",
  "artifactsProduced",
  "approvalIds",
  "evidenceIds",
  "verdict",
  "spend",
  "unresolvedConditions",
  "resumeInstructions",
  "rollbackInfo",
  "digest",
  "signature",
] as const satisfies readonly (keyof Receipt)[];

export const RECEIPT_COVERED_FIELDS = [
  "receiptVersion",
  "receiptId",
  "runId",
  "objective",
  "workspace",
  "requester",
  "worker",
  "modelId",
  "providerId",
  "executionLocation",
  "policyId",
  "policyVersion",
  "startedAt",
  "completedAt",
  "activeDuration",
  "humanAttention",
  "finalState",
  "actionSummary",
  "resourcesAccessed",
  "changesMade",
  "artifactsProduced",
  "approvalIds",
  "evidenceIds",
  "verdict",
  "spend",
  "unresolvedConditions",
  "resumeInstructions",
  "rollbackInfo",
] as const;
