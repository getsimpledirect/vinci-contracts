import { ENDPOINT_CAPABILITIES, HARNESS_CAPABILITIES } from "./role.ts";

/**
 * The capability ABI: a versioned, machine-readable contract of what each
 * capability NAME means, so a producer and a consumer of an attestation can
 * disagree about whether a capability is present without disagreeing about what
 * the capability is.
 *
 * A bare capability name ("durable_events") is a token; two systems can both
 * use it and mean different things. The ABI fixes the meaning and the version
 * of that meaning. An attestation naming a capability effectively references
 * this ABI, and a version bump here is how a meaning change becomes visible
 * rather than silent.
 *
 * Derived from `HARNESS_CAPABILITIES` and `ENDPOINT_CAPABILITIES`, so the id
 * set cannot drift from the vocabulary the rest of this package ships; the
 * `meaning` maps are keyed by the union and TypeScript refuses a missing id.
 */
export type CapabilityAbiDomain = "harness" | "endpoint";

export type CapabilityAbiEntry = {
  readonly id: string;
  readonly version: 1;
  readonly domain: CapabilityAbiDomain;
  readonly meaning: string;
};

const HARNESS_MEANINGS: Readonly<Record<(typeof HARNESS_CAPABILITIES)[number], string>> = {
  repository_editing: "Edit files in the working repository.",
  long_horizon_recovery: "Recover a run across a long horizon (checkpointing, resume).",
  evidence_citation: "Construct and cite evidence of completion.",
  workspace_read: "Read files inside the run's workspace.",
  workspace_write: "Write files inside the run's workspace.",
  shell_execution: "Execute shell commands.",
  code_sandbox: "Run untrusted code in a sandbox.",
  institutional_context: "Read institutional policy and context.",
  web_research: "Access and retrieve web research.",
  file_retrieval: "Retrieve files by reference.",
  skill_loading: "Load and apply skills.",
  context_compaction: "Compact a long-running context.",
  tool_catalog_search: "Search the tool catalogue.",
  mcp_catalog: "Query the MCP server catalogue.",
  mcp_call: "Invoke an MCP tool.",
  github_read: "Read GitHub repositories.",
  github_publish_pr: "Publish a pull request to GitHub.",
  artifact_create: "Create an artifact.",
  artifact_store: "Store an artifact durably.",
  durable_events: "Emit durable run events.",
  steer_interrupt: "Accept a steer to interrupt a run.",
  approval_suspend_resume: "Suspend and resume pending approvals.",
  subagent_spawn: "Spawn a subagent.",
  watcher_wait: "Wait on an external watcher.",
  independent_verification: "Run independent verification.",
  deployment_observation: "Observe deployment results.",
  human_escalation: "Escalate to a human.",
  provider_usage_receipt: "Produce a provider usage receipt.",
  utility_measurement: "Measure the utility of an action.",
};

const ENDPOINT_MEANINGS: Readonly<Record<(typeof ENDPOINT_CAPABILITIES)[number], string>> = {
  structured_tool_use: "The endpoint supports structured tool calling.",
  vision: "The endpoint accepts image input.",
  audio: "The endpoint accepts audio input.",
};

/**
 * Every capability id (harness then endpoint), each with its ABI version and a
 * fixed meaning. Frozen: a meaning change is a version bump, not an edit.
 */
export const HARNESS_CAPABILITY_ABI: readonly CapabilityAbiEntry[] = Object.freeze([
  ...HARNESS_CAPABILITIES.map(
    (id): CapabilityAbiEntry => ({
      id,
      version: 1,
      domain: "harness",
      meaning: HARNESS_MEANINGS[id],
    }),
  ),
  ...ENDPOINT_CAPABILITIES.map(
    (id): CapabilityAbiEntry => ({
      id,
      version: 1,
      domain: "endpoint",
      meaning: ENDPOINT_MEANINGS[id],
    }),
  ),
]);
