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

/**
 * The minimal shape computeTeamLift needs from an already-aggregated
 * team/solo row. Deliberately structural (not a specific row type) so it
 * accepts CertifiedRunScore rows (the cross-track leaderboard),
 * TeamIqComboMatrixRow-shaped rows (the per-track combo matrix), or any
 * other per-composition aggregate that carries these fields.
 */
export interface TeamLiftRowLike {
  modelIds: string[];
  jobSuccessScore: number;
  averageCostUsd?: number | null;
  costUsd?: number | null;
  durationMs?: number | null;
  averageDurationMs?: number | null;
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
  soloRowsByModel: Map<string, TeamLiftRowLike>
): TeamLiftScore | null {
  if (teamRow.modelIds.length === 0) return null;
  const soloRows = teamRow.modelIds.map((modelId) => soloRowsByModel.get(modelId));
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
