import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  EXTERNAL_SIDE_EFFECT_CLASSES,
  POLICY_DECISION_SCHEMA_META,
  POLICY_MANIFEST_SECTION_NAMES,
  POLICY_MANIFEST_SCHEMA_META,
  assertSchemaMetaComplete,
  evaluatePolicyDecision,
  validatePolicyDecision,
  validatePolicyManifest,
  type CredentialPolicy,
  type PolicyActionRequest,
  type PolicyDecision,
  type PolicyId,
  type PolicyManifest,
} from "./index.ts";
import * as policySchema from "./schema.ts";

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
          grant: { kind: "allow-once" },
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
      expect(result.unknownFields["/futureTopLevel"]).toEqual(future);
      expect(result.unknownFields["/network/futureNetworkRule"]).toEqual(future);
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

describe("evaluatePolicyDecision", () => {
  const request = {
    action: "deploy",
    description: "Deploy the service",
    target: "production",
    requestedBy: { kind: "system", component: "policy-test" },
  } as const satisfies PolicyActionRequest;

  function manifestWithRules(
    rules: PolicyManifest["approvals"]["rules"],
    version = 1,
  ): PolicyManifest {
    return {
      ...structuredClone(validManifest),
      version,
      approvals: { rules },
    };
  }

  const allowDeploy = {
    id: "allow-deploy",
    description: "Deploy is safe",
    appliesTo: { kind: "capability", capability: "deploy" },
    decision: { kind: "allow_automatically" },
  } as const;

  const denyDeploy = {
    id: "deny-deploy",
    description: "Deploy is forbidden",
    appliesTo: { kind: "capability", capability: "deploy" },
    decision: { kind: "deny" },
  } as const;

  const approveDeploy = {
    id: "approve-deploy",
    description: "Deploy needs an operator",
    appliesTo: { kind: "capability", capability: "deploy" },
    decision: {
      kind: "require_approval",
      approver: { kind: "role", role: "operator" },
      grant: { kind: "allow-once" },
    },
  } as const;

  it("allows a genuinely exact capability match", () => {
    const decision = evaluatePolicyDecision(manifestWithRules([allowDeploy]), request);

    expect(decision).toMatchObject({
      outcome: "allowed",
      request,
      reason: { code: "automatic_allow" },
      controllingPolicy: { policyId: "policy-test", version: 1 },
    });
  });

  it.each(["deployment", "deploy-production", "deploy.production"])(
    "does not prefix-match the near-miss capability %s",
    (action) => {
      const decision = evaluatePolicyDecision(manifestWithRules([allowDeploy]), {
        ...request,
        action,
      });

      expect(decision.outcome).toBe("undetermined");
      expect(decision.reason.code).toBe("unknown_action");
    },
  );

  it("uses the most restrictive decision across multiple matching rules", () => {
    const decision = evaluatePolicyDecision(
      manifestWithRules([allowDeploy, approveDeploy, denyDeploy]),
      request,
    );

    expect(decision.outcome).toBe("denied");
    expect(decision.reason.code).toBe("explicit_deny");
  });

  it("prefers approval over automatic allowance when no deny matches", () => {
    const decision = evaluatePolicyDecision(
      manifestWithRules([allowDeploy, approveDeploy]),
      request,
    );

    expect(decision.outcome).toBe("denied");
    expect(decision.reason.code).toBe("approval_required");
  });

  it("returns approval workflow hints and identifies the matched grant", () => {
    const decision = evaluatePolicyDecision(manifestWithRules([approveDeploy]), request);

    expect(decision).toMatchObject({
      outcome: "denied",
      reason: { code: "approval_required" },
      grant: { kind: "allow-once" },
      availableOptions: [
        { kind: "request_approval", description: expect.stringContaining("allow-once") },
        { kind: "contact_policy_owner" },
      ],
    });
    expect(validatePolicyDecision(decision).ok).toBe(true);
  });

  it("denies a genuinely exact deny match", () => {
    const decision = evaluatePolicyDecision(manifestWithRules([denyDeploy]), request);

    expect(decision.outcome).toBe("denied");
    expect(decision.reason.code).toBe("explicit_deny");
  });

  it("returns unknown_action when no rule matches", () => {
    const decision = evaluatePolicyDecision(manifestWithRules([]), request);

    expect(decision.outcome).toBe("undetermined");
    expect(decision.reason.code).toBe("unknown_action");
  });

  it("uses any_action only as a fallback behind a specific match", () => {
    const anyDeny = {
      id: "default-deny",
      description: "Deny anything not named",
      appliesTo: { kind: "any_action" },
      decision: { kind: "deny" },
    } as const;
    const specific = evaluatePolicyDecision(manifestWithRules([anyDeny, allowDeploy]), request);
    const fallback = evaluatePolicyDecision(manifestWithRules([anyDeny, allowDeploy]), {
      ...request,
      action: "unlisted-action",
    });

    expect(specific.outcome).toBe("allowed");
    expect(specific.reason.code).toBe("automatic_allow");
    expect(fallback.outcome).toBe("denied");
    expect(fallback.reason.code).toBe("explicit_deny");
  });

  it("matches a canonical external-side-effect class exactly", () => {
    const decision = evaluatePolicyDecision(
      manifestWithRules([validManifest.approvals.rules[0]]),
      { ...request, action: "deployment" },
    );

    expect(decision.outcome).toBe("denied");
    expect(decision.reason.code).toBe("approval_required");
  });

  it("reports malformed_policy with the first validation issue", () => {
    const decision = evaluatePolicyDecision(
      { ...validManifest, version: 0 } as unknown as PolicyManifest,
      request,
    );

    expect(decision.outcome).toBe("undetermined");
    expect(decision.reason.code).toBe("malformed_policy");
    expect(decision.reason.explanation).toContain("/version");
    expect(decision.reason.explanation).toContain("expected a positive integer");
  });

  it("reports unsupported_policy_version for a valid future manifest", () => {
    const decision = evaluatePolicyDecision(manifestWithRules([allowDeploy], 2), request);

    expect(decision.outcome).toBe("undetermined");
    expect(decision.reason.code).toBe("unsupported_policy_version");
  });

  it("reports missing_context when the action cannot map to a capability or side-effect class", () => {
    const decision = evaluatePolicyDecision(
      manifestWithRules([validManifest.approvals.rules[0]]),
      { ...request, action: "not_a_known_side_effect" },
    );

    expect(decision.outcome).toBe("undetermined");
    expect(decision.reason.code).toBe("missing_context");
  });

  it("reports conflicting_rules for incompatible approval requirements", () => {
    const conflictingApproval = {
      ...approveDeploy,
      id: "approve-deploy-security",
      decision: {
        ...approveDeploy.decision,
        approver: { kind: "role", role: "security" },
      },
    } as const;
    const decision = evaluatePolicyDecision(
      manifestWithRules([approveDeploy, conflictingApproval]),
      request,
    );

    expect(decision.outcome).toBe("undetermined");
    expect(decision.reason.code).toBe("conflicting_rules");
  });

  it("reports evaluator_error instead of throwing an evaluator exception", () => {
    const validation = vi.spyOn(policySchema, "validatePolicyManifest");
    try {
      validation.mockImplementationOnce(() => {
        throw new Error("forced evaluator failure");
      });
      let decision: PolicyDecision | undefined;

      expect(() => {
        decision = evaluatePolicyDecision(validManifest, request);
      }).not.toThrow();
      expect(decision?.outcome).toBe("undetermined");
      expect(decision?.reason.code).toBe("evaluator_error");
    } finally {
      validation.mockRestore();
    }
  });

  it("reads request fields as own data and never invokes accessors", () => {
    const hostileRequest = {
      get action(): never {
        throw new Error("request getter must not run");
      },
      description: request.description,
      requestedBy: request.requestedBy,
    } as unknown as PolicyActionRequest;

    expect(() => evaluatePolicyDecision(manifestWithRules([allowDeploy]), hostileRequest)).not.toThrow();
    expect(evaluatePolicyDecision(manifestWithRules([allowDeploy]), hostileRequest).reason.code).toBe(
      "missing_context",
    );
  });
});

describe("credential material cannot reach a policy", () => {
  // A denylist of known secret-ish field names is the wrong shape for a
  // security boundary: it is only as good as the imagination of whoever wrote
  // the list. These are the names real providers actually use.
  const REAL_WORLD_SECRET_FIELDS = [
    "clientSecret", // OAuth
    "secretAccessKey", // AWS
    "privateKeyPem", // service accounts
    "connectionString", // databases, often with the password inline
    "webhookSecret", // GitHub, Stripe
    "sasToken", // Azure
  ];

  it.each(REAL_WORLD_SECRET_FIELDS)("rejects a secret under %s", (field) => {
    const manifest = structuredClone(validManifest);
    (manifest.credentials.references[0] as Record<string, unknown>)[field] = "s3cr3t-value";

    const result = validatePolicyManifest(manifest);
    expect(result.ok).toBe(false);
  });

  it("never preserves an unrecognised credential field as an unknown field", () => {
    // The failure this guards is subtler than acceptance: if validation passes
    // and the field is retained in unknownFields, the secret is now inside a
    // record that FR-6 says gets exported and SR-3 says must never carry
    // secrets. Preserving it is worse than dropping it.
    const manifest = structuredClone(validManifest);
    (manifest.credentials.references[0] as Record<string, unknown>).clientSecret = "s3cr3t-value";

    const result = validatePolicyManifest(manifest);
    if (result.ok) {
      expect(JSON.stringify(result.unknownFields)).not.toContain("s3cr3t-value");
      throw new Error("a credential carrying secret material must not validate");
    }
    expect(result.issues.some((i) => i.code === "credential_material_forbidden")).toBe(true);
  });

  it("still accepts the reference-and-metadata shape it is supposed to allow", () => {
    // The fix must not make the credentials section unusable — a legitimate
    // reference with only safe metadata has to keep validating.
    expect(validatePolicyManifest(structuredClone(validManifest)).ok).toBe(true);
  });
});

describe("branded identifiers use the constructor rule in policy records", () => {
  const manifestWithRunBinding = (runId: string) => ({
    ...validManifest,
    credentials: {
      references: [{
        ...validManifest.credentials.references[0],
        boundTo: { kind: "run", runId },
      }],
    },
  });

  const manifestWithNamedApprover = (userId: string) => {
    const rule = validManifest.approvals.rules[0];
    return {
      ...validManifest,
      approvals: {
        rules: [{
          ...rule,
          decision: {
            ...rule.decision,
            approver: { kind: "named_person", userId },
          },
        }],
      },
    };
  };

  const allowedDecision = (requestedBy: Record<string, unknown>, policyId = "policy-test") => ({
    outcome: "allowed",
    request: { action: "read", description: "Read a repository", requestedBy },
    reason: { code: "automatic_allow", explanation: "Read access is allowed" },
    controllingPolicy: { policyId, version: 1 },
  });

  it.each([
    {
      field: "CredentialBinding.runId",
      path: "/credentials/references/0/boundTo/runId",
      validate: validatePolicyManifest,
      bad: manifestWithRunBinding("has space"),
      good: manifestWithRunBinding("run-1"),
    },
    {
      field: "ApprovalRequirement.userId",
      path: "/approvals/rules/0/decision/approver/userId",
      validate: validatePolicyManifest,
      bad: manifestWithNamedApprover("a/b"),
      good: manifestWithNamedApprover("user-1"),
    },
    {
      field: "PolicyManifest.policyId",
      path: "/policyId",
      validate: validatePolicyManifest,
      bad: { ...validManifest, policyId: "café" },
      good: { ...validManifest, policyId: "policy-1" },
    },
    {
      field: "Actor.userId",
      path: "/request/requestedBy/userId",
      validate: validatePolicyDecision,
      bad: allowedDecision({ kind: "user", userId: "-leading" }),
      good: allowedDecision({ kind: "user", userId: "user-1" }),
    },
    {
      field: "Actor.deviceId",
      path: "/request/requestedBy/deviceId",
      validate: validatePolicyDecision,
      bad: allowedDecision({ kind: "user", userId: "user-1", deviceId: "_under" }),
      good: allowedDecision({ kind: "user", userId: "user-1", deviceId: "device-1" }),
    },
    {
      field: "Actor.workerId",
      path: "/request/requestedBy/workerId",
      validate: validatePolicyDecision,
      bad: allowedDecision({ kind: "worker", workerId: "x".repeat(200) }),
      good: allowedDecision({ kind: "worker", workerId: "worker-1" }),
    },
    {
      field: "Actor.policyId",
      path: "/request/requestedBy/policyId",
      validate: validatePolicyDecision,
      bad: allowedDecision({ kind: "policy", policyId: "has space", policyVersion: 1 }),
      good: allowedDecision({ kind: "policy", policyId: "policy-1", policyVersion: 1 }),
    },
    {
      field: "PolicyReference.policyId",
      path: "/controllingPolicy/policyId",
      validate: validatePolicyDecision,
      bad: allowedDecision({ kind: "system", component: "test" }, "a/b"),
      good: allowedDecision({ kind: "system", component: "test" }, "policy-1"),
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
