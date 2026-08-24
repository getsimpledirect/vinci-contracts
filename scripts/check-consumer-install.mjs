#!/usr/bin/env node
/**
 * These packages are installable, and what they export survives being installed.
 *
 * Everything else in this gate runs inside the workspace, where TypeScript
 * resolves `@getsimpledirect/vinci-contracts` through tsconfig path aliases and
 * project references to the SOURCE. A consumer gets none of that. It gets a
 * tarball, `main`, `types`, `exports` and `files` — and a package can pass every
 * other check here while being unusable the moment it is installed: a `files`
 * list missing `dist`, a `types` path pointing at a file that was never emitted,
 * a declaration importing a path that only resolves inside the monorepo.
 *
 * So this check does what a consumer does. It packs every package with
 * `npm pack` (which runs `prepack`, so the tarball holds a real build), installs
 * the tarballs into an empty directory outside this repository, and then both
 * TYPE-CHECKS and RUNS a small program that imports across all four layers.
 *
 * Both halves are necessary and neither substitutes for the other:
 *   - `tsc --noEmit` alone proves declarations resolve, and would pass if every
 *     runtime file were missing.
 *   - Running alone proves the JavaScript loads, and would pass if the types
 *     were nonsense. `tsx` and `node --strip-types` both erase types WITHOUT
 *     checking them, which has already fooled someone in this repository into
 *     believing a fabricated API shape worked.
 *
 * Not part of `npm run gate`: it installs from the network and takes minutes.
 * CI runs it on pull requests via `npm run check:pack`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "vinci-consumer-"));
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const packages = readdirSync(join(root, "packages")).filter((dir) =>
  existsSync(join(root, "packages", dir, "package.json")),
);

// Non-vacuity: a pack run that found no packages must fail rather than report a
// clean install of nothing.
if (packages.length < 5) {
  console.error(`  only ${packages.length} packages found — this scan is broken, not the tree`);
  process.exit(1);
}

console.log(`  packing ${packages.length} packages into ${scratch}`);
const tarballs = {};
for (const dir of packages) {
  const packageDir = join(root, "packages", dir);
  const name = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).name;
  const out = run("npm", ["pack", "--pack-destination", scratch, "--silent"], packageDir).trim();
  const file = out.split("\n").pop().trim();
  if (!file.endsWith(".tgz")) {
    console.error(`  ${dir}: npm pack produced no tarball (got ${JSON.stringify(out)})`);
    process.exit(1);
  }
  tarballs[name] = join(scratch, file);
}

// The fixture is deliberately NOT a workspace and NOT inside this repository:
// a fixture under the repo root would inherit its tsconfig, its node_modules and
// its path aliases, and would then prove nothing about a real consumer.
const fixture = mkdtempSync(join(tmpdir(), "vinci-fixture-"));
writeFileSync(
  join(fixture, "package.json"),
  JSON.stringify(
    {
      name: "consumer-fixture",
      private: true,
      type: "module",
      dependencies: Object.fromEntries(
        Object.entries(tarballs).map(([name, path]) => [name, `file:${path}`]),
      ),
      devDependencies: { typescript: "5.9.3" },
    },
    null,
    2,
  ),
);
writeFileSync(
  join(fixture, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        // What a modern consumer actually sets. No paths, no references, no
        // rootDir into this repository.
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ["consumer.ts"],
    },
    null,
    2,
  ),
);

// EVERY package is imported, not a representative few.
//
// The first version of this file imported three packages and hand-wrote the
// list. A test mutation that removed "dist" from evidence's `files` — shipping
// a tarball with no build in it — passed clean, because nothing in the fixture
// ever loaded evidence. npm had installed it as a transitive dependency and
// left it there, unopened. A check that covers a subset it chose by hand
// reports on the subset and is read as reporting on the whole.
//
// The list is DERIVED from what was packed, so a package added tomorrow is
// covered tomorrow without anyone remembering to add it here.
const everyPackage = Object.keys(tarballs).sort();
const namespaceImports = everyPackage
  .map((name, index) => `import * as ns${index} from "${name}";`)
  .join("\n");
const namespaceChecks = everyPackage
  .map(
    (name, index) =>
      `if (Object.keys(ns${index}).length === 0) throw new Error("${name} installed but exports nothing");`,
  )
  .join("\n");

// Plus one program crossing every layer: 0 (contracts), 1 (policy),
// 3 (remote-protocol), using real values rather than only resolving names.
writeFileSync(
  join(fixture, "consumer.ts"),
  `${namespaceImports}
import { RISK_LEVELS, isCanonicalTimestamp, type RiskLevel } from "@getsimpledirect/vinci-contracts";
import { RETENTION_CLASSES } from "@getsimpledirect/vinci-policy";
import { validateSessionBinding, REMOTE_PROTOCOL_VERSION, SESSION_BINDING_SCHEMA_META } from "@getsimpledirect/vinci-remote-protocol";

const level: RiskLevel = RISK_LEVELS[0];
if (level !== "critical") throw new Error("RISK_LEVELS is not ordered most-severe-first");
if (!RETENTION_CLASSES.includes("zdr_0d")) throw new Error("RETENTION_CLASSES lost a member");
if (!isCanonicalTimestamp("2026-08-24T00:00:00.000Z")) throw new Error("timestamp check broke");

const good = validateSessionBinding({
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  schemaVersion: SESSION_BINDING_SCHEMA_META.version,
  sessionId: "sess-1", runId: "run-1", workspaceId: "ws-1", organizationId: null,
  hostDeviceId: "dev-1", policyId: "pol-1", policyVersion: 1, retentionClass: "zdr_0d",
});
if (!good.ok) throw new Error("a valid binding was refused: " + JSON.stringify(good));

// The guard must still refuse from outside the workspace. A validator that
// passes everything looks identical to one that works, from the accept side.
const skewed = validateSessionBinding({
  protocolVersion: REMOTE_PROTOCOL_VERSION + 1,
  schemaVersion: SESSION_BINDING_SCHEMA_META.version,
  sessionId: "sess-1", runId: "run-1", workspaceId: "ws-1", organizationId: null,
  hostDeviceId: "dev-1", policyId: "pol-1", policyVersion: 1, retentionClass: "zdr_0d",
});
if (skewed.ok) throw new Error("protocol skew was accepted by an installed build");

${namespaceChecks}

console.log(\`  consumer imported all ${everyPackage.length} packages across layers 0-3, types checked, guards still refuse\`);
`,
);

// Non-vacuity on the coverage itself: every packed package must appear in the
// program that is about to be compiled. If the generation above ever silently
// produces fewer imports than there are tarballs, this fails rather than
// reporting a clean install of a subset.
const consumerSource = readFileSync(join(fixture, "consumer.ts"), "utf8");
const uncovered = Object.keys(tarballs).filter((name) => !consumerSource.includes(`"${name}"`));
if (uncovered.length > 0) {
  console.error(`  packed but never imported by the fixture: ${uncovered.join(", ")}`);
  console.error("  a package nothing loads can ship broken and pass this check");
  process.exit(1);
}

try {
  console.log("  installing tarballs into a clean fixture");
  run("npm", ["install", "--no-audit", "--no-fund", "--silent"], fixture);

  console.log("  type-checking the consumer against the PUBLISHED declarations");
  run(join(fixture, "node_modules", ".bin", "tsc"), ["--project", "tsconfig.json"], fixture);

  console.log("  running the consumer against the PUBLISHED javascript");
  // Compiled first, then executed: stripping types would not check them.
  run(join(fixture, "node_modules", ".bin", "tsc"), ["consumer.ts", "--target", "ES2022",
    "--module", "NodeNext", "--moduleResolution", "NodeNext", "--outDir", "built"], fixture);
  process.stdout.write(run("node", [join(fixture, "built", "consumer.js")], fixture));
} catch (error) {
  console.error("  consumer install FAILED — these packages do not work when installed:\n");
  console.error(String(error.stdout ?? "") + String(error.stderr ?? "") || String(error));
  console.error(`\n  fixture left in place for inspection: ${fixture}`);
  process.exit(1);
}

rmSync(scratch, { recursive: true, force: true });
rmSync(fixture, { recursive: true, force: true });
console.log("  packed, installed, type-checked and executed outside the workspace");
