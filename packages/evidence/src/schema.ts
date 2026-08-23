import {
  fail,
  ok,
  VERDICT_STATUSES,
  type ValidationIssue,
  type ValidationResult,
} from "@vinci/contracts";
import {
  EVIDENCE_KINDS,
  EVIDENCE_SOURCE_KINDS,
} from "./evidence-kinds.ts";
import type { EvidenceRecord } from "./evidence-record.ts";
import { EVIDENCE_PROVENANCE_CASES } from "./provenance.ts";
import {
  VERDICT_STALENESS_TRIGGERS,
  type VerdictAssessment,
} from "./verdict-assessment.ts";

type JsonObject = Record<string, unknown>;
type UnknownFields = Record<string, unknown>;

const EVIDENCE_MODES = [
  "deterministic",
  "execution",
  "visual",
  "model_judgment",
  "human_approval",
] as const;

const EVIDENCE_RELIABILITIES = [
  "authoritative",
  "strong",
  "supporting",
  "weak",
] as const;

function pointer(path: string, field: string): string {
  const escaped = field.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${escaped}`;
}

function addIssue(
  issues: ValidationIssue[],
  path: string,
  code: string,
  message: string,
): void {
  issues.push({ path: path || "/", code, message });
}

function objectValue(
  value: unknown,
  path: string,
  knownFields: readonly string[],
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
): JsonObject | undefined {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    addIssue(issues, path, "invalid_type", "expected an object");
    return undefined;
  }
  const result = value as JsonObject;
  const known = new Set(knownFields);
  for (const [field, fieldValue] of Object.entries(result)) {
    if (!known.has(field)) unknownFields[pointer(path, field)] = fieldValue;
  }
  return result;
}

function requiredString(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (typeof value !== "string" || value.length === 0) {
    addIssue(issues, path, "invalid_string", "expected a non-empty string");
    return false;
  }
  return true;
}

function requiredBoolean(value: unknown, path: string, issues: ValidationIssue[]): value is boolean {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (typeof value !== "boolean") {
    addIssue(issues, path, "invalid_type", "expected a boolean");
    return false;
  }
  return true;
}

function positiveInteger(value: unknown, path: string, issues: ValidationIssue[]): value is number {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (!Number.isInteger(value) || (value as number) < 1) {
    addIssue(issues, path, "invalid_integer", "expected a positive integer");
    return false;
  }
  return true;
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
  issues: ValidationIssue[],
): value is T[number] {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (typeof value !== "string" || !values.includes(value)) {
    addIssue(issues, path, "invalid_enum", `expected one of: ${values.join(", ")}`);
    return false;
  }
  return true;
}

function literalOne(value: unknown, path: string, issues: ValidationIssue[]): value is 1 {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (value !== 1) {
    addIssue(issues, path, "invalid_literal", "expected literal value 1");
    return false;
  }
  return true;
}

function timestamp(value: unknown, path: string, issues: ValidationIssue[]): value is string {
  if (value === undefined) {
    addIssue(issues, path, "required_field", `${path.slice(path.lastIndexOf("/") + 1)} is required`);
    return false;
  }
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    || Number.isNaN(Date.parse(value))
  ) {
    addIssue(issues, path, "invalid_timestamp", "expected an ISO-8601 UTC timestamp with millisecond precision");
    return false;
  }
  return true;
}

function enumArray<const T extends readonly string[]>(
  value: unknown,
  values: T,
  path: string,
  issues: ValidationIssue[],
): value is readonly T[number][] {
  if (!Array.isArray(value)) {
    addIssue(
      issues,
      path,
      value === undefined ? "required_field" : "invalid_type",
      value === undefined ? `${path.slice(path.lastIndexOf("/") + 1)} is required` : "expected an array",
    );
    return false;
  }
  let valid = true;
  value.forEach((entry, index) => {
    if (!enumValue(entry, values, pointer(path, String(index)), issues)) valid = false;
  });
  return valid;
}

function validateActor(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
): void {
  const object = objectValue(
    value,
    path,
    [
      "kind",
      "userId",
      "deviceId",
      "workerId",
      "policyId",
      "policyVersion",
      "component",
      "verifierId",
      "independent",
    ],
    issues,
    unknownFields,
  );
  if (!object) return;
  if (!enumValue(object.kind, ["user", "worker", "policy", "system", "verifier"] as const, `${path}/kind`, issues)) {
    return;
  }
  switch (object.kind) {
    case "user":
      requiredString(object.userId, `${path}/userId`, issues);
      if (object.deviceId !== undefined) requiredString(object.deviceId, `${path}/deviceId`, issues);
      break;
    case "worker":
      requiredString(object.workerId, `${path}/workerId`, issues);
      break;
    case "policy":
      requiredString(object.policyId, `${path}/policyId`, issues);
      positiveInteger(object.policyVersion, `${path}/policyVersion`, issues);
      break;
    case "system":
      requiredString(object.component, `${path}/component`, issues);
      break;
    case "verifier":
      requiredString(object.verifierId, `${path}/verifierId`, issues);
      requiredBoolean(object.independent, `${path}/independent`, issues);
      break;
  }
}

function validateAttestation(
  value: unknown,
  issues: ValidationIssue[],
  unknownFields: UnknownFields,
): void {
  const path = "/attestation";
  const object = objectValue(value, path, ["provenance", "actor"], issues, unknownFields);
  if (!object) return;
  enumValue(object.provenance, EVIDENCE_PROVENANCE_CASES, `${path}/provenance`, issues);
  validateActor(object.actor, `${path}/actor`, issues, unknownFields);
}

export function validateEvidenceRecord(input: unknown): ValidationResult<EvidenceRecord> {
  const issues: ValidationIssue[] = [];
  const unknownFields: UnknownFields = {};
  const object = objectValue(
    input,
    "",
    [
      "schemaVersion",
      "id",
      "attestation",
      "kind",
      "mode",
      "reliability",
      "sourceKind",
      "summary",
      "recordedAt",
    ],
    issues,
    unknownFields,
  );
  if (!object) return fail(issues);

  literalOne(object.schemaVersion, "/schemaVersion", issues);
  requiredString(object.id, "/id", issues);
  validateAttestation(object.attestation, issues, unknownFields);
  enumValue(object.kind, EVIDENCE_KINDS, "/kind", issues);
  enumValue(object.mode, EVIDENCE_MODES, "/mode", issues);
  enumValue(object.reliability, EVIDENCE_RELIABILITIES, "/reliability", issues);
  enumValue(object.sourceKind, EVIDENCE_SOURCE_KINDS, "/sourceKind", issues);
  requiredString(object.summary, "/summary", issues);
  timestamp(object.recordedAt, "/recordedAt", issues);

  if (issues.length > 0) return fail(issues);
  return ok(input as EvidenceRecord, unknownFields);
}

export function validateVerdictAssessment(input: unknown): ValidationResult<VerdictAssessment> {
  const issues: ValidationIssue[] = [];
  const unknownFields: UnknownFields = {};
  const object = objectValue(
    input,
    "",
    ["kind", "status", "reason", "triggers"],
    issues,
    unknownFields,
  );
  if (!object) return fail(issues);
  if (!enumValue(object.kind, ["current", "stale"] as const, "/kind", issues)) {
    return fail(issues);
  }

  if (object.kind === "current") {
    enumValue(object.status, VERDICT_STATUSES, "/status", issues);
  } else {
    requiredString(object.reason, "/reason", issues);
    enumArray(object.triggers, VERDICT_STALENESS_TRIGGERS, "/triggers", issues);
  }

  if (issues.length > 0) return fail(issues);
  return ok(input as VerdictAssessment, unknownFields);
}
