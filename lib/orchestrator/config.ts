import type {
  DiscussionMode,
  EffortLevel,
  ReasoningEffort,
  Verbosity,
} from "../db/schema";
import type { ModelPricing } from "../providers/pricing";

export interface EffortConfig {
  maxRounds: number;
  maxTokens: number;
  /**
   * Token budget for the final judge synthesis. Kept well above the per-round
   * `maxTokens` because the judge produces the full deliverable answer; using
   * the round budget here truncates the JSON envelope mid-stream and the answer
   * never closes. See lib/orchestrator/parse.ts for the recovery path.
   */
  judgeMaxTokens: number;
  convergenceThreshold: number;
  skipConvergenceVote: boolean;
  temperature: number;
}

// Token budgets are deliberately generous CEILINGS, not the length control.
// Conciseness is steered entirely through prompt instructions (see
// buildVerbosityInstruction) so answers comply rather than get cut off.
export const EFFORT_CONFIG: Record<EffortLevel, EffortConfig> = {
  low: {
    maxRounds: 2,
    maxTokens: 2048,
    judgeMaxTokens: 8192,
    convergenceThreshold: 7,
    skipConvergenceVote: true,
    temperature: 0.6,
  },
  medium: {
    maxRounds: 4,
    maxTokens: 4096,
    judgeMaxTokens: 12288,
    convergenceThreshold: 7.5,
    skipConvergenceVote: false,
    temperature: 0.7,
  },
  high: {
    maxRounds: 6,
    maxTokens: 8192,
    judgeMaxTokens: 16384,
    convergenceThreshold: 8,
    skipConvergenceVote: false,
    temperature: 0.75,
  },
};

// Build mode emits multi-file code, so it gets extra headroom on top of the
// effort budget. These are ceilings; verbosity still governs prose length.
export const BUILD_ROUND_MIN_TOKENS = 8192;
export const BUILD_INTEGRATOR_MIN_TOKENS = 16384;
export const BUILD_TASKS_PER_WAVE = 8;
export const BUILD_MAX_WAVES = 50;
export const BUILD_NO_PROGRESS_WAVES = 4;

export interface VerbosityInfo {
  value: Verbosity;
  label: string;
  description: string;
}

export const VERBOSITY_OPTIONS: VerbosityInfo[] = [
  {
    value: "brief",
    label: "Brief",
    description: "Tight and to the point. Bullets over prose, no preamble.",
  },
  {
    value: "balanced",
    label: "Balanced",
    description: "Clear and reasonably thorough. The default.",
  },
  {
    value: "comprehensive",
    label: "Comprehensive",
    description: "Covers reasoning, alternatives, and caveats.",
  },
  {
    value: "exhaustive",
    label: "Exhaustive",
    description: "Deep and rigorous: edge cases and trade-offs.",
  },
];

export const DEFAULT_VERBOSITY: Verbosity = "balanced";

export function getVerbosityLabel(verbosity: Verbosity): string {
  return VERBOSITY_OPTIONS.find((o) => o.value === verbosity)?.label ?? verbosity;
}

export interface ReasoningEffortInfo {
  value: ReasoningEffort;
  label: string;
  description: string;
}

// How hard the models reason. Mapped per provider in lib/providers/reasoning.ts.
export const REASONING_OPTIONS: ReasoningEffortInfo[] = [
  {
    value: "default",
    label: "Provider default",
    description: "Each model's built-in setting (OpenAI medium, Claude high).",
  },
  {
    value: "low",
    label: "Low",
    description: "Fastest and cheapest; minimal reasoning.",
  },
  {
    value: "medium",
    label: "Medium",
    description: "Balanced reasoning, speed, and cost.",
  },
  {
    value: "high",
    label: "High",
    description: "Deeper reasoning for hard problems.",
  },
  {
    value: "max",
    label: "Max",
    description: "Maximum depth (xhigh / max where the model supports it).",
  },
];

export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "default";

export function getReasoningLabel(effort: ReasoningEffort): string {
  return REASONING_OPTIONS.find((o) => o.value === effort)?.label ?? effort;
}

export interface DiscussionModeInfo {
  label: string;
  summary: string;
  flow: string;
  bestFor: string;
}

export interface DiscussionUsageEstimate {
  minCalls: number;
  maxCalls: number;
  minResponseTokens: number;
  maxResponseTokens: number;
  label: string;
  note: string;
}

function getMinimumRounds(config: EffortConfig): number {
  if (config.skipConvergenceVote) {
    return config.maxRounds;
  }

  return Math.min(config.maxRounds, 2);
}

function getDiscussionCallsForRounds(
  mode: DiscussionMode,
  modelCount: number,
  rounds: number
): number {
  if (mode === "specialist") {
    return 1 + Math.max(0, rounds - 1) * modelCount;
  }

  return modelCount * rounds;
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}k`;
  }
  return `${value}`;
}

export function estimateDiscussionCost(
  modelCount: number,
  effort: EffortLevel,
  mode: DiscussionMode
): DiscussionUsageEstimate {
  const config = EFFORT_CONFIG[effort];
  const minRounds = getMinimumRounds(config);
  const maxRounds = config.maxRounds;

  const minDiscussionCalls = getDiscussionCallsForRounds(
    mode,
    modelCount,
    minRounds
  );
  const maxDiscussionCalls = getDiscussionCallsForRounds(
    mode,
    modelCount,
    maxRounds
  );

  const minVoteCalls = config.skipConvergenceVote
    ? 0
    : Math.max(0, minRounds - 1) * modelCount;
  const maxVoteCalls = config.skipConvergenceVote
    ? 0
    : Math.max(0, maxRounds - 1) * modelCount;

  const minCalls = minDiscussionCalls + minVoteCalls + 1;
  const maxCalls = maxDiscussionCalls + maxVoteCalls + 1;
  const minResponseTokens =
    minDiscussionCalls * config.maxTokens +
    minVoteCalls * 200 +
    config.judgeMaxTokens;
  const maxResponseTokens =
    maxDiscussionCalls * config.maxTokens +
    maxVoteCalls * 200 +
    config.judgeMaxTokens;

  return {
    minCalls,
    maxCalls,
    minResponseTokens,
    maxResponseTokens,
    label: `${minCalls}–${maxCalls} model/judge calls, ${formatCompactNumber(
      minResponseTokens
    )}–${formatCompactNumber(maxResponseTokens)} response tokens`,
    note:
      "Based on discussion rounds, convergence votes, and the final judge pass. Provider pricing varies by model, so treat this as usage planning rather than exact billing.",
  };
}

export interface DiscussionCostEstimateUsd {
  minUsd: number;
  maxUsd: number;
  pricedModelCount: number;
  totalModelCount: number;
}

/**
 * Rough dollar estimate from the selected models' pricing. Output tokens come
 * from the per-call budgets; input tokens approximate the transcript each turn
 * re-reads (it grows every round). Prices are blended across the priced models.
 * Models without pricing (e.g. local/custom) are excluded — they're free.
 */
export function estimateDiscussionCostUsd(
  modelPricings: (ModelPricing | null)[],
  effort: EffortLevel,
  mode: DiscussionMode
): DiscussionCostEstimateUsd | null {
  const priced = modelPricings.filter((p): p is ModelPricing => p !== null);
  if (priced.length === 0) return null;

  const avgInput =
    priced.reduce((sum, p) => sum + p.inputUsdPer1M, 0) / priced.length;
  const avgOutput =
    priced.reduce((sum, p) => sum + p.outputUsdPer1M, 0) / priced.length;
  // Only priced (cloud) models count toward the math — local/custom models are
  // free and must not change the estimate when added.
  const modelCount = priced.length;
  const config = EFFORT_CONFIG[effort];

  const usdForRounds = (rounds: number): number => {
    const discussionCalls = getDiscussionCallsForRounds(mode, modelCount, rounds);
    const outputTokens = discussionCalls * config.maxTokens + config.judgeMaxTokens;
    // Each turn in round r re-reads the ~(r-1) prior rounds of contributions.
    const transcriptInput =
      modelCount *
      modelCount *
      config.maxTokens *
      ((rounds * (rounds - 1)) / 2);
    const judgeInput = rounds * modelCount * config.maxTokens;
    const inputTokens = transcriptInput + judgeInput;
    return (inputTokens * avgInput + outputTokens * avgOutput) / 1_000_000;
  };

  return {
    minUsd: usdForRounds(getMinimumRounds(config)),
    maxUsd: usdForRounds(config.maxRounds),
    pricedModelCount: priced.length,
    totalModelCount: modelCount,
  };
}

export function getModeInfo(mode: DiscussionMode): DiscussionModeInfo {
  switch (mode) {
    case "panel":
      return {
        label: "Collaborative Panel",
        summary: "All selected models answer every round and refine together.",
        flow: "Each model gives an initial answer, then critiques and improves the group output across later rounds.",
        bestFor: "Best for broad questions where you want synthesis and shared reasoning.",
      };
    case "debate":
      return {
        label: "Debate",
        summary: "Models take opposing positions and challenge each other directly.",
        flow: "Participants are assigned sides, rebut counterarguments, and force tradeoffs into the open before judging.",
        bestFor: "Best for controversial choices, architecture tradeoffs, and risk analysis.",
      };
    case "specialist":
      return {
        label: "Specialist + Reviewers",
        summary: "One lead model drafts first, then reviewers critique and refine it.",
        flow: "Round 1 starts with a lead draft. Later rounds add reviewer feedback and lead revisions.",
        bestFor: "Best when you want one polished answer with structured review instead of equal voices every round.",
      };
    case "build":
      return {
        label: "Build",
        summary:
          "The judge acts as Architect: it plans tasks, worker models implement them, and it reviews and fixes until the project is done.",
        flow: "Architect plans tasks → workers implement each task with focused context → Architect reviews, fixes, and adds tasks → repeat until done, then writes the hand-off summary. Connect the local runner (or pick a browser folder) and files are written straight into your project.",
        bestFor:
          "Best for building real projects: pair an expensive Architect (judge) with cheap workers, point it at a folder, and let the team iterate.",
      };
  }
}

export function getModeLabel(mode: DiscussionMode): string {
  return getModeInfo(mode).label;
}

export function getEffortLabel(effort: EffortLevel): string {
  switch (effort) {
    case "low":
      return "Low (2 rounds)";
    case "medium":
      return "Medium (4 rounds)";
    case "high":
      return "High (6+ rounds)";
  }
}

/** Build-mode budgets per effort level (used by the build engine and the UI). */
export interface BuildLimits {
  cycles: number;
  tasksPerWave: number;
  totalWorkerCalls: number;
}

export const BUILD_LIMITS: Record<EffortLevel, BuildLimits> = {
  low: { cycles: 2, tasksPerWave: 3, totalWorkerCalls: 8 },
  medium: { cycles: 4, tasksPerWave: 5, totalWorkerCalls: 16 },
  high: { cycles: 6, tasksPerWave: 8, totalWorkerCalls: 32 },
};

/** What effort means in Build mode — cycles/tasks, not discussion rounds. */
export function getBuildEffortLabel(effort: EffortLevel): string {
  const config = EFFORT_CONFIG[effort];
  return `${formatCompactNumber(Math.max(config.maxTokens, BUILD_ROUND_MIN_TOKENS))} worker response ceiling`;
}
