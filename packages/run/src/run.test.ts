import { assertSchemaMetaComplete, type ValidationResult } from "@getsimpledirect/vinci-contracts";
import {
  matchEndpointToRole,
  type ModelEndpointSpec,
  type ModelRoleSpec,
} from "@getsimpledirect/vinci-model-classes";
import { validateRunEvent, type RunEvent } from "@getsimpledirect/vinci-run-events";
import { describe, expect, it } from "vitest";
import {
  AGENT_SCHEMA_META,
  CONTEXT_MANIFEST_SCHEMA_META,
  ENVIRONMENT_SCHEMA_META,
  HARNESS_ATTESTATION_SCHEMA_META,
  HUMAN_CORRECTION_SCHEMA_META,
  RUN_SCHEMA_META,
  agentDigest,
  attestedHarnessCapabilities,
  contextManifestDigest,
  environmentDigest,
  harnessAttestationDigest,
  humanCorrectionDigest,
  projectRunState,
  runDigest,
  terminalEvidenceMissing,
  validateAgent,
  validateContextManifest,
  validateEnvironment,
  validateHarnessAttestation,
  validateHumanCorrection,
  validateRun,
  type ContextManifest,
  type HarnessAttestation,
  type HumanCorrection,
  type VinciAgent,
  type VinciEnvironment,
  type VinciRun,
} from "./index.ts";

// ---------------------------------------------------------------------------
// Fixtures. Every "valid" fixture is asserted valid by a positive test below,
// so a negative test that mutates one field cannot pass because the fixture
// was already broken for an unrelated reason (same-signal earlier guard).
// ---------------------------------------------------------------------------

const DIGEST = "ab".repeat(32);
const OTHER_DIGEST = "cd".repeat(32);
const AT = "2026-08-23T00:00:00.000Z";
const LATER = "2026-08-24T00:00:00.000Z";
const NOW = "2026-08-23T12:00:00.000Z";
const worker = { kind: "worker", workerId: "w-1" } as const;
const user = { kind: "user", userId: "u-1" } as const;

const agent = (): Record<string, unknown> => ({
  schemaVersion: 1,
  agentId: "agent-1",
  version: 1,
  modelClass: "repository-agent",
  systemPolicyRef: "policy://system/v1",
  skills: [{ id: "skill-1", digest: DIGEST }],
  requiredCapabilities: [
    { id: "repository_editing", version: 1 },
    { id: "structured_tool_use", version: 1 },
  ],
  allowedToolCategories: ["repository", "github_read"],
  permissionPolicyRef: "policy://permissions/v1",
  autonomy: [{ capabilityId: "repository_editing", level: 3 }],
});

const environment = (): Record<string, unknown> => ({
  schemaVersion: 1,
  environmentId: "env-1",
  placement: "vinci_cloud",
  imageDigest: DIGEST,
  runtimeBuild: "worker@1.2.3",
  networkPolicy: { default: "deny", allowedCategories: ["model_provider", "github"] },
  filesystem: { base: "ephemeral", mounts: ["repository_cache_readonly", "workspace"] },
  resourceLimits: { cpu: 4, memoryMb: 8192, diskMb: 20480, wallSeconds: 3600 },
  secretPolicy: { source: "platform_vault", delivery: "run_scoped" },
});

const run = (): Record<string, unknown> => ({
  schemaVersion: 1,
  runId: "run-1",
  workOrderId: "wo-1",
  workOrderDigest: DIGEST,
  attemptId: "attempt-1",
  agent: { id: "agent-1", version: 1 },
  environment: { id: "env-1", digest: DIGEST },
  sessionId: null,
  contextManifestDigest: null,
  harnessAttestationDigest: null,
  servicePrincipalId: null,
  budget: { maxRuntimeS: 3600, maxToolCalls: 200 },
  requiredTerminal: "MERGED",
  state: "CREATED",
  createdAt: AT,
  startedAt: null,
  lastEventAt: null,
});

const manifest = (): Record<string, unknown> => ({
  schemaVersion: 1,
  runId: "run-1",
  entries: [
    { section: "stable_prefix", ref: "policy://system/v1", digest: DIGEST, trust: "ratified" },
    { section: "dynamic", ref: "web://example", digest: OTHER_DIGEST, trust: "externally_sourced" },
  ],
  excluded: [{ ref: "history://other-program", reason: "unrelated_program_history" }],
});

// A well-formed pin: two git object ids, 40 lowercase hex each. `COMMIT_ID` is
// what production already announces as `worker_build`; `TREE_ID` is what
// `git write-tree` produced over the tree as observed, and an auditor holding
// the repository recomputes `git rev-parse <COMMIT_ID>^{tree}` to check it.
const COMMIT_ID = "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d";
const TREE_ID = "f9e8d7c6b5a4938271605f4e3d2c1b0a99887766";
const pin = () => ({ commitId: COMMIT_ID, treeId: TREE_ID });

const attestation = (): Record<string, unknown> => ({
  schemaVersion: 2,
  attestationId: "att-1",
  runtimeBuild: "worker@1.2.3",
  environmentDigest: DIGEST,
  workerPrincipalId: "principal-1",
  capabilities: [
    {
      id: "repository_editing",
      version: 1,
      status: "PASS",
      selfTestDigest: DIGEST,
      observedEntrypoint: "installed_package",
    },
  ],
  createdAt: AT,
  expiresAt: LATER,
  issuedBy: worker,
});

const correction = (): Record<string, unknown> => ({
  schemaVersion: 1,
  correctionId: "corr-1",
  runId: "run-1",
  eventSequence: 7,
  modelId: "claude-fable-5-1",
  runtimeBuild: "worker@1.2.3",
  contextManifestDigest: DIGEST,
  correctionType: "scope_creep",
  correctedOutcomeDigest: OTHER_DIGEST,
  correctedBy: user,
  recordedAt: AT,
});

function mustBeValid<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new Error(`fixture invalid: ${JSON.stringify(result.issues)}`);
  return result.value;
}

function codesOf<T>(result: ValidationResult<T>): string[] {
  if (result.ok) return [];
  return result.issues.map((i) => i.code);
}

let sequence = 0;
function event(type: string, payload: Record<string, unknown>): RunEvent {
  sequence += 1;
  const result = validateRunEvent({
    schemaVersion: 4,
    eventId: `evt-${sequence}`,
    runId: "run-1",
    organizationId: null,
    workspaceId: "workspace-1",
    sequence,
    type,
    actor: worker,
    occurredAt: AT,
    idempotencyKey: `key-${sequence}`,
    traceId: "trace-1",
    payload,
  });
  if (!result.ok) throw new Error(`event fixture invalid (${type}): ${JSON.stringify(result.issues)}`);
  return result.value;
}
const id = (value: string) => ({ kind: "id", value });
const count = (value: number) => ({ kind: "count", value });
const digest = (value: string) => ({ kind: "digest", value });
const enumValue = (value: string) => ({ kind: "enum", value });

const created = () => event("run.created", { workspaceId: id("workspace-1"), policyId: id("policy-1"), policyVersion: count(1) });
const started = () => event("run.started", { workerId: id("w-1") });
const paused = () => event("run.paused", { requestedBy: id("u-1") });
const resumed = () => event("run.resumed", { resumedFromSequence: count(2) });
const completed = () =>
  event("run.completed", {
    terminalState: enumValue("DONE"),
    humanAttentionSeconds: count(0),
    humanDecisions: count(0),
    humanInterruptions: count(0),
    escalations: count(0),
  });
const turnStarted = () => event("agent.turn_started", { turnId: id("turn-1") });
const artifactCreated = (artifactId: string) =>
  event("artifact.created", { artifactId: id(artifactId), artifactDigest: digest(DIGEST) });
const artifactPersisted = (artifactId: string) =>
  event("artifact.persisted", { artifactId: id(artifactId), contentDigest: digest(DIGEST), kind: enumValue("report") });

// A role that REQUIRES a harness capability, and an endpoint that would be
// eligible for it if the harness were attested. Mirrors the model-classes
// fixtures so the matcher's own preconditions are all satisfied and the ONLY
// thing deciding the verdict is the attested list.
const known = <T>(value: T) => ({ kind: "known" as const, value });
const roleRequiringRepositoryEditing = {
  schemaVersion: 1,
  roleId: "repository-agent",
  taskClass: "repository-edit",
  requiredCapabilities: ["structured_tool_use"],
  requiredHarnessCapabilities: ["repository_editing"],
  minimumContextTokens: 64_000,
  riskClass: "medium",
  dataPolicy: { externalProviderAllowed: true, outputRetentionAllowed: false, processesProtectedData: false },
  qualityPolicy: { minimumVerifiedSuccessRate: 0.9, maximumFalseClaimRate: 0.02 },
  economicPolicy: { maximumCostPerVerifiedSuccessUsd: 3.5, maximumP95WallSeconds: 120 },
  fallbackRoleIds: [],
} as unknown as ModelRoleSpec;
const endpoint = {
  schemaVersion: 1,
  endpointId: "endpoint-1",
  capabilityProfile: { capabilities: ["text", "tool_use"], contextLimit: 128_000, toolSupport: true },
  declaredCapabilities: ["structured_tool_use"],
  credentials: { source: { kind: "managed-credential", credentialId: "credential-1" } },
  inferenceIsExternal: known(true),
  approvedForProtectedData: known(true),
  rights: {
    trainingAllowed: known(true),
    evaluationAllowed: known(true),
    redistributionAllowed: known(false),
    outputRetainedByProvider: known(false),
    policySnapshotDigest: known("policy-snapshot-1"),
  },
  validFrom: "2026-08-01T00:00:00.000Z",
  expiresAt: "2027-08-01T00:00:00.000Z",
  sourceClass: "frontier_api",
  serving: {
    kind: "third_party_api",
    provider: "openai",
    model: "supplier-model-current",
    modelRevision: known("2026-08-01"),
    jurisdiction: known({ jurisdiction: "CA", region: "ca-central-1" }),
  },
  servedArtifact: known({ kind: "proprietary" }),
} as unknown as ModelEndpointSpec;

// ---------------------------------------------------------------------------

describe("schema meta", () => {
  it("every exported meta answers all six questions and is frozen/reject/fail-closed", () => {
    for (const meta of [
      AGENT_SCHEMA_META,
      ENVIRONMENT_SCHEMA_META,
      RUN_SCHEMA_META,
      CONTEXT_MANIFEST_SCHEMA_META,
      HARNESS_ATTESTATION_SCHEMA_META,
      HUMAN_CORRECTION_SCHEMA_META,
    ]) {
      expect(() => assertSchemaMetaComplete(meta)).not.toThrow();
      expect(meta.compatibility).toBe("frozen");
      expect(meta.unknownFields).toBe("reject");
      expect(meta.malformedData).toBe("fail-closed");
    }
    // Version and migration are checked as a PAIR, not as a constant. Five of
    // these are still v1 with nothing to migrate from; the attestation is v2
    // because the entrypoint vocabulary changed under a frozen policy, and
    // `assertSchemaMetaComplete` already refuses `migration: "none"` above v1 —
    // so the assertion below is what stops a future bump from carrying a
    // migration string that says nothing, and what stops v1 from acquiring a
    // migration it does not need.
    for (const meta of [
      AGENT_SCHEMA_META,
      ENVIRONMENT_SCHEMA_META,
      RUN_SCHEMA_META,
      CONTEXT_MANIFEST_SCHEMA_META,
      HUMAN_CORRECTION_SCHEMA_META,
    ]) {
      expect(meta.version).toBe(1);
      expect(meta.migration).toBe("none");
    }
    expect(HARNESS_ATTESTATION_SCHEMA_META.version).toBe(2);
    expect(HARNESS_ATTESTATION_SCHEMA_META.migration).not.toBe("none");
    // The migration states what happens to a v1 record rather than merely
    // being non-empty: refusal, and why the record cannot be up-converted.
    expect(HARNESS_ATTESTATION_SCHEMA_META.migration).toContain("refuses a v1 record on schemaVersion");
    expect(

      [
        AGENT_SCHEMA_META, ENVIRONMENT_SCHEMA_META, RUN_SCHEMA_META,
        CONTEXT_MANIFEST_SCHEMA_META, HARNESS_ATTESTATION_SCHEMA_META, HUMAN_CORRECTION_SCHEMA_META,
      ].map((m) => m.id),
    ).toEqual([
      "vinci.agent", "vinci.environment", "vinci.run",
      "vinci.context-manifest", "vinci.harness-attestation", "vinci.human-correction",
    ]);
  });
});

describe("unknown fields are rejected on every schema (unknown_field)", () => {
  const cases: ReadonlyArray<[string, () => Record<string, unknown>, (input: unknown) => ValidationResult<unknown>]> = [
    ["agent", agent, validateAgent],
    ["environment", environment, validateEnvironment],
    ["run", run, validateRun],
    ["context manifest", manifest, validateContextManifest],
    ["harness attestation", attestation, validateHarnessAttestation],
    ["human correction", correction, validateHumanCorrection],
  ];
  for (const [name, fixture, validate] of cases) {
    it(`${name}: the fixture is valid (positive control) and one extra top-level field is unknown_field`, () => {
      const valid = validate(fixture());
      expect(valid.ok).toBe(true);
      const withExtra = validate({ ...fixture(), smuggled: "x" });
      expect(withExtra.ok).toBe(false);
      expect(codesOf(withExtra)).toEqual(["unknown_field"]);
      if (!withExtra.ok) expect(withExtra.issues[0]?.path).toBe("/smuggled");
    });
  }

  it("nested unknown fields are rejected too (agent skill, environment secretPolicy, run budget, attestation capability)", () => {
    const a = validateAgent({ ...agent(), skills: [{ id: "skill-1", digest: DIGEST, prompt: "x" }] });
    expect(codesOf(a)).toEqual(["unknown_field"]);
    const e = validateEnvironment({
      ...environment(),
      secretPolicy: { source: "platform_vault", delivery: "run_scoped", plaintext: "x" },
    });
    expect(codesOf(e)).toEqual(["unknown_field"]);
    const r = validateRun({ ...run(), budget: { maxRuntimeS: 1, maxDollars: 5 } });
    expect(codesOf(r)).toEqual(["unknown_field"]);
    const att = attestation();
    const capability = { ...(att.capabilities as Record<string, unknown>[])[0], notes: "x" };
    const h = validateHarnessAttestation({ ...att, capabilities: [capability] });
    expect(codesOf(h)).toEqual(["unknown_field"]);
  });
});

describe("closed sets and fail-closed scalars", () => {
  it("agent: a required capability outside HARNESS_CAPABILITIES ∪ ENDPOINT_CAPABILITIES is unknown_capability", () => {
    const result = validateAgent({ ...agent(), requiredCapabilities: [{ id: "teleport", version: 1 }] });
    expect(codesOf(result)).toEqual(["unknown_capability"]);
  });
  it("agent: autonomy level 9 is invalid_autonomy_level, level 8 is accepted", () => {
    expect(codesOf(validateAgent({ ...agent(), autonomy: [{ capabilityId: "x", level: 9 }] }))).toEqual([
      "invalid_autonomy_level",
    ]);
    expect(validateAgent({ ...agent(), autonomy: [{ capabilityId: "x", level: 8 }] }).ok).toBe(true);
  });
  it("environment: secretPolicy.source must be platform_vault or none", () => {
    expect(codesOf(validateEnvironment({ ...environment(), secretPolicy: { source: "env_file", delivery: "run_scoped" } }))).toEqual([
      "unknown_secret_source",
    ]);
    expect(validateEnvironment({ ...environment(), secretPolicy: { source: "none", delivery: "run_scoped" } }).ok).toBe(true);
    expect(codesOf(validateEnvironment({ ...environment(), secretPolicy: { delivery: "run_scoped" } }))).toEqual([
      "unknown_secret_source",
    ]);
  });
  it("environment: a negative resource limit is invalid_resource_limit", () => {
    const result = validateEnvironment({
      ...environment(),
      resourceLimits: { cpu: -1, memoryMb: 1, diskMb: 1, wallSeconds: 1 },
    });
    expect(codesOf(result)).toEqual(["invalid_resource_limit"]);
  });
  it("run: a budget limit that is not a non-negative integer is invalid_budget_limit; an empty budget is legal", () => {
    expect(codesOf(validateRun({ ...run(), budget: { maxToolCalls: 1.5 } }))).toEqual(["invalid_budget_limit"]);
    expect(validateRun({ ...run(), budget: {} }).ok).toBe(true);
  });
  it("run: unknown requiredTerminal / state are refused, nullable refs accept null and a digest but not prose", () => {
    expect(codesOf(validateRun({ ...run(), requiredTerminal: "SHIPPED" }))).toEqual(["unknown_required_terminal"]);
    expect(codesOf(validateRun({ ...run(), state: "DONE" }))).toEqual(["unknown_run_state"]);
    expect(validateRun({ ...run(), contextManifestDigest: DIGEST }).ok).toBe(true);
    expect(codesOf(validateRun({ ...run(), contextManifestDigest: "latest" }))).toEqual(["invalid_digest"]);
  });
  it("harness attestation: expiresAt must be strictly after createdAt; issuedBy must be a consistent actor", () => {
    expect(codesOf(validateHarnessAttestation({ ...attestation(), expiresAt: AT }))).toEqual(["expiry_not_after_creation"]);
    expect(
      codesOf(validateHarnessAttestation({ ...attestation(), issuedBy: { kind: "worker", workerId: "w-1", independent: true } })),
    ).toEqual(["invalid_actor"]);
  });
  it("harness attestation: observedEntrypoint is the v2 identity vocabulary, and the v1 words are gone", () => {
    const withEntrypoint = (observedEntrypoint: unknown, extra: Record<string, unknown> = {}) =>
      validateHarnessAttestation({
        ...attestation(),
        capabilities: [
          {
            id: "repository_editing", version: 1, status: "PASS", selfTestDigest: DIGEST,
            observedEntrypoint, ...extra,
          },
        ],
      });
    // Positive control: all three v2 members are accepted through this exact
    // entry point, so the refusals below are the vocabulary answering rather
    // than the fixture being broken for an unrelated reason.
    expect(withEntrypoint("installed_package").ok).toBe(true);
    expect(withEntrypoint("pinned_checkout", { checkoutPin: pin() }).ok).toBe(true);
    expect(withEntrypoint("working_tree").ok).toBe(true);
    // The v1 words are not silently tolerated: a v1 producer is refused at the
    // vocabulary as well as at schemaVersion.
    expect(codesOf(withEntrypoint("installed_worker"))).toEqual(["unknown_entrypoint"]);
    expect(codesOf(withEntrypoint("source_checkout"))).toEqual(["unknown_entrypoint"]);
    expect(codesOf(withEntrypoint(""))).toEqual(["unknown_entrypoint"]);
  });
  it("harness attestation: a v1 record is refused on schemaVersion rather than up-converted", () => {
    // The migration this bump declares, executed. The v1 record below is
    // otherwise the shape v1 accepted, so the ONLY thing refusing it is the
    // version — and nothing in the result resembles an up-conversion.
    const v1 = {
      ...attestation(),
      schemaVersion: 1,
      capabilities: [
        { id: "repository_editing", version: 1, status: "PASS", selfTestDigest: DIGEST, observedEntrypoint: "installed_worker" },
      ],
    };
    expect(codesOf(validateHarnessAttestation(v1)).sort()).toEqual(["invalid_schema_version", "unknown_entrypoint"]);
    expect(codesOf(validateHarnessAttestation({ ...attestation(), schemaVersion: 1 }))).toEqual([
      "invalid_schema_version",
    ]);
  });
  it("harness attestation: a pinned_checkout without well-formed pin evidence is INVALID", () => {
    const pinned = (checkoutPin: unknown, present = true) =>
      validateHarnessAttestation({
        ...attestation(),
        capabilities: [
          {
            id: "repository_editing", version: 1, status: "PASS", selfTestDigest: DIGEST,
            observedEntrypoint: "pinned_checkout",
            ...(present ? { checkoutPin } : {}),
          },
        ],
      });
    // Positive control: the same entry WITH the evidence validates.
    expect(pinned(pin()).ok).toBe(true);
    // Absent, null, and non-object all fail as the same missing-evidence code,
    // at the pin's own path.
    expect(codesOf(pinned(undefined, false))).toEqual(["missing_checkout_pin"]);
    expect(codesOf(pinned(null))).toEqual(["missing_checkout_pin"]);
    expect(codesOf(pinned("clean"))).toEqual(["missing_checkout_pin"]);
    expect(codesOf(pinned([COMMIT_ID, TREE_ID]))).toEqual(["missing_checkout_pin"]);
    const missing = pinned(null);
    if (!missing.ok) expect(missing.issues[0]?.path).toBe("/capabilities/0/checkoutPin");
    // Half a pin is not a pin, and each half names its own code.
    expect(codesOf(pinned({ commitId: COMMIT_ID }))).toEqual(["invalid_tree_id"]);
    expect(codesOf(pinned({ treeId: TREE_ID }))).toEqual(["invalid_commit_id"]);
    // A boolean claim is exactly what this field replaced, and it is refused
    // as an unknown field rather than quietly ignored beside a real pin.
    expect(codesOf(pinned({ ...pin(), clean: true }))).toEqual(["unknown_field"]);
    // Ids are 40 lowercase hex: not a 64-hex digest, not uppercase, not prose.
    expect(codesOf(pinned({ commitId: DIGEST, treeId: TREE_ID }))).toEqual(["invalid_commit_id"]);
    expect(codesOf(pinned({ commitId: COMMIT_ID.toUpperCase(), treeId: TREE_ID }))).toEqual(["invalid_commit_id"]);
    expect(codesOf(pinned({ commitId: COMMIT_ID, treeId: "HEAD" }))).toEqual(["invalid_tree_id"]);
    expect(codesOf(pinned({ commitId: COMMIT_ID, treeId: `${TREE_ID}0` }))).toEqual(["invalid_tree_id"]);
    expect(codesOf(pinned({ commitId: 0, treeId: TREE_ID }))).toEqual(["invalid_commit_id"]);
  });
  it("harness attestation: a pin on an entrypoint that has no checkout is refused, not ignored", () => {
    const withPin = (observedEntrypoint: string) =>
      validateHarnessAttestation({
        ...attestation(),
        capabilities: [
          {
            id: "repository_editing", version: 1, status: "PASS", selfTestDigest: DIGEST,
            observedEntrypoint, checkoutPin: pin(),
          },
        ],
      });
    // A working_tree entry carrying a pin reads to a human as pinned and is
    // not; an installed_package has no checkout for a pin to describe.
    expect(codesOf(withPin("working_tree"))).toEqual(["checkout_pin_not_applicable"]);
    expect(codesOf(withPin("installed_package"))).toEqual(["checkout_pin_not_applicable"]);
  });
  it("human correction: correctionType is a closed set and eventSequence starts at 1", () => {
    expect(codesOf(validateHumanCorrection({ ...correction(), correctionType: "typo" }))).toEqual(["unknown_correction_type"]);
    expect(codesOf(validateHumanCorrection({ ...correction(), eventSequence: 0 }))).toEqual(["invalid_sequence"]);
  });
  it("non-objects fail closed on every validator", () => {
    for (const validate of [
      validateAgent, validateEnvironment, validateRun,
      validateContextManifest, validateHarnessAttestation, validateHumanCorrection,
    ]) {
      expect(validate(null).ok).toBe(false);
      expect(validate("x").ok).toBe(false);
      expect(validate([]).ok).toBe(false);
    }
  });
});

describe("context manifest: control plane vs data plane", () => {
  it("stable_prefix + model_inferred is data_plane_in_control_prefix", () => {
    const result = validateContextManifest({
      ...manifest(),
      entries: [{ section: "stable_prefix", ref: "note", digest: DIGEST, trust: "model_inferred" }],
    });
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toEqual(["data_plane_in_control_prefix"]);
    if (!result.ok) expect(result.issues[0]?.path).toBe("/entries/0/trust");
  });
  it("stable_prefix + externally_sourced and + unverified are also refused; the same trusts are legal in a data-plane section", () => {
    for (const trust of ["externally_sourced", "unverified"]) {
      expect(
        codesOf(validateContextManifest({ ...manifest(), entries: [{ section: "stable_prefix", ref: "r", digest: DIGEST, trust }] })),
      ).toEqual(["data_plane_in_control_prefix"]);
      expect(
        validateContextManifest({ ...manifest(), entries: [{ section: "dynamic", ref: "r", digest: DIGEST, trust }] }).ok,
      ).toBe(true);
    }
  });
  it("stable_prefix + authoritative is ok (positive control through the same validator)", () => {
    const result = validateContextManifest({
      ...manifest(),
      entries: [{ section: "stable_prefix", ref: "policy", digest: DIGEST, trust: "authoritative" }],
    });
    expect(result.ok).toBe(true);
  });
  it("trust is REQUIRED on every entry: an entry without it is required_field, not silently trusted", () => {
    const result = validateContextManifest({
      ...manifest(),
      entries: [{ section: "mission", ref: "m", digest: DIGEST }],
    });
    expect(codesOf(result)).toEqual(["required_field"]);
    if (!result.ok) expect(result.issues[0]?.path).toBe("/entries/0/trust");
  });
  it("a ref longer than 512 characters or blank is invalid_ref; an unknown exclusion reason is refused", () => {
    expect(
      codesOf(validateContextManifest({ ...manifest(), entries: [{ section: "files", ref: "x".repeat(513), digest: DIGEST, trust: "unverified" }] })),
    ).toEqual(["invalid_ref"]);
    expect(
      codesOf(validateContextManifest({ ...manifest(), entries: [{ section: "files", ref: "  ", digest: DIGEST, trust: "unverified" }] })),
    ).toEqual(["invalid_ref"]);
    expect(codesOf(validateContextManifest({ ...manifest(), excluded: [{ ref: "r", reason: "too_long" }] }))).toEqual([
      "unknown_exclusion_reason",
    ]);
  });
});

describe("projectRunState", () => {
  it("a legal chain created→started→paused→resumed→completed yields TERMINAL with no issues", () => {
    sequence = 0;
    const events = [created(), started(), paused(), resumed(), completed()];
    expect(projectRunState(events)).toEqual({ state: "TERMINAL", issues: [] });
  });
  it("intermediate states are reached (positive control that the projection moves): started→RUNNING, paused→PAUSED, blocked→BLOCKED, stalled→STALLED", () => {
    sequence = 0;
    expect(projectRunState([]).state).toBe("CREATED");
    expect(projectRunState([created()]).state).toBe("CREATED");
    expect(projectRunState([created(), started()]).state).toBe("RUNNING");
    expect(projectRunState([created(), started(), paused()]).state).toBe("PAUSED");
    expect(projectRunState([created(), started(), event("approval.requested", {
      approvalId: id("ap-1"), actionClass: enumValue("deployment"), riskLevel: enumValue("medium"),
    })]).state).toBe("PAUSED");
    expect(projectRunState([started(), event("run.blocked", { reasonCode: enumValue("awaiting_approval") })]).state).toBe("BLOCKED");
    expect(projectRunState([started(), event("run.stalled", { lastEventAt: { kind: "at", value: AT }, stallWindowS: count(600) })]).state).toBe("STALLED");
    expect(projectRunState([started(), paused(), event("approval.granted", { approvalId: id("ap-1"), narrowed: { kind: "flag", value: false }, humanSeconds: count(5) })]).state).toBe("RUNNING");
    expect(projectRunState([started(), event("run.stalled", { lastEventAt: { kind: "at", value: AT }, stallWindowS: count(600) }), event("run.attempt_started", { attemptId: id("attempt-2"), reason: enumValue("stalled") })]).state).toBe("RUNNING");
    expect(projectRunState([started(), event("run.failed", { reasonCode: enumValue("worker_crashed") })]).state).toBe("TERMINAL");
    expect(projectRunState([started(), event("run.cancelled", { requestedBy: id("u-1"), acknowledged: { kind: "flag", value: true }, cleanupCompleted: { kind: "flag", value: true } })]).state).toBe("TERMINAL");
  });
  it("an agent.turn_started after run.completed is event_after_terminal, and the state stays TERMINAL", () => {
    sequence = 0;
    const events = [created(), started(), completed(), turnStarted()];
    const projected = projectRunState(events);
    expect(projected.state).toBe("TERMINAL");
    expect(projected.issues.map((i) => i.code)).toEqual(["event_after_terminal"]);
    expect(projected.issues[0]?.path).toBe("/events/4");
  });

  /**
   * EVERY post-terminal event, not just the first.
   *
   * The case above uses exactly ONE post-terminal event, so it cannot tell the
   * `continue` in the TERMINAL branch from a `break`: with one anomaly both
   * produce one issue and the same TERMINAL state. Measured: changing that
   * `continue` to `break` survived the whole gate at 1564/1564. The release
   * notes advertise `projectRunState` as "TERMINAL is absorbing and a later
   * event is reported, not folded away" -- with a `break` the FIRST later event
   * is reported and every one after it is dropped silently, which is the same
   * defect one level along.
   *
   * Two anomalies distinguish them, and the assertion is on the SEQUENCE PATHS
   * rather than the count: a projection that reported the same event twice
   * would satisfy a count of two.
   */
  it("reports EVERY post-terminal event: two anomalies yield two issues, at their own sequences", () => {
    sequence = 0;
    const events = [created(), started(), completed(), turnStarted(), paused()];
    const projected = projectRunState(events);
    expect(projected.state).toBe("TERMINAL");
    expect(projected.issues.map((i) => i.code)).toEqual([
      "event_after_terminal",
      "event_after_terminal",
    ]);
    expect(projected.issues.map((i) => i.path)).toEqual(["/events/4", "/events/5"]);
    // The second anomaly is a `run.paused`, whose transition would move a
    // non-terminal run to PAUSED. It is reported and NOT applied, so this also
    // pins that the branch continues to absorb rather than falling through.
    expect(events[4]?.type).toBe("run.paused");
  });

  it("three post-terminal events yield three issues, in log order and none folded away", () => {
    // A second, longer chain: with `break` the tail is dropped whatever its
    // length, so a two-event case could in principle be satisfied by an
    // off-by-one. Three, of three different types, cannot.
    sequence = 0;
    const events = [created(), started(), completed(), turnStarted(), paused(), started()];
    const projected = projectRunState(events);
    expect(projected.state).toBe("TERMINAL");
    expect(projected.issues.map((i) => i.path)).toEqual(["/events/4", "/events/5", "/events/6"]);
    expect(projected.issues.every((i) => i.code === "event_after_terminal")).toBe(true);
    // Positive control through the same function: the identical tail BEFORE a
    // terminal produces no issues at all and does move the state, so the
    // assertions above are about the TERMINAL branch and not about these three
    // event types being rejected everywhere.
    sequence = 0;
    const legal = projectRunState([created(), started(), turnStarted(), paused(), started()]);
    expect(legal.issues).toEqual([]);
    expect(legal.state).toBe("RUNNING");
  });
});

describe("terminalEvidenceMissing", () => {
  it("returns the artifactId that was created but never persisted", () => {
    sequence = 0;
    expect(terminalEvidenceMissing([started(), artifactCreated("art-1")])).toEqual(["art-1"]);
  });
  it("returns [] once the same artifact is persisted, and only the unpersisted one when two were created", () => {
    sequence = 0;
    expect(terminalEvidenceMissing([started(), artifactCreated("art-1"), artifactPersisted("art-1")])).toEqual([]);
    expect(
      terminalEvidenceMissing([started(), artifactCreated("art-1"), artifactCreated("art-2"), artifactPersisted("art-1")]),
    ).toEqual(["art-2"]);
  });
  it("a persisted event for a DIFFERENT artifact does not cover the created one", () => {
    sequence = 0;
    expect(terminalEvidenceMissing([artifactCreated("art-1"), artifactPersisted("art-9")])).toEqual(["art-1"]);
  });
});

describe("attestedHarnessCapabilities", () => {
  const withCapability = (overrides: Record<string, unknown>): HarnessAttestation => {
    const base = attestation();
    const capability = { ...(base.capabilities as Record<string, unknown>[])[0], ...overrides };
    return mustBeValid(validateHarnessAttestation({ ...base, capabilities: [capability] }));
  };

  it("positive: PASS + installed_package + fresh yields [\"repository_editing\"] and makes the matcher eligible", () => {
    const list = attestedHarnessCapabilities(mustBeValid(validateHarnessAttestation(attestation())), NOW);
    expect(list).toEqual(["repository_editing"]);
    const verdict = matchEndpointToRole(roleRequiringRepositoryEditing, endpoint, NOW, list);
    expect(verdict.verdict).toBe("eligible");
    expect(verdict.reasons).toEqual([]);
    // Reachability control for the negatives below: with NO attestation the
    // same role/endpoint pair is unevaluable for exactly the reason the
    // negatives assert, so a negative cannot pass because of an unrelated
    // precondition failing first.
    const unattested = matchEndpointToRole(roleRequiringRepositoryEditing, endpoint, NOW);
    expect(unattested.verdict).toBe("unevaluable");
    expect(unattested.reasons.map((r) => r.code)).toEqual(["harness_capabilities_unverified"]);
  });

  it("positive: PASS + pinned_checkout with valid pin evidence does the same — the case v1 made impossible", () => {
    // This is the shape a production worker actually has: a clean tree at an
    // exact commit under /opt, deployed by fetch + checkout --detach. Under v1
    // it was `source_checkout` and established NOTHING, so every role
    // requiring a harness capability stayed unevaluable forever. Same entry
    // point, same matcher, same role as the installed_package case above.
    const pinned = mustBeValid(
      validateHarnessAttestation({
        ...attestation(),
        capabilities: [
          {
            id: "repository_editing", version: 1, status: "PASS", selfTestDigest: DIGEST,
            observedEntrypoint: "pinned_checkout", checkoutPin: pin(),
          },
        ],
      }),
    );
    const list = attestedHarnessCapabilities(pinned, NOW);
    expect(list).toEqual(["repository_editing"]);
    const verdict = matchEndpointToRole(roleRequiringRepositoryEditing, endpoint, NOW, list);
    expect(verdict.verdict).toBe("eligible");
    expect(verdict.reasons).toEqual([]);
  });

  const negatives: ReadonlyArray<[string, () => HarnessAttestation, string]> = [
    ["status FAIL", () => withCapability({ status: "FAIL" }), NOW],
    ["expired (expiresAt == now)", () => mustBeValid(validateHarnessAttestation(attestation())), LATER],
    ["expired (expiresAt < now)", () => mustBeValid(validateHarnessAttestation(attestation())), "2026-09-01T00:00:00.000Z"],
    // The axis the repair turns on: a working tree is never attestable,
    // however the bytes arrived and whoever put them there.
    ["observed on working_tree", () => withCapability({ observedEntrypoint: "working_tree" }), NOW],
  ];
  for (const [label, build, now] of negatives) {
    it(`negative: ${label} returns [] and the matcher withholds eligibility with harness_capabilities_unverified`, () => {
      const list = attestedHarnessCapabilities(build(), now);
      expect(list).toEqual([]);
      const verdict = matchEndpointToRole(roleRequiringRepositoryEditing, endpoint, NOW, list);
      expect(verdict.verdict).not.toBe("eligible");
      expect(verdict.reasons.map((r) => r.code)).toEqual(["harness_capabilities_unverified"]);
      // The matcher's documented contract: a SUPPLIED list that does not cover
      // the requirement is a definite no, not an absence of evidence.
      expect(verdict.verdict).toBe("ineligible");
    });
  }

  it("a working_tree entry establishes nothing even beside an attestable one", () => {
    // A mixed attestation is the realistic hostile shape: one honest pinned
    // entry and one from whatever tree happened to be lying around. Only the
    // pinned capability survives, so the entrypoint is evaluated PER ENTRY and
    // not once for the record.
    const mixed = mustBeValid(
      validateHarnessAttestation({
        ...attestation(),
        capabilities: [
          {
            id: "repository_editing", version: 1, status: "PASS", selfTestDigest: DIGEST,
            observedEntrypoint: "pinned_checkout", checkoutPin: pin(),
          },
          {
            id: "shell_execution", version: 1, status: "PASS", selfTestDigest: OTHER_DIGEST,
            observedEntrypoint: "working_tree",
          },
        ],
      }),
    );
    expect(attestedHarnessCapabilities(mixed, NOW)).toEqual(["repository_editing"]);
  });

  it("a pinned_checkout missing its pin evidence is INVALID, not merely uncapable", () => {
    // The distinction the issue code exists to make. `attestedHarnessCapabilities`
    // answers [] for both a working_tree entry and an unpinned one, so the
    // empty list alone cannot tell them apart — validation is where the
    // difference is visible, and this asserts it at the validator rather than
    // inferring it from the matcher's silence.
    const unpinned = {
      ...attestation(),
      capabilities: [
        {
          id: "repository_editing", version: 1, status: "PASS", selfTestDigest: DIGEST,
          observedEntrypoint: "pinned_checkout",
        },
      ],
    };
    const result = validateHarnessAttestation(unpinned);
    expect(result.ok).toBe(false);
    expect(codesOf(result)).toEqual(["missing_checkout_pin"]);
    // And it establishes nothing, by the invalid-record path rather than by
    // the entrypoint path — the whole record is refused, so a valid sibling
    // capability in the same record would not survive either.
    expect(attestedHarnessCapabilities(unpinned as unknown as HarnessAttestation, NOW)).toEqual([]);
    const verdict = matchEndpointToRole(roleRequiringRepositoryEditing, endpoint, NOW, []);
    expect(verdict.verdict).toBe("ineligible");
    expect(verdict.reasons.map((r) => r.code)).toEqual(["harness_capabilities_unverified"]);
    // Positive control through the same entry point: adding ONLY the pin makes
    // the identical record valid and capable, so the refusal above is the pin
    // requirement answering and nothing else.
    const pinnedCapability = { ...unpinned.capabilities[0], checkoutPin: pin() };
    const repaired = mustBeValid(validateHarnessAttestation({ ...unpinned, capabilities: [pinnedCapability] }));
    expect(attestedHarnessCapabilities(repaired, NOW)).toEqual(["repository_editing"]);
  });

  it("SKIPPED and an id outside HARNESS_CAPABILITIES contribute nothing; duplicates collapse", () => {
    expect(attestedHarnessCapabilities(withCapability({ status: "SKIPPED" }), NOW)).toEqual([]);
    expect(attestedHarnessCapabilities(withCapability({ id: "structured_tool_use" }), NOW)).toEqual([]);
    expect(attestedHarnessCapabilities(withCapability({ id: "vision" }), NOW)).toEqual([]);
    // A pinned_checkout is not a bypass for the other conditions: the status
    // gate still answers on an attestable entrypoint.
    expect(
      attestedHarnessCapabilities(
        withCapability({ status: "SKIPPED", observedEntrypoint: "pinned_checkout", checkoutPin: pin() }),
        NOW,
      ),
    ).toEqual([]);
  });
  it("an invalid attestation object or a non-canonical `now` yields [] rather than a grant", () => {
    const tampered = { ...attestation(), capabilities: "all" } as unknown as HarnessAttestation;
    expect(attestedHarnessCapabilities(tampered, NOW)).toEqual([]);
    expect(attestedHarnessCapabilities(mustBeValid(validateHarnessAttestation(attestation())), "now")).toEqual([]);
  });
});

describe("digests", () => {
  const cases: ReadonlyArray<[string, () => Record<string, unknown>, (value: never) => string]> = [
    ["agentDigest", agent, agentDigest as (value: never) => string],
    ["environmentDigest", environment, environmentDigest as (value: never) => string],
    ["runDigest", run, runDigest as (value: never) => string],
    ["contextManifestDigest", manifest, contextManifestDigest as (value: never) => string],
    ["harnessAttestationDigest", attestation, harnessAttestationDigest as (value: never) => string],
    ["humanCorrectionDigest", correction, humanCorrectionDigest as (value: never) => string],
  ];
  for (const [name, fixture, digestOf] of cases) {
    it(`${name}: stable for the same input, different for a different input, throws on an invalid input`, () => {
      const first = digestOf(fixture() as never);
      const second = digestOf(fixture() as never);
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      expect(second).toBe(first);
      // Key order must not matter: the digest is over the canonical form.
      const reordered = Object.fromEntries(Object.entries(fixture()).reverse());
      expect(digestOf(reordered as never)).toBe(first);
      // A different object has a different identity (control: the function reads its input).
      const altered = { ...fixture(), schemaVersion: 1, ...( { [Object.keys(fixture())[1] ?? "x"]: "zzz-9" } ) };
      const alteredResult = (() => {
        try { return digestOf(altered as never); } catch { return "threw"; }
      })();
      expect(alteredResult).not.toBe(first);
      expect(() => digestOf({ ...fixture(), smuggled: 1 } as never)).toThrow(/unknown_field/);
      expect(() => digestOf({} as never)).toThrow(/cannot digest an invalid/);
    });
  }

  it("typed values round-trip: a validated value digests identically to its raw input", () => {
    const typedAgent: VinciAgent = mustBeValid(validateAgent(agent()));
    expect(agentDigest(typedAgent)).toBe(agentDigest(agent() as unknown as VinciAgent));
    const typedEnv: VinciEnvironment = mustBeValid(validateEnvironment(environment()));
    expect(environmentDigest(typedEnv)).toBe(environmentDigest(environment() as unknown as VinciEnvironment));
    const typedRun: VinciRun = mustBeValid(validateRun(run()));
    expect(runDigest(typedRun)).toBe(runDigest(run() as unknown as VinciRun));
    const typedManifest: ContextManifest = mustBeValid(validateContextManifest(manifest()));
    expect(contextManifestDigest(typedManifest)).toBe(contextManifestDigest(manifest() as unknown as ContextManifest));
    const typedCorrection: HumanCorrection = mustBeValid(validateHumanCorrection(correction()));
    expect(humanCorrectionDigest(typedCorrection)).toBe(humanCorrectionDigest(correction() as unknown as HumanCorrection));
  });
});
