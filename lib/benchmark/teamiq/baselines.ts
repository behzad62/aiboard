import type {
  BenchmarkAttemptV2,
  BenchmarkTeamComposition,
} from "@/lib/benchmark/types";
import { scoreTeamLift } from "@/lib/benchmark/scoring/teamiq";
import type { TeamLiftScore } from "@/lib/benchmark/scoring/types";
import {
  getTeamCompositionModelIds,
  isSoloTeamComposition,
} from "./compositions";

export interface TeamIqBaselineInput {
  soloAttempts: BenchmarkAttemptV2[];
  teamAttempts: BenchmarkAttemptV2[];
  teamCompositions: BenchmarkTeamComposition[];
  track?: BenchmarkAttemptV2["track"];
}

export interface TeamIqBaselineLink {
  teamAttempt: BenchmarkAttemptV2;
  teamComposition: BenchmarkTeamComposition;
  memberSoloAttempts: BenchmarkAttemptV2[];
  bestSoloAttempt: BenchmarkAttemptV2 | null;
  score: TeamLiftScore;
}

interface SoloCandidate {
  attempt: BenchmarkAttemptV2;
  modelId: string;
}

export function linkTeamLiftBaselines(
  input: TeamIqBaselineInput
): TeamIqBaselineLink[] {
  const teamsById = new Map(
    input.teamCompositions.map((team) => [team.id, team])
  );
  const soloCandidates = input.soloAttempts
    .filter((attempt) => matchesTrack(attempt, input.track))
    .map((attempt): SoloCandidate | null => {
      const team = teamsById.get(attempt.teamCompositionId);
      if (!isSoloTeamComposition(team)) return null;
      const modelId = getTeamCompositionModelIds(team)[0];
      return modelId ? { attempt, modelId } : null;
    })
    .filter((candidate): candidate is SoloCandidate => candidate !== null);

  const links: TeamIqBaselineLink[] = [];
  for (const teamAttempt of input.teamAttempts) {
    if (!matchesTrack(teamAttempt, input.track)) continue;
    const teamComposition = teamsById.get(teamAttempt.teamCompositionId);
    const modelIds = getTeamCompositionModelIds(teamComposition);
    if (!teamComposition || modelIds.length <= 1) continue;

    const memberSoloAttempts = modelIds
      .map((modelId) =>
        bestSoloAttemptForModel(soloCandidates, modelId, teamAttempt)
      )
      .filter((attempt): attempt is BenchmarkAttemptV2 => attempt !== null);
    if (memberSoloAttempts.length !== modelIds.length) continue;

    const bestSoloAttempt = memberSoloAttempts.reduce((best, attempt) =>
      scoreForAttempt(attempt) > scoreForAttempt(best) ? attempt : best
    );
    const score = scoreTeamLift({
      teamScore: scoreForAttempt(teamAttempt),
      memberSoloScores: memberSoloAttempts.map(scoreForAttempt),
      teamCostUsd: finiteOrNull(teamAttempt.costUsd),
      bestSoloCostUsd: finiteOrNull(bestSoloAttempt.costUsd),
      teamDurationMs: finiteOrNull(teamAttempt.durationMs),
      bestSoloDurationMs: finiteOrNull(bestSoloAttempt.durationMs),
    });

    links.push({
      teamAttempt,
      teamComposition,
      memberSoloAttempts,
      bestSoloAttempt,
      score,
    });
  }

  return links;
}

function bestSoloAttemptForModel(
  candidates: SoloCandidate[],
  modelId: string,
  teamAttempt: BenchmarkAttemptV2
): BenchmarkAttemptV2 | null {
  const matches = candidates.filter(
    (candidate) =>
      candidate.modelId === modelId &&
      candidate.attempt.caseId === teamAttempt.caseId &&
      candidate.attempt.track === teamAttempt.track &&
      candidate.attempt.harnessVersion === teamAttempt.harnessVersion &&
      candidate.attempt.scoringVersion === teamAttempt.scoringVersion
  );
  if (matches.length === 0) return null;
  return matches.reduce((best, candidate) =>
    scoreForAttempt(candidate.attempt) > scoreForAttempt(best.attempt)
      ? candidate
      : best
  ).attempt;
}

function matchesTrack(
  attempt: BenchmarkAttemptV2,
  track: BenchmarkAttemptV2["track"] | undefined
): boolean {
  return !track || attempt.track === track;
}

function scoreForAttempt(attempt: BenchmarkAttemptV2): number {
  if (Number.isFinite(attempt.jobSuccessScore)) return attempt.jobSuccessScore;
  return Number.isFinite(attempt.verifiedQuality)
    ? attempt.verifiedQuality * 100
    : 0;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
