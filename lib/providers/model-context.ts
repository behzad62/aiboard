export type LongContextQuality = "poor" | "ok" | "good" | "excellent";
export type ModelBuildRole = "architect" | "worker" | "reviewer" | "summary";

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
  maxOutputTokens?: number;
  buildOutputReserveTokens?: number;
  effectiveBuildInputCeilingTokens?: number;
  longContextQuality?: LongContextQuality;
  promptCaching?: boolean;
  recommendedBuildRoles?: ModelBuildRole[];
  source: ModelContextProfileSource;
}

export interface ModelContextProfileOverride {
  contextWindowTokens?: number | null;
  maxOutputTokens?: number | null;
  buildOutputReserveTokens?: number | null;
  effectiveBuildInputCeilingTokens?: number | null;
  longContextQuality?: LongContextQuality | null;
  promptCaching?: boolean | null;
  recommendedBuildRoles?: ModelBuildRole[] | null;
  updatedAt?: string;
}

export type ModelContextOverrides = Record<string, ModelContextProfileOverride>;

type StaticModelContextProfile = Omit<
  ModelContextProfile,
  "modelId" | "providerId" | "fullModelId" | "source"
>;

export const MIN_CONTEXT_WINDOW_TOKENS = 4_096;
export const MAX_CONTEXT_WINDOW_TOKENS = 2_000_000;
const MIN_OUTPUT_TOKENS = 256;
const MAX_OUTPUT_TOKENS = 128_000;

const ALL_BUILD_ROLES: ModelBuildRole[] = [
  "architect",
  "worker",
  "reviewer",
  "summary",
];

export const DEFAULT_MODEL_CONTEXT_PROFILE: StaticModelContextProfile = {
  contextWindowTokens: 32_768,
  maxOutputTokens: 4_096,
  buildOutputReserveTokens: 4_096,
  effectiveBuildInputCeilingTokens: 28_672,
  longContextQuality: "ok",
  promptCaching: false,
  recommendedBuildRoles: ["worker"],
};

export const PROVIDER_DEFAULT_CONTEXT_PROFILES: Record<
  string,
  StaticModelContextProfile
> = {
  openai: {
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    buildOutputReserveTokens: 16_384,
    longContextQuality: "good",
    promptCaching: true,
    recommendedBuildRoles: [...ALL_BUILD_ROLES],
  },
  chatgpt: {
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    buildOutputReserveTokens: 16_384,
    longContextQuality: "good",
    promptCaching: true,
    recommendedBuildRoles: [...ALL_BUILD_ROLES],
  },
  "github-copilot": {
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    buildOutputReserveTokens: 16_384,
    longContextQuality: "good",
    promptCaching: false,
    recommendedBuildRoles: ["worker", "reviewer", "summary"],
  },
  anthropic: {
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_384,
    buildOutputReserveTokens: 16_384,
    longContextQuality: "good",
    promptCaching: true,
    recommendedBuildRoles: [...ALL_BUILD_ROLES],
  },
  foundry: {
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_384,
    buildOutputReserveTokens: 16_384,
    longContextQuality: "good",
    promptCaching: true,
    recommendedBuildRoles: [...ALL_BUILD_ROLES],
  },
  nvidia: {
    contextWindowTokens: 128_000,
    maxOutputTokens: 16_384,
    buildOutputReserveTokens: 16_384,
    longContextQuality: "good",
    promptCaching: false,
    recommendedBuildRoles: ["worker", "reviewer", "summary"],
  },
  google: {
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 65_536,
    buildOutputReserveTokens: 65_536,
    longContextQuality: "excellent",
    promptCaching: true,
    recommendedBuildRoles: [...ALL_BUILD_ROLES],
  },
  openrouter: {
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
    buildOutputReserveTokens: 8_192,
    longContextQuality: "ok",
    promptCaching: true,
    recommendedBuildRoles: ["worker", "reviewer"],
  },
  custom: {
    contextWindowTokens: 32_768,
    maxOutputTokens: 4_096,
    buildOutputReserveTokens: 4_096,
    longContextQuality: "ok",
    promptCaching: false,
    recommendedBuildRoles: ["worker"],
  },
};

export const MODEL_CONTEXT_PROFILES: Record<string, StaticModelContextProfile> = {
  "openai:gpt-5.5": {
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
    buildOutputReserveTokens: 128_000,
    longContextQuality: "excellent",
    promptCaching: true,
    recommendedBuildRoles: [...ALL_BUILD_ROLES],
  },
  "openai:gpt-5.5-pro": {
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
    buildOutputReserveTokens: 128_000,
    longContextQuality: "excellent",
    promptCaching: true,
    recommendedBuildRoles: ["architect", "reviewer", "summary"],
  },
  "openai:gpt-5.4": {
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
    buildOutputReserveTokens: 128_000,
    longContextQuality: "excellent",
    promptCaching: true,
    recommendedBuildRoles: [...ALL_BUILD_ROLES],
  },
  "openai:gpt-5.4-pro": {
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
    buildOutputReserveTokens: 128_000,
    longContextQuality: "excellent",
    promptCaching: true,
    recommendedBuildRoles: ["architect", "reviewer", "summary"],
  },
  "openai:gpt-5.3-codex": {
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    buildOutputReserveTokens: 128_000,
    longContextQuality: "excellent",
    promptCaching: true,
    recommendedBuildRoles: ["worker", "reviewer"],
  },
  "openai:gpt-5.4-mini": {
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    buildOutputReserveTokens: 128_000,
    longContextQuality: "good",
    promptCaching: true,
    recommendedBuildRoles: ["worker", "reviewer", "summary"],
  },
  "chatgpt:gpt-5.5": {
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
    buildOutputReserveTokens: 128_000,
    longContextQuality: "excellent",
    promptCaching: true,
    recommendedBuildRoles: [...ALL_BUILD_ROLES],
  },
  "chatgpt:gpt-5.4": {
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
    buildOutputReserveTokens: 128_000,
    longContextQuality: "excellent",
    promptCaching: true,
    recommendedBuildRoles: [...ALL_BUILD_ROLES],
  },
  "chatgpt:gpt-5.4-mini": {
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    buildOutputReserveTokens: 128_000,
    longContextQuality: "good",
    promptCaching: true,
    recommendedBuildRoles: ["worker", "reviewer", "summary"],
  },
  "chatgpt:gpt-5.3-codex-spark": {
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    buildOutputReserveTokens: 128_000,
    longContextQuality: "excellent",
    promptCaching: true,
    recommendedBuildRoles: ["worker", "reviewer"],
  },
  "github-copilot:auto": {
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    buildOutputReserveTokens: 128_000,
    longContextQuality: "good",
    promptCaching: false,
    recommendedBuildRoles: ["worker", "reviewer", "summary"],
  },
  "github-copilot:gpt-5.4": {
    contextWindowTokens: 1_050_000,
    maxOutputTokens: 128_000,
    buildOutputReserveTokens: 128_000,
    longContextQuality: "excellent",
    promptCaching: false,
    recommendedBuildRoles: [...ALL_BUILD_ROLES],
  },
  "github-copilot:gpt-5.4-mini": {
    contextWindowTokens: 400_000,
    maxOutputTokens: 128_000,
    buildOutputReserveTokens: 128_000,
    longContextQuality: "good",
    promptCaching: false,
    recommendedBuildRoles: ["worker", "reviewer", "summary"],
  },
  "github-copilot:claude-sonnet-4.5": {
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_768,
    buildOutputReserveTokens: 32_768,
    longContextQuality: "good",
    promptCaching: false,
    recommendedBuildRoles: ["architect", "worker", "reviewer"],
  },
  "anthropic:claude-fable-5": {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 32_768,
    buildOutputReserveTokens: 32_768,
    longContextQuality: "excellent",
    promptCaching: true,
    recommendedBuildRoles: [...ALL_BUILD_ROLES],
  },
  "anthropic:claude-opus-4-8": {
    contextWindowTokens: 200_000,
    maxOutputTokens: 32_768,
    buildOutputReserveTokens: 32_768,
    longContextQuality: "good",
    promptCaching: true,
    recommendedBuildRoles: ["architect", "reviewer", "summary"],
  },
  "anthropic:claude-sonnet-4-6": {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 32_768,
    buildOutputReserveTokens: 32_768,
    longContextQuality: "excellent",
    promptCaching: true,
    recommendedBuildRoles: [...ALL_BUILD_ROLES],
  },
  "anthropic:claude-haiku-4-5-20251001": {
    contextWindowTokens: 200_000,
    maxOutputTokens: 16_384,
    buildOutputReserveTokens: 16_384,
    longContextQuality: "good",
    promptCaching: true,
    recommendedBuildRoles: ["worker", "summary"],
  },
  "google:gemini-3.5-flash": {
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 65_536,
    buildOutputReserveTokens: 65_536,
    longContextQuality: "excellent",
    promptCaching: true,
    recommendedBuildRoles: [...ALL_BUILD_ROLES],
  },
  "google:gemini-3.1-pro-preview": {
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 65_536,
    buildOutputReserveTokens: 65_536,
    longContextQuality: "excellent",
    promptCaching: true,
    recommendedBuildRoles: [...ALL_BUILD_ROLES],
  },
  "google:gemini-2.5-flash": {
    contextWindowTokens: 1_048_576,
    maxOutputTokens: 65_536,
    buildOutputReserveTokens: 65_536,
    longContextQuality: "excellent",
    promptCaching: true,
    recommendedBuildRoles: ["worker", "reviewer", "summary"],
  },
  "openrouter:qwen/qwen3.7-max": {
    contextWindowTokens: 262_144,
    maxOutputTokens: 16_384,
    buildOutputReserveTokens: 16_384,
    longContextQuality: "good",
    promptCaching: true,
    recommendedBuildRoles: ["architect", "worker", "reviewer"],
  },
  "openrouter:qwen/qwen3.7-plus": {
    contextWindowTokens: 262_144,
    maxOutputTokens: 16_384,
    buildOutputReserveTokens: 16_384,
    longContextQuality: "good",
    promptCaching: true,
    recommendedBuildRoles: ["worker", "reviewer", "summary"],
  },
  "openrouter:deepseek/deepseek-v4-pro": {
    contextWindowTokens: 128_000,
    maxOutputTokens: 8_192,
    buildOutputReserveTokens: 8_192,
    longContextQuality: "ok",
    promptCaching: true,
    recommendedBuildRoles: ["architect", "worker", "reviewer"],
  },
  "openrouter:deepseek/deepseek-v4-flash": {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 32_768,
    buildOutputReserveTokens: 32_768,
    longContextQuality: "excellent",
    promptCaching: true,
    recommendedBuildRoles: ["worker", "reviewer", "summary"],
  },
  "openrouter:minimax/minimax-m3": {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 32_768,
    buildOutputReserveTokens: 32_768,
    longContextQuality: "excellent",
    promptCaching: true,
    recommendedBuildRoles: ["worker", "summary"],
  },
  "openrouter:z-ai/glm-5.2": {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 32_768,
    buildOutputReserveTokens: 32_768,
    longContextQuality: "excellent",
    promptCaching: true,
    recommendedBuildRoles: ["worker", "reviewer"],
  },
  "nvidia:z-ai/glm-5.2": {
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 16_384,
    buildOutputReserveTokens: 16_384,
    longContextQuality: "excellent",
    promptCaching: false,
    recommendedBuildRoles: [...ALL_BUILD_ROLES],
  },
  "openrouter:moonshotai/kimi-k2.7-code": {
    contextWindowTokens: 262_144,
    maxOutputTokens: 16_384,
    buildOutputReserveTokens: 16_384,
    longContextQuality: "good",
    promptCaching: true,
    recommendedBuildRoles: ["architect", "worker", "reviewer"],
  },
  "openrouter:nex-agi/nex-n2-pro:free": {
    contextWindowTokens: 262_144,
    maxOutputTokens: 16_384,
    buildOutputReserveTokens: 16_384,
    longContextQuality: "good",
    promptCaching: true,
    recommendedBuildRoles: ["worker"],
  },
};

const LONG_CONTEXT_QUALITIES = new Set<LongContextQuality>([
  "poor",
  "ok",
  "good",
  "excellent",
]);
const BUILD_ROLES = new Set<ModelBuildRole>(ALL_BUILD_ROLES);

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

function normalizeRoles(
  overrideRoles: unknown,
  baseRoles: ModelBuildRole[] | undefined
): ModelBuildRole[] | undefined {
  if (!Array.isArray(overrideRoles)) return baseRoles ? [...baseRoles] : undefined;
  const roles = overrideRoles.filter((role): role is ModelBuildRole =>
    BUILD_ROLES.has(role as ModelBuildRole)
  );
  const deduped = [...new Set(roles)];
  return deduped.length > 0 ? deduped : baseRoles ? [...baseRoles] : undefined;
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
  const maxOutputCeiling = Math.min(MAX_OUTPUT_TOKENS, contextWindowTokens);
  const overrideMaxOutput = finiteInteger(input.override?.maxOutputTokens);
  const baseMaxOutput = finiteInteger(input.base.maxOutputTokens);
  const maxOutputTokens = clamp(
    overrideMaxOutput ?? baseMaxOutput ?? Math.min(4_096, maxOutputCeiling),
    MIN_OUTPUT_TOKENS,
    maxOutputCeiling
  );
  const maxReserve = Math.min(
    maxOutputTokens,
    MAX_OUTPUT_TOKENS,
    Math.max(MIN_OUTPUT_TOKENS, Math.floor(contextWindowTokens / 2))
  );
  const overrideReserve = finiteInteger(
    input.override?.buildOutputReserveTokens
  );
  const baseReserve = finiteInteger(input.base.buildOutputReserveTokens);
  const buildOutputReserveTokens = clamp(
    overrideReserve ?? baseReserve ?? maxOutputTokens,
    MIN_OUTPUT_TOKENS,
    maxReserve
  );
  const maxInputCeiling = Math.max(
    0,
    contextWindowTokens - buildOutputReserveTokens
  );
  const overrideInputCeiling = finiteInteger(
    input.override?.effectiveBuildInputCeilingTokens
  );
  const baseInputCeiling = finiteInteger(
    input.base.effectiveBuildInputCeilingTokens
  );
  const effectiveBuildInputCeilingTokens = clamp(
    overrideInputCeiling ?? baseInputCeiling ?? maxInputCeiling,
    0,
    maxInputCeiling
  );
  const quality = LONG_CONTEXT_QUALITIES.has(
    input.override?.longContextQuality as LongContextQuality
  )
    ? (input.override?.longContextQuality as LongContextQuality)
    : input.base.longContextQuality;
  const promptCaching =
    typeof input.override?.promptCaching === "boolean"
      ? input.override.promptCaching
      : input.base.promptCaching;

  return {
    modelId: input.modelId,
    providerId: input.providerId,
    fullModelId: fullModelId(input.providerId, input.modelId),
    contextWindowTokens,
    maxOutputTokens,
    buildOutputReserveTokens,
    effectiveBuildInputCeilingTokens,
    longContextQuality: quality,
    promptCaching,
    recommendedBuildRoles: normalizeRoles(
      input.override?.recommendedBuildRoles,
      input.base.recommendedBuildRoles
    ),
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
