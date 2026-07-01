"use client";

import React, { useRef, useState } from "react";
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
  duration,
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

export function CertifiedBenchmarkOverview({
  certified,
  counts,
  track = "all",
  onRefresh,
  setMessage,
}: {
  certified: unknown | null;
  counts: BenchmarkReportCounts;
  track?: CertifiedTrackView;
  onRefresh?: () => Promise<void>;
  setMessage?: (message: string | null) => void;
}) {
  const [deletingAttemptIds, setDeletingAttemptIds] = useState<Set<string>>(
    () => new Set()
  );
  const deletionInFlightRef = useRef(false);
  const [deleteInFlight, setDeleteInFlight] = useState(false);
  const summary = readCertifiedSummary(certified, counts);
  const leaderboard = readLeaderboard(certified, track);
  const providerErrorAttemptIds = readProviderErrorAttemptIds(certified, track);
  const teamIqRows = readTeamIqComboMatrixRows(certified);
  const teamIqCards = readTeamIqRecommendationCards(certified);
  const workBenchRoleBoards = readWorkBenchRoleLeaderboards(certified);
  const hasWorkBenchRoleBoards =
    workBenchRoleBoards.architect.length > 0 ||
    workBenchRoleBoards.worker.length > 0 ||
    workBenchRoleBoards.reviewer.length > 0;
  const isTrackView = track !== "all";
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
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <CertifiedStat
          label="Provider failures"
          value={String(summary.excludedProviderAttempts)}
          detail={
            summary.excludedAttempts > 0
              ? `${summary.excludedHarnessAttempts} harness, ${summary.excludedEnvironmentAttempts} environment, ${summary.excludedCaseAttempts} case, ${summary.excludedUserAttempts} user`
              : undefined
          }
        />
        <CertifiedStat label="Verified pass" value={pct(summary.verifiedPassRate)} />
        <CertifiedStat
          label="Avg verified quality"
          value={formatNormalizedScore(summary.averageQuality)}
        />
        <CertifiedStat label="Verifier results" value={String(counts.verifierResults)} />
        <CertifiedStat label="Teams" value={String(counts.teamCompositions)} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <CertifiedStat label="Avg cost" value={usd(summary.averageCostUsd)} />
        <CertifiedStat label="Avg duration" value={duration(summary.averageDurationMs)} />
      </div>

      {!hasCertifiedData ? (
        <CertifiedEmptyState track={track} />
      ) : !shouldRenderLeaderboardSection ? (
        <CertifiedTrackEmptyState track={track} />
      ) : (
        <>
          <CertifiedRecommendationCards rows={leaderboard} />
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
  return (
    <Card>
      <CardHeader>
        <CardTitle>No {TRACK_LABELS[track]} certified attempts</CardTitle>
        <CardDescription>
          The imported certified bundle does not contain attempts for this track.
          Use the Certified tab for all imported certified data or import a bundle
          with {TRACK_LABELS[track]} cases.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function CertifiedLeaderboard({
  rows,
  track,
  deletingAttemptIds,
  deleteInFlight,
  providerErrorCount,
  onDeleteAttempt,
  onDeleteProviderErrors,
}: {
  rows: CertifiedLeaderboardRow[];
  track: CertifiedTrackView;
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
            Ranked only from scored certified attempts. Excluded provider,
            harness, environment, and user-aborted results stay visible as
            evidence and can still be removed.
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
      {rows.length === 0 ? (
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Certified records were loaded, but there are no scored certified
          attempts for this view yet. Excluded evidence remains removable.
        </CardContent>
      ) : (
        <CardContent className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="py-2 pr-3 font-medium">Team or model</th>
                <th className="px-3 py-2 font-medium">Track</th>
                <th className="px-3 py-2 text-right font-medium">Scored</th>
                <th className="px-3 py-2 text-right font-medium">
                  Verified quality
                </th>
                <th className="px-3 py-2 text-right font-medium">Pass</th>
                <th className="px-3 py-2 text-right font-medium">Efficiency</th>
                <th className="px-3 py-2 text-right font-medium">Tool</th>
                <th className="py-2 pl-3 text-right font-medium">Cost</th>
                <th className="py-2 pl-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 12).map((row) => (
                <tr key={row.id} className="border-b last:border-0">
                  <td className="py-3 pr-3">
                    <div className="font-medium">{row.label}</div>
                    {row.detail && (
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {row.detail}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-3">{formatTrackLabel(row.tracks)}</td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    <span>{row.attempts}</span>
                    {row.preliminary && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        preliminary
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {formatNormalizedScore(row.verifiedQuality)}
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
                  <td className="py-3 pl-3 text-right tabular-nums">
                    {usd(row.averageCostUsd)}
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
}: {
  rows: CertifiedLeaderboardRow[];
}) {
  const recommendations = buildRecommendations(rows);
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

function buildRecommendations(rows: CertifiedLeaderboardRow[]) {
  const recommendations: Array<{ label: string; name: string; value: string }> = [];
  const quality = maxBy(rows, (row) => row.verifiedQuality);
  const value = maxBy(rows, (row) =>
    row.averageCostUsd && row.verifiedQuality
      ? (row.verifiedQuality <= 1 ? row.verifiedQuality * 100 : row.verifiedQuality) /
        row.averageCostUsd
      : null
  );
  const fastest = minBy(rows, (row) => row.averageDurationMs);
  const tool = maxBy(rows, (row) => row.toolReliabilityScore);
  const lift = maxBy(rows, (row) => row.teamLift);

  if (quality) {
    recommendations.push({
      label: "Best quality",
      name: quality.label,
      value: `Verified quality ${formatNormalizedScore(quality.verifiedQuality)}`,
    });
  }
  if (value) {
    recommendations.push({
      label: "Best value",
      name: value.label,
      value: `${formatNormalizedScore(value.verifiedQuality)} quality at ${usd(value.averageCostUsd)}`,
    });
  }
  if (fastest) {
    recommendations.push({
      label: "Fastest",
      name: fastest.label,
      value: duration(fastest.averageDurationMs),
    });
  }
  if (tool) {
    recommendations.push({
      label: "Best tool reliability",
      name: tool.label,
      value: formatScore(tool.toolReliabilityScore),
    });
  }
  if (lift) {
    recommendations.push({
      label: "Best team lift",
      name: lift.label,
      value: formatScore(lift.teamLift),
    });
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
  attempts: number;
  preliminary: boolean;
  verifiedQuality: number | null;
  passRate: number | null;
  efficiencyScore: number | null;
  toolReliabilityScore: number | null;
  averageCostUsd: number | null;
  averageDurationMs: number | null;
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
  track: CertifiedTrackView
): CertifiedLeaderboardRow[] {
  const source = readArray(readRecord(certified).leaderboard);
  const rows = source
    .map(readLeaderboardRow)
    .filter((row): row is CertifiedLeaderboardRow => row !== null);
  const filtered =
    track === "all"
      ? rows
      : rows.filter((row) =>
          row.tracks.some((item) => normalizeTrack(item) === track)
        );
  return filtered.map((row) => resolveLeaderboardDeleteFields(row, track)).sort(
    (a, b) => (b.verifiedQuality ?? -1) - (a.verifiedQuality ?? -1)
  );
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
    attempts: readNumber(row.attempts) ?? readNumber(row.totalAttempts) ?? 0,
    preliminary: readBoolean(row.preliminary),
    verifiedQuality:
      readNumber(row.verifiedQuality) ??
      readNumber(row.averageVerifiedQuality) ??
      readNumber(row.quality),
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
