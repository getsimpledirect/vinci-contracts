import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUN_EVENT_TYPES } from "./event-types.ts";
import { PAYLOAD_FIELDS } from "./payload.ts";
import {
  VOCABULARY_VECTOR_VERSION,
  emitVocabularyVector,
  vocabularyVector,
} from "./vocabulary-vector.ts";

/**
 * The committed vocabulary vector is the shared case file: this package emits
 * it, and a Python Run registry in another repository vendors a copy and
 * asserts its own vocabulary against it. Both sides only get a real check if
 * the committed bytes are the CURRENT bytes, so this test regenerates from the
 * live source and compares.
 *
 * fileURLToPath rather than import.meta.dirname: engines says node >=20 and
 * import.meta.dirname arrived in 20.11 — the same reason vectors.test.ts in
 * work-orders does it this way.
 */
const VECTORS = join(dirname(fileURLToPath(import.meta.url)), "..", "vectors");
const JSON_PATH = join(VECTORS, "vocabulary-v4.json");
const DIGEST_PATH = join(VECTORS, "vocabulary-v4.digest.txt");

const committed = readFileSync(JSON_PATH, "utf8");
const committedDigest = readFileSync(DIGEST_PATH, "utf8").trim();

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("the committed vocabulary vector is the current vocabulary", () => {
  it("is byte-identical to what the generator emits from the live source", () => {
    // Not `toEqual` on parsed objects: the consumer pins a DIGEST of these
    // exact bytes, so a reformatting that leaves the object equal still breaks
    // the consumer and must fail here.
    expect(committed).toBe(emitVocabularyVector());
  });

  it("its digest file pins those same bytes", () => {
    expect(committedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(committed)).toBe(committedDigest);
  });

  it("carries every event type, and the same fields payload.ts declares", () => {
    const parsed: { vectorVersion: number; schemaVersion: number; types: Record<string, Record<string, unknown>> } =
      JSON.parse(committed);
    expect(parsed.vectorVersion).toBe(VOCABULARY_VECTOR_VERSION);
    expect(parsed.schemaVersion).toBe(4);
    expect(Object.keys(parsed.types).sort()).toEqual([...RUN_EVENT_TYPES].sort());
    for (const type of RUN_EVENT_TYPES) {
      expect(Object.keys(parsed.types[type] ?? {}).sort(), type).toEqual(
        Object.keys(PAYLOAD_FIELDS[type]).sort(),
      );
    }
  });

  it("emits every enum field's closed member set, from the constants and not a copy", () => {
    // A vector that dropped `members` would still be byte-stable and would
    // still let a consumer's enum test pass vacuously against an empty set —
    // exactly the "asserted rather than enforced" shape this vector exists to
    // remove. So the presence of members is asserted, not assumed.
    const vector = vocabularyVector();
    let enumFields = 0;
    for (const type of RUN_EVENT_TYPES) {
      const spec: Record<string, { kind: string; members?: readonly string[] }> = PAYLOAD_FIELDS[type];
      for (const [field, declared] of Object.entries(spec)) {
        if (declared.kind !== "enum") continue;
        enumFields += 1;
        expect(vector.types[type]?.[field]?.members, `${type}.${field}`).toEqual([
          ...(declared.members ?? []),
        ]);
        expect(vector.types[type]?.[field]?.members?.length, `${type}.${field}`).toBeGreaterThan(0);
      }
    }
    // A floor, so a traversal that silently found nothing fails instead of
    // reporting a clean scan over zero fields.
    expect(enumFields).toBeGreaterThan(15);
  });
});

describe("mutation control: the comparison can actually fail", () => {
  /**
   * A byte-comparison test that has only ever seen matching bytes proves
   * nothing about what it does when they differ. These flip exactly one
   * character of the committed text IN MEMORY (nothing is written) and assert
   * both the byte comparison and the digest pin refuse it.
   */
  const flipAt = (text: string, index: number): string => {
    const original = text[index];
    if (original === undefined) throw new Error(`index ${index} is past the end`);
    const replacement = original === "a" ? "b" : "a";
    return text.slice(0, index) + replacement + text.slice(index + 1);
  };

  it("a one-character change to the committed JSON fails the byte comparison", () => {
    // A fixed offset rather than a search for one field name: this control has
    // to fail for the RIGHT reason even when the file it reads has itself been
    // tampered with, and indexOf on a name the tamperer removed reports a
    // missing substring instead of a broken comparison.
    const index = Math.floor(committed.length / 2);
    const mutated = flipAt(committed, index);
    expect(mutated).not.toBe(committed);
    expect(mutated).not.toBe(emitVocabularyVector());
    // and the positive control: the unmutated text still matches, so the
    // assertion above failed because of the mutation and not because the
    // comparison is broken.
    expect(committed).toBe(emitVocabularyVector());
  });

  it("a one-character change to the committed JSON fails the digest pin", () => {
    const index = Math.floor(committed.length / 3);
    const mutated = flipAt(committed, index);
    expect(sha256(mutated)).not.toBe(committedDigest);
    expect(sha256(committed)).toBe(committedDigest);
  });
});
