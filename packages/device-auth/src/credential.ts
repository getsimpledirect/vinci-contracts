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

/**
 * sha256, lowercase hex, exactly 64 characters.
 *
 * The brand alone is a compile-time guarantee, and a validator that accepted
 * any non-empty string erased it the moment data arrived from outside — which
 * is the only place credentials ever come from. `"super-secret-value"` is a
 * non-empty string; it is not a digest. Checking the actual shape is what
 * makes "the raw secret is never stored" true at runtime rather than aspirational.
 */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The only way to obtain a KeyHash from untrusted input. */
export function parseKeyHash(value: unknown): KeyHash | undefined {
  return typeof value === "string" && SHA256_HEX.test(value) ? (value as KeyHash) : undefined;
}

const KNOWN_CREDENTIAL_FIELDS = new Set([
  // `kind` and `deviceId` are safe metadata carried by the device variant.
  // They must be listed, or the reject-unknowns rule above refuses every
  // device credential.
  "kind",
  "deviceId",
  "workerId",
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
 * Validates a credential identity record, dispatching on its `kind`.
 *
 * The dispatch is the security-relevant part. This used to validate the base
 * shape only, so a record tagged `kind: "worker"` carrying
 * `scopes: ["acceptance"]` passed here cleanly — the prohibition lived in
 * `validateWorkerCredential`, and nothing forced a caller through it. A record
 * that declares what it is must be held to that variant's rules; otherwise the
 * variant validators are optional, and an optional security check is not one.
 *
 * Fail-closed on malformed data (D4), and unrecognised fields are rejected
 * rather than preserved, because an unknown field on a credential may be the
 * secret itself.
 */
export function validateCredentialIdentity(value: unknown): ValidationResult<CredentialIdentity> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const kind = (value as Record<string, unknown>).kind;
    if (kind === "device") return validateDeviceCredential(value);
    if (kind === "worker") return validateWorkerCredential(value);
    if (kind !== undefined) {
      return fail([
        {
          path: "/kind",
          code: "unknown_credential_kind",
          message: `unrecognised credential kind "${String(kind)}"; a credential is either a device credential, a worker credential, or untagged`,
        },
      ]);
    }
  }
  return validateBaseCredential(value);
}


function validateBaseCredential(value: unknown): ValidationResult<CredentialIdentity> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail([{ path: "", code: "not_object", message: "credential identity must be an object" }]);
  }
  const record = value as Record<string, unknown>;
  const issues: ValidationIssue[] = [];
  // D4 exception, matching /credentials in @vinci/policy: an unrecognised
  // field on a credential may BE the secret, and preserving it would carry
  // that secret into a record SR-3 says must never hold one. Reject instead.
  for (const key of Object.keys(record)) {
    if (KNOWN_CREDENTIAL_FIELDS.has(key)) continue;
    issues.push({
      path: `/${key}`,
      code: "unknown_credential_field",
      message:
        "unrecognised field on a credential; a credential carries only safe metadata, and an unknown field here may be secret material",
    });
  }

  if (parseKeyHash(record.keyHash) === undefined) {
    issues.push({
      path: "/keyHash",
      code: "invalid_hash",
      message:
        "keyHash must be a sha256 digest: 64 lowercase hex characters. A raw secret is not a digest and is never stored.",
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
      // Cloned and frozen. Retaining the caller's array let a validated
      // credential be mutated afterwards — pushing `acceptance` onto it with
      // no cast and no re-validation, defeating the prohibition below.
      scopes: Object.freeze([...(record.scopes as readonly Scope[])]),
      createdAt: record.createdAt as Timestamp,
      revokedAt: record.revokedAt as Timestamp | null,
    },
    // Empty by construction: an unrecognised field is a rejection above, so a
    // successful validation has nothing left over to carry.
    {},
  );
}

/**
 * Validates a credential identity **and** enforces the device-token scope
 * prohibition at runtime: an `acceptance` scope fails closed even if produced
 * by a caller that bypassed the `DeviceScope` type. A device credential also
 * requires a concrete (non-null) `clientType` and a `deviceId`.
 */
export function validateDeviceCredential(value: unknown): ValidationResult<DeviceCredential> {
  const base = validateBaseCredential(value);
  if (!base.ok) return base;
  const known = base.value;

  const issues: ValidationIssue[] = [];
  const raw = value as Record<string, unknown>;
  // Without this, `{ kind: "device", workerId: "w1" }` validated as a device
  // and `{ kind: "worker", deviceId: "d1" }` as a worker — each validator
  // rewrote the discriminator to the variant it produces, so the tag a caller
  // supplied was decorative. A record that says what it is has to be it.
  if (raw.kind !== undefined && raw.kind !== "device") {
    issues.push({
      path: "/kind",
      code: "wrong_credential_kind",
      message: `expected a device credential, got kind "${String(raw.kind)}"`,
    });
  }
  if (raw.workerId !== undefined) {
    issues.push({
      path: "/workerId",
      code: "field_not_valid_for_kind",
      message: "workerId does not belong on a device credential",
    });
  }
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
    Object.freeze({
      kind: "device",
      deviceId: deviceId as DeviceId,
      keyHash: known.keyHash,
      prefix: known.prefix,
      clientType: known.clientType as ClientType,
      scopes: Object.freeze([...known.scopes]) as readonly DeviceScope[],
      createdAt: known.createdAt,
      revokedAt: known.revokedAt,
    }),
    {},
  );
}

/**
 * Six-field compatibility contract for the credential identity schema (§16).
 */
export const CREDENTIAL_IDENTITY_SCHEMA_META: SchemaMeta = {
  id: "vinci.device-auth.credential-identity",
  version: 1,
  compatibility: "additive-only",
  /**
   * Rejected, not preserved — the D4 exception that also governs /credentials
   * in @vinci/policy. An unrecognised field on a credential may be the secret
   * itself, and preserving it would carry that secret into a record SR-3 says
   * must never hold one.
   */
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};

/**
 * Validates a worker credential, and enforces the same `acceptance`-scope
 * prohibition at runtime that device credentials get.
 *
 * The prohibition previously lived only in the WorkerCredential type's `scopes`
 * narrowing and a comment saying "a worker must not certify its own
 * verification work either". A type narrowing is erased the moment data arrives
 * from outside, which is the only place credentials come from — so untrusted
 * JSON claiming to be a worker credential with `scopes: ["acceptance"]` passed
 * cleanly through validateCredentialIdentity.
 *
 * The reason it matters is the same one behind the evidence provenance check:
 * a worker holding the acceptance scope can certify its own work, and
 * architectural principle 2 says it does not get to.
 */
export function validateWorkerCredential(value: unknown): ValidationResult<WorkerCredential> {
  const base = validateBaseCredential(value);
  if (!base.ok) return base;
  const known = base.value;

  const issues: ValidationIssue[] = [];
  const raw = value as Record<string, unknown>;
  if (raw.kind !== undefined && raw.kind !== "worker") {
    issues.push({
      path: "/kind",
      code: "wrong_credential_kind",
      message: `expected a worker credential, got kind "${String(raw.kind)}"`,
    });
  }
  if (raw.deviceId !== undefined) {
    issues.push({
      path: "/deviceId",
      code: "field_not_valid_for_kind",
      message: "deviceId does not belong on a worker credential",
    });
  }
  if (known.scopes.some((s) => s === "acceptance")) {
    issues.push(ACCEPTANCE_FORBIDDEN_ISSUE);
  }
  const workerId = raw.workerId;
  if (typeof workerId !== "string" || workerId.length === 0) {
    issues.push({
      path: "/workerId",
      code: "required_field",
      message: "a worker credential requires a workerId",
    });
  }

  if (issues.length > 0) return fail(issues);

  return ok(
    Object.freeze({
      kind: "worker",
      workerId: workerId as WorkerId,
      keyHash: known.keyHash,
      prefix: known.prefix,
      clientType: known.clientType,
      scopes: Object.freeze([...known.scopes]) as readonly DeviceScope[],
      createdAt: known.createdAt,
      revokedAt: known.revokedAt,
    }),
    {},
  );
}
