// Shared team-vs-solo "lift" computation used across every certified track
// (TeamIQ today, WorkBench as of this file — any future track that runs
// BenchmarkTeamComposition rosters plugs in the same way).
//
// Extracted 2026-07-17 from lib/benchmark/scoring/aggregate.ts's applyTeamLift
// (benchmark UX overhaul Task 6) — VERBATIM semantics: team quality minus the
// best solo member's quality, exactly what scoreTeamLift (lib/benchmark/
// scoring/teamiq.ts) has always computed for the cross-track leaderboard.
// Displayed "Team lift" numbers must not change because of this extraction —
// do not touch the math here without re-checking every caller.
import type { TeamLiftScore } from "@/lib/benchmark/scoring/types";
import { finiteOrNull } from "@/lib/benchmark/scoring/types";
import { scoreTeamLift } from "@/lib/benchmark/scoring/teamiq";
import { benchmarkVariantKey } from "@/lib/benchmark/model-effort";

/**
 * The minimal shape computeTeamLift needs from an already-aggregated
 * team/solo row. Deliberately structural (not a specific row type) so it
 * accepts CertifiedRunScore rows (the cross-track leaderboard),
 * TeamIqComboMatrixRow-shaped rows (the per-track combo matrix), or any
 * other per-composition aggregate that carries these fields.
 */
export interface TeamLiftRowLike {
  modelIds: string[];
  modelVariantKeys?: string[];
  jobSuccessScore: number;
  averageCostUsd?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
  averageDurationMs?: number | null;
}

export interface ComparableTrackRowLike extends TeamLiftRowLike {
  modelVariantKeys: string[];
  trackBreakdown: Array<{
    track: string;
    averageVerifiedQuality: number;
  }>;
}

export interface ComparableTrackTeamLift {
  bestSoloScore: number;
  teamLift: number;
  label: TeamLiftScore["label"];
  tracks: string[];
}

export function computeComparableTrackTeamLift(
  teamRow: ComparableTrackRowLike,
  soloRowsByVariant: Map<string, ComparableTrackRowLike>
): ComparableTrackTeamLift | null {
  if (teamRow.modelVariantKeys.length === 0) return null;
  const soloRows = teamRow.modelVariantKeys.map((variantKey) => {
    const row = soloRowsByVariant.get(variantKey);
    return row?.modelVariantKeys.length === 1 &&
      row.modelVariantKeys[0] === variantKey
      ? row
      : undefined;
  });
  if (soloRows.some((row) => !row)) return null;

  const solos = soloRows as ComparableTrackRowLike[];
  const tracks = teamRow.trackBreakdown
    .filter((teamTrack) =>
      solos.every((solo) =>
        solo.trackBreakdown.some(
          (soloTrack) => soloTrack.track === teamTrack.track
        )
      )
    )
    .sort((a, b) => a.track.localeCompare(b.track));
  if (tracks.length === 0) return null;

  const teamScore =
    tracks.reduce(
      (sum, track) => sum + track.averageVerifiedQuality * 100,
      0
    ) / tracks.length;
  const bestSoloScore =
    tracks.reduce((sum, teamTrack) => {
      const bestOnTrack = Math.max(
        ...solos.map(
          (solo) =>
            solo.trackBreakdown.find(
              (soloTrack) => soloTrack.track === teamTrack.track
            )!.averageVerifiedQuality * 100
        )
      );
      return sum + bestOnTrack;
    }, 0) / tracks.length;
  const rowWideEfficiencyIsComparable =
    teamRow.trackBreakdown.length === tracks.length &&
    solos.every((solo) => solo.trackBreakdown.length === tracks.length);
  const bestSolo = solos.reduce((best, solo) =>
    solo.jobSuccessScore > best.jobSuccessScore ? solo : best
  );
  const score = scoreTeamLift({
    teamScore,
    memberSoloScores: [bestSoloScore],
    teamCostUsd: rowWideEfficiencyIsComparable
      ? finiteOrNull(teamRow.averageCostUsd ?? teamRow.costUsd)
      : null,
    bestSoloCostUsd: rowWideEfficiencyIsComparable
      ? finiteOrNull(bestSolo.averageCostUsd ?? bestSolo.costUsd)
      : null,
    teamDurationMs: rowWideEfficiencyIsComparable
      ? finiteOrNull(teamRow.durationMs ?? teamRow.averageDurationMs)
      : null,
    bestSoloDurationMs: rowWideEfficiencyIsComparable
      ? finiteOrNull(bestSolo.durationMs ?? bestSolo.averageDurationMs)
      : null,
  });
  return {
    bestSoloScore: score.bestSoloScore,
    teamLift: score.teamLift,
    label: score.label,
    tracks: tracks.map((track) => track.track),
  };
}

/**
 * Team quality vs. best solo member quality — the ONE shared implementation
 * every lens calls into (directly, or via lib/benchmark/teamiq/baselines.ts's
 * per-attempt linkTeamLiftBaselines, which calls the same underlying
 * scoreTeamLift). `soloRowsByModel` must carry a COMPLETE baseline: every
 * model id in `teamRow.modelIds` needs an entry, or this returns `null` — no
 * partial/misleading lift. Callers render `null` as a dash with a "no solo
 * baseline for this pack" tooltip, never as 0 or an omitted row.
 */
export function computeTeamLift(
  teamRow: TeamLiftRowLike,
  soloRowsByMemberKey: Map<string, TeamLiftRowLike>
): TeamLiftScore | null {
  const memberKeys =
    teamRow.modelVariantKeys?.length
      ? teamRow.modelVariantKeys
      : teamRow.modelIds;
  const usesLegacyModelIds = !teamRow.modelVariantKeys?.length;
  if (memberKeys.length === 0) return null;
  const soloRows = memberKeys.map((memberKey, index) => {
    const solo = soloRowsByMemberKey.get(memberKey);
    if (!solo?.modelVariantKeys?.length) {
      if (!solo || usesLegacyModelIds) return solo;
      const separator = memberKey.indexOf("\u0000");
      const modelId =
        separator > 0
          ? memberKey.slice(0, separator)
          : (teamRow.modelIds[index] ?? memberKey);
      return memberKey === benchmarkVariantKey(modelId, "default")
        ? solo
        : undefined;
    }
    const expectedVariantKey = usesLegacyModelIds
      ? benchmarkVariantKey(teamRow.modelIds[index] ?? memberKey, "default")
      : memberKey;
    return solo.modelVariantKeys.length === 1 &&
      solo.modelVariantKeys[0] === expectedVariantKey
      ? solo
      : undefined;
  });
  if (soloRows.some((row) => !row)) return null;
  const solos = soloRows as TeamLiftRowLike[];
  const bestSolo = solos.reduce((best, solo) =>
    solo.jobSuccessScore > best.jobSuccessScore ? solo : best
  );
  return scoreTeamLift({
    teamScore: teamRow.jobSuccessScore,
    memberSoloScores: solos.map((solo) => solo.jobSuccessScore),
    teamCostUsd: finiteOrNull(teamRow.averageCostUsd ?? teamRow.costUsd),
    bestSoloCostUsd: finiteOrNull(bestSolo.averageCostUsd ?? bestSolo.costUsd),
    teamDurationMs: finiteOrNull(teamRow.durationMs ?? teamRow.averageDurationMs),
    bestSoloDurationMs: finiteOrNull(
      bestSolo.durationMs ?? bestSolo.averageDurationMs
    ),
  });
}

/**
 * Stable rank for lists that mix team rows from MORE THAN ONE track — e.g.
 * the Results "Teams" lens ComboMatrix, which now shows TeamIQ and WorkBench
 * rows side by side. Highest lift first, rows with no solo baseline (null)
 * sort last, ties break by verified quality then team name — the same
 * tie-break order lib/benchmark/teamiq/combo-matrix.ts's internal compareRows
 * uses for a single track, generalized to a mixed-track list.
 */
export function sortRowsByTeamLift<
  T extends {
    teamLift: number | null;
    verifiedQuality: number;
    teamName: string;
  }
>(rows: T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (b.teamLift ?? Number.NEGATIVE_INFINITY) -
        (a.teamLift ?? Number.NEGATIVE_INFINITY) ||
      b.verifiedQuality - a.verifiedQuality ||
      a.teamName.localeCompare(b.teamName)
  );
}
