import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ReviewPublicationAttribution } from "./review-publication-attribution.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATOR = join(PACKAGE_ROOT, "vectors", "generate.mjs");
// SHA-256 of the committed vector files, including their exact formatting.
const ARTIFACT_SHA256 = {
  "valid-v1.json": "d37c785f444220af3b01c1e74436e4024416b71446a64e794c44a228745de985",
  "invalid-v1.json": "8eb8af990a4796ed48cb503b3efccd68759d5a2bba0e7362a1d52022e6fd1267",
  "timestamp-v1.json": "7699a0d5e532e2d513ae5149accdeedbf26df323a6af46eee92e65560da9c7de",
  "canonical.txt": "6a81b96fa73260e5bed85a23c49c3671dddf4e7e15b8117560d4a9e4af1d1ae7",
  "digest.txt": "fd6b810a28afa5ed989e8dc9777068c7424b5c69ba245608e9b710d6e30fbf92",
  "public-key.txt": "f762498cbcd4baca389ccf363dbb0ff912aac48d5c1016a45cbcd616a5686238",
  "signature.txt": "64ffe85585296a9397d15e3615c29029cc6f89921473a6ee3d42e3586877117e",
  "pointer.txt": "5dfbf3053eae218e2d9db776a550e86a5d5441f3ca4f776bb946c47113dbfe14",
};
const ARTIFACTS = Object.keys(ARTIFACT_SHA256);

function runGenerator(directory: string) {
  const vectors = join(directory, "vectors");
  mkdirSync(vectors, { recursive: true });
  const script = join(vectors, "generate.mjs");
  copyFileSync(GENERATOR, script);
  // Preserve the generator's relative import and use the built workspace package.
  symlinkSync(join(PACKAGE_ROOT, "dist"), join(directory, "dist"), "junction");
  const stdout = execFileSync(process.execPath, [script], {
    cwd: directory,
    encoding: "utf8",
    timeout: 10_000,
  });
  return { vectors, stdout };
}

describe("review publication attribution vector generator", () => {
  let scratch: string | undefined;
  let firstRun: ReturnType<typeof runGenerator>;
  let secondRun: ReturnType<typeof runGenerator>;
  let attribution: ReviewPublicationAttribution;
  let invalidCases: { name: string; code: string; input: string }[];

  function readArtifact(name: string): string {
    return readFileSync(join(firstRun.vectors, name), "utf8");
  }

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "review-publication-vectors-"));
    firstRun = runGenerator(join(scratch, "first"));
    secondRun = runGenerator(join(scratch, "second"));
    attribution = JSON.parse(readArtifact("valid-v1.json"));
    invalidCases = JSON.parse(readArtifact("invalid-v1.json"));
  });

  afterAll(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  });

  it("emits byte-identical attribution artifacts on two independent runs", () => {
    for (const artifact of ARTIFACTS) {
      expect(readFileSync(join(secondRun.vectors, artifact)), artifact).toEqual(
        readFileSync(join(firstRun.vectors, artifact)),
      );
    }
  });

  it.each(Object.entries(ARTIFACT_SHA256))(
    "emits the pinned bytes of %s, equal to the committed vector",
    (artifact, sha256) => {
      const emitted = readFileSync(join(firstRun.vectors, artifact));
      expect(createHash("sha256").update(emitted).digest("hex")).toBe(sha256);
      expect(emitted).toEqual(readFileSync(join(PACKAGE_ROOT, "vectors", artifact)));
    },
  );

  it("writes the SHA-256 of canonical.txt to digest.txt", () => {
    const canonical = readFileSync(join(firstRun.vectors, "canonical.txt"));
    const digest = createHash("sha256").update(canonical).digest("hex");
    expect(readArtifact("digest.txt")).toBe(`${digest}\n`);
  });

  it("writes the canonical signing payload without a trailing newline", () => {
    expect(readArtifact("canonical.txt")).not.toMatch(/[\r\n]$/);
  });

  it("writes the RFC 8032 fixture public key as base64url", () => {
    const rawKey = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex");
    expect(readArtifact("public-key.txt")).toBe(`${rawKey.toString("base64url")}\n`);
  });

  it("uses the fixed issue time in the valid attribution", () => {
    expect(attribution.issuedAt).toBe("2026-09-04T12:00:00.000Z");
  });

  it("writes a canonical Ed25519 signature for the generated signing payload", () => {
    expect(attribution.signature.alg).toBe("Ed25519");
    const signature = Buffer.from(attribution.signature.value, "base64url");
    expect(signature).toHaveLength(64);
    expect(attribution.signature.value).toBe(signature.toString("base64url"));
    expect(readArtifact("signature.txt")).toBe(`${attribution.signature.value}\n`);

    const publicKey = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: readArtifact("public-key.txt").trimEnd() },
      format: "jwk",
    });
    const canonical = readFileSync(join(firstRun.vectors, "canonical.txt"));
    expect(verify(null, canonical, publicKey, signature)).toBe(true);
  });

  it("writes the v1 publication reference with a final newline", () => {
    const publicationDigest = createHash("sha256").update("guard-review-publication-vector-v1").digest("hex");
    expect(readArtifact("pointer.txt")).toBe(`grv_01JTEST@sha256:${publicationDigest}\n`);
  });

  it("writes the wrong-provider case as a complete compact attribution", () => {
    const name = "wrong provider";
    const input = JSON.stringify({ ...attribution, subject: { ...attribution.subject, provider: "gitlab" } });
    expect(invalidCases.filter((entry) => entry.name === name)).toStrictEqual([
      { name, code: "invalid_provider", input },
    ]);
  });

  it.each([
    {
      name: "duplicate decoded key",
      code: "duplicate_field",
      token: '"schemaVersion":1,"schema\\u0056ersion":1,',
    },
    {
      name: "unsafe integer",
      code: "unsafe_integer",
      token: `"pullRequestNumber":${Number.MAX_SAFE_INTEGER + 1},`,
    },
  ])("preserves the raw JSON token for $name", ({ name, code, token }) => {
    expect(invalidCases.filter((entry) => entry.name === name)).toStrictEqual([
      { name, code, input: expect.stringContaining(token) },
    ]);
  });

  it("emits exactly the pinned invalid cases, in order", () => {
    expect(invalidCases.map(({ name, code }) => ({ name, code }))).toStrictEqual([
      { name: "wrong purpose", code: "invalid_purpose" },
      { name: "wrong audience", code: "invalid_audience" },
      { name: "wrong verdict", code: "invalid_verdict" },
      { name: "uppercase record digest", code: "invalid_digest" },
      { name: "invalid idempotency key", code: "invalid_id" },
      { name: "wrong provider", code: "invalid_provider" },
      { name: "abbreviated head", code: "invalid_git_sha" },
      { name: "reversed time", code: "invalid_time_order" },
      { name: "lifetime over bound", code: "lifetime_exceeded" },
      { name: "duplicate decoded key", code: "duplicate_field" },
      { name: "unsafe integer", code: "unsafe_integer" },
      { name: "fractional integer spelling", code: "ambiguous_number" },
      { name: "non-NFC identity", code: "non_canonical_unicode" },
    ]);
  });

  it("writes invalid-v1.json with two-space indentation and a final newline", () => {
    expect(readArtifact("invalid-v1.json")).toBe(`${JSON.stringify(invalidCases, null, 2)}\n`);
  });

  it("reports the v1 attribution digest on stdout", () => {
    expect(firstRun.stdout).toBe(`review-publication-attribution-v1: ${readArtifact("digest.txt")}`);
  });

  // The valid cases pin the digests from the committed timestamp vector.
  const expectedTimestamps = [
    {
      name: "year one lower boundary",
      issuedAt: "0001-01-01T00:00:00.000Z",
      expiresAt: "0001-01-01T00:10:00.000Z",
      now: "0001-01-01T00:09:59.999Z",
      valid: true,
      digest: "8ac180a015ab41dc80dad57e2e1ee9e61dbfb3c6082985358d8fd344a6bcbd2f",
    },
    {
      name: "real leap day and exact maximum lifetime",
      issuedAt: "2024-02-29T23:50:00.000Z",
      expiresAt: "2024-03-01T00:00:00.000Z",
      now: "2024-02-29T23:59:59.999Z",
      valid: true,
      digest: "ff5db837d38586ea0a9f8ba02b35efcfdac0ade1310914495b6d9f1b7cb267bc",
    },
    {
      name: "year zero",
      issuedAt: "0000-01-01T00:00:00.000Z",
      expiresAt: "0000-01-01T00:10:00.000Z",
      now: "0000-01-01T00:05:00.000Z",
      valid: false,
      code: "invalid_timestamp",
    },
    {
      name: "nonexistent leap day",
      issuedAt: "2026-02-29T00:00:00.000Z",
      expiresAt: "2026-02-29T00:10:00.000Z",
      now: "2026-02-29T00:05:00.000Z",
      valid: false,
      code: "invalid_timestamp",
    },
    {
      name: "expiry equals issue",
      issuedAt: "2026-09-04T12:00:00.000Z",
      expiresAt: "2026-09-04T12:00:00.000Z",
      now: "2026-09-04T11:59:59.999Z",
      valid: false,
      code: "invalid_time_order",
    },
    {
      name: "expiry before issue",
      issuedAt: "2026-09-04T12:00:00.001Z",
      expiresAt: "2026-09-04T12:00:00.000Z",
      now: "2026-09-04T11:59:59.999Z",
      valid: false,
      code: "invalid_time_order",
    },
    {
      name: "one millisecond over lifetime",
      issuedAt: "2026-09-04T12:00:00.000Z",
      expiresAt: "2026-09-04T12:10:00.001Z",
      now: "2026-09-04T12:05:00.000Z",
      valid: false,
      code: "lifetime_exceeded",
    },
    {
      name: "expiry is exclusive",
      issuedAt: "2026-09-04T12:00:00.000Z",
      expiresAt: "2026-09-04T12:10:00.000Z",
      now: "2026-09-04T12:10:00.000Z",
      valid: false,
      code: "expired",
    },
  ];

  it("writes exactly the expected number of timestamp cases with a final newline", () => {
    const text = readArtifact("timestamp-v1.json");
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toHaveLength(expectedTimestamps.length);
  });

  it("emits exactly the pinned timestamp cases, in order", () => {
    const timestamps: { name: string }[] = JSON.parse(readArtifact("timestamp-v1.json"));
    expect(timestamps.map(({ name }) => name)).toStrictEqual(
      expectedTimestamps.map(({ name }) => name),
    );
  });

  it.each(expectedTimestamps)("preserves the timestamp case: $name", (expected) => {
    const timestamps: { name: string }[] = JSON.parse(readArtifact("timestamp-v1.json"));
    expect(timestamps.filter(({ name }) => name === expected.name)).toStrictEqual([expected]);
  });
});
