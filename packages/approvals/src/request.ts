import type {
  ConsequentialActionClass,
  Actor,
  AgentId,
  ApprovalId,
  ArtifactId,
  DeviceId,
  EvidenceId,
  OrganizationId,
  PolicyId,
  ReceiptId,
  RunId,
  SchemaMeta,
  Timestamp,
  UserId,
  ValidationResult,
  WorkerId,
  WorkspaceId,
} from "@vinci/contracts";
import { fail, isConsequentialActionClass, ok, toPlainRecord } from "@vinci/contracts";
import type { GrantShape } from "./grant.ts";
import { validateGrantShape } from "./grant.ts";
import {
  collectUnknownFields,
  isActor,
  isNonEmptyString,
  isObject,
  isPositiveInteger,
  isTimestamp,
  issue,
} from "./validation.ts";

/** Every branded identifier currently exported by contracts can identify an affected resource. */
export type AffectedResourceId =
  | OrganizationId
  | WorkspaceId
  | RunId
  | WorkerId
  | AgentId
  | DeviceId
  | UserId
  | ApprovalId
  | ArtifactId
  | EvidenceId
  | ReceiptId
  | PolicyId;

export const RISK_LEVELS = ["critical", "high", "medium", "low"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

export type ControllingPolicy = {
  readonly policyId: string;
  readonly policyVersion: number;
};

export type ApprovalRequest = {
  readonly approvalId: ApprovalId;
  readonly runId: RunId;
  readonly requestedAt: Timestamp;
  /**
   * What CLASS of consequential action this is. Required, because it is the
   * only description of the request that can safely reach a push notification
   * — every other description is free text a human typed.
   */
  readonly actionClass: ConsequentialActionClass;
  readonly requestedAction: string;
  readonly worker: Actor;
  readonly runObjective: string;
  readonly affectedResource: AffectedResourceId;
  readonly reason: string;
  /**
   * ADVISORY ONLY. Supplied by the worker, and it confers no authority.
   *
   * Whether approval is required, who may approve, which options may be
   * offered, and whether an action is forbidden are decided by policy — never
   * by a label the requesting worker chose for its own request. A worker that
   * could widen its own permissions by calling an action "low" would be
   * granting itself authority, which is the thing this package exists to
   * prevent.
   *
   * It is carried because it helps a human understand a request quickly, and
   * nothing in this package reads it to make a decision.
   */
  readonly riskLevel: RiskLevel;
  readonly evidenceId: EvidenceId;
  readonly estimatedCostOrImpact: string;
  readonly controllingPolicy: ControllingPolicy;
  readonly grant: GrantShape;
};

export const APPROVAL_REQUEST_SCHEMA_META = {
  id: "vinci.approval-request",
  version: 1,
  compatibility: "additive-only",
  unknownFields: "preserve",
  malformedData: "fail-closed",
  migration: "none",
} as const satisfies SchemaMeta;

const REQUEST_FIELDS = [
  "approvalId",
  "runId",
  "requestedAt",
  "requestedAction",
  "worker",
  "runObjective",
  "affectedResource",
  "reason",
  "riskLevel",
  "actionClass",
  "evidenceId",
  "estimatedCostOrImpact",
  "controllingPolicy",
  "grant",
] as const;

export function validateApprovalRequest(input: unknown): ValidationResult<ApprovalRequest> {
  // Snapshot before inspecting: rejects prototypes carrying inherited
  // fields, accessors that answer differently on each read, and symbol or
  // non-enumerable keys that an unknown-field check would not see.
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  input = plain.value;
  if (!isObject(input)) return fail([issue("/", "invalid_type", "approval request must be an object")]);
  const stringFields = [
    "approvalId",
    "runId",
    "requestedAction",
    "runObjective",
    "affectedResource",
    "reason",
    "evidenceId",
    "estimatedCostOrImpact",
  ] as const;
  for (const field of stringFields) {
    if (!isNonEmptyString(input[field])) {
      return fail([issue(`/${field}`, "required_field", `${field} must be a non-empty string`)]);
    }
  }
  if (!isTimestamp(input.requestedAt)) {
    return fail([issue("/requestedAt", "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z")]);
  }
  if (!isActor(input.worker)) {
    return fail([issue("/worker", "invalid_actor", "worker must be a valid Actor")]);
  }
  if (!isConsequentialActionClass(input.actionClass)) {
    return fail([
      issue(
        "/actionClass",
        "invalid_enum",
        "actionClass is not a recognized consequential-action class; it is the only field a push notification can safely describe",
      ),
    ]);
  }
  if (typeof input.riskLevel !== "string" || !(RISK_LEVELS as readonly string[]).includes(input.riskLevel)) {
    return fail([issue("/riskLevel", "invalid_enum", "riskLevel is not recognized")]);
  }
  if (!isObject(input.controllingPolicy)) {
    return fail([issue("/controllingPolicy", "invalid_type", "controllingPolicy must be an object")]);
  }
  if (!isNonEmptyString(input.controllingPolicy.policyId)) {
    return fail([issue("/controllingPolicy/policyId", "required_field", "policyId must be a non-empty string")]);
  }
  if (!isPositiveInteger(input.controllingPolicy.policyVersion)) {
    return fail([issue("/controllingPolicy/policyVersion", "invalid_version", "policyVersion must be a positive integer")]);
  }
  const grant = validateGrantShape(input.grant);
  if (!grant.ok) return fail(grant.issues.map((entry) => ({ ...entry, path: `/grant${entry.path}` })));

  const unknownFields: Record<string, unknown> = {};
  collectUnknownFields(input, REQUEST_FIELDS, "", unknownFields);
  collectUnknownFields(input.controllingPolicy, ["policyId", "policyVersion"], "/controllingPolicy", unknownFields);
  if (isObject(input.worker)) collectActorUnknownFields(input.worker, "/worker", unknownFields);
  for (const [path, value] of Object.entries(grant.unknownFields)) unknownFields[`/grant${path}`] = value;
  return ok(input as ApprovalRequest, unknownFields);
}

export function collectActorUnknownFields(
  actor: Readonly<Record<string, unknown>>,
  prefix: string,
  output: Record<string, unknown>,
): void {
  const known = actor.kind === "user"
    ? ["kind", "userId", "deviceId"]
    : actor.kind === "worker"
      ? ["kind", "workerId"]
      : actor.kind === "policy"
        ? ["kind", "policyId", "policyVersion"]
        : actor.kind === "system"
          ? ["kind", "component"]
          : ["kind", "verifierId", "independent"];
  collectUnknownFields(actor, known, prefix, output);
}
