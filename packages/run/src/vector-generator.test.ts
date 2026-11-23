import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const GENERATOR = join(here, "..", "vectors", "generate.mjs");
const NODE_MODULES = join(here, "..", "..", "..", "node_modules");

const AGENT = {
  version: 1,
  systemPolicyRef: "test-system",
  skills: [],
  schemaVersion: 1,
  requiredCapabilities: [],
  permissionPolicyRef: "test-permissions",
  modelClass: "synthetic",
  autonomy: [],
  allowedToolCategories: [],
  agentId: "vector-test",
};

const CANONICAL_AGENT =
  '{"agentId":"vector-test","allowedToolCategories":[],"autonomy":[],"modelClass":"synthetic",' +
  '"permissionPolicyRef":"test-permissions","requiredCapabilities":[],"schemaVersion":1,"skills":[],' +
  '"systemPolicyRef":"test-system","version":1}';
const AGENT_DIGEST = "193ea0f1a1ab538a18510c3d2751b2fa85b03dd25dd60825bd011e0e9c3705b3";

function runGenerator(name: string, input: object) {
  const sandbox = mkdtempSync(join(tmpdir(), "vinci-run-vectors-"));
  onTestFinished(() => rmSync(sandbox, { recursive: true, force: true }));

  // The generator scans beside its own file and resolves the built workspace packages.
  const vectors = join(sandbox, "vectors");
  const fixture = join(vectors, name);
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "input.json"), JSON.stringify(input, null, 2));
  const script = join(vectors, "generate.mjs");
  copyFileSync(GENERATOR, script);
  symlinkSync(NODE_MODULES, join(sandbox, "node_modules"), "junction");

  const result = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 5_000 });
  expect(result.error).toBeUndefined();
  return { fixture, result };
}

describe("run vector generator", () => {
  it("writes the exact canonical JSON and LF-terminated digest for an agent vector", () => {
    const { fixture, result } = runGenerator("agent-vector", AGENT);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(fixture, "canonical.txt"), "utf8")).toBe(CANONICAL_AGENT);
    expect(readFileSync(join(fixture, "digest.txt"), "utf8")).toBe(AGENT_DIGEST + "\n");
  });

  it("dispatches agent vectors through agent validation", () => {
    const { result } = runGenerator("agent-invalid", { ...AGENT, version: 0 });

    expect(result.status).toBeGreaterThan(0);
    expect(result.stderr).toContain("cannot digest an invalid agent: /version invalid_version");
  });

  it("exits nonzero with an uncaught error for an unknown vector prefix", () => {
    const { result } = runGenerator("unknown-vector", AGENT);

    expect(result.status).toBeGreaterThan(0);
    expect(result.stderr).toMatch(
      /^Error: unknown-vector: vector directories are named .+\r?\n[ \t]+at .*\/generate\.mjs:\d+:\d+$/m,
    );
  });
});
