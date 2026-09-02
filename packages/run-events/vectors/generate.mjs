#!/usr/bin/env node
/**
 * Regenerate the shared run-event vocabulary vector and its digest.
 *
 * Run after `npm run build` (it imports the built package). Same discipline as
 * packages/work-orders/vectors/generate.mjs and packages/run/vectors/generate.mjs:
 * ONLY this script writes these files, and every other reader — the Node test in
 * src/vocabulary-vector.test.ts, and the Python Run registry in vinci-gpu-control
 * that vendors a copy — COMPARES against them. A change to the vocabulary
 * therefore shows up as a failing test on both sides, not as a silently
 * rewritten vector.
 *
 * Two files, and the second is not redundant:
 *
 *   vocabulary-v4.json         the vocabulary
 *   vocabulary-v4.digest.txt   sha256 of those exact bytes
 *
 * The JSON alone is enough for THIS repository, where the test regenerates from
 * source and compares byte for byte. The digest is for the consumer, which has
 * only the vendored copy: it pins which emission was vendored, so a hand-edit of
 * the vendored JSON fails there even though that repository cannot re-run this
 * generator. Regenerate deliberately and commit the result.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { emitVocabularyVector } from "@getsimpledirect/vinci-run-events";

const here = dirname(fileURLToPath(import.meta.url));
const bytes = emitVocabularyVector();
const digest = createHash("sha256").update(bytes, "utf8").digest("hex");

writeFileSync(join(here, "vocabulary-v4.json"), bytes);
writeFileSync(join(here, "vocabulary-v4.digest.txt"), `${digest}\n`);
console.log(`vocabulary-v4.json: ${digest}`);
