#!/usr/bin/env node
/**
 * Every package releases at one version, and internal dependencies pin to it exactly.
 *
 * These ten packages are one coherent protocol release, not ten independently
 * evolving libraries. Internal dependencies previously used "*", which lets a
 * consumer resolve a combination of independently-newest packages that this
 * repository never tested together — remote-protocol built against one contracts
 * version and running against another, with nothing anywhere to notice.
 *
 * Lockstep makes that combination impossible to express: if the versions must
 * match, there is exactly one, and it is the one the gate ran against.
 *
 * This check exists because pinning once is not the same as staying pinned. The
 * first person to bump a single package and leave the others behind would see no
 * failure anywhere else.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = join(root, "packages");
const INTERNAL = /^@getsimpledirect\/vinci-/;

const manifests = [];
for (const dir of readdirSync(packagesDir)) {
  const path = join(packagesDir, dir, "package.json");
  if (!existsSync(path)) continue;
  manifests.push({ dir, manifest: JSON.parse(readFileSync(path, "utf8")) });
}

const errors = [];

// Non-vacuity. A scan that finds no packages must fail rather than report
// agreement: a checker that finds nothing looks exactly like a codebase with
// nothing wrong, and that confusion has already fooled several people here.
if (manifests.length < 5) {
  errors.push(`only ${manifests.length} packages found — this scan is broken, not the tree`);
}

const versions = new Set(manifests.map((entry) => entry.manifest.version));
if (versions.size > 1) {
  errors.push(
    `packages are at ${versions.size} different versions (${[...versions].sort().join(", ")}); `
      + "lockstep means one version across all of them",
  );
}
const expected = [...versions][0];

let internalDeps = 0;
for (const { dir, manifest } of manifests) {
  for (const section of ["dependencies", "devDependencies", "peerDependencies"]) {
    for (const [dep, range] of Object.entries(manifest[section] ?? {})) {
      if (!INTERNAL.test(dep)) continue;
      internalDeps += 1;
      if (range !== expected) {
        errors.push(
          `${dir}: ${dep} is "${range}", expected the exact lockstep version "${expected}". `
            + 'A range (including "*") lets a consumer resolve a combination never tested together.',
        );
      }
    }
  }
}

if (internalDeps === 0) {
  errors.push("no internal dependencies found at all — this scan is broken, not the tree");
}

if (errors.length > 0) {
  console.error("Lockstep version violations:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `  ${manifests.length} packages all at ${expected}, ${internalDeps} internal dependencies pinned exactly`,
);
