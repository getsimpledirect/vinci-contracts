import type {
  Actor,
  RunId,
  TerminalState,
  Timestamp,
  VerdictStatus,
  WorkspaceRef,
} from "@vinci/contracts";

/** Branded type for receipt identifiers */
export type ReceiptId = string & { readonly __ReceiptId: never };

/**
 * A receipt records what a run accomplished, with evidence and digest for verification.
 *
 * All identifier fields reference records by id only, never embedding them.
 * The digest covers every field except digest and signature.
 */
export type Receipt = {
  readonly receiptVersion: 1;
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
  readonly finalState: TerminalState;
  readonly actionSummary: string;
  readonly resourcesAccessed: readonly string[];
  readonly changesMade: readonly string[];
  readonly artifactsProduced: readonly string[];
  readonly approvalIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly verdict: VerdictStatus;
  readonly spend: number;
  readonly unresolvedConditions: readonly string[];
  readonly resumeInstructions: string | null;
  readonly rollbackInfo: string | null;
  readonly digest: string;
  readonly signature: string | null;
};

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
