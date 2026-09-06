#!/usr/bin/env node
/**
 * Regenerate canonical.txt and digest.txt for every fixture in this directory.
 *
 * Run after `npm run build` (it imports the built package). The Node vector
 * test and the Python unittest both COMPARE against these files; only this
 * script writes them, so a change in canonicalization shows up as a failing
 * test rather than as silently rewritten vectors. Run it only when a fixture
 * changes, and commit the result as a deliberate act.
 *
 * Same layout and same discipline as packages/run/vectors/generate.mjs: one
 * directory per vector holding input.json, the exact canonical bytes, and the
 * digest. `bound-context-manifest.json` is not a digest vector — it is the
 * `@getsimpledirect/vinci-run` context manifest that `context-binding-1-complete`
 * is bound to, read by src/vectors.test.ts and by the hostile-key gate's
 * positive control, so it is deliberately skipped here.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "@getsimpledirect/vinci-contracts";
import {
  oracleContextBindingDigest,
  researchRequestDigest,
  sourceCitationDigest,
  sourceRecordDigest,
} from "@getsimpledirect/vinci-oracle-records";

/**
 * Directory prefix -> the digest function that owns that schema.
 *
 * Longest prefix wins, so a schema whose name is a prefix of another's cannot
 * claim the other's vectors. A directory matching nothing is an error rather
 * than a silent skip: a vector nobody digests is a vector nobody checks.
 */
const KINDS = [
  ["context-binding-", oracleContextBindingDigest],
  ["research-request-", researchRequestDigest],
  ["source-citation-", sourceCitationDigest],
  ["source-record-", sourceRecordDigest],
];

const here = dirname(fileURLToPath(import.meta.url));
for (const dir of readdirSync(here, { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const path = join(here, dir.name);
  const matches = KINDS.filter(([prefix]) => dir.name.startsWith(prefix))
    .sort((a, b) => b[0].length - a[0].length);
  const kind = matches[0];
  if (kind === undefined) {
    throw new Error(
      `${dir.name}: vector directories are named ${KINDS.map(([p]) => `${p}*`).join(", ")}`,
    );
  }
  const [, digestOf] = kind;
  const input = JSON.parse(readFileSync(join(path, "input.json"), "utf8"));
  const digest = digestOf(input);
  writeFileSync(join(path, "canonical.txt"), canonicalize(input));
  writeFileSync(join(path, "digest.txt"), `${digest}\n`);
  console.log(`${dir.name}: ${digest}`);
}
