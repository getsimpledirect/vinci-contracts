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
import { assertExpectedInventory, internalDeps, readManifests } from "./lib/inventory.mjs";

const manifests = readManifests();

// The inventory must match what is committed. A floor ("at least five packages")
// was not enough: deleting a package made this report "9 packages all at 0.1.0"
// and exit 0, which reads exactly like success. A scan that reports on whatever
// it happens to find cannot tell you it found less than it should have.
assertExpectedInventory(manifests);

const errors = [];

const versions = new Set(manifests.map((entry) => entry.manifest.version));
if (versions.size > 1) {
  errors.push(
    `packages are at ${versions.size} different versions (${[...versions].sort().join(", ")}); `
      + "lockstep means one version across all of them",
  );
}
const expected = [...versions][0];

// Every dependency section, including optionalDependencies — omitting that one
// was a real hole: an internal dep declared there with "*" passed this check
// while it reported "14 internal dependencies pinned exactly". The count was
// true and the sentence was not.
let depCount = 0;
for (const { dir, manifest } of manifests) {
  for (const { section, dep, range } of internalDeps(manifest)) {
    depCount += 1;
    if (range !== expected) {
      errors.push(
        `${dir}: ${dep} is "${range}" in ${section}, expected the exact lockstep version `
          + `"${expected}". A range (including "*") lets a consumer resolve a combination `
          + "never tested together.",
      );
    }
  }
}

if (depCount === 0) {
  errors.push("no internal dependencies found at all — this scan is broken, not the tree");
}

if (errors.length > 0) {
  console.error("Lockstep version violations:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(
  `  ${manifests.length} packages all at ${expected}, ${depCount} internal dependencies pinned exactly`,
);
