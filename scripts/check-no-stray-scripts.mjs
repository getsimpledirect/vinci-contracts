/**
 * The repository root holds exactly the REGULAR FILES it is supposed to.
 *
 * Directories are deliberately out of scope — packages/, scripts/, dist/,
 * node_modules/ and .git/ all live here legitimately, and what belongs inside
 * them is governed by the dependency-graph and package checks rather than this
 * one. So this is not literally "exact root contents"; it is exact root files.
 * Saying the stronger thing would be the same overclaim that broke the previous
 * version, whose comment promised "no loose scripts" while its code enforced
 * "no loose TypeScript".
 *
 * FAIL-CLOSED. The list below is every file allowed at the root; anything else
 * fails the gate. A new root file therefore requires a deliberate decision,
 * which is the only mechanism that has held in this repository — every
 * hand-maintained exemption has needed a second fix, while the checks that
 * force a choice at the moment of the mistake have not.
 *
 * The first version of this check was fail-OPEN and wrong in two ways that
 * reinforced each other. It examined only `.ts` and `.mts`, so a probe named
 * `test-probe.mjs`, `.js`, `.py` or `.sh` passed straight through. And its
 * allowlist named `eslint.config.ts`, which does not exist — the real file is
 * `eslint.config.mjs`. That typo was INVISIBLE precisely because `.mjs` was
 * never examined: a dead entry in an allowlist that never ran.
 *
 * The invariant was always "no loose scripts at the root". What got written was
 * "no loose TypeScript". A check whose comment claims more than its code does
 * is the exact defect this repository exists to catch, and it appeared here, in
 * the check written to catch it.
 *
 * Why this list and not a pattern: patterns enumerate what is forbidden, and
 * the forbidden set is unbounded — every extension anyone might use for a
 * throwaway probe. The permitted set is small, known, and changes rarely.
 */
import { readdirSync, lstatSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every file permitted at the repository root. Regular files only. */
const ALLOWED_ROOT_FILES = [
  ".gitignore",
  "README.md",
  "eslint.config.mjs",
  "package-lock.json",
  "package.json",
  "vitest.config.ts",
];

const allowed = new Set(ALLOWED_ROOT_FILES);
let failed = false;

// lstat, NOT stat. `statSync` FOLLOWS symlinks, so a symlink sitting at an
// allowed name — package.json pointing anywhere at all — reported isFile()
// true and sailed through a check whose stated invariant is regular files only.
// The name was on the list and the target was a regular file, so both halves
// agreed while the thing at the root was neither.
//
// Note the asymmetry that made this easy to miss: a symlink at a DISALLOWED
// name was already caught, because following it produced a regular file that
// then failed the name check. Only the allowed-name case slipped, which is the
// case an attacker or a careless script would produce.
const present = [];
for (const name of readdirSync(root)) {
  let entry;
  try {
    entry = lstatSync(join(root, name));
  } catch {
    continue; // vanished mid-scan; not this check's business
  }
  if (entry.isDirectory()) continue;

  // `.git` is git's, and its TYPE depends on how the tree was created: a
  // directory in an ordinary clone, a FILE containing "gitdir: ..." inside a
  // worktree, and a symlink in some submodule layouts. Skipping it by name
  // rather than by type is the only form that behaves the same everywhere.
  //
  // This check passed for two commits and failed the moment it first ran in a
  // clean-checkout worktree — the exact environment the acceptance rule
  // requires — because `.git` was a file there and a directory here. A check
  // that depends on how the tree was made is not checking the tree.
  if (name === ".git") continue;

  if (!entry.isFile() || entry.isSymbolicLink()) {
    console.error(`  ${name}: not a regular file (symlink or special file) — the root holds real files only`);
    failed = true;
    continue;
  }
  if (!allowed.has(name)) {
    console.error(
      `  ${name}: not an allowed root file — move probes to /tmp, make it a real test, `
        + "or add it to ALLOWED_ROOT_FILES with a reason",
    );
    failed = true;
    continue;
  }
  present.push(name);
}

// A dead allowlist entry is how the previous version hid its own typo, so the
// list is checked against reality in BOTH directions.
for (const name of ALLOWED_ROOT_FILES) {
  if (!present.includes(name)) {
    console.error(`  ALLOWED_ROOT_FILES names ${name}, which is not at the root — stale entry`);
    failed = true;
  }
}

if (failed) {
  console.error("  (if an agent is mid-run, this may be its transient scratch; re-run on a quiet tree)");
  process.exit(1);
}
console.log(`  repository root holds exactly its ${ALLOWED_ROOT_FILES.length} allowed files`);
