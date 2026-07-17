"use client";

import { useMemo, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  duration as formatDuration,
  formatNormalizedScore,
  pct,
  usd,
} from "@/components/benchmark/format";
import type { BenchmarkReportCounts } from "@/components/benchmark/useBenchmarkDashboard";
import { ComboMatrix } from "@/components/benchmark/teamiq/ComboMatrix";
import { ParetoFrontier } from "@/components/benchmark/teamiq/ParetoFrontier";
import { LensTabs } from "@/components/benchmark/results/LensTabs";
import {
  CertifiedLeaderboard,
  TRACK_LABELS,
  trackLabelFor,
  WorkBenchRoleLeaderboards,
} from "@/components/benchmark/certified/CertifiedResultTables";
import { deleteBenchmarkAttemptsCascade } from "@/lib/benchmark/store";
import {
  normalizeTrack,
  readCertifiedSummary,
  readLeaderboard,
  readModelIntelligence,
  readParetoIds,
  readProviderErrorAttemptIds,
  readTeamIqComboMatrixRows,
  readTeamIqRecommendationCards,
  readTrackRows,
  readWorkBenchRoleLeaderboards,
  type CertifiedSummary,
  type CertifiedTrackRow,
  type CertifiedTrackView,
  type LeaderboardSortKey,
  type ModelIntelligenceRow,
} from "@/lib/benchmark/certified/dashboard-selectors";

// Re-exported so existing importers (e.g. CertifiedRunPanel.tsx, which only
// needs the `track` prop's type) don't need to change their import path after
// the 2026-07-17 benchmark UX overhaul moved the selector logic out to
// lib/benchmark/certified/dashboard-selectors.ts.
export type { CertifiedTrackView } from "@/lib/benchmark/certified/dashboard-selectors";

/**
 * Results tab main body. Renders the stat grid, then either the LensTabs
 * (Solo / Teams / Roles / Live builds) for the all-tracks Results view, or —
 * for a single-track view, kept only for backward compatibility with direct
 * per-track callers/tests, unreachable from the app UI since the Task 3 IA
 * collapse — the legacy single-leaderboard rendering. The verdict strip (best
 * model / best team / most efficient / best value team) lives one level up in
 * BenchmarkPage.tsx as its own VerdictStrip component, computed from the same
 * certified payload via the shared selectors in dashboard-selectors.ts.
 */
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
      ) : isTrackView ? (
        <>
          {track === "teamiq" && teamIqRows.length > 0 && (
            <div className="space-y-4">
              <ParetoFrontier rows={teamIqRows} cards={teamIqCards} />
              <ComboMatrix rows={teamIqRows} />
            </div>
          )}
          {track === "workbench" && hasWorkBenchRoleBoards && (
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
      ) : (
        <LensTabs
          leaderboard={leaderboard}
          sortKey={sortKey}
          onSortChange={setSortKey}
          paretoIds={paretoIds}
          teamIqRows={teamIqRows}
          teamIqCards={teamIqCards}
          workBenchRoleBoards={workBenchRoleBoards}
          deletingAttemptIds={deletingAttemptIds}
          deleteInFlight={deleteInFlight}
          providerErrorAttemptIds={providerErrorAttemptIds}
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

// All-tracks overall table: the FULL cross-track solo intelligence leaderboard
// (the verdict strip only shows the single winner + evidence line). Rank,
// model, combined score, one small column per track that has data (quality or
// —), track coverage, attempts, and a preliminary badge. Rows arrive already
// ranked best-first with preliminary demoted (payload order); capped at 8 with
// a "show all" toggle.
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

function formatDeleteError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
