import {
  fail,
  hasField,
  ok,
  toPlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { isSessionRole } from "./session.ts";
import type { SessionBinding } from "./session.ts";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const RETENTION_CLASSES = ["zdr_0d", "days_7", "days_14", "days_30"] as const;

const FIELDS = [
  "sessionId",
  "runId",
  "workspaceId",
  "organizationId",
  "hostDeviceId",
  "policyId",
  "policyVersion",
  "retentionClass",
] as const;

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

export function validateSessionBinding(input: unknown): ValidationResult<SessionBinding> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  const known = new Set<string>(FIELDS);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) issues.push(issue(`/${key}`, "unknown_field", "a session binding carries only its declared fields"));
  }

  for (const field of ["sessionId", "runId", "workspaceId", "hostDeviceId", "policyId"] as const) {
    const value = record[field];
    if (typeof value !== "string" || !ID_PATTERN.test(value)) {
      issues.push(issue(`/${field}`, "invalid_id", "an identifier is at most 128 safe characters"));
    }
  }

  // Present-and-null, never absent. An absent organization is
  // indistinguishable from one nobody set, and a stale organization context
  // authorizing current access is the failure FR-9.4 names.
  if (!hasField(record, "organizationId")) {
    issues.push(
      issue(
        "/organizationId",
        "required_field",
        "organizationId must be present and explicitly null for a personal workspace",
      ),
    );
  } else if (record.organizationId !== null) {
    const value = record.organizationId;
    if (typeof value !== "string" || !ID_PATTERN.test(value)) {
      issues.push(issue("/organizationId", "invalid_id", "an identifier is at most 128 safe characters"));
    }
  }

  if (!Number.isSafeInteger(record.policyVersion) || (record.policyVersion as number) < 1) {
    issues.push(issue("/policyVersion", "invalid_version", "a policy version is a positive safe integer"));
  }
  if (!(RETENTION_CLASSES as readonly unknown[]).includes(record.retentionClass)) {
    issues.push(issue("/retentionClass", "invalid_enum", "unrecognised retention class"));
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as SessionBinding, {});
}

export { isSessionRole };

export const SESSION_BINDING_SCHEMA_META: SchemaMeta = {
  id: "vinci.remote-session-binding",
  version: 1,
  /**
   * Frozen for the same reason as the run-event envelope: the validator rejects
   * unknown fields, and a schema that refuses additions has not left room for
   * them. Declaring additive-only beside a rejecting validator would claim a
   * compatibility this does not provide.
   */
  compatibility: "frozen",
  /**
   * A session binding is routing metadata that the relay reads. An unrecognised
   * field here is somewhere content could ride along on the one record the
   * relay is guaranteed to see in plaintext, so it is refused.
   */
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
