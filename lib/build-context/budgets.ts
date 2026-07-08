import type {
  ModelBuildRole,
  ModelContextProfile,
} from "../providers/model-context";

export const CONTEXT_TIERS = ["tiny", "standard", "large", "huge"] as const;
export type ContextTier = (typeof CONTEXT_TIERS)[number];
export type BuildPromptRole = ModelBuildRole;

export interface BuildPromptBudget {
  role: BuildPromptRole;
  tier: ContextTier;
  totalInputTokens: number;
  fixedPromptTokens: number;
  taskTokens: number;
  contextPackTokens: number;
  historyTokens: number;
  outputReserveTokens: number;
  modelContextWindowTokens?: number;
  modelInputCeilingTokens?: number;
}

export const MIN_WORKER_TOOL_CONVERSATION_CHARS = 80_000;
export const MAX_WORKER_TOOL_CONVERSATION_CHARS = 1_200_000;
export const TOOL_CONVERSATION_TOKEN_TO_CHAR_RATIO = 3.2;

export interface CreateBuildPromptBudgetOptions {
  role: BuildPromptRole;
  tier?: ContextTier;
  profile?: Pick<
    ModelContextProfile,
    | "contextWindowTokens"
    | "buildOutputReserveTokens"
    | "effectiveBuildInputCeilingTokens"
  >;
}

export function buildWorkerToolConversationCharLimit(input: {
  totalInputTokens: number;
}): number {
  const tokens =
    typeof input.totalInputTokens === "number" &&
    Number.isFinite(input.totalInputTokens)
      ? Math.max(0, Math.floor(input.totalInputTokens))
      : 0;
  if (tokens === 0) return 0;
  const chars = Math.floor(tokens * TOOL_CONVERSATION_TOKEN_TO_CHAR_RATIO);
  return Math.max(
    MIN_WORKER_TOOL_CONVERSATION_CHARS,
    Math.min(MAX_WORKER_TOOL_CONVERSATION_CHARS, chars)
  );
}

interface RoleAllocation {
  fixedPromptTokens: number;
  taskShare: number;
  historyShare: number;
}

export const TIER_INPUT_TOKEN_TARGETS: Record<ContextTier, number> = {
  tiny: 12_000,
  standard: 48_000,
  large: 160_000,
  huge: 420_000,
};

const ROLE_ALLOCATIONS: Record<BuildPromptRole, RoleAllocation> = {
  architect: {
    fixedPromptTokens: 1_800,
    taskShare: 0.16,
    historyShare: 0.24,
  },
  worker: {
    fixedPromptTokens: 1_200,
    taskShare: 0.22,
    historyShare: 0.1,
  },
  reviewer: {
    fixedPromptTokens: 1_500,
    taskShare: 0.14,
    historyShare: 0.2,
  },
  summary: {
    fixedPromptTokens: 1_000,
    taskShare: 0.12,
    historyShare: 0.34,
  },
};

function finitePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function finiteNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;
}

function buildInputCeiling(
  profile?: CreateBuildPromptBudgetOptions["profile"]
): number | null {
  const explicit = finiteNonNegativeInteger(
    profile?.effectiveBuildInputCeilingTokens
  );
  if (explicit !== null) return explicit;

  const windowTokens = finitePositiveInteger(profile?.contextWindowTokens);
  if (windowTokens === null) return null;

  const reserve =
    finiteNonNegativeInteger(profile?.buildOutputReserveTokens) ?? 0;
  return Math.max(0, windowTokens - reserve);
}

export function inferContextTier(
  profile?: CreateBuildPromptBudgetOptions["profile"]
): ContextTier {
  const inputCeiling = buildInputCeiling(profile);
  const tokens =
    inputCeiling ?? finitePositiveInteger(profile?.contextWindowTokens) ?? 0;

  if (tokens < 24_000) return "tiny";
  if (tokens < 120_000) return "standard";
  if (tokens < 500_000) return "large";
  return "huge";
}

function outputReserve(
  role: BuildPromptRole,
  profile?: CreateBuildPromptBudgetOptions["profile"]
): number {
  const profileReserve = finiteNonNegativeInteger(
    profile?.buildOutputReserveTokens
  );
  if (profileReserve !== null) return profileReserve;

  switch (role) {
    case "architect":
    case "reviewer":
      return 8_192;
    case "summary":
      return 4_096;
    case "worker":
      return 6_144;
  }
}

export function createBuildPromptBudget(
  options: CreateBuildPromptBudgetOptions
): BuildPromptBudget {
  const tier = options.tier ?? inferContextTier(options.profile);
  const modelInputCeiling = buildInputCeiling(options.profile);
  const targetInputTokens = TIER_INPUT_TOKEN_TARGETS[tier];
  const totalInputTokens =
    modelInputCeiling === null
      ? targetInputTokens
      : Math.min(targetInputTokens, modelInputCeiling);
  const allocation = ROLE_ALLOCATIONS[options.role];
  const fixedPromptTokens = Math.min(
    allocation.fixedPromptTokens,
    Math.floor(totalInputTokens * 0.25)
  );
  const remainingTokens = Math.max(0, totalInputTokens - fixedPromptTokens);
  const taskTokens = Math.floor(remainingTokens * allocation.taskShare);
  const historyTokens = Math.floor(remainingTokens * allocation.historyShare);
  const contextPackTokens = Math.max(
    0,
    remainingTokens - taskTokens - historyTokens
  );

  return {
    role: options.role,
    tier,
    totalInputTokens,
    fixedPromptTokens,
    taskTokens,
    contextPackTokens,
    historyTokens,
    outputReserveTokens: outputReserve(options.role, options.profile),
    modelContextWindowTokens: options.profile?.contextWindowTokens,
    modelInputCeilingTokens: modelInputCeiling ?? undefined,
  };
}
