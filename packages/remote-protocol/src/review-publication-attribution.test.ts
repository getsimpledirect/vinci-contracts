import { Buffer } from "node:buffer";
import { createPrivateKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertSchemaMetaComplete } from "@getsimpledirect/vinci-contracts";
import {
  MAX_REVIEW_PUBLICATION_ATTRIBUTION_LIFETIME_MS,
  REVIEW_PUBLICATION_ATTRIBUTION_SCHEMA_META,
  REVIEW_PUBLICATION_AUDIENCE,
  REVIEW_PUBLICATION_PURPOSE,
  REVIEW_PUBLICATION_VERDICTS,
  formatReviewPublicationReference,
  parseReviewPublicationAttributionJson,
  reviewPublicationAttributionDigest,
  reviewPublicationAttributionSigningPayload,
  validateReviewPublicationAttribution,
  validateReviewPublicationReference,
  verifyReviewPublicationAttributionSignature,
  type ReviewPublicationAttribution,
} from "./index.ts";
import {
  MAX_SIGNED_JSON_BYTES,
  MAX_SIGNED_JSON_DEPTH,
  MAX_SIGNED_JSON_MEMBERS,
  MAX_SIGNED_JSON_NODES,
  MAX_SIGNED_JSON_STRING_BYTES,
  parseStrictSignedJson,
} from "./strict-json.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = join(HERE, "..");
const ROOT = join(PACKAGE, "..", "..");
const VECTORS = join(PACKAGE, "vectors");
const NOW = "2026-09-04T12:05:00.000Z";

const read = (name: string): string => readFileSync(join(VECTORS, name), "utf8");
const source = read("valid-v1.json");
const fixture = (): Record<string, unknown> => JSON.parse(source) as Record<string, unknown>;

function issueCodes(result: { readonly ok: boolean; readonly issues?: readonly { readonly code: string }[] }): string[] {
  return result.ok ? [] : (result.issues ?? []).map(({ code }) => code);
}

function validated(value: unknown = fixture()): ReviewPublicationAttribution {
  const result = validateReviewPublicationAttribution(value, NOW);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("fixture must validate");
  return result.value;
}

describe("ReviewPublicationAttribution v1 shape and authority boundary", () => {
  it("pins the closed purpose, audience, verdicts, lifetime and schema policy", () => {
    expect(REVIEW_PUBLICATION_PURPOSE).toBe("guard_review.publish");
    expect(REVIEW_PUBLICATION_AUDIENCE).toBe("vinci-acceptance");
    expect(REVIEW_PUBLICATION_VERDICTS).toEqual(["GO", "BLOCK"]);
    expect(MAX_REVIEW_PUBLICATION_ATTRIBUTION_LIFETIME_MS).toBe(600_000);
    expect(() => assertSchemaMetaComplete(REVIEW_PUBLICATION_ATTRIBUTION_SCHEMA_META)).not.toThrow();
    expect(REVIEW_PUBLICATION_ATTRIBUTION_SCHEMA_META).toEqual({
      id: "vinci.review-publication-attribution",
      version: 1,
      compatibility: "frozen",
      unknownFields: "reject",
      malformedData: "fail-closed",
      migration: "none",
    });
  });

  it("accepts both verdicts and every central Actor arm without inventing another identity type", () => {
    const actors = [
      { kind: "user", userId: "user-1", deviceId: "device-1" },
      { kind: "worker", workerId: "worker-1" },
      { kind: "policy", policyId: "policy-1", policyVersion: 1 },
      { kind: "system", component: "vinci-governance-cloud" },
      { kind: "verifier", verifierId: "verifier-1", independent: false },
    ];
    for (const verdict of REVIEW_PUBLICATION_VERDICTS) {
      for (const actor of actors) {
        expect(validateReviewPublicationAttribution({ ...fixture(), verdict, actor }, NOW).ok).toBe(true);
      }
    }
  });

  it("requires an exact verifier identity and independence disclosure", () => {
    const actors = [
      { kind: "verifier", verifierId: "verifier-1" },
      { kind: "verifier", independent: true },
      { kind: "verifier", verifierId: "verifier-1", independent: "yes" },
      { kind: "worker", workerId: "worker-1", independent: true },
      { kind: "verifier", verifierId: "verifier-1", independent: true, runId: "client-shortcut" },
    ];
    for (const actor of actors) {
      expect(issueCodes(validateReviewPublicationAttribution({ ...fixture(), actor }, NOW)), JSON.stringify(actor))
        .toContain("invalid_actor");
    }
  });

  it("makes every top-level, binding and GitHub subject field required", () => {
    const top = fixture();
    for (const field of Object.keys(top)) {
      const changed = fixture();
      delete changed[field];
      expect(validateReviewPublicationAttribution(changed, NOW).ok, `top-level ${field}`).toBe(false);
    }
    for (const compartment of ["binding", "subject"] as const) {
      const fields = Object.keys(fixture()[compartment] as Record<string, unknown>);
      for (const field of fields) {
        const changed = fixture();
        const nested = { ...(changed[compartment] as Record<string, unknown>) };
        delete nested[field];
        changed[compartment] = nested;
        expect(validateReviewPublicationAttribution(changed, NOW).ok, `${compartment}.${field}`).toBe(false);
      }
    }
  });

  it("rejects client-authored authority shortcuts and unknown fields at every signed level", () => {
    const cases = [
      { ...fixture(), organizationId: "client-org" },
      { ...fixture(), workspaceId: "client-workspace" },
      { ...fixture(), runId: "client-run" },
      { ...fixture(), sessionId: "client-session" },
      { ...fixture(), independent: true },
      { ...fixture(), subject: { ...(fixture().subject as object), repositoryOwner: "display-only" } },
      { ...fixture(), binding: { ...(fixture().binding as object), actor: "client-actor" } },
      { ...fixture(), signature: { ...(fixture().signature as object), publicKey: "shortcut" } },
    ];
    for (const value of cases) {
      expect(issueCodes(validateReviewPublicationAttribution(value, NOW))).toContain("unknown_field");
    }
  });

  it("rejects wrong fixed values, malformed scalars, unsafe integers and time bounds", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["schema_version_mismatch", { schemaVersion: 2 }],
      ["invalid_purpose", { purpose: "guard_review.read" }],
      ["invalid_audience", { audience: "vinci-governor" }],
      ["invalid_verdict", { verdict: "VERIFIED_PASS" }],
      ["invalid_digest", { recordSetDigest: "D".repeat(64) }],
      ["invalid_id", { idempotencyKey: "has space" }],
      ["invalid_timestamp", { issuedAt: "2026-09-04T12:00:00Z" }],
      ["invalid_time_order", { expiresAt: "2026-09-04T12:00:00.000Z" }],
      ["lifetime_exceeded", { expiresAt: "2026-09-04T12:10:00.001Z" }],
      ["expired", { issuedAt: "2026-09-04T11:50:00.000Z", expiresAt: "2026-09-04T12:00:00.000Z" }],
      ["invalid_signature_algorithm", { signature: { alg: "none", value: read("signature.txt").trim() } }],
      ["invalid_signature_value", { signature: { alg: "Ed25519", value: "AQID" } }],
      ["invalid_provider", { subject: { ...(fixture().subject as object), provider: "gitlab" } }],
      ["invalid_git_sha", { subject: { ...(fixture().subject as object), headSha: "A".repeat(40) } }],
      ["invalid_pull_request_number", { subject: { ...(fixture().subject as object), pullRequestNumber: Number.MAX_SAFE_INTEGER + 1 } }],
      ["invalid_pull_request_number", { subject: { ...(fixture().subject as object), pullRequestNumber: -0 } }],
      ["invalid_validation_time", {}],
    ];
    for (const [code, overrides] of cases) {
      const now = code === "invalid_validation_time" ? "today" : NOW;
      expect(issueCodes(validateReviewPublicationAttribution({ ...fixture(), ...overrides }, now)), code).toContain(code);
    }
  });

  it("accepts the exact ten-minute lifetime and expires exclusively", () => {
    expect(validateReviewPublicationAttribution(fixture(), "2026-09-04T12:09:59.999Z").ok).toBe(true);
    expect(issueCodes(validateReviewPublicationAttribution(fixture(), "2026-09-04T12:10:00.000Z")))
      .toContain("expired");
  });

  it("returns one deeply frozen snapshot and refuses hostile prototypes/proxies", () => {
    const input = fixture();
    const result = validateReviewPublicationAttribution(input, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.actor)).toBe(true);
    expect(Object.isFrozen(result.value.binding)).toBe(true);
    expect(Object.isFrozen(result.value.subject)).toBe(true);
    (input.subject as Record<string, unknown>).headSha = "f".repeat(40);
    expect(result.value.subject.headSha).toBe("a".repeat(40));

    expect(validateReviewPublicationAttribution(Object.create(fixture()), NOW).ok).toBe(false);
    const accessor = fixture();
    let reads = 0;
    Object.defineProperty(accessor.subject as object, "headSha", {
      enumerable: true,
      get: () => {
        reads += 1;
        return reads === 1 ? "a".repeat(40) : "f".repeat(40);
      },
    });
    const captured = validateReviewPublicationAttribution(accessor, NOW);
    expect(captured.ok).toBe(true);
    expect(reads).toBe(1);
    if (captured.ok) expect(captured.value.subject.headSha).toBe("a".repeat(40));
    const proxy = new Proxy({}, { ownKeys: () => { throw new Error("trap"); } });
    expect(() => validateReviewPublicationAttribution(proxy, NOW)).not.toThrow();
    expect(validateReviewPublicationAttribution(proxy, NOW).ok).toBe(false);
  });
});

describe("strict JSON ingress", () => {
  it("accepts string and UTF-8 bytes through the alternate public parser", () => {
    for (const input of [source, Buffer.from(source, "utf8")]) {
      const result = parseReviewPublicationAttributionJson(input, NOW);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual(validated());
    }
  });

  it("rejects duplicate decoded names, hostile keys, malformed UTF-8 and Unicode hazards", () => {
    const duplicate = source.replace('"schemaVersion": 1,', '"schemaVersion": 1, "schemaVersion": 1,');
    const escapedDuplicate = source.replace('"schemaVersion": 1,', '"schemaVersion": 1, "schema\\u0056ersion": 1,');
    const hostile = source.replace('"schemaVersion": 1,', '"__proto__": {"polluted": true}, "schemaVersion": 1,');
    expect(issueCodes(parseReviewPublicationAttributionJson(duplicate, NOW))).toContain("duplicate_field");
    expect(issueCodes(parseReviewPublicationAttributionJson(escapedDuplicate, NOW))).toContain("duplicate_field");
    expect(issueCodes(parseReviewPublicationAttributionJson(hostile, NOW))).toContain("forbidden_key");
    expect(issueCodes(parseReviewPublicationAttributionJson(Uint8Array.from([0x7b, 0x22, 0xff, 0x22, 0x7d]), NOW)))
      .toContain("invalid_utf8");
    for (const invalid of [
      source.replace("verifier-01JTEST", "\\ud800"),
      source.replace("verifier-01JTEST", "e\\u0301"),
    ]) {
      expect(parseReviewPublicationAttributionJson(invalid, NOW).ok).toBe(false);
    }
  });

  it("rejects precision and numeric spelling hazards before object validation", () => {
    for (const token of ["9007199254740992", "-0", "1.0", "1e0"]) {
      const changed = source.replace('"pullRequestNumber": 10', `"pullRequestNumber": ${token}`);
      expect(parseReviewPublicationAttributionJson(changed, NOW).ok, token).toBe(false);
    }
  });

  it("rejects every committed invalid vector with its cross-language code", () => {
    const cases = JSON.parse(read("invalid-v1.json")) as ReadonlyArray<{
      readonly name: string;
      readonly code: string;
      readonly input: string;
    }>;
    expect(cases.length).toBeGreaterThanOrEqual(12);
    for (const entry of cases) {
      expect(issueCodes(parseReviewPublicationAttributionJson(entry.input, NOW)), entry.name)
        .toContain(entry.code);
    }
  });

  it("bounds raw input bytes, nesting, width, node count and string bytes", () => {
    expect(MAX_SIGNED_JSON_BYTES).toBe(1_000_000);
    expect(MAX_SIGNED_JSON_DEPTH).toBe(32);
    expect(MAX_SIGNED_JSON_NODES).toBe(200_000);
    expect(MAX_SIGNED_JSON_MEMBERS).toBe(10_000);
    expect(MAX_SIGNED_JSON_STRING_BYTES).toBe(262_144);

    const deep = `${"[".repeat(1_100)}0${"]".repeat(1_100)}`;
    expect(issueCodes(parseReviewPublicationAttributionJson(deep, NOW))).toContain("too_deep");
    const wide = `[${new Array(MAX_SIGNED_JSON_MEMBERS + 1).fill("0").join(",")}]`;
    expect(issueCodes(parseReviewPublicationAttributionJson(wide, NOW))).toContain("too_many_keys");
    const row = `[${new Array(MAX_SIGNED_JSON_MEMBERS).fill("0").join(",")}]`;
    const manyNodes = `[${new Array(21).fill(row).join(",")}]`;
    expect(issueCodes(parseReviewPublicationAttributionJson(manyNodes, NOW))).toContain("too_many_nodes");
    const longString = `{"value":"${"a".repeat(MAX_SIGNED_JSON_STRING_BYTES + 1)}"}`;
    expect(issueCodes(parseReviewPublicationAttributionJson(longString, NOW))).toContain("too_large");
    expect(issueCodes(parseReviewPublicationAttributionJson(" ".repeat(MAX_SIGNED_JSON_BYTES + 1), NOW)))
      .toContain("too_large");
  });

  it("accepts each exact raw resource boundary so the caps discriminate", () => {
    expect(parseStrictSignedJson(`${"[".repeat(MAX_SIGNED_JSON_DEPTH)}0${"]".repeat(MAX_SIGNED_JSON_DEPTH)}`).ok)
      .toBe(true);
    expect(parseStrictSignedJson(`[${new Array(MAX_SIGNED_JSON_MEMBERS).fill("0").join(",")}]`).ok)
      .toBe(true);
    expect(parseStrictSignedJson(`"${"a".repeat(MAX_SIGNED_JSON_STRING_BYTES)}"`).ok).toBe(true);
    expect(parseStrictSignedJson(`${" ".repeat(MAX_SIGNED_JSON_BYTES - 1)}0`).ok).toBe(true);

    const fullRow = `[${new Array(MAX_SIGNED_JSON_MEMBERS).fill("0").join(",")}]`;
    const finalRow = `[${new Array(9_979).fill("0").join(",")}]`;
    const exactNodes = `[${[...new Array(19).fill(fullRow), finalRow].join(",")}]`;
    expect(parseStrictSignedJson(exactNodes).ok).toBe(true);
    const overNodes = exactNodes.replace(finalRow, `[${new Array(9_980).fill("0").join(",")}]`);
    expect(issueCodes(parseStrictSignedJson(overNodes))).toContain("too_many_nodes");
  });

  it("fails closed for deep, cyclic, wide and node-heavy direct objects", () => {
    const cyclicUnknown = fixture();
    cyclicUnknown.unknown = cyclicUnknown;
    expect(() => validateReviewPublicationAttribution(cyclicUnknown, NOW)).not.toThrow();
    expect(issueCodes(validateReviewPublicationAttribution(cyclicUnknown, NOW))).toContain("not_serializable");

    const cyclicActor = { kind: "verifier", verifierId: undefined as unknown, independent: true };
    cyclicActor.verifierId = cyclicActor;
    expect(issueCodes(validateReviewPublicationAttribution({ ...fixture(), actor: cyclicActor }, NOW)))
      .toContain("not_serializable");

    let deep: unknown = "verifier-1";
    for (let index = 0; index < 1_100; index += 1) deep = [deep];
    expect(issueCodes(validateReviewPublicationAttribution({
      ...fixture(),
      actor: { kind: "verifier", verifierId: deep, independent: true },
    }, NOW))).toContain("too_deep");

    expect(issueCodes(validateReviewPublicationAttribution({
      ...fixture(),
      actor: {
        kind: "verifier",
        verifierId: new Array(MAX_SIGNED_JSON_MEMBERS + 1).fill("x"),
        independent: true,
      },
    }, NOW))).toContain("too_many_keys");

    const row = new Array(MAX_SIGNED_JSON_MEMBERS).fill(0);
    const nodeHeavyCodes = issueCodes(validateReviewPublicationAttribution({
      ...fixture(),
      actor: { kind: "verifier", verifierId: new Array(21).fill(row), independent: true },
    }, NOW));
    expect(["too_many_nodes", "too_large"]).toContain(nodeHeavyCodes[0]);
  });

  it("rejects a nested unknown field without inspecting it as authority", () => {
    const input = JSON.parse(source) as Record<string, unknown>;
    (input.subject as Record<string, unknown>).unknown = { nested: ["attacker"] };
    const result = parseReviewPublicationAttributionJson(JSON.stringify(input), NOW);
    expect(issueCodes(result)).toContain("unknown_field");
  });
});

describe("canonical bytes, digest, signature and compact reference", () => {
  it("matches the committed canonical bytes, digest, signature and public key", () => {
    const value = validated();
    const payload = Buffer.from(reviewPublicationAttributionSigningPayload(value));
    expect(payload).toHaveLength(843);
    expect(payload).toEqual(readFileSync(join(VECTORS, "canonical.txt")));
    expect(reviewPublicationAttributionDigest(value)).toBe(read("digest.txt").trim());
    expect(value.signature.value).toBe(read("signature.txt").trim());
    expect(verifyReviewPublicationAttributionSignature(value, read("public-key.txt").trim())).toBe(true);
  });

  it("is independent of input key order and signature value", () => {
    const value = validated();
    const reordered = validated({
      signature: { value: Buffer.alloc(64, 0x5a).toString("base64url"), alg: "Ed25519" },
      issuerKeyId: value.issuerKeyId,
      expiresAt: value.expiresAt,
      issuedAt: value.issuedAt,
      idempotencyKey: value.idempotencyKey,
      recordSetDigest: value.recordSetDigest,
      verdict: value.verdict,
      subject: { ...value.subject },
      binding: { ...value.binding },
      actor: { ...value.actor },
      audience: value.audience,
      purpose: value.purpose,
      schemaVersion: value.schemaVersion,
    });
    expect(reviewPublicationAttributionSigningPayload(reordered))
      .toEqual(reviewPublicationAttributionSigningPayload(value));
    expect(reviewPublicationAttributionDigest(reordered)).toBe(reviewPublicationAttributionDigest(value));
  });

  it("snapshots stateful direct objects once across payload, digest and verification", () => {
    const stateful = (signatureValue = read("signature.txt").trim()) => {
      const value = fixture();
      value.signature = { alg: "Ed25519", value: signatureValue };
      let reads = 0;
      Object.defineProperty(value, "issuedAt", {
        enumerable: true,
        get: () => {
          reads += 1;
          return reads <= 2 ? "2026-09-04T12:00:00.000Z" : "0000-01-01T00:00:00.000Z";
        },
      });
      return {
        value: value as unknown as ReviewPublicationAttribution,
        reads: () => reads,
      };
    };

    const payloadInput = stateful();
    expect(Buffer.from(reviewPublicationAttributionSigningPayload(payloadInput.value)))
      .toEqual(readFileSync(join(VECTORS, "canonical.txt")));
    expect(payloadInput.reads()).toBe(1);

    const digestInput = stateful();
    expect(reviewPublicationAttributionDigest(digestInput.value)).toBe(read("digest.txt").trim());
    expect(digestInput.reads()).toBe(1);

    const invalidPayload = Buffer.from(read("canonical.txt").replace(
      '"issuedAt":"2026-09-04T12:00:00.000Z"',
      '"issuedAt":"0000-01-01T00:00:00.000Z"',
    ));
    expect(invalidPayload.toString("utf8")).toContain('"issuedAt":"0000-01-01T00:00:00.000Z"');
    const seed = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
    const privateKey = createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
      format: "der",
      type: "pkcs8",
    });
    const verificationInput = stateful(sign(null, invalidPayload, privateKey).toString("base64url"));
    expect(verifyReviewPublicationAttributionSignature(
      verificationInput.value,
      read("public-key.txt").trim(),
    )).toBe(false);
    expect(verificationInput.reads()).toBe(1);
  });

  it("makes every one-byte mutation of the signed bytes fail Ed25519 verification", async () => {
    const value = validated();
    const payload = reviewPublicationAttributionSigningPayload(value);
    const signature = Buffer.from(value.signature.value, "base64url");
    const raw = Buffer.from(read("public-key.txt").trim(), "base64url");
    const { createPublicKey } = await import("node:crypto");
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
      format: "der",
      type: "spki",
    });
    expect(verify(null, payload, key, signature)).toBe(true);
    for (let index = 0; index < payload.length; index += 1) {
      const changed = Buffer.from(payload);
      changed[index] ^= 1;
      expect(verify(null, changed, key, signature), `byte ${index}`).toBe(false);
    }
  });

  it("binds each of the 24 signed semantic leaves in the digest and signature", () => {
    const original = validated();
    const cases: Array<[string, ReviewPublicationAttribution]> = [
      ["schemaVersion", { ...original, schemaVersion: 2 } as unknown as ReviewPublicationAttribution],
      ["purpose", { ...original, purpose: "guard_review.read" } as unknown as ReviewPublicationAttribution],
      ["audience", { ...original, audience: "vinci-governor" } as unknown as ReviewPublicationAttribution],
      ["actor.kind", { ...original, actor: { ...original.actor, kind: "system" } } as unknown as ReviewPublicationAttribution],
      ["actor.verifierId", { ...original, actor: { ...original.actor, verifierId: "verifier-02JTEST" } } as ReviewPublicationAttribution],
      ["actor.independent", { ...original, actor: { ...original.actor, independent: false } } as ReviewPublicationAttribution],
      ["binding.protocolVersion", { ...original, binding: { ...original.binding, protocolVersion: 2 } } as ReviewPublicationAttribution],
      ["binding.organizationId", { ...original, binding: { ...original.binding, organizationId: "organization-2" } } as ReviewPublicationAttribution],
      ["binding.workspaceId", { ...original, binding: { ...original.binding, workspaceId: "workspace-2" } } as ReviewPublicationAttribution],
      ["binding.runId", { ...original, binding: { ...original.binding, runId: "review-run-2" } } as ReviewPublicationAttribution],
      ["binding.sessionId", { ...original, binding: { ...original.binding, sessionId: "session-2" } } as ReviewPublicationAttribution],
      ["subject.provider", { ...original, subject: { ...original.subject, provider: "gitlab" } } as unknown as ReviewPublicationAttribution],
      ["subject.repositoryNodeId", { ...original, subject: { ...original.subject, repositoryNodeId: "R_kgDOOther" } }],
      ["subject.pullRequestNumber", { ...original, subject: { ...original.subject, pullRequestNumber: 11 } }],
      ["subject.headSha", { ...original, subject: { ...original.subject, headSha: "e".repeat(40) } }],
      ["subject.baseSha", { ...original, subject: { ...original.subject, baseSha: "e".repeat(40) } }],
      ["subject.headTreeSha", { ...original, subject: { ...original.subject, headTreeSha: "e".repeat(40) } }],
      ["verdict", { ...original, verdict: "BLOCK" }],
      ["recordSetDigest", { ...original, recordSetDigest: "e".repeat(64) }],
      ["idempotencyKey", { ...original, idempotencyKey: "review-publication-02JTEST" }],
      ["issuedAt", { ...original, issuedAt: "2026-09-04T12:00:00.001Z" }],
      ["expiresAt", { ...original, expiresAt: "2026-09-04T12:09:59.999Z" }],
      ["issuerKeyId", { ...original, issuerKeyId: "vgc-platform-key-2" }],
      ["signature.alg", { ...original, signature: { ...original.signature, alg: "Ed25518" } } as unknown as ReviewPublicationAttribution],
    ];
    expect(cases).toHaveLength(24);
    for (const [label, changed] of cases) {
      expect(reviewPublicationAttributionDigest(changed), label)
        .not.toBe(reviewPublicationAttributionDigest(original));
      expect(verifyReviewPublicationAttributionSignature(changed, read("public-key.txt").trim()), label)
        .toBe(false);
    }
  });

  it("rejects wrong/malformed keys and signatures, including Ed25519 S+L malleability", () => {
    const original = validated();
    const publicKey = Buffer.from(read("public-key.txt").trim(), "base64url");
    const wrongKey = Buffer.from(publicKey);
    wrongKey[0] ^= 1;
    for (const key of [
      wrongKey.toString("base64url"),
      publicKey.subarray(1).toString("base64url"),
      Buffer.concat([publicKey, Buffer.from([0])]).toString("base64url"),
      `${publicKey.toString("base64url")}=`,
      "not+base64url",
    ]) {
      expect(verifyReviewPublicationAttributionSignature(original, key), key).toBe(false);
    }

    const signature = Buffer.from(original.signature.value, "base64url");
    const order = (1n << 252n) + 27742317777372353535851937790883648493n;
    let scalar = 0n;
    for (let index = 31; index >= 0; index -= 1) scalar = (scalar << 8n) + BigInt(signature[32 + index] ?? 0);
    scalar += order;
    const malleable = Buffer.from(signature);
    for (let index = 0; index < 32; index += 1) {
      malleable[32 + index] = Number(scalar & 0xffn);
      scalar >>= 8n;
    }
    const signatures = [
      signature.subarray(1).toString("base64url"),
      Buffer.concat([signature, Buffer.from([0])]).toString("base64url"),
      `${signature.toString("base64url")}=`,
      malleable.toString("base64url"),
    ];
    for (const value of signatures) {
      expect(verifyReviewPublicationAttributionSignature({
        ...original,
        signature: { alg: "Ed25519", value },
      }, publicKey.toString("base64url")), value).toBe(false);
    }
  });

  it("strictly parses and formats the pinned compact reference", () => {
    const pointer = read("pointer.txt").trim();
    const checked = validateReviewPublicationReference(pointer);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.value.reviewId).toBe("grv_01JTEST");
    expect(formatReviewPublicationReference(checked.value.reviewId, checked.value.publicationDigest))
      .toEqual({ ok: true, value: pointer, unknownFields: {} });
    for (const invalid of [
      `grv_@sha256:${"a".repeat(64)}`,
      `GRV_x@sha256:${"a".repeat(64)}`,
      `grv_x @sha256:${"a".repeat(64)}`,
      `grv_x@sha256:${"A".repeat(64)}`,
      `grv_x@sha256:${"a".repeat(63)}`,
      `grv_x@sha256:${"a".repeat(64)}\n`,
      `grv_x@sha256:${"a".repeat(64)}@sha256:${"b".repeat(64)}`,
      { pointer },
    ]) {
      expect(validateReviewPublicationReference(invalid).ok, JSON.stringify(invalid)).toBe(false);
    }
    expect(() => formatReviewPublicationReference(Object.create(null), "a".repeat(64))).not.toThrow();
    expect(formatReviewPublicationReference(Object.create(null), "a".repeat(64)).ok).toBe(false);
    expect(verifyReviewPublicationAttributionSignature({} as ReviewPublicationAttribution, "not-a-key")).toBe(false);
  });

  it("runs the Python implementation against the same golden and invalid vectors", () => {
    const result = spawnSync(
      "python3",
      ["-B", "packages/remote-protocol/python/test_review_publication_attribution.py"],
      { cwd: ROOT, encoding: "utf8" },
    );
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout + result.stderr).toContain("OK");
  });
});

describe("shared timestamp domain", () => {
  const cases = JSON.parse(read("timestamp-v1.json")) as ReadonlyArray<{
    readonly name: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
    readonly now: string;
    readonly valid: boolean;
    readonly code?: string;
    readonly digest?: string;
  }>;

  for (const entry of cases) {
    it(`${entry.name}: matches the pinned validity and canonical digest`, () => {
      const candidate = { ...fixture(), issuedAt: entry.issuedAt, expiresAt: entry.expiresAt };
      const result = validateReviewPublicationAttribution(candidate, entry.now);
      expect(result.ok, entry.name).toBe(entry.valid);
      if (entry.valid) {
        if (!result.ok) return;
        expect(reviewPublicationAttributionDigest(result.value)).toBe(entry.digest);
      } else {
        expect(issueCodes(result)).toContain(entry.code);
      }
      if (["invalid_timestamp", "invalid_time_order", "lifetime_exceeded"].includes(entry.code ?? "")) {
        expect(() => reviewPublicationAttributionSigningPayload(candidate as ReviewPublicationAttribution))
          .toThrow();
      }
    });
  }
});
