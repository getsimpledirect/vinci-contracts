import { eventDigest } from "./digest.ts";
import type { RunEvent } from "./event.ts";

/**
 * FR-2.3 requires events be idempotent, ordered within a run, append-only after
 * acceptance, and safe to replay. Those are properties something must enforce;
 * this package can at least make each CHECKABLE, which is what this is.
 *
 * Deliberately pure. This package holds no log — it says what a valid append
 * looks like, and whatever holds the log decides using that.
 */
export type AppendRejection =
  | { readonly reason: "wrong_run"; readonly expected: string; readonly received: string }
  | { readonly reason: "sequence_not_contiguous"; readonly expected: number; readonly received: number }
  | { readonly reason: "sequence_reused"; readonly sequence: number }
  | { readonly reason: "time_went_backwards"; readonly previous: string; readonly received: string }
  /**
   * Same idempotency key, different event. Not a retry and not appendable:
   * something reused a key that is supposed to identify one logical event.
   * Treating this as a duplicate would silently discard a real event.
   */
  | { readonly reason: "idempotency_conflict"; readonly sequence: number };

export type AppendVerdict =
  | { readonly kind: "append" }
  /**
   * A retry of an event already in the log — same run, same key, same content.
   * Distinct from "reject" because the caller should treat it as success:
   * refusing a retry is how a worker concludes its event was lost and emits a
   * different one.
   */
  | { readonly kind: "duplicate"; readonly existingSequence: number }
  | { readonly kind: "reject"; readonly rejection: AppendRejection };

/**
 * An event already accepted into the log, for idempotency comparison.
 *
 * Carries the full event rather than a summary, so identity is compared against
 * what actually happened rather than against fields someone chose to keep.
 */
export type SeenEvent = { readonly event: RunEvent; readonly digest: string };

/**
 * Identity of an event for retry comparison.
 *
 * An earlier draft keyed idempotency on the key alone and stored only a
 * sequence, so the same key on a DIFFERENT run, or with a different type,
 * actor, payload or timestamp, was silently accepted as a retry — discarding a
 * real event and reporting success. A retry has to be the same event, not
 * merely the same label.
 */
export function eventIdentity(event: RunEvent): SeenEvent {
  return { event, digest: eventDigest(event) };
}

/**
 * May `candidate` be appended after `previous`?
 *
 * `previous` is null for the first event in a run, which must have sequence 1.
 * `seen` maps idempotency keys to the events already recorded under them, for
 * THIS run only — the caller scopes the map, and the run check below catches it
 * if they did not.
 *
 * The candidate's identity is computed HERE, not supplied. An earlier draft
 * took a caller-provided digest, which let a caller assert that two different
 * events were the same by passing one string twice.
 */
export function verifyAppend(
  previous: RunEvent | null,
  candidate: RunEvent,
  seen: ReadonlyMap<string, SeenEvent> = new Map(),
): AppendVerdict {
  // Run scoping first. An idempotency key means nothing across runs, and
  // checking the key before the run let a key collision on another run read as
  // a retry.
  if (previous !== null && previous.runId !== candidate.runId) {
    return {
      kind: "reject",
      rejection: { reason: "wrong_run", expected: previous.runId, received: candidate.runId },
    };
  }

  const existing = seen.get(candidate.idempotencyKey);
  if (existing !== undefined) {
    // Whole-event comparison, sequence included. Anything that differs at all
    // is a different event wearing the same key.
    const sameEvent = existing.digest === eventDigest(candidate);
    return sameEvent
      ? { kind: "duplicate", existingSequence: existing.event.sequence }
      : { kind: "reject", rejection: { reason: "idempotency_conflict", sequence: existing.event.sequence } };
  }

  if (previous === null) {
    return candidate.sequence === 1
      ? { kind: "append" }
      : {
          kind: "reject",
          rejection: { reason: "sequence_not_contiguous", expected: 1, received: candidate.sequence },
        };
  }

  if (candidate.sequence <= previous.sequence) {
    return { kind: "reject", rejection: { reason: "sequence_reused", sequence: candidate.sequence } };
  }
  if (candidate.sequence !== previous.sequence + 1) {
    return {
      kind: "reject",
      rejection: {
        reason: "sequence_not_contiguous",
        expected: previous.sequence + 1,
        received: candidate.sequence,
      },
    };
  }
  // Lexicographic comparison is sound because validateRunEvent requires the
  // canonical UTC form; on any other shape it would compare text, not instants.
  if (candidate.occurredAt < previous.occurredAt) {
    return {
      kind: "reject",
      rejection: {
        reason: "time_went_backwards",
        previous: previous.occurredAt,
        received: candidate.occurredAt,
      },
    };
  }
  return { kind: "append" };
}
