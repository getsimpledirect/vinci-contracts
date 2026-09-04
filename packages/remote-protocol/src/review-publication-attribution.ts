import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";
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
  type PlainValue,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { decodeCanonicalBase64Url } from "@getsimpledirect/vinci-device-auth";
import {
  validateSessionBindingRef,
  type SessionBindingRef,
} from "./binding-ref.ts";
import { parseStrictSignedJson } from "./strict-json.ts";
import {
  issue,
  prefixIssues,
  rejectUnknownFields,
  validateId,
} from "./wire-validation.ts";

export const REVIEW_PUBLICATION_PURPOSE = "guard_review.publish" as const;
export const REVIEW_PUBLICATION_AUDIENCE = "vinci-acceptance" as const;
export const REVIEW_PUBLICATION_VERDICTS = ["GO", "BLOCK"] as const;
export const MAX_REVIEW_PUBLICATION_ATTRIBUTION_LIFETIME_MS = 10 * 60 * 1_000;

export type ReviewPublicationVerdict = (typeof REVIEW_PUBLICATION_VERDICTS)[number];

export type ReviewPublicationGitHubSubject = {
  readonly provider: "github";
  /** Stable GitHub GraphQL repository node id; owner/name is never identity. */
  readonly repositoryNodeId: string;
  readonly pullRequestNumber: number;
  /** Exact lowercase, full Git object ids. Branch names and abbreviations are forbidden. */
  readonly headSha: string;
  readonly baseSha: string;
  readonly headTreeSha: string;
};

/**
 * A VGC-signed transport assertion for one guard-review publication attempt.
 *
 * This value carries no authority by itself. Runtime VGC MUST derive `actor`
 * and every member of `binding` from authenticated server-side state, prove
 * verifier independence there, and re-resolve the GitHub subject before it
 * signs. Vinci Acceptance MUST independently authenticate its caller, resolve
 * a currently usable platform-issuer key, verify this signature and binding,
 * and re-resolve the repository/PR snapshot. A caller-authored value that
 * merely validates against this transport schema is not an identity, session,
 * tenant, reviewer-independence, or publication authorization proof.
 */
export type ReviewPublicationAttribution = {
  readonly schemaVersion: 1;
  readonly purpose: typeof REVIEW_PUBLICATION_PURPOSE;
  readonly audience: typeof REVIEW_PUBLICATION_AUDIENCE;
  readonly actor: Actor;
  readonly binding: SessionBindingRef;
  readonly subject: ReviewPublicationGitHubSubject;
  readonly verdict: ReviewPublicationVerdict;
  readonly recordSetDigest: string;
  readonly idempotencyKey: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly issuerKeyId: string;
  readonly signature: {
    readonly alg: "Ed25519";
    /** Canonical unpadded base64url encoding of exactly 64 bytes. */
    readonly value: string;
  };
};

export type ReviewPublicationReference = {
  readonly reviewId: string;
  readonly publicationDigest: string;
};

const ATTRIBUTION_FIELDS = [
  "schemaVersion",
  "purpose",
  "audience",
  "actor",
  "binding",
  "subject",
  "verdict",
  "recordSetDigest",
  "idempotencyKey",
  "issuedAt",
  "expiresAt",
  "issuerKeyId",
  "signature",
] as const;
const SUBJECT_FIELDS = [
  "provider",
  "repositoryNodeId",
  "pullRequestNumber",
  "headSha",
  "baseSha",
  "headTreeSha",
] as const;
const FULL_GIT_SHA = /^[0-9a-f]{40}$/;
const OPAQUE_GITHUB_NODE_ID = /^[\x21-\x7e]{1,255}$/;
const REVIEW_ID = /^grv_[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/;
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** Python datetime and this wire contract share the ISO-8601 year 0001..9999 domain. */
function isReviewPublicationTimestamp(value: unknown): value is string {
  return isCanonicalTimestamp(value) && !(value as string).startsWith("0000-");
}

function assertSigningTimePair(attribution: ReviewPublicationAttribution): void {
  if (!isReviewPublicationTimestamp(attribution.issuedAt)
      || !isReviewPublicationTimestamp(attribution.expiresAt)) {
    throw new Error("review-publication signing timestamps must be canonical years 0001 through 9999");
  }
  const lifetime = Date.parse(attribution.expiresAt) - Date.parse(attribution.issuedAt);
  if (lifetime <= 0 || lifetime > MAX_REVIEW_PUBLICATION_ATTRIBUTION_LIFETIME_MS) {
    throw new Error("review-publication signing timestamps must be ordered within the ten-minute lifetime");
  }
}

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

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function validateUnicode(
  value: PlainValue,
  path: string,
  issues: ValidationIssue[],
): void {
  if (typeof value === "string") {
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(i + 1);
        if (next < 0xdc00 || next > 0xdfff) {
          issues.push(issue(path, "invalid_unicode", "strings must contain only Unicode scalar values"));
          return;
        }
        i += 1;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        issues.push(issue(path, "invalid_unicode", "strings must contain only Unicode scalar values"));
        return;
      }
    }
    if (value.normalize("NFC") !== value) {
      issues.push(issue(path, "non_canonical_unicode", "strings must use Unicode NFC normalization"));
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateUnicode(entry, `${path}/${index}`, issues));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      validateUnicode(key, `${path}/${escapePointer(key)}`, issues);
      validateUnicode(entry, `${path}/${escapePointer(key)}`, issues);
    }
  }
}

function validateSubject(
  value: unknown,
  originalValue: unknown,
  issues: ValidationIssue[],
): ReviewPublicationGitHubSubject | undefined {
  const subject = recordAt(value, "/subject", issues);
  if (subject === undefined) return undefined;
  rejectUnknownFields(subject, SUBJECT_FIELDS, "/subject", issues);
  if (subject.provider !== "github") {
    issues.push(issue("/subject/provider", "invalid_provider", "provider must be github"));
  }
  if (typeof subject.repositoryNodeId !== "string" || !OPAQUE_GITHUB_NODE_ID.test(subject.repositoryNodeId)) {
    issues.push(issue("/subject/repositoryNodeId", "invalid_github_node_id", "repositoryNodeId must be a printable ASCII GitHub node id"));
  }
  const original = ownData(originalValue, "pullRequestNumber");
  if (
    !Number.isSafeInteger(subject.pullRequestNumber)
    || (subject.pullRequestNumber as number) < 1
    || Object.is(original, -0)
  ) {
    issues.push(issue("/subject/pullRequestNumber", "invalid_pull_request_number", "pullRequestNumber must be a positive safe integer"));
  }
  for (const field of ["headSha", "baseSha", "headTreeSha"] as const) {
    if (typeof subject[field] !== "string" || !FULL_GIT_SHA.test(subject[field])) {
      issues.push(issue(`/subject/${field}`, "invalid_git_sha", `${field} must be an exact lowercase 40-hex Git object id`));
    }
  }
  return subject as unknown as ReviewPublicationGitHubSubject;
}

function validateSignature(
  value: unknown,
  issues: ValidationIssue[],
): ReviewPublicationAttribution["signature"] | undefined {
  const signature = recordAt(value, "/signature", issues);
  if (signature === undefined) return undefined;
  rejectUnknownFields(signature, ["alg", "value"], "/signature", issues);
  if (signature.alg !== "Ed25519") {
    issues.push(issue("/signature/alg", "invalid_signature_algorithm", "only Ed25519 is supported"));
  }
  if (decodeCanonicalBase64Url(signature.value)?.byteLength !== 64) {
    issues.push(issue("/signature/value", "invalid_signature_value", "signature.value must be canonical unpadded base64url encoding of exactly 64 bytes"));
  }
  return signature as unknown as ReviewPublicationAttribution["signature"];
}

/**
 * Strict transport validation at an explicit trusted clock instant.
 *
 * Passing does not verify the signature, key role/status, caller, tenancy,
 * repository state, session binding, reviewer identity, or independence.
 */
export function validateReviewPublicationAttribution(
  input: unknown,
  now: string,
): ValidationResult<ReviewPublicationAttribution> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];
  validateUnicode(record, "", issues);
  rejectUnknownFields(record, ATTRIBUTION_FIELDS, "", issues);

  if (!isReviewPublicationTimestamp(now)) {
    issues.push(issue("/", "invalid_validation_time", "expiry validation requires a canonical UTC timestamp"));
  }
  if (record.schemaVersion !== REVIEW_PUBLICATION_ATTRIBUTION_SCHEMA_META.version) {
    issues.push(issue("/schemaVersion", "schema_version_mismatch", "unsupported review-publication attribution schema version"));
  }
  if (record.purpose !== REVIEW_PUBLICATION_PURPOSE) {
    issues.push(issue("/purpose", "invalid_purpose", `purpose must be ${REVIEW_PUBLICATION_PURPOSE}`));
  }
  if (record.audience !== REVIEW_PUBLICATION_AUDIENCE) {
    issues.push(issue("/audience", "invalid_audience", `audience must be ${REVIEW_PUBLICATION_AUDIENCE}`));
  }

  const actor = typeof record.actor === "object" && record.actor !== null && !Array.isArray(record.actor)
    ? plainActor(record.actor as Readonly<Record<string, unknown>>)
    : null;
  if (actor === null) {
    issues.push(issue("/actor", "invalid_actor", "actor must be one exact member of the central Actor union"));
  } else {
    const identityFields = actor.kind === "user"
      ? ["userId", ...(actor.deviceId === undefined ? [] : ["deviceId"])] as const
      : actor.kind === "worker"
        ? ["workerId"] as const
        : actor.kind === "policy"
          ? ["policyId"] as const
          : actor.kind === "system"
            ? ["component"] as const
            : ["verifierId"] as const;
    for (const field of identityFields) {
      if (!isIdentifier(actor[field])) {
        issues.push(issue(`/actor/${field}`, "invalid_id", `${field} must be an identifier`));
      }
    }
    if (actor.kind === "policy" && !Number.isSafeInteger(actor.policyVersion)) {
      issues.push(issue("/actor/policyVersion", "unsafe_integer", "policyVersion must be a positive safe integer"));
    }
  }

  const binding = validateSessionBindingRef(record.binding);
  if (!binding.ok) prefixIssues("/binding", binding.issues, issues);
  const subject = validateSubject(
    record.subject,
    ownData(input, "subject"),
    issues,
  );

  if (!(REVIEW_PUBLICATION_VERDICTS as readonly unknown[]).includes(record.verdict)) {
    issues.push(issue("/verdict", "invalid_verdict", "verdict must be GO or BLOCK"));
  }
  if (!isDigest(record.recordSetDigest)) {
    issues.push(issue("/recordSetDigest", "invalid_digest", "recordSetDigest must be lowercase SHA-256"));
  }
  for (const field of ["idempotencyKey", "issuerKeyId"] as const) {
    validateId(record[field], `/${field}`, issues);
  }
  if (!isReviewPublicationTimestamp(record.issuedAt)) {
    issues.push(issue("/issuedAt", "invalid_timestamp", "issuedAt must be a canonical UTC timestamp in years 0001 through 9999"));
  }
  if (!isReviewPublicationTimestamp(record.expiresAt)) {
    issues.push(issue("/expiresAt", "invalid_timestamp", "expiresAt must be a canonical UTC timestamp in years 0001 through 9999"));
  }
  if (isReviewPublicationTimestamp(record.issuedAt) && isReviewPublicationTimestamp(record.expiresAt)) {
    const issuedMs = Date.parse(record.issuedAt);
    const expiresMs = Date.parse(record.expiresAt);
    if (expiresMs <= issuedMs) {
      issues.push(issue("/expiresAt", "invalid_time_order", "expiresAt must be strictly later than issuedAt"));
    } else if (expiresMs - issuedMs > MAX_REVIEW_PUBLICATION_ATTRIBUTION_LIFETIME_MS) {
      issues.push(issue("/expiresAt", "lifetime_exceeded", "a review-publication attribution may live for at most 10 minutes"));
    }
    if (isReviewPublicationTimestamp(now) && expiresMs <= Date.parse(now)) {
      issues.push(issue("/expiresAt", "expired", "the review-publication attribution has expired"));
    }
  }
  const signature = validateSignature(record.signature, issues);

  if (
    issues.length > 0
    || actor === null
    || !binding.ok
    || subject === undefined
    || signature === undefined
  ) {
    return fail(issues);
  }
  return ok(record as unknown as ReviewPublicationAttribution);
}

/** Rejects duplicate fields, invalid UTF-8/Unicode and unsafe JSON numbers before shape validation. */
export function parseReviewPublicationAttributionJson(
  input: string | Uint8Array,
  now: string,
): ValidationResult<ReviewPublicationAttribution> {
  const parsed = parseStrictSignedJson(input);
  if (!parsed.ok) return parsed;
  return validateReviewPublicationAttribution(parsed.value, now);
}

/** Canonical UTF-8 bytes signed by VGC; only signature.value is excluded. */
export function reviewPublicationAttributionSigningPayload(
  attribution: ReviewPublicationAttribution,
): Uint8Array {
  assertSigningTimePair(attribution);
  return new TextEncoder().encode(canonicalize({
    schemaVersion: attribution.schemaVersion,
    purpose: attribution.purpose,
    audience: attribution.audience,
    actor: attribution.actor,
    binding: attribution.binding,
    subject: attribution.subject,
    verdict: attribution.verdict,
    recordSetDigest: attribution.recordSetDigest,
    idempotencyKey: attribution.idempotencyKey,
    issuedAt: attribution.issuedAt,
    expiresAt: attribution.expiresAt,
    issuerKeyId: attribution.issuerKeyId,
    signature: { alg: attribution.signature.alg },
  }));
}

/** SHA-256 of the exact canonical signing bytes, excluding signature.value. */
export function reviewPublicationAttributionDigest(
  attribution: ReviewPublicationAttribution,
): string {
  return createHash("sha256")
    .update(reviewPublicationAttributionSigningPayload(attribution))
    .digest("hex");
}

/**
 * Cryptographic check only, against one raw Ed25519 public key.
 *
 * A true result does not establish that the key is a usable VGC platform
 * issuer or that the claims match server state; Acceptance must check those
 * facts independently.
 */
export function verifyReviewPublicationAttributionSignature(
  attribution: ReviewPublicationAttribution,
  publicKey: string,
): boolean {
  try {
    const rawKey = decodeCanonicalBase64Url(publicKey);
    const signature = decodeCanonicalBase64Url(attribution.signature.value);
    if (rawKey?.byteLength !== 32 || signature?.byteLength !== 64) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(rawKey)]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      reviewPublicationAttributionSigningPayload(attribution),
      key,
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}

export function validateReviewPublicationReference(
  input: unknown,
): ValidationResult<ReviewPublicationReference> {
  if (typeof input !== "string") {
    return fail([issue("/", "invalid_review_reference", "expected a compact guard-review reference string")]);
  }
  const separator = "@sha256:";
  const separatorAt = input.indexOf(separator);
  if (separatorAt < 1 || separatorAt !== input.lastIndexOf(separator)) {
    return fail([issue("/", "invalid_review_reference", "expected grv_<id>@sha256:<lowercase publication digest>")]);
  }
  const reviewId = input.slice(0, separatorAt);
  const publicationDigest = input.slice(separatorAt + separator.length);
  if (!REVIEW_ID.test(reviewId) || !isDigest(publicationDigest)) {
    return fail([issue("/", "invalid_review_reference", "review id or publication digest is malformed")]);
  }
  return ok(Object.freeze({ reviewId, publicationDigest }));
}

export function formatReviewPublicationReference(
  reviewId: unknown,
  publicationDigest: unknown,
): ValidationResult<string> {
  if (typeof reviewId !== "string" || typeof publicationDigest !== "string") {
    return fail([issue("/", "invalid_review_reference", "review id and publication digest must be strings")]);
  }
  const candidate = `${reviewId}@sha256:${publicationDigest}`;
  const checked = validateReviewPublicationReference(candidate);
  return checked.ok ? ok(candidate) : checked;
}

export const REVIEW_PUBLICATION_ATTRIBUTION_SCHEMA_META = {
  id: "vinci.review-publication-attribution",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
} as const satisfies SchemaMeta;
