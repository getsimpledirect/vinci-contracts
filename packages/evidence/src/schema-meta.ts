import type { SchemaMeta } from "@vinci/contracts";

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
