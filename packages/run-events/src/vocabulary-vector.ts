/**
 * The run-event vocabulary, emitted as a shared cross-language vector.
 *
 * WHY THIS EXISTS. A second implementation of this vocabulary (the Python Run
 * registry in `vinci-gpu-control`) was hand-copied from this package and had
 * diverged on 17 of the types they share — different field names, different
 * enum members, no required-vs-optional concept at all — while a test on that
 * side asserted "parity" without ever reading anything from here. A mirrored
 * grammar diverges on the cases nobody wrote down; the fix is not a more
 * careful copy, it is ONE producer and a file both sides read.
 *
 * So this module derives the vector from `RUN_EVENT_TYPES` and
 * `PAYLOAD_FIELDS` — the live source of truth — and nothing else. There is no
 * second list here to drift: adding an event type or a field changes the
 * emitted bytes, which fails `vocabulary-vector.test.ts` until the committed
 * vector is regenerated, and fails the consumer's parity test until the
 * consumer vendors the new bytes.
 *
 * WHAT IT DOES NOT DO. It says nothing about whether the consumer IMPLEMENTS a
 * type. A consumer that implements a subset (no device revocation, no relay
 * transport) is legitimate and this file cannot tell that case apart from an
 * omission — that judgement belongs to the consumer's own parity test, which is
 * where the subset rule is stated. This file only fixes what a type MEANS.
 */
import { RUN_EVENT_TYPES, type RunEventType } from "./event-types.ts";
import { PAYLOAD_FIELDS } from "./payload.ts";
import { RUN_EVENT_SCHEMA_META } from "./schema.ts";

/**
 * The vector format's own version, separate from the event schema version.
 *
 * They answer different questions: `schemaVersion` is which run-event contract
 * these types belong to, `vectorVersion` is the shape of THIS file. A consumer
 * that reads the file needs both — bumping the event schema without changing
 * the file layout must not look like a layout change, and re-laying-out the
 * file must not look like a new event contract.
 */
export const VOCABULARY_VECTOR_VERSION = 1;

/** One field's declaration as it appears in the emitted vector. */
export type VocabularyVectorField = {
  readonly kind: string;
  readonly required: boolean;
  readonly members?: readonly string[];
};

export type VocabularyVector = {
  readonly comment: string;
  readonly vectorVersion: number;
  readonly schemaVersion: number;
  readonly types: Readonly<Record<string, Readonly<Record<string, VocabularyVectorField>>>>;
};

const COMMENT =
  "The run-event vocabulary emitted from packages/run-events/src/{event-types,payload}.ts. "
  + "ONLY packages/run-events/vectors/generate.mjs writes this file; every other reader compares "
  + "against it. Consumers in other languages vendor a copy and assert parity field by field.";

/**
 * Build the vector object.
 *
 * Field specs are REBUILT rather than passed through, so the emitted key order
 * is fixed here (kind, required, members) instead of inheriting whatever order
 * a declaration in payload.ts happens to use. Byte-identity is the whole
 * mechanism; leaving it to hand-written declaration order would make an
 * innocuous reordering of one literal look like a vocabulary change.
 */
export function vocabularyVector(): VocabularyVector {
  const types: Record<string, Record<string, VocabularyVectorField>> = {};
  for (const type of RUN_EVENT_TYPES) {
    const declared: Record<string, VocabularyVectorField> = {};
    // Sorted, for the same reason the field keys are rebuilt: the order fields
    // are written in payload.ts is prose, not contract.
    const spec: Record<string, { kind: string; required: boolean; members?: readonly string[] }> =
      PAYLOAD_FIELDS[type as RunEventType];
    for (const field of Object.keys(spec).sort()) {
      const entry = spec[field];
      if (entry === undefined) continue;
      declared[field] =
        entry.members === undefined
          ? { kind: entry.kind, required: entry.required }
          : { kind: entry.kind, required: entry.required, members: [...entry.members] };
    }
    types[type] = declared;
  }
  return {
    comment: COMMENT,
    vectorVersion: VOCABULARY_VECTOR_VERSION,
    schemaVersion: RUN_EVENT_SCHEMA_META.version,
    types,
  };
}

/**
 * The exact bytes of the committed vector file.
 *
 * Two-space indent and a trailing newline, so the committed file is readable in
 * a diff and ends the way every other text file in the repository does. The
 * test compares STRINGS against the file on disk, so this function — not
 * `JSON.stringify` at each call site — is what "the same bytes" means.
 */
export function emitVocabularyVector(): string {
  return `${JSON.stringify(vocabularyVector(), null, 2)}\n`;
}
