/**
 * Provider identifiers are closed because vinci-platform already enforces
 * exactly this set at its routing boundary. Expanding it requires a deliberate
 * platform contract change rather than an accidental pass-through string.
 */
export const MODEL_PROVIDERS = ["openai", "anthropic", "openrouter"] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

/**
 * These ids match vinci-chat's shipping reserved ids. Keeping the vocabulary
 * small makes a request portable while leaving the gateway free to replace the
 * concrete model behind it.
 */
export const MODEL_CLASS_IDS = [
  "mezzo", // Balanced general-purpose work; the economical default.
  "forte", // Higher capability for work where quality outweighs latency.
  "fortissimo", // Maximum available capability for the hardest requests.
  "vision", // Requires an image-capable route rather than assuming all routes see images.
] as const;
export type ModelClassId = (typeof MODEL_CLASS_IDS)[number];

/**
 * Deliberately a free-form string: vendor model vocabularies change without
 * notice, so a closed model-id enum would reject a newly released model.
 */
export type ModelIdentifier = string;

export const MODEL_CAPABILITIES = [
  "text",
  "vision",
  "audio",
  "tool_use",
  "structured_output",
] as const;
export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export const MODEL_REASONING_MODES = ["disabled", "standard", "extended"] as const;
export type ModelReasoningMode = (typeof MODEL_REASONING_MODES)[number];

/**
 * UX-3 requires unknown to be data, not the accidental result of a missing
 * property. Consumers must branch on `kind` before reading a value.
 */
export type ExplicitValue<T> =
  | { readonly kind: "known"; readonly value: T }
  | { readonly kind: "unknown" };

export type ModelCapabilityProfile = {
  readonly capabilities: readonly ModelCapability[];
  readonly contextLimit: number;
  readonly toolSupport: boolean;
};

export type ProcessingLocation = {
  /** ISO 3166 code or an equally explicit contractual jurisdiction name. */
  readonly jurisdiction: string;
  /** Provider region when one is disclosed; jurisdiction remains authoritative. */
  readonly region?: string;
};
