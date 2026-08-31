/**
 * Vinci's inference lane declarations.
 *
 * This registry is a declaration of what we believe about each lane: every
 * `known` value should be traceable to something someone actually read, and
 * `unknown` is preferable to a guess. A fabricated value is the defect this
 * whole contract exists to prevent.
 */

import type {
  FrontierApiEndpoint,
  OpenWeightEndpoint,
  ModelEndpointSpec,
} from "./endpoint.ts";
import { deepFreeze } from "./deep-freeze.ts";

/**
 * Bedrock — Vinci's general frontier-model lane through AWS Bedrock.
 * Inference runs through external infrastructure.
 */
const bedrockEndpoint: FrontierApiEndpoint = {
  schemaVersion: 1,
  endpointId: "bedrock-general",
  sourceClass: "frontier_api",
  provider: "aws-bedrock",
  model: "anthropic.claude-3-5-sonnet-20241022-v2:0",
  modelRevision: { kind: "unknown" },
  // Bedrock is a multi-model gateway, so the served artifact is unknown.
  servedArtifact: { kind: "unknown" },
  capabilityProfile: {
    capabilities: ["text", "tool_use"],
    contextLimit: 200_000,
    toolSupport: true,
  },
  declaredCapabilities: [
    "structured_tool_use",
    "repository_editing",
    "long_horizon_recovery",
    "evidence_citation",
  ],
  credentials: {
    source: {
      kind: "managed-credential",
      credentialId: "bedrock-service-account",
    },
  },
  inferenceIsExternal: { kind: "known", value: true },
  // No protected-data approval record has been read for this lane. Unknown,
  // not false: "we have not checked" and "we checked and it is not approved"
  // are different facts, and only the second may deny on its own.
  approvedForProtectedData: { kind: "unknown" },
  rights: {
    trainingAllowed: { kind: "unknown" },
    evaluationAllowed: { kind: "unknown" },
    redistributionAllowed: { kind: "known", value: false },
    outputRetainedByProvider: { kind: "known", value: false },
    policySnapshotDigest: { kind: "unknown" },
  },
  validFrom: "2024-01-01T00:00:00.000Z",
  expiresAt: null,
  jurisdiction: { kind: "known", value: { jurisdiction: "US" } },
};

/**
 * OpenRouter — third-party API lane, fenced to vinci-worker cloud deployments.
 * Inference runs through external infrastructure (OpenRouter).
 */
const openrouterEndpoint: FrontierApiEndpoint = {
  schemaVersion: 1,
  endpointId: "openrouter-worker",
  sourceClass: "frontier_api",
  provider: "openrouter",
  model: "openai/gpt-4o",
  modelRevision: { kind: "unknown" },
  // OpenRouter is a multi-model gateway, so the served artifact is unknown.
  servedArtifact: { kind: "unknown" },
  capabilityProfile: {
    capabilities: ["text", "tool_use", "vision"],
    contextLimit: 128_000,
    toolSupport: true,
  },
  declaredCapabilities: [
    "structured_tool_use",
    "repository_editing",
    "evidence_citation",
  ],
  credentials: {
    source: {
      kind: "managed-credential",
      credentialId: "openrouter-api-key",
    },
  },
  inferenceIsExternal: { kind: "known", value: true },
  // No protected-data approval record has been read for this lane. Unknown,
  // not false: "we have not checked" and "we checked and it is not approved"
  // are different facts, and only the second may deny on its own.
  approvedForProtectedData: { kind: "unknown" },
  rights: {
    trainingAllowed: { kind: "unknown" },
    evaluationAllowed: { kind: "unknown" },
    redistributionAllowed: { kind: "known", value: false },
    outputRetainedByProvider: { kind: "unknown" },
    policySnapshotDigest: { kind: "unknown" },
  },
  validFrom: "2024-01-01T00:00:00.000Z",
  expiresAt: null,
  jurisdiction: { kind: "unknown" },
};

/**
 * Pod-served open-weight — locally hosted on Vinci's H200 GPU fleet.
 * Inference does NOT leave Vinci-controlled infrastructure.
 * Digests marked as placeholders and must be replaced with real values.
 */
const podEndpoint: OpenWeightEndpoint = {
  schemaVersion: 1,
  endpointId: "pod-openweight-local",
  sourceClass: "open_weight",
  weightsDigest: "sha256:placeholder-weights-do-not-use",
  tokenizerDigest: "sha256:placeholder-tokenizer-do-not-use",
  architectureDigest: "sha256:placeholder-architecture-do-not-use",
  servingImageDigest: {
    kind: "known",
    value: "sha256:placeholder-image-do-not-use",
  },
  quantizationDigest: { kind: "unknown" },
  capabilityProfile: {
    capabilities: ["text", "tool_use"],
    contextLimit: 128_000,
    toolSupport: true,
  },
  declaredCapabilities: [
    "structured_tool_use",
    "repository_editing",
    "evidence_citation",
  ],
  credentials: {
    source: {
      kind: "environment-variable",
      variableName: "POD_INFERENCE_URL",
    },
  },
  inferenceIsExternal: { kind: "known", value: false },
  // No protected-data approval record has been read for this lane. Unknown,
  // not false: "we have not checked" and "we checked and it is not approved"
  // are different facts, and only the second may deny on its own.
  approvedForProtectedData: { kind: "unknown" },
  rights: {
    trainingAllowed: { kind: "known", value: false },
    evaluationAllowed: { kind: "known", value: true },
    redistributionAllowed: { kind: "known", value: false },
    outputRetainedByProvider: { kind: "known", value: false },
    policySnapshotDigest: {
      kind: "known",
      value: "sha256:placeholder-policy-digest",
    },
  },
  validFrom: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
};

/**
 * Registry of Vinci's real inference endpoints.
 * Each endpoint declares the facts we know with certainty; `unknown` marks
 * what we have not yet verified.
 */
export const VINCI_ENDPOINTS = deepFreeze([
  bedrockEndpoint,
  openrouterEndpoint,
  podEndpoint,
] as const satisfies readonly ModelEndpointSpec[]);

/**
 * Look up an endpoint by its id.
 */
export function endpointById(id: string): ModelEndpointSpec | undefined {
  return VINCI_ENDPOINTS.find((ep) => ep.endpointId === id);
}
