import { describe, expect, it } from "vitest";
import { STATES_SCHEMA_META } from "./meta.ts";
import { assertSchemaMetaComplete } from "./schema-meta.ts";

describe("STATES_SCHEMA_META", () => {
  it("answers all six questions", () => {
    expect(() => assertSchemaMetaComplete(STATES_SCHEMA_META)).not.toThrow();
  });

  it("rejects unrecognised members rather than preserving them", () => {
    // The FR-6.4 exception in D4: an unknown state must never reach a display
    // layer that could render it as a pass. This is deliberately the opposite
    // of the event/receipt envelopes, which preserve unknown fields.
    expect(STATES_SCHEMA_META.unknownFields).toBe("reject");
  });
});

describe("assertSchemaMetaComplete", () => {
  it("rejects migration \"none\" above version 1", () => {
    // Bumping a version forces an explicit migration answer; a placeholder
    // carried forward from v1 is the failure this catches.
    expect(() =>
      assertSchemaMetaComplete({ ...STATES_SCHEMA_META, version: 2, migration: "none" }),
    ).toThrow(/only valid at version 1/);
  });

  it("rejects an unanswered migration", () => {
    expect(() => assertSchemaMetaComplete({ ...STATES_SCHEMA_META, migration: "  " })).toThrow(
      /migration must be stated/,
    );
  });
});
