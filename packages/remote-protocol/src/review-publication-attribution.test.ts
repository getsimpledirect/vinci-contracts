import { Buffer } from "node:buffer";
import { verify } from "node:crypto";
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
});

describe("canonical bytes, digest, signature and compact reference", () => {
  it("matches the committed canonical bytes, digest, signature and public key", () => {
    const value = validated();
    expect(Buffer.from(reviewPublicationAttributionSigningPayload(value)))
      .toEqual(readFileSync(join(VECTORS, "canonical.txt")));
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

  it("covers each semantic compartment in the digest and signature", () => {
    const original = validated();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["actor", { actor: { kind: "verifier", verifierId: "verifier-02JTEST", independent: true } }],
      ["binding", { binding: { ...original.binding, sessionId: "session-2" } }],
      ["subject", { subject: { ...original.subject, headTreeSha: "e".repeat(40) } }],
      ["verdict", { verdict: "BLOCK" }],
      ["recordSetDigest", { recordSetDigest: "e".repeat(64) }],
      ["idempotencyKey", { idempotencyKey: "review-publication-02JTEST" }],
      ["issuedAt", { issuedAt: "2026-09-04T12:00:00.001Z" }],
      ["expiresAt", { expiresAt: "2026-09-04T12:09:59.999Z" }],
      ["issuerKeyId", { issuerKeyId: "vgc-platform-key-2" }],
    ];
    for (const [label, overrides] of cases) {
      const changed = validated({ ...fixture(), ...overrides });
      expect(reviewPublicationAttributionDigest(changed), label)
        .not.toBe(reviewPublicationAttributionDigest(original));
      expect(verifyReviewPublicationAttributionSignature(changed, read("public-key.txt").trim()), label)
        .toBe(false);
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
