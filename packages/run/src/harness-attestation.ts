import {
  fail,
  isCanonicalTimestamp,
  isDigest,
  isIdentifier,
  isNonBlankText,
  isStrictlyAfter,
  ok,
  plainActor,
  toPlainRecord,
  type Actor,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { HARNESS_CAPABILITIES, type HarnessCapability } from "@getsimpledirect/vinci-model-classes";
import { digestValidated } from "./digest.ts";
import {
  isEnumMember,
  isObjectRecord,
  isPositiveInt,
  issue,
  rejectUnknownFields,
} from "./lib/validate.ts";

/**
 * What a harness has actually established about itself, per capability.
 *
 * `matchEndpointToRole` (model-classes) cannot confirm a harness capability —
 * an inference endpoint has no way to edit a repository — so it withholds
 * eligibility for any role that requires one until a CALLER hands it a list of
 * capabilities the harness has established. This record is where that list
 * comes from. Each entry names the capability, the self-test that proved it,
 * its result, and WHICH entrypoint was observed running the self-test: a
 * capability proven on a source checkout says nothing about the installed
 * worker that will actually run the job (see the worker artifact-identity
 * finding), so only `installed_worker` counts.
 */
export type HarnessAttestation = {
  readonly schemaVersion: 1;
  readonly attestationId: string;
  readonly runtimeBuild: string;
  readonly environmentDigest: string;
  readonly workerPrincipalId: string;
  readonly capabilities: readonly AttestedCapability[];
  readonly createdAt: string;
  readonly expiresAt: string;
  /** Who issued the attestation. Snapshotted through plainActor, so a proxy cannot lie about it. */
  readonly issuedBy: Actor;
};

export const ATTESTATION_STATUSES = ["PASS", "FAIL", "SKIPPED"] as const;
export type AttestationStatus = (typeof ATTESTATION_STATUSES)[number];

export const OBSERVED_ENTRYPOINTS = ["installed_worker", "source_checkout"] as const;
export type ObservedEntrypoint = (typeof OBSERVED_ENTRYPOINTS)[number];

export type AttestedCapability = {
  readonly id: string;
  readonly version: number;
  readonly status: AttestationStatus;
  readonly selfTestDigest: string;
  readonly observedEntrypoint: ObservedEntrypoint;
};

function validateCapability(raw: unknown, path: string, issues: ValidationIssue[], seen: Set<string>): void {
  if (!isObjectRecord(raw)) {
    issues.push(issue(path, "invalid_type", "an attested capability is an object"));
    return;
  }
  rejectUnknownFields(
    raw,
    ["id", "version", "status", "selfTestDigest", "observedEntrypoint"],
    path,
    "an attested capability",
    issues,
  );
  if (!isIdentifier(raw.id)) {
    issues.push(issue(`${path}/id`, "invalid_id", "a capability id is an identifier"));
  } else if (seen.has(raw.id)) {
    issues.push(issue(`${path}/id`, "duplicate_capability", "a capability is attested twice"));
  } else {
    seen.add(raw.id);
  }
  if (!isPositiveInt(raw.version)) {
    issues.push(issue(`${path}/version`, "invalid_version", "a capability version is a positive integer"));
  }
  if (!isEnumMember(raw.status, ATTESTATION_STATUSES)) {
    issues.push(issue(`${path}/status`, "unknown_attestation_status", "status must be PASS, FAIL, or SKIPPED"));
  }
  if (!isDigest(raw.selfTestDigest)) {
    issues.push(issue(`${path}/selfTestDigest`, "invalid_digest", "selfTestDigest is 64 lowercase hex characters"));
  }
  if (!isEnumMember(raw.observedEntrypoint, OBSERVED_ENTRYPOINTS)) {
    issues.push(
      issue(
        `${path}/observedEntrypoint`,
        "unknown_entrypoint",
        "observedEntrypoint must be installed_worker or source_checkout",
      ),
    );
  }
}

/** Validate a harness attestation from untrusted input. */
export function validateHarnessAttestation(input: unknown): ValidationResult<HarnessAttestation> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  rejectUnknownFields(
    record,
    [
      "schemaVersion", "attestationId", "runtimeBuild", "environmentDigest", "workerPrincipalId",
      "capabilities", "createdAt", "expiresAt", "issuedBy",
    ],
    "",
    "a harness attestation",
    issues,
  );

  if (record.schemaVersion !== 1) {
    issues.push(issue("/schemaVersion", "invalid_schema_version", "this schema is version 1"));
  }
  for (const field of ["attestationId", "workerPrincipalId"] as const) {
    if (!isIdentifier(record[field])) {
      issues.push(issue(`/${field}`, "invalid_id", `${field} is an identifier`));
    }
  }
  if (!isNonBlankText(record.runtimeBuild)) {
    issues.push(issue("/runtimeBuild", "required_field", "runtimeBuild must be non-blank text"));
  }
  if (!isDigest(record.environmentDigest)) {
    issues.push(issue("/environmentDigest", "invalid_digest", "environmentDigest is 64 lowercase hex characters"));
  }

  if (!Array.isArray(record.capabilities)) {
    issues.push(issue("/capabilities", "invalid_type", "capabilities is an array"));
  } else {
    const seen = new Set<string>();
    record.capabilities.forEach((raw, i) => validateCapability(raw, `/capabilities/${i}`, issues, seen));
  }

  for (const field of ["createdAt", "expiresAt"] as const) {
    if (!isCanonicalTimestamp(record[field])) {
      issues.push(
        issue(`/${field}`, "invalid_timestamp", "expected ISO-8601 UTC with millisecond precision, e.g. 2026-08-23T12:00:00.000Z"),
      );
    }
  }
  if (
    isCanonicalTimestamp(record.createdAt)
    && isCanonicalTimestamp(record.expiresAt)
    && !isStrictlyAfter(record.expiresAt, record.createdAt)
  ) {
    issues.push(issue("/expiresAt", "expiry_not_after_creation", "expiresAt must be strictly later than createdAt"));
  }

  // plainActor, not a local check: the issuer's identity decides whose word
  // this attestation is, and a proxy must not be able to answer differently
  // to the validator and to the consumer.
  if (!isObjectRecord(record.issuedBy) || plainActor(record.issuedBy) === null) {
    issues.push(issue("/issuedBy", "invalid_actor", "issuedBy must be a consistent actor"));
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as HarnessAttestation, {});
}

/**
 * The harness capabilities this attestation actually establishes at `now`.
 *
 * This is the ONLY function that should feed `matchEndpointToRole`'s
 * `attestedHarnessCapabilities` argument. It is deliberately narrower than the
 * record: an entry counts only when its self-test PASSED, was observed on the
 * INSTALLED worker (not a source checkout), the attestation has not expired
 * (`expiresAt` strictly after `now`), and the id is a member of
 * HARNESS_CAPABILITIES. Anything else — a FAIL, a SKIPPED, an unknown id, a
 * stale attestation, an invalid record, an unparseable `now` — contributes
 * nothing. Returning an empty list is the fail-closed answer: the matcher
 * treats it as "stated and does not cover", never as a grant.
 */
export function attestedHarnessCapabilities(attestation: HarnessAttestation, now: string): HarnessCapability[] {
  const validated = validateHarnessAttestation(attestation);
  if (!validated.ok) return [];
  if (!isStrictlyAfter(validated.value.expiresAt, now)) return [];
  const out: HarnessCapability[] = [];
  for (const capability of validated.value.capabilities) {
    if (capability.status !== "PASS") continue;
    if (capability.observedEntrypoint !== "installed_worker") continue;
    if (!isEnumMember(capability.id, HARNESS_CAPABILITIES)) continue;
    const id = capability.id as HarnessCapability;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** The identity of an attestation: SHA-256 over the canonical, validated record. */
export function harnessAttestationDigest(attestation: HarnessAttestation): string {
  return digestValidated("harness attestation", validateHarnessAttestation(attestation));
}

export const HARNESS_ATTESTATION_SCHEMA_META: SchemaMeta = {
  id: "vinci.harness-attestation",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
