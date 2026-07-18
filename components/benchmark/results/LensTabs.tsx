"use client";

// Segmented lens control over the Results tab's leaderboard area. Replaces the
// old per-track duplication (a dedicated TeamIQ tab was the only place team
// vs. solo comparison rendered; WorkBench teams collapsed into per-role
// boards; Build teams collapsed into per-model stats) with one Solo/Teams/
// Roles/Live-builds toggle that spans every track's data at once.
// 2026-07-17 benchmark UX overhaul, Task 5.
import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ComboMatrix } from "@/components/benchmark/teamiq/ComboMatrix";
import { ParetoFrontier } from "@/components/benchmark/teamiq/ParetoFrontier";
import {
  CertifiedLeaderboard,
  WorkBenchRoleLeaderboards,
  type RosterRole,
} from "@/components/benchmark/certified/CertifiedResultTables";
import { getBenchmarkTeamCompositions } from "@/lib/client/store";
import {
  isTeamRow,
  type CertifiedLeaderboardRow,
  type LeaderboardSortKey,
  type WorkBenchRoleBoards,
} from "@/lib/benchmark/certified/dashboard-selectors";
import type {
  TeamIqComboMatrixRow,
  TeamIqRecommendationCard,
} from "@/lib/benchmark/teamiq";

type Lens = "solo" | "teams" | "roles";

const LENSES: Array<{ key: Lens; label: string }> = [
  { key: "solo", label: "Solo" },
  { key: "teams", label: "Teams" },
  { key: "roles", label: "Roles" },
];

export function LensTabs({
  leaderboard,
  sortKey,
  onSortChange,
  paretoIds,
  teamIqRows,
  teamIqCards,
  workBenchRoleBoards,
  deletingAttemptIds,
  deleteInFlight,
  providerErrorAttemptIds,
  onDeleteAttempt,
  onDeleteProviderErrors,
}: {
  /** The "all tracks" leaderboard (already ranked by sortKey). Solo/Teams
   * split it client-side by member count — never re-fetched or re-ranked. */
  leaderboard: CertifiedLeaderboardRow[];
  sortKey: LeaderboardSortKey;
  onSortChange: (key: LeaderboardSortKey) => void;
  paretoIds: Set<string>;
  teamIqRows: TeamIqComboMatrixRow[];
  teamIqCards: TeamIqRecommendationCard[];
  workBenchRoleBoards: WorkBenchRoleBoards;
  deletingAttemptIds: Set<string>;
  deleteInFlight: boolean;
  providerErrorAttemptIds: string[];
  onDeleteAttempt: (attemptId: string, label: string) => void;
  onDeleteProviderErrors: () => void;
}) {
  const [lens, setLens] = useState<Lens>("solo");

  const soloRows = useMemo(
    () => leaderboard.filter((row) => !isTeamRow(row)),
    [leaderboard]
  );
  const teamRows = useMemo(() => leaderboard.filter(isTeamRow), [leaderboard]);
  const rosterByTeamId = useMemo(() => buildRosterByTeamId(teamRows), [teamRows]);

  const hasWorkBenchRoleBoards =
    workBenchRoleBoards.architect.length > 0 ||
    workBenchRoleBoards.worker.length > 0 ||
    workBenchRoleBoards.reviewer.length > 0;

  return (
    <div className="space-y-4">
      <div
        role="tablist"
        aria-label="Results lens"
        className="inline-flex flex-wrap gap-1 rounded-md border bg-muted/40 p-1"
      >
        {LENSES.map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={lens === item.key}
            onClick={() => setLens(item.key)}
            className={`rounded-sm px-3 py-1.5 text-sm font-medium transition-colors ${
              lens === item.key
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      {lens === "solo" &&
        (soloRows.length === 0 ? (
          <LensEmptyState text="No solo runs yet — run a certified benchmark to rank models solo." />
        ) : (
          <CertifiedLeaderboard
            rows={soloRows}
            track="all"
            titleOverride="Solo leaderboard"
            sortKey={sortKey}
            onSortChange={onSortChange}
            paretoIds={paretoIds}
            deletingAttemptIds={deletingAttemptIds}
            deleteInFlight={deleteInFlight}
            providerErrorCount={providerErrorAttemptIds.length}
            onDeleteAttempt={onDeleteAttempt}
            onDeleteProviderErrors={onDeleteProviderErrors}
          />
        ))}

      {lens === "teams" && (
        <div className="space-y-4">
          {teamRows.length === 0 ? (
            <LensEmptyState text="No team runs yet — run the TeamIQ pack (or a WorkBench team) with solo baselines to compare teams." />
          ) : (
            <CertifiedLeaderboard
              rows={teamRows}
              track="all"
              titleOverride="Team leaderboard"
              sortKey={sortKey}
              onSortChange={onSortChange}
              paretoIds={paretoIds}
              deletingAttemptIds={deletingAttemptIds}
              deleteInFlight={deleteInFlight}
              providerErrorCount={0}
              onDeleteAttempt={onDeleteAttempt}
              onDeleteProviderErrors={onDeleteProviderErrors}
              rosterByTeamId={rosterByTeamId}
            />
          )}
          <ParetoFrontier rows={teamIqRows} cards={teamIqCards} />
          <ComboMatrix rows={teamIqRows} />
        </div>
      )}

      {lens === "roles" &&
        (hasWorkBenchRoleBoards ? (
          <WorkBenchRoleLeaderboards boards={workBenchRoleBoards} />
        ) : (
          <LensEmptyState text="No WorkBench role attempts yet — run a WorkBench team to populate the architect, worker, and reviewer boards." />
        ))}

    </div>
  );
}

function LensEmptyState({ text }: { text: string }) {
  return (
    <Card>
      <CardContent className="py-8 text-center text-sm text-muted-foreground">
        {text}
      </CardContent>
    </Card>
  );
}

// Team roster chips: role -> model, read from the SAME team composition store
// getter AttemptDetailPanel.tsx uses (getBenchmarkTeamCompositions), keyed by
// teamCompositionId (not the leaderboard row's `id`, which is the comboHash).
function buildRosterByTeamId(
  teamRows: CertifiedLeaderboardRow[]
): Map<string, RosterRole[]> {
  const map = new Map<string, RosterRole[]>();
  if (teamRows.length === 0) return map;
  const teamIds = new Set(teamRows.map((row) => row.teamCompositionId));
  if (teamIds.size === 0) return map;
  for (const team of getBenchmarkTeamCompositions()) {
    if (!teamIds.has(team.id)) continue;
    map.set(
      team.id,
      (team.roles ?? []).map((role) => ({
        role: role.role,
        displayName: role.displayName ?? role.modelId,
      }))
    );
  }
  return map;
}
