import {
  actorFieldsAreConsistent,
  fail,
  hasField,
  isActorKind,
  isCanonicalTimestamp,
  ok,
  toPlainRecord,
  type PlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@vinci/contracts";
import { receiptDigest } from "./digest.ts";
import type { Correction } from "./correction.ts";
import type { Receipt } from "./receipt.ts";
import type { VerificationRecord } from "./verdict.ts";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

function isTerminalState(value: unknown): value is string {
  return typeof value === "string" && ["DONE", "DONE_UNVERIFIED", "BLOCKED", "FAILED", "CANCELLED"].includes(value);
}

function isVerdictStatus(value: unknown): value is string {
  return typeof value === "string" && ["VERIFIED_PASS", "VERIFIED_FAIL", "CONDITIONAL", "UNVERIFIED"].includes(value);
}

function validateActor(raw: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push(issue(path, "invalid_actor", "an actor is an object"));
    return;
  }
  const actor = raw as Record<string, unknown>;
  if (!isActorKind(actor.kind)) {
    issues.push(issue(`${path}/kind`, "invalid_actor_kind", "unrecognised actor kind"));
    return;
  }
  if (!actorFieldsAreConsistent(actor)) {
    issues.push(issue(path, "actor_identity_mismatch", "actor carries a field that kind does not permit"));
  }
  // Validate required id fields based on kind
  const requiredField = actor.kind === "user" ? "userId" : actor.kind === "worker" ? "workerId" : actor.kind === "system" ? "component" : actor.kind === "policy" ? "policyId" : "verifierId";
  if (!hasField(actor as PlainRecord, requiredField)) {
    issues.push(issue(`${path}/${requiredField}`, "required_field", `${requiredField} is required for ${actor.kind}`));
  }
  if (hasField(actor as PlainRecord, requiredField) && typeof actor[requiredField] !== "string") {
    issues.push(issue(`${path}/${requiredField}`, "invalid_id", "an identifier must be a string"));
  }
}

function validateWorkspace(raw: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push(issue(path, "invalid_workspace", "workspace is an object"));
    return;
  }
  const ws = raw as Record<string, unknown>;
  if (ws.kind === "personal") {
    if (hasField(ws as PlainRecord, "organizationId")) {
      issues.push(issue(path, "workspace_arm_mismatch", "personal workspace cannot carry organizationId"));
    }
  } else if (ws.kind === "organization") {
    if (!hasField(ws as PlainRecord, "organizationId")) {
      issues.push(issue(`${path}/organizationId`, "required_field", "organization workspace requires organizationId"));
    }
  }
}

export function validateReceipt(input: unknown): ValidationResult<Receipt> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;

  const issues: ValidationIssue[] = [];
  const unknownFields: Record<string, unknown> = {};

  const KNOWN_FIELDS = new Set([
    "receiptVersion", "receiptId", "runId", "objective", "workspace", "requester", "worker",
    "modelId", "providerId", "executionLocation", "policyId", "policyVersion", "startedAt",
    "completedAt", "activeDuration", "finalState", "actionSummary", "resourcesAccessed",
    "changesMade", "artifactsProduced", "approvalIds", "evidenceIds", "verdict", "spend",
    "unresolvedConditions", "resumeInstructions", "rollbackInfo", "digest", "signature",
  ]);

  for (const [key, value] of Object.entries(record)) {
    if (!KNOWN_FIELDS.has(key)) {
      unknownFields[`/${key}`] = value;
    }
  }

  if (record.receiptVersion !== 1) {
    issues.push(issue("/receiptVersion", "invalid_schema_version", "receipt schema is version 1"));
  }

  for (const field of ["receiptId", "runId"] as const) {
    const value = record[field];
    if (typeof value !== "string" || !ID_PATTERN.test(value)) {
      issues.push(issue(`/${field}`, "invalid_id", "an identifier is at most 128 safe characters"));
    }
  }

  if (typeof record.objective !== "string") {
    issues.push(issue("/objective", "invalid_type", "objective must be a string"));
  }

  validateWorkspace(record.workspace, "/workspace", issues);
  validateActor(record.requester, "/requester", issues);
  validateActor(record.worker, "/worker", issues);

  if (typeof record.modelId !== "string") {
    issues.push(issue("/modelId", "invalid_type", "modelId must be a string"));
  }

  if (typeof record.providerId !== "string") {
    issues.push(issue("/providerId", "invalid_type", "providerId must be a string"));
  }

  if (typeof record.executionLocation !== "string") {
    issues.push(issue("/executionLocation", "invalid_type", "executionLocation must be a string"));
  }

  if (typeof record.policyId !== "string" || !ID_PATTERN.test(record.policyId)) {
    issues.push(issue("/policyId", "invalid_id", "policyId must be an identifier"));
  }

  if (typeof record.policyVersion !== "number" || !Number.isSafeInteger(record.policyVersion) || record.policyVersion < 1) {
    issues.push(issue("/policyVersion", "invalid_version", "policyVersion must be a positive integer"));
  }

  if (!isCanonicalTimestamp(record.startedAt)) {
    issues.push(issue("/startedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z"));
  }

  if (!isCanonicalTimestamp(record.completedAt)) {
    issues.push(issue("/completedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z"));
  }

  if (typeof record.activeDuration !== "number" || !Number.isSafeInteger(record.activeDuration) || record.activeDuration < 0) {
    issues.push(issue("/activeDuration", "invalid_duration", "activeDuration must be a non-negative safe integer"));
  }

  if (!isTerminalState(record.finalState)) {
    issues.push(issue("/finalState", "invalid_state", "finalState must be a terminal state"));
  }

  if (typeof record.actionSummary !== "string") {
    issues.push(issue("/actionSummary", "invalid_type", "actionSummary must be a string"));
  }

  for (const field of ["resourcesAccessed", "changesMade", "artifactsProduced", "approvalIds", "evidenceIds", "unresolvedConditions"] as const) {
    if (!Array.isArray(record[field]) || !record[field].every((item: unknown) => typeof item === "string")) {
      issues.push(issue(`/${field}`, "invalid_array", `${field} must be an array of strings`));
    }
  }

  if (!isVerdictStatus(record.verdict)) {
    issues.push(issue("/verdict", "invalid_verdict", "verdict must be a valid verdict status"));
  }

  if (typeof record.spend !== "number" || !Number.isSafeInteger(record.spend) || record.spend < 0) {
    issues.push(issue("/spend", "invalid_spend", "spend must be a non-negative safe integer"));
  }

  if (record.resumeInstructions !== null && typeof record.resumeInstructions !== "string") {
    issues.push(issue("/resumeInstructions", "invalid_type", "resumeInstructions must be a string or null"));
  }

  if (record.rollbackInfo !== null && typeof record.rollbackInfo !== "string") {
    issues.push(issue("/rollbackInfo", "invalid_type", "rollbackInfo must be a string or null"));
  }

  if (typeof record.digest !== "string" || !DIGEST_PATTERN.test(record.digest)) {
    issues.push(issue("/digest", "invalid_digest", "digest must be 64 lowercase hex characters"));
  } else {
    const computed = receiptDigest(record as unknown as Receipt);
    if (computed !== record.digest) {
      issues.push(issue("/digest", "digest_mismatch", "digest does not match current content"));
    }
  }

  if (record.signature !== null && typeof record.signature !== "string") {
    issues.push(issue("/signature", "invalid_type", "signature must be a string or null"));
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as Receipt, unknownFields);
}

export function validateVerificationRecord(input: unknown): ValidationResult<VerificationRecord> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;

  const issues: ValidationIssue[] = [];

  if (typeof record.status !== "string") {
    issues.push(issue("/status", "invalid_type", "status must be a string"));
    if (issues.length > 0) return fail(issues);
  }

  if (record.status === "unverified") {
    const allowedKeys = new Set(["status"]);
    for (const key of Object.keys(record)) {
      if (!allowedKeys.has(key)) {
        issues.push(issue(`/${key}`, "unexpected_field", `unverified status cannot carry ${key}`));
      }
    }
  } else if (record.status === "verified") {
    for (const required of ["verifierId", "verifiedAt", "independent", "subjectDigest"]) {
      if (!hasField(record as PlainRecord, required)) {
        issues.push(issue(`/${required}`, "required_field", `verified status requires ${required}`));
      }
    }
    if (typeof record.verifierId !== "string") {
      issues.push(issue("/verifierId", "invalid_id", "verifierId must be a string"));
    }
    if (!isCanonicalTimestamp(record.verifiedAt)) {
      issues.push(issue("/verifiedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z"));
    }
    if (typeof record.independent !== "boolean") {
      issues.push(
        issue(
          "/independent",
          "required_field",
          "a verified record must state whether the verifier was independent; FR-7.3 requires non-independence to be disclosed, not omitted",
        ),
      );
    }
    if (typeof record.subjectDigest !== "string" || !/^[0-9a-f]{64}$/.test(record.subjectDigest)) {
      issues.push(
        issue(
          "/subjectDigest",
          "invalid_digest",
          "a verified record must bind to the exact content it was issued against",
        ),
      );
    }
    const allowedKeys = new Set(["status", "verifierId", "verifiedAt", "independent", "subjectDigest"]);
    for (const key of Object.keys(record)) {
      if (!allowedKeys.has(key)) {
        issues.push(issue(`/${key}`, "unexpected_field", `verified status cannot carry ${key}`));
      }
    }
  } else if (record.status === "invalidated") {
    if (!hasField(record as PlainRecord, "reason") || typeof record.reason !== "string" || record.reason === "") {
      issues.push(issue("/reason", "required_field", "invalidated status requires a non-empty reason"));
    }
    const allowedKeys = new Set(["status", "reason"]);
    for (const key of Object.keys(record)) {
      if (!allowedKeys.has(key)) {
        issues.push(issue(`/${key}`, "unexpected_field", `invalidated status cannot carry ${key}`));
      }
    }
  } else {
    issues.push(issue("/status", "unknown_status", `unknown verification status: ${String(record.status)}`));
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as VerificationRecord, {});
}

export function validateCorrection(input: unknown): ValidationResult<Correction> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;

  const issues: ValidationIssue[] = [];

  if (typeof record.correctionId !== "string" || !ID_PATTERN.test(record.correctionId)) {
    issues.push(issue("/correctionId", "invalid_id", "correctionId must be an identifier"));
  }

  if (typeof record.supersedes !== "string" || !ID_PATTERN.test(record.supersedes)) {
    issues.push(issue("/supersedes", "invalid_id", "supersedes must be an identifier"));
  }

  validateActor(record.actor, "/actor", issues);

  if (!Array.isArray(record.correctedFields) || record.correctedFields.length === 0 || !record.correctedFields.every((f: unknown) => typeof f === "string")) {
    issues.push(issue("/correctedFields", "invalid_array", "correctedFields must be a non-empty array of strings"));
  }

  if (typeof record.reason !== "string") {
    issues.push(issue("/reason", "invalid_type", "reason must be a string"));
  }

  const newReceiptResult = validateReceipt(record.newReceipt);
  if (!newReceiptResult.ok) {
    issues.push(issue("/newReceipt", "invalid_receipt", "newReceipt must be a valid receipt"));
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as Correction, {});
}

export const RECEIPT_SCHEMA_META: SchemaMeta = {
  id: "vinci.receipt",
  version: 1,
  compatibility: "frozen",
  unknownFields: "preserve",
  malformedData: "fail-closed",
  migration: "none",
};

export const VERIFICATION_STATUS_SCHEMA_META: SchemaMeta = {
  id: "vinci.verification-status",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};

export const CORRECTION_SCHEMA_META: SchemaMeta = {
  id: "vinci.correction",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
