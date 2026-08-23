/**
 * The six properties §16 requires of every schema in this repository:
 * version, validation, backward-compatibility policy, migration approach,
 * malformed-data behavior, and unknown-field behavior.
 *
 * They are fields rather than prose because prose rots silently and a field
 * can be asserted by a conformance test. `assertSchemaMetaComplete` is run
 * over every exported schema in the suite, so a new schema cannot be added
 * without answering all six questions.
 *
 * See docs/E0-decisions.md, D3 and D4.
 */

/**
 * How a consumer must react to a field it does not recognise.
 *
 * `preserve` is the default and applies to every append-only or exportable
 * record. Events are replayed (FR-2.3) and receipts are exported and
 * re-imported (FR-6.5); if an older consumer drops a newer producer's fields,
 * the append-only log silently loses data on the round trip.
 *
 * `reject` is reserved for the narrow case where retaining an unrecognised
 * value would let a consumer overstate a guarantee — an unrecognised verdict
 * status must not survive into a display layer that could render it as a pass
 * (FR-6.4).
 */
export type UnknownFieldBehavior = "preserve" | "reject";

/**
 * What happens to a record that does not validate.
 *
 * There is deliberately no `coerce` or `partial` member. FR-4.8 requires that
 * an undeterminable decision does not proceed, and SR-6 forbids silently
 * substituting a weaker guarantee; both rule out repairing a malformed record
 * into a plausible one.
 */
export type MalformedDataBehavior = "fail-closed";

/** How a schema may change without a major version bump. */
export type CompatibilityPolicy =
  /** New optional fields and new union members may be added. Consumers must tolerate both. */
  | "additive-only"
  /** No change is permitted within a major version. Used for digests and signed payloads. */
  | "frozen";

export type SchemaMeta = {
  /** Stable identifier, e.g. `vinci.run-event`. Never reused for a different shape. */
  readonly id: string;
  /**
   * Integer, incremented on any change that is not purely additive. Every
   * record produced by this repository carries its schema version inline, so a
   * consumer never has to infer a version from shape.
   */
  readonly version: number;
  readonly compatibility: CompatibilityPolicy;
  readonly unknownFields: UnknownFieldBehavior;
  readonly malformedData: MalformedDataBehavior;
  /**
   * How records written at earlier versions are read. `"none"` is only valid
   * at version 1, where there is nothing to migrate from; it is rejected by
   * `assertSchemaMetaComplete` at any later version, so bumping a version
   * forces an explicit answer.
   */
  readonly migration: string;
};

/**
 * Throws if a schema has not answered all six questions. Called by the
 * conformance suite over every exported schema, not at runtime on a hot path.
 */
export function assertSchemaMetaComplete(meta: SchemaMeta): void {
  if (!meta.id.trim()) throw new Error("SchemaMeta.id must be non-empty");
  if (!Number.isInteger(meta.version) || meta.version < 1) {
    throw new Error(`SchemaMeta.version must be a positive integer: ${meta.id}`);
  }
  if (!meta.migration.trim()) {
    throw new Error(`SchemaMeta.migration must be stated: ${meta.id}`);
  }
  if (meta.migration === "none" && meta.version !== 1) {
    throw new Error(
      `SchemaMeta.migration "none" is only valid at version 1; ${meta.id} is at version ${meta.version}`,
    );
  }
}
