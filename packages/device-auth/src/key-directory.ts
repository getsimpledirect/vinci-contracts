import {
  fail,
  hasField,
  isCanonicalTimestamp,
  isIdentifier,
  ok,
  ownData,
  toPlainRecord,
  type PlainRecord,
  type SchemaMeta,
  type Timestamp,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import {
  decodeCanonicalBase64Url,
  DEVICE_PUBLIC_KEY_KINDS,
  type DevicePublicKey,
  type DevicePublicKeyKind,
} from "./credential.ts";

export const KEY_ROLES = ["platform-issuer", "device-signer", "host-signer"] as const;
export type KeyRole = (typeof KEY_ROLES)[number];

export const KEY_DIRECTORY_STATUSES = ["active", "revoked"] as const;
export type KeyDirectoryStatus = (typeof KEY_DIRECTORY_STATUSES)[number];

export const KEY_DIRECTORY_FAILURE_REASONS = ["not_found", "revoked", "expired"] as const;
export type KeyDirectoryFailureReason = (typeof KEY_DIRECTORY_FAILURE_REASONS)[number];

export type KeyDirectoryRequest = {
  readonly schemaVersion: 1;
  readonly keyId: string;
};

export type KeyDirectoryEntry = {
  readonly schemaVersion: 1;
  readonly keyId: string;
  readonly role: KeyRole;
  readonly key: DevicePublicKey;
  readonly validFrom: Timestamp;
  readonly validUntil?: Timestamp;
  readonly supersededBy?: string;
  readonly refreshAfter: Timestamp;
  readonly status: KeyDirectoryStatus;
};

export type KeyDirectoryResponse =
  | {
      readonly schemaVersion: 1;
      readonly found: true;
      readonly entry: KeyDirectoryEntry;
    }
  | {
      readonly schemaVersion: 1;
      readonly found: false;
      readonly keyId: string;
      readonly reason: KeyDirectoryFailureReason;
    };

const FOUND_FIELDS = new Set(["schemaVersion", "found", "entry"]);
const NOT_FOUND_FIELDS = new Set(["schemaVersion", "found", "keyId", "reason"]);
const ENTRY_FIELDS = new Set([
  "schemaVersion",
  "keyId",
  "role",
  "key",
  "validFrom",
  "validUntil",
  "supersededBy",
  "refreshAfter",
  "status",
]);
const PUBLIC_KEY_FIELDS = new Set(["kind", "keyId", "key"]);

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

function rejectUnknownFields(
  record: PlainRecord,
  known: ReadonlySet<string>,
  path: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      issues.push(issue(`${path}/${key}`, "unknown_field", "the key-directory wire shape is closed"));
    }
  }
}

function recordAt(
  value: PlainRecord[string] | undefined,
  path: string,
  issues: ValidationIssue[],
): PlainRecord | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as PlainRecord;
  }
  issues.push(issue(path, "invalid_record", "expected a record"));
  return undefined;
}

function validatePublicKey(
  value: PlainRecord[string] | undefined,
  path: string,
  issues: ValidationIssue[],
): DevicePublicKey | undefined {
  const record = recordAt(value, path, issues);
  if (record === undefined) return undefined;
  rejectUnknownFields(record, PUBLIC_KEY_FIELDS, path, issues);

  if (!(DEVICE_PUBLIC_KEY_KINDS as readonly unknown[]).includes(record.kind)) {
    issues.push(issue(`${path}/kind`, "invalid_public_key_kind", "key.kind must be Ed25519 or X25519"));
  }
  if (!isIdentifier(record.keyId)) {
    issues.push(issue(`${path}/keyId`, "invalid_id", "key.keyId must be an identifier"));
  }
  const decoded = decodeCanonicalBase64Url(record.key);
  if (decoded === undefined) {
    issues.push(issue(`${path}/key`, "invalid_public_key_encoding", "key.key must be canonical unpadded base64url"));
  } else if (decoded.byteLength !== 32) {
    issues.push(issue(`${path}/key`, "invalid_public_key_length", "Ed25519 and X25519 public keys are exactly 32 bytes"));
  }

  if (
    !(DEVICE_PUBLIC_KEY_KINDS as readonly unknown[]).includes(record.kind)
    || !isIdentifier(record.keyId)
    || decoded?.byteLength !== 32
  ) {
    return undefined;
  }
  return Object.freeze({
    kind: record.kind as DevicePublicKeyKind,
    keyId: record.keyId,
    key: record.key as string,
  });
}

/**
 * Validates a key-directory response at the caller's trusted, skew-adjusted
 * current instant. A syntactically valid but unusable entry is rejected: a
 * consumer must not confuse successful shape validation with key authority.
 */
export function validateKeyDirectoryResponse(
  input: unknown,
  now: string,
): ValidationResult<KeyDirectoryResponse> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  if (!isCanonicalTimestamp(now)) {
    issues.push(issue("/", "invalid_validation_time", "key usability requires a canonical current timestamp"));
  }
  if (record.schemaVersion !== KEY_DIRECTORY_SCHEMA_META.version) {
    issues.push(issue("/schemaVersion", "schema_version_mismatch", "unsupported key-directory schema version"));
  }

  if (record.found === false) {
    rejectUnknownFields(record, NOT_FOUND_FIELDS, "", issues);
    if (!isIdentifier(record.keyId)) {
      issues.push(issue("/keyId", "invalid_id", "keyId must be an identifier"));
    }
    if (!(KEY_DIRECTORY_FAILURE_REASONS as readonly unknown[]).includes(record.reason)) {
      issues.push(issue("/reason", "invalid_reason", "unrecognised key-directory miss reason"));
    }
    if (issues.length > 0) return fail(issues);
    return ok(Object.freeze({
      schemaVersion: 1,
      found: false,
      keyId: record.keyId as string,
      reason: record.reason as KeyDirectoryFailureReason,
    }));
  }

  if (record.found !== true) {
    rejectUnknownFields(record, FOUND_FIELDS, "", issues);
    issues.push(issue("/found", "invalid_discriminant", "found must be exactly true or false"));
    return fail(issues);
  }

  rejectUnknownFields(record, FOUND_FIELDS, "", issues);
  const entry = recordAt(record.entry, "/entry", issues);
  if (entry === undefined) return fail(issues);
  rejectUnknownFields(entry, ENTRY_FIELDS, "/entry", issues);

  if (entry.schemaVersion !== KEY_DIRECTORY_SCHEMA_META.version) {
    issues.push(issue("/entry/schemaVersion", "schema_version_mismatch", "unsupported key-directory entry schema version"));
  }
  if (!isIdentifier(entry.keyId)) {
    issues.push(issue("/entry/keyId", "invalid_id", "entry.keyId must be an identifier"));
  }
  if (!(KEY_ROLES as readonly unknown[]).includes(entry.role)) {
    issues.push(issue("/entry/role", "invalid_key_role", "unrecognised key role"));
  }
  if (!(KEY_DIRECTORY_STATUSES as readonly unknown[]).includes(entry.status)) {
    issues.push(issue("/entry/status", "invalid_key_status", "unrecognised key status"));
  }

  const key = validatePublicKey(entry.key, "/entry/key", issues);
  if (key !== undefined && isIdentifier(entry.keyId) && entry.keyId !== key.keyId) {
    issues.push(issue("/entry/key/keyId", "key_id_mismatch", "entry.keyId must equal entry.key.keyId"));
  }

  if (!isCanonicalTimestamp(entry.validFrom)) {
    issues.push(issue("/entry/validFrom", "invalid_timestamp", "validFrom must be a canonical timestamp"));
  }
  if (!isCanonicalTimestamp(entry.refreshAfter)) {
    issues.push(issue("/entry/refreshAfter", "invalid_timestamp", "refreshAfter must be a canonical timestamp"));
  }
  const hasValidUntil = hasField(entry, "validUntil");
  if (hasValidUntil && !isCanonicalTimestamp(entry.validUntil)) {
    issues.push(issue("/entry/validUntil", "invalid_timestamp", "validUntil must be a canonical timestamp"));
  }
  if (hasField(entry, "supersededBy") && !isIdentifier(entry.supersededBy)) {
    issues.push(issue("/entry/supersededBy", "invalid_id", "supersededBy must be an identifier"));
  }

  if (isCanonicalTimestamp(now) && isCanonicalTimestamp(entry.validFrom)) {
    if (Date.parse(entry.validFrom) > Date.parse(now)) {
      issues.push(issue("/entry/validFrom", "not_yet_valid", "the key is not yet valid at the supplied instant"));
    }
  }
  if (isCanonicalTimestamp(now) && isCanonicalTimestamp(entry.validUntil)) {
    // Exclusive, matching DeviceCredential expiresAt/revokedAt: at the instant validUntil the key is already unusable.
    if (Date.parse(now) >= Date.parse(entry.validUntil)) {
      issues.push(issue("/entry/validUntil", "expired", "the key has expired at the supplied instant"));
    }
  }
  if (isCanonicalTimestamp(entry.validFrom) && isCanonicalTimestamp(entry.validUntil)) {
    if (Date.parse(entry.validUntil) < Date.parse(entry.validFrom)) {
      issues.push(issue("/entry/validUntil", "invalid_time_order", "validUntil must not precede validFrom"));
    }
  }

  if (issues.length > 0 || key === undefined) return fail(issues);
  return ok(Object.freeze({
    schemaVersion: 1,
    found: true,
    entry: Object.freeze({
      schemaVersion: 1,
      keyId: entry.keyId as string,
      role: entry.role as KeyRole,
      key,
      validFrom: entry.validFrom as Timestamp,
      ...(hasValidUntil ? { validUntil: entry.validUntil as Timestamp } : {}),
      ...(hasField(entry, "supersededBy") ? { supersededBy: entry.supersededBy as string } : {}),
      refreshAfter: entry.refreshAfter as Timestamp,
      status: entry.status as KeyDirectoryStatus,
    }),
  }));
}

/** Permission projection: malformed, revoked, wrong-role, and out-of-window keys deny. */
export function isKeyUsableAt(entry: KeyDirectoryEntry, now: string, role: KeyRole): boolean {
  if (ownData(entry, "status") !== "active") return false;
  if (!(KEY_ROLES as readonly unknown[]).includes(role)) return false;
  const checked = validateKeyDirectoryResponse(
    { schemaVersion: 1, found: true, entry },
    now,
  );
  return checked.ok && checked.value.found && checked.value.entry.role === role;
}

export const KEY_DIRECTORY_SCHEMA_META: SchemaMeta = {
  id: "vinci.device-auth.key-directory",
  version: 1,
  compatibility: "additive-only",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
