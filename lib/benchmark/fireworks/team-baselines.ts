import type { BenchmarkAttemptV2 } from "@/lib/benchmark/types";

export interface FireworksTeamLiftResult {
  teamScore: number;
  bestSoloScore: number;
  teamLift: number;
  label: "strong_positive" | "positive" | "neutral" | "negative" | "wasteful";
}

export function scoreFireworksTeamLift(input: {
  teamAttempt: BenchmarkAttemptV2;
  soloAttempts: BenchmarkAttemptV2[];
}): FireworksTeamLiftResult {
  const teamScore = scoreForAttempt(input.teamAttempt);
  const bestSoloScore =
    input.soloAttempts.length > 0
      ? Math.max(...input.soloAttempts.map(scoreForAttempt))
      : 0;
  const teamLift = Math.round((teamScore - bestSoloScore) * 10) / 10;
  return {
    teamScore,
    bestSoloScore,
    teamLift,
    label: labelForLift(teamLift, input.teamAttempt.costUsd),
  };
}

function scoreForAttempt(attempt: BenchmarkAttemptV2): number {
  if (Number.isFinite(attempt.jobSuccessScore)) return attempt.jobSuccessScore;
  return Number.isFinite(attempt.verifiedQuality)
    ? attempt.verifiedQuality * 100
    : 0;
}

function labelForLift(
  teamLift: number,
  costUsd: number | null
): FireworksTeamLiftResult["label"] {
  if (teamLift >= 10) return "strong_positive";
  if (teamLift >= 3) return "positive";
  if (teamLift >= -3) return "neutral";
  if (costUsd !== null && costUsd > 0 && teamLift < -10) return "wasteful";
  return "negative";
}
