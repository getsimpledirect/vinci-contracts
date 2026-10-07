import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { assertExpectedInventory, readManifests } from "./lib/inventory.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("the actual bundle producer preserves qualified bytes and refuses unsafe destinations", { timeout: 240_000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "vinci-bundle-regression-"));
  const clone = join(directory, "source");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 15_000, encoding: "utf8" }).trim();
  execFileSync("git", ["clone", "--quiet", "--local", "--no-hardlinks", "--no-checkout", root, clone], { timeout: 30_000 });
  execFileSync("git", ["switch", "--detach", head], { cwd: clone, timeout: 15_000, stdio: "pipe" });
  // Copy the installed dependencies into the isolated checkout. Relative
  // workspace links then resolve its own exact source, without a stub compiler.
  execFileSync(process.execPath, ["-e", "require('node:fs').cpSync(process.argv[1],process.argv[2],{recursive:true,dereference:false,verbatimSymlinks:true})", join(root, "node_modules"), join(clone, "node_modules")], { timeout: 30_000 });
  const script = join(clone, "scripts/check-consumer-install.mjs");
  const run = (args, timeout = 10_000) => spawnSync(process.execPath, [script, ...args], { cwd: clone, env: process.env, timeout, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const bundle = join(directory, "bundle");
  const positive = run(["--bundle-directory", bundle], 180_000);
  assert.equal(positive.error, undefined, `The actual producer did not close within its bound. Inspect retained fixture "${directory}" before retrying.`);
  assert.equal(positive.status, 0, positive.stdout + positive.stderr);
  assert.match(positive.stdout, /packed, installed, type-checked and executed outside the workspace/);
  const manifest = JSON.parse(readFileSync(join(bundle, "bundle-manifest.json")));
  assert.equal(manifest.source.commit, head);
  assert.equal(manifest.registryPublication, false);
  assert.equal(manifest.qualification.packedConsumer, "passed");
  const inventory = assertExpectedInventory(readManifests());
  const names = inventory.map(name => JSON.parse(readFileSync(join(root, "packages", name, "package.json"))).name).sort();
  assert.deepEqual(manifest.packages.map(entry => entry.name), names);
  assert.equal(manifest.qualification.importedPackages, names.length);
  assert.ok(manifest.qualification.compiledReadmeExamples > 0);
  const originalManifest = readFileSync(join(bundle, "bundle-manifest.json"));
  for (const entry of manifest.packages) {
    const bytes = readFileSync(join(bundle, entry.file));
    assert.equal(bytes.length, entry.sizeBytes);
    assert.equal(hash(bytes), entry.sha256);
    assert.equal("sha512-" + createHash("sha512").update(bytes).digest("base64"), entry.integrity);
    assert.ok(entry.installedFiles.length > 0);
  }
  function refused(args, message, destination) {
    const result = run(args);
    assert.equal(result.error, undefined, "The actual admission guard must refuse before the bounded build.");
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(message), `Admission refused on the wrong assertion: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /building the workspace/);
    if (destination) assert.equal(existsSync(destination), false);
    assert.deepEqual(readFileSync(join(bundle, "bundle-manifest.json")), originalManifest);
    for (const entry of manifest.packages) assert.equal(hash(readFileSync(join(bundle, entry.file))), entry.sha256);
  }
  refused(["--unknown", bundle], "arguments must be --bundle-directory NEW_DIRECTORY");
  refused(["--bundle-directory", bundle], "bundle directory already exists");
  const inside = join(clone, "uncreated-bundle");
  refused(["--bundle-directory", inside], "bundle directory must be outside the source checkout", inside);
  const alias = join(directory, "source-alias");
  symlinkSync(clone, alias, process.platform === "win32" ? "junction" : "dir");
  refused(["--bundle-directory", join(alias, "uncreated-bundle")], "bundle directory must be outside the source checkout", inside);
  writeFileSync(join(clone, "uncommitted-test-input.txt"), "Owned negative-control source marker.\n");
  const dirty = join(directory, "dirty-bundle");
  refused(["--bundle-directory", dirty], "source checkout has uncommitted files", dirty);
  console.info(`INFO: The actual producer qualified ${names.length} installed packages, preserved every bundle payload hash, and refused five unsafe inputs before build; retained fixture "${directory}" records the measured bytes.`);
});
