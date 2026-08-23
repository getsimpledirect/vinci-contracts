import { describe, expect, expectTypeOf, it } from "vitest";
import { assertSchemaMetaComplete } from "@vinci/contracts";
import {
  CREDENTIAL_IDENTITY_SCHEMA_META,
  CLIENT_TYPES,
  CLIENT_TYPE_TO_DB,
  DEVICE_PAIRING_SCHEMA_META,
  DEVICE_SCOPES,
  DEVICE_SCOPES as DEVICE_SCOPE_LIST,
  ENFORCED_ROLES,
  PAIRING_STATES,
  ROLES,
  ROLE_SAFE_FALLBACK,
  SCOPES,
  SHIPPING_CLIENT_TYPES,
  UNENFORCED_ROLES,
  isPairingState,
  revoke,
  validateCredentialIdentity,
  validateDeviceCredential,
  validateDevicePairing,
  validateWorkerCredential,
  type CredentialIdentity,
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

describe("schema meta", () => {
  it("declares complete metadata for every exported schema", () => {
    expect(() => assertSchemaMetaComplete(CREDENTIAL_IDENTITY_SCHEMA_META)).not.toThrow();
    expect(() => assertSchemaMetaComplete(DEVICE_PAIRING_SCHEMA_META)).not.toThrow();
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
    const revokedA = revoke((okA as { ok: true; value: CredentialIdentity }).value, "2026-08-23T00:00:00.000Z");
    expect(revokedA.revokedAt).toBe("2026-08-23T00:00:00.000Z");

    // B and C are untouched — neither reference is affected, immutably.
    expect((okB as { ok: true; value: CredentialIdentity }).value.revokedAt).toBeNull();
    expect((okC as { ok: true; value: CredentialIdentity }).value.revokedAt).toBeNull();
    // And A's original record is also unchanged (revoke returns a new object).
    expect(okA).toEqual({ ok: true, value: { ...a, scopes: ["inference", "models"] }, unknownFields: {} });
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
    const result = validateDeviceCredential(credential({ deviceId: "dev-1" }));
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
    // `Actor` in @vinci/contracts already has a `verifier` arm meaning an
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
    // /credentials in @vinci/policy.
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
    const result = validateDeviceCredential(credential({ deviceId: "dev-1" }));
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
