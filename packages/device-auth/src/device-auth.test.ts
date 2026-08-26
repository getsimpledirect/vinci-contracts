import { Buffer } from "node:buffer";
import { describe, expect, expectTypeOf, it } from "vitest";
import { assertSchemaMetaComplete } from "@getsimpledirect/vinci-contracts";
import {
  CREDENTIAL_IDENTITY_SCHEMA_META,
  CLIENT_TYPES,
  CLIENT_TYPE_TO_DB,
  DEVICE_PUBLIC_KEY_KINDS,
  DEVICE_PAIRING_SCHEMA_META,
  DEVICE_SCOPES,
  DEVICE_SCOPES as DEVICE_SCOPE_LIST,
  ENFORCED_ROLES,
  PAIRING_STATES,
  RELAY_ACCESS_TOKEN_AUDIENCE,
  RELAY_ACCESS_TOKEN_MAX_LIFETIME_MS,
  RELAY_ACCESS_TOKEN_SCHEMA_META,
  ROLES,
  ROLE_SAFE_FALLBACK,
  SCOPES,
  SESSION_ROLES,
  SHIPPING_CLIENT_TYPES,
  UNENFORCED_ROLES,
  credentialIdentityDigest,
  isCredentialActiveAt,
  isPairingState,
  relayAccessTokenSigningPayload,
  revoke,
  validateCredentialIdentity,
  validateDeviceCredential,
  validateDevicePairing,
  validateRelayAccessToken,
  validateWorkerCredential,
  type CredentialIdentity,
  type DeviceCredential,
  type DeviceScope,
  type KeyHash,
  type Scope,
} from "./index.ts";

const baseCredential = {
  keyHash: "a".repeat(64),
  prefix: "vinci_live_ab12",
  clientType: "work",
  scopes: ["inference", "models"],
  createdAt: "2026-08-22T10:00:00.000Z",
  revokedAt: null,
} as const;

function credential(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...baseCredential, ...overrides };
}

function deviceCredential(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return credential({
    id: "cred-1",
    deviceId: "dev-1",
    expiresAt: null,
    publicKey: null,
    ...overrides,
  });
}

describe("schema meta", () => {
  it("declares complete metadata for every exported schema", () => {
    expect(() => assertSchemaMetaComplete(CREDENTIAL_IDENTITY_SCHEMA_META)).not.toThrow();
    expect(() => assertSchemaMetaComplete(DEVICE_PAIRING_SCHEMA_META)).not.toThrow();
    expect(() => assertSchemaMetaComplete(RELAY_ACCESS_TOKEN_SCHEMA_META)).not.toThrow();
  });

  it("declares the credential migration that rejects unknowable v1 expiry", () => {
    expect(CREDENTIAL_IDENTITY_SCHEMA_META.version).toBe(2);
    expect(CREDENTIAL_IDENTITY_SCHEMA_META.migration).not.toBe("none");
    expect(CREDENTIAL_IDENTITY_SCHEMA_META.migration).toContain("rejected");
  });
});

describe("credential identity (cannot carry a secret)", () => {
  it("accepts a valid credential identity", () => {
    const result = validateCredentialIdentity(credential());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.keyHash).toBe(baseCredential.keyHash);
  });

  it("rejects a record that carries the raw secret instead of a digest", () => {
    // This test previously asserted ok === true while being named "rejects",
    // documenting a guarantee the code did not provide. A secret is not a
    // digest, and the validator now says so.
    const result = validateCredentialIdentity(credential({ keyHash: "super-secret-value" }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "invalid_hash")).toBe(true);
  });

  it.each([
    ["too short", "abc123"],
    ["uppercase hex", "A".repeat(64)],
    ["63 chars", "a".repeat(63)],
    ["65 chars", "a".repeat(65)],
    ["a bearer token", "vinci_live_aaaaaaaaaaaaaaaaaaaaaaaa"],
    ["an empty string", ""],
  ])("rejects %s as a keyHash", (_label, keyHash) => {
    expect(validateCredentialIdentity(credential({ keyHash })).ok).toBe(false);
  });

  it("accepts a real sha256 digest", () => {
    // The shape must stay usable for the thing it actually stores.
    const digest = "e".repeat(64);
    const result = validateCredentialIdentity(credential({ keyHash: digest }));
    expect(result.ok).toBe(true);
  });

  it("refuses an unrecognised field rather than carrying it", () => {
    // A field nobody recognises may BE the secret. Preserving it would put it
    // inside a record SR-3 says must never hold one, so it fails closed.
    const result = validateCredentialIdentity(credential({ clientSecret: "s3cr3t" } as never));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === "unknown_credential_field")).toBe(true);
      // and the value must not have survived into the failure either
      expect(JSON.stringify(result.issues)).not.toContain("s3cr3t");
    }
  });

  it("enforces the digest at the type level: a plain secret string is not a KeyHash", () => {
    expectTypeOf<string>().not.toMatchTypeOf<KeyHash>();
  });

  it("enforces at the type level that a secret-bearing shape is not a CredentialIdentity", () => {
    type SecretBearingCredential = {
      readonly keyHash: string; // un-branded — could be the raw value
      readonly secret: string; // the actual secret value
      readonly prefix: string;
      readonly clientType: "work";
      readonly scopes: readonly Scope[];
      readonly createdAt: string;
      readonly revokedAt: string | null;
    };
    expectTypeOf<SecretBearingCredential>().not.toMatchTypeOf<CredentialIdentity>();
  });
});

describe("independent revocability", () => {
  it("revoking one credential leaves every other credential valid", () => {
    const a = credential();
    const b = credential({ prefix: "vinci_live_cd34" });
    const c = credential({ prefix: "vinci_live_ef56" });

    const okA = validateCredentialIdentity(a);
    const okB = validateCredentialIdentity(b);
    const okC = validateCredentialIdentity(c);
    expect(okA.ok && okB.ok && okC.ok).toBe(true);

    // Revoke only A.
    const revokedResult = revoke((okA as { ok: true; value: CredentialIdentity }).value, "2026-08-23T00:00:00.000Z");
    expect(revokedResult.ok).toBe(true);
    if (!revokedResult.ok) return;
    expect(revokedResult.value.revokedAt).toBe("2026-08-23T00:00:00.000Z");

    // B and C are untouched — neither reference is affected, immutably.
    expect((okB as { ok: true; value: CredentialIdentity }).value.revokedAt).toBeNull();
    expect((okC as { ok: true; value: CredentialIdentity }).value.revokedAt).toBeNull();
    // And A's original record is also unchanged (revoke returns a new object).
    expect(okA).toEqual({ ok: true, value: { ...a, scopes: ["inference", "models"] }, unknownFields: {} });
  });
});

describe("credential expiry and public-key identity", () => {
  const publicKey = (fill = 7) => ({
    kind: "Ed25519",
    keyId: "device-key-1",
    key: Buffer.alloc(32, fill).toString("base64url"),
  });

  it("requires v2 expiry and public-key fields instead of trusting a v1 record", () => {
    const { expiresAt: _expiry, publicKey: _key, ...v1 } = deviceCredential();
    const result = validateDeviceCredential(v1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.filter((entry) => entry.code === "required_field").map((entry) => entry.path)).toEqual([
        "/expiresAt",
        "/publicKey",
      ]);
    }
  });

  it("accepts null for a non-expiring pairing credential and a bound 32-byte key", () => {
    expect(validateDeviceCredential(deviceCredential()).ok).toBe(true);
    const bound = validateDeviceCredential(
      deviceCredential({ expiresAt: "2027-08-22T10:00:00.000Z", publicKey: publicKey() }),
    );
    expect(bound.ok).toBe(true);
    if (bound.ok) {
      expect(Object.isFrozen(bound.value)).toBe(true);
      expect(Object.isFrozen(bound.value.publicKey)).toBe(true);
      expect(bound.value.publicKey?.key).toBe(publicKey().key);
      expect(() => {
        (bound.value as { expiresAt: string | null }).expiresAt = null;
      }).toThrow();
      expect(() => {
        (bound.value as { publicKey: null }).publicKey = null;
      }).toThrow();
    }
  });

  it.each(DEVICE_PUBLIC_KEY_KINDS)("accepts a 32-byte %s public key", (kind) => {
    const result = validateDeviceCredential(
      deviceCredential({ publicKey: { ...publicKey(), kind } }),
    );
    expect(result.ok).toBe(true);
  });

  it.each([
    ["invalid_id", { id: "not an id" }],
    ["invalid_timestamp", { expiresAt: "2026-08-22" }],
    ["invalid_public_key", { publicKey: "not-a-record" }],
    ["unknown_public_key_field", { publicKey: { ...publicKey(), privateKey: "forbidden" } }],
    ["invalid_public_key_kind", { publicKey: { ...publicKey(), kind: "P-256" } }],
    ["invalid_public_key_id", { publicKey: { ...publicKey(), keyId: "not an id" } }],
    ["invalid_public_key_encoding", { publicKey: { ...publicKey(), key: "not+base64url==" } }],
    ["invalid_public_key_length", { publicKey: { ...publicKey(), key: Buffer.alloc(31).toString("base64url") } }],
  ])("drives the %s rejection", (code, override) => {
    const result = validateDeviceCredential(deviceCredential(override));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((entry) => entry.code === code)).toBe(true);
  });

  it("treats revocation and expiry boundaries as inactive and rejects non-canonical instants", () => {
    const result = validateDeviceCredential(
      deviceCredential({
        expiresAt: "2026-08-22T10:10:00.000Z",
        publicKey: publicKey(),
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(isCredentialActiveAt(result.value, "2026-08-22T10:09:59.999Z")).toBe(true);
    expect(isCredentialActiveAt(result.value, "2026-08-22T10:10:00.000Z")).toBe(false);
    expect(isCredentialActiveAt({ ...result.value, revokedAt: "2026-08-22T10:05:00.000Z" }, "2026-08-22T10:05:00.000Z")).toBe(false);
    expect(isCredentialActiveAt(result.value, "2026-08-22T10:09:59Z" as never)).toBe(false);
    expect(isCredentialActiveAt(result.value, Number.NaN as never)).toBe(false);
    expect(isCredentialActiveAt(result.value, -0 as never)).toBe(false);
  });

  it("keeps revocation out of the identity digest and covers public-key rotation", () => {
    const original = validateDeviceCredential(
      deviceCredential({ publicKey: publicKey(1) }),
    );
    const rotated = validateDeviceCredential(
      deviceCredential({ publicKey: publicKey(2) }),
    );
    expect(original.ok && rotated.ok).toBe(true);
    if (!original.ok || !rotated.ok) return;

    const before = credentialIdentityDigest(original.value);
    const revoked = revoke(original.value, "2026-08-23T00:00:00.000Z");
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) return;
    expect(credentialIdentityDigest(revoked.value as DeviceCredential)).toBe(before);
    expect(credentialIdentityDigest(rotated.value)).not.toBe(before);
  });
});

describe("client type (additive extension)", () => {
  it("keeps the shipping work/code values unchanged", () => {
    expect(SHIPPING_CLIENT_TYPES).toEqual(["work", "code"]);
    for (const value of SHIPPING_CLIENT_TYPES) expect(CLIENT_TYPES).toContain(value);
  });

  it("extends additively to Web, Desktop, Mobile, Code, Admin", () => {
    expect([...CLIENT_TYPES].sort()).toEqual(["admin", "code", "desktop", "mobile", "web", "work"]);
    expect(CLIENT_TYPES).toContain("web");
    expect(CLIENT_TYPES).toContain("desktop");
    expect(CLIENT_TYPES).toContain("mobile");
    expect(CLIENT_TYPES).toContain("admin");
    expect(CLIENT_TYPES).toContain("code");
  });

  it("states the mapping from work/code for every extended client type", () => {
    expect(CLIENT_TYPE_TO_DB).toEqual({
      work: "work",
      code: "code",
      web: "work",
      desktop: "work",
      mobile: "work",
      admin: null,
    });
  });
});

describe("device-token / acceptance-scope prohibition", () => {
  it("excludes acceptance from device scopes at the type level", () => {
    expectTypeOf<"acceptance">().not.toMatchTypeOf<DeviceScope>();
    expect(DEVICE_SCOPES).toEqual(["inference", "models", "usage"]);
  });

  it("rejects an acceptance scope at validation time (fail closed)", () => {
    const result = validateDeviceCredential(
      credential({ scopes: ["inference", "acceptance"], deviceId: "dev-1" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.code === "acceptance_forbidden")).toBe(true);
  });

  it("accepts a device credential with only device-valid scopes", () => {
    const result = validateDeviceCredential(deviceCredential());
    expect(result.ok).toBe(true);
  });
});

describe("pairing state", () => {
  it("models pending, authorized and consumed", () => {
    expect(PAIRING_STATES).toEqual(["pending", "authorized", "consumed"]);
    expect(PAIRING_STATES.every(isPairingState)).toBe(true);
    expect(isPairingState("bogus")).toBe(false);
  });

  it("validates a full device pairing record", () => {
    const result = validateDevicePairing({
      deviceCodeHash: "b".repeat(64),
      userCode: "ABCDEF",
      clientType: "work",
      status: "pending",
      userId: null,
      createdAt: "2026-08-22T10:00:00.000Z",
      expiresAt: "2026-08-23T10:00:00.000Z",
    });
    expect(result.ok).toBe(true);
  });

  it("fails closed on an unknown pairing state (no DB CHECK to rely on)", () => {
    const result = validateDevicePairing({
      deviceCodeHash: "b".repeat(64),
      userCode: "ABCDEF",
      clientType: "work",
      status: "weird",
      userId: null,
      createdAt: "2026-08-22T10:00:00.000Z",
      expiresAt: "2026-08-23T10:00:00.000Z",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.code === "unknown_pairing_state")).toBe(true);
  });
});

describe("scopes", () => {
  it("declares inference, models, usage and acceptance", () => {
    expect(SCOPES).toEqual(["inference", "models", "usage", "acceptance"]);
  });
});

describe("seven roles", () => {
  it("defines exactly seven roles", () => {
    expect(ROLES.length).toBe(7);
    expect(ROLES).toContain("owner");
    expect(ROLES).toContain("admin");
    expect(ROLES).toContain("member");
  });

  it("marks the four new roles as not yet enforced and maps each from an existing role", () => {
    expect(ENFORCED_ROLES).toEqual(["owner", "admin", "member"]);
    expect(UNENFORCED_ROLES.length).toBe(4);
    expect(new Set(ROLES).size).toBe(7);
    // Every role maps from one of the three enforced roles.
    for (const role of ROLES) {
      const fallback = ROLE_SAFE_FALLBACK[role];
      if (fallback !== null) expect(ENFORCED_ROLES).toContain(fallback);
    }
    // The four new roles are the unenforced ones.
    for (const role of UNENFORCED_ROLES) {
      expect(ENFORCED_ROLES).not.toContain(role);
    }
  });

  it("names approver, the role a functional requirement depends on", () => {
    // FR-4.7 must be able to say "require any user with a role", and the
    // approval centre needs to express who may clear a request. Neither works
    // without this member, so its absence is a functional gap, not a
    // reporting one.
    expect(ROLES).toContain("approver");
  });

  it("does not name a role `verifier`", () => {
    // `Actor` in @getsimpledirect/vinci-contracts already has a `verifier` arm meaning an
    // independent verification service. A person's org role by that name
    // would read as the same thing and is deliberately avoided.
    expect(ROLES).not.toContain("verifier");
  });

  it("degrades an authority-adding role to member, and never over-grants", () => {
    for (const role of ["operator", "approver", "auditor"] as const) {
      expect(ROLE_SAFE_FALLBACK[role]).toBe("member");
    }
  });

  it("gives read-only viewer no fallback at all", () => {
    // viewer is the only role that REMOVES capability relative to member.
    // Falling back to member would hand a read-only user write access, so
    // there is deliberately nothing to fall back to: null means deny.
    expect(ROLE_SAFE_FALLBACK.viewer).toBeNull();
  });
});

describe("D4 behavior", () => {
  it("fails closed on malformed data without coercion", () => {
    const result = validateCredentialIdentity(credential({ clientType: "adminx" as unknown }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe("/clientType");
  });

  it("does not coerce a malformed timestamp", () => {
    const result = validateCredentialIdentity(credential({ revokedAt: "not-a-date" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe("/revokedAt");
  });

  it("does NOT preserve unknown fields on a credential — it rejects them", () => {
    // The general D4 rule is preserve, so that an older consumer can round-trip
    // a newer producer's record. Credentials are the documented exception: an
    // unrecognised field here may be secret material, and a preserved secret
    // sits inside a record SR-3 says must never carry one. Same rule as
    // /credentials in @getsimpledirect/vinci-policy.
    const future = { mode: "future", values: [1, { untouched: true }] };
    const result = validateCredentialIdentity(credential({ futureTopLevel: future }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.code === "unknown_credential_field")).toBe(true);
    }
  });

  it("declares that rejection in its metadata rather than claiming to preserve", () => {
    // The claim and the behaviour have to agree; SR-6 forbids advertising a
    // guarantee the code does not provide.
    expect(CREDENTIAL_IDENTITY_SCHEMA_META.unknownFields).toBe("reject");
  });

  it("cannot have `acceptance` pushed onto a validated credential's scopes", () => {
    // The array was previously the caller's own, so a validated device
    // credential could be mutated afterwards to hold the one scope a device
    // token may never have — no cast, no re-validation.
    const result = validateDeviceCredential(deviceCredential());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => (result.value.scopes as string[]).push("acceptance")).toThrow();
      expect(result.value.scopes).not.toContain("acceptance");
    }
  });
});

it("exposes the requested scope/device scope constants", () => {
  expect(DEVICE_SCOPE_LIST).toEqual(["inference", "models", "usage"]);
});

describe("device pairing digests", () => {
  const pairing = (overrides: Record<string, unknown> = {}) => ({
    deviceCodeHash: "b".repeat(64),
    userCode: "WXYZ-1234",
    clientType: "code",
    status: "pending",
    userId: null,
    createdAt: "2026-08-22T10:00:00.000Z",
    expiresAt: "2026-08-22T10:15:00.000Z",
    ...overrides,
  });

  it("rejects the raw device code in the field meant to hold its digest", () => {
    // "non-empty string" accepted the device code itself — precisely the value
    // this column exists so as not to store.
    const result = validateDevicePairing(pairing({ deviceCodeHash: "WXYZ-1234-raw-device-code" }));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.some((i) => i.code === "invalid_hash")).toBe(true);
  });

  it("accepts a real digest, so the fix does not break the legitimate case", () => {
    expect(validateDevicePairing(pairing()).ok).toBe(true);
  });
});

describe("a worker credential cannot hold the acceptance scope either", () => {
  const workerCredential = (overrides: Record<string, unknown> = {}) =>
    credential({ kind: "worker", workerId: "wkr-1", ...overrides });

  it("refuses the acceptance scope on a worker credential", () => {
    // The prohibition existed only in the WorkerCredential type's scopes
    // narrowing, which is erased the moment data arrives from outside — the
    // only place credentials come from. A worker holding this scope can
    // certify its own work, which architectural principle 2 forbids.
    const result = validateWorkerCredential(
      workerCredential({ scopes: ["inference", "acceptance"] }),
    );
    expect(result.ok).toBe(false);
  });

  it("accepts the scopes a worker may legitimately hold", () => {
    expect(validateWorkerCredential(workerCredential()).ok).toBe(true);
  });

  it("requires a workerId", () => {
    const { workerId: _dropped, ...withoutId } = workerCredential();
    expect(validateWorkerCredential(withoutId).ok).toBe(false);
  });

  it("freezes its scopes, so acceptance cannot be added after validation", () => {
    const result = validateWorkerCredential(workerCredential());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(() => (result.value.scopes as string[]).push("acceptance")).toThrow();
    }
  });
});

describe("variant validation cannot be bypassed", () => {
  // Each of these was reachable at 9d3cce0. The guards existed; the paths
  // around them did too, which is the same thing as not having the guards.
  const cred = (o: Record<string, unknown> = {}) => credential(o);

  it("holds a tagged worker credential to the worker rules", () => {
    // validateCredentialIdentity validated the base shape only, so a record
    // tagged kind:"worker" carrying the acceptance scope passed here without
    // ever reaching validateWorkerCredential. An optional security check is
    // not a security check.
    const result = validateCredentialIdentity(
      cred({ kind: "worker", workerId: "w-1", scopes: ["inference", "acceptance"] }),
    );
    expect(result.ok).toBe(false);
  });

  it("holds a tagged device credential to the device rules", () => {
    const result = validateCredentialIdentity(
      cred({ kind: "device", deviceId: "d-1", scopes: ["inference", "acceptance"] }),
    );
    expect(result.ok).toBe(false);
  });

  it("refuses an unrecognised credential kind rather than falling back", () => {
    expect(validateCredentialIdentity(cred({ kind: "superuser" })).ok).toBe(false);
  });

  it("refuses a device credential submitted to the worker validator", () => {
    // Each validator rewrote the discriminator to the variant it produces, so
    // the tag the caller supplied was decorative.
    expect(validateWorkerCredential(cred({ kind: "device", workerId: "w-1" })).ok).toBe(false);
    expect(validateDeviceCredential(cred({ kind: "worker", deviceId: "d-1" })).ok).toBe(false);
  });

  it("refuses a credential carrying the other variant's identity field", () => {
    expect(validateWorkerCredential(cred({ kind: "worker", workerId: "w-1", deviceId: "d-1" })).ok).toBe(false);
    expect(validateDeviceCredential(cred({ kind: "device", deviceId: "d-1", workerId: "w-1" })).ok).toBe(false);
  });

  it("freezes the credential itself, not only its scopes array", () => {
    // Freezing the array stopped a push; it did not stop the whole array being
    // replaced with ["acceptance"].
    const result = validateWorkerCredential(cred({ kind: "worker", workerId: "w-1" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(() => {
        (result.value as { scopes: readonly string[] }).scopes = ["acceptance"];
      }).toThrow();
      expect(result.value.scopes).not.toContain("acceptance");
    }
  });
});

describe("an untagged credential cannot smuggle a variant identity", () => {
  // Class B again, and introduced by the fix for Class B: workerId and
  // deviceId were added to the known-field list so the reject-unknowns rule
  // would permit them on tagged variants. That also permitted them on an
  // UNTAGGED credential, which routes to base validation and never sees the
  // variant's scope rules.
  //
  // The result was a validated credential that silently dropped the identity
  // it was handed and kept the `acceptance` scope a worker or device may
  // never hold.
  const smuggled = (o: Record<string, unknown>) =>
    credential({ scopes: ["inference", "acceptance"], ...o });

  it.each([
    ["workerId with no kind", { workerId: "w-1" }],
    ["deviceId with no kind", { deviceId: "d-1" }],
    ["workerId with kind explicitly undefined", { kind: undefined, workerId: "w-1" }],
    ["deviceId with kind explicitly undefined", { kind: undefined, deviceId: "d-1" }],
  ])("refuses %s", (_label, extra) => {
    expect(validateCredentialIdentity(smuggled(extra)).ok).toBe(false);
  });

  it("distinguishes an absent kind from an own kind holding undefined", () => {
    // `kind === undefined` was treated as untagged even when the property was
    // present. Those are different assertions: one says nothing about the
    // kind, the other says the kind is undefined, which is not a kind.
    const withOwnUndefined = { ...credential(), kind: undefined };
    expect(Object.hasOwn(withOwnUndefined, "kind")).toBe(true);
    expect(validateCredentialIdentity(withOwnUndefined).ok).toBe(false);

    const withoutKind = credential();
    expect(Object.hasOwn(withoutKind, "kind")).toBe(false);
    expect(validateCredentialIdentity(withoutKind).ok).toBe(true);
  });

  it("still accepts a genuinely untagged credential with no variant identity", () => {
    // The fix must not make the generic form unusable — a manually issued
    // developer key is untagged by design.
    expect(validateCredentialIdentity(credential()).ok).toBe(true);
  });
});

describe("revoke does not undo the immutability validation established", () => {
  // revoke() spread into a NEW object, which was unfrozen. The scopes array it
  // carried was still frozen, so a push failed — but the whole property could
  // be reassigned to ["acceptance"]. That is the same whole-array-replacement
  // hole the freeze was added to close, reached by a second path, on a
  // credential that has just been revoked.
  const worker = () =>
    credential({ kind: "worker", workerId: "w-1", scopes: ["inference"] });
  const device = () =>
    deviceCredential({ kind: "device", deviceId: "d-1", scopes: ["inference"] });

  it.each([
    ["worker", worker, "workerId", "w-1"],
    ["device", device, "deviceId", "d-1"],
  ])("keeps a revoked %s credential frozen and identified", (_l, make, idField, idValue) => {
    const validated = validateCredentialIdentity(make());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const revokedResult = revoke(validated.value, "2026-08-23T00:00:00.000Z");
    expect(revokedResult.ok).toBe(true);
    if (!revokedResult.ok) return;
    const revoked = revokedResult.value;

    expect(Object.isFrozen(revoked)).toBe(true);
    expect(Object.isFrozen(revoked.scopes)).toBe(true);
    // The variant survives revocation — a revoked worker is still a worker.
    expect((revoked as Record<string, unknown>).kind).toBe(_l);
    expect((revoked as Record<string, unknown>)[idField]).toBe(idValue);
    expect(revoked.revokedAt).toBe("2026-08-23T00:00:00.000Z");

    expect(() => {
      (revoked as { scopes: readonly string[] }).scopes = ["acceptance"];
    }).toThrow();
    expect(revoked.scopes).not.toContain("acceptance");
  });

  it("does not share the scopes array with the credential it revoked", () => {
    // Sharing the reference means one array behind two records; freezing the
    // original is then the only thing standing between them.
    const validated = validateCredentialIdentity(worker());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const revokedResult = revoke(validated.value, "2026-08-23T00:00:00.000Z");
    expect(revokedResult.ok).toBe(true);
    if (!revokedResult.ok) return;
    expect(revokedResult.value.scopes).not.toBe(validated.value.scopes);
    expect([...revokedResult.value.scopes]).toEqual([...validated.value.scopes]);
  });

  it("still leaves the credential it was given untouched", () => {
    // Independent revocability (FR-9.3) rests on revoke never mutating input.
    const validated = validateCredentialIdentity(worker());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    revoke(validated.value, "2026-08-23T00:00:00.000Z");
    expect(validated.value.revokedAt).toBeNull();
  });
});

describe("how a credential was constructed cannot change the decision", () => {
  // These previously asserted that exotic inputs are REFUSED. That contract
  // required reflecting over the input, and reflection was a second read a
  // Proxy could answer differently — a field hidden from validation appeared in
  // the returned record. Input is now read exactly once, by serialization.
  //
  // The invariant that replaces it is stronger and is what actually matters
  // here: the decision depends only on the JSON data, never on how the object
  // carrying it was built. An attacker gains nothing by dressing a record up,
  // because the outcome is identical to sending the same JSON plainly.
  const fields = {
    keyHash: "a".repeat(64),
    prefix: "vinci_live_ab12",
    clientType: "work",
    createdAt: "2026-08-22T10:00:00.000Z",
    revokedAt: null,
  };

  const decidesTheSame = (exotic: unknown) => {
    const viaExotic = validateCredentialIdentity(exotic);
    const viaJson = validateCredentialIdentity(JSON.parse(JSON.stringify(exotic)));
    expect(viaExotic.ok).toBe(viaJson.ok);
    if (viaExotic.ok && viaJson.ok) expect(viaExotic.value).toEqual(viaJson.value);
    return viaExotic;
  };

  it("gains nothing from hiding kind and identity on a prototype", () => {
    // The inherited `kind: "worker"` and `workerId` are dropped, so this is
    // judged as the untagged credential its JSON actually describes. That is
    // not a privilege gain: an untagged credential may hold `acceptance`, and
    // the caller could have sent exactly this JSON directly.
    const proto = { kind: "worker", workerId: "w-1" };
    const inherited = Object.create(proto) as Record<string, unknown>;
    for (const [k, v] of Object.entries({ ...fields, scopes: ["inference", "acceptance"] })) {
      inherited[k] = v;
    }
    const result = decidesTheSame(inherited);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Crucially, nothing downstream can read it as a worker.
      expect((result.value as Record<string, unknown>).kind).toBeUndefined();
      expect((result.value as Record<string, unknown>).workerId).toBeUndefined();
    }
  });

  it("still refuses a tagged worker credential holding acceptance", () => {
    // The prohibition applies to what the data actually says it is.
    expect(
      validateCredentialIdentity(
        credential({ kind: "worker", workerId: "w-1", scopes: ["inference", "acceptance"] }),
      ).ok,
    ).toBe(false);
  });

  it("reads an accessor once, so it cannot answer differently later", () => {
    let reads = 0;
    const sneaky = {
      ...fields,
      get scopes() {
        reads += 1;
        return reads === 1 ? ["inference"] : ["acceptance"];
      },
    };
    const result = validateCredentialIdentity(sneaky);
    expect(reads).toBe(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect([...result.value.scopes]).toEqual(["inference"]);
  });

  it("drops symbol keys and non-enumerable fields rather than carrying them", () => {
    const withHidden: Record<string | symbol, unknown> = { ...fields, scopes: ["inference"] };
    withHidden[Symbol("hidden")] = "secret";
    Object.defineProperty(withHidden, "clientSecret", {
      value: "s3cr3t",
      enumerable: false,
      configurable: true,
    });
    const result = decidesTheSame(withHidden);
    // Whatever the outcome, the secret is not in it.
    expect(JSON.stringify(result)).not.toContain("s3cr3t");
  });

  it("does not echo attacker-supplied data back in an error message", () => {
    const hostile = {
      ...fields,
      scopes: ["inference"],
      kind: {
        [Symbol.toPrimitive]() {
          throw new Error("escaped validation");
        },
      },
    };
    expect(() => validateCredentialIdentity(hostile)).not.toThrow();
    expect(validateCredentialIdentity(hostile).ok).toBe(false);
  });
});

describe("revoke validates the moment it records", () => {
  const active = () => credential({ kind: "worker", workerId: "w-1" });

  it("refuses a malformed revocation timestamp", () => {
    // `at` was any string, so a malformed value could be written into the one
    // field recording WHEN authority ended.
    const validated = validateCredentialIdentity(active());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    for (const bad of ["yesterday", "2026-02-29T00:00:00.000Z", "2026-08-23", ""]) {
      expect(revoke(validated.value, bad).ok, bad).toBe(false);
    }
  });

  it("accepts a canonical one", () => {
    const validated = validateCredentialIdentity(active());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(revoke(validated.value, "2026-08-23T00:00:00.000Z").ok).toBe(true);
  });
});

describe("device-auth agrees with its sibling packages on timestamps", () => {
  it("refuses 2026-02-29, which is not a date", () => {
    // This package was left on the wrong side of a disagreement its own commit
    // described: the round-trip fix went to evidence and model-classes only.
    expect(validateCredentialIdentity(credential({ createdAt: "2026-02-29T12:34:56.789Z" })).ok).toBe(false);
  });
});

describe("relay access token", () => {
  const relayToken = (overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    tokenId: "token-1",
    credentialId: "cred-1",
    deviceId: "device-1",
    audience: RELAY_ACCESS_TOKEN_AUDIENCE,
    binding: {
      protocolVersion: 1,
      organizationId: null,
      workspaceId: "workspace-1",
      runId: "run-1",
      sessionId: "session-1",
    },
    sessionRole: "owner",
    issuedAt: "2026-08-26T12:00:00.000Z",
    expiresAt: "2026-08-26T12:10:00.000Z",
    issuerKeyId: "platform-key-1",
    signature: {
      alg: "Ed25519",
      value: Buffer.alloc(64, 9).toString("base64url"),
    },
    ...overrides,
  });

  it("accepts the exact 10-minute lifetime and returns a deeply frozen snapshot", () => {
    expect(RELAY_ACCESS_TOKEN_MAX_LIFETIME_MS).toBe(600_000);
    const result = validateRelayAccessToken(relayToken());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(Object.isFrozen(result.value.binding)).toBe(true);
      expect(Object.isFrozen(result.value.signature)).toBe(true);
    }
  });

  it.each(SESSION_ROLES)("accepts the shared %s session role", (sessionRole) => {
    expect(validateRelayAccessToken(relayToken({ sessionRole })).ok).toBe(true);
  });

  it("caps relay token lifetime at 10 minutes", () => {
    const result = validateRelayAccessToken(
      relayToken({ expiresAt: "2026-08-26T12:10:00.001Z" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((entry) => entry.code === "lifetime_exceeded")).toBe(true);
  });

  it("rejects missing expiry rather than treating the relay grant as long-lived", () => {
    const { expiresAt: _expiry, ...withoutExpiry } = relayToken();
    const result = validateRelayAccessToken(withoutExpiry);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((entry) => entry.code === "required_field")).toBe(true);
  });

  it.each([
    ["schema_version_mismatch", { schemaVersion: 2 }],
    ["invalid_id", { tokenId: "not an id" }],
    ["invalid_audience", { audience: "some-other-service" }],
    ["invalid_session_role", { sessionRole: "admin" }],
    ["invalid_timestamp", { issuedAt: "2026-08-26T12:00:00Z" }],
    ["expiry_not_after_issue", { expiresAt: "2026-08-26T12:00:00.000Z" }],
    ["invalid_record", { binding: null }],
    ["invalid_signature_algorithm", { signature: { ...relayToken().signature, alg: "HS256" } }],
    ["invalid_signature_value", { signature: { ...relayToken().signature, value: "" } }],
    ["invalid_signature_value", { signature: { ...relayToken().signature, value: Buffer.alloc(63, 1).toString("base64url") } }],
    ["invalid_signature_value", { signature: { ...relayToken().signature, value: Buffer.alloc(64, 1).toString("base64") } }],
    ["invalid_timestamp", { expiresAt: "2026-08-26T00:00:00Z" }],
  ])("drives the %s rejection", (code, override) => {
    const result = validateRelayAccessToken(relayToken(override));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((entry) => entry.code === code)).toBe(true);
  });

  it.each([Number.NaN, -0])("rejects non-canonical protocol number %s", (protocolVersion) => {
    const result = validateRelayAccessToken(
      relayToken({ binding: { ...relayToken().binding, protocolVersion } }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some((entry) =>
          entry.code === "invalid_protocol_version" || entry.code === "unsupported_value"),
      ).toBe(true);
    }
  });

  it("rejects hostile and unknown keys at every signed record boundary", () => {
    const cases = [
      { ...relayToken(), extra: "content" },
      relayToken({ binding: { ...relayToken().binding, extra: "content" } }),
      relayToken({ signature: { ...relayToken().signature, extra: "content" } }),
      JSON.parse(`{"__proto__":{"polluted":true},"tokenId":"token-1"}`),
    ];
    for (const value of cases) expect(validateRelayAccessToken(value).ok).toBe(false);
    const ordinaryUnknown = validateRelayAccessToken(cases[0]);
    expect(ordinaryUnknown.ok).toBe(false);
    if (!ordinaryUnknown.ok) {
      expect(ordinaryUnknown.issues.some((entry) => entry.code === "unknown_field")).toBe(true);
    }
  });

  it("requires explicit nullable organization identity and valid binding ids", () => {
    const { organizationId: _organization, ...missingOrganization } = relayToken().binding;
    const missing = validateRelayAccessToken(relayToken({ binding: missingOrganization }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.issues.some((entry) => entry.code === "required_field")).toBe(true);

    const invalid = validateRelayAccessToken(
      relayToken({ binding: { ...relayToken().binding, workspaceId: "not an id" } }),
    );
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.issues.some((entry) => entry.code === "invalid_id")).toBe(true);
  });

  it("produces canonical signed bytes while leaving crypto verification to the caller", () => {
    const first = validateRelayAccessToken(relayToken());
    const second = validateRelayAccessToken(
      relayToken({ signature: { alg: "Ed25519", value: Buffer.alloc(64, 10).toString("base64url") } }),
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;

    const firstPayload = relayAccessTokenSigningPayload(first.value);
    const secondPayload = relayAccessTokenSigningPayload(second.value);
    expect(firstPayload).toBeInstanceOf(Uint8Array);
    expect(firstPayload).toEqual(secondPayload);
    const text = new TextDecoder().decode(firstPayload);
    expect(text).toContain('"audience":"vinci-relay"');
    expect(text).toContain('"signature":{"alg":"Ed25519"}');
    expect(text).not.toContain(first.value.signature.value);
  });
});
