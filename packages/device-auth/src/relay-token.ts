import { decodeCanonicalBase64Url } from "./credential.ts";
import {
  canonicalize,
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

export { SESSION_ROLES } from "@getsimpledirect/vinci-contracts";
export type { SessionRole } from "@getsimpledirect/vinci-contracts";

export const RELAY_ACCESS_TOKEN_MAX_LIFETIME_MS = 10 * 60 * 1_000;
export const RELAY_ACCESS_TOKEN_AUDIENCE = "vinci-relay" as const;

export type RelayAccessTokenBinding = {
  readonly protocolVersion: number;
  readonly organizationId: OrganizationId | null;
  readonly workspaceId: WorkspaceId;
  readonly runId: RunId;
  readonly sessionId: string;
};

export type RelayAccessToken = {
  readonly schemaVersion: 1;
  readonly tokenId: string;
  readonly credentialId: string;
  readonly deviceId: DeviceId;
  readonly audience: typeof RELAY_ACCESS_TOKEN_AUDIENCE;
  readonly binding: RelayAccessTokenBinding;
  readonly sessionRole: SessionRole;
  readonly issuedAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly issuerKeyId: string;
  readonly signature: {
    readonly alg: "Ed25519";
    /** Signature encoding is owned by the issuer/verifier profile. */
    readonly value: string;
  };
};

const TOKEN_FIELDS = new Set([
  "schemaVersion",
  "tokenId",
  "credentialId",
  "deviceId",
  "audience",
  "binding",
  "sessionRole",
  "issuedAt",
  "expiresAt",
  "issuerKeyId",
  "signature",
]);
const BINDING_FIELDS = new Set([
  "protocolVersion",
  "organizationId",
  "workspaceId",
  "runId",
  "sessionId",
]);
const SIGNATURE_FIELDS = new Set(["alg", "value"]);

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
      issues.push(
        issue(
          `${path}/${key}`,
          "unknown_field",
          "a relay access token carries only its declared signed fields",
        ),
      );
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

function requireId(record: PlainRecord, field: string, path: string, issues: ValidationIssue[]): void {
  if (!isIdentifier(record[field])) {
    issues.push(issue(`${path}/${field}`, "invalid_id", "expected an identifier"));
  }
}

/**
 * Validates token structure, audience, binding, role, and lifetime. It does
 * NOT verify the Ed25519 signature; callers must verify the returned token's
 * signing payload against the trusted issuer key before granting authority.
 * Nor does it consult the clock: `expiresAt` is checked for shape and for the
 * lifetime cap relative to `issuedAt`, and whether the token has ALREADY
 * expired is the consumer's check against its own trusted time source — a
 * validator that read the clock would be non-deterministic and untestable.
 */
export function validateRelayAccessToken(input: unknown): ValidationResult<RelayAccessToken> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];
  rejectUnknownFields(record, TOKEN_FIELDS, "", issues);

  if (record.schemaVersion !== RELAY_ACCESS_TOKEN_SCHEMA_META.version) {
    issues.push(
      issue(
        "/schemaVersion",
        "schema_version_mismatch",
        `this build reads relay-access-token schema ${RELAY_ACCESS_TOKEN_SCHEMA_META.version}`,
      ),
    );
  }
  for (const field of ["tokenId", "credentialId", "deviceId", "issuerKeyId"] as const) {
    requireId(record, field, "", issues);
  }
  if (record.audience !== RELAY_ACCESS_TOKEN_AUDIENCE) {
    issues.push(
      issue(
        "/audience",
        "invalid_audience",
        `audience must be ${RELAY_ACCESS_TOKEN_AUDIENCE}`,
      ),
    );
  }
  if (!isSessionRole(record.sessionRole)) {
    issues.push(issue("/sessionRole", "invalid_session_role", "sessionRole is not in the closed session-role list"));
  }

  if (!isCanonicalTimestamp(record.issuedAt)) {
    issues.push(issue("/issuedAt", "invalid_timestamp", "issuedAt must be a canonical timestamp"));
  }
  if (!hasField(record, "expiresAt")) {
    issues.push(issue("/expiresAt", "required_field", "expiresAt is required on every relay access token"));
  } else if (!isCanonicalTimestamp(record.expiresAt)) {
    issues.push(issue("/expiresAt", "invalid_timestamp", "expiresAt must be a canonical timestamp"));
  }
  if (isCanonicalTimestamp(record.issuedAt) && isCanonicalTimestamp(record.expiresAt)) {
    const lifetime = Date.parse(record.expiresAt) - Date.parse(record.issuedAt);
    if (lifetime <= 0) {
      issues.push(issue("/expiresAt", "expiry_not_after_issue", "expiresAt must be strictly after issuedAt"));
    } else if (lifetime > RELAY_ACCESS_TOKEN_MAX_LIFETIME_MS) {
      issues.push(
        issue(
          "/expiresAt",
          "lifetime_exceeded",
          `relay access token lifetime must not exceed ${RELAY_ACCESS_TOKEN_MAX_LIFETIME_MS} milliseconds`,
        ),
      );
    }
  }

  const binding = recordAt(record.binding, "/binding", issues);
  if (binding !== undefined) {
    rejectUnknownFields(binding, BINDING_FIELDS, "/binding", issues);
    if (
      !Number.isSafeInteger(binding.protocolVersion)
      || (binding.protocolVersion as number) < 1
      || Object.is(binding.protocolVersion, -0)
    ) {
      issues.push(
        issue(
          "/binding/protocolVersion",
          "invalid_protocol_version",
          "protocolVersion must be a positive safe integer",
        ),
      );
    }
    for (const field of ["workspaceId", "runId", "sessionId"] as const) {
      requireId(binding, field, "/binding", issues);
    }
    if (!hasField(binding, "organizationId")) {
      issues.push(
        issue(
          "/binding/organizationId",
          "required_field",
          "organizationId is required and must be explicitly null for personal workspaces",
        ),
      );
    } else if (binding.organizationId !== null && !isIdentifier(binding.organizationId)) {
      issues.push(issue("/binding/organizationId", "invalid_id", "expected an identifier or null"));
    }
  }

  const signature = recordAt(record.signature, "/signature", issues);
  if (signature !== undefined) {
    rejectUnknownFields(signature, SIGNATURE_FIELDS, "/signature", issues);
    if (signature.alg !== "Ed25519") {
      issues.push(
        issue(
          "/signature/alg",
          "invalid_signature_algorithm",
          "relay access tokens use Ed25519 signatures",
        ),
      );
    }
    // Same strictness as the credential public key: canonical unpadded
    // base64url, and exactly the 64 bytes an Ed25519 signature is. Structure
    // only — verification against the issuer key remains the caller's duty.
    if (decodeCanonicalBase64Url(signature.value)?.length !== 64) {
      issues.push(
        issue(
          "/signature/value",
          "invalid_signature_value",
          "signature.value must be canonical base64url encoding exactly 64 bytes (an Ed25519 signature)",
        ),
      );
    }
  }

  if (issues.length > 0) return fail(issues);

  const acceptedBinding = binding as PlainRecord;
  const acceptedSignature = signature as PlainRecord;
  return ok(
    Object.freeze({
      schemaVersion: 1,
      tokenId: record.tokenId as string,
      credentialId: record.credentialId as string,
      deviceId: record.deviceId as DeviceId,
      audience: RELAY_ACCESS_TOKEN_AUDIENCE,
      binding: Object.freeze({
        protocolVersion: acceptedBinding.protocolVersion as number,
        organizationId: acceptedBinding.organizationId as OrganizationId | null,
        workspaceId: acceptedBinding.workspaceId as WorkspaceId,
        runId: acceptedBinding.runId as RunId,
        sessionId: acceptedBinding.sessionId as string,
      }),
      sessionRole: record.sessionRole as SessionRole,
      issuedAt: record.issuedAt as Timestamp,
      expiresAt: record.expiresAt as Timestamp,
      issuerKeyId: record.issuerKeyId as string,
      signature: Object.freeze({
        alg: "Ed25519",
        value: acceptedSignature.value as string,
      }),
    }),
    {},
  );
}

/**
 * Canonical UTF-8 bytes covered by the Ed25519 signature. The signature value
 * is excluded to avoid self-reference; its algorithm is covered so it cannot
 * be substituted independently of the signed claims.
 */
export function relayAccessTokenSigningPayload(token: RelayAccessToken): Uint8Array {
  return new TextEncoder().encode(
    canonicalize({
      schemaVersion: token.schemaVersion,
      tokenId: token.tokenId,
      credentialId: token.credentialId,
      deviceId: token.deviceId,
      audience: token.audience,
      binding: token.binding,
      sessionRole: token.sessionRole,
      issuedAt: token.issuedAt,
      expiresAt: token.expiresAt,
      issuerKeyId: token.issuerKeyId,
      signature: { alg: token.signature.alg },
    }),
  );
}

export const RELAY_ACCESS_TOKEN_SCHEMA_META: SchemaMeta = {
  id: "vinci.device-auth.relay-access-token",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
