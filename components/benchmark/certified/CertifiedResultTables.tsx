"use client";

// The certified leaderboard table and the WorkBench role boards, split out of
// CertifiedBenchmarkOverview.tsx (2026-07-17 benchmark UX overhaul, Task 5) so
// both CertifiedBenchmarkOverview.tsx (legacy single-track rendering) and
// components/benchmark/results/LensTabs.tsx (the Results tab's Solo/Teams/
// Roles lenses) can reuse the exact same table markup without a circular
// import between the two.
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";
import {
  duration as formatDuration,
  formatNormalizedScore,
  formatScore,
  pct,
  usd,
} from "@/components/benchmark/format";
import {
  normalizeTrack,
  SORT_BASIS_TEXT,
  SORT_OPTIONS,
  type CertifiedLeaderboardRow,
  type CertifiedTrackView,
  type LeaderboardSortKey,
  type WorkBenchRoleBoards as WorkBenchRoleBoardsData,
  type WorkBenchRoleRow,
} from "@/lib/benchmark/certified/dashboard-selectors";

export const TRACK_LABELS: Record<CertifiedTrackView, string> = {
  all: "Certified",
  workbench: "WorkBench",
  gameiq: "GameIQ",
  teamiq: "TeamIQ",
  toolreliability: "Tool Reliability",
};

export function trackLabelFor(track: string): string {
  const normalized = normalizeTrack(track);
  return normalized ? TRACK_LABELS[normalized] : track;
}

/** role -> displayName pairs for one team's roster chip strip. */
export interface RosterRole {
  role: string;
  displayName: string;
}

export function CertifiedLeaderboard({
  rows,
  track,
  sortKey,
  onSortChange,
  paretoIds,
  deletingAttemptIds,
  deleteInFlight,
  providerErrorCount,
  onDeleteAttempt,
  onDeleteProviderErrors,
  titleOverride,
  rosterByTeamId,
}: {
  rows: CertifiedLeaderboardRow[];
  track: CertifiedTrackView;
  sortKey: LeaderboardSortKey;
  onSortChange: (key: LeaderboardSortKey) => void;
  paretoIds: Set<string>;
  deletingAttemptIds: Set<string>;
  deleteInFlight: boolean;
  providerErrorCount: number;
  onDeleteAttempt: (attemptId: string, label: string) => void;
  onDeleteProviderErrors: () => void;
  /** Overrides the computed "$Track leaderboard" title — used by LensTabs.tsx
   * to label this same table "Solo leaderboard" / "Team leaderboard" without
   * duplicating the table markup. */
  titleOverride?: string;
  /** Role -> model roster chips per team composition id, for the Teams lens.
   * Only rows whose teamCompositionId has an entry get chips rendered. */
  rosterByTeamId?: Map<string, RosterRole[]>;
}) {
  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>
            {titleOverride ??
              (track === "all"
                ? "Certified leaderboard"
                : `${TRACK_LABELS[track]} leaderboard`)}
          </CardTitle>
          <CardDescription>
            {SORT_BASIS_TEXT[sortKey]} Ranked only from scored certified
            attempts. Excluded provider, harness, environment, and user-aborted
            results stay visible as evidence and can still be removed.
          </CardDescription>
        </div>
        {providerErrorCount > 0 && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onDeleteProviderErrors}
            disabled={deleteInFlight}
            className="shrink-0"
          >
            <Trash2 className="h-4 w-4" aria-hidden="true" />
            Remove provider-error results
          </Button>
        )}
      </CardHeader>
      {rows.length > 0 && (
        <div className="px-6 pb-2">
          <LeaderboardSortSelector value={sortKey} onChange={onSortChange} />
        </div>
      )}
      {rows.length === 0 ? (
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Certified records were loaded, but there are no scored certified
          attempts for this view yet. Excluded evidence remains removable.
        </CardContent>
      ) : (
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[1020px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Team or model</th>
                <th className="px-3 py-2 font-medium">Track</th>
                <th className="px-3 py-2 text-right font-medium">Scored</th>
                <th className="px-3 py-2 text-right font-medium">
                  {sortKey === "overall" ? "Overall score" : "Verified quality"}
                </th>
                <th className="px-3 py-2 text-right font-medium">Pass</th>
                <th className="px-3 py-2 text-right font-medium">Efficiency</th>
                <th className="px-3 py-2 text-right font-medium">Tool</th>
                <th className="px-3 py-2 text-right font-medium">Tokens</th>
                <th className="px-3 py-2 text-right font-medium">Time</th>
                <th className="py-2 pl-3 text-right font-medium">Cost</th>
                <th className="py-2 pl-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 12).map((row) => (
                <tr key={row.id} className="border-b last:border-0">
                  <td className="py-3 pr-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{row.label}</span>
                      {paretoIds.has(row.id) && (
                        <span
                          className="shrink-0 rounded-sm border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400"
                          title="On the Pareto frontier: not beaten on quality, cost, speed, and team lift together."
                        >
                          Frontier
                        </span>
                      )}
                    </div>
                    {row.detail && (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {row.detail}
                      </div>
                    )}
                    <RosterChips roles={rosterByTeamId?.get(row.teamCompositionId)} />
                  </td>
                  <td className="px-3 py-3 align-top">
                    <div>{formatTrackLabel(row.tracks)}</div>
                    <CaseTitlesCell titles={row.caseTitles} />
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    <span>{row.attempts}</span>
                    {row.preliminary && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        preliminary
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {sortKey === "overall" ? (
                      <span
                        title={overallScoreTooltip(row)}
                        className="underline decoration-dotted underline-offset-2"
                      >
                        {formatNormalizedScore(
                          row.overallScore ?? row.verifiedQuality
                        )}
                      </span>
                    ) : (
                      formatNormalizedScore(row.verifiedQuality)
                    )}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {pct(row.passRate)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {formatScore(row.efficiencyScore)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {formatScore(row.toolReliabilityScore)}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    <div>{formatTokenCount(row.totalTokens)}</div>
                    {row.tokensPerPass != null && (
                      <div className="text-xs text-muted-foreground">
                        {formatTokenCount(row.tokensPerPass)}/pass
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    <div>{formatDuration(row.durationMs)}</div>
                    {row.speedPerPassMs != null && (
                      <div className="text-xs text-muted-foreground">
                        {formatDuration(row.speedPerPassMs)}/pass
                      </div>
                    )}
                  </td>
                  <td className="py-3 pl-3 text-right tabular-nums">
                    {row.averageCostUsd != null ? (
                      usd(row.averageCostUsd)
                    ) : (
                      <div className="text-muted-foreground">
                        <div>— (no pricing)</div>
                        {row.tokensPerPass != null && (
                          <div className="text-xs">
                            {formatTokenCount(row.tokensPerPass)} tokens/pass
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="py-3 pl-3 text-right">
                    {row.latestAttemptId ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => onDeleteAttempt(row.latestAttemptId!, row.label)}
                        disabled={
                          deleteInFlight ||
                          deletingAttemptIds.has(row.latestAttemptId)
                        }
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                        Remove
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">n/a</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      )}
    </Card>
  );
}

function RosterChips({ roles }: { roles?: RosterRole[] }) {
  if (!roles || roles.length === 0) return null;
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {roles.map((chip, index) => (
        <span
          key={`${chip.role}:${index}`}
          className="rounded-sm border bg-muted/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          {chip.role}: {chip.displayName}
        </span>
      ))}
    </div>
  );
}

function LeaderboardSortSelector({
  value,
  onChange,
}: {
  value: LeaderboardSortKey;
  onChange: (key: LeaderboardSortKey) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Rank by
      </span>
      <div className="inline-flex flex-wrap gap-1 rounded-md border bg-muted/40 p-1">
        {SORT_OPTIONS.map((option) => (
          <button
            key={option.key}
            type="button"
            aria-pressed={value === option.key}
            onClick={() => onChange(option.key)}
            className={`rounded-sm px-2.5 py-1 text-xs font-medium transition-colors ${
              value === option.key
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// Trim the noisy shared prefix certified case titles carry ("Certified GameIQ
// v1: Chess Tactics" -> "Chess Tactics") for a compact leaderboard cell. Only a
// leading "Certified <track> <version>:" style prefix is stripped; titles
// without that prefix (e.g. "ToolReliability current challenge pack") are left
// as-is. Full titles remain in the data; this is display-only.
function shortenCaseTitle(title: string): string {
  const match = /^certified\b.*?:\s*(.+)$/i.exec(title);
  const shortened = match ? match[1].trim() : title.trim();
  return shortened.length > 0 ? shortened : title;
}

// The pack/case names for one leaderboard row: first two shortened titles, then
// "+N more", with the full (unshortened) list in the cell's title tooltip so no
// information is lost. Returns null when the row has no resolved case titles.
function CaseTitlesCell({ titles }: { titles: string[] }) {
  if (titles.length === 0) return null;
  const shown = titles.slice(0, 2).map(shortenCaseTitle);
  const remaining = titles.length - shown.length;
  const label =
    remaining > 0 ? `${shown.join(", ")} +${remaining} more` : shown.join(", ");
  return (
    <div
      className="mt-0.5 text-xs text-muted-foreground"
      title={titles.join("\n")}
    >
      {label}
    </div>
  );
}

// Tooltip text for the overall-score cell: names the per-track quality figures
// the equal-weighted mean averages, so the reader sees WHAT the number is made
// of without opening the leaderboard math.
function overallScoreTooltip(row: CertifiedLeaderboardRow): string {
  if (row.trackBreakdown.length === 0) {
    return "Overall score averages each track's quality equally.";
  }
  const parts = row.trackBreakdown.map(
    (entry) =>
      `${trackLabelFor(entry.track)} ${formatNormalizedScore(
        entry.averageVerifiedQuality
      )}`
  );
  return `Equal-weighted mean of: ${parts.join(", ")}`;
}

function formatTrackLabel(tracks: string[]): string {
  if (tracks.length === 0) return "Mixed";
  const labels = tracks.map((track) => {
    const normalized = normalizeTrack(track);
    return normalized ? TRACK_LABELS[normalized] : track;
  });
  return Array.from(new Set(labels)).join(", ");
}

function formatTokenCount(value: number | null): string {
  if (value == null) return "n/a";
  return value.toLocaleString();
}

export function WorkBenchRoleLeaderboards({
  boards,
}: {
  boards: WorkBenchRoleBoardsData;
}) {
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <WorkBenchRoleLeaderboard title="Best Architect" rows={boards.architect} />
      <WorkBenchRoleLeaderboard title="Best Worker" rows={boards.worker} />
      <WorkBenchRoleLeaderboard title="Best Reviewer" rows={boards.reviewer} />
    </div>
  );
}

function WorkBenchRoleLeaderboard({
  title,
  rows,
}: {
  title: string;
  rows: WorkBenchRoleRow[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? (
          <div className="text-sm text-muted-foreground">No role attempts yet.</div>
        ) : (
          rows.slice(0, 5).map((row) => (
            <div key={row.id} className="border-b pb-3 last:border-0 last:pb-0">
              <div className="truncate text-sm font-medium">{row.displayName}</div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{formatNormalizedScore(row.verifiedQuality)} quality</span>
                <span>{pct(row.verifiedPassRate)} pass</span>
                <span>{row.attempts} attempts</span>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
