import { assertSchemaMetaComplete } from "@vinci/contracts";
import { describe, expect, it } from "vitest";
import {
  CUSTOMER_ENDPOINT_SCHEMA_META,
  FALLBACK_RECORD_SCHEMA_META,
  MODEL_PROVENANCE_SCHEMA_META,
  RESIDENCY_RECORD_SCHEMA_META,
  validateCustomerEndpointConfig,
  validateFallbackRecord,
  validateModelProvenanceRecord,
  validateResidencyRecord,
} from "./index.ts";

const known = <T>(value: T) => ({ kind: "known" as const, value });

const capabilityProfile = {
  capabilities: ["text", "tool_use"],
  contextLimit: 128_000,
  toolSupport: true,
};

const actor = { kind: "system", component: "model-gateway" };

const validFallback = () => ({
  schemaVersion: 1,
  runId: "run-1",
  recordedAt: "2026-08-23T12:34:56.789Z",
  recordedBy: actor,
  outcome: "applied",
  source: {
    provider: known("openai"),
    jurisdiction: known({ jurisdiction: "CA", region: "ca-central-1" }),
  },
  destination: {
    provider: "anthropic",
    jurisdiction: { jurisdiction: "US", region: "us-east-1" },
  },
  policyDecision: {
    permitted: true,
    policyId: "policy-1",
    policyVersion: 3,
    reasonCode: "approved_cross_provider_fallback",
  },
});

const validEndpoint = () => ({
  schemaVersion: 1,
  endpointId: "customer-endpoint-1",
  workspace: {
    kind: "personal",
    workspaceId: "workspace-1",
    ownerId: "user-1",
  },
  baseUrl: "https://models.example.ca/v1",
  modelIdentifier: "customer-model-released-yesterday",
  capabilityProfile,
  retentionDeclaration: known("prompts retained for 7 days"),
  jurisdiction: known({ jurisdiction: "CA", region: "ca-central-1" }),
  credentials: {
    source: {
      kind: "managed-credential",
      credentialId: "cred-customer-endpoint-1",
    },
  },
});

const validResolvedProvenance = () => ({
  schemaVersion: 1,
  event: "resolved",
  runId: "run-1",
  recordedAt: "2026-08-23T12:34:56.789Z",
  recordedBy: actor,
  request: { kind: "model-class", modelClass: "forte" },
  reasoningMode: known("standard"),
  capabilityProfile: known(capabilityProfile),
  route: {
    provider: known("openrouter"),
    model: known("vendor/model-introduced-without-a-contract-release"),
    modelVersion: { kind: "unknown" },
    evidence: "gateway-header",
  },
  materialFallback: { kind: "used", record: validFallback() },
});

function expectIssue(
  result:
    | ReturnType<typeof validateCustomerEndpointConfig>
    | ReturnType<typeof validateFallbackRecord>
    | ReturnType<typeof validateModelProvenanceRecord>
    | ReturnType<typeof validateResidencyRecord>,
  path: string,
  code: string,
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.issues).toContainEqual(expect.objectContaining({ path, code }));
  }
}

describe("schema compatibility contracts", () => {
  it("keeps every exported record schema machine-checkable", () => {
    for (const meta of [
      MODEL_PROVENANCE_SCHEMA_META,
      FALLBACK_RECORD_SCHEMA_META,
      CUSTOMER_ENDPOINT_SCHEMA_META,
      RESIDENCY_RECORD_SCHEMA_META,
    ]) {
      expect(() => assertSchemaMetaComplete(meta)).not.toThrow();
      expect(meta.malformedData).toBe("fail-closed");
      expect(meta.unknownFields).toBe("preserve");
    }
  });
});

describe("explicit unknown values", () => {
  it("accepts an explicit unknown but rejects an absent declaration", () => {
    const explicit = validateCustomerEndpointConfig({
      ...validEndpoint(),
      retentionDeclaration: { kind: "unknown" },
    });
    expect(explicit.ok).toBe(true);
    if (explicit.ok) expect(explicit.value.retentionDeclaration.kind).toBe("unknown");

    const { retentionDeclaration: _missing, ...absent } = validEndpoint();
    expectIssue(
      validateCustomerEndpointConfig(absent),
      "/retentionDeclaration",
      "required_field",
    );
  });
});

describe("residency disclosure", () => {
  it("records all four locations independently without inferring a Canadian run", () => {
    const input = {
      schemaVersion: 1,
      runId: "run-1",
      recordedAt: "2026-08-23T12:34:56.789Z",
      recordedBy: actor,
      accountDataLocation: known({ jurisdiction: "CA", region: "ca-central-1" }),
      projectContentLocation: known({ jurisdiction: "DE", region: "eu-central-1" }),
      inferenceLocation: known({ jurisdiction: "US", region: "us-west-2" }),
      verificationLocation: { kind: "unknown" },
    };
    const result = validateResidencyRecord(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.accountDataLocation).toEqual(input.accountDataLocation);
      expect(result.value.projectContentLocation).toEqual(input.projectContentLocation);
      expect(result.value.inferenceLocation).toEqual(input.inferenceLocation);
      expect(result.value.verificationLocation).toEqual({ kind: "unknown" });
    }
  });

  it("rejects an omitted location instead of inferring it", () => {
    expectIssue(
      validateResidencyRecord({
        schemaVersion: 1,
        runId: "run-1",
        recordedAt: "2026-08-23T12:34:56.789Z",
        recordedBy: actor,
        accountDataLocation: { kind: "unknown" },
        projectContentLocation: { kind: "unknown" },
        inferenceLocation: { kind: "unknown" },
      }),
      "/verificationLocation",
      "required_field",
    );
  });
});

describe("policy-controlled material fallback", () => {
  it("rejects a fallback without its destination jurisdiction and policy decision", () => {
    const fallback = validFallback();
    const { jurisdiction: _jurisdiction, ...destination } = fallback.destination;
    const { policyDecision: _policy, ...withoutPolicy } = fallback;
    const input = { ...withoutPolicy, destination };
    const result = validateFallbackRecord(input);

    expectIssue(result, "/destination/jurisdiction", "required_field");
    expectIssue(result, "/policyDecision", "required_field");
  });

  it("rejects an applied fallback that policy did not permit", () => {
    expectIssue(
      validateFallbackRecord({
        ...validFallback(),
        policyDecision: { ...validFallback().policyDecision, permitted: false },
      }),
      "/policyDecision/permitted",
      "policy_decision_conflict",
    );
  });
});

describe("customer endpoint authentication", () => {
  it("rejects a secret-like field in the authentication source", () => {
    const result = validateCustomerEndpointConfig({
      ...validEndpoint(),
      credentials: {
        source: {
          kind: "managed-credential",
          credentialId: "cred-customer-endpoint-1",
          apiKey: "sk-must-never-enter-this-record",
        },
      },
    });

    expectIssue(result, "/credentials/source/apiKey", "credential_material_forbidden");
  });

  it("rejects every unknown field under credentials, even with an innocuous name", () => {
    const result = validateCustomerEndpointConfig({
      ...validEndpoint(),
      credentials: { ...validEndpoint().credentials, futureMetadata: "do not preserve here" },
    });

    expectIssue(result, "/credentials/futureMetadata", "credential_material_forbidden");
  });

  it("rejects fields from the other workspace union arm", () => {
    expectIssue(
      validateCustomerEndpointConfig({
        ...validEndpoint(),
        workspace: { ...validEndpoint().workspace, organizationId: "organization-1" },
      }),
      "/workspace/organizationId",
      "unexpected_field",
    );
  });
});

describe("fail-closed validation and preservation", () => {
  it("reports a stable code and exact path for malformed nested input", () => {
    expectIssue(
      validateCustomerEndpointConfig({
        ...validEndpoint(),
        capabilityProfile: { ...capabilityProfile, contextLimit: "128000" },
      }),
      "/capabilityProfile/contextLimit",
      "invalid_integer",
    );
  });

  it("preserves a normal unknown field with the original value identity", () => {
    const futureValue = { nested: [1, "two", { three: true }] };
    const input = { ...validEndpoint(), futureEndpointProperty: futureValue };
    const result = validateCustomerEndpointConfig(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Unknown field VALUES round-trip; their references deliberately do not.
      // Normalization is deep, so a validated record shares no object with the
      // input it validated. Retaining the caller's nested reference is what
      // let a validated record change meaning after validation.
      expect(result.unknownFields["/futureEndpointProperty"]).toEqual(futureValue);
      expect(result.unknownFields["/futureEndpointProperty"]).not.toBe(futureValue);
      expect((result.value as typeof input).futureEndpointProperty).toEqual(futureValue);

      // But the validated record is NOT the caller's object. This previously
      // asserted `toBe(input)`, i.e. that validation handed back the very
      // object it was given — which leaves the caller holding a mutable
      // reference to a "validated" record. That is the same defect class as a
      // credential sharing its scopes array with the input it validated.
      expect(result.value).not.toBe(input);
      expect(result.value).toEqual(input);
    }
  });
});

describe("model provenance", () => {
  it("validates selected and drift records as distinct event variants", () => {
    const common = {
      schemaVersion: 1,
      runId: "run-1",
      recordedAt: "2026-08-23T12:34:56.789Z",
      recordedBy: actor,
      request: {
        kind: "model",
        requestedModel: { provider: "anthropic", model: "just-released-model" },
      },
      reasoningMode: { kind: "unknown" },
      capabilityProfile: { kind: "unknown" },
      materialFallback: { kind: "not-used" },
    };
    const selected = validateModelProvenanceRecord({ ...common, event: "selected" });
    const route = validResolvedProvenance().route;
    const drift = validateModelProvenanceRecord({
      ...common,
      event: "drift",
      previousRoute: route,
      observedRoute: { ...route, model: known("another-unconstrained-model-id") },
    });

    expect(selected.ok).toBe(true);
    expect(drift.ok).toBe(true);
    if (drift.ok && drift.value.event === "drift") {
      expect(drift.value.observedRoute.model).toEqual(known("another-unconstrained-model-id"));
    }
  });

  it("fails closed when fields from a different event arm are present", () => {
    expectIssue(
      validateModelProvenanceRecord({
        ...validResolvedProvenance(),
        event: "selected",
      }),
      "/route",
      "unexpected_field",
    );
  });

  it("fails closed when both request union arms are supplied", () => {
    expectIssue(
      validateModelProvenanceRecord({
        ...validResolvedProvenance(),
        request: {
          ...validResolvedProvenance().request,
          requestedModel: { provider: "openai", model: "should-not-be-here" },
        },
      }),
      "/request/requestedModel",
      "unexpected_field",
    );
  });

  it("records the resolved provider and accepts unconstrained model identifiers", () => {
    const input = validResolvedProvenance();
    const result = validateModelProvenanceRecord(input);

    expect(result.ok).toBe(true);
    if (result.ok && result.value.event === "resolved") {
      expect(result.value.route.provider).toEqual(known("openrouter"));
      expect(result.value.route.model).toEqual(
        known("vendor/model-introduced-without-a-contract-release"),
      );
      expect(result.value.materialFallback.kind).toBe("used");
    }
  });

  it("rejects an absent resolved provider while accepting explicit unknown", () => {
    const explicit = validateModelProvenanceRecord({
      ...validResolvedProvenance(),
      route: { ...validResolvedProvenance().route, provider: { kind: "unknown" } },
    });
    expect(explicit.ok).toBe(true);

    const { provider: _provider, ...route } = validResolvedProvenance().route;
    expectIssue(
      validateModelProvenanceRecord({ ...validResolvedProvenance(), route }),
      "/route/provider",
      "required_field",
    );
  });
});

describe("branded identifiers use the constructor rule in model-class records", () => {
  const residency = (runId: string) => ({
    schemaVersion: 1,
    runId,
    recordedAt: "2026-08-23T12:34:56.789Z",
    recordedBy: actor,
    accountDataLocation: { kind: "unknown" },
    projectContentLocation: { kind: "unknown" },
    inferenceLocation: { kind: "unknown" },
    verificationLocation: { kind: "unknown" },
  });

  const endpointWithWorkspace = (workspace: Record<string, unknown>) => ({
    ...validEndpoint(),
    workspace,
  });

  it.each([
    {
      field: "Actor.userId",
      path: "/recordedBy/userId",
      validate: validateFallbackRecord,
      bad: { ...validFallback(), recordedBy: { kind: "user", userId: "has space" } },
      good: { ...validFallback(), recordedBy: { kind: "user", userId: "user-1" } },
    },
    {
      field: "Actor.deviceId",
      path: "/recordedBy/deviceId",
      validate: validateFallbackRecord,
      bad: { ...validFallback(), recordedBy: { kind: "user", userId: "user-1", deviceId: "a/b" } },
      good: { ...validFallback(), recordedBy: { kind: "user", userId: "user-1", deviceId: "device-1" } },
    },
    {
      field: "Actor.workerId",
      path: "/recordedBy/workerId",
      validate: validateFallbackRecord,
      bad: { ...validFallback(), recordedBy: { kind: "worker", workerId: "café" } },
      good: { ...validFallback(), recordedBy: { kind: "worker", workerId: "worker-1" } },
    },
    {
      field: "Actor.policyId",
      path: "/recordedBy/policyId",
      validate: validateFallbackRecord,
      bad: { ...validFallback(), recordedBy: { kind: "policy", policyId: "-leading", policyVersion: 1 } },
      good: { ...validFallback(), recordedBy: { kind: "policy", policyId: "policy-1", policyVersion: 1 } },
    },
    {
      field: "FallbackRecord.runId",
      path: "/runId",
      validate: validateFallbackRecord,
      bad: { ...validFallback(), runId: "_under" },
      good: { ...validFallback(), runId: "run-1" },
    },
    {
      field: "ModelProvenanceRecord.runId",
      path: "/runId",
      validate: validateModelProvenanceRecord,
      bad: { ...validResolvedProvenance(), runId: "x".repeat(200) },
      good: { ...validResolvedProvenance(), runId: "run-1" },
    },
    {
      field: "WorkspaceRef.workspaceId",
      path: "/workspace/workspaceId",
      validate: validateCustomerEndpointConfig,
      bad: endpointWithWorkspace({ kind: "personal", workspaceId: "has space", ownerId: "user-1" }),
      good: endpointWithWorkspace({ kind: "personal", workspaceId: "workspace-1", ownerId: "user-1" }),
    },
    {
      field: "WorkspaceRef.ownerId",
      path: "/workspace/ownerId",
      validate: validateCustomerEndpointConfig,
      bad: endpointWithWorkspace({ kind: "personal", workspaceId: "workspace-1", ownerId: "a/b" }),
      good: endpointWithWorkspace({ kind: "personal", workspaceId: "workspace-1", ownerId: "user-1" }),
    },
    {
      field: "WorkspaceRef.organizationId",
      path: "/workspace/organizationId",
      validate: validateCustomerEndpointConfig,
      bad: endpointWithWorkspace({ kind: "organization", workspaceId: "workspace-1", organizationId: "café" }),
      good: endpointWithWorkspace({ kind: "organization", workspaceId: "workspace-1", organizationId: "organization-1" }),
    },
    {
      field: "ResidencyRecord.runId",
      path: "/runId",
      validate: validateResidencyRecord,
      bad: residency("-leading"),
      good: residency("run-1"),
    },
  ])("enforces the branded constructor rule for $field", ({ path, validate, bad, good }) => {
    const rejected = validate(bad);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) {
      expect(rejected.issues).toContainEqual(expect.objectContaining({ path, code: "invalid_identifier" }));
    }
    expect(validate(good).ok).toBe(true);
  });
});
