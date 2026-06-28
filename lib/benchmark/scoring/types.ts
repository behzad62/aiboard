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
  toolReliability: number;
}

export interface GameIqScoreInput {
  outcomeScore: number;
  moveQuality: number;
  legalActionRate: number;
  structuredReliability: number;
  fallbackRate: number;
  latencyFactor: number;
}

export interface ToolReliabilityScoreInput {
  schemaValidRate: number;
  firstAttemptValidRate: number;
  repairSuccessRate: number;
  toolValidRate: number;
  patchSuccessRate: number;
  commandSafetyRate: number;
  forbiddenActionRate: number;
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
  tracks: string[];
  attempts: number;
  cases: number;
  passed: number;
  failed: number;
  verifiedPassRate: number | null;
  verifiedQuality: number;
  jobSuccessScore: number;
  efficiencyScore: number;
  toolReliabilityScore: number | null;
  costUsd: number | null;
  averageCostUsd: number | null;
  durationMs: number | null;
  costPerPass: number | null;
  speedPerPassMs: number | null;
  bestSoloScore: number | null;
  teamLift: number | null;
  teamLiftLabel: TeamLiftLabel | null;
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
  efficiencyLeaderboard: CertifiedRunScore[];
  costPerPassLeaderboard: CertifiedRunScore[];
  speedPerPassLeaderboard: CertifiedRunScore[];
  teamLiftLeaderboard: CertifiedRunScore[];
  toolReliabilityLeaderboard: CertifiedRunScore[];
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
