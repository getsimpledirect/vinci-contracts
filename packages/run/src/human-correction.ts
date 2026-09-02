import {
  fail,
  isCanonicalTimestamp,
  isDigest,
  isIdentifier,
  isNonBlankText,
  ok,
  plainActor,
  toPlainRecord,
  type Actor,
  type RunId,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { digestValidated } from "./digest.ts";
import { isEnumMember, isObjectRecord, isPositiveInt, issue, rejectUnknownFields } from "./lib/validate.ts";

/**
 * A human's recorded correction of something a run did.
 *
 * Corrections are the training signal the institution actually learns from,
 * so each one is pinned to the exact point it applies to: the run, the event
 * sequence at which the corrected behaviour happened, the model and runtime
 * build that produced it, and the digest of the context manifest the model
 * was working from. Without those a correction is an anecdote; with them it
 * is reproducible. `correctionType` is a closed set so corrections can be
 * counted by kind rather than by re-reading prose.
 */
export type HumanCorrection = {
  readonly schemaVersion: 1;
  readonly correctionId: string;
  readonly runId: RunId;
  readonly eventSequence: number;
  readonly modelId: string;
  readonly runtimeBuild: string;
  readonly contextManifestDigest: string;
  readonly correctionType: CorrectionType;
  readonly correctedOutcomeDigest: string;
  /** Who corrected. Snapshotted through plainActor, so a proxy cannot lie about it. */
  readonly correctedBy: Actor;
  readonly recordedAt: string;
};

export const CORRECTION_TYPES = [
  "wrong_objective",
  "wrong_priority",
  "wrong_route",
  "missing_context",
  "bad_evidence",
  "scope_creep",
  "premature_completion",
  "over_cautious_refusal",
  "unsafe_action",
  "poor_judgment",
  "unnecessary_escalation",
  "bad_presentation",
] as const;
export type CorrectionType = (typeof CORRECTION_TYPES)[number];

/** Validate a human correction from untrusted input. */
export function validateHumanCorrection(input: unknown): ValidationResult<HumanCorrection> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  rejectUnknownFields(
    record,
    [
      "schemaVersion", "correctionId", "runId", "eventSequence", "modelId", "runtimeBuild",
      "contextManifestDigest", "correctionType", "correctedOutcomeDigest", "correctedBy", "recordedAt",
    ],
    "",
    "a human correction",
    issues,
  );

  if (record.schemaVersion !== 1) {
    issues.push(issue("/schemaVersion", "invalid_schema_version", "this schema is version 1"));
  }
  for (const field of ["correctionId", "runId"] as const) {
    if (!isIdentifier(record[field])) {
      issues.push(issue(`/${field}`, "invalid_id", `${field} is an identifier`));
    }
  }
  if (!isPositiveInt(record.eventSequence)) {
    issues.push(issue("/eventSequence", "invalid_sequence", "eventSequence is an integer of at least 1"));
  }
  for (const field of ["modelId", "runtimeBuild"] as const) {
    if (!isNonBlankText(record[field])) {
      issues.push(issue(`/${field}`, "required_field", `${field} must be non-blank text`));
    }
  }
  for (const field of ["contextManifestDigest", "correctedOutcomeDigest"] as const) {
    if (!isDigest(record[field])) {
      issues.push(issue(`/${field}`, "invalid_digest", `${field} is 64 lowercase hex characters`));
    }
  }
  if (!isEnumMember(record.correctionType, CORRECTION_TYPES)) {
    issues.push(issue("/correctionType", "unknown_correction_type", "correctionType must come from CORRECTION_TYPES"));
  }
  if (!isObjectRecord(record.correctedBy) || plainActor(record.correctedBy) === null) {
    issues.push(issue("/correctedBy", "invalid_actor", "correctedBy must be a consistent actor"));
  }
  if (!isCanonicalTimestamp(record.recordedAt)) {
    issues.push(
      issue("/recordedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z"),
    );
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as HumanCorrection, {});
}

/** The identity of a correction: SHA-256 over the canonical, validated record. */
export function humanCorrectionDigest(correction: HumanCorrection): string {
  return digestValidated("human correction", validateHumanCorrection(correction));
}

export const HUMAN_CORRECTION_SCHEMA_META: SchemaMeta = {
  id: "vinci.human-correction",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
