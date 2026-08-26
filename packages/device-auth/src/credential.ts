import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  canonicalize,
  fail,
  hasField,
  isCanonicalTimestamp,
  isIdentifier,
  ownData,
  toPlainRecord,
  type PlainRecord,
  ok,
  type SchemaMeta,
  type Timestamp,
  type ValidationIssue,
  type ValidationResult,
  safeLabel,
} from "@getsimpledirect/vinci-contracts";
import type { DeviceId, WorkerId } from "@getsimpledirect/vinci-contracts";
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

export const DEVICE_PUBLIC_KEY_KINDS = ["Ed25519", "X25519"] as const;
export type DevicePublicKeyKind = (typeof DEVICE_PUBLIC_KEY_KINDS)[number];

/** Platform-certified public key material bound immutably to a credential. */
export type DevicePublicKey = {
  readonly kind: DevicePublicKeyKind;
  readonly keyId: string;
  /** Canonical unpadded base64url encoding of exactly 32 bytes. */
  readonly key: string;
};

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
  /** Stable credential identity. Rotation always issues a new id. */
  readonly id: string;
  readonly deviceId: DeviceId;
  /** A device credential always has a concrete surface; never the `null` dev-key case. */
  readonly clientType: ClientType;
  /** `acceptance` is impossible here by construction. */
  readonly scopes: readonly DeviceScope[];
  /** `null` is reserved for a non-expiring, long-lived pairing credential. */
  readonly expiresAt: Timestamp | null;
  /** Public key certified for this credential; raw private key material is never present. */
  readonly publicKey: DevicePublicKey | null;
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
 * Immutably mark a single credential revoked.
 *
 * Generic in the credential type so a revoked worker is still statically a
 * worker — but `revokedAt` is re-typed rather than carried through.
 *
 * Returning bare `T` was unsound in the dangerous direction. A caller writing
 * the natural thing — `type ActiveCredential = CredentialIdentity & { revokedAt:
 * null }`, meaning "not yet revoked" — got back a value the compiler believed
 * had `revokedAt: null` while it held a Timestamp. `isRevoked(c) { return
 * c.revokedAt !== null }` then constant-folds to false, so a revoked
 * credential reads as active. For a function underpinning FR-9.3 and SR-4,
 * that is the wrong way to be wrong.
 *
 * The result is frozen, and its scopes are cloned before freezing. The
 * previous implementation spread into a NEW object which was not frozen:
 * the scopes array it carried was still frozen, so a push failed, but the
 * whole property could be reassigned to `["acceptance"]`. That is the same
 * whole-array-replacement hole freezing was introduced to close, reached by a
 * second path — and reached on a credential that has just been revoked, which
 * is the worst moment for its authority to become editable.
 *
 * Cloning matters as well as freezing. Sharing one array between the original
 * and the revoked copy leaves a single object behind two records, where the
 * original's freeze is the only thing protecting both.
 *
 * Because this returns a new object and never mutates its input, revoking one
 * credential cannot affect any other (FR-9.3, SR-4).
 */
export function revoke<T extends CredentialIdentity>(
  identity: T,
  at: Timestamp = new Date().toISOString(),
): ValidationResult<Omit<T, "revokedAt"> & { readonly revokedAt: Timestamp }> {
  // `at` was accepted as any string, so a malformed timestamp could be written
  // into the one field that records WHEN authority ended.
  if (!isTimestamp(at)) {
    return fail([
      {
        path: "/revokedAt",
        code: "invalid_timestamp",
        message: "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z",
      },
    ]);
  }
  const publicKey = ownData(identity, "publicKey");
  return ok(
    Object.freeze({
      ...identity,
      scopes: Object.freeze([...identity.scopes]),
      ...(publicKey === null
        ? { publicKey: null }
        : typeof publicKey === "object"
          ? { publicKey: Object.freeze({ ...(publicKey as DevicePublicKey) }) }
          : {}),
      revokedAt: at,
    }) as Omit<T, "revokedAt"> & { readonly revokedAt: Timestamp },
  );
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
  "id",
  "keyHash",
  "prefix",
  "clientType",
  "scopes",
  "createdAt",
  "expiresAt",
  "publicKey",
  "revokedAt",
]);

const KNOWN_PUBLIC_KEY_FIELDS = new Set(["kind", "keyId", "key"]);

const ACCEPTANCE_FORBIDDEN_ISSUE: ValidationIssue = {
  path: "/scopes",
  code: "acceptance_forbidden",
  message: "device and worker credentials may not hold the 'acceptance' scope",
};

/**
 * ISO-8601 UTC with millisecond precision, and a date that actually exists.
 *
 * `Date.parse` alone normalises impossible dates rather than refusing them:
 * "2026-02-29" becomes March 1 and validates, 2026 not being a leap year. The
 * round-trip comparison is what makes the refusal real.
 *
 * evidence and model-classes already carried this check. The commit that added
 * it there described the two packages disagreeing about what malformed means —
 * and left this package on the wrong side of that disagreement.
 */
function isTimestamp(value: unknown): value is Timestamp {
  return isCanonicalTimestamp(value);
}

/**
 * Returns the decoded bytes of a canonical, unpadded base64url string, or
 * undefined. Typed as Uint8Array so the published declaration does not depend
 * on Node's `Buffer` type — a consumer without @types/node could not resolve it.
 */
export function decodeCanonicalBase64Url(value: unknown): Uint8Array | undefined {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : undefined;
}

function validatePublicKey(
  value: PlainRecord[string] | undefined,
  path: string,
  issues: ValidationIssue[],
): DevicePublicKey | null | undefined {
  if (value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    issues.push({
      path,
      code: "invalid_public_key",
      message: "publicKey must be a declared public-key record or null",
    });
    return undefined;
  }

  const record = value as PlainRecord;

  for (const key of Object.keys(record)) {
    if (!KNOWN_PUBLIC_KEY_FIELDS.has(key)) {
      issues.push({
        path: `${path}/${key}`,
        code: "unknown_public_key_field",
        message: "a public key carries only kind, keyId, and key",
      });
    }
  }
  if (!(DEVICE_PUBLIC_KEY_KINDS as readonly unknown[]).includes(record.kind)) {
    issues.push({
      path: `${path}/kind`,
      code: "invalid_public_key_kind",
      message: "publicKey.kind must be Ed25519 or X25519",
    });
  }
  if (!isIdentifier(record.keyId)) {
    issues.push({
      path: `${path}/keyId`,
      code: "invalid_public_key_id",
      message: "publicKey.keyId must be an identifier",
    });
  }
  const decoded = decodeCanonicalBase64Url(record.key);
  if (decoded === undefined) {
    issues.push({
      path: `${path}/key`,
      code: "invalid_public_key_encoding",
      message: "publicKey.key must be canonical unpadded base64url",
    });
  } else if (decoded.byteLength !== 32) {
    issues.push({
      path: `${path}/key`,
      code: "invalid_public_key_length",
      message: "Ed25519 and X25519 public keys are exactly 32 bytes",
    });
  }

  if (issues.length > 0) return undefined;
  return Object.freeze({
    kind: record.kind as DevicePublicKeyKind,
    keyId: record.keyId as string,
    key: record.key as string,
  });
}

/**
 * Whether a validated credential has authority at one canonical instant.
 * Revocation and expiry take effect at their timestamp, not one tick later.
 */
export function isCredentialActiveAt(
  credential: DeviceCredential,
  at: Timestamp,
): boolean {
  if (!isTimestamp(at)) return false;
  const validated = validateDeviceCredential(credential);
  if (!validated.ok) return false;
  const { revokedAt, expiresAt } = validated.value;
  const instant = Date.parse(at);
  return (
    (revokedAt === null || instant < Date.parse(revokedAt))
    && (expiresAt === null || instant < Date.parse(expiresAt))
  );
}

/**
 * SHA-256 identity of the immutable authorization fields on a device
 * credential. Revocation is state and is deliberately excluded; expiry and
 * public-key rotation are identity and are deliberately covered.
 */
export function credentialIdentityDigest(credential: DeviceCredential): string {
  const covered = {
    id: credential.id,
    deviceId: credential.deviceId,
    clientType: credential.clientType,
    scopes: credential.scopes,
    createdAt: credential.createdAt,
    expiresAt: credential.expiresAt,
    publicKey: credential.publicKey,
  };
  return createHash("sha256").update(canonicalize(covered), "utf8").digest("hex");
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
  // Snapshot first. Reading `value.kind` directly saw inherited properties
  // that Object.hasOwn did not, so a prototype-tagged worker took the untagged
  // path and kept the acceptance scope.
  const plain = toPlainRecord(value);
  if (!plain.ok) return plain;
  const record = plain.value;

  if (hasField(record, "kind")) {
    if (record.kind === "device") return validateDeviceCredential(record);
    if (record.kind === "worker") return validateWorkerCredential(record);
    return fail([
      {
        path: "/kind",
        code: "unknown_credential_kind",
        // Deliberately does not echo the value. Interpolating attacker-supplied
        // data into an error both leaks it into logs and hands control to a
        // Symbol.toPrimitive that can throw out of validation.
        message:
          'unrecognised credential kind; a credential is a device credential, a worker credential, or untagged',
      },
    ]);
  }

  const issues: ValidationIssue[] = [];
  for (const [field, variant] of [
    ["workerId", "worker"],
    ["deviceId", "device"],
    ["id", "device"],
    ["expiresAt", "device"],
    ["publicKey", "device"],
  ] as const) {
    if (hasField(record, field)) {
      issues.push({
        path: `/${field}`,
        code: "untagged_variant_identity",
        message: `an untagged credential must not carry ${field}; tag it with kind: "${variant}" so the ${variant} rules apply`,
      });
    }
  }
  if (issues.length > 0) return fail(issues);

  return validateBaseCredential(record);
}

function validateBaseCredential(value: unknown): ValidationResult<CredentialIdentity> {
  const plain = toPlainRecord(value);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];
  // D4 exception, matching /credentials in @getsimpledirect/vinci-policy: an unrecognised
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
  const plain = toPlainRecord(value);
  if (!plain.ok) return plain;
  const raw: PlainRecord = plain.value;
  const base = validateBaseCredential(raw);
  if (!base.ok) return base;
  const known = base.value;

  const issues: ValidationIssue[] = [];
  if (!isIdentifier(raw.id)) {
    issues.push({ path: "/id", code: "invalid_id", message: "id must be an identifier" });
  }
  if (!hasField(raw, "expiresAt")) {
    issues.push({
      path: "/expiresAt",
      code: "required_field",
      message: "expiresAt is required; use null only for a non-expiring pairing credential",
    });
  } else if (raw.expiresAt !== null && !isTimestamp(raw.expiresAt)) {
    issues.push({
      path: "/expiresAt",
      code: "invalid_timestamp",
      message: "expiresAt must be an ISO-8601 timestamp or null",
    });
  }
  let publicKey: DevicePublicKey | null | undefined;
  if (!hasField(raw, "publicKey")) {
    issues.push({
      path: "/publicKey",
      code: "required_field",
      message: "publicKey is required; use null when no key is bound",
    });
  } else {
    publicKey = validatePublicKey(raw.publicKey, "/publicKey", issues);
  }
  // Without this, `{ kind: "device", workerId: "w1" }` validated as a device
  // and `{ kind: "worker", deviceId: "d1" }` as a worker — each validator
  // rewrote the discriminator to the variant it produces, so the tag a caller
  // supplied was decorative. A record that says what it is has to be it.
  if (hasField(raw, "kind") && raw.kind !== "device") {
    issues.push({
      path: "/kind",
      code: "wrong_credential_kind",
      message: `expected a device credential, got kind "${safeLabel(raw.kind)}"`,
    });
  }
  if (hasField(raw, "workerId")) {
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
  const deviceId = raw.deviceId;
  if (typeof deviceId !== "string" || deviceId.length === 0) {
    issues.push({ path: "/deviceId", code: "required_field", message: "a device credential requires a deviceId" });
  }

  if (issues.length > 0) return fail(issues);

  return ok(
    Object.freeze({
      kind: "device",
      deviceId: deviceId as DeviceId,
      id: raw.id as string,
      keyHash: known.keyHash,
      prefix: known.prefix,
      clientType: known.clientType as ClientType,
      scopes: Object.freeze([...known.scopes]) as readonly DeviceScope[],
      createdAt: known.createdAt,
      expiresAt: raw.expiresAt as Timestamp | null,
      publicKey: publicKey as DevicePublicKey | null,
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
  version: 2,
  compatibility: "frozen",
  /**
   * Rejected, not preserved — the D4 exception that also governs /credentials
   * in @getsimpledirect/vinci-policy. An unrecognised field on a credential may be the secret
   * itself, and preserving it would carry that secret into a record SR-3 says
   * must never hold one.
   */
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration:
    "Version 1 credentials lack required expiry and public-key identity fields and are rejected; an unknown expiry must never be inferred as trustworthy.",
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
  const plain = toPlainRecord(value);
  if (!plain.ok) return plain;
  const raw: PlainRecord = plain.value;
  const base = validateBaseCredential(raw);
  if (!base.ok) return base;
  const known = base.value;

  const issues: ValidationIssue[] = [];
  if (hasField(raw, "kind") && raw.kind !== "worker") {
    issues.push({
      path: "/kind",
      code: "wrong_credential_kind",
      message: `expected a worker credential, got kind "${safeLabel(raw.kind)}"`,
    });
  }
  if (hasField(raw, "deviceId")) {
    issues.push({
      path: "/deviceId",
      code: "field_not_valid_for_kind",
      message: "deviceId does not belong on a worker credential",
    });
  }
  for (const field of ["id", "expiresAt", "publicKey"] as const) {
    if (hasField(raw, field)) {
      issues.push({
        path: `/${field}`,
        code: "field_not_valid_for_kind",
        message: `${field} belongs to a device credential, not a worker credential`,
      });
    }
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
