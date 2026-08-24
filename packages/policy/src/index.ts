/**
 * @getsimpledirect/vinci-policy — the run-authority policy manifest.
 *
 * This governs what a WORKER may do during a RUN: which paths it may touch,
 * what it may reach on the network, which credentials it may reference, what
 * it may spend, and which actions need a human first.
 *
 * It is NOT device policy. `vinci-work` already has a separate, unrelated
 * desktop-policy subsystem — `DesktopPolicyKey`, `DesktopPolicyDocument`, a
 * `/v1/desktop-policies` API and an editor screen — which governs how a
 * machine is configured, in the MDM sense. Both are legitimate and they do not
 * overlap.
 *
 * Keeping that distinction explicit matters because "policy" reading as either
 * one is how a device setting comes to be believed to constrain a run. See
 * docs/conflict-register.md C13.
 */

export * from "./decision.ts";
export * from "./evaluation.ts";
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
} from "@getsimpledirect/vinci-contracts";
