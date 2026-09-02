import {
  fail,
  isDigest,
  isCanonicalTimestamp,
  isIdentifier,
  ok,
  toPlainRecord,
  type RunId,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import type { RunEvent } from "@getsimpledirect/vinci-run-events";
import { digestValidated } from "./digest.ts";
import {
  isEnumMember,
  isNonNegativeInt,
  isObjectRecord,
  isPositiveInt,
  issue,
  rejectUnknownFields,
} from "./lib/validate.ts";

/**
 * The durable declaration of one run: what it is, who it runs as, where, under
 * what budget, and toward which terminal outcome.
 *
 * A run is the governed unit. It binds an agent version to an environment
 * digest, names the work order and attempt it is executing, and fixes the
 * budget and terminal contract up front — the same "fix it BEFORE the work
 * starts" discipline as a work order's acceptance criteria.
 */
export type VinciRun = {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly workOrderId: string;
  readonly workOrderDigest: string;
  readonly attemptId: string;
  readonly agent: VinciRunAgentRef;
  readonly environment: VinciRunEnvironmentRef;
  readonly sessionId: string | null;
  readonly contextManifestDigest: string | null;
  readonly harnessAttestationDigest: string | null;
  readonly servicePrincipalId: string | null;
  readonly budget: VinciRunBudget;
  readonly requiredTerminal: RequiredTerminal;
  readonly state: RunState;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly lastEventAt: string | null;
};

export type VinciRunAgentRef = {
  readonly id: string;
  readonly version: number;
};

export type VinciRunEnvironmentRef = {
  readonly id: string;
  readonly digest: string;
};

export type VinciRunBudget = {
  readonly maxListCostMicrousd?: number;
  readonly maxCashCostMicrousd?: number;
  readonly maxRuntimeS?: number;
  readonly maxToolCalls?: number;
  readonly maxHumanInterruptions?: number;
};

export const REQUIRED_TERMINALS = ["NONE", "MERGED", "DEPLOYED", "OBSERVED"] as const;
export type RequiredTerminal = (typeof REQUIRED_TERMINALS)[number];

export const RUN_STATES = ["CREATED", "RUNNING", "PAUSED", "BLOCKED", "STALLED", "TERMINAL"] as const;
export type RunState = (typeof RUN_STATES)[number];

/** Validate a run declaration from untrusted input. */
export function validateRun(input: unknown): ValidationResult<VinciRun> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  rejectUnknownFields(
    record,
    [
      "schemaVersion", "runId", "workOrderId", "workOrderDigest", "attemptId", "agent",
      "environment", "sessionId", "contextManifestDigest", "harnessAttestationDigest",
      "servicePrincipalId", "budget", "requiredTerminal", "state", "createdAt",
      "startedAt", "lastEventAt",
    ],
    "",
    "a run",
    issues,
  );

  if (record.schemaVersion !== 1) {
    issues.push(issue("/schemaVersion", "invalid_schema_version", "this schema is version 1"));
  }
  for (const field of ["runId", "workOrderId", "attemptId"] as const) {
    if (!isIdentifier(record[field])) {
      issues.push(issue(`/${field}`, "invalid_id", `${field} is an identifier`));
    }
  }
  if (!isDigest(record.workOrderDigest)) {
    issues.push(issue("/workOrderDigest", "invalid_digest", "workOrderDigest is 64 lowercase hex characters"));
  }

  if (!isObjectRecord(record.agent)) {
    issues.push(issue("/agent", "invalid_type", "agent is an object"));
  } else {
    const a = record.agent;
    rejectUnknownFields(a, ["id", "version"], "/agent", "agent", issues);
    if (!isIdentifier(a.id)) {
      issues.push(issue("/agent/id", "invalid_id", "an agent ref id is an identifier"));
    }
    if (!isPositiveInt(a.version)) {
      issues.push(issue("/agent/version", "invalid_version", "an agent ref version is a positive integer"));
    }
  }

  if (!isObjectRecord(record.environment)) {
    issues.push(issue("/environment", "invalid_type", "environment is an object"));
  } else {
    const e = record.environment;
    rejectUnknownFields(e, ["id", "digest"], "/environment", "environment", issues);
    if (!isIdentifier(e.id)) {
      issues.push(issue("/environment/id", "invalid_id", "an environment ref id is an identifier"));
    }
    if (!isDigest(e.digest)) {
      issues.push(issue("/environment/digest", "invalid_digest", "an environment ref digest is 64 lowercase hex characters"));
    }
  }

  for (const field of ["sessionId", "contextManifestDigest", "harnessAttestationDigest", "servicePrincipalId", "startedAt", "lastEventAt"] as const) {
    const value = record[field];
    if (value === null) continue;
    if (field === "startedAt" || field === "lastEventAt") {
      if (!isCanonicalTimestamp(value)) {
        issues.push(issue(`/${field}`, "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z"));
      }
    } else if (field === "contextManifestDigest" || field === "harnessAttestationDigest") {
      if (!isDigest(value)) {
        issues.push(issue(`/${field}`, "invalid_digest", `${field} is 64 lowercase hex characters or null`));
      }
    } else if (!isIdentifier(value)) {
      issues.push(issue(`/${field}`, "invalid_id", `${field} is an identifier or null`));
    }
  }

  if (!isObjectRecord(record.budget)) {
    issues.push(issue("/budget", "invalid_type", "budget is an object"));
  } else {
    const b = record.budget;
    rejectUnknownFields(
      b,
      ["maxListCostMicrousd", "maxCashCostMicrousd", "maxRuntimeS", "maxToolCalls", "maxHumanInterruptions"],
      "/budget",
      "budget",
      issues,
    );
    for (const field of ["maxListCostMicrousd", "maxCashCostMicrousd", "maxRuntimeS", "maxToolCalls", "maxHumanInterruptions"] as const) {
      if (!Object.hasOwn(b, field)) continue;
      if (!isNonNegativeInt(b[field])) {
        issues.push(issue(`/budget/${field}`, "invalid_budget_limit", `${field} is a non-negative integer`));
      }
    }
  }

  if (!isEnumMember(record.requiredTerminal, REQUIRED_TERMINALS)) {
    issues.push(issue("/requiredTerminal", "unknown_required_terminal", "requiredTerminal must be NONE, MERGED, DEPLOYED, or OBSERVED"));
  }
  if (!isEnumMember(record.state, RUN_STATES)) {
    issues.push(issue("/state", "unknown_run_state", "state must be CREATED, RUNNING, PAUSED, BLOCKED, STALLED, or TERMINAL"));
  }
  if (!isCanonicalTimestamp(record.createdAt)) {
    issues.push(issue("/createdAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z"));
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as VinciRun, {});
}

/**
 * The declared run state projected from its event log.
 *
 * The projection is a pure function of the events: no database, no host
 * memory. A consumer that replays the same log must reach the same state, or
 * one of the two is wrong. Terminal is absorbing — an event after the run has
 * reached TERMINAL is a real anomaly (the log should have stopped), and it is
 * reported rather than silently folded back into a running state.
 */
export function projectRunState(events: readonly RunEvent[]): { state: RunState; issues: readonly ValidationIssue[] } {
  let state: RunState = "CREATED";
  const issues: ValidationIssue[] = [];
  for (const event of events) {
    if (state === "TERMINAL") {
      issues.push(
        issue(
          `/events/${event.sequence}`,
          "event_after_terminal",
          `event ${event.type} arrived after the run reached TERMINAL`,
        ),
      );
      continue;
    }
    switch (event.type) {
      case "run.started":
        state = "RUNNING";
        break;
      case "run.paused":
      case "approval.requested":
        state = "PAUSED";
        break;
      case "run.blocked":
        state = "BLOCKED";
        break;
      case "run.resumed":
      case "approval.granted":
      case "approval.denied":
      case "run.attempt_started":
        state = "RUNNING";
        break;
      case "run.stalled":
        state = "STALLED";
        break;
      case "run.completed":
      case "run.failed":
      case "run.cancelled":
        state = "TERMINAL";
        break;
      default:
        break;
    }
  }
  return { state, issues };
}

/**
 * Artifacts that were announced (`artifact.created`) but never persisted
 * (`artifact.persisted`). An artifact the run claims to have produced but left
 * nowhere for a consumer to fetch is missing evidence of completion.
 */
export function terminalEvidenceMissing(events: readonly RunEvent[]): string[] {
  const created = new Set<string>();
  const persisted = new Set<string>();
  for (const event of events) {
    // Payload values are kinded (`{ kind: "id", value }`), not bare strings.
    if (event.type === "artifact.created") {
      created.add(event.payload.artifactId.value);
    } else if (event.type === "artifact.persisted") {
      persisted.add(event.payload.artifactId.value);
    }
  }
  return [...created].filter((id) => !persisted.has(id));
}

/** The identity of a run: SHA-256 over the canonical, validated declaration. */
export function runDigest(run: VinciRun): string {
  return digestValidated("run", validateRun(run));
}

export const RUN_SCHEMA_META: SchemaMeta = {
  id: "vinci.run",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
