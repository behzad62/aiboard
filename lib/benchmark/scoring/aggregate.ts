import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkTeamComposition,
} from "@/lib/benchmark/types";
import { computeTeamLift } from "@/lib/benchmark/certified/team-lift";
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
  inputTokens?: number | null;
  outputTokens?: number | null;
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
  isTeam: boolean;
  tracks: Set<string>;
  // Per-track quality accumulators feeding the equal-weighted overall score.
  // Keyed by resolved track; each holds this row's attempt count and verified-
  // quality sum WITHIN that one track, so finalizeGroup can average per track
  // and then take the simple (equal-weight) mean of those track averages.
  trackQuality: Map<
    string,
    { attempts: number; passed: number; verifiedQualitySum: number }
  >;
  caseIds: Set<string>;
  // Case ids in first-appearance order across this row's attempts. The Set above
  // tracks membership (for the `cases` count and dedup); this array preserves a
  // deterministic order so resolved titles read the same way every render.
  caseIdOrder: string[];
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
  inputTokens: number;
  outputTokens: number;
  tokenSamples: number;
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
    const inputTokens = finiteOrNull(attempt.inputTokens);
    const outputTokens = finiteOrNull(attempt.outputTokens);
    const track =
      attempt.track ??
      ((attempt.caseId ? (caseById.get(attempt.caseId) as BenchmarkCaseV2 | undefined) : undefined) as
        | { track?: string }
        | undefined)?.track ??
      "unknown";

    const attemptPassed = isPassedAttempt(attempt);
    group.attempts += 1;
    if (attemptPassed) group.passed += 1;
    else group.failed += 1;
    if (attempt.caseId) {
      if (!group.caseIds.has(attempt.caseId)) {
        group.caseIdOrder.push(attempt.caseId);
      }
      group.caseIds.add(attempt.caseId);
    }
    group.tracks.add(track);
    const trackQuality =
      group.trackQuality.get(track) ??
      { attempts: 0, passed: 0, verifiedQualitySum: 0 };
    trackQuality.attempts += 1;
    if (attemptPassed) trackQuality.passed += 1;
    trackQuality.verifiedQualitySum += verifiedQuality;
    group.trackQuality.set(track, trackQuality);
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
    if (inputTokens != null || outputTokens != null) {
      group.inputTokens += inputTokens ?? 0;
      group.outputTokens += outputTokens ?? 0;
      group.tokenSamples += 1;
    }
  }

  const rows = Array.from(groups.values()).map((group) =>
    finalizeGroup(group, caseById)
  );
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

/**
 * Rank by the equal-weighted cross-track OVERALL score. Preliminary rows are
 * demoted, rows with no overall score (no scored attempts) sort last, then ties
 * break by verified quality, attempt count, and display name — mirroring the
 * verified-quality ranking's convention so the leaderboard stays consistent
 * when the user flips to the Overall sort.
 */
export function rankByOverall<T extends Partial<CertifiedRunScore>>(
  rows: T[]
): T[] {
  return [...rows].sort(
    (a, b) =>
      comparePreliminary(a, b) ||
      compareNumberDesc(a.overallScore, b.overallScore) ||
      compareNumberDesc(a.verifiedQuality, b.verifiedQuality) ||
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
  // Efficiency ranking. Rows with a real USD cost-per-pass sort first (cheapest
  // to priciest); rows with no pricing (account/custom providers) fall back to
  // tokens-per-pass and sort among themselves after the priced rows. Cost and
  // tokens are different units, so we never compare a USD row against a token
  // row numerically — priced rows simply outrank unpriced ones, and within each
  // basis the cheaper/leaner row wins.
  return [...rows].sort(
    (a, b) =>
      compareCostBasisPriority(a, b) ||
      compareNumberAsc(a.costPerPass, b.costPerPass) ||
      compareNumberAsc(a.tokensPerPass, b.tokensPerPass) ||
      compareNumberDesc(a.verifiedQuality, b.verifiedQuality) ||
      compareText(a.displayName, b.displayName)
  );
}

// USD-priced rows (costBasis "usd") rank ahead of token-only rows ("tokens"),
// which rank ahead of rows with neither basis. Falls back to the null-safe
// costPerPass/tokensPerPass presence when costBasis isn't populated on the row.
function compareCostBasisPriority<T extends Partial<CertifiedRunScore>>(
  a: T,
  b: T
): number {
  return costBasisRank(b) - costBasisRank(a);
}

function costBasisRank<T extends Partial<CertifiedRunScore>>(row: T): number {
  const basis =
    row.costBasis ??
    (finiteOrNull(row.costPerPass) != null
      ? "usd"
      : finiteOrNull(row.tokensPerPass) != null
        ? "tokens"
        : null);
  if (basis === "usd") return 2;
  if (basis === "tokens") return 1;
  return 0;
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
    isTeam: roles.length > 1,
    tracks: new Set(),
    trackQuality: new Map(),
    caseIds: new Set(),
    caseIdOrder: [],
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
    inputTokens: 0,
    outputTokens: 0,
    tokenSamples: 0,
  };
  groups.set(teamId, created);
  return created;
}

function finalizeGroup(
  group: MutableCertifiedRunScore,
  caseById: Map<string, BenchmarkCaseV2>
): CertifiedRunScore {
  const costUsd = group.costSamples > 0 ? round(group.costUsd, 6) : null;
  const durationMs =
    group.durationSamples > 0 ? round(group.durationMs / group.durationSamples) : null;
  const hasTokens = group.tokenSamples > 0;
  const inputTokens = hasTokens ? group.inputTokens : null;
  const outputTokens = hasTokens ? group.outputTokens : null;
  const totalTokens = hasTokens ? group.inputTokens + group.outputTokens : null;
  const costPerPass =
    group.passed > 0 && group.costSamples > 0
      ? round(group.costUsd / group.passed, 6)
      : null;
  const tokensPerPass =
    group.passed > 0 && hasTokens
      ? round((group.inputTokens + group.outputTokens) / group.passed)
      : null;
  // Prefer real USD cost; fall back to token-based efficiency when the row's
  // providers have no pricing (account/custom). null only if neither exists.
  const costBasis: "usd" | "tokens" | null =
    costPerPass != null ? "usd" : tokensPerPass != null ? "tokens" : null;

  // Equal-weighted cross-track overall score. Average verified quality WITHIN
  // each track first, then take the simple mean of those per-track averages so
  // every track counts the same regardless of attempt volume. A high-volume
  // track cannot drown a low-volume one this way (unlike verifiedQuality, which
  // is attempt-weighted). Null when the row has no scored attempts.
  const trackBreakdown = Array.from(group.trackQuality.entries())
    .map(([track, acc]) => ({
      track,
      attempts: acc.attempts,
      passed: acc.passed,
      verifiedPassRate: rate(acc.passed, acc.attempts),
      averageVerifiedQuality: average(acc.verifiedQualitySum, acc.attempts),
    }))
    .sort((a, b) => a.track.localeCompare(b.track));
  const overallScore =
    trackBreakdown.length > 0
      ? round(
          trackBreakdown.reduce(
            (sum, entry) => sum + entry.averageVerifiedQuality,
            0
          ) / trackBreakdown.length
        )
      : null;

  return {
    id: group.id,
    teamCompositionId: group.teamCompositionId,
    teamName: group.teamName,
    comboHash: group.comboHash,
    displayName: group.displayName,
    modelIds: group.modelIds,
    isTeam: group.isTeam,
    tracks: Array.from(group.tracks).sort(),
    caseTitles: resolveCaseTitles(group.caseIdOrder, caseById),
    attempts: group.attempts,
    preliminary: group.attempts > 0 && group.attempts < MIN_CONFIDENT_ATTEMPTS,
    cases: group.caseIds.size,
    passed: group.passed,
    failed: group.failed,
    verifiedPassRate: rate(group.passed, group.attempts),
    verifiedQuality: average(group.verifiedQualitySum, group.attempts),
    overallScore,
    trackBreakdown,
    jobSuccessScore: average(group.jobSuccessScoreSum, group.attempts),
    efficiencyScore: average(group.efficiencyScoreSum, group.attempts),
    toolReliabilityScore:
      group.toolReliabilitySamples > 0
        ? average(group.toolReliabilityScoreSum, group.toolReliabilitySamples)
        : null,
    toolReliabilitySamples: group.toolReliabilitySamples,
    costUsd,
    averageCostUsd:
      group.costSamples > 0 ? round(group.costUsd / group.costSamples, 6) : null,
    durationMs,
    costPerPass,
    speedPerPassMs:
      group.passed > 0 && group.durationSamples > 0
        ? round(group.durationMs / group.passed)
        : null,
    inputTokens,
    outputTokens,
    totalTokens,
    tokensPerPass,
    costBasis,
    bestSoloScore: null,
    teamLift: null,
    teamLiftLabel: null,
  };
}

function applyTeamLift(rows: CertifiedRunScore[]): void {
  const soloScoreByModel = new Map<string, CertifiedRunScore>();
  for (const row of rows) {
    if (row.isTeam || row.modelIds.length !== 1) continue;
    const modelId = row.modelIds[0];
    const existing = soloScoreByModel.get(modelId);
    if (!existing || row.jobSuccessScore > existing.jobSuccessScore) {
      soloScoreByModel.set(modelId, row);
    }
  }

  for (const row of rows) {
    if (!row.isTeam) continue;
    const lift = computeTeamLift(row, soloScoreByModel);
    if (!lift) continue;
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

/**
 * Resolve a row's case ids (in first-appearance order) to display titles. Each
 * id maps to its case record's `title`; when no record is found (e.g. an
 * imported bundle missing the case), the raw id is kept so the row still names
 * something. Titles are de-duplicated while preserving first-appearance order,
 * so a merged cross-track row that reaches the same case through two tracks (two
 * ids resolving to one title, or the same id twice) lists that title once.
 */
function resolveCaseTitles(
  caseIdOrder: string[],
  caseById: Map<string, BenchmarkCaseV2>
): string[] {
  const seen = new Set<string>();
  const titles: string[] = [];
  for (const caseId of caseIdOrder) {
    const title = caseById.get(caseId)?.title ?? caseId;
    if (seen.has(title)) continue;
    seen.add(title);
    titles.push(title);
  }
  return titles;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value)))
  ).sort();
}
