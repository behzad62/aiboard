import type {
  BenchmarkAttemptV2,
  BenchmarkTeamComposition,
} from "@/lib/benchmark/types";
import { computeParetoFrontier } from "@/lib/benchmark/scoring/pareto";
import type { TeamLiftLabel } from "@/lib/benchmark/scoring/types";
import {
  getTeamCompositionModelIds,
  isSoloTeamComposition,
} from "./compositions";
import { linkTeamLiftBaselines } from "./baselines";
import { MIN_CONFIDENT_ATTEMPTS } from "./recommendations";

export type TeamIqRecommendationLabel =
  | "recommended"
  | "tradeoff"
  | "watch"
  | "dominated"
  | "solo_baseline"
  | "insufficient_data";

export interface TeamIqComboMatrixInput {
  attempts: BenchmarkAttemptV2[];
  teamCompositions: BenchmarkTeamComposition[];
  track?: BenchmarkAttemptV2["track"];
  includeSolos?: boolean;
}

export interface TeamIqComboMatrixRow {
  id: string;
  teamCompositionId: string;
  teamName: string;
  comboHash: string;
  track: BenchmarkAttemptV2["track"];
  modelIds: string[];
  isSolo: boolean;
  attempts: number;
  verifiedQuality: number;
  jobSuccessScore: number;
  costUsd: number | null;
  averageCostUsd: number | null;
  durationMs: number | null;
  averageDurationMs: number | null;
  bestSoloScore: number | null;
  teamLift: number | null;
  teamLiftLabel: TeamLiftLabel | null;
  isParetoRecommended: boolean;
  recommendationLabel: TeamIqRecommendationLabel;
}

interface MutableComboRow {
  teamCompositionId: string;
  teamName: string;
  comboHash: string;
  track: BenchmarkAttemptV2["track"];
  modelIds: string[];
  attempts: number;
  verifiedQualitySum: number;
  jobSuccessScoreSum: number;
  costUsd: number;
  costSamples: number;
  durationMs: number;
  durationSamples: number;
  bestSoloScoreSum: number;
  teamLiftSum: number;
  teamLiftSamples: number;
  teamLiftLabels: Map<TeamLiftLabel, number>;
  isSolo: boolean;
}

export function buildTeamIqComboMatrixRows(
  input: TeamIqComboMatrixInput
): TeamIqComboMatrixRow[] {
  const teamsById = new Map(
    input.teamCompositions.map((team) => [team.id, team])
  );
  const filteredAttempts = input.attempts.filter(
    (attempt) =>
      attempt.mode === "certified" &&
      (!input.track || attempt.track === input.track)
  );
  const soloAttempts = filteredAttempts.filter((attempt) =>
    isSoloTeamComposition(teamsById.get(attempt.teamCompositionId))
  );
  const teamAttempts = filteredAttempts.filter(
    (attempt) =>
      !isSoloTeamComposition(teamsById.get(attempt.teamCompositionId))
  );
  const liftByAttemptId = new Map(
    linkTeamLiftBaselines({
      soloAttempts,
      teamAttempts,
      teamCompositions: input.teamCompositions,
      track: input.track,
    }).map((link) => [link.teamAttempt.id, link])
  );
  const groups = new Map<string, MutableComboRow>();

  for (const attempt of filteredAttempts) {
    const team = teamsById.get(attempt.teamCompositionId);
    const modelIds = getTeamCompositionModelIds(team);
    const isSolo = isSoloTeamComposition(team);
    if (!input.includeSolos && isSolo) continue;
    if (modelIds.length === 0) continue;

    const group = groupFor(groups, attempt, team, modelIds, isSolo);
    group.attempts += 1;
    group.verifiedQualitySum += finiteNumber(attempt.verifiedQuality);
    group.jobSuccessScoreSum += scoreForAttempt(attempt);

    const cost = finiteOrNull(attempt.costUsd);
    if (cost != null) {
      group.costUsd += cost;
      group.costSamples += 1;
    }
    const duration = finiteOrNull(attempt.durationMs);
    if (duration != null) {
      group.durationMs += duration;
      group.durationSamples += 1;
    }

    const lift = liftByAttemptId.get(attempt.id);
    if (lift) {
      group.bestSoloScoreSum += lift.score.bestSoloScore;
      group.teamLiftSum += lift.score.teamLift;
      group.teamLiftSamples += 1;
      group.teamLiftLabels.set(
        lift.score.label,
        (group.teamLiftLabels.get(lift.score.label) ?? 0) + 1
      );
    }
  }

  const rows = Array.from(groups.values()).map(finalizeGroup);
  applyParetoRecommendations(rows);
  return rows.sort(compareRows);
}

function groupFor(
  groups: Map<string, MutableComboRow>,
  attempt: BenchmarkAttemptV2,
  team: BenchmarkTeamComposition | undefined,
  modelIds: string[],
  isSolo: boolean
): MutableComboRow {
  const key = `${attempt.teamCompositionId}\u0000${attempt.track}`;
  const existing = groups.get(key);
  if (existing) return existing;

  const created: MutableComboRow = {
    teamCompositionId: attempt.teamCompositionId,
    teamName: team?.name ?? modelIds.join(" + "),
    comboHash: team?.comboHash ?? attempt.teamCompositionId,
    track: attempt.track,
    modelIds,
    attempts: 0,
    verifiedQualitySum: 0,
    jobSuccessScoreSum: 0,
    costUsd: 0,
    costSamples: 0,
    durationMs: 0,
    durationSamples: 0,
    bestSoloScoreSum: 0,
    teamLiftSum: 0,
    teamLiftSamples: 0,
    teamLiftLabels: new Map(),
    isSolo,
  };
  groups.set(key, created);
  return created;
}

function finalizeGroup(group: MutableComboRow): TeamIqComboMatrixRow {
  const row: TeamIqComboMatrixRow = {
    id: `${group.comboHash}:${group.track}`,
    teamCompositionId: group.teamCompositionId,
    teamName: group.teamName,
    comboHash: group.comboHash,
    track: group.track,
    modelIds: group.modelIds,
    isSolo: group.isSolo,
    attempts: group.attempts,
    verifiedQuality: average(group.verifiedQualitySum, group.attempts, 4),
    jobSuccessScore: average(group.jobSuccessScoreSum, group.attempts, 2),
    costUsd: group.costSamples > 0 ? round(group.costUsd, 6) : null,
    averageCostUsd:
      group.costSamples > 0 ? round(group.costUsd / group.costSamples, 6) : null,
    durationMs:
      group.durationSamples > 0
        ? round(group.durationMs / group.durationSamples)
        : null,
    averageDurationMs:
      group.durationSamples > 0
        ? round(group.durationMs / group.durationSamples)
        : null,
    bestSoloScore:
      group.teamLiftSamples > 0
        ? average(group.bestSoloScoreSum, group.teamLiftSamples, 2)
        : null,
    teamLift:
      group.teamLiftSamples > 0
        ? average(group.teamLiftSum, group.teamLiftSamples, 2)
        : null,
    teamLiftLabel:
      group.teamLiftSamples > 0 ? mostCommonLabel(group.teamLiftLabels) : null,
    isParetoRecommended: false,
    recommendationLabel: group.isSolo ? "solo_baseline" : "insufficient_data",
  };
  return row;
}

function applyParetoRecommendations(rows: TeamIqComboMatrixRow[]): void {
  const allCandidates = rows.filter(
    (row) => !row.isSolo && row.attempts > 0 && row.teamLift !== null
  );
  const confidentCandidates = allCandidates.filter(
    (row) => row.attempts >= MIN_CONFIDENT_ATTEMPTS
  );
  const candidates =
    confidentCandidates.length > 0 ? confidentCandidates : allCandidates;
  const frontier = new Set(
    computeParetoFrontier(candidates, [
      {
        key: "verifiedQuality",
        direction: "higher",
        value: (row) => row.verifiedQuality,
      },
      {
        key: "averageCostUsd",
        direction: "lower",
        value: (row) => row.averageCostUsd ?? Number.POSITIVE_INFINITY,
      },
      {
        key: "averageDurationMs",
        direction: "lower",
        value: (row) => row.averageDurationMs ?? Number.POSITIVE_INFINITY,
      },
    ])
  );

  for (const row of rows) {
    if (row.isSolo) {
      row.recommendationLabel = "solo_baseline";
      continue;
    }
    row.isParetoRecommended = frontier.has(row);
    row.recommendationLabel = recommendationFor(row);
  }
}

function recommendationFor(
  row: TeamIqComboMatrixRow
): TeamIqRecommendationLabel {
  if (row.attempts === 0) return "insufficient_data";
  if (row.teamLiftLabel == null) return "insufficient_data";
  if (!row.isParetoRecommended) return "dominated";
  if (row.teamLiftLabel === "negative" || row.teamLiftLabel === "wasteful") {
    return "watch";
  }
  if (row.teamLiftLabel === "neutral") return "tradeoff";
  return "recommended";
}

function mostCommonLabel(labels: Map<TeamLiftLabel, number>): TeamLiftLabel {
  return Array.from(labels.entries()).sort((a, b) => b[1] - a[1])[0][0];
}

function scoreForAttempt(attempt: BenchmarkAttemptV2): number {
  if (Number.isFinite(attempt.jobSuccessScore)) return attempt.jobSuccessScore;
  return Number.isFinite(attempt.verifiedQuality)
    ? attempt.verifiedQuality * 100
    : 0;
}

function finiteNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function average(sum: number, count: number, digits: number): number {
  return count > 0 ? round(sum / count, digits) : 0;
}

function round(value: number, digits = 0): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function compareRows(
  a: TeamIqComboMatrixRow,
  b: TeamIqComboMatrixRow
): number {
  return (
    Number(b.isParetoRecommended) - Number(a.isParetoRecommended) ||
    (b.teamLift ?? Number.NEGATIVE_INFINITY) -
      (a.teamLift ?? Number.NEGATIVE_INFINITY) ||
    b.verifiedQuality - a.verifiedQuality ||
    a.teamName.localeCompare(b.teamName)
  );
}
