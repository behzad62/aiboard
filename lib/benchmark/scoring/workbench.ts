import type { WorkBenchScore, WorkBenchScoreInput } from "./types";
import { clamp01, finiteOrNull, round } from "./types";

export function scoreWorkBenchAttempt(input: WorkBenchScoreInput): WorkBenchScore {
  const verifierScore = clamp01(input.verifierScore);
  const verifiedQuality = input.verifierPassed ? verifierScore : 0;
  const jobSuccessScore = round(verifiedQuality * 100);
  const costFactor = boundedTargetFactor(input.targetCostUsd, input.actualCostUsd);
  const timeFactor =
    boundedTargetFactor(
      input.targetDurationMs,
      input.actualDurationMs
    ) ?? 1;
  const totalToolCalls = Math.max(0, input.totalToolCalls);
  const toolReliability =
    totalToolCalls > 0
      ? clamp01(input.validToolCalls / totalToolCalls)
      : null;

  // Weights: 0.5 base + 0.25 cost + 0.15 time + 0.1 tool = 1.0. When cost is
  // unknown (no pricing for the provider), do NOT award the full 0.25 cost
  // credit — that biased unpriced/custom-provider models above fully-priced
  // ones. Likewise, no tool calls means no tool-reliability sample. Renormalize
  // over the dimensions that have evidence so missing evidence is neutral.
  const weightedScore =
    0.5 +
    0.15 * timeFactor +
    (costFactor == null ? 0 : 0.25 * costFactor) +
    (toolReliability == null ? 0 : 0.1 * toolReliability);
  const availableWeight =
    0.5 +
    0.15 +
    (costFactor == null ? 0 : 0.25) +
    (toolReliability == null ? 0 : 0.1);
  const efficiencyMultiplier = weightedScore / availableWeight;
  const efficiencyScore =
    verifiedQuality === 0 ? 0 : round(jobSuccessScore * efficiencyMultiplier);

  return {
    verifiedQuality,
    jobSuccessScore,
    efficiencyScore,
    costFactor,
    timeFactor,
    toolReliability,
  };
}

function boundedTargetFactor(
  targetValue: number | null | undefined,
  actualValue: number | null | undefined
): number | null {
  const target = finiteOrNull(targetValue);
  const actual = finiteOrNull(actualValue);
  if (target == null || target <= 0 || actual == null) return null;
  if (actual <= 0) return 1;
  return clamp01(target / actual);
}
