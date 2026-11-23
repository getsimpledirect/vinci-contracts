import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const GENERATOR = join(PACKAGE_ROOT, "vectors", "generate.mjs");
const ARTIFACTS = [
  "valid-v1.json",
  "invalid-v1.json",
  "timestamp-v1.json",
  "canonical.txt",
  "digest.txt",
  "public-key.txt",
  "signature.txt",
  "pointer.txt",
];

function runGenerator(directory: string): string {
  const vectors = join(directory, "vectors");
  mkdirSync(vectors, { recursive: true });
  const script = join(vectors, "generate.mjs");
  copyFileSync(GENERATOR, script);
  // Preserve the generator's relative import and use the built workspace package.
  symlinkSync(join(PACKAGE_ROOT, "dist"), join(directory, "dist"), "junction");
  execFileSync(process.execPath, [script], { cwd: directory, timeout: 10_000 });
  return vectors;
}

describe("review publication attribution vector generator", () => {
  let scratch: string | undefined;
  let firstRun: string;
  let secondRun: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "review-publication-vectors-"));
    firstRun = runGenerator(join(scratch, "first"));
    secondRun = runGenerator(join(scratch, "second"));
  });

  afterAll(() => {
    if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
  });

  it("emits byte-identical attribution artifacts on two independent runs", () => {
    for (const artifact of ARTIFACTS) {
      expect(readFileSync(join(secondRun, artifact)), artifact).toEqual(
        readFileSync(join(firstRun, artifact)),
      );
    }
  });

  it("writes the SHA-256 of canonical.txt to digest.txt", () => {
    const canonical = readFileSync(join(firstRun, "canonical.txt"));
    const digest = createHash("sha256").update(canonical).digest("hex");
    expect(readFileSync(join(firstRun, "digest.txt"), "utf8")).toBe(`${digest}\n`);
  });

  // The valid cases pin the digests from the committed timestamp vector.
  it.each([
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
  ])("preserves the timestamp case: $name", (expected) => {
    const timestamps: { name: string }[] = JSON.parse(
      readFileSync(join(firstRun, "timestamp-v1.json"), "utf8"),
    );
    expect(timestamps.filter(({ name }) => name === expected.name)).toStrictEqual([expected]);
  });
});
