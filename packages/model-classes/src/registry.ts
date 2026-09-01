/**
 * Vinci's inference lane declarations.
 *
 * This registry is a declaration of what we believe about each lane: every
 * `known` value should be traceable to something someone actually read, and
 * `unknown` is preferable to a guess. A fabricated value is the defect this
 * whole contract exists to prevent.
 */

import type {
  OpenWeightEndpoint,
  ModelEndpointSpec,
} from "./endpoint.ts";
import { deepFreeze } from "./deep-freeze.ts";

/**
 * Forte class, Deepinfra lane — GLM-5.2 on DeepInfra.
 * Inference runs through external infrastructure (DeepInfra).
 * Open-weight model served via third-party API.
 */
const forteDeepinfraEndpoint: OpenWeightEndpoint = {
  schemaVersion: 1,
  endpointId: "forte-deepinfra",
  sourceClass: "open_weight",
  serving: {
    kind: "third_party_api",
    provider: "deepinfra",
    model: "zai-org/GLM-5.2",
    modelRevision: { kind: "unknown" },
    jurisdiction: { kind: "unknown" },
  },
  weightsDigest: { kind: "unknown" },
  tokenizerDigest: { kind: "unknown" },
  architectureDigest: { kind: "unknown" },
  servingImageDigest: { kind: "unknown" },
  quantizationDigest: { kind: "unknown" },
  capabilityProfile: {
    // EVIDENCE-BACKED: text is universal (all LLMs support text).
    // tool_use: app/api/v1/chat/completions/route.ts forwards tool definitions
    // and tool results over the OpenAI-compatible protocol to the upstream
    // provider, where they are processed. The forwarding path and provider
    // acceptance both are required for tool_use to be true; neither alone suffices.
    capabilities: ["text", "tool_use"],
    // From vinci-chat/config/classes.yaml line 26: forte declares 1000000 tokens.
    contextLimit: 1000000,
    toolSupport: true,
  },
  // DECISION: structured_tool_use is arguably evidenced (tool forwarding); it was kept.
  // repository_editing: NO EVIDENCE. These are inference endpoints; vinci-code
  // (PR #69, lib/code/capabilities.ts) has its own registry for agent work.
  // evidence_citation: NO EVIDENCE found. No citations are handled by this layer.
  declaredCapabilities: ["structured_tool_use"],
  credentials: {
    source: {
      kind: "managed-credential",
      credentialId: "deepinfra-api-key",
    },
  },
  inferenceIsExternal: { kind: "known", value: true },
  approvedForProtectedData: { kind: "unknown" },
  rights: {
    // DECLARED BY GEORGE, 2026-08-31: he checked DeepInfra's, Fireworks' and
    // OpenRouter's terms and states all three permit training and evaluation on
    // their output. A declaration, not a proof -- recorded with its author and
    // date so it is auditable, and void if the declaration is false.
    trainingAllowed: { kind: "known", value: true },
    evaluationAllowed: { kind: "known", value: true },
    // NOT covered by that check. Redistribution is a separate permission and
    // was not spoken to; inferring it from the other two is how a rights field
    // gets fabricated.
    redistributionAllowed: { kind: "unknown" },
    // EVIDENCE-BACKED, not declared. Every adapter in vinci-chat carries
    // zdr = true, and FoundationProxy.selectAdapter REFUSES any provider not in
    // APPROVED_ZDR -- so non-retention is an enforced invariant of the serving
    // path, which is stronger than a terms reading.
    outputRetainedByProvider: { kind: "known", value: false },
    // No document snapshot was taken. Writing a digest here would fabricate an
    // audit trail for a reading nobody can re-check.
    policySnapshotDigest: { kind: "unknown" },
  },
  validFrom: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
};

/**
 * Forte class, Fireworks lane — GLM-5.2 on Fireworks.
 * Inference runs through external infrastructure (Fireworks).
 * Open-weight model served via third-party API.
 * This is the primary fallback for Forte when DeepInfra is unavailable.
 *
 * Note: The canonical model identifier is zai-org/GLM-5.2 (same as DeepInfra).
 * The vinci-chat config maps this to account-specific routing paths at runtime.
 */
const forteFireworksEndpoint: OpenWeightEndpoint = {
  schemaVersion: 1,
  endpointId: "forte-fireworks",
  sourceClass: "open_weight",
  serving: {
    kind: "third_party_api",
    provider: "fireworks",
    model: "zai-org/GLM-5.2",
    modelRevision: { kind: "unknown" },
    jurisdiction: { kind: "unknown" },
  },
  weightsDigest: { kind: "unknown" },
  tokenizerDigest: { kind: "unknown" },
  architectureDigest: { kind: "unknown" },
  servingImageDigest: { kind: "unknown" },
  quantizationDigest: { kind: "unknown" },
  capabilityProfile: {
    // EVIDENCE-BACKED: text is universal (all LLMs support text).
    // tool_use: app/api/v1/chat/completions/route.ts forwards tool definitions
    // and tool results over the OpenAI-compatible protocol to the upstream
    // provider, where they are processed.
    capabilities: ["text", "tool_use"],
    // From vinci-chat/config/classes.yaml line 26: forte declares 1000000 tokens.
    contextLimit: 1000000,
    toolSupport: true,
  },
  // DECISION: structured_tool_use is arguably evidenced (tool forwarding); it was kept.
  // repository_editing and evidence_citation have no evidence and were removed.
  declaredCapabilities: ["structured_tool_use"],
  credentials: {
    source: {
      kind: "managed-credential",
      credentialId: "fireworks-api-key",
    },
  },
  inferenceIsExternal: { kind: "known", value: true },
  approvedForProtectedData: { kind: "unknown" },
  rights: {
    // DECLARED BY GEORGE, 2026-08-31: he checked DeepInfra's, Fireworks' and
    // OpenRouter's terms and states all three permit training and evaluation on
    // their output. A declaration, not a proof -- recorded with its author and
    // date so it is auditable, and void if the declaration is false.
    trainingAllowed: { kind: "known", value: true },
    evaluationAllowed: { kind: "known", value: true },
    // NOT covered by that check. Redistribution is a separate permission and
    // was not spoken to; inferring it from the other two is how a rights field
    // gets fabricated.
    redistributionAllowed: { kind: "unknown" },
    // EVIDENCE-BACKED, not declared. Every adapter in vinci-chat carries
    // zdr = true, and FoundationProxy.selectAdapter REFUSES any provider not in
    // APPROVED_ZDR -- so non-retention is an enforced invariant of the serving
    // path, which is stronger than a terms reading.
    outputRetainedByProvider: { kind: "known", value: false },
    // No document snapshot was taken. Writing a digest here would fabricate an
    // audit trail for a reading nobody can re-check.
    policySnapshotDigest: { kind: "unknown" },
  },
  validFrom: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
};

/**
 * Vision class, DeepInfra lane — Qwen3-VL-30B-A3B on DeepInfra.
 * Inference runs through external infrastructure (DeepInfra).
 * Internal-only image-description preprocessor for text-only Forte occupant.
 * Open-weight model served via third-party API.
 */
const visionDeepinfraEndpoint: OpenWeightEndpoint = {
  schemaVersion: 1,
  endpointId: "vision-deepinfra",
  sourceClass: "open_weight",
  serving: {
    kind: "third_party_api",
    provider: "deepinfra",
    model: "Qwen/Qwen3-VL-30B-A3B-Instruct",
    modelRevision: { kind: "unknown" },
    jurisdiction: { kind: "unknown" },
  },
  weightsDigest: { kind: "unknown" },
  tokenizerDigest: { kind: "unknown" },
  architectureDigest: { kind: "unknown" },
  servingImageDigest: { kind: "unknown" },
  quantizationDigest: { kind: "unknown" },
  capabilityProfile: {
    // EVIDENCE-BACKED: text is universal; vision is declared because this model
    // is Qwen3-VL-30B-A3B-Instruct, a multimodal model, and classes.yaml line 142
    // declares multimodal: true for this class. tool_use is NOT declared for vision
    // because these image-description outputs are fed only to Forte, which handles tools;
    // vision itself does not need tool support.
    capabilities: ["text", "vision"],
    // From vinci-chat/config/classes.yaml line 145: vision declares 262144 tokens.
    contextLimit: 262144,
    toolSupport: true,
  },
  // vision: evidenced by the model being multimodal.
  // structured_tool_use and evidence_citation: no evidence, removed.
  declaredCapabilities: ["vision"],
  credentials: {
    source: {
      kind: "managed-credential",
      credentialId: "deepinfra-api-key",
    },
  },
  inferenceIsExternal: { kind: "known", value: true },
  approvedForProtectedData: { kind: "unknown" },
  rights: {
    // DECLARED BY GEORGE, 2026-08-31: he checked DeepInfra's, Fireworks' and
    // OpenRouter's terms and states all three permit training and evaluation on
    // their output. A declaration, not a proof -- recorded with its author and
    // date so it is auditable, and void if the declaration is false.
    trainingAllowed: { kind: "known", value: true },
    evaluationAllowed: { kind: "known", value: true },
    // NOT covered by that check. Redistribution is a separate permission and
    // was not spoken to; inferring it from the other two is how a rights field
    // gets fabricated.
    redistributionAllowed: { kind: "unknown" },
    // EVIDENCE-BACKED, not declared. Every adapter in vinci-chat carries
    // zdr = true, and FoundationProxy.selectAdapter REFUSES any provider not in
    // APPROVED_ZDR -- so non-retention is an enforced invariant of the serving
    // path, which is stronger than a terms reading.
    outputRetainedByProvider: { kind: "known", value: false },
    // No document snapshot was taken. Writing a digest here would fabricate an
    // audit trail for a reading nobody can re-check.
    policySnapshotDigest: { kind: "unknown" },
  },
  validFrom: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
};

/**
 * Vision class, OpenRouter lane — Qwen3-VL-30B-A3B on OpenRouter.
 * Inference runs through external infrastructure (OpenRouter).
 * Internal-only image-description preprocessor for text-only Forte occupant.
 * Open-weight model served via third-party API.
 *
 * Note: The canonical model identifier is Qwen/Qwen3-VL-30B-A3B-Instruct (same as DeepInfra).
 * OpenRouter may use lowercase casing in their routing; the gateway translates at runtime.
 *
 * ⚠️ NON-FUNCTIONAL — This fallback is currently non-functional per issue #236.
 * See vinci-chat/config/classes.yaml lines 117-139 for the detailed explanation.
 * The config line is retained so the intended routing shape stays visible;
 * runtime behavior is unchanged. Vision fails closed by design — it refuses to
 * let the text-only model guess at an image.
 */
const visionOpenrouterEndpoint: OpenWeightEndpoint = {
  schemaVersion: 1,
  endpointId: "vision-openrouter",
  sourceClass: "open_weight",
  serving: {
    kind: "third_party_api",
    provider: "openrouter",
    model: "Qwen/Qwen3-VL-30B-A3B-Instruct",
    modelRevision: { kind: "unknown" },
    jurisdiction: { kind: "unknown" },
  },
  weightsDigest: { kind: "unknown" },
  tokenizerDigest: { kind: "unknown" },
  architectureDigest: { kind: "unknown" },
  servingImageDigest: { kind: "unknown" },
  quantizationDigest: { kind: "unknown" },
  capabilityProfile: {
    // EVIDENCE-BACKED: text is universal; vision is declared for the same reason
    // as the DeepInfra lane (multimodal model, classes.yaml line 142).
    capabilities: ["text", "vision"],
    // From vinci-chat/config/classes.yaml line 145: vision declares 262144 tokens.
    contextLimit: 262144,
    toolSupport: true,
  },
  // vision: evidenced by the model being multimodal.
  // structured_tool_use and evidence_citation: no evidence, removed.
  declaredCapabilities: ["vision"],
  credentials: {
    source: {
      kind: "managed-credential",
      credentialId: "openrouter-api-key",
    },
  },
  inferenceIsExternal: { kind: "known", value: true },
  approvedForProtectedData: { kind: "unknown" },
  rights: {
    // DECLARED BY GEORGE, 2026-08-31: he checked DeepInfra's, Fireworks' and
    // OpenRouter's terms and states all three permit training and evaluation on
    // their output. A declaration, not a proof -- recorded with its author and
    // date so it is auditable, and void if the declaration is false.
    trainingAllowed: { kind: "known", value: true },
    evaluationAllowed: { kind: "known", value: true },
    // NOT covered by that check. Redistribution is a separate permission and
    // was not spoken to; inferring it from the other two is how a rights field
    // gets fabricated.
    redistributionAllowed: { kind: "unknown" },
    // EVIDENCE-BACKED, not declared. Every adapter in vinci-chat carries
    // zdr = true, and FoundationProxy.selectAdapter REFUSES any provider not in
    // APPROVED_ZDR -- so non-retention is an enforced invariant of the serving
    // path, which is stronger than a terms reading.
    outputRetainedByProvider: { kind: "known", value: false },
    // No document snapshot was taken. Writing a digest here would fabricate an
    // audit trail for a reading nobody can re-check.
    policySnapshotDigest: { kind: "unknown" },
  },
  validFrom: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
};

/**
 * Mezzo class, DeepInfra lane — DeepSeek-V4-Flash on DeepInfra.
 * Inference runs through external infrastructure (DeepInfra).
 * Public opt-in lighter class for quick everyday tasks.
 * Open-weight model served via third-party API.
 * DeepInfra is the only approved ZDR route for this class.
 */
const mezzoDeepinfraEndpoint: OpenWeightEndpoint = {
  schemaVersion: 1,
  endpointId: "mezzo-deepinfra",
  sourceClass: "open_weight",
  serving: {
    kind: "third_party_api",
    provider: "deepinfra",
    model: "deepseek-ai/DeepSeek-V4-Flash-0731",
    modelRevision: { kind: "unknown" },
    jurisdiction: { kind: "unknown" },
  },
  weightsDigest: { kind: "unknown" },
  tokenizerDigest: { kind: "unknown" },
  architectureDigest: { kind: "unknown" },
  servingImageDigest: { kind: "unknown" },
  quantizationDigest: { kind: "unknown" },
  capabilityProfile: {
    // EVIDENCE-BACKED: text is universal (all LLMs support text).
    // tool_use: app/api/v1/chat/completions/route.ts forwards tool definitions
    // and tool results over the OpenAI-compatible protocol to the upstream provider.
    capabilities: ["text", "tool_use"],
    // From vinci-chat/config/classes.yaml line 187: mezzo declares 1000000 tokens.
    contextLimit: 1000000,
    toolSupport: true,
  },
  // DECISION: structured_tool_use is arguably evidenced (tool forwarding); it was kept.
  // repository_editing and evidence_citation: no evidence, removed.
  declaredCapabilities: ["structured_tool_use"],
  credentials: {
    source: {
      kind: "managed-credential",
      credentialId: "deepinfra-api-key",
    },
  },
  inferenceIsExternal: { kind: "known", value: true },
  approvedForProtectedData: { kind: "unknown" },
  rights: {
    // DECLARED BY GEORGE, 2026-08-31: he checked DeepInfra's, Fireworks' and
    // OpenRouter's terms and states all three permit training and evaluation on
    // their output. A declaration, not a proof -- recorded with its author and
    // date so it is auditable, and void if the declaration is false.
    trainingAllowed: { kind: "known", value: true },
    evaluationAllowed: { kind: "known", value: true },
    // NOT covered by that check. Redistribution is a separate permission and
    // was not spoken to; inferring it from the other two is how a rights field
    // gets fabricated.
    redistributionAllowed: { kind: "unknown" },
    // EVIDENCE-BACKED, not declared. Every adapter in vinci-chat carries
    // zdr = true, and FoundationProxy.selectAdapter REFUSES any provider not in
    // APPROVED_ZDR -- so non-retention is an enforced invariant of the serving
    // path, which is stronger than a terms reading.
    outputRetainedByProvider: { kind: "known", value: false },
    // No document snapshot was taken. Writing a digest here would fabricate an
    // audit trail for a reading nobody can re-check.
    policySnapshotDigest: { kind: "unknown" },
  },
  validFrom: "2026-01-01T00:00:00.000Z",
  expiresAt: null,
};

/**
 * Fortissimo class, Fireworks lane — Kimi-K3 on Fireworks.
 * Inference runs through external infrastructure (Fireworks).
 * Open-weight model served via third-party API.
 *
 * 🔴 RESERVED AND NOT LIVE.
 *
 * This endpoint is deliberately unservable to prevent tier-3 class escalation
 * until three prerequisites are met:
 *   1. FIREWORKS_ENABLED=true on the box — the adapter needs both flag AND key,
 *      and Fireworks is the only provider here, so today this class has nowhere
 *      to run. It fails closed rather than degrading.
 *   2. An entitlement gate (issue #217) — at ~5x Forte's rates this is not
 *      something to open on credit weighting alone.
 *   3. The eval suite — no eval_suite_version is defined because it has not
 *      been run. Per vinci-chat AGENTS.md a class occupant ships by passing
 *      evals, not by editing this file.
 *
 * See vinci-chat/config/classes.yaml lines 43-55 for full explanation.
 * liveCloudClasses() drops reserved classes so they stay out of model ladder,
 * /api/models, and the resolver's accepted ids.
 */
const fortissimoFireworksEndpoint: OpenWeightEndpoint = {
  schemaVersion: 1,
  endpointId: "fortissimo-fireworks",
  sourceClass: "open_weight",
  serving: {
    kind: "third_party_api",
    provider: "fireworks",
    model: "moonshotai/Kimi-K3",
    modelRevision: { kind: "unknown" },
    jurisdiction: { kind: "unknown" },
  },
  weightsDigest: { kind: "unknown" },
  tokenizerDigest: { kind: "unknown" },
  architectureDigest: { kind: "unknown" },
  servingImageDigest: { kind: "unknown" },
  quantizationDigest: { kind: "unknown" },
  capabilityProfile: {
    // EVIDENCE-BACKED: text is universal (all LLMs support text).
    // tool_use: app/api/v1/chat/completions/route.ts forwards tool definitions
    // and tool results over the OpenAI-compatible protocol to the upstream provider.
    capabilities: ["text", "tool_use"],
    // From vinci-chat/config/classes.yaml line 77: fortissimo declares 1000000 tokens.
    contextLimit: 1000000,
    toolSupport: true,
  },
  // DECISION: structured_tool_use is arguably evidenced (tool forwarding); it was kept.
  // repository_editing and evidence_citation: no evidence, removed.
  declaredCapabilities: ["structured_tool_use"],
  credentials: {
    source: {
      kind: "managed-credential",
      credentialId: "fireworks-api-key",
    },
  },
  inferenceIsExternal: { kind: "known", value: true },
  approvedForProtectedData: { kind: "unknown" },
  rights: {
    // DECLARED BY GEORGE, 2026-08-31: he checked DeepInfra's, Fireworks' and
    // OpenRouter's terms and states all three permit training and evaluation on
    // their output. A declaration, not a proof -- recorded with its author and
    // date so it is auditable, and void if the declaration is false.
    trainingAllowed: { kind: "known", value: true },
    evaluationAllowed: { kind: "known", value: true },
    // NOT covered by that check. Redistribution is a separate permission and
    // was not spoken to; inferring it from the other two is how a rights field
    // gets fabricated.
    redistributionAllowed: { kind: "unknown" },
    // EVIDENCE-BACKED, not declared. Every adapter in vinci-chat carries
    // zdr = true, and FoundationProxy.selectAdapter REFUSES any provider not in
    // APPROVED_ZDR -- so non-retention is an enforced invariant of the serving
    // path, which is stronger than a terms reading.
    outputRetainedByProvider: { kind: "known", value: false },
    // No document snapshot was taken. Writing a digest here would fabricate an
    // audit trail for a reading nobody can re-check.
    policySnapshotDigest: { kind: "unknown" },
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
  forteDeepinfraEndpoint,
  forteFireworksEndpoint,
  visionDeepinfraEndpoint,
  visionOpenrouterEndpoint,
  mezzoDeepinfraEndpoint,
  fortissimoFireworksEndpoint,
] as const satisfies readonly ModelEndpointSpec[]);

/**
 * Look up an endpoint by its id.
 */
export function endpointById(id: string): ModelEndpointSpec | undefined {
  return VINCI_ENDPOINTS.find((ep) => ep.endpointId === id);
}
