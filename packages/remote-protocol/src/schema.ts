import {
  fail,
  hasField,
  ok,
  toPlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
// Imported, not redeclared. This package is layer 3 and policy is layer 1, so a
// downward import was always legal — the private copy that used to live here
// existed for no reason except that nobody noticed. It was byte-identical to
// policy's, which is the failure mode: a duplicate agrees until someone edits
// one side, and then a retention class accepted by the policy manifest is
// refused by the session validator, or the reverse.
import { RETENTION_CLASSES } from "@getsimpledirect/vinci-policy";
import { isSessionRole, REMOTE_PROTOCOL_VERSION } from "./session.ts";
import type { SessionBinding } from "./session.ts";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const FIELDS = [
  "protocolVersion",
  "schemaVersion",
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

  // Version skew is refused, not tolerated. A binding from a peer speaking a
  // protocol this build does not implement may parse cleanly and mean something
  // else; FR-4.8 says an action we cannot determine the permission of must not
  // proceed, and this is that rule at the network boundary.
  //
  // The message names both numbers because "invalid" sends an operator reading
  // logs to look at the record, and the record is fine — the mismatch is the
  // fact worth reporting.
  if (record.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
    issues.push(
      issue(
        "/protocolVersion",
        "protocol_version_mismatch",
        `this build speaks remote protocol ${REMOTE_PROTOCOL_VERSION}; the binding declares `
          + `${JSON.stringify(record.protocolVersion)}`,
      ),
    );
  }
  if (record.schemaVersion !== SESSION_BINDING_SCHEMA_META.version) {
    issues.push(
      issue(
        "/schemaVersion",
        "schema_version_mismatch",
        `this build reads session-binding schema ${SESSION_BINDING_SCHEMA_META.version}; the `
          + `binding declares ${JSON.stringify(record.schemaVersion)}`,
      ),
    );
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
