import type { SchemaMeta } from "./schema-meta.ts";

/**
 * The state vocabularies are themselves a schema: they are persisted in
 * receipts, sent over the event stream, and stored in databases with CHECK
 * constraints. So they answer the same six questions every other schema does.
 */
export const STATES_SCHEMA_META: SchemaMeta = {
  id: "vinci.states",
  version: 1,
  /**
   * Additive-only. New run states and new terminal states may be added; none
   * may be removed or renamed within version 1.
   *
   * This matches the freeze `vinci-acceptance` already operates under
   * (docs/adr/0007-contracts-v1-freeze.md: additive-only after tag
   * contracts-v1 — new optional fields and new enum values, never renames,
   * removals, or semantic changes). Adopting a different policy here would put
   * the two repositories on incompatible release rules.
   */
  compatibility: "additive-only",
  /**
   * A state is a single string, so "unknown field" here means an unrecognised
   * *member*. It is rejected rather than preserved: the guards return false and
   * callers fail closed.
   *
   * This is the FR-6.4 exception in D4. Preserving an unrecognised state would
   * let it reach a display layer, and the one thing a display layer must never
   * do is render an unknown state as a pass. Note this is the opposite choice
   * from the event and receipt envelopes, which preserve unknown fields so an
   * append-only log survives a round trip through an older consumer.
   */
  unknownFields: "reject",
  malformedData: "fail-closed",
  migration: "none",
};
