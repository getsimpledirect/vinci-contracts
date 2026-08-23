/**
 * The deliverable contains no loose scripts at the repository root.
 *
 * Two console-log probes reached a commit because a background reviewer wrote
 * them into the repo root instead of /tmp, and `git add -A` swept them into the
 * deliverable. Nothing failed: they define no test, so the runner never
 * collects them, and they sat in the tree looking like coverage.
 *
 * One of them printed
 *
 *   "✓ PASS - worker cannot pass as independent_verifier" + (bad ? " FAILED!" : "")
 *
 * which renders a FAILURE as a line beginning "✓ PASS". Anything skimming the
 * output, or grepping for PASS, reads success. That is this repository's own
 * subject matter, as a two-line script, shipped inside it.
 *
 * KNOWN LIMITATION: this check is only meaningful on a QUIESCENT tree. A
 * background agent that copies a probe in, runs it, and deletes it will trip
 * this if the gate runs inside that window. That is a false failure, not a
 * flaky rule — the rule is about what the deliverable CONTAINS, and the answer
 * is only well-defined when nothing else is writing.
 */
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Config files that legitimately live at the root. */
const ALLOWED = new Set(["vitest.config.ts", "eslint.config.ts"]);

const stray = readdirSync(root).filter(
  (name) => (name.endsWith(".ts") || name.endsWith(".mts")) && !ALLOWED.has(name),
);

if (stray.length > 0) {
  for (const name of stray) {
    console.error(
      `  ${name}: a script at the repository root — move probes to /tmp, or make it a real test`,
    );
  }
  console.error("  (if an agent is mid-run, this may be its transient scratch; re-run on a quiet tree)");
  process.exit(1);
}
console.log("  no stray scripts at the repository root");
