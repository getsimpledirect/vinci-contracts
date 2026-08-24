import type { Actor, RunId, SchemaMeta, Timestamp, ValidationResult } from "@vinci/contracts";
import { fail, ok, toPlainRecord } from "@vinci/contracts";
import { collectActorUnknownFields } from "./request.ts";
import {
  collectUnknownFields,
  isActor,
  isNonEmptyString,
  isObject,
  isTimestamp,
  issue,
} from "./validation.ts";

export const RUN_ACTION_KINDS = ["request-explanation", "pause-run", "cancel-run"] as const;
export type RunActionKind = (typeof RUN_ACTION_KINDS)[number];

export type RunAction = {
  readonly kind: RunActionKind;
  readonly runId: RunId;
  readonly requestedBy: Actor;
  readonly requestedAt: Timestamp;
};

export const RUN_ACTION_SCHEMA_META = {
  id: "vinci.run-action",
  version: 1,
  compatibility: "additive-only",
  unknownFields: "preserve",
  malformedData: "fail-closed",
  migration: "none",
} as const satisfies SchemaMeta;

export function validateRunAction(input: unknown): ValidationResult<RunAction> {
  // Snapshot before inspecting: refuses prototypes carrying inherited fields,
  // accessors that can answer differently on each read, and symbol or
  // non-enumerable keys an unknown-field check would never see.
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  input = plain.value;
  if (!isObject(input)) return fail([issue("/", "invalid_type", "run action must be an object")]);
  if (typeof input.kind !== "string" || !(RUN_ACTION_KINDS as readonly string[]).includes(input.kind)) {
    return fail([issue("/kind", "invalid_discriminator", "run action kind is not recognized")]);
  }
  if (!isNonEmptyString(input.runId)) return fail([issue("/runId", "required_field", "runId must be a non-empty string")]);
  if (!isActor(input.requestedBy)) return fail([issue("/requestedBy", "invalid_actor", "requestedBy must be a valid Actor")]);
  if (!isTimestamp(input.requestedAt)) {
    return fail([issue("/requestedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z")]);
  }
  const unknownFields: Record<string, unknown> = {};
  collectUnknownFields(input, ["kind", "runId", "requestedBy", "requestedAt"], "", unknownFields);
  if (isObject(input.requestedBy)) collectActorUnknownFields(input.requestedBy, "/requestedBy", unknownFields);
  return ok(input as unknown as RunAction, unknownFields);
}
