import type { DiscussionMode, EffortLevel } from "../db/schema";

export interface EffortConfig {
  maxRounds: number;
  maxTokens: number;
  convergenceThreshold: number;
  skipConvergenceVote: boolean;
  temperature: number;
}

export const EFFORT_CONFIG: Record<EffortLevel, EffortConfig> = {
  low: {
    maxRounds: 2,
    maxTokens: 800,
    convergenceThreshold: 7,
    skipConvergenceVote: true,
    temperature: 0.6,
  },
  medium: {
    maxRounds: 4,
    maxTokens: 1500,
    convergenceThreshold: 7.5,
    skipConvergenceVote: false,
    temperature: 0.7,
  },
  high: {
    maxRounds: 6,
    maxTokens: 2500,
    convergenceThreshold: 8,
    skipConvergenceVote: false,
    temperature: 0.75,
  },
};

export function estimateDiscussionCost(
  modelCount: number,
  effort: EffortLevel
): { minUsd: number; maxUsd: number; label: string } {
  const config = EFFORT_CONFIG[effort];
  const rounds = config.maxRounds + 1;
  const calls = modelCount * rounds + 1;
  const minUsd = calls * 0.002;
  const maxUsd = calls * 0.05 * (effort === "high" ? 1.5 : 1);
  return {
    minUsd,
    maxUsd,
    label: `$${minUsd.toFixed(2)} – $${maxUsd.toFixed(2)} (${calls} API calls approx.)`,
  };
}

export function getModeLabel(mode: DiscussionMode): string {
  switch (mode) {
    case "panel":
      return "Collaborative Panel";
    case "debate":
      return "Debate";
    case "specialist":
      return "Specialist + Reviewers";
  }
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
