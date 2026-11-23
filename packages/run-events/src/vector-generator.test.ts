import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const VECTORS = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");
const JSON_NAME = "vocabulary-v4.json";
const DIGEST_NAME = "vocabulary-v4.digest.txt";

describe("the vocabulary vector generator", () => {
  let directory: string | undefined;
  let vectors: string;
  let stdout: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "vinci-run-event-vectors-"));
    vectors = join(directory, "vectors");
    mkdirSync(vectors);
    const script = join(vectors, "generate.mjs");
    copyFileSync(join(VECTORS, "generate.mjs"), script);
    symlinkSync(
      join(VECTORS, "..", "..", "..", "node_modules"),
      join(directory, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );

    // Use a different working directory to exercise script-relative output paths.
    stdout = execFileSync(process.execPath, [script], {
      cwd: directory,
      encoding: "utf8",
      timeout: 5_000,
    });
  });

  afterAll(() => {
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  });

  function generatedDigest(): string {
    return createHash("sha256").update(readFileSync(join(vectors, JSON_NAME))).digest("hex");
  }

  it("writes the exact vocabulary JSON bytes beside the script", () => {
    expect(readFileSync(join(vectors, JSON_NAME))).toEqual(readFileSync(join(VECTORS, JSON_NAME)));
  });

  it("writes the SHA-256 of the emitted bytes with one final LF", () => {
    expect(readFileSync(join(vectors, DIGEST_NAME))).toEqual(Buffer.from(`${generatedDigest()}\n`));
  });

  it("prints the output filename and the same digest", () => {
    expect(stdout).toBe(`${JSON_NAME}: ${generatedDigest()}\n`);
  });
});
