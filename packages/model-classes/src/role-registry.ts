/** Vinci's closed set of institutional model-role declarations. */

import type { ModelRoleSpec } from "./role.ts";
import { deepFreeze } from "./deep-freeze.ts";

const mleImplementationWorker: ModelRoleSpec = {
  schemaVersion: 1,
  roleId: "mle-implementation-worker",
  taskClass: "mle-implementation",
  // Endpoint capabilities: what the inference endpoint itself must provide
  requiredCapabilities: [
    "structured_tool_use",
  ],
  // Harness capabilities: what the calling system must provide
  // (repository_editing and long_horizon_recovery are system/framework features)
  requiredHarnessCapabilities: [
    "repository_editing",
    "long_horizon_recovery",
  ],
  minimumContextTokens: 64_000,
  riskClass: "medium",
  dataPolicy: {
    externalProviderAllowed: true,
    outputRetentionAllowed: false,
    // Conservative default pending confirmation of the role's data profile.
    processesProtectedData: false,
  },
  qualityPolicy: {
    minimumVerifiedSuccessRate: 0.8,
    maximumFalseClaimRate: 0.05,
  },
  economicPolicy: {
    maximumCostPerVerifiedSuccessUsd: 5,
    maximumP95WallSeconds: 600,
  },
  fallbackRoleIds: [],
};

const adversarialReviewer: ModelRoleSpec = {
  schemaVersion: 1,
  roleId: "adversarial-reviewer",
  taskClass: "adversarial-review",
  // Endpoint capabilities: what the inference endpoint itself must provide
  requiredCapabilities: ["structured_tool_use"],
  // Harness capabilities: what the calling system must provide
  // (evidence_citation is a prompt/scaffold feature, not an endpoint property)
  requiredHarnessCapabilities: ["evidence_citation"],
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
    maximumP95WallSeconds: 180,
  },
  fallbackRoleIds: [],
};

const cloudWorker: ModelRoleSpec = {
  schemaVersion: 1,
  roleId: "cloud-worker",
  taskClass: "cloud-work",
  requiredCapabilities: [],
  requiredHarnessCapabilities: [],
  minimumContextTokens: 1,
  riskClass: "low",
  dataPolicy: {
    externalProviderAllowed: true,
    // This role imposes no retention constraint, so endpoints whose retention
    // policy is unknown remain eligible.
    outputRetentionAllowed: true,
    processesProtectedData: false,
  },
  qualityPolicy: {
    minimumVerifiedSuccessRate: 0.7,
    maximumFalseClaimRate: 0.1,
  },
  economicPolicy: {
    maximumCostPerVerifiedSuccessUsd: 3,
    maximumP95WallSeconds: 300,
  },
  fallbackRoleIds: [],
};

/**
 * Teacher trajectory producer — generates training data from model outputs.
 *
 * This role generates training data by curating and verifying model outputs
 * as examples for training. It is high-risk because using a provider's output
 * as training data is a contractual rights question that cannot be undone if
 * answered incorrectly: training data becomes part of a model's permanent history.
 * The trainingAllowed and evaluationAllowed rights must be explicitly verified
 * for each endpoint before this role can execute.
 */
const teacherTrajectoryProducer: ModelRoleSpec = {
  schemaVersion: 1,
  roleId: "teacher-trajectory-producer",
  taskClass: "teacher-trajectory-generation",
  // Endpoint capabilities: empty; this role does not require specific model features
  requiredCapabilities: [],
  // Harness capabilities: what the calling system must provide
  // (evidence_citation is a prompt/scaffold feature for curating trajectories)
  requiredHarnessCapabilities: ["evidence_citation"],
  minimumContextTokens: 8_000,
  riskClass: "high",
  dataPolicy: {
    externalProviderAllowed: true,
    // This role does not impose a retention constraint on the endpoint itself;
    // the role retains training data locally, not requiring the endpoint to retain outputs.
    outputRetentionAllowed: true,
    // Conservative default: training data generation involves curating outputs,
    // and whether those outputs contain protected data depends on the source
    // prompts. Until explicitly confirmed, assume unknown sensitivity.
    processesProtectedData: false,
  },
  qualityPolicy: {
    minimumVerifiedSuccessRate: 0.85,
    maximumFalseClaimRate: 0.03,
  },
  economicPolicy: {
    maximumCostPerVerifiedSuccessUsd: 4.5,
    maximumP95WallSeconds: 300,
  },
  fallbackRoleIds: [],
};

export const VINCI_ROLES = deepFreeze([
  mleImplementationWorker,
  adversarialReviewer,
  cloudWorker,
  teacherTrajectoryProducer,
] as const satisfies readonly ModelRoleSpec[]);

/** Look up a Vinci model role by its stable identifier. */
export function roleById(id: string): ModelRoleSpec | undefined {
  return VINCI_ROLES.find((role) => role.roleId === id);
}
