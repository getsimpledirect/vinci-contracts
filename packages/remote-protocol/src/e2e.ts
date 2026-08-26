import {
  fail,
  isCanonicalTimestamp,
  ok,
  toPlainRecord,
  type DeviceId,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { validateSessionBindingRef, type SessionBindingRef } from "./binding-ref.ts";
import {
  isBase64Url,
  issue,
  prefixIssues,
  rejectUnknownFields,
  validateId,
} from "./wire-validation.ts";

/** Mandatory Wave 1 cryptographic suite, represented as data rather than code. */
export const E2E_SUITE_V1 = {
  id: "vinci-e2e-1",
  keyAgreement: "X25519",
  signature: "Ed25519",
  aead: "XChaCha20-Poly1305",
  kdf: "HKDF-SHA-256",
} as const;

/**
 * One host-generated session content key wrapped to one authorized device.
 *
 * A new session MUST generate a new content key and never reuse a prior
 * session's key. Removing a device MUST rotate the surviving session's key
 * before future content is sent. This package validates the record only; it
 * performs no key agreement, wrapping, rotation, or other cryptography.
 */
export type SessionKeyWrap = {
  readonly schemaVersion: 1;
  readonly binding: SessionBindingRef;
  readonly suiteId: typeof E2E_SUITE_V1.id;
  readonly recipientDeviceId: DeviceId;
  readonly recipientKeyId: string;
  readonly ephemeralPublicKey: string;
  readonly wrappedKey: string;
  readonly createdAt: string;
};

const FIELDS = [
  "schemaVersion",
  "binding",
  "suiteId",
  "recipientDeviceId",
  "recipientKeyId",
  "ephemeralPublicKey",
  "wrappedKey",
  "createdAt",
] as const;

export function validateSessionKeyWrap(input: unknown): ValidationResult<SessionKeyWrap> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];
  rejectUnknownFields(record, FIELDS, "", issues);

  if (record.schemaVersion !== SESSION_KEY_WRAP_SCHEMA_META.version) {
    issues.push(issue("/schemaVersion", "schema_version_mismatch", "unsupported session-key-wrap schema version"));
  }
  const binding = validateSessionBindingRef(record.binding);
  if (!binding.ok) prefixIssues("/binding", binding.issues, issues);
  if (record.suiteId !== E2E_SUITE_V1.id) {
    issues.push(issue("/suiteId", "unsupported_suite", `suiteId must be ${E2E_SUITE_V1.id}`));
  }
  validateId(record.recipientDeviceId, "/recipientDeviceId", issues);
  validateId(record.recipientKeyId, "/recipientKeyId", issues);
  for (const field of ["ephemeralPublicKey", "wrappedKey"] as const) {
    if (!isBase64Url(record[field])) {
      issues.push(issue(`/${field}`, "invalid_base64url", `${field} must be unpadded base64url`));
    }
  }
  if (!isCanonicalTimestamp(record.createdAt)) {
    issues.push(issue("/createdAt", "invalid_timestamp", "createdAt must be a canonical UTC timestamp"));
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as SessionKeyWrap);
}

export const SESSION_KEY_WRAP_SCHEMA_META = {
  id: "vinci.session-key-wrap",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
} as const satisfies SchemaMeta;
