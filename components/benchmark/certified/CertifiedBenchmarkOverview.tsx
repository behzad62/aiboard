"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { duration, pct, usd } from "@/components/benchmark/format";
import type { BenchmarkReportCounts } from "@/components/benchmark/useBenchmarkDashboard";
import { ComboMatrix } from "@/components/benchmark/teamiq/ComboMatrix";
import { ParetoFrontier } from "@/components/benchmark/teamiq/ParetoFrontier";
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
}: {
  certified: unknown | null;
  counts: BenchmarkReportCounts;
  track?: CertifiedTrackView;
}) {
  const summary = readCertifiedSummary(certified, counts);
  const leaderboard = readLeaderboard(certified, track);
  const teamIqRows = readTeamIqComboMatrixRows(certified);
  const teamIqCards = readTeamIqRecommendationCards(certified);
  const isTrackView = track !== "all";
  const hasCertifiedData = counts.certifiedCases > 0 || counts.certifiedAttempts > 0;
  const hasTrackData = leaderboard.length > 0 || (!isTrackView && hasCertifiedData);

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-1">
        <h3 className="text-lg font-semibold tracking-tight">
          {isTrackView ? `${TRACK_LABELS[track]} certified results` : "Certified benchmark results"}
        </h3>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Certified data is kept separate from lab evidence because it requires
          versioned cases, verifier output, harness metadata, and reproducibility
          hashes.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <CertifiedStat label="Certified runs" value={String(summary.certifiedRuns)} />
        <CertifiedStat label="Cases" value={String(summary.certifiedCases)} />
        <CertifiedStat label="Attempts" value={String(counts.certifiedAttempts)} />
        <CertifiedStat label="Verified pass" value={pct(summary.verifiedPassRate)} />
        <CertifiedStat
          label="Avg verified quality"
          value={formatScore(summary.averageQuality)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <CertifiedStat label="Verifier results" value={String(counts.verifierResults)} />
        <CertifiedStat label="Teams" value={String(counts.teamCompositions)} />
        <CertifiedStat label="Avg cost" value={usd(summary.averageCostUsd)} />
        <CertifiedStat label="Avg duration" value={duration(summary.averageDurationMs)} />
      </div>

      {!hasCertifiedData ? (
        <CertifiedEmptyState track={track} />
      ) : !hasTrackData ? (
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
          <CertifiedLeaderboard rows={leaderboard} track={track} />
        </>
      )}
    </section>
  );
}

function CertifiedStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function CertifiedEmptyState({ track }: { track: CertifiedTrackView }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>No certified runs yet</CardTitle>
        <CardDescription>
          Import a v2 benchmark JSON bundle from Reports, or run a certified
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
}: {
  rows: CertifiedLeaderboardRow[];
  track: CertifiedTrackView;
}) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Certified records were loaded, but no ranked teams or models are
          available yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {track === "all" ? "Certified leaderboard" : `${TRACK_LABELS[track]} leaderboard`}
        </CardTitle>
        <CardDescription>
          Ranked by verified quality, with pass rate and efficiency signals kept
          visible for review.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Team or model</th>
              <th className="px-3 py-2 font-medium">Track</th>
              <th className="px-3 py-2 text-right font-medium">Attempts</th>
              <th className="px-3 py-2 text-right font-medium">
                Verified quality
              </th>
              <th className="px-3 py-2 text-right font-medium">Pass</th>
              <th className="px-3 py-2 text-right font-medium">Efficiency</th>
              <th className="px-3 py-2 text-right font-medium">Tool</th>
              <th className="py-2 pl-3 text-right font-medium">Cost</th>
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
                  {row.attempts}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {formatScore(row.verifiedQuality)}
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
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
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
      value: `Verified quality ${formatScore(quality.verifiedQuality)}`,
    });
  }
  if (value) {
    recommendations.push({
      label: "Best value",
      name: value.label,
      value: `${formatScore(value.verifiedQuality)} quality at ${usd(value.averageCostUsd)}`,
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
  verifiedQuality: number | null;
  passRate: number | null;
  efficiencyScore: number | null;
  toolReliabilityScore: number | null;
  averageCostUsd: number | null;
  averageDurationMs: number | null;
  teamLift: number | null;
}

function readCertifiedSummary(
  certified: unknown,
  counts: BenchmarkReportCounts
): CertifiedSummary {
  const summary = readRecord(readRecord(certified).summary);
  return {
    certifiedRuns:
      readNumber(summary.certifiedRuns) ?? readNumber(summary.totalRuns) ?? 0,
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
  return filtered.sort(
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
  };
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

function readTrackList(row: Record<string, unknown>): string[] {
  if (Array.isArray(row.tracks)) {
    return row.tracks.filter(
      (item): item is string => typeof item === "string" && item.length > 0
    );
  }
  const track = readString(row.track);
  return track ? [track] : [];
}

function formatScore(value: number | null): string {
  if (value == null) return "n/a";
  const score = value <= 1 ? value * 100 : value;
  return `${Math.round(score * 10) / 10}`;
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

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
