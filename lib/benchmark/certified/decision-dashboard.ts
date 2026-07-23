import type {
  CertifiedLeaderboardRow,
  LeaderboardSortKey,
} from "./dashboard-selectors";

export const CERTIFIED_INDEX_VERSION = "Certified Index v1.0";
export const MIN_MATURE_ATTEMPTS = 3;

export type DecisionRow = CertifiedLeaderboardRow;

export interface DecisionFilters {
  query: string;
  track: string;
  kind: "all" | "solo" | "team";
  provider: string;
  effort: string;
  evidence: "all" | "mature" | "preliminary";
}

export interface ConfidenceInterval {
  lower: number;
  upper: number;
}

export type DecisionVerdictKey =
  | "overall"
  | "workbench"
  | "reliability"
  | "leanest"
  | "fastest"
  | "teamLift";

export interface DecisionVerdict {
  key: DecisionVerdictKey;
  label: string;
  winner: DecisionRow | null;
  metric: number | null;
  evidenceCount: number | null;
  evidenceLabel: string;
  preliminary: boolean;
  emptyHint: string;
}

export function wilsonInterval(
  passed: number,
  total: number,
  z = 1.96
): ConfidenceInterval | null {
  if (!Number.isFinite(passed) || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  const boundedPassed = Math.min(total, Math.max(0, passed));
  const proportion = boundedPassed / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = (proportion + zSquared / (2 * total)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt(
      (proportion * (1 - proportion)) / total +
        zSquared / (4 * total * total)
    );
  return {
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

export function filterDecisionRows(
  rows: DecisionRow[],
  filters: DecisionFilters
): DecisionRow[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return rows.flatMap((row) => {
    if (filters.track !== "all" && !row.tracks.includes(filters.track)) {
      return [];
    }
    const team = isTeam(row);
    if (filters.kind === "solo" && team) return [];
    if (filters.kind === "team" && !team) return [];
    if (
      filters.provider !== "all" &&
      !(row.providerIds ?? []).includes(filters.provider)
    ) {
      return [];
    }
    if (
      filters.effort !== "all" &&
      !(row.reasoningEfforts ?? []).includes(filters.effort)
    ) {
      return [];
    }
    if (query && !searchableText(row).includes(query)) return [];

    const scoped = scopeToTrack(row, filters.track);
    if (!scoped) return [];
    if (
      filters.evidence === "mature" &&
      scoped.attempts < MIN_MATURE_ATTEMPTS
    ) {
      return [];
    }
    if (
      filters.evidence === "preliminary" &&
      scoped.attempts >= MIN_MATURE_ATTEMPTS
    ) {
      return [];
    }
    return [scoped];
  });
}

export function sortDecisionRows(
  rows: DecisionRow[],
  sortKey: LeaderboardSortKey
): DecisionRow[] {
  return [...rows].sort((left, right) => {
    const maturityOrder = Number(left.preliminary) - Number(right.preliminary);
    if (maturityOrder) return maturityOrder;
    if (sortKey === "costPerPass") {
      const costOrder = compareCost(left, right);
      if (costOrder) return costOrder;
    } else {
      const direction = sortKey === "speedPerPass" ? "minimum" : "maximum";
      const metricOrder = compareMetric(
        rankMetric(left, sortKey),
        rankMetric(right, sortKey),
        direction
      );
      if (metricOrder) return metricOrder;
    }
    return (
      right.attempts - left.attempts ||
      left.label.localeCompare(right.label)
    );
  });
}

export function buildDecisionVerdicts(rows: DecisionRow[]): DecisionVerdict[] {
  const soloRows = rows.filter((row) => !isTeam(row));
  const teamRows = rows.filter(isTeam);
  return [
    verdict(
      "overall",
      "Best overall model",
      pickMaximum(soloRows, (row) => row.overallScore ?? row.verifiedQuality),
      (row) => row.overallScore ?? row.verifiedQuality,
      (row) => row.attempts,
      "scored attempt",
      "Run one model across certified tracks to establish an overall result."
    ),
    verdict(
      "workbench",
      "Best WorkBench model",
      pickMaximum(soloRows, workBenchQuality),
      workBenchQuality,
      workBenchAttempts,
      "WorkBench attempt",
      "Run a solo WorkBench pack to compare verified coding work."
    ),
    verdict(
      "reliability",
      "Most reliable",
      pickMaximum(soloRows, (row) => row.toolReliabilityScore),
      (row) => row.toolReliabilityScore,
      (row) => row.toolReliabilitySamples,
      "reliability sample",
      "Run Tool Reliability to compare structured and tool-call discipline."
    ),
    verdict(
      "leanest",
      "Leanest successful model",
      pickMinimum(soloRows, (row) => row.tokensPerPass),
      (row) => row.tokensPerPass,
      (row) => row.passed,
      "successful case",
      "Complete at least one successful measured attempt to compare token use."
    ),
    verdict(
      "fastest",
      "Fastest successful model",
      pickMinimum(soloRows, (row) => row.speedPerPassMs),
      (row) => row.speedPerPassMs,
      (row) => row.passed,
      "successful case",
      "Complete at least one successful measured attempt to compare speed."
    ),
    verdict(
      "teamLift",
      "Best team lift",
      pickMaximum(teamRows, (row) => row.teamLift),
      (row) => row.teamLift,
      (row) => row.attempts,
      "team attempt",
      "Run a team with solo baselines to measure added value."
    ),
  ];
}

function verdict(
  key: DecisionVerdictKey,
  label: string,
  winner: DecisionRow | null,
  readMetric: (row: DecisionRow) => number | null | undefined,
  readEvidence: (row: DecisionRow) => number | null | undefined,
  evidenceLabel: string,
  emptyHint: string
): DecisionVerdict {
  const evidenceCount = winner ? finite(readEvidence(winner)) : null;
  return {
    key,
    label,
    winner,
    metric: winner ? finite(readMetric(winner)) : null,
    evidenceCount,
    evidenceLabel,
    preliminary:
      winner != null &&
      (evidenceCount == null
        ? winner.preliminary
        : evidenceCount > 0 && evidenceCount < MIN_MATURE_ATTEMPTS),
    emptyHint,
  };
}

function workBenchQuality(row: DecisionRow): number | null {
  const track = row.trackBreakdown.find((item) => item.track === "workbench");
  return track ? finite(track.averageVerifiedQuality) : null;
}

function workBenchAttempts(row: DecisionRow): number | null {
  return (
    row.trackBreakdown.find((item) => item.track === "workbench")?.attempts ??
    null
  );
}

function pickMaximum(
  rows: DecisionRow[],
  readMetric: (row: DecisionRow) => number | null | undefined
): DecisionRow | null {
  return pick(rows, readMetric, "maximum");
}

function pickMinimum(
  rows: DecisionRow[],
  readMetric: (row: DecisionRow) => number | null | undefined
): DecisionRow | null {
  return pick(rows, readMetric, "minimum");
}

function pick(
  rows: DecisionRow[],
  readMetric: (row: DecisionRow) => number | null | undefined,
  direction: "minimum" | "maximum"
): DecisionRow | null {
  const candidates = rows
    .map((row) => ({ row, metric: finite(readMetric(row)) }))
    .filter(
      (item): item is { row: DecisionRow; metric: number } =>
        item.metric !== null
    );
  candidates.sort((left, right) => {
    const metricOrder =
      direction === "maximum"
        ? right.metric - left.metric
        : left.metric - right.metric;
    return (
      metricOrder ||
      right.row.attempts - left.row.attempts ||
      left.row.label.localeCompare(right.row.label)
    );
  });
  return candidates[0]?.row ?? null;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isTeam(row: DecisionRow): boolean {
  return row.isTeam;
}

function searchableText(row: DecisionRow): string {
  return [
    row.label,
    row.detail ?? "",
    ...row.caseTitles,
    ...(row.providerIds ?? []),
    ...(row.reasoningEfforts ?? []),
  ]
    .join(" ")
    .toLocaleLowerCase();
}

function scopeToTrack(row: DecisionRow, trackId: string): DecisionRow | null {
  if (trackId === "all") return row;
  const track = row.trackBreakdown.find((item) => item.track === trackId);
  if (!track) return null;
  const alreadySingleTrack =
    row.tracks.length === 1 && row.tracks[0] === trackId;
  return {
    ...row,
    tracks: [trackId],
    trackBreakdown: [track],
    caseTitles: alreadySingleTrack ? row.caseTitles : [],
    attempts: track.attempts,
    passed: track.passed,
    preliminary:
      track.attempts > 0 && track.attempts < MIN_MATURE_ATTEMPTS,
    verifiedQuality: track.averageVerifiedQuality,
    overallScore: track.averageVerifiedQuality,
    passRate: track.verifiedPassRate,
    efficiencyScore: alreadySingleTrack ? row.efficiencyScore : null,
    toolReliabilityScore: alreadySingleTrack
      ? row.toolReliabilityScore
      : null,
    toolReliabilitySamples: alreadySingleTrack
      ? row.toolReliabilitySamples
      : null,
    averageCostUsd: alreadySingleTrack ? row.averageCostUsd : null,
    costPerPass: alreadySingleTrack ? row.costPerPass : null,
    averageDurationMs: alreadySingleTrack ? row.averageDurationMs : null,
    durationMs: alreadySingleTrack ? row.durationMs : null,
    speedPerPassMs: alreadySingleTrack ? row.speedPerPassMs : null,
    totalTokens: alreadySingleTrack ? row.totalTokens : null,
    tokensPerPass: alreadySingleTrack ? row.tokensPerPass : null,
    costBasis: alreadySingleTrack ? row.costBasis : null,
    teamLift: alreadySingleTrack ? row.teamLift : null,
  };
}

function rankMetric(
  row: DecisionRow,
  sortKey: Exclude<LeaderboardSortKey, "costPerPass">
): number | null {
  if (sortKey === "quality") return row.verifiedQuality;
  if (sortKey === "overall") return row.overallScore;
  if (sortKey === "teamLift") return row.teamLift;
  if (sortKey === "speedPerPass") return row.speedPerPassMs;
  if (sortKey === "toolReliability") return row.toolReliabilityScore;
  return row.efficiencyScore;
}

function compareMetric(
  left: number | null,
  right: number | null,
  direction: "minimum" | "maximum"
): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;
  return direction === "minimum" ? left - right : right - left;
}

function compareCost(left: DecisionRow, right: DecisionRow): number {
  const leftCost = costRank(left);
  const rightCost = costRank(right);
  return (
    leftCost.tier - rightCost.tier ||
    compareMetric(leftCost.value, rightCost.value, "minimum")
  );
}

function costRank(row: DecisionRow): { tier: number; value: number | null } {
  if (row.costBasis === "usd" && row.costPerPass != null) {
    return { tier: 0, value: row.costPerPass };
  }
  if (row.tokensPerPass != null) {
    return { tier: 1, value: row.tokensPerPass };
  }
  return { tier: 2, value: null };
}
