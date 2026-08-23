export * from "./decision.ts";
export * from "./manifest.ts";
export * from "./schema.ts";

// Re-exporting these avoids a second definition while keeping schema consumers
// on the policy package's public surface.
export {
  assertSchemaMetaComplete,
  fail,
  ok,
  type Actor,
  type PolicyId,
  type SchemaMeta,
  type Timestamp,
  type ValidationResult,
} from "@vinci/contracts";
