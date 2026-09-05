import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { RUN_EVENT_TYPES } from "./event-types.ts";
import { PAYLOAD_FIELDS } from "./payload.ts";
import { RUN_EVENT_SCHEMA_META } from "./schema.ts";
import {
  VOCABULARY_VECTOR_VERSION,
  emitVocabularyVector,
  vocabularyVector,
  type VocabularyVectorField,
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
    //
    // MASKING TRIPLE (1 of 3) -- do not delete this as redundant.
    //
    // THE THREE. (1) is this assertion. (2) is the "carries every event type"
    // case below, which compares the PARSED committed JSON, field by field,
    // against a spec rebuilt in the test from the live PAYLOAD_FIELDS. (3) is
    // the identical `expect(committed).toBe(emitVocabularyVector())` at the
    // foot of the "mutation control" describe, which reads as a local positive
    // control and is in fact a full third copy of this guard. An earlier note
    // here called this a PAIR and never mentioned (3); a reader pruning
    // redundant positive controls would have deleted it without meeting either
    // note.
    //
    // HOW THEY MASK EACH OTHER. Silence this one alone and (2) still fails for
    // any staleness in the vocabulary's VALUES -- a changed kind, a changed
    // required flag, an edited or reordered enum member set -- and (3) still
    // fails for everything. Silence (2) alone and this one still fails.
    // Silence (1) and (3) and (2), and the suite passes over a genuinely stale
    // committed artifact.
    //
    // WHAT IS NOT SYMMETRIC, stated because the earlier note claimed a symmetry
    // it did not have. (1) and (3) compare BYTES, so they alone catch a
    // reformatting that leaves the parsed object equal -- a re-indent, a key
    // reorder, a changed `comment` string -- which is exactly what the
    // consumer's pinned digest breaks on. (2) alone catches a divergence from
    // PAYLOAD_FIELDS without going through `emitVocabularyVector` at all, so it
    // still answers if the generator is what is broken. Neither subsumes the
    // other.
    //
    // The earlier note said "silence this one alone and that one still fails"
    // while (2) compared only `Object.keys(...)`. Measured then: a stale enum
    // member ORDER, and a flipped `required` flag, both passed 1564/1564 with
    // byte-identity silenced. For that whole class byte-identity was the SOLE
    // guard and the note told the next reader it was covered from the other
    // side. (2) now compares the full spec, so the sentence is true.
    expect(committed).toBe(emitVocabularyVector());
  });

  it("its digest file pins those same bytes", () => {
    expect(committedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256(committed)).toBe(committedDigest);
  });

  it("carries every event type, and the same fields payload.ts declares", () => {
    // MASKING TRIPLE (2 of 3) -- do not delete this as redundant. It is
    // masked by the byte-identity case above AND by its third copy at the foot
    // of the "mutation control" describe; the full account is in the note on
    // (1). Those two catch a stale artifact only while `emitVocabularyVector`
    // is really consulted; this one catches a divergence from payload.ts
    // through the PARSED object, by a route that never calls the generator.
    // With all three silenced the suite passes over a stale artifact.
    //
    // The comparison is the FULL field spec, not `Object.keys(...)`. A key-set
    // comparison is blind to a changed `kind`, a changed `required` flag and
    // any edit to an enum's `members` -- and for that whole class it left
    // byte-identity as the only guard while the note above promised cover from
    // this side. The expected spec is rebuilt HERE from PAYLOAD_FIELDS rather
    // than taken from `vocabularyVector()`, so this route stays independent of
    // the one the byte comparison uses.
    const parsed: {
      vectorVersion: number;
      schemaVersion: number;
      types: Record<string, Record<string, VocabularyVectorField>>;
    } = JSON.parse(committed);
    expect(parsed.vectorVersion).toBe(VOCABULARY_VECTOR_VERSION);
    // The literal AND the live schema meta. The literal alone cannot tell a
    // derived value from a hardcoded one -- measured: replacing
    // `RUN_EVENT_SCHEMA_META.version` with a bare `4` in vocabulary-vector.ts
    // (import kept, so nothing goes unused) passed 1564/1564, because the test
    // asserted the same 4 the mutant hardcodes. This pins that the committed
    // vector, the literal and the live meta agree TODAY; the case at the foot
    // of this file is what pins the derivation itself.
    expect(parsed.schemaVersion).toBe(4);
    expect(parsed.schemaVersion).toBe(RUN_EVENT_SCHEMA_META.version);
    expect(Object.keys(parsed.types).sort()).toEqual([...RUN_EVENT_TYPES].sort());
    for (const type of RUN_EVENT_TYPES) {
      const declared: Record<string, { kind: string; required: boolean; members?: readonly string[] }> =
        PAYLOAD_FIELDS[type];
      const expected: Record<string, VocabularyVectorField> = {};
      for (const field of Object.keys(declared).sort()) {
        const spec = declared[field];
        if (spec === undefined) continue;
        expected[field] =
          spec.members === undefined
            ? { kind: spec.kind, required: spec.required }
            : { kind: spec.kind, required: spec.required, members: [...spec.members] };
      }
      expect(parsed.types[type], type).toEqual(expected);
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
    // MASKING TRIPLE (3 of 3) -- and the positive control: the unmutated text
    // still matches, so the assertion above failed because of the mutation and
    // not because the comparison is broken.
    //
    // READ THIS BEFORE DELETING IT. It is a local positive control AND a full
    // third copy of the staleness guard at the top of this file, byte for byte
    // the same assertion. Someone pruning redundant positive controls deletes
    // it here without ever meeting the notes on (1) and (2), and the notes on
    // (1) and (2) called each other a PAIR and did not mention this line at
    // all. It counts. See the note on (1) for how the three mask each other.
    expect(committed).toBe(emitVocabularyVector());
  });

  it("a one-character change to the committed JSON fails the digest pin", () => {
    const index = Math.floor(committed.length / 3);
    const mutated = flipAt(committed, index);
    expect(sha256(mutated)).not.toBe(committedDigest);
    expect(sha256(committed)).toBe(committedDigest);
  });
});

describe("the vector's schemaVersion is DERIVED from the live schema meta", () => {
  /**
   * Asserting `schemaVersion === RUN_EVENT_SCHEMA_META.version` beside the
   * literal `4` does NOT discriminate: both are 4 today, so a mutant that
   * hardcodes `schemaVersion: 4` in vocabulary-vector.ts satisfies every such
   * assertion. Measured: that mutant, with its `RUN_EVENT_SCHEMA_META` import
   * kept so nothing goes unused, survived the whole suite at 1564/1564.
   *
   * The only way to tell a derived value from a hardcoded one is to make the
   * two differ. This reloads the module with the schema meta reporting a
   * different version and asserts the emitted vector follows it. At a v5 bump
   * the hardcoded vector would announce 4 and the consuming registry would
   * vendor a v5 vocabulary labelled v4.
   */
  it("follows the schema meta when the meta reports a different version", async () => {
    vi.resetModules();
    vi.doMock("./schema.ts", async () => {
      const actual = await vi.importActual<typeof import("./schema.ts")>("./schema.ts");
      return {
        ...actual,
        RUN_EVENT_SCHEMA_META: { ...actual.RUN_EVENT_SCHEMA_META, version: 99 },
      };
    });
    try {
      const reloaded = await import("./vocabulary-vector.ts");
      expect(reloaded.vocabularyVector().schemaVersion).toBe(99);
      expect(JSON.parse(reloaded.emitVocabularyVector()).schemaVersion).toBe(99);
    } finally {
      vi.doUnmock("./schema.ts");
      vi.resetModules();
    }
  });

  it("positive control: unmocked, the module reports the real schema meta version", async () => {
    // Proves the case above failed (when it fails) because the value is not
    // derived, and not because the reload machinery is broken.
    vi.resetModules();
    const reloaded = await import("./vocabulary-vector.ts");
    expect(reloaded.vocabularyVector().schemaVersion).toBe(RUN_EVENT_SCHEMA_META.version);
    expect(vocabularyVector().schemaVersion).toBe(RUN_EVENT_SCHEMA_META.version);
    vi.resetModules();
  });
});
