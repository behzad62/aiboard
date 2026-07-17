// Shared read-side selectors over the certified benchmark dashboard payload
// (the `certified` blob returned by buildCertifiedBenchmarkDashboardData and
// re-shaped through JSON at the store boundary). Extracted 2026-07-17 from
// components/benchmark/certified/CertifiedBenchmarkOverview.tsx (benchmark UX
// overhaul Task 5) so the Results tab's VerdictStrip and LensTabs can reuse the
// EXACT same parsing/ranking math the leaderboard and the old verdict/
// recommendation cards used — never re-derive these numbers independently.
//
// Pure data in, data out — no JSX here. Rendering-only helpers (track label
// strings, case-title shortening, tooltip text) stay component-side in
// CertifiedBenchmarkOverview.tsx since they are presentation, not selection.
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

export type LeaderboardSortKey =
  | "quality"
  | "overall"
  | "teamLift"
  | "costPerPass"
  | "speedPerPass"
  | "toolReliability"
  | "efficiency";

export const SORT_OPTIONS: Array<{ key: LeaderboardSortKey; label: string }> = [
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
export const SORT_SOURCE_KEY: Record<
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

export const SORT_BASIS_TEXT: Record<LeaderboardSortKey, string> = {
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

/** The subset of BenchmarkReportCounts readCertifiedSummary actually reads —
 * kept local (rather than importing the full component-layer type) so this
 * lib module has no dependency on components/. */
export interface CertifiedSummaryCounts {
  certifiedCases: number;
  certifiedAttempts: number;
}

export interface CertifiedSummary {
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

export interface CertifiedLeaderboardRow {
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
  /** The underlying team composition id (distinct from `id`, which is the
   * comboHash/display key). Solo/team lens filtering and roster-chip lookups
   * key off this. */
  teamCompositionId: string;
  /** Member model ids. Length 1 (or 0 for legacy rows without the field) is a
   * solo row; length > 1 is a team row — see isTeamRow/isSoloRow below. */
  modelIds: string[];
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

export interface ModelIntelligenceTrackBreakdown {
  track: string;
  attempts: number;
  passed: number;
  verifiedPassRate: number | null;
  averageVerifiedQuality: number;
}

export interface ModelIntelligenceRow {
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

export interface WorkBenchRoleRow {
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

export interface WorkBenchRoleBoards {
  architect: WorkBenchRoleRow[];
  worker: WorkBenchRoleRow[];
  reviewer: WorkBenchRoleRow[];
}

export interface CertifiedTrackRow {
  track: string;
  cases: number;
  attempts: number;
  passed: number;
  verifiedPassRate: number | null;
  averageVerifiedQuality: number | null;
}

export function readCertifiedSummary(
  certified: unknown,
  counts: CertifiedSummaryCounts
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

export function readLeaderboard(
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

export function readParetoIds(certified: unknown): Set<string> {
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

export function readTrackRows(certified: unknown): CertifiedTrackRow[] {
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

export function readModelIntelligence(certified: unknown): ModelIntelligenceRow[] {
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

export function readLeaderboardRow(value: unknown): CertifiedLeaderboardRow | null {
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
    teamCompositionId: readString(row.teamCompositionId) ?? id,
    modelIds: readStringList(row.modelIds),
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

export function resolveLeaderboardDeleteFields(
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

export function readWorkBenchRoleLeaderboards(certified: unknown): WorkBenchRoleBoards {
  const source = readRecord(readRecord(certified).workBenchRoleLeaderboards);
  return {
    architect: readWorkBenchRoleRows(source.architect),
    worker: readWorkBenchRoleRows(source.worker),
    reviewer: readWorkBenchRoleRows(source.reviewer),
  };
}

export function readWorkBenchRoleRows(value: unknown): WorkBenchRoleRow[] {
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

export function readTeamIqComboMatrixRows(certified: unknown): TeamIqComboMatrixRow[] {
  return readArray(readRecord(certified).teamIqComboMatrixRows)
    .map(readTeamIqComboMatrixRow)
    .filter((row): row is TeamIqComboMatrixRow => row !== null);
}

export function readTeamIqComboMatrixRow(value: unknown): TeamIqComboMatrixRow | null {
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

export function readBenchmarkTrack(value: string | null): BenchmarkTrack | null {
  const normalized = normalizeTrack(value ?? undefined);
  return normalized && normalized !== "all" ? normalized : null;
}

export function readTeamIqRecommendationCards(
  certified: unknown
): TeamIqRecommendationCard[] {
  return readArray(readRecord(certified).teamIqRecommendationCards)
    .map(readTeamIqRecommendationCard)
    .filter((card): card is TeamIqRecommendationCard => card !== null);
}

export function readTeamIqRecommendationCard(
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

export function readTeamIqRecommendationLabel(
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

export function readTeamLiftLabel(
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

export function normalizeTrack(
  track: string | undefined
): CertifiedTrackView | undefined {
  if (!track) return undefined;
  const normalized = track.toLowerCase().replace(/[\s_-]/g, "");
  if (normalized === "workbench") return "workbench";
  if (normalized === "game" || normalized === "gameiq") return "gameiq";
  if (normalized === "teamiq") return "teamiq";
  if (normalized === "toolreliability") return "toolreliability";
  return undefined;
}

export function readProviderErrorAttemptIds(
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

// --- Row classification -----------------------------------------------

/** A team row has more than one member model id. Rows imported from before
 * `modelIds` existed on the payload (empty array) fall back to solo — the
 * safer default for a leaderboard row with no team evidence. */
export function isTeamRow(row: CertifiedLeaderboardRow): boolean {
  return row.modelIds.length > 1;
}

export function isSoloRow(row: CertifiedLeaderboardRow): boolean {
  return !isTeamRow(row);
}

// --- Verdict-strip selectors --------------------------------------------
// These reuse the exact ranking math the old BestModelVerdictCard and
// CertifiedRecommendationCards components used (maxBy/minBy over the already-
// computed leaderboard rows) rather than re-deriving new formulas.

export function maxBy(
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

export function minBy(
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

// Quality per dollar (the "Most efficient" axis): prefers priced rows.
// Verified quality is 0-1 on some payloads and 0-100 on others (legacy rows) —
// normalize to a 0-100 scale before dividing so the ranking is comparable.
function qualityPerDollar(row: CertifiedLeaderboardRow): number | null {
  return row.averageCostUsd && row.verifiedQuality
    ? (row.verifiedQuality <= 1 ? row.verifiedQuality * 100 : row.verifiedQuality) /
        row.averageCostUsd
    : null;
}

/** Highest quality-per-dollar row. Null when no row in the set has both a
 * verified quality and a real USD cost (e.g. every row is on an account or
 * custom provider with no pricing) — callers should fall back to
 * `pickCheapestByTokens` in that case, same two-step fallback the old
 * CertifiedRecommendationCards "Most efficient" card used. */
export function pickMostEfficient(
  rows: CertifiedLeaderboardRow[]
): CertifiedLeaderboardRow | null {
  return maxBy(rows, qualityPerDollar);
}

/** Token-based efficiency fallback for providers with no pricing. */
export function pickCheapestByTokens(
  rows: CertifiedLeaderboardRow[]
): CertifiedLeaderboardRow | null {
  return minBy(rows, (row) => row.tokensPerPass);
}

/** The TeamIQ-computed "best team lift" recommendation, already gated by
 * baseline availability, sample count, and the preliminary rule — never
 * recompute team lift here. */
export function pickBestTeamLiftCard(
  cards: TeamIqRecommendationCard[]
): TeamIqRecommendationCard | undefined {
  return cards.find((card) => card.kind === "best_team_lift");
}
