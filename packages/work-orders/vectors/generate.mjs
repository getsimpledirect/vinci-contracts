#!/usr/bin/env node
/**
 * Regenerate canonical.txt and digest.txt for every fixture in this directory.
 *
 * Run after `npm run build` (it imports the built package). The Node vector
 * test and the Python unittest both COMPARE against these files; only this
 * script writes them, so a change in canonicalization shows up as a failing
 * test, not as silently rewritten vectors. Run it only when a fixture changes,
 * and commit the result as a deliberate act.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "@getsimpledirect/vinci-contracts";
import { executionSpecDigest, workOrderDigest } from "@getsimpledirect/vinci-work-orders";

const here = dirname(fileURLToPath(import.meta.url));
for (const dir of readdirSync(here, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const path = join(here, dir.name);
  const kind = dir.name.startsWith("work-order") ? "work-order" : dir.name.startsWith("execution-spec") ? "execution-spec" : null;
  if (kind === null) throw new Error(`${dir.name}: vector directories are named work-order-* or execution-spec-*`);
  const input = JSON.parse(readFileSync(join(path, "input.json"), "utf8"));
  const digest = kind === "work-order" ? workOrderDigest(input) : executionSpecDigest(input);
  writeFileSync(join(path, "canonical.txt"), canonicalize(input));
  writeFileSync(join(path, "digest.txt"), `${digest}\n`);
  console.log(`${dir.name}: ${digest}`);
}
