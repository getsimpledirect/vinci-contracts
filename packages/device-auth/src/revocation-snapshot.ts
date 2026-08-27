import {
  canonicalize,
  fail,
  isCanonicalTimestamp,
  isIdentifier,
  ok,
  ownData,
  toPlainRecord,
  type DeviceId,
  type PlainRecord,
  type SchemaMeta,
  type Timestamp,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { decodeCanonicalBase64Url } from "./credential.ts";

// Layer-1 twin of the Layer-3 run-events `device.revoked` revokedBy vocabulary.
export const REVOCATION_ACTORS = ["self", "dashboard", "platform"] as const;
export type RevocationActor = (typeof REVOCATION_ACTORS)[number];

export type RevocationRecord = {
  readonly credentialId: string;
  readonly deviceId: DeviceId;
  readonly revokedAt: Timestamp;
  readonly revokedBy: RevocationActor;
};

export type RevocationSnapshot = {
  readonly schemaVersion: 1;
  readonly version: number;
  readonly issuedAt: Timestamp;
  readonly issuerKeyId: string;
  readonly revoked: readonly RevocationRecord[];
  readonly signature: {
    readonly alg: "Ed25519";
    readonly value: string;
  };
};

const SNAPSHOT_FIELDS = new Set([
  "schemaVersion",
  "version",
  "issuedAt",
  "issuerKeyId",
  "revoked",
  "signature",
]);
const RECORD_FIELDS = new Set(["credentialId", "deviceId", "revokedAt", "revokedBy"]);
const SIGNATURE_FIELDS = new Set(["alg", "value"]);

function issue(path: string, code: string, message: string): ValidationIssue {
  return { path, code, message };
}

function rejectUnknownFields(
  record: PlainRecord,
  known: ReadonlySet<string>,
  path: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      issues.push(issue(`${path}/${key}`, "unknown_field", "the signed revocation snapshot shape is closed"));
    }
  }
}

function recordAt(
  value: PlainRecord[string] | undefined,
  path: string,
  issues: ValidationIssue[],
): PlainRecord | undefined {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as PlainRecord;
  }
  issues.push(issue(path, "invalid_record", "expected a record"));
  return undefined;
}

export function validateRevocationSnapshot(input: unknown): ValidationResult<RevocationSnapshot> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];
  rejectUnknownFields(record, SNAPSHOT_FIELDS, "", issues);

  if (record.schemaVersion !== REVOCATION_SNAPSHOT_SCHEMA_META.version) {
    issues.push(issue("/schemaVersion", "schema_version_mismatch", "unsupported revocation-snapshot schema version"));
  }
  const originalVersion = ownData(input, "version");
  if (
    !Number.isSafeInteger(record.version)
    || (record.version as number) < 0
    || Object.is(originalVersion, -0)
  ) {
    issues.push(issue("/version", "invalid_version", "version must be a non-negative safe integer other than -0"));
  }
  if (!isCanonicalTimestamp(record.issuedAt)) {
    issues.push(issue("/issuedAt", "invalid_timestamp", "issuedAt must be a canonical timestamp"));
  }
  if (!isIdentifier(record.issuerKeyId)) {
    issues.push(issue("/issuerKeyId", "invalid_id", "issuerKeyId must be an identifier"));
  }

  const revoked: RevocationRecord[] = [];
  if (!Array.isArray(record.revoked)) {
    issues.push(issue("/revoked", "invalid_array", "revoked must be an array"));
  } else {
    for (const [index, value] of record.revoked.entries()) {
      const path = `/revoked/${index}`;
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        issues.push(issue(path, "invalid_record", "each revocation must be a record"));
        continue;
      }
      const item = value as PlainRecord;
      const before = issues.length;
      rejectUnknownFields(item, RECORD_FIELDS, path, issues);
      if (!isIdentifier(item.credentialId)) {
        issues.push(issue(`${path}/credentialId`, "invalid_id", "credentialId must be an identifier"));
      }
      if (!isIdentifier(item.deviceId)) {
        issues.push(issue(`${path}/deviceId`, "invalid_id", "deviceId must be an identifier"));
      }
      if (!isCanonicalTimestamp(item.revokedAt)) {
        issues.push(issue(`${path}/revokedAt`, "invalid_timestamp", "revokedAt must be a canonical timestamp"));
      }
      if (!(REVOCATION_ACTORS as readonly unknown[]).includes(item.revokedBy)) {
        issues.push(issue(`${path}/revokedBy`, "invalid_revocation_actor", "unrecognised revocation actor"));
      }
      if (issues.length === before) {
        revoked.push(Object.freeze({
          credentialId: item.credentialId as string,
          deviceId: item.deviceId as DeviceId,
          revokedAt: item.revokedAt as Timestamp,
          revokedBy: item.revokedBy as RevocationActor,
        }));
      }
    }
  }

  const signature = recordAt(record.signature, "/signature", issues);
  if (signature !== undefined) {
    rejectUnknownFields(signature, SIGNATURE_FIELDS, "/signature", issues);
    if (signature.alg !== "Ed25519") {
      issues.push(issue("/signature/alg", "invalid_signature_algorithm", "revocation snapshots use Ed25519 signatures"));
    }
    if (decodeCanonicalBase64Url(signature.value)?.byteLength !== 64) {
      issues.push(issue("/signature/value", "invalid_signature_value", "signature.value must be canonical base64url encoding exactly 64 bytes"));
    }
  }

  if (issues.length > 0 || signature === undefined) return fail(issues);
  return ok(Object.freeze({
    schemaVersion: 1,
    version: record.version as number,
    issuedAt: record.issuedAt as Timestamp,
    issuerKeyId: record.issuerKeyId as string,
    revoked: Object.freeze(revoked),
    signature: Object.freeze({ alg: "Ed25519", value: signature.value as string }),
  }));
}

/** Canonical UTF-8 bytes covered by the issuer's Ed25519 signature. */
export function revocationSnapshotSigningPayload(snapshot: RevocationSnapshot): Uint8Array {
  return new TextEncoder().encode(canonicalize({
    schemaVersion: snapshot.schemaVersion,
    version: snapshot.version,
    issuedAt: snapshot.issuedAt,
    issuerKeyId: snapshot.issuerKeyId,
    revoked: snapshot.revoked,
    // The algorithm is covered by the signature (as for RelayAccessToken) so it cannot be rebound in transit.
    signature: { alg: snapshot.signature.alg },
  }));
}

/** Applying an equal or older snapshot could resurrect revoked credentials. */
export function isSnapshotNewer(candidate: number, currentVersion: number): boolean {
  return Number.isSafeInteger(candidate)
    && candidate >= 0
    && !Object.is(candidate, -0)
    && Number.isSafeInteger(currentVersion)
    && currentVersion >= 0
    && !Object.is(currentVersion, -0)
    && candidate > currentVersion;
}

export const REVOCATION_SNAPSHOT_SCHEMA_META: SchemaMeta = {
  id: "vinci.device-auth.revocation-snapshot",
  version: 1,
  compatibility: "additive-only",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
