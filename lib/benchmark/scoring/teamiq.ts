import type { TeamLiftScore, TeamLiftScoreInput, TeamLiftLabel } from "./types";
import { finiteOrNull, round } from "./types";

export function scoreTeamLift(input: TeamLiftScoreInput): TeamLiftScore {
  const soloScores = input.memberSoloScores.filter((score) =>
    Number.isFinite(score)
  );
  const bestSoloScore = soloScores.length > 0 ? Math.max(...soloScores) : 0;
  const teamScore = round(input.teamScore);
  const teamLift = round(teamScore - bestSoloScore);
  const costAdjustedTeamLift = adjustedLift(
    teamLift,
    input.bestSoloCostUsd,
    input.teamCostUsd
  );
  const speedAdjustedTeamLift =
    adjustedLift(teamLift, input.bestSoloDurationMs, input.teamDurationMs) ??
    teamLift;

  return {
    teamScore,
    bestSoloScore,
    teamLift,
    costAdjustedTeamLift,
    speedAdjustedTeamLift,
    label: classifyTeamLift(
      teamLift,
      costAdjustedTeamLift,
      input.teamCostUsd,
      input.bestSoloCostUsd
    ),
  };
}

function classifyTeamLift(
  teamLift: number,
  costAdjustedTeamLift: number | null,
  teamCostUsd: number | null | undefined,
  bestSoloCostUsd: number | null | undefined
): TeamLiftLabel {
  const teamCost = finiteOrNull(teamCostUsd);
  const bestSoloCost = finiteOrNull(bestSoloCostUsd);
  if (
    teamLift <= 0 &&
    teamCost != null &&
    bestSoloCost != null &&
    teamCost > bestSoloCost
  ) {
    return "wasteful";
  }
  const costRatio =
    teamCost != null && bestSoloCost != null && bestSoloCost > 0
      ? teamCost / bestSoloCost
      : null;
  const overpriced = costRatio != null && costRatio > 3;

  if (teamLift >= 10 && !overpriced && (costAdjustedTeamLift ?? teamLift) > 0) {
    return "strong_positive";
  }
  if (teamLift > 3) return overpriced && teamLift < 10 ? "neutral" : "positive";
  if (teamLift >= -3 && teamLift <= 3) return "neutral";
  if (teamLift < -3) return "negative";
  return "neutral";
}

function adjustedLift(
  teamLift: number,
  baselineValue: number | null | undefined,
  teamValue: number | null | undefined
): number | null {
  const baseline = finiteOrNull(baselineValue);
  const team = finiteOrNull(teamValue);
  if (baseline == null || team == null || team <= 0 || baseline <= 0) {
    return null;
  }
  const factor = teamLift >= 0 ? baseline / team : team / baseline;
  return round(teamLift * factor);
}
