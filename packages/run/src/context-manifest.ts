import {
  fail,
  isDigest,
  isIdentifier,
  ok,
  toPlainRecord,
  type RunId,
  type SchemaMeta,
  type ValidationIssue,
  type ValidationResult,
} from "@getsimpledirect/vinci-contracts";
import { digestValidated } from "./digest.ts";
import {
  isEnumMember,
  isObjectRecord,
  isRefText,
  issue,
  rejectUnknownFields,
} from "./lib/validate.ts";

/**
 * The durable inventory of context a run was given.
 *
 * A context manifest is the closed list of what was loaded into a run and
 * where each piece came from. `trust` is required on every entry — an entry
 * with no stated provenance is a piece of context whose reliability is
 * unexamined, which is exactly the kind of thing that should be refused rather
 * than assumed. The stable_prefix section is the mission's control plane: it
 * may only carry context that was ratified or machine-observed, never context
 * the model inferred or that came from an unverified source.
 */
export type ContextManifest = {
  readonly schemaVersion: 1;
  readonly runId: RunId;
  readonly entries: readonly ContextEntry[];
  readonly excluded: readonly ExcludedContext[];
};

export const CONTEXT_SECTIONS = [
  "stable_prefix", "mission", "repository", "institutional_state", "memory", "files", "dynamic",
] as const;
export type ContextSection = (typeof CONTEXT_SECTIONS)[number];

export const CONTEXT_TRUSTS = [
  "authoritative", "ratified", "machine_observed", "externally_sourced", "model_inferred", "unverified", "superseded",
] as const;
export type ContextTrust = (typeof CONTEXT_TRUSTS)[number];

export const EXCLUSION_REASONS = [
  "unrelated_program_history", "rights_restricted", "superseded", "budget",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export type ContextEntry = {
  readonly section: ContextSection;
  readonly ref: string;
  readonly digest: string;
  readonly trust: ContextTrust;
};

export type ExcludedContext = {
  readonly ref: string;
  readonly reason: ExclusionReason;
};

/**
 * Trusts that are not permitted in the control-plane prefix. Context the model
 * inferred or that came from an unverified or external source must not be able
 * to steer the mission's own definition.
 */
const PREFIX_INVALID_TRUSTS = ["externally_sourced", "model_inferred", "unverified"] as const;

/** Validate a context manifest from untrusted input. */
export function validateContextManifest(input: unknown): ValidationResult<ContextManifest> {
  const plain = toPlainRecord(input);
  if (!plain.ok) return plain;
  const record = plain.value;
  const issues: ValidationIssue[] = [];

  rejectUnknownFields(record, ["schemaVersion", "runId", "entries", "excluded"], "", "a context manifest", issues);

  if (record.schemaVersion !== 1) {
    issues.push(issue("/schemaVersion", "invalid_schema_version", "this schema is version 1"));
  }
  if (!isIdentifier(record.runId)) {
    issues.push(issue("/runId", "invalid_id", "runId is an identifier"));
  }

  if (!Array.isArray(record.entries)) {
    issues.push(issue("/entries", "invalid_type", "entries is an array"));
  } else {
    const seenRefs = new Set<string>();
    record.entries.forEach((raw, i) => {
      const path = `/entries/${i}`;
      if (!isObjectRecord(raw)) {
        issues.push(issue(path, "invalid_type", "an entry is an object"));
        return;
      }
      rejectUnknownFields(raw, ["section", "ref", "digest", "trust"], path, "an entry", issues);
      if (!isEnumMember(raw.section, CONTEXT_SECTIONS)) {
        issues.push(issue(`${path}/section`, "unknown_context_section", "section must come from CONTEXT_SECTIONS"));
      }
      if (!isRefText(raw.ref)) {
        issues.push(issue(`${path}/ref`, "invalid_ref", "a ref is non-blank text of at most 512 characters"));
      } else if (seenRefs.has(raw.ref)) {
        issues.push(issue(`${path}/ref`, "duplicate_ref", "a ref is listed twice"));
      } else {
        seenRefs.add(raw.ref);
      }
      if (!isDigest(raw.digest)) {
        issues.push(issue(`${path}/digest`, "invalid_digest", "an entry digest is 64 lowercase hex characters"));
      }
      // trust is REQUIRED: an entry with no stated provenance is refused.
      if (!isEnumMember(raw.trust, CONTEXT_TRUSTS)) {
        issues.push(issue(`${path}/trust`, "required_field", "trust must come from CONTEXT_TRUSTS"));
      } else if (
        raw.section === "stable_prefix"
        && (PREFIX_INVALID_TRUSTS as readonly string[]).includes(raw.trust as string)
      ) {
        issues.push(
          issue(
            `${path}/trust`,
            "data_plane_in_control_prefix",
            `a stable_prefix entry may not carry trust ${String(raw.trust)}; the control plane cannot be steered by data-plane context`,
          ),
        );
      }
    });
  }

  if (!Array.isArray(record.excluded)) {
    issues.push(issue("/excluded", "invalid_type", "excluded is an array"));
  } else {
    record.excluded.forEach((raw, i) => {
      const path = `/excluded/${i}`;
      if (!isObjectRecord(raw)) {
        issues.push(issue(path, "invalid_type", "an excluded entry is an object"));
        return;
      }
      rejectUnknownFields(raw, ["ref", "reason"], path, "an excluded entry", issues);
      if (!isRefText(raw.ref)) {
        issues.push(issue(`${path}/ref`, "invalid_ref", "a ref is non-blank text of at most 512 characters"));
      }
      if (!isEnumMember(raw.reason, EXCLUSION_REASONS)) {
        issues.push(issue(`${path}/reason`, "unknown_exclusion_reason", "reason must come from EXCLUSION_REASONS"));
      }
    });
  }

  if (issues.length > 0) return fail(issues);
  return ok(record as unknown as ContextManifest, {});
}

/** The identity of a context manifest: SHA-256 over the canonical, validated declaration. */
export function contextManifestDigest(manifest: ContextManifest): string {
  return digestValidated("context manifest", validateContextManifest(manifest));
}

export const CONTEXT_MANIFEST_SCHEMA_META: SchemaMeta = {
  id: "vinci.context-manifest",
  version: 1,
  compatibility: "frozen",
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
