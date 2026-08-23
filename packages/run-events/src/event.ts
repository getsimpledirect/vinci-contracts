import type { Actor, RunId, Timestamp } from "@vinci/contracts";
import type { RunEventType } from "./event-types.ts";
import type { PayloadFor } from "./payload.ts";

/**
 * One event in a run's append-only log.
 *
 * `sequence` is per-run and starts at 1. Acceptance's schema permits 0 while its
 * database requires positive, and a cursor of 0 doubles as a before-first-event
 * sentinel; that ambiguity is not reproduced here. Zero is not an event.
 */
export type RunEventFor<T extends RunEventType> = {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly runId: RunId;
  /** Position in this run's log. Positive, contiguous, and never reused. */
  readonly sequence: number;
  readonly type: T;
  readonly actor: Actor;
  readonly occurredAt: Timestamp;
  /**
   * Stable across retries of the same logical event, so replay is a no-op
   * (FR-2.3). Two events with one key are the same event observed twice, not
   * two things that happened.
   */
  readonly idempotencyKey: string;
  /** Correlates events across runs and services. Carries no content. */
  readonly traceId: string;
  readonly payload: PayloadFor<T>;
};

/**
 * One event in a run's append-only log.
 *
 * A union over every event type, each arm pairing its `type` with the payload
 * the allowlist declares for it. The previous shape carried a broad
 * `RunEventPayload` index signature, so the derived `PayloadFor` existed but was
 * not wired to anything: `payload` still accepted arbitrary fields at the type
 * level, and the structural guarantee held only at runtime. A structural claim
 * that lives in a comment is not a structural claim.
 */
export type RunEvent = { [T in RunEventType]: RunEventFor<T> }[RunEventType];
