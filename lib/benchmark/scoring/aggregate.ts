import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkTeamComposition,
} from "@/lib/benchmark/types";
import { scoreTeamLift } from "./teamiq";
import type { CertifiedAggregateInput, CertifiedRunScore } from "./types";
import { finiteOrNull, round } from "./types";

const MIN_CONFIDENT_ATTEMPTS = 3;

// Cross-track de-duplication.
//
// The same underlying decision can be scored into ONE merged (per-model /
// per-team) leaderboard row twice through two different tracks:
//   (a) fireworks — each GameIQ fireworks scenario is a re-wrap of a TeamIQ
//       fireworks scenario and carries an explicit `source:<teamiq-id>` tag
//       (see lib/benchmark/gameiq/fireworks.ts). The `gameiq` attempt and the
//       `teamiq` attempt then describe the same decision.
//   (b) toolreliability — the TeamIQ ToolReliability suites run the SAME case
//       ids as the dedicated solo ToolReliability track, so a `teamiq` attempt
//       and a `toolreliability` attempt can share the same underlying case id.
//
// When such attempts land in the SAME team group they must count once, not
// twice. We key strictly on the explicit `source:` tag or the shared case id —
// never on fuzzy matching — and keep the sample from the track-primary (richer)
// track. Track-scoped views and per-track rates are left untouched: they never
// run through this helper.
//
// Track priority (higher wins the shared decision):
//   toolreliability > gameiq > teamiq > workbench > harnessbench
// Rationale: the dedicated solo ToolReliability track carries the full
// tool-reliability scoring dimension the TeamIQ re-run lacks, and the GameIQ
// fireworks pack carries full move-quality scoring the TeamIQ fireworks re-wrap
// lacks — so in both real overlaps the TeamIQ re-wrap loses to the richer,
// dedicated track. Ties (same priority) break deterministically by attempt id.
const CROSS_TRACK_PRIORITY: Record<string, number> = {
  toolreliability: 5,
  gameiq: 4,
  teamiq: 3,
  workbench: 2,
  harnessbench: 1,
};

function trackPriority(track: string | undefined): number {
  return track != null && track in CROSS_TRACK_PRIORITY
    ? CROSS_TRACK_PRIORITY[track]
    : 0;
}

/**
 * Resolve an attempt to the id of the underlying decision it scores. Prefers an
 * explicit `source:<id>` tag on the attempt's case (the fireworks re-wrap
 * mechanism); otherwise falls back to the attempt's own case id (the shared
 * toolreliability case id). Never fuzzy-matches.
 */
function underlyingDecisionId(
  attempt: AttemptLike,
  caseById: Map<string, BenchmarkCaseV2>
): string {
  const caseId = attempt.caseId ?? "";
  const benchmarkCase = caseId ? caseById.get(caseId) : undefined;
  const sourceTag = benchmarkCase?.tags?.find((tag) => tag.startsWith("source:"));
  if (sourceTag) return sourceTag.slice("source:".length);
  return caseId;
}

/**
 * Drop the cross-track DUPLICATES of a shared underlying decision within a team
 * group. When the same decision is reached through more than one track, only
 * the samples from the single track-primary (richest) track survive; the
 * re-wrap track's samples are dropped. Repeated attempts of one decision WITHIN
 * a single track are kept intact (legitimate repetition for confidence), and
 * attempts with no resolvable underlying id (no case id) are always kept.
 * Used only by merged (cross-track) aggregates; callers that want a per-track
 * view must NOT run their attempts through this.
 */
export function dedupeCrossTrackAttempts(
  attempts: BenchmarkAttemptV2[],
  cases: BenchmarkCaseV2[] = []
): BenchmarkAttemptV2[] {
  const caseById = new Map(cases.map((item) => [item.id, item]));
  const passthrough: BenchmarkAttemptV2[] = [];
  // key -> attempts grouped by (team, decision), tracking which track wins.
  const groups = new Map<
    string,
    { winningTrack: string | undefined; attempts: AttemptLike[] }
  >();

  for (const attempt of attempts as AttemptLike[]) {
    const decisionId = underlyingDecisionId(attempt, caseById);
    if (!decisionId) {
      passthrough.push(attempt);
      continue;
    }
    const teamId = attempt.teamCompositionId ?? "unknown";
    const key = `${teamId}::${decisionId}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { winningTrack: attempt.track, attempts: [attempt] });
      continue;
    }
    group.attempts.push(attempt);
    if (winsTrack(attempt.track, group.winningTrack)) {
      group.winningTrack = attempt.track;
    }
  }

  const deduped: BenchmarkAttemptV2[] = [...passthrough];
  for (const group of groups.values()) {
    // Keep every same-track repeat from the winning track; drop the re-wrap
    // track's samples entirely.
    for (const attempt of group.attempts) {
      if (attempt.track === group.winningTrack) deduped.push(attempt);
    }
  }
  return deduped;
}

// Which of two tracks owns a shared decision: higher priority wins. On equal
// priority the incumbent keeps ownership, so a decision reached only within one
// track (same priority) is never split — all its samples are retained.
function winsTrack(
  candidate: string | undefined,
  incumbent: string | undefined
): boolean {
  return trackPriority(candidate) > trackPriority(incumbent);
}

type AttemptLike = BenchmarkAttemptV2 & {
  status?: string;
  verifiedQuality?: number;
  jobSuccessScore?: number;
  efficiencyScore?: number;
  toolReliabilityScore?: number;
  costUsd?: number | null;
  durationMs?: number | null;
  teamCompositionId?: string;
  caseId?: string;
  track?: string;
};

type TeamLike = BenchmarkTeamComposition & {
  id: string;
  name?: string;
  comboHash?: string;
  roles?: Array<{
    modelId?: string;
    displayName?: string;
    role?: string;
    slot?: string;
  }>;
};

interface MutableCertifiedRunScore {
  id: string;
  teamCompositionId: string;
  teamName: string;
  comboHash: string;
  displayName: string;
  modelIds: string[];
  tracks: Set<string>;
  caseIds: Set<string>;
  attempts: number;
  passed: number;
  failed: number;
  verifiedQualitySum: number;
  jobSuccessScoreSum: number;
  efficiencyScoreSum: number;
  toolReliabilityScoreSum: number;
  toolReliabilitySamples: number;
  costUsd: number;
  costSamples: number;
  durationMs: number;
  durationSamples: number;
}

export function aggregateCertifiedRunScores(
  input: CertifiedAggregateInput | BenchmarkAttemptV2[]
): CertifiedRunScore[] {
  const rawAttempts = (Array.isArray(input) ? input : input.attempts).filter(
    (attempt) => (attempt as AttemptLike).mode === undefined || (attempt as AttemptLike).mode === "certified"
  );
  const teams = Array.isArray(input) ? [] : input.teamCompositions ?? [];
  const cases = Array.isArray(input) ? [] : input.cases ?? [];
  // Leaderboard rows MERGE all tracks for a team into one row, so the same
  // underlying decision reached via two tracks must be counted once.
  const attempts = dedupeCrossTrackAttempts(rawAttempts, cases);
  const teamById = new Map(teams.map((team) => [team.id, team as TeamLike]));
  const caseById = new Map(cases.map((item) => [item.id, item]));
  const groups = new Map<string, MutableCertifiedRunScore>();

  for (const attempt of attempts as AttemptLike[]) {
    const teamId = attempt.teamCompositionId ?? "unknown";
    const team = teamById.get(teamId);
    const group = groupFor(groups, teamId, team);
    const verifiedQuality = readScore(attempt.verifiedQuality, 0, 1);
    const jobSuccessScore = readScore(
      attempt.jobSuccessScore,
      0,
      100,
      verifiedQuality * 100
    );
    const efficiencyScore = readScore(attempt.efficiencyScore, 0, 100);
    const toolReliabilityScore = finiteOrNull(attempt.toolReliabilityScore);
    const costUsd = finiteOrNull(attempt.costUsd);
    const durationMs = finiteOrNull(attempt.durationMs);
    const track =
      attempt.track ??
      ((attempt.caseId ? (caseById.get(attempt.caseId) as BenchmarkCaseV2 | undefined) : undefined) as
        | { track?: string }
        | undefined)?.track ??
      "unknown";

    group.attempts += 1;
    if (isPassedAttempt(attempt)) group.passed += 1;
    else group.failed += 1;
    if (attempt.caseId) group.caseIds.add(attempt.caseId);
    group.tracks.add(track);
    group.verifiedQualitySum += verifiedQuality;
    group.jobSuccessScoreSum += jobSuccessScore;
    group.efficiencyScoreSum += efficiencyScore;
    if (toolReliabilityScore != null) {
      group.toolReliabilityScoreSum += toolReliabilityScore;
      group.toolReliabilitySamples += 1;
    }
    if (costUsd != null) {
      group.costUsd += costUsd;
      group.costSamples += 1;
    }
    if (durationMs != null) {
      group.durationMs += durationMs;
      group.durationSamples += 1;
    }
  }

  const rows = Array.from(groups.values()).map(finalizeGroup);
  applyTeamLift(rows);
  return rankByVerifiedQuality(rows);
}

export function rankByVerifiedQuality<T extends Partial<CertifiedRunScore>>(
  rows: T[]
): T[] {
  return [...rows].sort(
    (a, b) =>
      comparePreliminary(a, b) ||
      compareNumberDesc(a.verifiedQuality, b.verifiedQuality) ||
      compareNumberDesc(a.verifiedPassRate, b.verifiedPassRate) ||
      compareNumberDesc(a.attempts, b.attempts) ||
      compareText(a.displayName, b.displayName)
  );
}

export function rankByEfficiency<T extends Partial<CertifiedRunScore>>(
  rows: T[]
): T[] {
  return [...rows].sort(
    (a, b) =>
      compareNumberDesc(a.efficiencyScore, b.efficiencyScore) ||
      compareNumberDesc(a.verifiedQuality, b.verifiedQuality) ||
      compareText(a.displayName, b.displayName)
  );
}

export function rankByCostPerPass<T extends Partial<CertifiedRunScore>>(
  rows: T[]
): T[] {
  return [...rows].sort(
    (a, b) =>
      compareNumberAsc(a.costPerPass, b.costPerPass) ||
      compareNumberDesc(a.verifiedQuality, b.verifiedQuality) ||
      compareText(a.displayName, b.displayName)
  );
}

export function rankBySpeedPerPass<T extends Partial<CertifiedRunScore>>(
  rows: T[]
): T[] {
  return [...rows].sort(
    (a, b) =>
      compareNumberAsc(a.speedPerPassMs, b.speedPerPassMs) ||
      compareNumberDesc(a.verifiedQuality, b.verifiedQuality) ||
      compareText(a.displayName, b.displayName)
  );
}

export function rankByTeamLift<T extends Partial<CertifiedRunScore>>(
  rows: T[]
): T[] {
  return [...rows].sort(
    (a, b) =>
      compareNumberDesc(a.teamLift, b.teamLift) ||
      compareNumberDesc(a.verifiedQuality, b.verifiedQuality) ||
      compareText(a.displayName, b.displayName)
  );
}

export function rankByToolReliability<T extends Partial<CertifiedRunScore>>(
  rows: T[]
): T[] {
  return [...rows].sort(
    (a, b) =>
      compareNumberDesc(a.toolReliabilityScore, b.toolReliabilityScore) ||
      compareNumberDesc(a.verifiedQuality, b.verifiedQuality) ||
      compareText(a.displayName, b.displayName)
  );
}

function groupFor(
  groups: Map<string, MutableCertifiedRunScore>,
  teamId: string,
  team: TeamLike | undefined
): MutableCertifiedRunScore {
  const existing = groups.get(teamId);
  if (existing) return existing;

  const roles = team?.roles ?? [];
  const modelIds = uniqueStrings(roles.map((role) => role.modelId));
  const displayNames = uniqueStrings(
    roles.map((role) => role.displayName ?? role.modelId)
  );
  const displayName =
    team?.name ??
    (displayNames.length > 0 ? displayNames.join(" + ") : teamId);
  const created: MutableCertifiedRunScore = {
    id: team?.comboHash ?? teamId,
    teamCompositionId: teamId,
    teamName: team?.name ?? displayName,
    comboHash: team?.comboHash ?? teamId,
    displayName,
    modelIds,
    tracks: new Set(),
    caseIds: new Set(),
    attempts: 0,
    passed: 0,
    failed: 0,
    verifiedQualitySum: 0,
    jobSuccessScoreSum: 0,
    efficiencyScoreSum: 0,
    toolReliabilityScoreSum: 0,
    toolReliabilitySamples: 0,
    costUsd: 0,
    costSamples: 0,
    durationMs: 0,
    durationSamples: 0,
  };
  groups.set(teamId, created);
  return created;
}

function finalizeGroup(group: MutableCertifiedRunScore): CertifiedRunScore {
  const costUsd = group.costSamples > 0 ? round(group.costUsd, 6) : null;
  const durationMs =
    group.durationSamples > 0 ? round(group.durationMs / group.durationSamples) : null;

  return {
    id: group.id,
    teamCompositionId: group.teamCompositionId,
    teamName: group.teamName,
    comboHash: group.comboHash,
    displayName: group.displayName,
    modelIds: group.modelIds,
    tracks: Array.from(group.tracks).sort(),
    attempts: group.attempts,
    preliminary: group.attempts > 0 && group.attempts < MIN_CONFIDENT_ATTEMPTS,
    cases: group.caseIds.size,
    passed: group.passed,
    failed: group.failed,
    verifiedPassRate: rate(group.passed, group.attempts),
    verifiedQuality: average(group.verifiedQualitySum, group.attempts),
    jobSuccessScore: average(group.jobSuccessScoreSum, group.attempts),
    efficiencyScore: average(group.efficiencyScoreSum, group.attempts),
    toolReliabilityScore:
      group.toolReliabilitySamples > 0
        ? average(group.toolReliabilityScoreSum, group.toolReliabilitySamples)
        : null,
    costUsd,
    averageCostUsd:
      group.costSamples > 0 ? round(group.costUsd / group.costSamples, 6) : null,
    durationMs,
    costPerPass:
      group.passed > 0 && group.costSamples > 0
        ? round(group.costUsd / group.passed, 6)
        : null,
    speedPerPassMs:
      group.passed > 0 && group.durationSamples > 0
        ? round(group.durationMs / group.passed)
        : null,
    bestSoloScore: null,
    teamLift: null,
    teamLiftLabel: null,
  };
}

function applyTeamLift(rows: CertifiedRunScore[]): void {
  const soloScoreByModel = new Map<string, CertifiedRunScore>();
  for (const row of rows) {
    if (row.modelIds.length !== 1) continue;
    const modelId = row.modelIds[0];
    const existing = soloScoreByModel.get(modelId);
    if (!existing || row.jobSuccessScore > existing.jobSuccessScore) {
      soloScoreByModel.set(modelId, row);
    }
  }

  for (const row of rows) {
    if (row.modelIds.length <= 1) continue;
    const soloRows = row.modelIds
      .map((modelId) => soloScoreByModel.get(modelId))
      .filter((solo): solo is CertifiedRunScore => Boolean(solo));
    if (soloRows.length !== row.modelIds.length) continue;
    const bestSolo = soloRows.reduce((best, solo) =>
      solo.jobSuccessScore > best.jobSuccessScore ? solo : best
    );
    const lift = scoreTeamLift({
      teamScore: row.jobSuccessScore,
      memberSoloScores: soloRows.map((solo) => solo.jobSuccessScore),
      teamCostUsd: row.averageCostUsd,
      bestSoloCostUsd: bestSolo.averageCostUsd,
      teamDurationMs: row.durationMs,
      bestSoloDurationMs: bestSolo.durationMs,
    });
    row.bestSoloScore = lift.bestSoloScore;
    row.teamLift = lift.teamLift;
    row.teamLiftLabel = lift.label;
  }
}

function isPassedAttempt(attempt: AttemptLike): boolean {
  return attempt.status === "passed";
}

function readScore(
  value: number | null | undefined,
  min: number,
  max: number,
  fallback = min
): number {
  const number = finiteOrNull(value);
  if (number == null) return fallback;
  return Math.min(max, Math.max(min, number));
}

function average(sum: number, count: number): number {
  return count > 0 ? round(sum / count) : 0;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? round(numerator / denominator, 4) : null;
}

function compareNumberDesc(
  a: number | null | undefined,
  b: number | null | undefined
): number {
  const aValue = finiteOrNull(a);
  const bValue = finiteOrNull(b);
  if (aValue == null && bValue == null) return 0;
  if (aValue == null) return 1;
  if (bValue == null) return -1;
  return bValue - aValue;
}

function comparePreliminary<T extends Partial<CertifiedRunScore>>(
  a: T,
  b: T
): number {
  return Number(isPreliminary(a)) - Number(isPreliminary(b));
}

function isPreliminary(row: Partial<CertifiedRunScore>): boolean {
  if (typeof row.preliminary === "boolean") return row.preliminary;
  return typeof row.attempts === "number" &&
    row.attempts > 0 &&
    row.attempts < MIN_CONFIDENT_ATTEMPTS;
}

function compareNumberAsc(
  a: number | null | undefined,
  b: number | null | undefined
): number {
  const aValue = finiteOrNull(a);
  const bValue = finiteOrNull(b);
  if (aValue == null && bValue == null) return 0;
  if (aValue == null) return 1;
  if (bValue == null) return -1;
  return aValue - bValue;
}

function compareText(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  return (a ?? "").localeCompare(b ?? "");
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  ).sort();
}
