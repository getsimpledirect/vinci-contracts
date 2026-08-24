/**
 * One source of truth for "which packages exist" and "where a dependency can hide".
 *
 * Both questions were answered independently by three scripts, and all three got
 * the second one wrong in the same way: each listed `dependencies`,
 * `devDependencies` and `peerDependencies` by hand and silently ignored
 * `optionalDependencies`. A review found it. An internal dependency declared
 * there with a `"*"` range passed the lockstep check reporting "14 internal
 * dependencies pinned exactly" — the number was true and the sentence was not.
 *
 * The general defect is a hand-written list of the places to look. The fix is
 * not a longer hand-written list: it is to enumerate what npm actually puts in a
 * manifest and refuse anything unrecognised, so a section this file has never
 * heard of fails loudly instead of being skipped quietly.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(dirname(fileURLToPath(import.meta.url))), "..");

export const INTERNAL = /^@getsimpledirect\/vinci-/;

/**
 * Every manifest section that can declare a dependency on another package.
 *
 * `optionalDependencies` is here because omitting it was the actual bug.
 * `bundleDependencies` is a name list rather than a range map and is handled as
 * such by the caller that cares.
 */
export const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** Sections that affect what a CONSUMER resolves, and therefore publish order. */
export const RUNTIME_SECTIONS = ["dependencies", "peerDependencies", "optionalDependencies"];

function fail(lines) {
  for (const line of lines) console.error(line);
  process.exit(1);
}

/**
 * Read every package manifest, and refuse a manifest carrying a dependency
 * section this file does not know about.
 *
 * A new npm section, or a typo like `dependancies`, would otherwise be skipped
 * by every check here while looking exactly like a clean scan.
 */
export function readManifests() {
  const packagesDir = join(root, "packages");
  const manifests = [];
  for (const dir of readdirSync(packagesDir).sort()) {
    const path = join(packagesDir, dir, "package.json");
    if (!existsSync(path)) continue;
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const unknown = Object.keys(manifest).filter(
      // /depend/i, not /dependenc/i. The narrower pattern missed "dependancies"
      // — the exact typo this guard's own error message names — because the
      // misspelling replaces the "e" the pattern was anchored on. A guard that
      // cannot catch its own worked example is not a guard.
      (key) => /depend/i.test(key) && !DEPENDENCY_SECTIONS.includes(key) && key !== "bundleDependencies",
    );
    if (unknown.length > 0) {
      fail([
        `${dir}: unrecognised dependency section(s): ${unknown.join(", ")}`,
        "  Every check in scripts/ would skip it. Add it to DEPENDENCY_SECTIONS in",
        "  scripts/lib/inventory.mjs, or fix the typo.",
      ]);
    }
    manifests.push({ dir, name: manifest.name, manifest });
  }
  return manifests;
}

/** Internal dependency edges declared anywhere in `sections`. */
export function internalDeps(manifest, sections = DEPENDENCY_SECTIONS) {
  const edges = [];
  for (const section of sections) {
    for (const [dep, range] of Object.entries(manifest[section] ?? {})) {
      if (INTERNAL.test(dep)) edges.push({ section, dep, range });
    }
  }
  return edges;
}

/**
 * The package inventory must match what is committed, exactly.
 *
 * This IS a hand-maintained list, deliberately, and it is not the same thing as
 * the hand-written lists removed elsewhere in this repository. Those were
 * duplicates of derivable facts used to DRIVE behaviour, so an omission silently
 * shrank what ran. This one drives nothing; it is a tripwire whose only job is
 * to make a change in the inventory a deliberate act.
 *
 * Without it every scan here is self-describing: delete a package directory and
 * check-lockstep-versions reports "9 packages all at 0.1.0" and exits 0, which
 * reads exactly like success. A scan that reports on whatever it happens to find
 * cannot tell you that it found less than it should have.
 */
export function assertExpectedInventory(manifests) {
  const expectedPath = join(root, "scripts", "expected-packages.json");
  const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
  const onDisk = manifests.map((entry) => entry.dir);

  const missing = expected.packages.filter((dir) => !onDisk.includes(dir));
  const unexpected = onDisk.filter((dir) => !expected.packages.includes(dir));

  if (missing.length > 0 || unexpected.length > 0) {
    fail([
      "Package inventory does not match scripts/expected-packages.json:",
      ...missing.map((dir) => `  - expected packages/${dir}, which is not on disk`),
      ...unexpected.map((dir) => `  - packages/${dir} is on disk but not expected`),
      "",
      "  If this change is intended, edit scripts/expected-packages.json in the same",
      "  commit. That edit is the point: adding or removing a package changes what",
      "  every other check in this directory covers, and it should not be possible",
      "  to do it silently.",
    ]);
  }
  return expected.packages;
}
