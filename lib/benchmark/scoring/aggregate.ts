import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkTeamComposition,
} from "@/lib/benchmark/types";
import { scoreTeamLift } from "./teamiq";
import type { CertifiedAggregateInput, CertifiedRunScore } from "./types";
import { finiteOrNull, round } from "./types";

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
  const attempts = (Array.isArray(input) ? input : input.attempts).filter(
    (attempt) => (attempt as AttemptLike).mode === undefined || (attempt as AttemptLike).mode === "certified"
  );
  const teams = Array.isArray(input) ? [] : input.teamCompositions ?? [];
  const cases = Array.isArray(input) ? [] : input.cases ?? [];
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
      teamCostUsd: row.costPerPass,
      bestSoloCostUsd: bestSolo.costPerPass,
      teamDurationMs: row.speedPerPassMs,
      bestSoloDurationMs: bestSolo.speedPerPassMs,
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
