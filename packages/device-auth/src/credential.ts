import {
  fail,
  ok,
  type SchemaMeta,
  type Timestamp,
  type ValidationIssue,
  type ValidationResult,
} from "@vinci/contracts";
import type { DeviceId, WorkerId } from "@vinci/contracts";
import type { ClientType } from "./client-type.ts";
import { isClientType } from "./client-type.ts";
import type { DeviceScope, Scope } from "./scopes.ts";
import { isScope } from "./scopes.ts";

declare const brand: unique symbol;
type Branded<T extends string> = string & { readonly [brand]: T };

/**
 * The sha256 digest of a credential's secret. Only the hash is ever stored
 * (`api_keys.key_hash`, `device_pairings.device_code_hash`); the secret value
 * itself is never persisted, so it cannot appear in any of these identity
 * records by construction.
 *
 * Branding the hash (rather than leaving it a bare `string`) is what makes the
 * "cannot carry a secret" property *enforceable*: a record that carries the
 * raw secret as a plain string is not assignable to a type that demands the
 * branded digest.
 */
export type KeyHash = Branded<"KeyHash">;

/**
 * The metadata identity of a stored credential. It carries **no secret
 * value** — only what the platform persists and needs for authorization
 * decisions: the digest, the display-only prefix, the client type, the
 * scopes, the timestamps, and the revocation state.
 */
export type CredentialIdentity = {
  /** sha256 of the secret. The raw secret never appears here or in the store. */
  readonly keyHash: KeyHash;
  /** Display-only, e.g. `vinci_live_ab12`. Never used for authorization. */
  readonly prefix: string;
  /** `null` means a manually issued developer key (DB `client_type` NULL). */
  readonly clientType: ClientType | null;
  readonly scopes: readonly Scope[];
  readonly createdAt: Timestamp;
  /** Set by both self-revoke and dashboard-revoke. `null` while active. */
  readonly revokedAt: Timestamp | null;
};

/**
 * A device-bound credential. It is a `CredentialIdentity` plus device context.
 * `scopes` is narrowed to `readonly DeviceScope[]`, which has no `'acceptance'`
 * member — so a device token cannot be constructed holding the acceptance
 * scope, at the type level (see `scopes.ts`).
 */
export type DeviceCredential = CredentialIdentity & {
  readonly kind: "device";
  readonly deviceId: DeviceId;
  /** A device credential always has a concrete surface; never the `null` dev-key case. */
  readonly clientType: ClientType;
  /** `acceptance` is impossible here by construction. */
  readonly scopes: readonly DeviceScope[];
};

/**
 * A worker-bound credential. Like a device credential it carries only
 * metadata, and its scopes are narrowed to `readonly DeviceScope[]` because a
 * worker must not certify its own verification work either.
 */
export type WorkerCredential = CredentialIdentity & {
  readonly kind: "worker";
  readonly workerId: WorkerId;
  readonly scopes: readonly DeviceScope[];
};

/**
 * Immutably mark a single credential revoked. Both self-revoke and
 * dashboard-revoke set `revokedAt`. Because this returns a new object and
 * never mutates its input, revoking one credential cannot affect any other —
 * credentials are fully independent, each owning its own `revokedAt`.
 */
export function revoke(
  identity: CredentialIdentity,
  at: Timestamp = new Date().toISOString(),
): CredentialIdentity {
  return { ...identity, revokedAt: at };
}

const KNOWN_CREDENTIAL_FIELDS = new Set([
  "keyHash",
  "prefix",
  "clientType",
  "scopes",
  "createdAt",
  "revokedAt",
]);

const ACCEPTANCE_FORBIDDEN_ISSUE: ValidationIssue = {
  path: "/scopes",
  code: "acceptance_forbidden",
  message: "device and worker credentials may not hold the 'acceptance' scope",
};

function isTimestamp(value: unknown): value is Timestamp {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/**
 * Validates a credential identity record.
 *
 * Fail-closed on malformed data (D4): nothing is coerced or defaulted. Unknown
 * fields are preserved verbatim and reported on the success arm so a newer
 * producer's record round-trips through this consumer without loss.
 */
export function validateCredentialIdentity(value: unknown): ValidationResult<CredentialIdentity> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail([{ path: "", code: "not_object", message: "credential identity must be an object" }]);
  }
  const record = value as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  const unknownFields: Record<string, unknown> = {};

  for (const key of Object.keys(record)) {
    if (!KNOWN_CREDENTIAL_FIELDS.has(key)) unknownFields[key] = record[key];
  }

  if (typeof record.keyHash !== "string" || record.keyHash.length === 0) {
    issues.push({
      path: "/keyHash",
      code: "invalid_hash",
      message: "keyHash must be a non-empty sha256 digest string; the raw secret is never stored",
    });
  }
  if (typeof record.prefix !== "string" || record.prefix.length === 0) {
    issues.push({ path: "/prefix", code: "invalid_prefix", message: "prefix must be a non-empty string" });
  }
  if (record.clientType !== null && !isClientType(record.clientType)) {
    issues.push({
      path: "/clientType",
      code: "unknown_client_type",
      message: "clientType must be a known client type or null",
    });
  }
  if (
    !Array.isArray(record.scopes) ||
    record.scopes.some((scope) => typeof scope !== "string" || !isScope(scope))
  ) {
    issues.push({
      path: "/scopes",
      code: "invalid_scopes",
      message: "scopes must be an array of known scopes",
    });
  }
  if (!isTimestamp(record.createdAt)) {
    issues.push({
      path: "/createdAt",
      code: "invalid_timestamp",
      message: "createdAt must be an ISO-8601 timestamp",
    });
  }
  if (record.revokedAt !== null && !isTimestamp(record.revokedAt)) {
    issues.push({
      path: "/revokedAt",
      code: "invalid_timestamp",
      message: "revokedAt must be an ISO-8601 timestamp or null",
    });
  }

  if (issues.length > 0) return fail(issues);

  return ok(
    {
      keyHash: record.keyHash as KeyHash,
      prefix: record.prefix as string,
      clientType: record.clientType as ClientType | null,
      scopes: record.scopes as readonly Scope[],
      createdAt: record.createdAt as Timestamp,
      revokedAt: record.revokedAt as Timestamp | null,
    },
    unknownFields,
  );
}

/**
 * Validates a credential identity **and** enforces the device-token scope
 * prohibition at runtime: an `acceptance` scope fails closed even if produced
 * by a caller that bypassed the `DeviceScope` type. A device credential also
 * requires a concrete (non-null) `clientType` and a `deviceId`.
 */
export function validateDeviceCredential(value: unknown): ValidationResult<DeviceCredential> {
  const base = validateCredentialIdentity(value);
  if (!base.ok) return base;
  const known = base.value;

  const issues: ValidationIssue[] = [];
  if (known.clientType === null) {
    issues.push({
      path: "/clientType",
      code: "required_client_type",
      message: "a device credential requires a concrete clientType",
    });
  }
  if (known.scopes.some((s) => s === "acceptance")) {
    issues.push(ACCEPTANCE_FORBIDDEN_ISSUE);
  }
  const deviceId = (value as Record<string, unknown>).deviceId;
  if (typeof deviceId !== "string" || deviceId.length === 0) {
    issues.push({ path: "/deviceId", code: "required_field", message: "a device credential requires a deviceId" });
  }

  if (issues.length > 0) return fail(issues);

  return ok(
    {
      kind: "device",
      deviceId: deviceId as DeviceId,
      keyHash: known.keyHash,
      prefix: known.prefix,
      clientType: known.clientType as ClientType,
      scopes: known.scopes as readonly DeviceScope[],
      createdAt: known.createdAt,
      revokedAt: known.revokedAt,
    },
    base.unknownFields,
  );
}

/**
 * Six-field compatibility contract for the credential identity schema (§16).
 */
export const CREDENTIAL_IDENTITY_SCHEMA_META: SchemaMeta = {
  id: "vinci.device-auth.credential-identity",
  version: 1,
  compatibility: "additive-only",
  unknownFields: "preserve",
  malformedData: "fail-closed",
  migration: "none",
};
