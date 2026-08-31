import { assertSchemaMetaComplete } from "@getsimpledirect/vinci-contracts";
import { describe, expect, it } from "vitest";
import {
  CUSTOMER_ENDPOINT_SCHEMA_META,
  FALLBACK_RECORD_SCHEMA_META,
  MODEL_ENDPOINT_SPEC_SCHEMA_META,
  MODEL_PROVENANCE_SCHEMA_META,
  MODEL_ROLE_SPEC_SCHEMA_META,
  RESIDENCY_RECORD_SCHEMA_META,
  matchEndpointToRole,
  validateCustomerEndpointConfig,
  validateModelEndpointSpec,
  validateFallbackRecord,
  validateModelProvenanceRecord,
  validateModelRoleSpec,
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
    | ReturnType<typeof validateModelEndpointSpec>
    | ReturnType<typeof validateFallbackRecord>
    | ReturnType<typeof validateModelProvenanceRecord>
    | ReturnType<typeof validateModelRoleSpec>
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
      MODEL_ROLE_SPEC_SCHEMA_META,
      MODEL_ENDPOINT_SPEC_SCHEMA_META,
    ]) {
      expect(() => assertSchemaMetaComplete(meta)).not.toThrow();
      expect(meta.malformedData).toBe("fail-closed");
      expect(meta.unknownFields).toBe("preserve");
    }
  });
});

const validRole = () => ({
  schemaVersion: 1,
  roleId: "repository-agent",
  taskClass: "repository-edit",
  requiredCapabilities: ["repository_editing", "evidence_citation"],
  minimumContextTokens: 64_000,
  riskClass: "medium",
  dataPolicy: {
    externalProviderAllowed: true,
    outputRetentionAllowed: false,
    processesProtectedData: false,
  },
  qualityPolicy: {
    minimumVerifiedSuccessRate: 0.9,
    maximumFalseClaimRate: 0.02,
  },
  economicPolicy: {
    maximumCostPerVerifiedSuccessUsd: 3.5,
    maximumP95WallSeconds: 120,
  },
  fallbackRoleIds: ["repository-agent-fallback"],
});

const endpointCommon = () => ({
  schemaVersion: 1,
  endpointId: "endpoint-1",
  capabilityProfile: {
    capabilities: ["text", "tool_use"],
    contextLimit: 128_000,
    toolSupport: true,
  },
  declaredCapabilities: ["repository_editing", "evidence_citation"],
  credentials: {
    source: { kind: "managed-credential", credentialId: "credential-1" },
  },
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
});

const validFrontierEndpoint = () => ({
  ...endpointCommon(),
  sourceClass: "frontier_api",
  provider: "openai",
  model: "supplier-model-current",
  modelRevision: known("2026-08-01"),
  jurisdiction: known({ jurisdiction: "CA", region: "ca-central-1" }),
});

const validLocalEndpoint = (sourceClass: "open_weight" | "vinci_pretrained") => ({
  ...endpointCommon(),
  sourceClass,
  weightsDigest: "weights-sha256-abc",
  tokenizerDigest: "tokenizer-sha256-def",
  architectureDigest: "architecture-sha256-ghi",
  servingImageDigest: known("image-sha256-jkl"),
  quantizationDigest: { kind: "unknown" },
});

const DIGEST_IDENTITY_FIELDS = [
  "weightsDigest",
  "tokenizerDigest",
  "architectureDigest",
  "servingImageDigest",
  "quantizationDigest",
] as const;

const FRONTIER_IDENTITY_FIELDS = [
  "provider",
  "model",
  "modelRevision",
  "jurisdiction",
] as const;

const digestIdentityValues: Record<(typeof DIGEST_IDENTITY_FIELDS)[number], unknown> = {
  weightsDigest: "weights-sha256-abc",
  tokenizerDigest: "tokenizer-sha256-def",
  architectureDigest: "architecture-sha256-ghi",
  servingImageDigest: known("image-sha256-jkl"),
  quantizationDigest: known("quantization-sha256-mno"),
};

const frontierIdentityValues: Record<(typeof FRONTIER_IDENTITY_FIELDS)[number], unknown> = {
  provider: "openai",
  model: "supplier-model-current",
  modelRevision: known("2026-08-01"),
  jurisdiction: known({ jurisdiction: "CA", region: "ca-central-1" }),
};

describe("model role and endpoint ABI validation", () => {
  it("round-trips a valid role and all three endpoint source classes", () => {
    const role = validRole();
    const endpoints = [
      validFrontierEndpoint(),
      validLocalEndpoint("open_weight"),
      validLocalEndpoint("vinci_pretrained"),
    ];

    const roleResult = validateModelRoleSpec(role);
    expect(roleResult.ok).toBe(true);
    if (roleResult.ok) expect(roleResult.value).toEqual(role);

    for (const endpoint of endpoints) {
      const result = validateModelEndpointSpec(endpoint);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual(endpoint);
    }
  });

  it("accumulates malformed role and endpoint issues at exact JSON pointers", () => {
    const roleResult = validateModelRoleSpec({
      ...validRole(),
      roleId: "has space",
      qualityPolicy: {
        ...validRole().qualityPolicy,
        minimumVerifiedSuccessRate: 1.1,
      },
    });
    expectIssue(roleResult, "/roleId", "invalid_identifier");
    expectIssue(
      roleResult,
      "/qualityPolicy/minimumVerifiedSuccessRate",
      "invalid_number",
    );

    const endpointResult = validateModelEndpointSpec({
      ...validFrontierEndpoint(),
      declaredCapabilities: ["not-a-required-capability"],
      validFrom: "August 1",
    });
    expectIssue(endpointResult, "/declaredCapabilities/0", "invalid_enum");
    expectIssue(endpointResult, "/validFrom", "invalid_timestamp");
  });

  it("rejects rather than preserves an unknown credentials key", () => {
    const result = validateModelEndpointSpec({
      ...validLocalEndpoint("open_weight"),
      credentials: {
        ...endpointCommon().credentials,
        label: "must-not-be-preserved",
      },
    });

    expectIssue(result, "/credentials/label", "credential_material_forbidden");
  });

  it("requires expiresAt on every validated endpoint", () => {
    const { expiresAt: _missing, ...endpoint } = validFrontierEndpoint();
    expectIssue(validateModelEndpointSpec(endpoint), "/expiresAt", "required_field");
  });

  it.each(DIGEST_IDENTITY_FIELDS)(
    "rejects digest identity field %s on a frontier_api endpoint",
    (field) => {
    expectIssue(
      validateModelEndpointSpec({
        ...validFrontierEndpoint(),
          [field]: digestIdentityValues[field],
      }),
        `/${field}`,
      "unexpected_field",
    );
    },
  );

  it.each(FRONTIER_IDENTITY_FIELDS)(
    "rejects frontier identity field %s on a digest-identified endpoint",
    (field) => {
      expectIssue(
        validateModelEndpointSpec({
          ...validLocalEndpoint("open_weight"),
          [field]: frontierIdentityValues[field],
        }),
        `/${field}`,
        "unexpected_field",
      );
    },
  );
});

describe("model role endpoint matching", () => {
  const now = "2026-08-30T12:00:00.000Z";

  it("fails closed when a retention-dependent policy is undeclared", () => {
    const endpoint = {
      ...validLocalEndpoint("vinci_pretrained"),
      rights: {
        ...endpointCommon().rights,
        outputRetainedByProvider: { kind: "unknown" as const },
      },
    };

    const result = matchEndpointToRole(validRole(), endpoint, now);
    expect(result.verdict).toBe("unevaluable");
    expect(result.reasons).toEqual([
      {
        code: "retention_undeclared",
        detail: "endpoint did not declare retention policy",
      },
    ]);
  });

  it("does not change verdict or reason codes merely because sourceClass changes", () => {
    const role = { ...validRole(), requiredCapabilities: ["vision"] };
    const frontier = validFrontierEndpoint();
    const local = validLocalEndpoint("vinci_pretrained");

    const frontierResult = matchEndpointToRole(role, frontier, now);
    const localResult = matchEndpointToRole(role, local, now);
    expect(frontierResult.verdict).toBe("ineligible");
    expect(localResult.verdict).toBe("ineligible");
    expect(frontierResult.reasons.map(({ code }) => code)).toEqual(["capability_missing"]);
    expect(localResult.reasons.map(({ code }) => code)).toEqual(["capability_missing"]);
  });

  it("fails unevaluable when external-ness is undeclared but role forbids external", () => {
    const endpoint = {
      ...validLocalEndpoint("open_weight"),
      inferenceIsExternal: { kind: "unknown" as const },
    };
    const role = {
      ...validRole(),
      dataPolicy: { ...validRole().dataPolicy, externalProviderAllowed: false },
    };

    const result = matchEndpointToRole(role, endpoint, now);
    expect(result.verdict).toBe("unevaluable");
    expect(result.reasons).toContainEqual({
      code: "external_provider_undeclared",
      detail: "endpoint did not declare whether inference is external",
    });
  });

  it("rejects an open_weight endpoint when declared external but role forbids external providers", () => {
    const endpoint = {
      ...validLocalEndpoint("open_weight"),
      inferenceIsExternal: known(true),
    };
    const role = {
      ...validRole(),
      dataPolicy: { ...validRole().dataPolicy, externalProviderAllowed: false },
    };

    const result = matchEndpointToRole(role, endpoint, now);
    expect(result.verdict).toBe("ineligible");
    expect(result.reasons).toEqual([
      {
        code: "external_provider_forbidden",
        detail: "role policy forbids an external inference provider",
      },
    ]);
  });

  it("permits a frontier_api endpoint when declared non-external despite sourceClass", () => {
    const endpoint = {
      ...validFrontierEndpoint(),
      inferenceIsExternal: known(false),
    };
    const role = {
      ...validRole(),
      dataPolicy: { ...validRole().dataPolicy, externalProviderAllowed: false },
    };

    const result = matchEndpointToRole(role, endpoint, now);
    expect(result.verdict).toBe("eligible");
    expect(result.reasons).toEqual([]);
  });

  it("still does not change verdict when sourceClass changes (with external forbidden)", () => {
    const role = {
      ...validRole(),
      dataPolicy: { ...validRole().dataPolicy, externalProviderAllowed: false },
      requiredCapabilities: ["vision"],
    };
    const frontier = { ...validFrontierEndpoint(), inferenceIsExternal: known(false) };
    const local = {
      ...validLocalEndpoint("vinci_pretrained"),
      inferenceIsExternal: known(false),
    };

    const frontierResult = matchEndpointToRole(role, frontier, now);
    const localResult = matchEndpointToRole(role, local, now);
    expect(frontierResult.verdict).toBe("ineligible");
    expect(localResult.verdict).toBe("ineligible");
    expect(frontierResult.reasons.map(({ code }) => code)).toEqual([
      "capability_missing",
    ]);
    expect(localResult.reasons.map(({ code }) => code)).toEqual(["capability_missing"]);
  });

  it("makes ineligible outrank unevaluable while collecting every reason", () => {
    const endpoint = {
      ...validLocalEndpoint("open_weight"),
      capabilityProfile: {
        ...endpointCommon().capabilityProfile,
        contextLimit: 4_096,
      },
      rights: {
        ...endpointCommon().rights,
        outputRetainedByProvider: { kind: "unknown" as const },
      },
    };

    const result = matchEndpointToRole(validRole(), endpoint, now);
    expect(result.verdict).toBe("ineligible");
    expect(result.reasons.map(({ code }) => code)).toEqual([
      "context_too_small",
      "retention_undeclared",
    ]);
  });

  it("rejects an expired endpoint and treats null as no declared expiry", () => {
    const expired = matchEndpointToRole(
      validRole(),
      { ...validLocalEndpoint("open_weight"), expiresAt: "2026-08-30T11:59:59.999Z" },
      now,
    );
    const noExpiry = matchEndpointToRole(
      validRole(),
      { ...validLocalEndpoint("open_weight"), expiresAt: null },
      now,
    );

    expect(expired.verdict).toBe("ineligible");
    expect(expired.reasons.map(({ code }) => code)).toEqual(["endpoint_expired"]);
    expect(noExpiry.verdict).toBe("eligible");
    expect(noExpiry.reasons).toEqual([]);
  });

  it("is unevaluable when a protected-data role meets an undeclared approval", () => {
    const role = {
      ...validRole(),
      dataPolicy: { ...validRole().dataPolicy, processesProtectedData: true },
    };
    const endpoint = {
      ...validLocalEndpoint("vinci_pretrained"),
      approvedForProtectedData: { kind: "unknown" as const },
    };

    const result = matchEndpointToRole(role, endpoint, now);
    expect(result.verdict).toBe("unevaluable");
    expect(result.reasons).toEqual([
      {
        code: "protected_data_approval_undeclared",
        detail: "endpoint did not declare whether it may process protected data",
      },
    ]);
  });

  it("is ineligible when a protected-data role meets an endpoint not approved for protected data", () => {
    const role = {
      ...validRole(),
      dataPolicy: { ...validRole().dataPolicy, processesProtectedData: true },
    };
    const endpoint = {
      ...validLocalEndpoint("vinci_pretrained"),
      approvedForProtectedData: known(false),
    };

    const result = matchEndpointToRole(role, endpoint, now);
    expect(result.verdict).toBe("ineligible");
    expect(result.reasons).toEqual([
      {
        code: "protected_data_not_approved",
        detail: "endpoint is not approved to process protected data",
      },
    ]);
  });

  it("imposes no protected-data constraint when the role does not process protected data", () => {
    const role = {
      ...validRole(),
      dataPolicy: { ...validRole().dataPolicy, processesProtectedData: false },
    };
    const endpoint = {
      ...validLocalEndpoint("vinci_pretrained"),
      approvedForProtectedData: known(false),
    };

    const result = matchEndpointToRole(role, endpoint, now);
    expect(result.verdict).toBe("eligible");
    expect(result.reasons).toEqual([]);
  });

  it("emits evaluation_rights_required (not training_rights_required) for a forbidden evaluation right", () => {
    const endpoint = {
      ...validLocalEndpoint("vinci_pretrained"),
      rights: { ...endpointCommon().rights, evaluationAllowed: known(false) },
    };
    const role = { ...validRole(), riskClass: "high" };

    const result = matchEndpointToRole(role, endpoint, now);
    const codes = result.reasons.map(({ code }) => code);
    expect(codes).toContain("evaluation_rights_required");
    expect(codes).not.toContain("training_rights_required");
  });
});

describe("matchEndpointToRole defensive validation", () => {
  const now = "2026-08-30T12:00:00.000Z";

  function matchUnknown(role: unknown, endpoint: unknown) {
    let result: ReturnType<typeof matchEndpointToRole> | undefined;
    expect(() => {
      result = matchEndpointToRole(role as never, endpoint as never, now);
    }).not.toThrow();
    expect(result).toBeDefined();
    return result as ReturnType<typeof matchEndpointToRole>;
  }

  function expectInputNotEvaluable(result: ReturnType<typeof matchEndpointToRole>) {
    expect(result.verdict).toBe("unevaluable");
    expect(result.reasons.map(({ code }) => code)).toEqual(["input_not_evaluable"]);
  }

  it("rejects a null role", () => {
    const result = matchUnknown(null, validLocalEndpoint("open_weight"));
    expectInputNotEvaluable(result);
  });

  it("rejects non-object roles", () => {
    for (const role of [7, "role", undefined]) {
      const result = matchUnknown(role, validLocalEndpoint("open_weight"));
      expectInputNotEvaluable(result);
    }
  });

  it("rejects a role with non-array requiredCapabilities", () => {
    const result = matchUnknown(
      { ...validRole(), requiredCapabilities: "repository_editing" },
      validLocalEndpoint("open_weight"),
    );
    expectInputNotEvaluable(result);
  });

  it("rejects a null endpoint", () => {
    const result = matchUnknown(validRole(), null);
    expectInputNotEvaluable(result);
  });

  it("rejects non-object endpoints", () => {
    for (const endpoint of [7, "endpoint", undefined]) {
      const result = matchUnknown(validRole(), endpoint);
      expectInputNotEvaluable(result);
    }
  });

  it("rejects an endpoint with non-array declaredCapabilities", () => {
    const result = matchUnknown(validRole(), {
      ...validLocalEndpoint("open_weight"),
      declaredCapabilities: "repository_editing",
    });
    expectInputNotEvaluable(result);
  });

  it("rejects a role with non-object dataPolicy", () => {
    const result = matchUnknown(
      { ...validRole(), dataPolicy: null },
      validLocalEndpoint("open_weight"),
    );
    expectInputNotEvaluable(result);
  });

  it("rejects an endpoint with a missing or non-object capabilityProfile", () => {
    const { capabilityProfile: _missing, ...missingProfile } =
      validLocalEndpoint("open_weight");
    for (const endpoint of [missingProfile, { ...missingProfile, capabilityProfile: 7 }]) {
      const result = matchUnknown(validRole(), endpoint);
      expectInputNotEvaluable(result);
    }
  });

  it("rejects an endpoint with a non-string endpointId without coercing it", () => {
    const hostileId = Object.create(null) as { toString?: () => string };
    hostileId.toString = () => {
      throw new Error("must not coerce endpointId");
    };
    const result = matchUnknown(validRole(), {
      ...validLocalEndpoint("open_weight"),
      endpointId: hostileId,
    });
    expectInputNotEvaluable(result);
  });

  it("does not throw on any hostile input", () => {
    const hostileInputs: unknown[] = [
      Symbol("hostile"),
      Object.create(null),
      new Proxy({}, { get() { throw new Error("trap"); } }),
      { get requiredCapabilities() { throw new Error("getter"); } },
      new Array(5),
    ];

    for (const hostile of hostileInputs) {
      expectInputNotEvaluable(matchUnknown(hostile, validLocalEndpoint("open_weight")));
      expectInputNotEvaluable(matchUnknown(validRole(), hostile));
    }
  });

  it("rejects own __proto__ keys without throwing or polluting Object.prototype", () => {
    const pollutedRole = JSON.parse(JSON.stringify(validRole())) as Record<string, unknown>;
    Object.defineProperty(pollutedRole, "__proto__", {
      value: { testMarker: true },
      enumerable: true,
    });
    const pollutedEndpoint = JSON.parse(
      JSON.stringify(validLocalEndpoint("open_weight")),
    ) as Record<string, unknown>;
    Object.defineProperty(pollutedEndpoint, "__proto__", {
      value: { testMarker: true },
      enumerable: true,
    });

    expect(({} as { testMarker?: boolean }).testMarker).toBeUndefined();
    expectInputNotEvaluable(matchUnknown(pollutedRole, validLocalEndpoint("open_weight")));
    expectInputNotEvaluable(matchUnknown(validRole(), pollutedEndpoint));
    expect(({} as { testMarker?: boolean }).testMarker).toBeUndefined();
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

describe("role-match guards", () => {
  /**
   * Guards the class, not just today's three instances. Reading keys from a real
   * role means a newly added policy field must behaviorally affect matching or
   * this test fails.
   */
  it("enforces every dataPolicy key that a role can declare", () => {
    const keys = Object.keys(validRole().dataPolicy);
    expect(keys.length).toBeGreaterThan(0);

    const endpoint = {
      ...validLocalEndpoint("vinci_pretrained"),
      approvedForProtectedData: known(false),
      rights: {
        ...endpointCommon().rights,
        outputRetainedByProvider: known(true),
      },
    };

    for (const key of keys) {
      const outcomes = [true, false].map((value) => {
        const role = {
          ...validRole(),
          dataPolicy: { ...validRole().dataPolicy, [key]: value },
        };
        const result = matchEndpointToRole(role, endpoint, "2026-08-30T12:00:00.000Z");
        return {
          verdict: result.verdict,
          reasonCodes: result.reasons.map(({ code }) => code),
        };
      });

      expect(outcomes[0], `${key} does not affect matching`).not.toEqual(outcomes[1]);
    }
  });
});
