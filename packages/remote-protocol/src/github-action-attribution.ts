import { createHash } from "node:crypto";
import {
  canonicalize,
  fail,
  isCanonicalTimestamp,
  isDigest,
  isIdentifier,
  ok,
  ownData,
  plainActor,
  toPlainRecord,
  type Actor,
  type PlainRecord,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { decodeCanonicalBase64Url } from "@getsimpledirect/vinci-device-auth";
import {
  validateSessionBindingRef,
  type SessionBindingRef,
} from "./binding-ref.ts";
import {
  issue,
  prefixIssues,
  rejectUnknownFields,
  validateId,
} from "./wire-validation.ts";

/** The only GitHub mutations this attribution envelope may describe. */
export const GITHUB_ATTRIBUTION_ACTIONS = [
  "pr.created",
  "pr.head_updated",
  "pr.review_submitted",
  "pr.merge_recorded",
] as const;

export type GitHubAttributionAction = (typeof GITHUB_ATTRIBUTION_ACTIONS)[number];

type GitHubPullRequestSubjectBase = {
  /** Stable GitHub GraphQL node id. Renames and repository transfers do not change it. */
  readonly repositoryNodeId: string;
  /** Informational only. Never use owner/name as repository identity. */
  readonly repositoryOwner: string;
  /** Informational only. Never use owner/name as repository identity. */
  readonly repositoryName: string;
  readonly pullRequestNumber: number;
  /** Exact lowercase 40-hex Git object id, never a branch name or abbreviated SHA. */
  readonly headSha: string;
  /** Exact base commit when the issuer recorded one. */
  readonly baseSha?: string;
};

/**
 * The stable GitHub object being acted on.
 *
 * Review and merge identifiers are deliberately legal only for the matching
 * action. They remain optional because delivery payloads and reconciliation
 * reads do not expose them uniformly; their absence must not be filled with a
 * guessed value.
 */
type GitHubPullRequestSubject = GitHubPullRequestSubjectBase & {
  readonly reviewNodeId?: never;
  readonly mergeCommitSha?: never;
};

type GitHubReviewSubject = GitHubPullRequestSubjectBase & {
  readonly reviewNodeId?: string;
  readonly mergeCommitSha?: never;
};

type GitHubMergeSubject = GitHubPullRequestSubjectBase & {
  readonly reviewNodeId?: never;
  readonly mergeCommitSha?: string;
};

export type GitHubActionSubject =
  | GitHubPullRequestSubject
  | GitHubReviewSubject
  | GitHubMergeSubject;

export type GitHubTransportMetadata = {
  readonly provider: "github";
  /** The credential/login observed by GitHub, retained only for operations and debugging. */
  readonly sharedLogin: string;
  /** Literal false prevents the shared credential from being promoted to actor identity. */
  readonly sharedLoginAuthoritative: false;
};

/**
 * A server-issued attribution for one GitHub action.
 *
 * `actor` is the existing Vinci Actor union and must be derived from the
 * authenticated server-side request/session context. GitHub's observed login
 * is shared transport metadata and is never an actor assertion.
 */
type GitHubActionAttributionContext = {
  readonly schemaVersion: 1;
  /** Immutable event/object id. Covered by both the digest and signature. */
  readonly attributionId: string;
  readonly binding: SessionBindingRef;
  readonly actor: Actor;
  readonly transport: GitHubTransportMetadata;
  readonly issuedAt: string;
  readonly idempotencyKey: string;
  readonly issuerKeyId: string;
  readonly signature: {
    readonly alg: "Ed25519";
    /** Canonical unpadded base64url encoding of exactly 64 bytes. */
    readonly value: string;
  };
};

export type GitHubActionAttribution = GitHubActionAttributionContext & (
  | {
      readonly action: "pr.created" | "pr.head_updated";
      readonly subject: GitHubPullRequestSubject;
    }
  | {
      readonly action: "pr.review_submitted";
      readonly subject: GitHubReviewSubject;
    }
  | {
      readonly action: "pr.merge_recorded";
      readonly subject: GitHubMergeSubject;
    }
);

export type GitHubActionAttributionPointer = {
  readonly attributionId: string;
  readonly digest: string;
};

const ATTRIBUTION_FIELDS = [
  "schemaVersion",
  "attributionId",
  "binding",
  "action",
  "actor",
  "subject",
  "transport",
  "issuedAt",
  "idempotencyKey",
  "issuerKeyId",
  "signature",
] as const;

const COMMON_SUBJECT_FIELDS = [
  "repositoryNodeId",
  "repositoryOwner",
  "repositoryName",
  "pullRequestNumber",
  "headSha",
  "baseSha",
] as const;

const SUBJECT_FIELDS_BY_ACTION: Readonly<Record<GitHubAttributionAction, readonly string[]>> = {
  "pr.created": COMMON_SUBJECT_FIELDS,
  "pr.head_updated": COMMON_SUBJECT_FIELDS,
  "pr.review_submitted": [...COMMON_SUBJECT_FIELDS, "reviewNodeId"],
  "pr.merge_recorded": [...COMMON_SUBJECT_FIELDS, "mergeCommitSha"],
};

const TRANSPORT_FIELDS = ["provider", "sharedLogin", "sharedLoginAuthoritative"] as const;
const SIGNATURE_FIELDS = ["alg", "value"] as const;
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPOSITORY_NAME = /^[A-Za-z0-9._-]{1,100}$/;
const OPAQUE_GITHUB_NODE_ID = /^[\x21-\x7e]{1,255}$/;
const SHARED_LOGIN = /^[A-Za-z0-9_.-]{1,250}(?:\[bot\])?$/;

function recordAt(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
): PlainRecord | undefined {
  const plain = toPlainRecord(value);
  if (!plain.ok) {
    prefixIssues(path, plain.issues, issues);
    return undefined;
  }
  return plain.value;
}

function validateSha(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (typeof value !== "string" || !FULL_GIT_SHA.test(value)) {
    issues.push(issue(path, "invalid_git_sha", "expected an exact lowercase 40-hex Git object id"));
  }
}

function validateSubject(
  value: unknown,
  action: GitHubAttributionAction | undefined,
  originalSubject: unknown,
  issues: ValidationIssue[],
): GitHubActionSubject | undefined {
  const subject = recordAt(value, "/subject", issues);
  if (subject === undefined) return undefined;
  rejectUnknownFields(
    subject,
    action === undefined ? COMMON_SUBJECT_FIELDS : SUBJECT_FIELDS_BY_ACTION[action],
    "/subject",
    issues,
  );

  if (typeof subject.repositoryNodeId !== "string" || !OPAQUE_GITHUB_NODE_ID.test(subject.repositoryNodeId)) {
    issues.push(issue("/subject/repositoryNodeId", "invalid_github_node_id", "repositoryNodeId must be a non-whitespace printable ASCII token"));
  }
  if (typeof subject.repositoryOwner !== "string" || !GITHUB_OWNER.test(subject.repositoryOwner)) {
    issues.push(issue("/subject/repositoryOwner", "invalid_github_owner", "repositoryOwner must be a GitHub owner login"));
  }
  if (typeof subject.repositoryName !== "string" || !GITHUB_REPOSITORY_NAME.test(subject.repositoryName)) {
    issues.push(issue("/subject/repositoryName", "invalid_github_repository", "repositoryName must be a GitHub repository name"));
  }
  if (
    !Number.isSafeInteger(subject.pullRequestNumber)
    || (subject.pullRequestNumber as number) < 1
    || Object.is(ownData(originalSubject, "pullRequestNumber"), -0)
  ) {
    issues.push(issue("/subject/pullRequestNumber", "invalid_pull_request_number", "pullRequestNumber must be a positive safe integer"));
  }
  validateSha(subject.headSha, "/subject/headSha", issues);
  if (subject.baseSha !== undefined) validateSha(subject.baseSha, "/subject/baseSha", issues);
  if (subject.mergeCommitSha !== undefined) {
    validateSha(subject.mergeCommitSha, "/subject/mergeCommitSha", issues);
  }
  if (
    subject.reviewNodeId !== undefined
    && (typeof subject.reviewNodeId !== "string" || !OPAQUE_GITHUB_NODE_ID.test(subject.reviewNodeId))
  ) {
    issues.push(issue("/subject/reviewNodeId", "invalid_github_node_id", "reviewNodeId must be a non-whitespace printable ASCII token"));
  }
  return subject as unknown as GitHubActionSubject;
}

function validateTransport(
  value: unknown,
  issues: ValidationIssue[],
): GitHubTransportMetadata | undefined {
  const transport = recordAt(value, "/transport", issues);
  if (transport === undefined) return undefined;
  rejectUnknownFields(transport, TRANSPORT_FIELDS, "/transport", issues);
  if (transport.provider !== "github") {
    issues.push(issue("/transport/provider", "invalid_provider", "provider must be github"));
  }
  if (typeof transport.sharedLogin !== "string" || !SHARED_LOGIN.test(transport.sharedLogin)) {
    issues.push(issue("/transport/sharedLogin", "invalid_shared_login", "sharedLogin must be a GitHub account or app-bot login"));
  }
  if (transport.sharedLoginAuthoritative !== false) {
    issues.push(issue("/transport/sharedLoginAuthoritative", "transport_identity_forbidden", "a shared GitHub login is never authoritative actor identity"));
  }
  return transport as unknown as GitHubTransportMetadata;
}

function validateAttributionSignature(
  value: unknown,
  issues: ValidationIssue[],
): GitHubActionAttribution["signature"] | undefined {
  const signature = recordAt(value, "/signature", issues);
  if (signature === undefined) return undefined;
  rejectUnknownFields(signature, SIGNATURE_FIELDS, "/signature", issues);
  if (signature.alg !== "Ed25519") {
    issues.push(issue("/signature/alg", "invalid_signature_algorithm", "only Ed25519 is supported"));
  }
  if (decodeCanonicalBase64Url(signature.value)?.byteLength !== 64) {
    issues.push(issue("/signature/value", "invalid_signature_value", "signature.value must be canonical unpadded base64url encoding exactly 64 bytes"));
  }
  return signature as unknown as GitHubActionAttribution["signature"];
}

/**
 * Strict shape validation. This does not perform the cryptographic operation:
 * callers must resolve `issuerKeyId` to a currently usable `platform-issuer`
 * Ed25519 key and verify {@link githubActionAttributionSigningPayload}.
 */
export function validateGitHubActionAttribution(
  input: unknown,
): ValidationResult<GitHubActionAttribution> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];
  rejectUnknownFields(record, ATTRIBUTION_FIELDS, "", issues);

  if (record.schemaVersion !== GITHUB_ACTION_ATTRIBUTION_SCHEMA_META.version) {
    issues.push(issue("/schemaVersion", "schema_version_mismatch", "unsupported GitHub action attribution schema version"));
  }
  for (const field of ["attributionId", "idempotencyKey", "issuerKeyId"] as const) {
    validateId(record[field], `/${field}`, issues);
  }

  const binding = validateSessionBindingRef(record.binding);
  if (!binding.ok) prefixIssues("/binding", binding.issues, issues);

  const action = (GITHUB_ATTRIBUTION_ACTIONS as readonly unknown[]).includes(record.action)
    ? record.action as GitHubAttributionAction
    : undefined;
  if (action === undefined) {
    issues.push(issue("/action", "invalid_action", "unrecognised GitHub attribution action"));
  }

  const actor = typeof record.actor === "object" && record.actor !== null && !Array.isArray(record.actor)
    ? plainActor(record.actor as Readonly<Record<string, unknown>>)
    : null;
  if (actor === null) {
    issues.push(issue("/actor", "invalid_actor", "actor must be one exact member of the central Actor union"));
  }

  const subject = validateSubject(
    record.subject,
    action,
    ownData(input, "subject"),
    issues,
  );
  const transport = validateTransport(record.transport, issues);

  if (!isCanonicalTimestamp(record.issuedAt)) {
    issues.push(issue("/issuedAt", "invalid_timestamp", "issuedAt must be a canonical UTC timestamp"));
  }
  const signature = validateAttributionSignature(record.signature, issues);

  if (
    issues.length > 0
    || !binding.ok
    || action === undefined
    || actor === null
    || subject === undefined
    || transport === undefined
    || signature === undefined
  ) {
    return fail(issues);
  }

  return ok(record as unknown as GitHubActionAttribution);
}

/**
 * Canonical UTF-8 bytes covered by Ed25519. Every semantic field and the
 * signature algorithm are covered; only `signature.value` is excluded.
 */
export function githubActionAttributionSigningPayload(
  attribution: GitHubActionAttribution,
): Uint8Array {
  return new TextEncoder().encode(canonicalize({
    schemaVersion: attribution.schemaVersion,
    attributionId: attribution.attributionId,
    binding: attribution.binding,
    action: attribution.action,
    actor: attribution.actor,
    subject: attribution.subject,
    transport: attribution.transport,
    issuedAt: attribution.issuedAt,
    idempotencyKey: attribution.idempotencyKey,
    issuerKeyId: attribution.issuerKeyId,
    signature: { alg: attribution.signature.alg },
  }));
}

/** SHA-256 of the exact canonical bytes signed by the issuer. */
export function githubActionAttributionDigest(
  attribution: GitHubActionAttribution,
): string {
  return createHash("sha256")
    .update(githubActionAttributionSigningPayload(attribution))
    .digest("hex");
}

/** The only comment/body pointer form. Call only with a validated attribution. */
export function githubActionAttributionPointer(
  attribution: GitHubActionAttribution,
): string {
  return `vinci-attribution: ${attribution.attributionId}@sha256:${githubActionAttributionDigest(attribution)}`;
}

/** Strict parser for the compact pointer form. */
export function validateGitHubActionAttributionPointer(
  input: unknown,
): ValidationResult<GitHubActionAttributionPointer> {
  if (typeof input !== "string") {
    return fail([issue("/", "invalid_pointer", "expected a Vinci attribution pointer string")]);
  }
  const prefix = "vinci-attribution: ";
  const separator = "@sha256:";
  if (!input.startsWith(prefix)) {
    return fail([issue("/", "invalid_pointer", "expected vinci-attribution: <id>@sha256:<lowercase digest>")]);
  }
  const body = input.slice(prefix.length);
  const separatorAt = body.indexOf(separator);
  if (separatorAt < 1 || separatorAt !== body.lastIndexOf(separator)) {
    return fail([issue("/", "invalid_pointer", "expected vinci-attribution: <id>@sha256:<lowercase digest>")]);
  }
  const attributionId = body.slice(0, separatorAt);
  const digest = body.slice(separatorAt + separator.length);
  if (!isIdentifier(attributionId) || !isDigest(digest)) {
    return fail([issue("/", "invalid_pointer", "the pointer contains an invalid attribution id or digest")]);
  }
  return ok(Object.freeze({ attributionId, digest }));
}

export const GITHUB_ACTION_ATTRIBUTION_SCHEMA_META = {
  id: "vinci.github-action-attribution",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
} as const satisfies SchemaMeta;
