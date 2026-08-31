import { workOrderDigest, type ExecutionSpec, type WorkOrder } from "./index.ts";

/** Shared test fixtures. Not exported from the package; tests only. */
export const validOrder = (): WorkOrder => ({
  schemaVersion: 3,
  contractVersion: 1,
  id: "wo-1",
  request: "Add rate limiting to the public API.",
  scope: "The /v1 HTTP handlers only; no infrastructure or DNS changes.",
  acceptanceCriteria: [
    { id: "c.limits", statement: "Requests over 100/min receive 429.", verifiedBy: "Integration test against a live handler." },
  ],
  grantedAuthority: [
    "edit files under src/api", "run the test suite",
    "tool:read", "tool:edit", "tool:bash",
    "repo:github.com/getsimpledirect/vinci-contracts", "branch:feat/*", "promotion:pull_request",
  ],
  attentionBudget: { interruptions: 3, decisions: 2, onExhaustion: "block" },
  requestedBy: { kind: "user", userId: "u-1" },
  owner: { kind: "user", userId: "owner-1" },
  riskClassification: {
    level: "low",
    consequentialClasses: [],
    rationale: "Changes are confined to local request handling and are fully testable.",
  },
  verifier: { kind: "none", verifierId: null, independence: "none" },
  rollbackConditions: [],
  escalationRules: [
    { when: "verifier_unavailable", to: { kind: "user", userId: "owner-1" }, within: 900 },
    { when: "policy_undetermined", to: { kind: "user", userId: "owner-1" }, within: 300 },
  ],
  issuedAt: "2026-08-23T12:00:00.000Z",
  expiresAt: "2026-08-24T12:00:00.000Z",
});

export const validSpec = (order: WorkOrder = validOrder()): ExecutionSpec => ({
  schemaVersion: 1,
  workOrderId: order.id,
  workOrderDigest: workOrderDigest(order),
  repository: { host: "github.com", owner: "getsimpledirect", name: "vinci-contracts" },
  baseRef: "main",
  baseCommit: "60bd211a3f4c5d6e7f8091a2b3c4d5e6f7a8b9c0",
  targetBranch: "feat/rate-limit",
  modelClass: "forte",
  resourceBounds: { budgetMicrousd: 12_500_000, maxRuntimeS: 3600, deadline: "2026-08-23T14:00:00.000Z" },
  tools: ["read", "edit", "bash"],
  inputArtifacts: [{ id: "design-note", digest: "a".repeat(64) }],
  requiredCapabilities: ["structuredEvidence", "safeResume"],
  output: "branch",
  evidence: { required: true },
  promotion: "pull_request",
  issuedAt: "2026-08-23T12:05:00.000Z",
});

/** Reverse every object's key order, recursively. Same content, different insertion order. */
export function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]));
  }
  return value;
}

