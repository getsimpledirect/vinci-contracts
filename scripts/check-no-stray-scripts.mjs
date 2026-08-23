/**
 * The repository root contains exactly the files it is supposed to, and nothing else.
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
import { readdirSync, statSync } from "node:fs";
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

// Regular files only: directories at the root are governed by the dependency
// graph and package checks, not by this one.
const present = readdirSync(root).filter((name) => {
  try {
    return statSync(join(root, name)).isFile();
  } catch {
    return false; // vanished mid-scan; not this check's business
  }
});

for (const name of present) {
  if (!allowed.has(name)) {
    console.error(
      `  ${name}: not an allowed root file — move probes to /tmp, make it a real test, `
        + "or add it to ALLOWED_ROOT_FILES with a reason",
    );
    failed = true;
  }
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
