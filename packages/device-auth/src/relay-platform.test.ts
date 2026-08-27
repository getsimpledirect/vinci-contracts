import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  KEY_DIRECTORY_FAILURE_REASONS,
  KEY_DIRECTORY_SCHEMA_META,
  KEY_ROLES,
  RELAY_ACCESS_TOKEN_MAX_LIFETIME_MS,
  RELAY_ACCESS_TOKEN_REQUEST_SCHEMA_META,
  REVOCATION_ACTORS,
  REVOCATION_SNAPSHOT_SCHEMA_META,
  SESSION_ROLES,
  isKeyUsableAt,
  isSnapshotNewer,
  revocationSnapshotSigningPayload,
  validateKeyDirectoryResponse,
  validateRelayAccessTokenRequest,
  validateRevocationSnapshot,
  type KeyDirectoryEntry,
} from "./index.ts";

const NOW = "2026-08-27T12:00:00.000Z";
const KEY_BYTES = Buffer.alloc(32, 7).toString("base64url");
const SIGNATURE_BYTES = Buffer.alloc(64, 9).toString("base64url");

function keyEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    keyId: "platform-key-1",
    role: "platform-issuer",
    key: { kind: "Ed25519", keyId: "platform-key-1", key: KEY_BYTES },
    validFrom: "2026-08-27T11:00:00.000Z",
    validUntil: "2026-08-27T13:00:00.000Z",
    refreshAfter: "2026-08-27T12:00:15.000Z",
    status: "active",
    ...overrides,
  };
}

function keyResponse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 1, found: true, entry: keyEntry(), ...overrides };
}

function revocationSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: 12,
    issuedAt: NOW,
    issuerKeyId: "platform-key-1",
    revoked: [
      {
        credentialId: "credential-1",
        deviceId: "device-1",
        revokedAt: "2026-08-27T11:59:00.000Z",
        revokedBy: "dashboard",
      },
    ],
    signature: { alg: "Ed25519", value: SIGNATURE_BYTES },
    ...overrides,
  };
}

function tokenRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    credentialId: "credential-1",
    deviceId: "device-1",
    binding: {
      protocolVersion: 1,
      organizationId: null,
      workspaceId: "workspace-1",
      runId: "run-1",
      sessionId: "session-1",
    },
    sessionRole: "owner",
    requestedLifetimeMs: RELAY_ACCESS_TOKEN_MAX_LIFETIME_MS,
    requestedAt: NOW,
    ...overrides,
  };
}

describe("relay Platform schema metadata", () => {
  it.each([
    KEY_DIRECTORY_SCHEMA_META,
    REVOCATION_SNAPSHOT_SCHEMA_META,
    RELAY_ACCESS_TOKEN_REQUEST_SCHEMA_META,
  ])("declares the requested v1 fail-closed policy for $id", (meta) => {
    expect(meta).toMatchObject({
      version: 1,
      compatibility: "additive-only",
      unknownFields: "reject",
      malformedData: "fail-closed",
      migration: "none",
    });
  });
});

describe("key directory", () => {
  it.each(KEY_ROLES)("accepts the closed %s key role", (role) => {
    expect(validateKeyDirectoryResponse(keyResponse({ entry: keyEntry({ role }) }), NOW).ok).toBe(true);
  });

  it.each(KEY_DIRECTORY_FAILURE_REASONS)("accepts %s as a normal not-found response", (reason) => {
    const result = validateKeyDirectoryResponse(
      { schemaVersion: 1, found: false, keyId: "missing-key-1", reason },
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.found).toBe(false);
  });

  it.each(["Ed25519", "X25519"])("accepts a 32-byte canonical %s public key", (kind) => {
    const result = validateKeyDirectoryResponse(
      keyResponse({ entry: keyEntry({ key: { kind, keyId: "platform-key-1", key: KEY_BYTES } }) }),
      NOW,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.value.found) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.entry)).toBe(true);
      expect(Object.isFrozen(result.value.entry.key)).toBe(true);
    }
  });

  it("accepts an inclusive validFrom, an exclusive validUntil, and an absent planned end", () => {
    expect(validateKeyDirectoryResponse(
      keyResponse({ entry: keyEntry({ validFrom: NOW, validUntil: "2026-08-27T12:00:00.001Z" }) }),
      NOW,
    ).ok).toBe(true);
    // At the instant validUntil the key is already unusable — the same convention as DeviceCredential expiresAt.
    const atEnd = validateKeyDirectoryResponse(
      keyResponse({ entry: keyEntry({ validFrom: "2026-08-27T11:00:00.000Z", validUntil: NOW }) }),
      NOW,
    );
    expect(atEnd.ok).toBe(false);
    if (!atEnd.ok) expect(atEnd.issues.map((i) => i.code)).toContain("expired");
    const noEnd = keyEntry();
    delete noEnd.validUntil;
    expect(validateKeyDirectoryResponse(keyResponse({ entry: noEnd }), NOW).ok).toBe(true);
  });

  it("rejects every unknown closed-set member", () => {
    const cases = [
      keyResponse({ entry: keyEntry({ role: "toString" }) }),
      keyResponse({ entry: keyEntry({ status: "suspended" }) }),
      keyResponse({ entry: keyEntry({ key: { kind: "RSA", keyId: "platform-key-1", key: KEY_BYTES } }) }),
      { schemaVersion: 1, found: false, keyId: "missing-key-1", reason: "unknown" },
    ];
    for (const value of cases) expect(validateKeyDirectoryResponse(value, NOW).ok).toBe(false);
  });

  it.each([
    ["schema_version_mismatch", keyResponse({ schemaVersion: 2 }), NOW],
    ["invalid_validation_time", keyResponse(), "today"],
    ["invalid_discriminant", keyResponse({ found: "true" }), NOW],
    ["invalid_record", keyResponse({ entry: null }), NOW],
    ["invalid_id", keyResponse({ entry: keyEntry({ keyId: "not an id" }) }), NOW],
    ["key_id_mismatch", keyResponse({ entry: keyEntry({ key: { kind: "Ed25519", keyId: "other-key", key: KEY_BYTES } }) }), NOW],
    ["invalid_public_key_encoding", keyResponse({ entry: keyEntry({ key: { kind: "Ed25519", keyId: "platform-key-1", key: "not+url" } }) }), NOW],
    ["invalid_public_key_length", keyResponse({ entry: keyEntry({ key: { kind: "Ed25519", keyId: "platform-key-1", key: Buffer.alloc(31).toString("base64url") } }) }), NOW],
    ["invalid_timestamp", keyResponse({ entry: keyEntry({ refreshAfter: "soon" }) }), NOW],
    ["invalid_id", keyResponse({ entry: keyEntry({ supersededBy: "not an id" }) }), NOW],
    ["not_yet_valid", keyResponse({ entry: keyEntry({ validFrom: "2026-08-27T12:00:00.001Z" }) }), NOW],
    ["expired", keyResponse({ entry: keyEntry({ validUntil: "2026-08-27T11:59:59.999Z" }) }), NOW],
    ["invalid_time_order", keyResponse({ entry: keyEntry({ validFrom: "2026-08-27T12:30:00.000Z", validUntil: "2026-08-27T12:15:00.000Z" }) }), NOW],
    ["invalid_id", { schemaVersion: 1, found: false, keyId: "not an id", reason: "not_found" }, NOW],
  ])("drives the %s fail-closed branch", (code, value, now) => {
    const result = validateKeyDirectoryResponse(value, now);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((entry) => entry.code === code)).toBe(true);
  });

  it("rejects unknown fields at response, entry, and public-key boundaries", () => {
    const cases = [
      { ...keyResponse(), extra: true },
      keyResponse({ entry: keyEntry({ extra: true }) }),
      keyResponse({ entry: keyEntry({ key: { kind: "Ed25519", keyId: "platform-key-1", key: KEY_BYTES, extra: true } }) }),
      { schemaVersion: 1, found: false, keyId: "key-1", reason: "not_found", entry: keyEntry() },
    ];
    for (const value of cases) expect(validateKeyDirectoryResponse(value, NOW).ok).toBe(false);
  });

  it("returns true for a current active key with the requested role", () => {
    expect(isKeyUsableAt(keyEntry() as KeyDirectoryEntry, NOW, "platform-issuer")).toBe(true);
  });

  it("refuses a revoked key as unusable", () => {
    expect(isKeyUsableAt(keyEntry({ status: "revoked" }) as KeyDirectoryEntry, NOW, "platform-issuer")).toBe(false);
  });

  it("refuses a key with the wrong role as unusable", () => {
    expect(isKeyUsableAt(keyEntry() as KeyDirectoryEntry, NOW, "device-signer")).toBe(false);
  });

  it("refuses a not-yet-valid key as unusable", () => {
    expect(isKeyUsableAt(
      keyEntry({ validFrom: "2026-08-27T12:00:00.001Z" }) as KeyDirectoryEntry,
      NOW,
      "platform-issuer",
    )).toBe(false);
  });

  it("refuses an expired key as unusable", () => {
    expect(isKeyUsableAt(
      keyEntry({ validUntil: "2026-08-27T11:59:59.999Z" }) as KeyDirectoryEntry,
      NOW,
      "platform-issuer",
    )).toBe(false);
  });
});

describe("signed revocation snapshot", () => {
  it.each(REVOCATION_ACTORS)("accepts the shared %s revokedBy member", (revokedBy) => {
    const value = revocationSnapshot({
      revoked: [{ credentialId: "credential-1", deviceId: "device-1", revokedAt: NOW, revokedBy }],
    });
    expect(validateRevocationSnapshot(value).ok).toBe(true);
  });

  it("accepts version zero and returns a deeply frozen snapshot", () => {
    const result = validateRevocationSnapshot(revocationSnapshot({ version: 0 }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.revoked)).toBe(true);
      expect(Object.isFrozen(result.value.revoked[0])).toBe(true);
      expect(Object.isFrozen(result.value.signature)).toBe(true);
    }
  });

  it.each([
    ["schema_version_mismatch", { schemaVersion: 2 }],
    ["invalid_version", { version: -1 }],
    ["invalid_version", { version: 1.5 }],
    ["invalid_version", { version: -0 }],
    ["invalid_timestamp", { issuedAt: "now" }],
    ["invalid_id", { issuerKeyId: "not an id" }],
    ["invalid_array", { revoked: null }],
    ["invalid_record", { revoked: [null] }],
    ["invalid_id", { revoked: [{ credentialId: "bad id", deviceId: "device-1", revokedAt: NOW, revokedBy: "self" }] }],
    ["invalid_timestamp", { revoked: [{ credentialId: "credential-1", deviceId: "device-1", revokedAt: "today", revokedBy: "self" }] }],
    ["invalid_revocation_actor", { revoked: [{ credentialId: "credential-1", deviceId: "device-1", revokedAt: NOW, revokedBy: "operator" }] }],
    ["invalid_signature_algorithm", { signature: { alg: "HS256", value: SIGNATURE_BYTES } }],
    ["invalid_signature_value", { signature: { alg: "Ed25519", value: Buffer.alloc(63).toString("base64url") } }],
    ["invalid_signature_value", { signature: { alg: "Ed25519", value: Buffer.alloc(64).toString("base64") } }],
  ])("drives the %s fail-closed branch", (code, override) => {
    const result = validateRevocationSnapshot(revocationSnapshot(override));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((entry) => entry.code === code)).toBe(true);
  });

  it("rejects unknown fields at snapshot, revocation, and signature boundaries", () => {
    const cases = [
      { ...revocationSnapshot(), extra: true },
      revocationSnapshot({ revoked: [{ credentialId: "credential-1", deviceId: "device-1", revokedAt: NOW, revokedBy: "self", extra: true }] }),
      revocationSnapshot({ signature: { alg: "Ed25519", value: SIGNATURE_BYTES, extra: true } }),
    ];
    for (const value of cases) expect(validateRevocationSnapshot(value).ok).toBe(false);
  });

  it("produces deterministic bytes across insertion order and excludes the signature value", () => {
    const first = validateRevocationSnapshot(revocationSnapshot());
    const second = validateRevocationSnapshot({
      signature: { value: SIGNATURE_BYTES, alg: "Ed25519" },
      revoked: [{ revokedBy: "dashboard", revokedAt: "2026-08-27T11:59:00.000Z", deviceId: "device-1", credentialId: "credential-1" }],
      issuerKeyId: "platform-key-1",
      issuedAt: NOW,
      version: 12,
      schemaVersion: 1,
    });
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const left = revocationSnapshotSigningPayload(first.value);
    const right = revocationSnapshotSigningPayload(second.value);
    expect(left).toEqual(right);
    const text = new TextDecoder().decode(left);
    // The algorithm is covered; the signature bytes themselves are not (self-reference).
    expect(text).toContain('"signature":{"alg":"Ed25519"}');
    expect(text).not.toContain(SIGNATURE_BYTES);
  });

  it("completes a real Ed25519 signer and verifier round trip over the payload helper", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const placeholder = validateRevocationSnapshot(revocationSnapshot());
    expect(placeholder.ok).toBe(true);
    if (!placeholder.ok) return;

    const signature = sign(null, revocationSnapshotSigningPayload(placeholder.value), privateKey);
    const signed = validateRevocationSnapshot(
      revocationSnapshot({ signature: { alg: "Ed25519", value: signature.toString("base64url") } }),
    );
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    expect(verify(null, revocationSnapshotSigningPayload(signed.value), publicKey, signature)).toBe(true);
  });

  it("accepts only a strictly newer snapshot version", () => {
    expect(isSnapshotNewer(13, 12)).toBe(true);
    expect(isSnapshotNewer(12, 12)).toBe(false);
    expect(isSnapshotNewer(11, 12)).toBe(false);
    expect(isSnapshotNewer(-1, 12)).toBe(false);
  });
});

describe("relay access token request", () => {
  it.each(SESSION_ROLES)("accepts the shared %s session role", (sessionRole) => {
    expect(validateRelayAccessTokenRequest(tokenRequest({ sessionRole })).ok).toBe(true);
  });

  it("accepts an absent lifetime and the exact maximum without clamping", () => {
    const absent = tokenRequest();
    delete absent.requestedLifetimeMs;
    expect(validateRelayAccessTokenRequest(absent).ok).toBe(true);
    const maximum = validateRelayAccessTokenRequest(tokenRequest());
    expect(maximum.ok).toBe(true);
    if (maximum.ok) {
      expect(maximum.value.requestedLifetimeMs).toBe(RELAY_ACCESS_TOKEN_MAX_LIFETIME_MS);
      expect(Object.isFrozen(maximum.value)).toBe(true);
      expect(Object.isFrozen(maximum.value.binding)).toBe(true);
    }
  });

  it("rejects a lifetime above the maximum rather than clamping it", () => {
    const result = validateRelayAccessTokenRequest(
      tokenRequest({ requestedLifetimeMs: RELAY_ACCESS_TOKEN_MAX_LIFETIME_MS + 1 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((entry) => entry.code === "lifetime_exceeded")).toBe(true);
  });

  it.each([
    ["schema_version_mismatch", { schemaVersion: 2 }],
    ["invalid_id", { credentialId: "not an id" }],
    ["invalid_session_role", { sessionRole: "admin" }],
    ["invalid_timestamp", { requestedAt: "now" }],
    ["invalid_lifetime", { requestedLifetimeMs: 0 }],
    ["invalid_lifetime", { requestedLifetimeMs: -0 }],
    ["invalid_lifetime", { requestedLifetimeMs: 1.5 }],
    ["invalid_record", { binding: null }],
    ["invalid_protocol_version", { binding: { ...tokenRequest().binding as Record<string, unknown>, protocolVersion: 0 } }],
    ["invalid_id", { binding: { ...tokenRequest().binding as Record<string, unknown>, sessionId: "bad id" } }],
    ["invalid_id", { binding: { ...tokenRequest().binding as Record<string, unknown>, organizationId: "bad id" } }],
  ])("drives the %s fail-closed branch", (code, override) => {
    const result = validateRelayAccessTokenRequest(tokenRequest(override));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((entry) => entry.code === code)).toBe(true);
  });

  it("requires explicit nullable organization identity", () => {
    const binding = { ...tokenRequest().binding as Record<string, unknown> };
    delete binding.organizationId;
    const result = validateRelayAccessTokenRequest(tokenRequest({ binding }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((entry) => entry.code === "required_field")).toBe(true);
  });

  it("rejects unknown fields at request and binding boundaries", () => {
    expect(validateRelayAccessTokenRequest({ ...tokenRequest(), extra: true }).ok).toBe(false);
    expect(validateRelayAccessTokenRequest(
      tokenRequest({ binding: { ...tokenRequest().binding as Record<string, unknown>, extra: true } }),
    ).ok).toBe(false);
  });
});
