import {
  canonicalize,
  fail,
  isCanonicalTimestamp,
  isDigest,
  ok,
  ownData,
  toPlainRecord,
  type ApprovalId,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import {
  REMOTE_DECISION_REJECTIONS,
  REMOTE_DECISION_STATES,
  mayIssue,
  type RemoteCommandKind,
  type RemoteDecisionRejection,
  type RemoteDecisionState,
} from "./authority.ts";
import {
  validateSessionBindingRef,
  type SessionBindingRef,
} from "./binding-ref.ts";
import { isSessionRole, type SessionRole } from "./session.ts";
import {
  issue,
  prefixIssues,
  rejectUnknownFields,
  validateId,
  validateSignature,
} from "./wire-validation.ts";

export const MAX_AUTHORITY_COMMAND_LIFETIME_MS = 10 * 60 * 1_000;

type EmptyCommandParams = Readonly<Record<string, never>>;

export type AuthorityCommandParams =
  | EmptyCommandParams
  | { readonly approvalId: ApprovalId; readonly narrowedGrantRefId?: string }
  | { readonly approvalId: ApprovalId }
  | { readonly questionId: string; readonly answerId: string }
  | { readonly messageDigest: string; readonly byteCount: number };

/**
 * A device-signed authority request. Parameters are content-minimal and closed
 * by command: free text never rides this envelope.
 *
 * Passing validation proves only the wire shape, lifetime, binding shape, and
 * static role-to-command `mayIssue` filter. It does NOT verify the signature or
 * prove that the device holds `assertedRole`. The relay must compare
 * `assertedRole` with the current Platform grant using
 * `assertedRoleMatchesGrant` and refuse a mismatch. Relays and hosts must also
 * verify `authorityCommandSigningPayload` with the identified key, and the host
 * independently re-checks binding, role, revocation, policy, and live request
 * state before treating the command as authoritative.
 */
type AuthorityCommandContext = {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly binding: SessionBindingRef;
  readonly assertedRole: SessionRole;
  readonly sequence: number;
  readonly idempotencyKey: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly signerKeyId: string;
  readonly signature: { readonly alg: "Ed25519"; readonly value: string };
};

export type AuthorityCommandEnvelope = AuthorityCommandContext & (
  | {
      readonly command: "pause" | "restrict_to_read_only" | "abort";
      readonly params: EmptyCommandParams;
    }
  | {
      readonly command: "deny_pending_approval";
      readonly params: { readonly approvalId: ApprovalId };
    }
  | {
      readonly command: "approve_pending_approval";
      readonly params: { readonly approvalId: ApprovalId; readonly narrowedGrantRefId?: string };
    }
  | {
      readonly command: "answer_question";
      readonly params: { readonly questionId: string; readonly answerId: string };
    }
  | {
      readonly command: "send_message";
      readonly params: { readonly messageDigest: string; readonly byteCount: number };
    }
);

const COMMAND_FIELDS = [
  "schemaVersion",
  "commandId",
  "binding",
  "command",
  "params",
  "assertedRole",
  "sequence",
  "idempotencyKey",
  "issuedAt",
  "expiresAt",
  "signerKeyId",
  "signature",
] as const;

const PARAM_FIELDS: Readonly<Record<RemoteCommandKind, readonly string[]>> = {
  pause: [],
  restrict_to_read_only: [],
  abort: [],
  deny_pending_approval: ["approvalId"],
  approve_pending_approval: ["approvalId", "narrowedGrantRefId"],
  answer_question: ["questionId", "answerId"],
  send_message: ["messageDigest", "byteCount"],
};

function isRemoteCommandKind(value: unknown): value is RemoteCommandKind {
  return typeof value === "string" && Object.hasOwn(PARAM_FIELDS, value);
}

function validateParams(
  command: RemoteCommandKind,
  value: unknown,
  issues: ValidationIssue[],
): void {
  const plain = toPlainRecord(value);
  if (!plain.ok) {
    prefixIssues("/params", plain.issues, issues);
    return;
  }
  const params = plain.value;
  const allowed = PARAM_FIELDS[command];
  rejectUnknownFields(params, allowed, "/params", issues);

  switch (command) {
    case "approve_pending_approval":
      validateId(params.approvalId, "/params/approvalId", issues);
      if (params.narrowedGrantRefId !== undefined) {
        validateId(params.narrowedGrantRefId, "/params/narrowedGrantRefId", issues);
      }
      break;
    case "deny_pending_approval":
      validateId(params.approvalId, "/params/approvalId", issues);
      break;
    case "answer_question":
      validateId(params.questionId, "/params/questionId", issues);
      validateId(params.answerId, "/params/answerId", issues);
      break;
    case "send_message":
      if (!isDigest(params.messageDigest)) {
        issues.push(issue("/params/messageDigest", "invalid_digest", "messageDigest must be lowercase SHA-256"));
      }
      if (!Number.isSafeInteger(params.byteCount)
          || (params.byteCount as number) < 0
          || Object.is(params.byteCount, -0)) {
        issues.push(issue("/params/byteCount", "invalid_count", "byteCount must be a non-negative safe integer"));
      }
      break;
    case "pause":
    case "restrict_to_read_only":
    case "abort":
      break;
  }
}

export function validateAuthorityCommandEnvelope(
  input: unknown,
  now: string,
): ValidationResult<AuthorityCommandEnvelope> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  // JSON normalization represents -0 as 0. Read the original own DATA field
  // through the total helper solely to retain the distinction the wire rule
  // explicitly requires; getters, inherited values, and throwing proxies
  // yield undefined rather than authority.
  const sequenceWasNegativeZero = Object.is(ownData(input, "sequence"), -0);
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  if (!isCanonicalTimestamp(now)) {
    issues.push(issue("/", "invalid_validation_time", "the expiry comparison requires a canonical UTC timestamp"));
  }

  rejectUnknownFields(record, COMMAND_FIELDS, "", issues);
  if (record.schemaVersion !== AUTHORITY_COMMAND_ENVELOPE_SCHEMA_META.version) {
    issues.push(issue("/schemaVersion", "schema_version_mismatch", "unsupported authority-command schema version"));
  }
  for (const field of ["commandId", "idempotencyKey", "signerKeyId"] as const) {
    validateId(record[field], `/${field}`, issues);
  }

  const binding = validateSessionBindingRef(record.binding);
  if (!binding.ok) prefixIssues("/binding", binding.issues, issues);

  if (!isRemoteCommandKind(record.command)) {
    issues.push(issue("/command", "invalid_command", "unrecognised remote command"));
  } else {
    validateParams(record.command, record.params, issues);
  }

  if (!isSessionRole(record.assertedRole)) {
    issues.push(issue("/assertedRole", "invalid_role", "unrecognised session role"));
  } else if (isRemoteCommandKind(record.command) && !mayIssue(record.assertedRole, record.command)) {
    issues.push(issue("/assertedRole", "not_permitted", "the asserted role may not issue this command"));
  }

  if (!Number.isSafeInteger(record.sequence)
      || (record.sequence as number) < 0
      || sequenceWasNegativeZero) {
    issues.push(issue("/sequence", "invalid_sequence", "sequence must be a non-negative safe integer other than -0"));
  }

  if (!isCanonicalTimestamp(record.issuedAt)) {
    issues.push(issue("/issuedAt", "invalid_timestamp", "issuedAt must be a canonical UTC timestamp"));
  }
  if (!isCanonicalTimestamp(record.expiresAt)) {
    issues.push(issue("/expiresAt", "invalid_timestamp", "expiresAt must be a canonical UTC timestamp"));
  }
  if (isCanonicalTimestamp(record.issuedAt) && isCanonicalTimestamp(record.expiresAt)) {
    const issuedMs = Date.parse(record.issuedAt);
    const expiresMs = Date.parse(record.expiresAt);
    if (expiresMs <= issuedMs) {
      issues.push(issue("/expiresAt", "invalid_time_order", "expiresAt must be strictly later than issuedAt"));
    } else if (expiresMs - issuedMs > MAX_AUTHORITY_COMMAND_LIFETIME_MS) {
      issues.push(issue("/expiresAt", "lifetime_exceeded", "an authority command may live for at most 10 minutes"));
    }
    // "Already expired" is relative to the explicit caller-supplied clock.
    // Reading Date.now() here would make identical validation calls disagree.
    if (isCanonicalTimestamp(now) && expiresMs <= Date.parse(now)) {
      issues.push(issue("/expiresAt", "expired", "the authority command has expired"));
    }
  }

  validateSignature(record.signature, "/signature", issues);
  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as AuthorityCommandEnvelope);
}

/**
 * Canonical UTF-8 bytes covered by the Ed25519 signature.
 *
 * The signature field itself is excluded. Call this only after validation;
 * this function encodes bytes and performs no cryptographic verification.
 */
export function authorityCommandSigningPayload(
  envelope: AuthorityCommandEnvelope,
): Uint8Array {
  const { signature: _signature, ...unsigned } = envelope;
  return new TextEncoder().encode(canonicalize(unsigned));
}

export type AuthorityResultEnvelope = {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly binding: SessionBindingRef;
  /** Reuses the existing RemoteDecisionState discriminant; no second enum. */
  readonly result: RemoteDecisionState["kind"];
  readonly rejection?: RemoteDecisionRejection;
  readonly decidedAt: string;
  readonly hostKeyId: string;
  readonly signature: { readonly alg: "Ed25519"; readonly value: string };
};

const RESULT_FIELDS = [
  "schemaVersion",
  "commandId",
  "binding",
  "result",
  "rejection",
  "decidedAt",
  "hostKeyId",
  "signature",
] as const;

/** Shape validation only; passing does not mean the host signature was checked. */
export function validateAuthorityResultEnvelope(
  input: unknown,
): ValidationResult<AuthorityResultEnvelope> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  rejectUnknownFields(record, RESULT_FIELDS, "", issues);
  if (record.schemaVersion !== AUTHORITY_RESULT_ENVELOPE_SCHEMA_META.version) {
    issues.push(issue("/schemaVersion", "schema_version_mismatch", "unsupported authority-result schema version"));
  }
  validateId(record.commandId, "/commandId", issues);
  validateId(record.hostKeyId, "/hostKeyId", issues);
  const binding = validateSessionBindingRef(record.binding);
  if (!binding.ok) prefixIssues("/binding", binding.issues, issues);

  if (!(REMOTE_DECISION_STATES as readonly unknown[]).includes(record.result)) {
    issues.push(issue("/result", "invalid_result", "unrecognised remote decision state"));
  }
  if (record.result === "rejected_by_host") {
    if (!(REMOTE_DECISION_REJECTIONS as readonly unknown[]).includes(record.rejection)) {
      issues.push(issue("/rejection", "invalid_rejection", "a host rejection requires a closed rejection reason"));
    }
  } else if (record.rejection !== undefined) {
    issues.push(issue("/rejection", "unexpected_rejection", "rejection is valid only for rejected_by_host"));
  }
  if (!isCanonicalTimestamp(record.decidedAt)) {
    issues.push(issue("/decidedAt", "invalid_timestamp", "decidedAt must be a canonical UTC timestamp"));
  }
  validateSignature(record.signature, "/signature", issues);

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as AuthorityResultEnvelope);
}

export const AUTHORITY_COMMAND_ENVELOPE_SCHEMA_META = {
  id: "vinci.authority-command-envelope",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
} as const satisfies SchemaMeta;

export const AUTHORITY_RESULT_ENVELOPE_SCHEMA_META = {
  id: "vinci.authority-result-envelope",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
} as const satisfies SchemaMeta;
