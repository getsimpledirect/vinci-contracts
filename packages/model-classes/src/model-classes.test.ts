import { assertSchemaMetaComplete } from "@getsimpledirect/vinci-contracts";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CUSTOMER_ENDPOINT_SCHEMA_META,
  FALLBACK_RECORD_SCHEMA_META,
  MODEL_ENDPOINT_SPEC_SCHEMA_META,
  MODEL_PROVENANCE_SCHEMA_META,
  MODEL_ROLE_SPEC_SCHEMA_META,
  RESIDENCY_RECORD_SCHEMA_META,
  VINCI_ENDPOINTS,
  VINCI_ROLES,
  endpointById,
  matchEndpointToRole,
  roleById,
  selectForRole,
  validateCustomerEndpointConfig,
  validateModelEndpointSpec,
  validateFallbackRecord,
  validateModelProvenanceRecord,
  validateModelRoleSpec,
  validateResidencyRecord,
  violatesIndependence,
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
  requiredCapabilities: ["structured_tool_use"],
  // Deliberately EMPTY. A role that requires a harness capability can never be
  // `eligible` from the endpoint matcher alone, so a non-empty default here would
  // silently make every test below assert `unevaluable` for a reason unrelated to
  // what it is testing. The harness requirement is covered by its own tests.
  requiredHarnessCapabilities: [],
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
  declaredCapabilities: ["structured_tool_use"],
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
  serving: {
    kind: "third_party_api",
    provider: "openai",
    model: "supplier-model-current",
    modelRevision: known("2026-08-01"),
    jurisdiction: known({ jurisdiction: "CA", region: "ca-central-1" }),
  },
  servedArtifact: known({ kind: "proprietary" as const }),
});

const validLocalEndpoint = (sourceClass: "open_weight" | "vinci_pretrained") => ({
  ...endpointCommon(),
  sourceClass,
  serving: { kind: "vinci_hosted" },
  weightsDigest: known("weights-sha256-abc"),
  tokenizerDigest: known("tokenizer-sha256-def"),
  architectureDigest: known("architecture-sha256-ghi"),
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
  "servedArtifact",
] as const;

const digestIdentityValues: Record<(typeof DIGEST_IDENTITY_FIELDS)[number], unknown> = {
  weightsDigest: known("weights-sha256-abc"),
  tokenizerDigest: known("tokenizer-sha256-def"),
  architectureDigest: known("architecture-sha256-ghi"),
  servingImageDigest: known("image-sha256-jkl"),
  quantizationDigest: known("quantization-sha256-mno"),
};

const frontierIdentityValues: Record<(typeof FRONTIER_IDENTITY_FIELDS)[number], unknown> = {
  provider: "openai",
  model: "supplier-model-current",
  modelRevision: known("2026-08-01"),
  jurisdiction: known({ jurisdiction: "CA", region: "ca-central-1" }),
  servedArtifact: known({ kind: "proprietary" }),
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

  it("requires a well-formed servedArtifact on frontier endpoints", () => {
    const { servedArtifact: _missing, ...missing } = validFrontierEndpoint();
    expectIssue(
      validateModelEndpointSpec(missing),
      "/servedArtifact",
      "required_field",
    );
    expectIssue(
      validateModelEndpointSpec({
        ...validFrontierEndpoint(),
        servedArtifact: known({ kind: "digest" }),
      }),
      "/servedArtifact/value/value",
      "required_field",
    );
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

  it("rejects malformed decision values instead of granting eligibility", () => {
    const endpoint = validLocalEndpoint("open_weight");
    for (const role of [
      { ...validRole(), riskClass: "bogus" },
      { ...validRole(), minimumContextTokens: -1 },
      { ...validRole(), requiredCapabilities: ["bogus"] },
    ]) {
      expectInputNotEvaluable(matchUnknown(role, endpoint));
    }

    for (const malformedEndpoint of [
      { ...endpoint, declaredCapabilities: ["bogus"] },
      { ...endpoint, capabilityProfile: { ...endpoint.capabilityProfile, contextLimit: -1 } },
      { ...endpoint, validFrom: "not-a-timestamp" },
      { ...endpoint, expiresAt: "not-a-timestamp" },
    ]) {
      expectInputNotEvaluable(matchUnknown(validRole(), malformedEndpoint));
    }

    expectInputNotEvaluable(
      matchEndpointToRole(validRole(), endpoint, "not-a-timestamp" as never),
    );
  });

  it("reads bounded capability arrays by index without trusting their iterator", () => {
    const capabilities = new Proxy(["structured_tool_use"], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) throw new Error("must not use caller iterator");
        return Reflect.get(target, property, receiver);
      },
    });

    const result = matchUnknown(
      { ...validRole(), requiredCapabilities: capabilities },
      { ...validLocalEndpoint("open_weight"), declaredCapabilities: capabilities },
    );

    expect(result.verdict).toBe("eligible");
  });

  it("rejects explicit unknown values that smuggle a value", () => {
    const endpoint = {
      ...validLocalEndpoint("open_weight"),
      inferenceIsExternal: { kind: "unknown", value: false },
    };
    expectInputNotEvaluable(matchUnknown(validRole(), endpoint));
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

  it("rejects malformed role and endpoint identifiers", () => {
    expectInputNotEvaluable(
      matchUnknown({ ...validRole(), roleId: "" }, validLocalEndpoint("open_weight")),
    );
    expectInputNotEvaluable(
      matchUnknown(validRole(), { ...validLocalEndpoint("open_weight"), endpointId: "" }),
    );
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
describe("vinci endpoint registry", () => {
  it("declares every endpoint as a valid ModelEndpointSpec", () => {
    for (const endpoint of VINCI_ENDPOINTS) {
      const result = validateModelEndpointSpec(endpoint);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.endpointId).toBe(endpoint.endpointId);
      }
    }
  });

  it("maintains unique endpoint ids", () => {
    const ids = VINCI_ENDPOINTS.map((ep) => ep.endpointId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("rejects an external endpoint when role forbids external providers", () => {
    const externalEndpoint = VINCI_ENDPOINTS.find(
      (ep) => ep.endpointId === "forte-deepinfra",
    );
    expect(externalEndpoint).toBeDefined();

    if (externalEndpoint) {
      const roleWithoutExternal = {
        ...validRole(),
        dataPolicy: {
          ...validRole().dataPolicy,
          externalProviderAllowed: false,
        },
      };
      const now = "2026-08-30T12:00:00.000Z";
      const result = matchEndpointToRole(roleWithoutExternal, externalEndpoint, now);

      expect(result.verdict).toBe("ineligible");
      expect(result.reasons).toContainEqual({
        code: "external_provider_forbidden",
        detail: "role policy forbids an external inference provider",
      });
    }
  });

  it("permits pod-served endpoint when role forbids external providers", () => {
    // A local fixture served on Vinci's own infrastructure. The role forbids
    // external providers, so this must stay eligible: the refusal in the test
    // above is about where inference runs (serving.kind), not about the lane
    // name. No registered lane is vinci_hosted today — every real lane is a
    // third-party API — so the fixture carries the property explicitly.
    const podEndpoint = {
      ...validLocalEndpoint("open_weight"),
      endpointId: "pod-openweight-local",
      serving: { kind: "vinci_hosted" },
      inferenceIsExternal: known(false),
    };

    const roleWithoutExternal = {
      ...validRole(),
      dataPolicy: {
        ...validRole().dataPolicy,
        externalProviderAllowed: false,
      },
    };
    const now = "2026-08-30T12:00:00.000Z";
    const result = matchEndpointToRole(roleWithoutExternal, podEndpoint, now);

    expect(result.verdict).toBe("eligible");
    expect(result.reasons).toEqual([]);
  });

  it("looks up endpoints by id", () => {
    expect(endpointById("forte-deepinfra")).toBeDefined();
    expect(endpointById("forte-deepinfra")?.endpointId).toBe("forte-deepinfra");

    expect(endpointById("vision-openrouter")).toBeDefined();
    expect(endpointById("vision-openrouter")?.endpointId).toBe("vision-openrouter");

    expect(endpointById("mezzo-deepinfra")).toBeDefined();
    expect(endpointById("mezzo-deepinfra")?.endpointId).toBe("mezzo-deepinfra");

    expect(endpointById("unknown-endpoint-id")).toBeUndefined();
  });

  it("reports the registry's undeclared rights and policy facts", () => {
    const script = fileURLToPath(
      new URL("../../../scripts/report-rights-gaps.mjs", import.meta.url),
    );
    const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}; status=$?; printf '\\n__EXIT_CODE__=%s\\n' "$status"`;
    const output = execSync(command, { encoding: "utf8", shell: "/bin/sh" });
    const match = output.match(/\n__EXIT_CODE__=(\d+)\n$/);
    const stdout = output.replace(/\n__EXIT_CODE__=\d+\n$/, "");

    expect(match?.[1]).toBe("0");
    // Every registry RIGHTS field a role depends on is now declared: George checked the
    // three providers' terms on 2026-08-31 (training and evaluation permitted), and
    // non-retention is an enforced invariant of vinci-chat's serving path. So no
    // provider-terms gap should appear.
    expect(stdout).not.toContain("terms of service");
    expect(stdout).not.toContain("protected-data approval record");

    // One honest gap remains, and it is not a rights gap: three roles require harness
    // capabilities that only the CALLER can attest, so the registry alone cannot make
    // them eligible. The report must name it rather than report a clean bill of health,
    // and must still exit 0, because a declared gap is a healthy state, not a failure.
    expect(stdout).toContain("attestedHarnessCapabilities");
    expect(stdout).toContain("mle-implementation-worker");
  });
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

  it("uses the data-policy value it validated when a getter changes its answer", () => {
    let reads = 0;
    const policy = {
      ...validRole().dataPolicy,
      get externalProviderAllowed(): boolean {
        reads += 1;
        return reads === 1 ? false : true;
      },
    };
    const role = { ...validRole(), dataPolicy: policy };
    const endpoint = { ...validLocalEndpoint("open_weight"), inferenceIsExternal: known(true) };

    const result = matchEndpointToRole(role, endpoint, "2026-08-30T12:00:00.000Z");

    expect(reads).toBe(1);
    expect(result.verdict).toBe("ineligible");
    expect(result.reasons.map(({ code }) => code)).toContain("external_provider_forbidden");
  });

  it("uses the endpoint-rights value it validated when a getter changes its answer", () => {
    let reads = 0;
    const rights = {
      ...endpointCommon().rights,
      get trainingAllowed() {
        reads += 1;
        return reads === 1 ? { kind: "unknown" as const } : known(true);
      },
    };
    const role = { ...validRole(), riskClass: "high" as const };
    const endpoint = { ...validLocalEndpoint("open_weight"), rights };

    const result = matchEndpointToRole(role, endpoint, "2026-08-30T12:00:00.000Z");

    expect(reads).toBe(1);
    expect(result.verdict).toBe("unevaluable");
    expect(result.reasons.map(({ code }) => code)).toContain("rights_undeclared");
  });
});

describe("vinci role registry", () => {
  it("declares valid roles with unique ids and lookup support", () => {
    expect(VINCI_ROLES.map(({ roleId }) => roleId)).toEqual([
      "mle-implementation-worker",
      "adversarial-reviewer",
      "cloud-worker",
      "teacher-trajectory-producer",
    ]);

    for (const role of VINCI_ROLES) {
      const result = validateModelRoleSpec(role);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toEqual(role);
      expect(roleById(role.roleId)).toBe(role);
    }

    const ids = VINCI_ROLES.map(({ roleId }) => roleId);
    expect(new Set(ids).size).toBe(4);
    expect(roleById("not-a-vinci-role")).toBeUndefined();
  });

  it("keeps both authority registries deeply immutable at runtime", () => {
    expect(Object.isFrozen(VINCI_ROLES)).toBe(true);
    expect(Object.isFrozen(VINCI_ROLES[0])).toBe(true);
    expect(Object.isFrozen(VINCI_ROLES[0].dataPolicy)).toBe(true);
    expect(Object.isFrozen(VINCI_ROLES[0].requiredCapabilities)).toBe(true);
    expect(Object.isFrozen(VINCI_ENDPOINTS)).toBe(true);
    expect(Object.isFrozen(VINCI_ENDPOINTS[0])).toBe(true);
    expect(Object.isFrozen(VINCI_ENDPOINTS[0].rights)).toBe(true);
    expect(() => {
      (VINCI_ROLES[0] as unknown as { riskClass: string }).riskClass = "low";
    }).toThrow(TypeError);
    expect(() => {
      (VINCI_ENDPOINTS[0] as unknown as { expiresAt: string }).expiresAt =
        "2020-01-01T00:00:00.000Z";
    }).toThrow(TypeError);
  });
});

describe("role selection", () => {
  const now = "2026-08-30T12:00:00.000Z";
  const endpointIds = (results: readonly { readonly endpointId: string }[]) =>
    results.map(({ endpointId }) => endpointId);

  it("reports the concrete three-way registry partition for every role", () => {
    const selections = Object.fromEntries(
      VINCI_ROLES.map((role) => [role.roleId, selectForRole(role, VINCI_ENDPOINTS, now)]),
    );

    // NOT eligible. The role requires repository_editing and long_horizon_recovery,
    // which are harness capabilities an inference endpoint cannot supply and
    // selectForRole does not attest. Absence of that attestation withholds
    // eligibility instead of granting it.
    expect(endpointIds(selections["mle-implementation-worker"].eligible)).toEqual([]);
    expect(endpointIds(selections["mle-implementation-worker"].unevaluable)).toEqual([
      "forte-deepinfra",
      "forte-fireworks",
      "mezzo-deepinfra",
      "fortissimo-fireworks",
    ]);
    expect(endpointIds(selections["mle-implementation-worker"].ineligible)).toEqual([
      "vision-deepinfra",
      "vision-openrouter",
    ]);

    // adversarial-reviewer requires evidence_citation from the HARNESS. Splitting the
    // field out of requiredCapabilities removed it from the endpoint check; it must not
    // also remove it from enforcement, so these lanes are unevaluable, not eligible.
    expect(endpointIds(selections["adversarial-reviewer"].eligible)).toEqual([]);
    expect(endpointIds(selections["adversarial-reviewer"].unevaluable)).toEqual([
      "forte-deepinfra",
      "forte-fireworks",
      "mezzo-deepinfra",
      "fortissimo-fireworks",
    ]);
    expect(endpointIds(selections["adversarial-reviewer"].ineligible)).toEqual([
      "vision-deepinfra",
      "vision-openrouter",
    ]);

    expect(endpointIds(selections["cloud-worker"].eligible)).toEqual([
      "forte-deepinfra",
      "forte-fireworks",
      "vision-deepinfra",
      "vision-openrouter",
      "mezzo-deepinfra",
      "fortissimo-fireworks",
    ]);
    expect(endpointIds(selections["cloud-worker"].unevaluable)).toEqual([]);
    expect(endpointIds(selections["cloud-worker"].ineligible)).toEqual([]);

    // teacher-trajectory-producer requires no ENDPOINT capabilities, which is exactly why
    // it is the sharpest case: with evidence_citation moved to the harness field and left
    // unenforced, every endpoint would have become eligible for a role whose one real
    // requirement nothing checks. Unattested, all six are unevaluable.
    expect(endpointIds(selections["teacher-trajectory-producer"].eligible)).toEqual([]);
    expect(endpointIds(selections["teacher-trajectory-producer"].unevaluable)).toEqual([
      "forte-deepinfra",
      "forte-fireworks",
      "vision-deepinfra",
      "vision-openrouter",
      "mezzo-deepinfra",
      "fortissimo-fireworks",
    ]);
    expect(endpointIds(selections["teacher-trajectory-producer"].ineligible)).toEqual([]);
  });

  it("withholds eligibility when a role omits requiredHarnessCapabilities entirely", () => {
    // A role that simply does not mention the field is NOT a role with no harness
    // requirements. Reading omission as "none required" is the fail-open this guard
    // exists to prevent: it would let a role become eligible by saying less.
    const endpoint = endpointById("forte-deepinfra");
    expect(endpoint).toBeDefined();

    const role = roleById("cloud-worker");
    expect(role).toBeDefined();

    if (role && endpoint) {
      // Control: cloud-worker declares [] explicitly and IS eligible, so the assertion
      // below fails for the omission and not for some unrelated property of the pair.
      expect(matchEndpointToRole(role, endpoint, now).verdict).toBe("eligible");

      const withoutField: Record<string, unknown> = { ...role };
      delete withoutField.requiredHarnessCapabilities;

      const result = matchEndpointToRole(
        withoutField as unknown as ModelRoleSpec,
        endpoint,
        now,
      );
      expect(result.verdict).toBe("unevaluable");
      expect(result.reasons.map(({ code }) => code)).toContain(
        "harness_capabilities_unverified",
      );
    }
  });

  it("keeps each partition disjoint and accounts for every endpoint", () => {
    const expectedIds = VINCI_ENDPOINTS.map(({ endpointId }) => endpointId).sort();

    for (const role of VINCI_ROLES) {
      const selection = selectForRole(role, VINCI_ENDPOINTS, now);
      const eligible = endpointIds(selection.eligible);
      const unevaluable = endpointIds(selection.unevaluable);
      const ineligible = endpointIds(selection.ineligible);
      const allIds = [...eligible, ...unevaluable, ...ineligible];

      expect(selection.roleId).toBe(role.roleId);
      expect(new Set(allIds).size).toBe(VINCI_ENDPOINTS.length);
      expect(allIds.sort()).toEqual(expectedIds);
      expect(eligible.filter((id) => unevaluable.includes(id) || ineligible.includes(id))).toEqual(
        [],
      );
      expect(unevaluable.filter((id) => ineligible.includes(id))).toEqual([]);
    }
  });

  it("surfaces an endpoint-list read failure as unevaluable", () => {
    const endpoints = new Proxy([...VINCI_ENDPOINTS], {
      get(target, property, receiver) {
        if (property === "0") throw new Error("hostile index getter");
        return Reflect.get(target, property, receiver);
      },
    });

    const selection = selectForRole(VINCI_ROLES[0], endpoints, now);
    expect(selection.eligible).toEqual([]);
    expect(selection.ineligible).toEqual([]);
    expect(selection.unevaluable).toHaveLength(1);
    expect(selection.unevaluable[0]?.reasons.map(({ code }) => code)).toEqual([
      "input_not_evaluable",
    ]);
  });

  it("surfaces an unreadable role as unevaluable instead of an empty population", () => {
    const selection = selectForRole(null as never, VINCI_ENDPOINTS, now);
    expect(selection.eligible).toEqual([]);
    expect(selection.ineligible).toEqual([]);
    expect(selection.unevaluable).toHaveLength(1);
    expect(selection.unevaluable[0]?.reasons.map(({ code }) => code)).toEqual([
      "input_not_evaluable",
    ]);
  });

  it("classifies an implementation endpoint from declared facts, not its lane id", () => {
    const role = roleById("mle-implementation-worker");
    const endpoint = endpointById("forte-deepinfra");
    expect(role).toBeDefined();
    expect(endpoint).toBeDefined();

    if (role && endpoint) {
      const result = matchEndpointToRole(role, endpoint, now);

      // The verdict follows the declared facts. The endpoint satisfies every ENDPOINT
      // capability the role asks for, but the role also requires harness capabilities
      // that no endpoint can supply and this call does not attest, so the honest answer
      // is "cannot tell", not "yes".
      expect(result.verdict).toBe("unevaluable");
      expect(result.reasons.map(({ code }) => code)).toEqual([
        "harness_capabilities_unverified",
      ]);

      // Both directions. With the harness attested, the same pair IS eligible -- so the
      // check above is withholding a real grant rather than refusing everything.
      const attested = matchEndpointToRole(role, endpoint, now, [
        "repository_editing",
        "long_horizon_recovery",
      ]);
      expect(attested.verdict).toBe("eligible");
      expect(attested.reasons).toEqual([]);

      // And an attestation that does not cover the requirement is a definite no.
      const partial = matchEndpointToRole(role, endpoint, now, ["repository_editing"]);
      expect(partial.verdict).toBe("ineligible");
    }
  });

  /**
   * The registry's rights are now DECLARED, so it can no longer demonstrate
   * this property -- but the property is the reason the role exists and must
   * keep a test. An undeclared right must never become an implicit yes for
   * high-risk work; it must refuse.
   *
   * Uses a local fixture rather than the registry, the same way the pod-served
   * test does, because the registry moved on and the invariant did not.
   */
  it("refuses high-risk work when a right is undeclared, whatever the lane", () => {
    const role = roleById("teacher-trajectory-producer");
    const declared = endpointById("forte-deepinfra");
    expect(role).toBeDefined();
    expect(declared).toBeDefined();

    if (role && declared) {
      // After separating endpoint and harness capabilities, teacher-trajectory-producer
      // requires no endpoint capabilities (evidence_citation is now a harness capability).
      // Create a fixture that is eligible to verify the rights-undeclared check still fires.
      const withCapabilities = {
        ...declared,
        endpointId: "fixture-rights-eligible-capable",
        declaredCapabilities: [],
      } as unknown as ModelEndpointSpec;

      const undeclared = {
        ...withCapabilities,
        endpointId: "fixture-rights-undeclared",
        rights: { ...withCapabilities.rights, trainingAllowed: { kind: "unknown" } },
      } as unknown as ModelEndpointSpec;

      // Attest the harness capability so that the ONLY thing differing between the two
      // fixtures below is the declared right. Without this the pair would both be
      // unevaluable for a harness reason and the test would pass without touching rights.
      const harness = ["evidence_citation"] as const;

      expect(matchEndpointToRole(role, withCapabilities, now, harness).verdict).toBe(
        "eligible",
      );

      const result = matchEndpointToRole(role, undeclared, now, harness);
      expect(result.verdict).toBe("unevaluable");
      expect(result.reasons.map(({ code }) => code)).toContain("rights_undeclared");
    }
  });

  /**
   * The companion, so the test above cannot pass vacuously. If the check simply
   * returned true for everything it would be worthless, and the sweep above
   * could not tell the difference. With digests actually KNOWN it discriminates.
   */
  it("still discriminates when artifact identity IS established", () => {
    const digest = (value: string) =>
      ({ ...validLocalEndpoint("open_weight"), endpointId: `e-${value}`,
         weightsDigest: known(`sha256-${value.repeat(64).slice(0, 64)}`) }) as unknown as ModelEndpointSpec;

    expect(violatesIndependence(digest("a"), digest("a"))).toBe(true);
    expect(violatesIndependence(digest("a"), digest("b"))).toBe(false);
  });

  it("rejects the same endpoint id", () => {
    const endpoint = validLocalEndpoint("open_weight");
    expect(violatesIndependence(endpoint, endpoint)).toBe(true);
  });

  it("rejects different local endpoints serving the same weights", () => {
    const producer = { ...validLocalEndpoint("open_weight"), endpointId: "producer-local" };
    const reviewer = { ...validLocalEndpoint("open_weight"), endpointId: "reviewer-local" };

    expect(producer.endpointId).not.toBe(reviewer.endpointId);
    expect(producer.weightsDigest).toStrictEqual(reviewer.weightsDigest);
    expect(violatesIndependence(producer, reviewer)).toBe(true);
  });

  it("rejects the same weights across open-weight and Vinci-pretrained classes", () => {
    const producer = { ...validLocalEndpoint("open_weight"), endpointId: "producer-local" };
    const reviewer = {
      ...validLocalEndpoint("vinci_pretrained"),
      endpointId: "reviewer-local",
    };

    expect(producer.weightsDigest).toStrictEqual(reviewer.weightsDigest);
    expect(violatesIndependence(producer, reviewer)).toBe(true);
  });

  it("fails closed before comparing source classes when either artifact identity is malformed", () => {
    const local = {
      ...validLocalEndpoint("open_weight"),
      endpointId: "producer-local",
      weightsDigest: { kind: "unknown" },
    };
    const frontier = {
      ...validFrontierEndpoint(),
      endpointId: "reviewer-frontier",
    };

    expect(violatesIndependence(local, frontier)).toBe(true);

  });

  it("fails closed for a future source class until its identity scheme is classified", () => {
    const future = {
      ...validLocalEndpoint("open_weight"),
      endpointId: "future-endpoint",
      sourceClass: "future_source_class",
      weightsDigest: "weights-sha256-different",
    };
    const local = { ...validLocalEndpoint("open_weight"), endpointId: "reviewer-local" };

    expect(future.weightsDigest).not.toBe(local.weightsDigest);
    expect(violatesIndependence(future as never, local)).toBe(true);
  });

  it("rejects frontier endpoints with the same provider and model", () => {
    const producer = { ...validFrontierEndpoint(), endpointId: "producer-frontier" };
    const reviewer = { ...validFrontierEndpoint(), endpointId: "reviewer-frontier" };

    expect(producer.endpointId).not.toBe(reviewer.endpointId);
    expect(violatesIndependence(producer, reviewer)).toBe(true);
  });

  it("fails closed for differently labelled frontier endpoints", () => {
    const producer = { ...validFrontierEndpoint(), endpointId: "producer-frontier" };
    const reviewer = { 
      ...validFrontierEndpoint(),
      endpointId: "reviewer-frontier",
      serving: {
        kind: "third_party_api",
        provider: "different-provider",
        model: "different-model",
        modelRevision: { kind: "unknown" },
        jurisdiction: { kind: "unknown" },
      },
    };

    expect(violatesIndependence(producer, reviewer)).toBe(true);
  });

  it("rejects a frontier endpoint serving the same digest as an open-weight endpoint", () => {
    const frontier = {
      ...validFrontierEndpoint(),
      endpointId: "producer-frontier",

      servedArtifact: known({ kind: "digest" as const, value: "weights-sha256-abc" }),
    };
    const local = { ...validLocalEndpoint("open_weight"), endpointId: "reviewer-local" };

    expect(violatesIndependence(frontier, local)).toBe(true);
  });

  it("rejects an unknown frontier artifact against any digest endpoint", () => {
    const frontier = {
      ...validFrontierEndpoint(),
      endpointId: "producer-frontier",
      servedArtifact: { kind: "unknown" as const },
    };
    const local = {
      ...validLocalEndpoint("vinci_pretrained"),
      endpointId: "reviewer-local",
      weightsDigest: { kind: "known", value: "weights-sha256-unrelated" },
    };

    expect(violatesIndependence(frontier, local)).toBe(true);
  });

  it("accepts a proprietary frontier artifact against a digest endpoint", () => {
    const frontier = { ...validFrontierEndpoint(), endpointId: "producer-frontier" };
    const local = { ...validLocalEndpoint("open_weight"), endpointId: "reviewer-local" };

    expect(violatesIndependence(frontier, local)).toBe(false);
  });

  it("accepts a frontier artifact whose digest differs from the digest endpoint", () => {
    const frontier = {
      ...validFrontierEndpoint(),
      endpointId: "producer-frontier",
      servedArtifact: known({ kind: "digest" as const, value: "weights-sha256-different" }),
    };
    const local = { ...validLocalEndpoint("open_weight"), endpointId: "reviewer-local" };

    expect(violatesIndependence(frontier, local)).toBe(false);
  });

  it("snapshots servedArtifact and its inner value exactly once", () => {
    let servedArtifactReads = 0;
    let innerValueReads = 0;
    const frontier = {
      ...validFrontierEndpoint(),
      endpointId: "producer-frontier",
      get servedArtifact() {
        servedArtifactReads += 1;
        return {
          kind: "known" as const,
          value: {
            kind: "digest" as const,
            get value() {
              innerValueReads += 1;
              return innerValueReads === 1
                ? "weights-sha256-abc"
                : "weights-sha256-different";
            },
          },
        };
      },
    };
    const local = { ...validLocalEndpoint("open_weight"), endpointId: "reviewer-local" };

    expect(violatesIndependence(frontier, local)).toBe(true);
    expect(servedArtifactReads).toBe(1);
    expect(innerValueReads).toBe(1);
  });

  it("fails closed when a servedArtifact getter changes its answer", () => {
    let reads = 0;
    const frontier = {
      ...validFrontierEndpoint(),
      endpointId: "producer-frontier",
      get servedArtifact() {
        reads += 1;
        return reads === 1
          ? { kind: "unknown" as const }
          : known({ kind: "proprietary" as const });
      },
    };
    const local = { ...validLocalEndpoint("open_weight"), endpointId: "reviewer-local" };

    expect(violatesIndependence(frontier, local)).toBe(true);
    expect(reads).toBe(1);
  });

  it("rejects independence between real lanes whose artifact identity is unknown", () => {
    const forte = endpointById("forte-deepinfra");
    const vision = endpointById("vision-openrouter");
    const mezzo = endpointById("mezzo-deepinfra");

    expect(forte).toBeDefined();
    expect(vision).toBeDefined();
    expect(mezzo).toBeDefined();
    if (forte && vision && mezzo) {
      // All real lanes are third-party APIs with an unknown weightsDigest, so
      // no pair can prove independence: an absent identity is not a different
      // identity. Independence is refused, not granted.
      expect(violatesIndependence(forte, mezzo)).toBe(true);
      expect(violatesIndependence(vision, mezzo)).toBe(true);
      expect(violatesIndependence(forte, vision)).toBe(true);
    }
  });

  it("accepts endpoints with genuinely different identities", () => {
    const producer = { ...validLocalEndpoint("open_weight"), endpointId: "producer-local" };
    const reviewer = {
      ...validLocalEndpoint("vinci_pretrained"),
      endpointId: "reviewer-local",
      weightsDigest: { kind: "known", value: "weights-sha256-different" },
    };

    const pVal = (producer.weightsDigest as Record<string, unknown>).value;
    const rVal = (reviewer.weightsDigest as Record<string, unknown>).value;
    expect(pVal).not.toBe(rVal);
    expect(violatesIndependence(producer, reviewer)).toBe(false);
  });
});
