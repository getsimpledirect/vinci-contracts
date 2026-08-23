#!/usr/bin/env node
/**
 * The E0 integration gate.
 *
 * Layer 2 does not begin until this passes on the exact integrated head. It
 * exists as a script rather than a checklist because a checklist is satisfied
 * by remembering it, and the failures this repository has already hit — a
 * SchemaMeta claiming a guarantee no validator provided, a test asserting the
 * opposite of its own name — all passed every check anyone remembered to run.
 *
 * Every step must be capable of failing. A step that cannot fail is not a
 * check, and is reported as a gate failure in its own right.
 */
import { execSync } from "node:child_process";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const STEPS = [
  ["build", "npx tsc --build packages/*/tsconfig.json --force"],
  ["lint", "npx eslint packages --max-warnings=0"],
  ["tests", "npx vitest run"],
  ["dependency graph", "node scripts/check-dependency-graph.mjs"],
  ["SchemaMeta conformance", "node scripts/check-schema-meta.mjs"],
  ["hostile-key conformance", "node scripts/check-hostile-keys.mjs"],
  ["no stray scripts", "node scripts/check-no-stray-scripts.mjs"],
];

const results = [];
let failed = false;

for (const [name, command] of STEPS) {
  process.stdout.write(`\n─── ${name} ───\n`);
  try {
    execSync(command, { cwd: root, stdio: "inherit" });
    results.push([name, "pass"]);
  } catch {
    results.push([name, "FAIL"]);
    failed = true;
  }
}

// A gate that skips a package silently is worse than no gate. Every package
// on disk must have been covered by the build and by a test file.
process.stdout.write("\n─── coverage of the gate itself ───\n");
const packages = readdirSync(join(root, "packages")).filter((d) =>
  existsSync(join(root, "packages", d, "package.json")),
);
for (const pkg of packages) {
  const src = join(root, "packages", pkg, "src");
  const testFiles =
    existsSync(src) ? readdirSync(src).filter((f) => f.endsWith(".test.ts")) : [];
  if (testFiles.length === 0) {
    console.error(`  ${pkg}: no test file — the suite passing says nothing about it`);
    failed = true;
    continue;
  }

  // A file of skipped tests is not coverage.
  //
  // The previous check asked only whether a *.test.ts file EXISTED, so a
  // package whose every test was `it.skip` reported as covered while asserting
  // nothing — the same shape as the vacuous tests this gate exists to prevent,
  // one level up. A reviewer listed this as untested and it was.
  const live = testFiles.some((file) => {
    const source = readFileSync(join(root, "packages", pkg, "src", file), "utf8");
    // An it/test call that is NOT .skip/.todo, and not commented out at line start.
    return source
      .split("\n")
      .some((line) => /^\s*(it|test)\s*\(/.test(line) && !/^\s*(\/\/|\*)/.test(line));
  });
  if (!live) {
    console.error(
      `  ${pkg}: every test is skipped or absent — a file of it.skip asserts nothing`,
    );
    failed = true;
    continue;
  }
  console.log(`  ${pkg}: covered`);
}

console.log("\n─── gate ───");
for (const [name, status] of results) console.log(`  ${status.padEnd(4)}  ${name}`);
console.log(failed ? "\nGATE FAILED — layer 2 does not start.\n" : "\nGATE PASSED.\n");
process.exit(failed ? 1 : 0);
