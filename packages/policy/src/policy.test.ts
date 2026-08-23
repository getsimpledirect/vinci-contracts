import { describe, expect, expectTypeOf, it } from "vitest";
import {
  EXTERNAL_SIDE_EFFECT_CLASSES,
  POLICY_DECISION_SCHEMA_META,
  POLICY_MANIFEST_SECTION_NAMES,
  POLICY_MANIFEST_SCHEMA_META,
  assertSchemaMetaComplete,
  validatePolicyDecision,
  validatePolicyManifest,
  type CredentialPolicy,
  type PolicyDecision,
  type PolicyId,
  type PolicyManifest,
} from "./index.ts";

const validManifest = {
  policyId: "policy-test" as PolicyId,
  version: 1,
  displayName: "Test policy",
  resources: {
    allowedKinds: ["local_process"],
    maximumCpuCores: 2,
    maximumMemoryBytes: 1_073_741_824,
    maximumStorageBytes: 5_000_000_000,
  },
  filesystem: {
    readOnlyRoots: ["/workspace"],
    writableRoots: ["/workspace/output"],
    deniedRoots: ["/etc"],
    temporaryWorkspace: "/tmp/run",
    protectedPaths: ["/workspace/.git"],
    maximumChangedFileCount: 100,
    maximumChangedByteVolume: 10_000_000,
    symlinkHandling: "deny",
    generatedArtifactPaths: ["/workspace/output"],
  },
  applications: {
    defaultAction: "deny",
    allowedApplications: ["git"],
    deniedApplications: [],
  },
  network: {
    defaultAction: "deny",
    allowedDomains: ["example.com"],
    allowedIpRanges: [],
    allowedProtocols: ["https"],
    dnsPolicy: "system_resolver",
    maximumOutboundRequests: 10,
    privateNetworkAccess: "deny",
    noNetwork: false,
  },
  credentials: {
    references: [
      {
        credentialId: "github-installation",
        issuer: "github",
        scopes: ["contents:read"],
        revocable: true,
        lifetime: "short_lived",
        boundTo: { kind: "capability", capability: "repository_read" },
        expiresAt: "2026-08-23T18:00:00.000Z",
      },
    ],
  },
  external_side_effects: {
    defaultAction: "require_approval",
    rules: EXTERNAL_SIDE_EFFECT_CLASSES.map((actionClass) => ({
      actionClass,
      approval: "required",
    })),
  },
  spend: {
    maximumSpend: { currency: "USD", minorUnits: 1000 },
    maximumVerificationCost: { currency: "USD", minorUnits: 200 },
  },
  runtime: {
    maximumActiveRuntimeSeconds: 600,
    maximumWallClockRuntimeSeconds: 1800,
    maximumModelCalls: 20,
    maximumWorkerCount: 2,
    maximumExternalActions: 5,
  },
  retries: { maximumRetries: 2 },
  approvals: {
    rules: [
      {
        id: "deploy-production",
        description: "Production deploys need an operator",
        appliesTo: { kind: "external_side_effect", actionClass: "deployment" },
        decision: {
          kind: "require_approval",
          approver: { kind: "role", role: "operator" },
          grant: { kind: "once", expiresAfterSeconds: 900 },
        },
      },
    ],
  },
  verification: {
    required: true,
    requirements: ["unit_tests"],
    independentVerifierRequired: true,
  },
  retention: { class: "days_14" },
} as const satisfies PolicyManifest;

describe("policy schemas", () => {
  it("declares complete metadata for every exported schema", () => {
    expect(() => assertSchemaMetaComplete(POLICY_MANIFEST_SCHEMA_META)).not.toThrow();
    expect(() => assertSchemaMetaComplete(POLICY_DECISION_SCHEMA_META)).not.toThrow();
  });

  it("accepts the complete manifest", () => {
    const result = validatePolicyManifest(validManifest);
    expect(result.ok).toBe(true);
  });

  it("fails closed when network is omitted", () => {
    const { network: _network, ...withoutNetwork } = validManifest;
    const result = validatePolicyManifest(withoutNetwork);
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          path: "/network",
          code: "required_field",
          message: "network is required; absence never grants network access",
        },
      ],
    });
  });

  it("does not coerce malformed values", () => {
    const result = validatePolicyManifest({ ...validManifest, version: "1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe("/version");
  });

  it("preserves unknown fields verbatim, including nested fields", () => {
    const future = { mode: "future", values: [1, { untouched: true }] };
    const result = validatePolicyManifest({
      ...validManifest,
      futureTopLevel: future,
      network: { ...validManifest.network, futureNetworkRule: future },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.unknownFields).toEqual({
        "/futureTopLevel": future,
        "/network/futureNetworkRule": future,
      });
      expect(result.unknownFields["/futureTopLevel"]).toBe(future);
      expect(result.unknownFields["/network/futureNetworkRule"]).toBe(future);
    }
  });
});

describe("policy vocabulary", () => {
  it("exposes every named manifest section without aliases", () => {
    expect(POLICY_MANIFEST_SECTION_NAMES).toEqual([
      "resources",
      "filesystem",
      "applications",
      "network",
      "credentials",
      "external_side_effects",
      "spend",
      "runtime",
      "retries",
      "approvals",
      "verification",
      "retention",
    ]);
  });

  it("expresses every consequential side-effect class named by the requirements", () => {
    expect(EXTERNAL_SIDE_EFFECT_CLASSES).toEqual([
      "deployment",
      "production_database_change",
      "external_communication",
      "financial_obligation",
      "billing_modification",
      "content_publication",
      "customer_data_deletion",
      "access_control_change",
      "protected_branch_update",
      "infrastructure_purchase",
      "security_policy_change",
    ]);
    expect(validManifest.external_side_effects.rules.every((rule) => rule.approval === "required")).toBe(
      true,
    );
  });

  it("makes credential payload fields unassignable", () => {
    type SecretBearingPolicy = {
      readonly references: readonly [{
        readonly credentialId: string;
        readonly issuer: string;
        readonly scopes: readonly string[];
        readonly revocable: true;
        readonly lifetime: "short_lived";
        readonly expiresAt: string;
        readonly boundTo: { readonly kind: "capability"; readonly capability: string };
        readonly secret: string;
      }];
    };
    expectTypeOf<SecretBearingPolicy>().not.toMatchTypeOf<CredentialPolicy>();
  });
});

describe("policy decisions", () => {
  it("keeps denied and undetermined distinct while both carry fail-closed context", () => {
    const denied = {
      outcome: "denied",
      request: {
        action: "deploy",
        description: "Deploy service",
        target: "production",
        requestedBy: { kind: "system", component: "test" },
      },
      reason: { code: "explicit_deny", explanation: "Production deploys are denied" },
      controllingPolicy: { policyId: "policy-test" as PolicyId, version: 1 },
      availableOptions: [{ kind: "change_request", description: "Target staging instead" }],
    } as const satisfies PolicyDecision;
    const undetermined = {
      outcome: "undetermined",
      request: {
        action: "deploy",
        description: "Deploy service",
        target: "production",
        requestedBy: { kind: "system", component: "test" },
      },
      reason: { code: "unknown_action", explanation: "No rule recognizes this deploy type" },
      controllingPolicy: { policyId: "policy-test" as PolicyId, version: 1 },
      availableOptions: [{ kind: "request_policy_change", description: "Ask an owner to add a rule" }],
    } as const satisfies PolicyDecision;

    expect(denied.outcome).not.toBe(undetermined.outcome);
    expect([denied, undetermined].every((decision) => decision.availableOptions.length > 0)).toBe(true);
  });

  it("rejects a non-proceeding decision that omits next-step options", () => {
    const result = validatePolicyDecision({
      outcome: "undetermined",
      request: {
        action: "deploy",
        description: "Deploy service",
        requestedBy: { kind: "system", component: "test" },
      },
      reason: { code: "missing_context", explanation: "The target environment is unknown" },
      controllingPolicy: { policyId: "policy-test", version: 1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.path === "/availableOptions")).toBe(true);
  });
});
