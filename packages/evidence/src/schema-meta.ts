import type { SchemaMeta } from "@getsimpledirect/vinci-contracts";

/**
 * The schema contract for EvidenceRecord.
 *
 * See docs/E0-decisions.md, D3 and D4 for why every schema carries these six
 * properties: they are persisted in receipts and events, so they must answer
 * the six questions that keep those records stable and round-trippable.
 */
export const EVIDENCE_RECORD_SCHEMA_META: SchemaMeta = {
  id: "vinci.evidence-record",
  version: 1,
  /**
   * Additive-only. New evidence kinds may be added; existing ones may not be
   * renamed or removed within version 1.
   *
   * This preserves the invariant that a record persisted at any point can be
   * read at any later point within the same major version, even if new kinds
   * have been introduced. An older consumer seeing a newer kind will preserve
   * it verbatim (see unknownFields below).
   */
  compatibility: "additive-only",
  /**
   * Unknown fields are preserved verbatim. Events are append-only and replayed
   * (FR-2.3); receipts are exported and re-imported (FR-6.5). If an older
   * consumer drops a newer producer's fields, the log loses data on the round
   * trip. Preserving unknown fields keeps the record intact.
   *
   * The `kind` and `provenance` fields are both union members and are
   * validated, not unknown-and-preserved, so an unrecognised value in either
   * fails closed rather than surviving to a display layer.
   */
  unknownFields: "preserve",
  /**
   * Malformed data fails closed. A record that does not validate is rejected.
   * It is never coerced, defaulted, or partially accepted (FR-4.8, SR-6).
   */
  malformedData: "fail-closed",
  /**
   * No migration required at version 1. This is the first version; there is
   * nothing to migrate from.
   */
  migration: "none",
};

/**
 * VerdictAssessment is an exported, validated schema and had no SchemaMeta at
 * all, which made D3's claim — "a new schema cannot be added without answering
 * all six questions" — false for the one schema most directly concerned with
 * whether something may be called verified.
 */
export const VERDICT_ASSESSMENT_SCHEMA_META: SchemaMeta = {
  id: "vinci.verdict-assessment",
  version: 1,
  compatibility: "additive-only",
  /**
   * Rejected, not preserved. An assessment is the record that decides whether
   * a UI may say "Verified" (FR-6.4), and an unrecognised field on it could
   * carry a stale pass into a reader that does not know to ignore it — the
   * same reason the stale and current arms now refuse each other's fields.
   */
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
