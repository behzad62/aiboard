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
  const toolReliability = clamp01(
    input.validToolCalls / Math.max(input.totalToolCalls, 1)
  );

  const efficiencyScore = verifiedQuality === 0
    ? 0
    : round(
        jobSuccessScore *
          (0.5 +
            0.25 * (costFactor ?? 1) +
            0.15 * timeFactor +
            0.1 * toolReliability)
      );

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
