import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkTeamComposition,
  BenchmarkVerifierResult,
  HarnessCertificationResult,
} from "@/lib/benchmark/types";
import type {
  TeamIqComboMatrixRow,
  TeamIqRecommendationCard,
} from "@/lib/benchmark/teamiq";

export type NullableNumber = number | null | undefined;

export interface WorkBenchScoreInput {
  verifierScore: number;
  verifierPassed: boolean;
  actualCostUsd: NullableNumber;
  targetCostUsd: NullableNumber;
  actualDurationMs: NullableNumber;
  targetDurationMs: NullableNumber;
  validToolCalls: number;
  totalToolCalls: number;
}

export interface WorkBenchScore {
  verifiedQuality: number;
  jobSuccessScore: number;
  efficiencyScore: number;
  costFactor: number | null;
  timeFactor: number;
  toolReliability: number | null;
}

export interface GameIqScoreInput {
  outcomeScore: number;
  moveQuality: number;
  legalActionRate: number;
  structuredReliability: number;
  fallbackRate: number;
}

export interface ToolReliabilityScoreInput {
  schemaValidRate: number | null;
  firstAttemptValidRate: number | null;
  repairSuccessRate: number | null;
  toolValidRate: number | null;
  patchSuccessRate: number | null;
  commandSafetyRate: number | null;
  forbiddenActionRate: number | null;
  /**
   * Fraction of stateful (scripted multi-turn environment) cases passed.
   * Null when no stateful cases ran (e.g. a historical pre-v0.5 attempt) —
   * the null-skip renormalization in `scoreToolReliability` means such
   * attempts replay to the identical score they always had.
   */
  statefulDisciplineRate: number | null;
}

export type TeamLiftLabel =
  | "strong_positive"
  | "positive"
  | "neutral"
  | "negative"
  | "wasteful";

export interface TeamLiftScoreInput {
  teamScore: number;
  memberSoloScores: number[];
  teamCostUsd: NullableNumber;
  bestSoloCostUsd: NullableNumber;
  teamDurationMs: NullableNumber;
  bestSoloDurationMs: NullableNumber;
}

export interface TeamLiftScore {
  teamScore: number;
  bestSoloScore: number;
  teamLift: number;
  costAdjustedTeamLift: number | null;
  speedAdjustedTeamLift: number;
  label: TeamLiftLabel;
}

export type ParetoDirection = "higher" | "lower";

export interface ParetoDimension<T> {
  key: string;
  direction: ParetoDirection;
  value: (item: T) => number;
}

export interface CertifiedAggregateInput {
  attempts: BenchmarkAttemptV2[];
  cases?: BenchmarkCaseV2[];
  teamCompositions?: BenchmarkTeamComposition[];
  verifierResults?: BenchmarkVerifierResult[];
}

export interface CertifiedRunScore {
  id: string;
  teamCompositionId: string;
  teamName: string;
  comboHash: string;
  displayName: string;
  modelIds: string[];
  /** True for multi-role compositions, even when every role uses one model. */
  isTeam: boolean;
  tracks: string[];
  /**
   * Human-readable titles of the cases this row aggregates, so the leaderboard
   * can name WHICH packs/cases the row came from (not just its tracks). Unique,
   * in first-appearance order across the row's attempts. Each entry is the case
   * record's `title` resolved from the aggregate input's `cases`, falling back to
   * the raw caseId when no case record is found. Full titles are kept here; any
   * shared-prefix shortening is a display concern for the UI layer.
   */
  caseTitles: string[];
  attempts: number;
  preliminary: boolean;
  cases: number;
  passed: number;
  failed: number;
  verifiedPassRate: number | null;
  verifiedQuality: number;
  /**
   * Cross-track OVERALL score (0..1): the simple mean of this row's per-track
   * average verified quality, every track weighted EQUALLY. This is distinct
   * from `verifiedQuality`, which is the attempt-weighted mean across whatever
   * tracks the row ran. Equal weighting is deliberate: an attempt-weighted mean
   * lets a high-volume track (e.g. a 19-attempt WorkBench run) drown out a
   * low-volume one (e.g. a 1-attempt GameIQ run), so a model that runs one big
   * track would outrank a model judged fairly across several. Equal per-track
   * weighting judges breadth instead. Null when the row has no scored attempts
   * (no tracks to average). A single-track row's overallScore equals that
   * track's average verified quality (breadth is one track wide).
   */
  overallScore: number | null;
  /**
   * Per-track quality breakdown feeding `overallScore`, one entry per distinct
   * track the row ran, in track-id order. Lets the UI show WHAT the overall
   * number averages (e.g. in a tooltip). `averageVerifiedQuality` is the
   * attempt-weighted mean within that single track.
   */
  trackBreakdown: Array<{
    track: string;
    attempts: number;
    passed: number;
    verifiedPassRate: number | null;
    averageVerifiedQuality: number;
  }>;
  jobSuccessScore: number;
  efficiencyScore: number;
  toolReliabilityScore: number | null;
  toolReliabilitySamples: number;
  costUsd: number | null;
  averageCostUsd: number | null;
  durationMs: number | null;
  costPerPass: number | null;
  speedPerPassMs: number | null;
  /** Summed provider input tokens across the row's attempts (null if none). */
  inputTokens: number | null;
  /** Summed provider output tokens across the row's attempts (null if none). */
  outputTokens: number | null;
  /** Summed input+output tokens across the row's attempts (null if none). */
  totalTokens: number | null;
  /**
   * Total tokens per verified pass — the token-based efficiency axis that works
   * even when cost is unavailable (account/custom providers have no pricing).
   * Null when there are no passes or no token samples.
   */
  tokensPerPass: number | null;
  /**
   * Which basis the cost/efficiency ranking used for this row: "usd" when a real
   * USD cost was available, "tokens" when it fell back to tokensPerPass, null
   * when neither is available.
   */
  costBasis: "usd" | "tokens" | null;
  bestSoloScore: number | null;
  teamLift: number | null;
  teamLiftLabel: TeamLiftLabel | null;
}

export interface WorkBenchRoleLeaderboardRow {
  id: string;
  role: "architect" | "worker" | "reviewer";
  modelId: string;
  displayName: string;
  attempts: number;
  passed: number;
  verifiedPassRate: number | null;
  verifiedQuality: number;
  efficiencyScore: number;
  averageCostUsd: number | null;
  averageDurationMs: number | null;
}

export interface CertifiedBenchmarkDashboardInput {
  caseV2: BenchmarkCaseV2[];
  attemptsV2: BenchmarkAttemptV2[];
  verifierResults: BenchmarkVerifierResult[];
  teamCompositions: BenchmarkTeamComposition[];
  harnessCertifications: HarnessCertificationResult[];
}

export interface CertifiedBenchmarkDashboardData {
  summary: {
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
    certifiedTeams: number;
    verifiedPassRate: number | null;
    averageVerifiedQuality: number | null;
    averageEfficiencyScore: number | null;
    averageCostUsd: number | null;
    averageDurationMs: number | null;
    harnessCertificationPassRate: number | null;
  };
  leaderboard: CertifiedRunScore[];
  /**
   * The leaderboard rows ranked by the equal-weighted cross-track overall score
   * (nulls last, preliminary demoted). Backs the "Overall (all tracks)" Rank-by
   * option in the certified leaderboard UI.
   */
  overallLeaderboard: CertifiedRunScore[];
  efficiencyLeaderboard: CertifiedRunScore[];
  costPerPassLeaderboard: CertifiedRunScore[];
  speedPerPassLeaderboard: CertifiedRunScore[];
  teamLiftLeaderboard: CertifiedRunScore[];
  toolReliabilityLeaderboard: CertifiedRunScore[];
  workBenchRoleLeaderboards: {
    architect: WorkBenchRoleLeaderboardRow[];
    worker: WorkBenchRoleLeaderboardRow[];
    reviewer: WorkBenchRoleLeaderboardRow[];
  };
  paretoFrontier: CertifiedRunScore[];
  teamIqComboMatrixRows: TeamIqComboMatrixRow[];
  teamIqRecommendationCards: TeamIqRecommendationCard[];
  trackRows: Array<{
    track: string;
    cases: number;
    attempts: number;
    passed: number;
    verifiedPassRate: number | null;
    averageVerifiedQuality: number | null;
  }>;
  verifierAssertionRows: Array<{
    id: string;
    label: string;
    passed: number;
    failed: number;
    passRate: number | null;
    weight: number | null;
  }>;
  /**
   * Per-model, cross-track SOLO intelligence leaderboard (product goal 1: "most
   * intelligent model"). Sorted best-first with preliminary (<3 attempts) rows
   * demoted. Shape mirrors ModelIntelligenceRow in metrics.ts; kept inline here
   * to avoid a circular type import.
   */
  modelIntelligence: Array<{
    modelId: string;
    displayName: string;
    attempts: number;
    passed: number;
    verifiedPassRate: number | null;
    combinedScore: number;
    trackCount: number;
    preliminary: boolean;
    tracks: Array<{
      track: string;
      attempts: number;
      passed: number;
      verifiedPassRate: number | null;
      averageVerifiedQuality: number;
    }>;
  }>;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function finiteOrNull(value: NullableNumber): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function ratioOrNull(
  numerator: NullableNumber,
  denominator: NullableNumber
): number | null {
  const n = finiteOrNull(numerator);
  const d = finiteOrNull(denominator);
  if (n == null || d == null || d <= 0) return null;
  return n / d;
}

export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
