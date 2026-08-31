import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = join(dirname(fileURLToPath(import.meta.url)), "check-unconsumed-exports.mjs");

function write(root, relativePath, contents) {
  const destination = join(root, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, contents);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "vinci-unconsumed-"));
  write(
    root,
    "packages/alpha/src/index.ts",
    'export * from "./models.ts";\n',
  );
  write(
    root,
    "packages/alpha/src/models.ts",
    [
      "export type Model = { id: string };",
      "export type ModelRequest = { model: Model };",
      "export const Unused = 1;",
      "export const TestOnly = 2;",
      "export const SamePackage = 3;",
      "export const CrossPackage = 4;",
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/alpha/src/consumer.ts",
    [
      'import { ModelRequest, SamePackage } from "./index.ts";',
      "export const request: ModelRequest = { model: { id: String(SamePackage) } };",
      '// These are not references: "Unused" and Modelled.',
      "",
    ].join("\n"),
  );
  write(
    root,
    "packages/alpha/src/models.test.ts",
    'import { TestOnly } from "./models.ts";\nvoid TestOnly;\n',
  );
  write(
    root,
    "packages/beta/src/index.ts",
    'export * from "./beta.ts";\n',
  );
  write(
    root,
    "packages/beta/src/beta.ts",
    [
      'import { CrossPackage } from "../../alpha/src/index.ts";',
      "export const BetaUnused = CrossPackage;",
      "",
    ].join("\n"),
  );
  write(
    root,
    "scripts/expected-unconsumed.json",
    `${JSON.stringify([
      { package: "beta", export: "BetaUnused", reason: "Published for external consumers." },
    ], null, 2)}\n`,
  );
  return root;
}

function run(root, ...args) {
  return spawnSync(process.execPath, [script, "--root", root, ...args], {
    encoding: "utf8",
  });
}

test("reports exact-name nowhere and test-only exports by package", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Matching strategy: exact identifier matches/);
  assert.match(result.stdout, /Package: alpha/);
  assert.match(result.stdout, /NOWHERE REFERENCED \(2\)/);
  assert.match(result.stdout, /- Model \(src\/models\.ts\)/);
  assert.match(result.stdout, /- Unused \(src\/models\.ts\)/);
  assert.match(result.stdout, /TEST ONLY \(1\)/);
  assert.match(result.stdout, /- TestOnly \(src\/models\.ts\)/);
  assert.doesNotMatch(result.stdout, /- ModelRequest /);
  assert.doesNotMatch(result.stdout, /- SamePackage /);
  assert.doesNotMatch(result.stdout, /- CrossPackage /);
  assert.match(result.stdout, /Package: beta/);
  assert.match(result.stdout, /NOWHERE REFERENCED \(1\)/);
  assert.match(result.stdout, /- BetaUnused \(src\/beta\.ts\)/);
});

test("cross-repository consumer scanning", (t) => {
  const packageRoot = mkdtempSync(join(tmpdir(), "vinci-unconsumed-package-"));
  const consumerRoot = mkdtempSync(join(tmpdir(), "vinci-unconsumed-consumer-"));
  t.after(() => rmSync(packageRoot, { recursive: true, force: true }));
  t.after(() => rmSync(consumerRoot, { recursive: true, force: true }));

  write(packageRoot, "packages/shared/src/index.ts", 'export * from "./shared.ts";\n');
  write(packageRoot, "packages/shared/src/shared.ts", "export const SharedExport = 42;\n");
  write(
    consumerRoot,
    "src/consume.ts",
    'import { SharedExport } from "@example/shared";\nconsole.log(SharedExport);\n',
  );

  const withoutConsumers = run(packageRoot);
  assert.equal(withoutConsumers.status, 0);
  assert.match(withoutConsumers.stdout, /NOWHERE REFERENCED \(1\)/);
  assert.match(withoutConsumers.stdout, /- SharedExport \(src\/shared\.ts\)/);

  const withConsumers = run(packageRoot, "--consumers", consumerRoot);
  assert.equal(withConsumers.status, 0);
  assert.match(
    withConsumers.stdout,
    new RegExp(`\\[Consumer\\] ${consumerRoot.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}: exists=yes files_scanned=1`),
  );
  assert.doesNotMatch(withConsumers.stdout, /- SharedExport \(src\/shared\.ts\)/);
});

test("reports a nonexistent consumer directory without crashing", (t) => {
  const root = createFixture();
  const missingConsumer = join(root, "does-not-exist");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = run(root, "--consumers", missingConsumer);

  assert.equal(result.status, 0);
  assert.match(
    result.stdout,
    new RegExp(`\\[Consumer\\] ${missingConsumer.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}: exists=no files_scanned=0`),
  );
  assert.match(result.stdout, /\[Consumer\] WARNING: directory does not exist:/);
  assert.ok(result.stdout.indexOf("[Consumer]") < result.stdout.indexOf("Package: alpha"));
});

test("strict mode fails until every nowhere export is allowlisted", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const failing = run(root, "--strict");
  assert.equal(failing.status, 1);
  assert.match(failing.stdout, /Strict result: 2 unallowlisted nowhere-referenced exports/);

  write(
    root,
    "scripts/expected-unconsumed.json",
    `${JSON.stringify([
      { package: "alpha", export: "Model", reason: "Fixture public API." },
      { package: "alpha", export: "Unused", reason: "Fixture public API." },
      { package: "beta", export: "BetaUnused", reason: "Fixture public API." },
    ], null, 2)}\n`,
  );
  const passing = run(root, "--strict");
  assert.equal(passing.status, 0);
  assert.match(passing.stdout, /Strict result: no unallowlisted nowhere-referenced exports/);
});

test("rejects allowlist entries without a non-empty reason", (t) => {
  const root = createFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(
    root,
    "scripts/expected-unconsumed.json",
    '[{"package":"alpha","export":"Unused","reason":"   "}]\n',
  );

  const result = run(root, "--strict");

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Allowlist error: entry 1 must have a non-empty reason/);
});

test("the focused test file is directly runnable", () => {
  assert.equal(typeof execFileSync, "function");
});
