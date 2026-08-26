import {
  fail,
  ok,
  ownData,
  toPlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { validateSessionBindingRef, type SessionBindingRef } from "./binding-ref.ts";
import { issue, prefixIssues, rejectUnknownFields } from "./wire-validation.ts";

/**
 * A control-plane response saying a replay cursor predates the relay ring.
 * This is NOT a SessionFrame and must not be persisted or rendered as session
 * content.
 */
export type ReplayGap = {
  readonly schemaVersion: 1;
  readonly binding: SessionBindingRef;
  readonly requestedSeq: number;
  readonly oldestAvailableSeq: number;
  readonly newestAvailableSeq: number;
};

const FIELDS = [
  "schemaVersion",
  "binding",
  "requestedSeq",
  "oldestAvailableSeq",
  "newestAvailableSeq",
] as const;

function isSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && !Object.is(value, -0);
}

export function validateReplayGap(input: unknown): ValidationResult<ReplayGap> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const negativeZeroFields = new Set(
    ["requestedSeq", "oldestAvailableSeq", "newestAvailableSeq"].filter(
      (field) => Object.is(ownData(input, field), -0),
    ),
  );
  const record = plain.value;
  const issues: ValidationIssue[] = [];
  rejectUnknownFields(record, FIELDS, "", issues);

  if (record.schemaVersion !== REPLAY_GAP_SCHEMA_META.version) {
    issues.push(issue("/schemaVersion", "schema_version_mismatch", "unsupported replay-gap schema version"));
  }
  const binding = validateSessionBindingRef(record.binding);
  if (!binding.ok) prefixIssues("/binding", binding.issues, issues);

  for (const field of ["requestedSeq", "oldestAvailableSeq", "newestAvailableSeq"] as const) {
    if (!isSequence(record[field]) || negativeZeroFields.has(field)) {
      issues.push(issue(`/${field}`, "invalid_sequence", `${field} must be a non-negative safe integer other than -0`));
    }
  }
  if (isSequence(record.requestedSeq)
      && isSequence(record.oldestAvailableSeq)
      && isSequence(record.newestAvailableSeq)
      && !(record.requestedSeq < record.oldestAvailableSeq
        && record.oldestAvailableSeq <= record.newestAvailableSeq)) {
    issues.push(issue(
      "/requestedSeq",
      "invalid_replay_gap",
      "requestedSeq must be less than oldestAvailableSeq, which must not exceed newestAvailableSeq",
    ));
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as ReplayGap);
}

export const REPLAY_GAP_SCHEMA_META = {
  id: "vinci.replay-gap",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
} as const satisfies SchemaMeta;
