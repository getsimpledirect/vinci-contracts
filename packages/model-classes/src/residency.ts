import type { Actor, RunId, Timestamp } from "@getsimpledirect/vinci-contracts";
import type { ExplicitValue, ProcessingLocation } from "./vocabulary.ts";

/**
 * DR-5 requires four independent facts. Deliberately no aggregate
 * `canadianHosted` flag exists because it would overstate mixed-location runs.
 */
export type ResidencyRecord = {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly recordedAt: Timestamp;
  readonly recordedBy: Actor;
  readonly accountDataLocation: ExplicitValue<ProcessingLocation>;
  readonly projectContentLocation: ExplicitValue<ProcessingLocation>;
  readonly inferenceLocation: ExplicitValue<ProcessingLocation>;
  readonly verificationLocation: ExplicitValue<ProcessingLocation>;
};
