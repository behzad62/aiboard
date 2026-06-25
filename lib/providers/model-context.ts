export type LongContextBehavior = "standard" | "large" | "very_large";

export type ModelContextProfileSource =
  | "registry"
  | "provider-default"
  | "default"
  | "override";

export interface ModelContextProfile {
  modelId: string;
  providerId: string;
  fullModelId: string;
  contextWindowTokens: number;
  outputReserveTokens: number;
  longContextBehavior: LongContextBehavior;
  source: ModelContextProfileSource;
}

export interface ModelContextProfileOverride {
  contextWindowTokens?: number | null;
  outputReserveTokens?: number | null;
  longContextBehavior?: LongContextBehavior | null;
  updatedAt?: string;
}

export type ModelContextOverrides = Record<string, ModelContextProfileOverride>;

type StaticModelContextProfile = Omit<
  ModelContextProfile,
  "modelId" | "providerId" | "fullModelId" | "source"
>;

export const MIN_CONTEXT_WINDOW_TOKENS = 4_096;
export const MAX_CONTEXT_WINDOW_TOKENS = 2_000_000;
const MIN_OUTPUT_RESERVE_TOKENS = 256;
const MAX_OUTPUT_RESERVE_TOKENS = 128_000;

export const DEFAULT_MODEL_CONTEXT_PROFILE: StaticModelContextProfile = {
  contextWindowTokens: 32_768,
  outputReserveTokens: 4_096,
  longContextBehavior: "standard",
};

export const PROVIDER_DEFAULT_CONTEXT_PROFILES: Record<
  string,
  StaticModelContextProfile
> = {
  openai: {
    contextWindowTokens: 128_000,
    outputReserveTokens: 16_384,
    longContextBehavior: "large",
  },
  anthropic: {
    contextWindowTokens: 200_000,
    outputReserveTokens: 16_384,
    longContextBehavior: "large",
  },
  foundry: {
    contextWindowTokens: 200_000,
    outputReserveTokens: 16_384,
    longContextBehavior: "large",
  },
  google: {
    contextWindowTokens: 1_048_576,
    outputReserveTokens: 65_536,
    longContextBehavior: "very_large",
  },
  openrouter: {
    contextWindowTokens: 128_000,
    outputReserveTokens: 8_192,
    longContextBehavior: "large",
  },
  custom: {
    contextWindowTokens: 32_768,
    outputReserveTokens: 4_096,
    longContextBehavior: "standard",
  },
};

export const MODEL_CONTEXT_PROFILES: Record<string, StaticModelContextProfile> = {
  "openai:gpt-5.5": {
    contextWindowTokens: 400_000,
    outputReserveTokens: 32_768,
    longContextBehavior: "large",
  },
  "openai:gpt-5.5-pro": {
    contextWindowTokens: 400_000,
    outputReserveTokens: 32_768,
    longContextBehavior: "large",
  },
  "openai:gpt-5.4": {
    contextWindowTokens: 400_000,
    outputReserveTokens: 32_768,
    longContextBehavior: "large",
  },
  "openai:gpt-5.4-pro": {
    contextWindowTokens: 400_000,
    outputReserveTokens: 32_768,
    longContextBehavior: "large",
  },
  "openai:gpt-5.3-codex": {
    contextWindowTokens: 400_000,
    outputReserveTokens: 32_768,
    longContextBehavior: "large",
  },
  "openai:gpt-5.4-mini": {
    contextWindowTokens: 400_000,
    outputReserveTokens: 16_384,
    longContextBehavior: "large",
  },
  "anthropic:claude-fable-5": {
    contextWindowTokens: 1_000_000,
    outputReserveTokens: 32_768,
    longContextBehavior: "very_large",
  },
  "anthropic:claude-opus-4-8": {
    contextWindowTokens: 200_000,
    outputReserveTokens: 32_768,
    longContextBehavior: "large",
  },
  "anthropic:claude-sonnet-4-6": {
    contextWindowTokens: 1_000_000,
    outputReserveTokens: 32_768,
    longContextBehavior: "very_large",
  },
  "anthropic:claude-haiku-4-5-20251001": {
    contextWindowTokens: 200_000,
    outputReserveTokens: 16_384,
    longContextBehavior: "large",
  },
  "google:gemini-3.5-flash": {
    contextWindowTokens: 1_048_576,
    outputReserveTokens: 65_536,
    longContextBehavior: "very_large",
  },
  "google:gemini-3.1-pro-preview": {
    contextWindowTokens: 1_048_576,
    outputReserveTokens: 65_536,
    longContextBehavior: "very_large",
  },
  "google:gemini-2.5-flash": {
    contextWindowTokens: 1_048_576,
    outputReserveTokens: 65_536,
    longContextBehavior: "very_large",
  },
  "openrouter:qwen/qwen3.7-max": {
    contextWindowTokens: 262_144,
    outputReserveTokens: 16_384,
    longContextBehavior: "large",
  },
  "openrouter:qwen/qwen3.7-plus": {
    contextWindowTokens: 262_144,
    outputReserveTokens: 16_384,
    longContextBehavior: "large",
  },
  "openrouter:deepseek/deepseek-v4-pro": {
    contextWindowTokens: 128_000,
    outputReserveTokens: 8_192,
    longContextBehavior: "large",
  },
  "openrouter:deepseek/deepseek-v4-flash": {
    contextWindowTokens: 1_000_000,
    outputReserveTokens: 32_768,
    longContextBehavior: "very_large",
  },
  "openrouter:minimax/minimax-m3": {
    contextWindowTokens: 1_000_000,
    outputReserveTokens: 32_768,
    longContextBehavior: "very_large",
  },
  "openrouter:z-ai/glm-5.2": {
    contextWindowTokens: 1_000_000,
    outputReserveTokens: 32_768,
    longContextBehavior: "very_large",
  },
  "openrouter:nex-agi/nex-n2-pro:free": {
    contextWindowTokens: 262_144,
    outputReserveTokens: 16_384,
    longContextBehavior: "large",
  },
};

const LONG_CONTEXT_BEHAVIORS = new Set<LongContextBehavior>([
  "standard",
  "large",
  "very_large",
]);

function fullModelId(providerId: string, modelId: string): string {
  return `${providerId}:${modelId}`;
}

function finiteInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeProfile(input: {
  providerId: string;
  modelId: string;
  base: StaticModelContextProfile;
  override?: ModelContextProfileOverride;
  source: ModelContextProfileSource;
}): ModelContextProfile {
  const overrideContext = finiteInteger(input.override?.contextWindowTokens);
  const contextWindowTokens = clamp(
    overrideContext ?? input.base.contextWindowTokens,
    MIN_CONTEXT_WINDOW_TOKENS,
    MAX_CONTEXT_WINDOW_TOKENS
  );
  const maxReserve = Math.min(
    MAX_OUTPUT_RESERVE_TOKENS,
    Math.max(MIN_OUTPUT_RESERVE_TOKENS, Math.floor(contextWindowTokens / 2))
  );
  const overrideReserve = finiteInteger(input.override?.outputReserveTokens);
  const outputReserveTokens = clamp(
    overrideReserve ?? input.base.outputReserveTokens,
    MIN_OUTPUT_RESERVE_TOKENS,
    maxReserve
  );
  const behavior = LONG_CONTEXT_BEHAVIORS.has(
    input.override?.longContextBehavior as LongContextBehavior
  )
    ? (input.override?.longContextBehavior as LongContextBehavior)
    : input.base.longContextBehavior;

  return {
    modelId: input.modelId,
    providerId: input.providerId,
    fullModelId: fullModelId(input.providerId, input.modelId),
    contextWindowTokens,
    outputReserveTokens,
    longContextBehavior: behavior,
    source: input.source,
  };
}

function resolveOverride(
  providerId: string,
  modelId: string,
  overrides?: ModelContextOverrides
): ModelContextProfileOverride | undefined {
  if (!overrides) return undefined;
  const modelOverride = overrides[fullModelId(providerId, modelId)];
  if (modelOverride) return modelOverride;
  const providerOverride = overrides[fullModelId(providerId, "*")];
  if (providerOverride) return providerOverride;
  return overrides["*"];
}

export function resolveModelContextProfile(
  modelId: string,
  providerId: string,
  overrides?: ModelContextOverrides
): ModelContextProfile {
  const normalizedProviderId = providerId.trim();
  const normalizedModelId = modelId.trim();
  const key = fullModelId(normalizedProviderId, normalizedModelId);
  const registry = MODEL_CONTEXT_PROFILES[key];
  const providerDefault = PROVIDER_DEFAULT_CONTEXT_PROFILES[normalizedProviderId];
  const base = registry ?? providerDefault ?? DEFAULT_MODEL_CONTEXT_PROFILE;
  const baseSource: ModelContextProfileSource = registry
    ? "registry"
    : providerDefault
      ? "provider-default"
      : "default";
  const override = resolveOverride(
    normalizedProviderId,
    normalizedModelId,
    overrides
  );

  return normalizeProfile({
    providerId: normalizedProviderId,
    modelId: normalizedModelId,
    base,
    override,
    source: override ? "override" : baseSource,
  });
}

export function formatContextWindowTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    const thousands = tokens / 1_000;
    return `${Number.isInteger(thousands) ? thousands : thousands.toFixed(1)}k`;
  }
  return String(tokens);
}
