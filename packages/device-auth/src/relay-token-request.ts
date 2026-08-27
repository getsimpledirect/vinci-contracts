import {
  fail,
  hasField,
  isCanonicalTimestamp,
  isIdentifier,
  isSessionRole,
  ok,
  toPlainRecord,
  type DeviceId,
  type OrganizationId,
  type PlainRecord,
  type RunId,
  type SchemaMeta,
  type SessionRole,
  type Timestamp,
  type ValidationIssue,
  type ValidationResult,
  type WorkspaceId,
} from "@getsimpledirect/vinci-contracts";
import {
  RELAY_ACCESS_TOKEN_MAX_LIFETIME_MS,
  type RelayAccessTokenBinding,
} from "./relay-token.ts";

export type RelayAccessTokenRequest = {
  readonly schemaVersion: 1;
  readonly credentialId: string;
  readonly deviceId: DeviceId;
  readonly binding: RelayAccessTokenBinding;
  readonly sessionRole: SessionRole;
  readonly requestedLifetimeMs?: number;
  readonly requestedAt: Timestamp;
};

const REQUEST_FIELDS = new Set([
  "schemaVersion",
  "credentialId",
  "deviceId",
  "binding",
  "sessionRole",
  "requestedLifetimeMs",
  "requestedAt",
]);
const BINDING_FIELDS = new Set([
  "protocolVersion",
  "organizationId",
  "workspaceId",
  "runId",
  "sessionId",
]);

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
      issues.push(issue(`${path}/${key}`, "unknown_field", "the relay-token request shape is closed"));
    }
  }
}

export function validateRelayAccessTokenRequest(
  input: unknown,
): ValidationResult<RelayAccessTokenRequest> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];
  rejectUnknownFields(record, REQUEST_FIELDS, "", issues);

  if (record.schemaVersion !== RELAY_ACCESS_TOKEN_REQUEST_SCHEMA_META.version) {
    issues.push(issue("/schemaVersion", "schema_version_mismatch", "unsupported relay-token-request schema version"));
  }
  for (const field of ["credentialId", "deviceId"] as const) {
    if (!isIdentifier(record[field])) {
      issues.push(issue(`/${field}`, "invalid_id", `${field} must be an identifier`));
    }
  }
  if (!isSessionRole(record.sessionRole)) {
    issues.push(issue("/sessionRole", "invalid_session_role", "unrecognised session role"));
  }
  if (!isCanonicalTimestamp(record.requestedAt)) {
    issues.push(issue("/requestedAt", "invalid_timestamp", "requestedAt must be a canonical timestamp"));
  }

  const hasRequestedLifetime = hasField(record, "requestedLifetimeMs");
  if (hasRequestedLifetime) {
    if (
      !Number.isSafeInteger(record.requestedLifetimeMs)
      || (record.requestedLifetimeMs as number) <= 0
      || Object.is(record.requestedLifetimeMs, -0)
    ) {
      issues.push(issue("/requestedLifetimeMs", "invalid_lifetime", "requestedLifetimeMs must be a positive safe integer"));
    } else if ((record.requestedLifetimeMs as number) > RELAY_ACCESS_TOKEN_MAX_LIFETIME_MS) {
      issues.push(issue("/requestedLifetimeMs", "lifetime_exceeded", `requestedLifetimeMs must not exceed ${RELAY_ACCESS_TOKEN_MAX_LIFETIME_MS}`));
    }
  }

  let binding: PlainRecord | undefined;
  if (typeof record.binding !== "object" || record.binding === null || Array.isArray(record.binding)) {
    issues.push(issue("/binding", "invalid_record", "binding must be a record"));
  } else {
    binding = record.binding as PlainRecord;
    rejectUnknownFields(binding, BINDING_FIELDS, "/binding", issues);
    if (
      !Number.isSafeInteger(binding.protocolVersion)
      || (binding.protocolVersion as number) < 1
      || Object.is(binding.protocolVersion, -0)
    ) {
      issues.push(issue("/binding/protocolVersion", "invalid_protocol_version", "protocolVersion must be a positive safe integer"));
    }
    for (const field of ["workspaceId", "runId", "sessionId"] as const) {
      if (!isIdentifier(binding[field])) {
        issues.push(issue(`/binding/${field}`, "invalid_id", `${field} must be an identifier`));
      }
    }
    if (!hasField(binding, "organizationId")) {
      issues.push(issue("/binding/organizationId", "required_field", "organizationId is required and nullable"));
    } else if (binding.organizationId !== null && !isIdentifier(binding.organizationId)) {
      issues.push(issue("/binding/organizationId", "invalid_id", "organizationId must be an identifier or null"));
    }
  }

  if (issues.length > 0 || binding === undefined) return fail(issues);
  return ok(Object.freeze({
    schemaVersion: 1,
    credentialId: record.credentialId as string,
    deviceId: record.deviceId as DeviceId,
    binding: Object.freeze({
      protocolVersion: binding.protocolVersion as number,
      organizationId: binding.organizationId as OrganizationId | null,
      workspaceId: binding.workspaceId as WorkspaceId,
      runId: binding.runId as RunId,
      sessionId: binding.sessionId as string,
    }),
    sessionRole: record.sessionRole as SessionRole,
    ...(hasRequestedLifetime ? { requestedLifetimeMs: record.requestedLifetimeMs as number } : {}),
    requestedAt: record.requestedAt as Timestamp,
  }));
}

export const RELAY_ACCESS_TOKEN_REQUEST_SCHEMA_META: SchemaMeta = {
  id: "vinci.device-auth.relay-access-token-request",
  version: 1,
  compatibility: "additive-only",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
