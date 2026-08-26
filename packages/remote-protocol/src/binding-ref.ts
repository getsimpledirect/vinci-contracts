import {
  fail,
  hasField,
  isIdentifier,
  ok,
  toPlainRecord,
  type OrganizationId,
  type RunId,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
  type WorkspaceId,
} from "@getsimpledirect/vinci-contracts";
import { validateSessionBinding } from "./schema.ts";
import {
  REMOTE_PROTOCOL_VERSION,
  type SessionBinding,
  type SessionId,
} from "./session.ts";

/**
 * The literal identity carried by every relay channel message.
 *
 * `organizationId` is required even for personal workspaces, where its value
 * is explicitly null. Connection context is not a substitute for these five
 * wire fields: a consumer can compare the message to its established binding
 * without inventing defaults or trusting whichever connection delivered it.
 */
export type SessionBindingRef = {
  readonly protocolVersion: number;
  readonly organizationId: OrganizationId | null;
  readonly workspaceId: WorkspaceId;
  readonly runId: RunId;
  readonly sessionId: SessionId;
};

const BINDING_REF_FIELDS = [
  "protocolVersion",
  "organizationId",
  "workspaceId",
  "runId",
  "sessionId",
] as const;

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

export function validateSessionBindingRef(input: unknown): ValidationResult<SessionBindingRef> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  const known = new Set<string>(BINDING_REF_FIELDS);
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      issues.push(issue(`/${key}`, "unknown_field", "a binding reference carries only routing identity"));
    }
  }

  if (record.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
    issues.push(issue(
      "/protocolVersion",
      "protocol_version_mismatch",
      `this build speaks remote protocol ${REMOTE_PROTOCOL_VERSION}`,
    ));
  }
  for (const field of ["workspaceId", "runId", "sessionId"] as const) {
    if (!isIdentifier(record[field])) {
      issues.push(issue(`/${field}`, "invalid_id", `${field} must be an identifier`));
    }
  }
  if (!hasField(record, "organizationId")) {
    issues.push(issue(
      "/organizationId",
      "required_field",
      "organizationId must be present and explicitly null for a personal workspace",
    ));
  } else if (record.organizationId !== null && !isIdentifier(record.organizationId)) {
    issues.push(issue("/organizationId", "invalid_id", "organizationId must be an identifier or null"));
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as SessionBindingRef);
}

/**
 * Exact, fail-closed comparison with a complete SessionBinding.
 *
 * Both arguments are validated before comparison. In particular, an absent
 * organization never compares equal to null, and malformed or hostile input
 * returns false rather than throwing.
 */
export function bindingRefMatches(ref: SessionBindingRef, binding: SessionBinding): boolean {
  const checkedRef = validateSessionBindingRef(ref);
  if (!checkedRef.ok) return false;
  const checkedBinding = validateSessionBinding(binding);
  if (!checkedBinding.ok) return false;

  return checkedRef.value.protocolVersion === checkedBinding.value.protocolVersion
    && checkedRef.value.organizationId === checkedBinding.value.organizationId
    && checkedRef.value.workspaceId === checkedBinding.value.workspaceId
    && checkedRef.value.runId === checkedBinding.value.runId
    && checkedRef.value.sessionId === checkedBinding.value.sessionId;
}

export const SESSION_BINDING_REF_SCHEMA_META = {
  id: "vinci.remote-session-binding-ref",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
} as const satisfies SchemaMeta;
