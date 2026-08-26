import { SESSION_FRAME_SCHEMA_VERSION } from "./frame.ts";
import { WORKER_WARNING_CODES } from "@getsimpledirect/vinci-run-events";
function isWorkerWarningCode(value: unknown): value is (typeof WORKER_WARNING_CODES)[number] {
  return typeof value === "string" && (WORKER_WARNING_CODES as readonly string[]).includes(value);
}

import {
  fail,
  isCanonicalTimestamp,
  isDigest,
  isEnumToken,
  hasField,
  isIdentifier,
  isNonBlankText,
  ok,
  ownData,
  toPlainRecord,
  type OrganizationId,
  type PlainRecord,
  type RunId,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
  type WorkspaceId,
} from "@getsimpledirect/vinci-contracts";
import {
  REMOTE_PROTOCOL_VERSION,
  type SessionId,
} from "@getsimpledirect/vinci-remote-protocol";
import { SESSION_FRAME_KINDS, type SessionFrameKind } from "./frame-types.ts";
import type { SessionFrame } from "./frame.ts";

/** Maximum UTF-8 size of one serialized frame, including its envelope. */
export const MAX_SESSION_FRAME_BYTES = 64 * 1024;
/** Short alias for consumers that already know they are handling session frames. */
export const MAX_FRAME_BYTES = MAX_SESSION_FRAME_BYTES;
/** The host must truncate a diff before constructing a frame larger than this. */
export const MAX_DIFF_HUNK_BYTES = 16 * 1024;
/** Tool payloads are projected to a small human-readable summary. */
export const MAX_TOOL_SUMMARY_BYTES = 2 * 1024;

const ENVELOPE_FIELDS = [
  "schemaVersion",
  "protocolVersion",
  "sessionId",
  "runId",
  "organizationId",
  "workspaceId",
  "seq",
  "at",
  "kind",
  "body",
] as const;

const BODY_FIELDS: Readonly<Record<SessionFrameKind, readonly string[]>> = {
  current_action: ["text"],
  tool_activity: ["toolName", "summary"],
  diff_preview: ["path", "hunk", "truncated", "digest"],
  question: ["questionId", "prompt"],
  warning: ["message", "reasonCode"],
  artifact_preview: ["artifactId", "mime", "caption", "textExcerpt", "digest"],
  redaction_notice: ["count", "category"],
};

// These discriminator values are the hostile inherited-key probes used by
// scripts/check-hostile-keys.mjs. They are forbidden as keys at every depth,
// in addition to being refused as unknown kind values.
const HOSTILE_KEYS = new Set([
  "toString",
  "constructor",
  "valueOf",
  "hasOwnProperty",
  "__proto__",
]);

// Field-name checks complement the exact allowlists. The message never echoes
// a value, so rejected credential material cannot leak into diagnostics.
const CREDENTIAL_KEY_PARTS = [
  "secret",
  "password",
  "passwd",
  "token",
  "apikey",
  "privatekey",
  "accesskey",
  "credential",
  "authorization",
  "connectionstring",
] as const;

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

function pointer(path: string, field: string): string {
  const escaped = field.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${path}/${escaped}`;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function credentialLike(field: string): boolean {
  const normalized = field.replaceAll(/[^A-Za-z0-9]/g, "").toLowerCase();
  return CREDENTIAL_KEY_PARTS.some((part) => normalized.includes(part));
}

function rejectDangerousKeys(
  value: PlainRecord | readonly unknown[],
  path: string,
  issues: ValidationIssue[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      if (typeof entry === "object" && entry !== null) {
        rejectDangerousKeys(entry as PlainRecord | readonly unknown[], `${path}/${index}`, issues);
      }
    });
    return;
  }

  for (const [field, entry] of Object.entries(value)) {
    const fieldPath = pointer(path, field);
    if (HOSTILE_KEYS.has(field)) {
      issues.push(issue(fieldPath, "hostile_field_name", "prototype-like field names are forbidden"));
    }
    if (credentialLike(field)) {
      issues.push(
        issue(
          fieldPath,
          "credential_field_forbidden",
          "credential-like field names are forbidden in an ephemeral session frame",
        ),
      );
    }
    if (typeof entry === "object" && entry !== null) {
      rejectDangerousKeys(entry as PlainRecord | readonly unknown[], fieldPath, issues);
    }
  }
}

function rejectUnknownFields(
  record: PlainRecord,
  allowed: readonly string[],
  path: string,
  noun: string,
  issues: ValidationIssue[],
): void {
  const known = new Set(allowed);
  for (const field of Object.keys(record)) {
    if (!known.has(field)) {
      issues.push(issue(pointer(path, field), "unknown_field", `${noun} carries only its declared fields`));
    }
  }
}

function objectBody(value: unknown, issues: ValidationIssue[]): PlainRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push(issue("/body", "invalid_body", "a frame body is an object"));
    return undefined;
  }
  return value as PlainRecord;
}

function requiredText(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  options: { readonly oneLine?: boolean; readonly maxBytes?: number } = {},
): value is string {
  if (!isNonBlankText(value)) {
    issues.push(issue(path, "invalid_text", "expected non-blank human-readable text"));
    return false;
  }
  if (options.oneLine === true && /[\r\n]/.test(value)) {
    issues.push(issue(path, "multiple_lines", "expected exactly one line"));
  }
  if (options.maxBytes !== undefined && utf8Bytes(value) > options.maxBytes) {
    issues.push(issue(path, "text_too_large", `text exceeds the ${options.maxBytes}-byte limit`));
  }
  return true;
}

function requiredIdentifier(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isIdentifier(value)) {
    issues.push(issue(path, "invalid_id", "an identifier is at most 128 safe characters"));
  }
}

function requiredDigest(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!isDigest(value)) {
    issues.push(issue(path, "invalid_digest", "a digest is 64 lowercase hex characters"));
  }
}

function validateBody(kind: SessionFrameKind, body: PlainRecord, issues: ValidationIssue[]): void {
  rejectUnknownFields(body, BODY_FIELDS[kind], "/body", `${kind} body`, issues);

  switch (kind) {
    case "current_action":
      requiredText(body.text, "/body/text", issues, { oneLine: true });
      break;
    case "tool_activity":
      requiredText(body.toolName, "/body/toolName", issues, { oneLine: true });
      requiredText(body.summary, "/body/summary", issues, {
        oneLine: true,
        maxBytes: MAX_TOOL_SUMMARY_BYTES,
      });
      break;
    case "diff_preview":
      requiredText(body.path, "/body/path", issues, { oneLine: true });
      if (typeof body.hunk !== "string") {
        issues.push(issue("/body/hunk", "invalid_text", "a diff hunk is text"));
      } else if (utf8Bytes(body.hunk) > MAX_DIFF_HUNK_BYTES) {
        issues.push(
          issue(
            "/body/hunk",
            "diff_hunk_too_large",
            `diff hunk exceeds the ${MAX_DIFF_HUNK_BYTES}-byte limit; the host must truncate it`,
          ),
        );
      }
      if (typeof body.truncated !== "boolean") {
        issues.push(issue("/body/truncated", "invalid_flag", "truncated is a boolean"));
      }
      requiredDigest(body.digest, "/body/digest", issues);
      break;
    case "question":
      requiredIdentifier(body.questionId, "/body/questionId", issues);
      requiredText(body.prompt, "/body/prompt", issues);
      break;
    case "warning":
      if (!isWorkerWarningCode(body.reasonCode)) {
        issues.push(
          issue(
            "/body/reasonCode",
            "unknown_reason_code",
            `expected one of ${WORKER_WARNING_CODES.join(", ")}`,
          ),
        );
      }
      requiredText(body.message, "/body/message", issues);
      break;
    case "artifact_preview": {
      requiredIdentifier(body.artifactId, "/body/artifactId", issues);
      if (
        typeof body.mime !== "string"
        || !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(body.mime)
      ) {
        issues.push(issue("/body/mime", "invalid_mime", "expected a MIME media type"));
      }
      requiredText(body.caption, "/body/caption", issues);
      const hasExcerpt = Object.hasOwn(body, "textExcerpt");
      const hasDigest = Object.hasOwn(body, "digest");
      if (hasExcerpt === hasDigest) {
        issues.push(
          issue(
            "/body",
            "artifact_preview_choice",
            "an artifact preview carries exactly one of textExcerpt or digest",
          ),
        );
      } else if (hasExcerpt) {
        requiredText(body.textExcerpt, "/body/textExcerpt", issues);
      } else {
        requiredDigest(body.digest, "/body/digest", issues);
      }
      break;
    }
    case "redaction_notice":
      if (!Number.isSafeInteger(body.count) || (body.count as number) < 1) {
        issues.push(issue("/body/count", "invalid_count", "a redaction count is a positive safe integer"));
      }
      if (!isEnumToken(body.category)) {
        issues.push(issue("/body/category", "invalid_category", "a category is a short symbolic token"));
      }
      break;
  }
}

/**
 * Whether `next` is the one unused sequence value immediately after `prev`.
 * Gaps, replays, negative values, unsafe integers, and overflow all fail.
 */
export function nextSeqIsValid(prev: unknown, next: unknown): boolean {
  return (
    typeof prev === "number"
    && Number.isSafeInteger(prev)
    && prev >= 0
    && typeof next === "number"
    && Number.isSafeInteger(next)
    && next === prev + 1
  );
}

/**
 * Does this frame name the exact routing authority of the authenticated
 * connection? The body may be ciphertext; only the authenticated binding
 * fields are read here.
 */
export function frameMatchesBinding(
  frame: SessionFrame,
  binding: {
    readonly protocolVersion: number;
    readonly organizationId: OrganizationId | null;
    readonly workspaceId: WorkspaceId;
    readonly runId: RunId;
    readonly sessionId: SessionId;
  },
): boolean {
  const frameProtocolVersion = ownData(frame, "protocolVersion");
  const frameOrganizationId = ownData(frame, "organizationId");
  const frameWorkspaceId = ownData(frame, "workspaceId");
  const frameRunId = ownData(frame, "runId");
  const frameSessionId = ownData(frame, "sessionId");
  const bindingProtocolVersion = ownData(binding, "protocolVersion");
  const bindingOrganizationId = ownData(binding, "organizationId");
  const bindingWorkspaceId = ownData(binding, "workspaceId");
  const bindingRunId = ownData(binding, "runId");
  const bindingSessionId = ownData(binding, "sessionId");

  return (
    typeof frameProtocolVersion === "number"
    && Number.isSafeInteger(frameProtocolVersion)
    && frameProtocolVersion >= 1
    && frameProtocolVersion === bindingProtocolVersion
    && (frameOrganizationId === null || isIdentifier(frameOrganizationId))
    && frameOrganizationId === bindingOrganizationId
    && isIdentifier(frameWorkspaceId)
    && frameWorkspaceId === bindingWorkspaceId
    && isIdentifier(frameRunId)
    && frameRunId === bindingRunId
    && isIdentifier(frameSessionId)
    && frameSessionId === bindingSessionId
  );
}

export function validateSessionFrame(input: unknown): ValidationResult<SessionFrame> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  rejectDangerousKeys(record, "", issues);
  rejectUnknownFields(record, ENVELOPE_FIELDS, "", "a session frame", issues);

  if (utf8Bytes(JSON.stringify(record)) > MAX_SESSION_FRAME_BYTES) {
    issues.push(
      issue(
        "/",
        "frame_too_large",
        `serialized frame exceeds the ${MAX_SESSION_FRAME_BYTES}-byte limit; the host must truncate it`,
      ),
    );
  }

  if (record.schemaVersion !== SESSION_FRAME_SCHEMA_VERSION) {
    issues.push(
      issue(
        "/schemaVersion",
        "invalid_schema_version",
        `session frames are schema version ${SESSION_FRAME_SCHEMA_VERSION}; version 1 frames carry no binding and are rejected`,
      ),
    );
  }
  if (record.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
    issues.push(
      issue(
        "/protocolVersion",
        "protocol_version_mismatch",
        `this build speaks remote protocol ${REMOTE_PROTOCOL_VERSION}`,
      ),
    );
  }
  requiredIdentifier(record.sessionId, "/sessionId", issues);
  requiredIdentifier(record.runId, "/runId", issues);
  if (!hasField(record, "organizationId")) {
    issues.push(
      issue(
        "/organizationId",
        "required_field",
        "organizationId must be present and explicitly null for a personal workspace",
      ),
    );
  } else if (record.organizationId !== null) {
    requiredIdentifier(record.organizationId, "/organizationId", issues);
  }
  requiredIdentifier(record.workspaceId, "/workspaceId", issues);
  if (typeof record.seq !== "number" || !Number.isSafeInteger(record.seq) || record.seq < 0) {
    issues.push(issue("/seq", "invalid_sequence", "seq is a non-negative safe integer"));
  }
  if (!isCanonicalTimestamp(record.at)) {
    issues.push(
      issue(
        "/at",
        "invalid_timestamp",
        "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z",
      ),
    );
  }

  if (!isSessionFrameKind(record.kind)) {
    issues.push(issue("/kind", "unknown_frame_kind", "unrecognised session frame kind"));
  }
  const body = objectBody(record.body, issues);
  if (body !== undefined && isSessionFrameKind(record.kind)) {
    validateBody(record.kind, body, issues);
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as SessionFrame, {});
}

function isSessionFrameKind(value: unknown): value is SessionFrameKind {
  return (
    typeof value === "string"
    && (SESSION_FRAME_KINDS as readonly string[]).includes(value)
  );
}

export const SESSION_FRAME_SCHEMA_META: SchemaMeta & { readonly retention: "ephemeral" } = {
  id: "vinci.session-frame",
  version: 2,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration:
    "Version-1 frames are rejected: an unbound frame cannot be routed safely; producers must add the authenticated organizationId and workspaceId binding fields.",
  /** Frames are display transport and must never be treated as durable records. */
  retention: "ephemeral",
};
