"use client";

import React, { useMemo, useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  duration as formatDuration,
  formatNormalizedScore,
  formatScore,
  pct,
  usd,
} from "@/components/benchmark/format";
import type { BenchmarkReportCounts } from "@/components/benchmark/useBenchmarkDashboard";
import { ComboMatrix } from "@/components/benchmark/teamiq/ComboMatrix";
import { ParetoFrontier } from "@/components/benchmark/teamiq/ParetoFrontier";
import { deleteBenchmarkAttemptsCascade } from "@/lib/benchmark/store";
import type { BenchmarkTrack } from "@/lib/benchmark/types";
import type {
  TeamIqComboMatrixRow,
  TeamIqRecommendationCard,
  TeamIqRecommendationLabel,
} from "@/lib/benchmark/teamiq";

export type CertifiedTrackView =
  | "all"
  | "workbench"
  | "gameiq"
  | "teamiq"
  | "toolreliability";

const TRACK_LABELS: Record<CertifiedTrackView, string> = {
  all: "Certified",
  workbench: "WorkBench",
  gameiq: "GameIQ",
  teamiq: "TeamIQ",
  toolreliability: "Tool Reliability",
};

type LeaderboardSortKey =
  | "quality"
  | "overall"
  | "teamLift"
  | "costPerPass"
  | "speedPerPass"
  | "toolReliability"
  | "efficiency";

const SORT_OPTIONS: Array<{ key: LeaderboardSortKey; label: string }> = [
  { key: "quality", label: "Quality" },
  { key: "overall", label: "Overall (all tracks)" },
  { key: "teamLift", label: "Team lift" },
  { key: "costPerPass", label: "Cost or tokens/pass" },
  { key: "speedPerPass", label: "Speed/pass" },
  { key: "toolReliability", label: "Tool reliability" },
  { key: "efficiency", label: "Efficiency" },
];

// Which pre-computed dashboard array backs each sort choice. Components never
// re-sort here; the leaderboards below are already ranked in lib/benchmark.
const SORT_SOURCE_KEY: Record<
  LeaderboardSortKey,
  | "leaderboard"
  | "overallLeaderboard"
  | "teamLiftLeaderboard"
  | "costPerPassLeaderboard"
  | "speedPerPassLeaderboard"
  | "toolReliabilityLeaderboard"
  | "efficiencyLeaderboard"
> = {
  quality: "leaderboard",
  overall: "overallLeaderboard",
  teamLift: "teamLiftLeaderboard",
  costPerPass: "costPerPassLeaderboard",
  speedPerPass: "speedPerPassLeaderboard",
  toolReliability: "toolReliabilityLeaderboard",
  efficiency: "efficiencyLeaderboard",
};

const SORT_BASIS_TEXT: Record<LeaderboardSortKey, string> = {
  quality: "Ranked by verified quality.",
  overall:
    "Ranked by overall score — each track's quality weighted equally, then averaged across the tracks the row ran.",
  teamLift: "Ranked by team lift over the best solo member.",
  costPerPass:
    "Ranked by cost per passed case (lowest first). Rows without pricing (account or custom providers) fall back to tokens per passed case and rank after priced rows.",
  speedPerPass: "Ranked by time per passed case (fastest first).",
  toolReliability: "Ranked by tool-reliability score.",
  efficiency: "Ranked by efficiency (quality vs cost and time).",
};

export function CertifiedBenchmarkOverview({
  certified,
  counts,
  track = "all",
  corruptRunFileCount = 0,
  onRefresh,
  setMessage,
}: {
  certified: unknown | null;
  counts: BenchmarkReportCounts;
  track?: CertifiedTrackView;
  corruptRunFileCount?: number;
  onRefresh?: () => Promise<void>;
  setMessage?: (message: string | null) => void;
}) {
  const [deletingAttemptIds, setDeletingAttemptIds] = useState<Set<string>>(
    () => new Set()
  );
  const deletionInFlightRef = useRef(false);
  const [deleteInFlight, setDeleteInFlight] = useState(false);
  const [sortKey, setSortKey] = useState<LeaderboardSortKey>("quality");
  const summary = readCertifiedSummary(certified, counts);
  const isTrackView = track !== "all";
  const leaderboard = useMemo(
    () => readLeaderboard(certified, track, sortKey),
    [certified, track, sortKey]
  );
  const paretoIds = useMemo(() => readParetoIds(certified), [certified]);
  const trackRows = useMemo(() => readTrackRows(certified), [certified]);
  const trackStat = isTrackView
    ? trackRows.find((row) => normalizeTrack(row.track) === track) ?? null
    : null;
  const providerErrorAttemptIds = readProviderErrorAttemptIds(certified, track);
  const teamIqRows = readTeamIqComboMatrixRows(certified);
  const teamIqCards = readTeamIqRecommendationCards(certified);
  const bestTeamLiftCard = teamIqCards.find((card) => card.kind === "best_team_lift");
  const modelIntelligence = useMemo(
    () => readModelIntelligence(certified),
    [certified]
  );
  const workBenchRoleBoards = readWorkBenchRoleLeaderboards(certified);
  const hasWorkBenchRoleBoards =
    workBenchRoleBoards.architect.length > 0 ||
    workBenchRoleBoards.worker.length > 0 ||
    workBenchRoleBoards.reviewer.length > 0;
  const hasCertifiedData = counts.certifiedCases > 0 || counts.certifiedAttempts > 0;
  const hasTrackData = leaderboard.length > 0 || (!isTrackView && hasCertifiedData);
  const shouldRenderLeaderboardSection =
    hasTrackData || providerErrorAttemptIds.length > 0;

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-semibold tracking-tight">
          {isTrackView ? `${TRACK_LABELS[track]} certified results` : "Certified benchmark results"}
        </h3>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Certified data is kept separate from lab evidence because it requires
          current cases, verifier output, harness metadata, and reproducibility
          hashes. Provider, harness, environment, and user-aborted certified
          results remain visible as evidence and removable records, but they are
          excluded from model score averages and leaderboard math.
        </p>
      </div>

      {corruptRunFileCount > 0 && (
        <CorruptRunFileNotice count={corruptRunFileCount} />
      )}

      {!isTrackView && hasCertifiedData && (
        <BestModelVerdictCard rows={modelIntelligence} />
      )}

      {!isTrackView && hasCertifiedData && modelIntelligence.length > 0 && (
        <OverallScoresTable rows={modelIntelligence} />
      )}

      {isTrackView ? (
        <CertifiedTrackStatStrip
          track={track}
          trackStat={trackStat}
          summary={summary}
          counts={counts}
        />
      ) : (
        <CertifiedFullStatGrid summary={summary} counts={counts} />
      )}

      {!hasCertifiedData ? (
        <CertifiedEmptyState track={track} />
      ) : !shouldRenderLeaderboardSection ? (
        <CertifiedTrackEmptyState track={track} />
      ) : (
        <>
          <CertifiedRecommendationCards
            rows={leaderboard}
            showTeamLift={track === "all"}
            bestTeamLiftCard={bestTeamLiftCard}
          />
          {track === "teamiq" && teamIqRows.length > 0 && (
            <div className="space-y-4">
              <ParetoFrontier rows={teamIqRows} cards={teamIqCards} />
              <ComboMatrix rows={teamIqRows} />
            </div>
          )}
          {(track === "all" || track === "workbench") && hasWorkBenchRoleBoards && (
            <WorkBenchRoleLeaderboards boards={workBenchRoleBoards} />
          )}
          <CertifiedLeaderboard
            rows={leaderboard}
            track={track}
            sortKey={sortKey}
            onSortChange={setSortKey}
            paretoIds={paretoIds}
            deletingAttemptIds={deletingAttemptIds}
            deleteInFlight={deleteInFlight}
            providerErrorCount={providerErrorAttemptIds.length}
            onDeleteAttempt={(attemptId, label) =>
              void deleteAttempts(
                [attemptId],
                `Remove the latest certified result for ${label}? This deletes the attempt, verifier result, failures, and traces but keeps cases, teams, and harness certifications.`
              )
            }
            onDeleteProviderErrors={() =>
              void deleteAttempts(
                providerErrorAttemptIds,
                `Remove ${providerErrorAttemptIds.length} provider-error certified result(s)? This deletes attempts, verifier results, failures, and traces but keeps cases, teams, and harness certifications.`
              )
            }
          />
        </>
      )}
    </section>
  );

  async function deleteAttempts(
    attemptIds: string[],
    confirmMessage: string
  ): Promise<void> {
    const uniqueAttemptIds = Array.from(new Set(attemptIds)).filter(Boolean);
    if (uniqueAttemptIds.length === 0) return;
    if (deletionInFlightRef.current) return;
    if (!window.confirm(confirmMessage)) return;

    deletionInFlightRef.current = true;
    setDeleteInFlight(true);
    markDeleting(uniqueAttemptIds, true);
    let mutationFailed = false;
    try {
      const summary = await deleteBenchmarkAttemptsCascade(uniqueAttemptIds);
      const removedAttempts = summary.attempts;
      setMessage?.(
        `Removed ${removedAttempts} certified result${removedAttempts === 1 ? "" : "s"}.`
      );
    } catch (error) {
      mutationFailed = true;
      setMessage?.(`Could not remove certified result: ${formatDeleteError(error)}`);
    } finally {
      try {
        await onRefresh?.();
      } catch (error) {
        if (!mutationFailed) {
          setMessage?.(
            `Removed certified result, but could not refresh: ${formatDeleteError(error)}`
          );
        }
      } finally {
        markDeleting(uniqueAttemptIds, false);
        deletionInFlightRef.current = false;
        setDeleteInFlight(false);
      }
    }
  }

  function markDeleting(attemptIds: string[], deleting: boolean): void {
    setDeletingAttemptIds((current) => {
      const next = new Set(current);
      for (const attemptId of attemptIds) {
        if (deleting) next.add(attemptId);
        else next.delete(attemptId);
      }
      return next;
    });
  }
}

function CorruptRunFileNotice({ count }: { count: number }) {
  return (
    <div
      role="status"
      className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300"
    >
      {count} benchmark run file{count === 1 ? "" : "s"} could not be read — see
      the browser console for details.
    </div>
  );
}

// Goal 1 — the single "most intelligent model" answer. One prominent card with
// the winner, its combined cross-track score, per-track breakdown, and a runner-
// up so the reader gets the verdict without scanning the leaderboard.
function BestModelVerdictCard({ rows }: { rows: ModelIntelligenceRow[] }) {
  const winner = rows[0];
  const runnerUp = rows[1];
  if (!winner) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Best model overall</CardTitle>
          <CardDescription>
            Run solo certified attempts across the tracks to rank models by
            cross-track intelligence.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }
  return (
    <Card className="border-emerald-500/30 bg-emerald-500/[0.04]">
      <CardHeader className="gap-1">
        <CardDescription className="text-xs font-medium uppercase tracking-wide">
          Best model overall (solo, across tracks)
        </CardDescription>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <CardTitle className="text-2xl">{winner.displayName}</CardTitle>
          <span className="text-lg font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
            {formatNormalizedScore(winner.combinedScore)}
          </span>
          <span className="text-xs text-muted-foreground">
            combined score across {winner.trackCount} track
            {winner.trackCount === 1 ? "" : "s"}
          </span>
          {winner.preliminary && (
            <span
              className="rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400"
              title="Fewer than 3 solo attempts — treat as a preliminary result."
            >
              thin evidence (&lt;3)
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-xs text-muted-foreground">
          {winner.attempts} solo attempt{winner.attempts === 1 ? "" : "s"},{" "}
          {pct(winner.verifiedPassRate)} verified pass rate. Combined score is the
          simple mean of each track&apos;s average verified quality, so breadth
          counts as much as any single track.
        </div>
        {winner.tracks.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {winner.tracks.map((breakdown) => (
              <span
                key={breakdown.track}
                className="rounded-md border bg-background px-2 py-1 text-xs"
                title={`${breakdown.attempts} attempt(s), ${pct(
                  breakdown.verifiedPassRate
                )} pass`}
              >
                <span className="font-medium">
                  {trackLabelFor(breakdown.track)}
                </span>{" "}
                <span className="tabular-nums text-muted-foreground">
                  {formatNormalizedScore(breakdown.averageVerifiedQuality)}
                </span>
              </span>
            ))}
          </div>
        )}
        {runnerUp && (
          <div className="border-t pt-2 text-xs text-muted-foreground">
            Runner-up:{" "}
            <span className="font-medium text-foreground">
              {runnerUp.displayName}
            </span>{" "}
            <span className="tabular-nums">
              {formatNormalizedScore(runnerUp.combinedScore)}
            </span>{" "}
            across {runnerUp.trackCount} track
            {runnerUp.trackCount === 1 ? "" : "s"}
            {runnerUp.preliminary ? " (thin evidence)" : ""}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// All-tracks overall table: the FULL cross-track solo intelligence leaderboard,
// not just the verdict card's winner + runner-up. Rank, model, combined score,
// one small column per track that has data (quality or —), track coverage,
// attempts, and a preliminary badge. Rows arrive already ranked best-first with
// preliminary demoted (payload order); capped at 8 with a "show all" toggle.
const OVERALL_TABLE_INITIAL_ROWS = 8;

function OverallScoresTable({ rows }: { rows: ModelIntelligenceRow[] }) {
  const [showAll, setShowAll] = useState(false);
  // Column set: every track any row ran, in a stable track-label order, so the
  // table has one small quality column per track that has data.
  const trackColumns = useMemo(() => {
    const present = new Set<string>();
    for (const row of rows) {
      for (const entry of row.tracks) present.add(entry.track);
    }
    return Array.from(present).sort((a, b) =>
      trackLabelFor(a).localeCompare(trackLabelFor(b))
    );
  }, [rows]);
  const totalTracks = trackColumns.length;
  const visibleRows = showAll ? rows : rows.slice(0, OVERALL_TABLE_INITIAL_ROWS);
  const hasHidden = rows.length > OVERALL_TABLE_INITIAL_ROWS;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Overall scores (all tracks)</CardTitle>
        <CardDescription>
          Every model ranked by its cross-track overall score — each track&apos;s
          quality weighted equally so breadth counts as much as any single track.
          Solo attempts only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-medium">#</th>
              <th className="py-2 pr-3 font-medium">Model</th>
              <th className="px-3 py-2 text-right font-medium">Overall</th>
              {trackColumns.map((track) => (
                <th
                  key={track}
                  className="px-3 py-2 text-right font-medium"
                >
                  {trackLabelFor(track)}
                </th>
              ))}
              <th className="px-3 py-2 text-right font-medium">Coverage</th>
              <th className="px-3 py-2 text-right font-medium">Attempts</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, index) => {
              const qualityByTrack = new Map(
                row.tracks.map((entry) => [entry.track, entry])
              );
              return (
                <tr key={row.modelId} className="border-b last:border-0">
                  <td className="py-2 pr-3 tabular-nums text-muted-foreground">
                    {index + 1}
                  </td>
                  <td className="py-2 pr-3">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{row.displayName}</span>
                      {row.preliminary && (
                        <span
                          className="shrink-0 rounded-sm border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-600 dark:text-amber-400"
                          title="Fewer than 3 solo attempts — treat as a preliminary result."
                        >
                          preliminary
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-medium tabular-nums">
                    {formatNormalizedScore(row.combinedScore)}
                  </td>
                  {trackColumns.map((track) => {
                    const entry = qualityByTrack.get(track);
                    return (
                      <td
                        key={track}
                        className="px-3 py-2 text-right tabular-nums text-muted-foreground"
                        title={
                          entry
                            ? `${entry.attempts} attempt${
                                entry.attempts === 1 ? "" : "s"
                              }`
                            : undefined
                        }
                      >
                        {entry
                          ? formatNormalizedScore(entry.averageVerifiedQuality)
                          : "—"}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {row.trackCount} of {totalTracks} track
                    {totalTracks === 1 ? "" : "s"}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">
                    {row.attempts}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {hasHidden && (
          <button
            type="button"
            onClick={() => setShowAll((current) => !current)}
            aria-expanded={showAll}
            className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            {showAll
              ? "Show fewer"
              : `Show all ${rows.length} models`}
          </button>
        )}
        <p className="text-xs text-muted-foreground">
          Overall score averages each track&apos;s quality equally — run more
          tracks to firm it up.
        </p>
      </CardContent>
    </Card>
  );
}

function WorkBenchRoleLeaderboards({
  boards,
}: {
  boards: WorkBenchRoleBoards;
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

function CertifiedStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {detail ? (
        <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
      ) : null}
    </div>
  );
}

function CertifiedEmptyState({ track }: { track: CertifiedTrackView }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No certified runs yet</CardTitle>
        <CardDescription>
          Import a benchmark JSON bundle from Reports, or run a certified
          {track === "all" ? " " : ` ${TRACK_LABELS[track]} `}
          benchmark once the harness controls are configured. Lab evidence
          remains available in the other tabs, but it is not treated as
          certified.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function CertifiedTrackEmptyState({ track }: { track: CertifiedTrackView }) {
  const trackName = track === "all" ? "certified" : TRACK_LABELS[track];
  return (
    <Card>
      <CardHeader>
        <CardTitle>No {trackName} scored attempts yet</CardTitle>
        <CardDescription>
          Select models above and run the {trackName} pack in the run panel -
          one run per model or team. Each completed run adds a scored attempt
          here. You can also import a bundle with {trackName} cases from Reports.
        </CardDescription>
      </CardHeader>
    </Card>
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

// Compact per-track strip: only the four track-true numbers, derived from the
// existing trackRows data. The full 12-stat grid is available behind Details.
function CertifiedTrackStatStrip({
  track,
  trackStat,
  summary,
  counts,
}: {
  track: CertifiedTrackView;
  trackStat: CertifiedTrackRow | null;
  summary: CertifiedSummary;
  counts: BenchmarkReportCounts;
}) {
  const [showDetails, setShowDetails] = useState(false);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <CertifiedStat label="Cases" value={String(trackStat?.cases ?? 0)} />
        <CertifiedStat
          label="Scored attempts"
          value={String(trackStat?.attempts ?? 0)}
        />
        <CertifiedStat
          label="Pass rate"
          value={pct(trackStat?.verifiedPassRate ?? null)}
        />
        <CertifiedStat
          label="Avg quality"
          value={formatNormalizedScore(trackStat?.averageVerifiedQuality ?? null)}
        />
      </div>
      <div>
        <button
          type="button"
          onClick={() => setShowDetails((current) => !current)}
          aria-expanded={showDetails}
          className="text-xs font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          {showDetails ? "Hide details" : "Details"}
        </button>
        <p className="mt-1 text-xs text-muted-foreground">
          The four numbers above are {TRACK_LABELS[track]}-only. Details shows the
          full certified totals across every track.
        </p>
      </div>
      {showDetails && <CertifiedFullStatGrid summary={summary} counts={counts} />}
    </div>
  );
}

// Full 12-stat grid: shown on Overview and Certified tabs, and behind Details
// on per-track tabs. The excluded-attempt taxonomy is collapsed into one tile
// with the breakdown in its subtitle.
function CertifiedFullStatGrid({
  summary,
  counts,
}: {
  summary: CertifiedSummary;
  counts: BenchmarkReportCounts;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <CertifiedStat label="Certified runs" value={String(summary.certifiedRuns)} />
        <CertifiedStat label="Cases" value={String(summary.certifiedCases)} />
        <CertifiedStat
          label="Total evidence"
          value={String(summary.certifiedAttempts)}
        />
        <CertifiedStat
          label="Scored attempts"
          value={String(summary.scoredAttempts)}
        />
        <CertifiedStat
          label="Excluded evidence"
          value={String(summary.excludedAttempts)}
          detail={
            summary.excludedAttempts > 0
              ? `${summary.excludedProviderAttempts} provider, ${summary.excludedHarnessAttempts} harness, ${summary.excludedEnvironmentAttempts} environment, ${summary.excludedCaseAttempts} case, ${summary.excludedUserAttempts} user`
              : "None excluded"
          }
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <CertifiedStat label="Verified pass" value={pct(summary.verifiedPassRate)} />
        <CertifiedStat
          label="Avg verified quality"
          value={formatNormalizedScore(summary.averageQuality)}
        />
        <CertifiedStat label="Verifier results" value={String(counts.verifierResults)} />
        <CertifiedStat label="Teams" value={String(counts.teamCompositions)} />
        <CertifiedStat label="Avg cost" value={usd(summary.averageCostUsd)} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <CertifiedStat
          label="Avg duration"
          value={formatDuration(summary.averageDurationMs)}
        />
      </div>
    </div>
  );
}

function CertifiedLeaderboard({
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
}) {
  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle>
            {track === "all" ? "Certified leaderboard" : `${TRACK_LABELS[track]} leaderboard`}
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

function CertifiedRecommendationCards({
  rows,
  showTeamLift,
  bestTeamLiftCard,
}: {
  rows: CertifiedLeaderboardRow[];
  showTeamLift: boolean;
  bestTeamLiftCard?: TeamIqRecommendationCard;
}) {
  const recommendations = buildRecommendations(rows, showTeamLift, bestTeamLiftCard);
  if (recommendations.length === 0) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {recommendations.map((item) => (
        <div key={item.label} className="rounded-lg border bg-card px-4 py-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {item.label}
          </div>
          <div className="mt-1 truncate text-sm font-semibold">{item.name}</div>
          <div className="mt-1 text-xs text-muted-foreground">{item.value}</div>
        </div>
      ))}
    </div>
  );
}

function buildRecommendations(
  rows: CertifiedLeaderboardRow[],
  showTeamLift: boolean,
  bestTeamLiftCard?: TeamIqRecommendationCard
) {
  const recommendations: Array<{ label: string; name: string; value: string }> = [];
  const quality = maxBy(rows, (row) => row.verifiedQuality);
  // Most efficient: prefer priced rows (highest quality per dollar). When no row
  // has pricing (account/custom providers), fall back to the fewest tokens per
  // passed case so the efficiency axis is never blank (product goal 3).
  const value = maxBy(rows, (row) =>
    row.averageCostUsd && row.verifiedQuality
      ? (row.verifiedQuality <= 1 ? row.verifiedQuality * 100 : row.verifiedQuality) /
        row.averageCostUsd
      : null
  );
  const cheapestByTokens = minBy(rows, (row) => row.tokensPerPass);
  const fastest = minBy(rows, (row) => row.averageDurationMs);
  const tool = maxBy(rows, (row) => row.toolReliabilityScore);

  if (quality) {
    recommendations.push({
      label: "Best quality",
      name: quality.label,
      value: `Verified quality ${formatNormalizedScore(quality.verifiedQuality)}`,
    });
  }
  if (value) {
    recommendations.push({
      label: "Most efficient",
      name: value.label,
      value: `${formatNormalizedScore(value.verifiedQuality)} quality at ${usd(value.averageCostUsd)}`,
    });
  } else if (cheapestByTokens && cheapestByTokens.tokensPerPass != null) {
    recommendations.push({
      label: "Most efficient (by tokens)",
      name: cheapestByTokens.label,
      value: `${formatTokenCount(cheapestByTokens.tokensPerPass)} tokens/pass — no pricing available`,
    });
  }
  if (fastest) {
    recommendations.push({
      label: "Fastest",
      name: fastest.label,
      value: formatDuration(fastest.averageDurationMs),
    });
  }
  if (tool) {
    recommendations.push({
      label: "Best tool reliability",
      name: tool.label,
      value: formatScore(tool.toolReliabilityScore),
    });
  }
  // Best team lift comes from the TeamIQ recommendation card, which already
  // applies the baseline + sample-count + preliminary gate. When TeamIQ has
  // not produced a confident winner, show a pointer instead of a bare number.
  // Only meaningful on the all-tracks Overview; other tabs omit it.
  if (showTeamLift) {
    recommendations.push(
      bestTeamLiftCard
        ? {
            label: "Best team lift",
            name: bestTeamLiftCard.teamName,
            value: `${bestTeamLiftCard.value}${
              bestTeamLiftCard.detail ? ` - ${bestTeamLiftCard.detail}` : ""
            }`,
          }
        : {
            label: "Best team lift",
            name: "Not enough team data yet",
            value: "Run the TeamIQ pack with solo baselines to compare teams.",
          }
    );
  }
  return recommendations;
}

function maxBy(
  rows: CertifiedLeaderboardRow[],
  read: (row: CertifiedLeaderboardRow) => number | null
): CertifiedLeaderboardRow | null {
  return rows.reduce<CertifiedLeaderboardRow | null>((best, row) => {
    const value = read(row);
    if (value == null || !Number.isFinite(value)) return best;
    if (!best) return row;
    const bestValue = read(best);
    return bestValue == null || value > bestValue ? row : best;
  }, null);
}

function minBy(
  rows: CertifiedLeaderboardRow[],
  read: (row: CertifiedLeaderboardRow) => number | null
): CertifiedLeaderboardRow | null {
  return rows.reduce<CertifiedLeaderboardRow | null>((best, row) => {
    const value = read(row);
    if (value == null || !Number.isFinite(value)) return best;
    if (!best) return row;
    const bestValue = read(best);
    return bestValue == null || value < bestValue ? row : best;
  }, null);
}

interface CertifiedSummary {
  certifiedRuns: number;
  certifiedAttempts: number;
  scoredAttempts: number;
  excludedAttempts: number;
  excludedProviderAttempts: number;
  excludedHarnessAttempts: number;
  excludedEnvironmentAttempts: number;
  excludedUserAttempts: number;
  excludedCaseAttempts: number;
  certifiedCases: number;
  verifiedPassRate: number | null;
  averageQuality: number | null;
  averageCostUsd: number | null;
  averageDurationMs: number | null;
}

interface CertifiedLeaderboardRow {
  id: string;
  label: string;
  detail?: string;
  tracks: string[];
  caseTitles: string[];
  attempts: number;
  preliminary: boolean;
  verifiedQuality: number | null;
  overallScore: number | null;
  trackBreakdown: Array<{
    track: string;
    attempts: number;
    averageVerifiedQuality: number;
  }>;
  passRate: number | null;
  efficiencyScore: number | null;
  toolReliabilityScore: number | null;
  averageCostUsd: number | null;
  averageDurationMs: number | null;
  durationMs: number | null;
  speedPerPassMs: number | null;
  totalTokens: number | null;
  tokensPerPass: number | null;
  costBasis: "usd" | "tokens" | null;
  teamLift: number | null;
  latestAttemptId?: string;
  latestAttemptStatus?: string;
  latestAttemptTrack?: string;
  latestAttemptsByTrack: Record<
    string,
    { id: string; status: string; track: string }
  >;
  providerUnavailableAttemptIds: string[];
  providerUnavailableAttemptIdsByTrack: Record<string, string[]>;
}

interface ModelIntelligenceTrackBreakdown {
  track: string;
  attempts: number;
  passed: number;
  verifiedPassRate: number | null;
  averageVerifiedQuality: number;
}

interface ModelIntelligenceRow {
  modelId: string;
  displayName: string;
  attempts: number;
  passed: number;
  verifiedPassRate: number | null;
  combinedScore: number;
  trackCount: number;
  preliminary: boolean;
  tracks: ModelIntelligenceTrackBreakdown[];
}

interface WorkBenchRoleRow {
  id: string;
  modelId: string;
  displayName: string;
  attempts: number;
  passed: number;
  verifiedPassRate: number | null;
  verifiedQuality: number | null;
  efficiencyScore: number | null;
  averageCostUsd: number | null;
  averageDurationMs: number | null;
}

interface WorkBenchRoleBoards {
  architect: WorkBenchRoleRow[];
  worker: WorkBenchRoleRow[];
  reviewer: WorkBenchRoleRow[];
}

function readCertifiedSummary(
  certified: unknown,
  counts: BenchmarkReportCounts
): CertifiedSummary {
  const summary = readRecord(readRecord(certified).summary);
  return {
    certifiedRuns:
      readNumber(summary.certifiedRuns) ?? readNumber(summary.totalRuns) ?? 0,
    certifiedAttempts:
      readNumber(summary.certifiedAttempts) ?? counts.certifiedAttempts ?? 0,
    scoredAttempts:
      readNumber(summary.scoredAttempts) ??
      readNumber(summary.certifiedAttempts) ??
      counts.certifiedAttempts ??
      0,
    excludedAttempts: readNumber(summary.excludedAttempts) ?? 0,
    excludedProviderAttempts:
      readNumber(summary.excludedProviderAttempts) ?? 0,
    excludedHarnessAttempts:
      readNumber(summary.excludedHarnessAttempts) ?? 0,
    excludedEnvironmentAttempts:
      readNumber(summary.excludedEnvironmentAttempts) ?? 0,
    excludedUserAttempts: readNumber(summary.excludedUserAttempts) ?? 0,
    excludedCaseAttempts: readNumber(summary.excludedCaseAttempts) ?? 0,
    certifiedCases:
      readNumber(summary.certifiedCases) ?? counts.certifiedCases ?? 0,
    verifiedPassRate:
      readNumber(summary.verifiedPassRate) ?? readNumber(summary.passRate),
    averageQuality:
      readNumber(summary.averageVerifiedQuality) ??
      readNumber(summary.averageQuality) ??
      readNumber(summary.verifiedQuality),
    averageCostUsd:
      readNumber(summary.averageCostUsd) ?? readNumber(summary.costUsd),
    averageDurationMs:
      readNumber(summary.averageDurationMs) ??
      readNumber(summary.averageLatencyMs) ??
      readNumber(summary.durationMs),
  };
}

function readLeaderboard(
  certified: unknown,
  track: CertifiedTrackView,
  sortKey: LeaderboardSortKey = "quality"
): CertifiedLeaderboardRow[] {
  const record = readRecord(certified);
  // The base `.leaderboard` array is the only one carrying delete metadata
  // (latestAttemptId etc.) attached in useBenchmarkDashboard. The alternate
  // sort arrays are the same rows ranked differently, so re-attach delete
  // metadata by row id rather than recomputing anything here.
  const deleteMetaById = new Map<string, CertifiedLeaderboardRow>();
  for (const value of readArray(record.leaderboard)) {
    const row = readLeaderboardRow(value);
    if (row) deleteMetaById.set(row.id, row);
  }

  const sourceKey = SORT_SOURCE_KEY[sortKey];
  const source = readArray(record[sourceKey]);
  const rows = source
    .map(readLeaderboardRow)
    .filter((row): row is CertifiedLeaderboardRow => row !== null)
    .map((row) => {
      const meta = deleteMetaById.get(row.id);
      return meta
        ? {
            ...row,
            latestAttemptId: meta.latestAttemptId,
            latestAttemptStatus: meta.latestAttemptStatus,
            latestAttemptTrack: meta.latestAttemptTrack,
            latestAttemptsByTrack: meta.latestAttemptsByTrack,
            providerUnavailableAttemptIds: meta.providerUnavailableAttemptIds,
            providerUnavailableAttemptIdsByTrack:
              meta.providerUnavailableAttemptIdsByTrack,
          }
        : row;
    });
  const filtered =
    track === "all"
      ? rows
      : rows.filter((row) =>
          row.tracks.some((item) => normalizeTrack(item) === track)
        );
  // Do NOT re-sort: the source array is already ranked by the chosen basis.
  return filtered.map((row) => resolveLeaderboardDeleteFields(row, track));
}

function readParetoIds(certified: unknown): Set<string> {
  const ids = new Set<string>();
  for (const value of readArray(readRecord(certified).paretoFrontier)) {
    const row = readRecord(value);
    const id =
      readString(row.id) ??
      readString(row.comboHash) ??
      readString(row.teamCompositionId);
    if (id) ids.add(id);
  }
  return ids;
}

interface CertifiedTrackRow {
  track: string;
  cases: number;
  attempts: number;
  passed: number;
  verifiedPassRate: number | null;
  averageVerifiedQuality: number | null;
}

function readTrackRows(certified: unknown): CertifiedTrackRow[] {
  return readArray(readRecord(certified).trackRows)
    .map((value) => {
      const row = readRecord(value);
      const track = readString(row.track);
      if (!track) return null;
      return {
        track,
        cases: readNumber(row.cases) ?? 0,
        attempts: readNumber(row.attempts) ?? 0,
        passed: readNumber(row.passed) ?? 0,
        verifiedPassRate: readNumber(row.verifiedPassRate),
        averageVerifiedQuality: readNumber(row.averageVerifiedQuality),
      };
    })
    .filter((row): row is CertifiedTrackRow => row !== null);
}

function readModelIntelligence(certified: unknown): ModelIntelligenceRow[] {
  return readArray(readRecord(certified).modelIntelligence)
    .map((value) => {
      const row = readRecord(value);
      const modelId = readString(row.modelId);
      if (!modelId) return null;
      const tracks = readArray(row.tracks)
        .map((item) => {
          const trackRow = readRecord(item);
          const track = readString(trackRow.track);
          if (!track) return null;
          return {
            track,
            attempts: readNumber(trackRow.attempts) ?? 0,
            passed: readNumber(trackRow.passed) ?? 0,
            verifiedPassRate: readNumber(trackRow.verifiedPassRate),
            averageVerifiedQuality:
              readNumber(trackRow.averageVerifiedQuality) ?? 0,
          };
        })
        .filter(
          (item): item is ModelIntelligenceTrackBreakdown => item !== null
        );
      return {
        modelId,
        displayName: readString(row.displayName) ?? modelId,
        attempts: readNumber(row.attempts) ?? 0,
        passed: readNumber(row.passed) ?? 0,
        verifiedPassRate: readNumber(row.verifiedPassRate),
        combinedScore: readNumber(row.combinedScore) ?? 0,
        trackCount: readNumber(row.trackCount) ?? tracks.length,
        preliminary: readBoolean(row.preliminary),
        tracks,
      };
    })
    .filter((row): row is ModelIntelligenceRow => row !== null);
}

function trackLabelFor(track: string): string {
  const normalized = normalizeTrack(track);
  return normalized ? TRACK_LABELS[normalized] : track;
}

function readLeaderboardRow(value: unknown): CertifiedLeaderboardRow | null {
  const row = readRecord(value);
  const id =
    readString(row.id) ??
    readString(row.teamCompositionId) ??
    readString(row.modelId);
  if (!id) return null;

  return {
    id,
    label:
      readString(row.name) ??
      readString(row.teamName) ??
      readString(row.displayName) ??
      readString(row.modelId) ??
      id,
    detail: readString(row.comboHash) ?? readString(row.modelId) ?? undefined,
    tracks: readTrackList(row),
    caseTitles: readStringList(row.caseTitles),
    attempts: readNumber(row.attempts) ?? readNumber(row.totalAttempts) ?? 0,
    preliminary: readBoolean(row.preliminary),
    verifiedQuality:
      readNumber(row.verifiedQuality) ??
      readNumber(row.averageVerifiedQuality) ??
      readNumber(row.quality),
    overallScore: readNumber(row.overallScore),
    trackBreakdown: readTrackBreakdown(row.trackBreakdown),
    passRate: readNumber(row.passRate) ?? readNumber(row.verifiedPassRate),
    efficiencyScore:
      readNumber(row.efficiencyScore) ?? readNumber(row.averageEfficiencyScore),
    toolReliabilityScore:
      readNumber(row.toolReliabilityScore) ??
      readNumber(row.averageToolReliabilityScore),
    averageCostUsd: readNumber(row.averageCostUsd) ?? readNumber(row.costUsd),
    averageDurationMs:
      readNumber(row.averageDurationMs) ??
      readNumber(row.averageLatencyMs) ??
      readNumber(row.durationMs),
    durationMs:
      readNumber(row.durationMs) ??
      readNumber(row.averageDurationMs) ??
      readNumber(row.averageLatencyMs),
    speedPerPassMs: readNumber(row.speedPerPassMs),
    totalTokens: readNumber(row.totalTokens),
    tokensPerPass: readNumber(row.tokensPerPass),
    costBasis: readCostBasis(row.costBasis),
    teamLift: readNumber(row.teamLift) ?? readNumber(row.averageTeamLift),
    latestAttemptId: readString(row.latestAttemptId) ?? undefined,
    latestAttemptStatus: readString(row.latestAttemptStatus) ?? undefined,
    latestAttemptTrack: readString(row.latestAttemptTrack) ?? undefined,
    latestAttemptsByTrack: readLatestAttemptsByTrack(row.latestAttemptsByTrack),
    providerUnavailableAttemptIds: readStringList(
      row.providerUnavailableAttemptIds
    ),
    providerUnavailableAttemptIdsByTrack: readStringListByTrack(
      row.providerUnavailableAttemptIdsByTrack
    ),
  };
}

function resolveLeaderboardDeleteFields(
  row: CertifiedLeaderboardRow,
  track: CertifiedTrackView
): CertifiedLeaderboardRow {
  if (track === "all") return row;
  const latest = row.latestAttemptsByTrack[track];
  return {
    ...row,
    latestAttemptId: latest?.id,
    latestAttemptStatus: latest?.status,
    latestAttemptTrack: latest?.track,
    providerUnavailableAttemptIds:
      row.providerUnavailableAttemptIdsByTrack[track] ?? [],
  };
}

function readWorkBenchRoleLeaderboards(certified: unknown): WorkBenchRoleBoards {
  const source = readRecord(readRecord(certified).workBenchRoleLeaderboards);
  return {
    architect: readWorkBenchRoleRows(source.architect),
    worker: readWorkBenchRoleRows(source.worker),
    reviewer: readWorkBenchRoleRows(source.reviewer),
  };
}

function readWorkBenchRoleRows(value: unknown): WorkBenchRoleRow[] {
  return readArray(value)
    .map((item) => {
      const row = readRecord(item);
      const modelId = readString(row.modelId);
      if (!modelId) return null;
      return {
        id: readString(row.id) ?? modelId,
        modelId,
        displayName: readString(row.displayName) ?? modelId,
        attempts: readNumber(row.attempts) ?? 0,
        passed: readNumber(row.passed) ?? 0,
        verifiedPassRate: readNumber(row.verifiedPassRate),
        verifiedQuality: readNumber(row.verifiedQuality),
        efficiencyScore: readNumber(row.efficiencyScore),
        averageCostUsd: readNumber(row.averageCostUsd),
        averageDurationMs: readNumber(row.averageDurationMs),
      };
    })
    .filter((row): row is WorkBenchRoleRow => row !== null);
}

function readTeamIqComboMatrixRows(certified: unknown): TeamIqComboMatrixRow[] {
  return readArray(readRecord(certified).teamIqComboMatrixRows)
    .map(readTeamIqComboMatrixRow)
    .filter((row): row is TeamIqComboMatrixRow => row !== null);
}

function readTeamIqComboMatrixRow(value: unknown): TeamIqComboMatrixRow | null {
  const row = readRecord(value);
  const id = readString(row.id);
  const teamCompositionId = readString(row.teamCompositionId);
  const teamName = readString(row.teamName);
  const comboHash = readString(row.comboHash);
  const track = readString(row.track);
  const recommendationLabel = readTeamIqRecommendationLabel(
    readString(row.recommendationLabel)
  );
  if (
    !id ||
    !teamCompositionId ||
    !teamName ||
    !comboHash ||
    !track ||
    !recommendationLabel
  ) {
    return null;
  }
  const modelIds = readArray(row.modelIds).filter(
    (item): item is string => typeof item === "string" && item.length > 0
  );
  return {
    id,
    teamCompositionId,
    teamName,
    comboHash,
    track: readBenchmarkTrack(track) ?? "teamiq",
    modelIds,
    isSolo: row.isSolo === true || recommendationLabel === "solo_baseline",
    attempts: readNumber(row.attempts) ?? 0,
    verifiedQuality: readNumber(row.verifiedQuality) ?? 0,
    jobSuccessScore: readNumber(row.jobSuccessScore) ?? 0,
    costUsd: readNumber(row.costUsd),
    averageCostUsd: readNumber(row.averageCostUsd),
    durationMs: readNumber(row.durationMs),
    averageDurationMs: readNumber(row.averageDurationMs),
    bestSoloScore: readNumber(row.bestSoloScore),
    teamLift: readNumber(row.teamLift),
    teamLiftLabel: readTeamLiftLabel(readString(row.teamLiftLabel)),
    isParetoRecommended: row.isParetoRecommended === true,
    recommendationLabel,
  };
}

function readBenchmarkTrack(value: string | null): BenchmarkTrack | null {
  const normalized = normalizeTrack(value ?? undefined);
  return normalized && normalized !== "all" ? normalized : null;
}

function readTeamIqRecommendationCards(
  certified: unknown
): TeamIqRecommendationCard[] {
  return readArray(readRecord(certified).teamIqRecommendationCards)
    .map(readTeamIqRecommendationCard)
    .filter((card): card is TeamIqRecommendationCard => card !== null);
}

function readTeamIqRecommendationCard(
  value: unknown
): TeamIqRecommendationCard | null {
  const card = readRecord(value);
  const kind = readString(card.kind);
  const title = readString(card.title);
  const teamCompositionId = readString(card.teamCompositionId);
  const teamName = readString(card.teamName);
  const recommendationLabel = readTeamIqRecommendationLabel(
    readString(card.recommendationLabel)
  );
  if (
    !kind ||
    !title ||
    !teamCompositionId ||
    !teamName ||
    !recommendationLabel
  ) {
    return null;
  }
  if (
    ![
      "best_team_lift",
      "best_quality",
      "best_value",
      "fastest",
      "watchlist",
    ].includes(kind)
  ) {
    return null;
  }
  return {
    kind: kind as TeamIqRecommendationCard["kind"],
    title,
    teamCompositionId,
    teamName,
    value: readString(card.value) ?? "n/a",
    detail: readString(card.detail) ?? "",
    recommendationLabel,
  };
}

function readTeamIqRecommendationLabel(
  value: string | null
): TeamIqRecommendationLabel | null {
  if (
    value === "recommended" ||
    value === "tradeoff" ||
    value === "watch" ||
    value === "dominated" ||
    value === "solo_baseline" ||
    value === "insufficient_data"
  ) {
    return value;
  }
  return null;
}

function readTeamLiftLabel(
  value: string | null
): TeamIqComboMatrixRow["teamLiftLabel"] {
  if (
    value === "strong_positive" ||
    value === "positive" ||
    value === "neutral" ||
    value === "negative" ||
    value === "wasteful"
  ) {
    return value;
  }
  return null;
}

function normalizeTrack(track: string | undefined): CertifiedTrackView | undefined {
  if (!track) return undefined;
  const normalized = track.toLowerCase().replace(/[\s_-]/g, "");
  if (normalized === "workbench") return "workbench";
  if (normalized === "game" || normalized === "gameiq") return "gameiq";
  if (normalized === "teamiq") return "teamiq";
  if (normalized === "toolreliability") return "toolreliability";
  return undefined;
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

function readProviderErrorAttemptIds(
  certified: unknown,
  track: CertifiedTrackView
): string[] {
  const rows = readArray(readRecord(certified).providerErrorAttempts);
  const ids = rows
    .map((item) => {
      const row = readRecord(item);
      const id = readString(row.id);
      const rowTrack = normalizeTrack(readString(row.track) ?? undefined);
      if (!id) return null;
      if (track !== "all" && rowTrack !== track) return null;
      return id;
    })
    .filter((id): id is string => id !== null);
  return Array.from(new Set(ids));
}

function readTrackList(row: Record<string, unknown>): string[] {
  if (Array.isArray(row.tracks)) {
    return row.tracks.filter(
      (item): item is string => typeof item === "string" && item.length > 0
    );
  }
  const track = readString(row.track);
  return track ? [track] : [];
}

function readTrackBreakdown(
  value: unknown
): Array<{ track: string; attempts: number; averageVerifiedQuality: number }> {
  return readArray(value)
    .map((item) => {
      const row = readRecord(item);
      const track = readString(row.track);
      if (!track) return null;
      return {
        track,
        attempts: readNumber(row.attempts) ?? 0,
        averageVerifiedQuality: readNumber(row.averageVerifiedQuality) ?? 0,
      };
    })
    .filter(
      (
        item
      ): item is {
        track: string;
        attempts: number;
        averageVerifiedQuality: number;
      } => item !== null
    );
}

function readStringList(value: unknown): string[] {
  return readArray(value).filter(
    (item): item is string => typeof item === "string" && item.length > 0
  );
}

function readStringListByTrack(value: unknown): Record<string, string[]> {
  const source = readRecord(value);
  const byTrack: Record<string, string[]> = {};
  for (const [track, ids] of Object.entries(source)) {
    const normalized = normalizeTrack(track);
    if (!normalized) continue;
    byTrack[normalized] = readStringList(ids);
  }
  return byTrack;
}

function readLatestAttemptsByTrack(
  value: unknown
): Record<string, { id: string; status: string; track: string }> {
  const source = readRecord(value);
  const byTrack: Record<string, { id: string; status: string; track: string }> =
    {};
  for (const [track, candidate] of Object.entries(source)) {
    const normalized = normalizeTrack(track);
    const record = readRecord(candidate);
    const id = readString(record.id);
    if (!normalized || !id) continue;
    byTrack[normalized] = {
      id,
      status: readString(record.status) ?? "",
      track: readString(record.track) ?? normalized,
    };
  }
  return byTrack;
}

function formatDeleteError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readBoolean(value: unknown): boolean {
  return value === true;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readCostBasis(value: unknown): "usd" | "tokens" | null {
  return value === "usd" || value === "tokens" ? value : null;
}

function formatTokenCount(value: number | null): string {
  if (value == null) return "n/a";
  return value.toLocaleString();
}
