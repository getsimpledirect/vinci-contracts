import {
  fail,
  ok,
  type SchemaMeta,
  type Timestamp,
  type ValidationIssue,
  type ValidationResult,
} from "@vinci/contracts";
import type { UserId } from "@vinci/contracts";
import type { ClientType } from "./client-type.ts";
import { isClientType } from "./client-type.ts";
import type { PairingState } from "./pairing-state.ts";
import { isPairingState } from "./pairing-state.ts";

/**
 * A device pairing record (`device_pairings`).
 *
 * Stores only metadata; the device code itself is never kept — only its
 * sha256 (`deviceCodeHash`). The shipped DB schema is:
 * `device_code_hash`, `user_code`, `client_type`, `status`, `user_id`,
 * `created_at`, `expires_at`.
 */
export type DevicePairing = {
  /** sha256 of the device code. The device code itself is never stored. */
  readonly deviceCodeHash: string;
  /** Short, human-typed code the user enters to authorize the pairing. */
  readonly userCode: string;
  readonly clientType: ClientType;
  readonly status: PairingState;
  /** NULL until the pairing is authorized. */
  readonly userId: UserId | null;
  readonly createdAt: Timestamp;
  readonly expiresAt: Timestamp;
};

const KNOWN_PAIRING_FIELDS = new Set([
  "deviceCodeHash",
  "userCode",
  "clientType",
  "status",
  "userId",
  "createdAt",
  "expiresAt",
]);

function isTimestamp(value: unknown): value is Timestamp {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * Validates a device pairing record. Fail-closed on malformed data (D4); unknown
 * fields are preserved verbatim and reported on the success arm.
 *
 * Note: `status` is validated against the three known pairing states even
 * though the DB currently has **no CHECK constraint** on it — a consumer must
 * not rely on the store to catch an invalid value.
 */
export function validateDevicePairing(value: unknown): ValidationResult<DevicePairing> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail([{ path: "", code: "not_object", message: "device pairing must be an object" }]);
  }
  const record = value as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  const unknownFields: Record<string, unknown> = {};

  for (const key of Object.keys(record)) {
    if (!KNOWN_PAIRING_FIELDS.has(key)) unknownFields[key] = record[key];
  }

  if (typeof record.deviceCodeHash !== "string" || record.deviceCodeHash.length === 0) {
    issues.push({
      path: "/deviceCodeHash",
      code: "invalid_hash",
      message: "deviceCodeHash must be a non-empty sha256 digest string; the code is never stored",
    });
  }
  if (typeof record.userCode !== "string" || record.userCode.length === 0) {
    issues.push({ path: "/userCode", code: "invalid_user_code", message: "userCode must be a non-empty string" });
  }
  if (!isClientType(record.clientType)) {
    issues.push({
      path: "/clientType",
      code: "unknown_client_type",
      message: "clientType must be a known client type",
    });
  }
  if (!isPairingState(record.status)) {
    issues.push({
      path: "/status",
      code: "unknown_pairing_state",
      message: "status must be one of pending, authorized or consumed",
    });
  }
  if (record.userId !== null && (typeof record.userId !== "string" || record.userId.length === 0)) {
    issues.push({ path: "/userId", code: "invalid_user_id", message: "userId must be a non-empty string or null" });
  }
  if (!isTimestamp(record.createdAt)) {
    issues.push({ path: "/createdAt", code: "invalid_timestamp", message: "createdAt must be an ISO-8601 timestamp" });
  }
  if (!isTimestamp(record.expiresAt)) {
    issues.push({ path: "/expiresAt", code: "invalid_timestamp", message: "expiresAt must be an ISO-8601 timestamp" });
  }

  if (issues.length > 0) return fail(issues);

  return ok(
    {
      deviceCodeHash: record.deviceCodeHash as string,
      userCode: record.userCode as string,
      clientType: record.clientType as ClientType,
      status: record.status as PairingState,
      userId: record.userId as UserId | null,
      createdAt: record.createdAt as Timestamp,
      expiresAt: record.expiresAt as Timestamp,
    },
    unknownFields,
  );
}

/**
 * Six-field compatibility contract for the device pairing schema (§16).
 */
export const DEVICE_PAIRING_SCHEMA_META: SchemaMeta = {
  id: "vinci.device-auth.device-pairing",
  version: 1,
  compatibility: "additive-only",
  unknownFields: "preserve",
  malformedData: "fail-closed",
  migration: "none",
};
