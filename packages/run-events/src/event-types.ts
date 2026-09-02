/**
 * The run event vocabulary (FR-2.3).
 *
 * A run is not a verification job (conflict register C2), so this does not
 * merge with `vinci-acceptance`'s twenty-three job events. Where both name the
 * same concept the names differ — `job.created` there, `run.created` here — and
 * keeping them separate is deliberate: a job's `RUNNING` means checks are
 * executing, a run's means the worker is working.
 *
 * One deviation from FR-2.3, recorded in register C5. The requirements name a
 * single `approval.resolved`; Acceptance splits `approval.granted` from
 * `approval.denied`. The split wins, because it carries in the event TYPE what a
 * single resolved event only carries in a payload field — and a consumer
 * filtering an append-only log by type should not have to read payloads to know
 * whether authority was granted.
 */
export const RUN_EVENT_TYPES = [
  "run.created",
  "run.started",
  "run.progress",
  "run.question",
  "run.question_answered",
  "approval.requested",
  "approval.granted",
  "approval.denied",
  "device.revoked",
  "relay.unavailable",
  "relay.restored",
  "host.unreachable",
  "host.reachable",
  "authority.acknowledged",
  "authority.rejected",
  "capability.used",
  "artifact.created",
  "evidence.recorded",
  "worker.heartbeat",
  "worker.warning",
  "run.paused",
  "run.resumed",
  "run.cancelled",
  "verification.started",
  "verdict.recorded",
  "run.completed",
  "run.failed",
  "run.blocked",
  // v4 additions: 24 event types describing the governed run in more detail.
  "run.stalled",
  "run.attempt_started",
  "agent.turn_started",
  "agent.turn_finished",
  "agent.compaction_started",
  "agent.compaction_finished",
  "agent.retry_started",
  "agent.retry_finished",
  "tool.requested",
  "tool.started",
  "tool.completed",
  "tool.failed",
  "tool.confirmation_required",
  "governor.lease_acquired",
  "governor.lease_renewed",
  "governor.lease_lost",
  "artifact.persisted",
  "artifact.verified",
  "approval.expired",
  "context.loaded",
  "context.invalidated",
  "capability.attested",
  "capability.refused",
  "steer.received",
] as const;

export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export function isRunEventType(value: unknown): value is RunEventType {
  return typeof value === "string" && (RUN_EVENT_TYPES as readonly string[]).includes(value);
}
