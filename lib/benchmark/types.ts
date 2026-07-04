import type {
  BuildCheckpoint,
  BuildProblemCode,
  BuildProblemSeverity,
  BuildProblemSource,
  GenericGameMatchRecord,
  GameId,
  GameParticipant,
  ModelBuildStat,
  ReasoningEffort,
} from "@/lib/db/schema";

export type BenchmarkDomain = "game" | "build" | "model-call";
export type BenchmarkCaseKind =
  | "game-match"
  | "build-run"
  | "fixed-pack"
  | "real-work";
export type BenchmarkRunStatus =
  | "planned"
  | "running"
  | "completed"
  | "stopped"
  | "failed";
export type BenchmarkAttemptStatus =
  | "completed"
  | "failed"
  | "fallback"
  | "aborted";
export type BenchmarkArtifactKind =
  | "json"
  | "markdown"
  | "patch"
  | "transcript"
  | "raw-response"
  | "screenshot"
  | "log";
export type BenchmarkMetricDirection = "higher" | "lower" | "neutral";

export type BenchmarkTrack =
  | "workbench"
  | "gameiq"
  | "teamiq"
  | "toolreliability"
  | "harnessbench";
export type BenchmarkMode =
  | "lab"
  | "certified"
  | "publish";
export type HarnessProfile =
  | "raw-single-model"
  | "aiboard-single-model"
  | "aiboard-panel"
  | "aiboard-debate"
  | "aiboard-specialist"
  | "aiboard-build-single-worker"
  | "aiboard-build-multi-worker"
  | "external-mini-swe-agent"
  | "external-custom";
export type CertifiedAttemptStatus =
  | "passed"
  | "failed_model"
  | "failed_verifier"
  | "failed_tool_use"
  | "failed_budget"
  | "provider_unavailable"
  | "invalid_harness"
  | "invalid_environment"
  | "invalid_case"
  | "aborted_user";

export interface BenchmarkSuite {
  id: string;
  name: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  caseIds: string[];
  modelIds: string[];
  configJson: string;
}

export interface BenchmarkRun {
  id: string;
  suiteId?: string;
  name: string;
  domain: BenchmarkDomain;
  status: BenchmarkRunStatus;
  startedAt: string;
  completedAt?: string;
  source: "manual" | "game" | "build" | "import";
  modelIds: string[];
  caseIds: string[];
  summaryJson: string;
  metricValueIds: string[];
  artifactIds: string[];
  failureIds: string[];
}

export interface BenchmarkCase {
  id: string;
  kind: BenchmarkCaseKind;
  domain: BenchmarkDomain;
  title: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
  gameId?: GameId;
  discussionId?: string;
  sourceId?: string;
  promptHash?: string;
  verifierCommand?: string;
  tags: string[];
  configJson: string;
  expectedJson?: string;
}

export interface BenchmarkCaseV2 {
  id: string;
  schemaVersion: 2;
  track: BenchmarkTrack;
  title: string;
  description: string;
  difficulty: "easy" | "medium" | "hard" | "expert";
  tags: string[];
  caseVersion: string;
  createdAt: string;
  updatedAt: string;
  prompt: {
    userRequest: string;
    publicContext?: string;
    hiddenNotesHash?: string;
    systemPromptHash?: string;
    attachmentIds?: string[];
  };
  repo?: {
    url: string;
    baseCommit: string;
    shallowClone: boolean;
    fixtureHash?: string;
  };
  environment: {
    type: "browser" | "local-runner" | "docker" | "modal" | "github-actions";
    image?: string;
    imageDigest?: string;
    setupCommand?: string;
    timeoutSeconds: number;
    /** Advisory only - bench-runner v0.1 does NOT enforce a memory cap. */
    memoryMb?: number;
    network: "none" | "dependency-only" | "open";
  };
  verifier: {
    command?: string;
    resultFile?: string;
    publicCommand?: string;
    hiddenCommandHash?: string;
    timeoutSeconds?: number;
    scorer: "verifier-json" | "game-engine" | "rule-checker";
  };
  budget: {
    maxUsd?: number;
    maxWallClockSeconds?: number;
    maxModelCalls?: number;
    maxToolCalls?: number;
    maxInputTokens?: number;
    maxOutputTokens?: number;
  };
  scoring: {
    scoringVersion: string;
    primary:
      | "verified_quality"
      | "game_iq"
      | "team_lift"
      | "tool_reliability";
    costTargetUsd?: number;
    timeTargetSeconds?: number;
  };
  contamination: {
    originalTask: boolean;
    canary: string;
    referenceSolutionPrivate: boolean;
    publicAfter?: string;
  };
}

export interface BenchmarkTeamCompositionRole {
  role:
    | "single"
    | "architect"
    | "worker"
    | "reviewer"
    | "critic"
    | "judge"
    | "player"
    | "specialist";
  slot: string;
  modelId: string;
  providerId: string;
  displayName: string;
  reasoningEffort?: ReasoningEffort | string;
  temperature: number;
  maxTokens?: number;
}

export type TeamIqStrategy =
  | "solo"
  | "panel"
  | "debate"
  | "architect_worker"
  | "architect_worker_reviewer"
  | "cheap_swarm_strong_judge";

export interface BenchmarkTeamComposition {
  id: string;
  name: string;
  comboHash: string;
  roles: BenchmarkTeamCompositionRole[];
  strategy?: TeamIqStrategy;
}

export interface BenchmarkVerifierAssertionResult {
  id: string;
  label: string;
  passed: boolean;
  weight: number;
  message?: string;
  details?: string;
}

export interface BenchmarkVerifierResult {
  id: string;
  attemptId: string;
  caseId: string;
  command?: string;
  passed: boolean;
  score: number;
  durationMs: number;
  exitCode?: number;
  stdoutPreview?: string;
  stderrPreview?: string;
  resultJson: string;
  assertionResults: BenchmarkVerifierAssertionResult[];
  artifactIds: string[];
}

export interface BenchmarkAttemptV2 {
  id: string;
  runId: string;
  caseId: string;
  teamCompositionId: string;
  mode: BenchmarkMode;
  track: BenchmarkTrack;
  harnessProfile: HarnessProfile;
  status: CertifiedAttemptStatus;
  startedAt: string;
  completedAt?: string;
  verifiedQuality: number;
  jobSuccessScore: number;
  efficiencyScore: number;
  gameIqScore?: number;
  teamLift?: number;
  toolReliabilityScore?: number;
  costUsd: number | null;
  inputTokens: number;
  outputTokens: number;
  /**
   * Whether inputTokens/outputTokens are the provider's REAL billed counts
   * ("reported") or the chars/4 fallback estimate ("estimated"). Additive and
   * optional so existing records without it are treated as legacy estimates.
   */
  usageSource?: "reported" | "estimated";
  modelCalls: number;
  toolCalls: number;
  durationMs: number;
  verifierResultId?: string;
  artifactIds: string[];
  traceIds: string[];
  failureIds: string[];
  harnessVersion: string;
  promptSetVersion: string;
  scoringVersion: string;
}

export type BenchmarkRunEventType =
  | "model_call_started"
  | "model_call_completed"
  | "model_call_failed"
  | "tool_call_started"
  | "tool_call_completed"
  | "tool_call_blocked"
  | "verifier_started"
  | "verifier_completed"
  | "run_blocked"
  | "run_failed";

export interface BenchmarkRunEvent {
  id: string;
  attemptId: string;
  caseId: string;
  type: BenchmarkRunEventType;
  phase: string;
  at: string;
  message: string;
  modelId?: string;
  providerId?: string;
  detailsJson?: string;
}

export interface BenchmarkToolCallTrace {
  id: string;
  attemptId: string;
  caseId: string;
  toolName: string;
  command?: string;
  status: "ok" | "failed" | "blocked" | "denied";
  exitCode?: number;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  inputJson?: string;
  outputPreview?: string;
  error?: string;
}

export interface HarnessCertificationCheck {
  id: string;
  label: string;
  passed: boolean;
  message?: string;
  detailsJson?: string;
}

export interface HarnessCertificationResult {
  id: string;
  createdAt: string;
  aiboardVersion: string;
  benchmarkEngineVersion: string;
  harnessProfile: HarnessProfile;
  harnessVersion: string;
  promptSetVersion: string;
  passed: boolean;
  checks: HarnessCertificationCheck[];
  artifactIds?: string[];
}

export interface BenchmarkAttempt {
  id: string;
  runId?: string;
  caseId?: string;
  modelId?: string;
  participantId?: string;
  status: BenchmarkAttemptStatus;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedUsd?: number | null;
  resultJson: string;
  traceIds: string[];
  artifactIds: string[];
  failureIds: string[];
}

export interface BenchmarkMetricValue {
  id: string;
  runId?: string;
  caseId?: string;
  attemptId?: string;
  modelId?: string;
  domain: BenchmarkDomain;
  key: string;
  label: string;
  value: number;
  unit?: string;
  sampleSize?: number;
  direction: BenchmarkMetricDirection;
  detailsJson?: string;
}

export interface BenchmarkArtifact {
  id: string;
  runId?: string;
  caseId?: string;
  attemptId?: string;
  kind: BenchmarkArtifactKind;
  label: string;
  mimeType: string;
  content: string;
  createdAt: string;
}

export interface BenchmarkFailure {
  id: string;
  runId?: string;
  caseId?: string;
  attemptId?: string;
  modelId?: string;
  domain: BenchmarkDomain;
  source: BuildProblemSource | "provider" | "parser" | "rules" | "benchmark";
  code: BuildProblemCode | string;
  severity: BuildProblemSeverity;
  message: string;
  details?: string;
  createdAt: string;
}

export interface BenchmarkModelCallTraceAttempt {
  attempt: number;
  status: "parsed" | "parse_error" | "illegal" | "provider_error";
  message: string;
  rawResponse?: string;
  parsedJson?: string;
  latencyMs?: number;
}

export interface BenchmarkModelCallTrace {
  id: string;
  runId?: string;
  caseId?: string;
  attemptId?: string;
  // The GameIQ scenario id this call answered. Lets trace consumers map by
  // id instead of positional order — required once retries/concurrency
  // produce out-of-order or multiple traces per scenario.
  scenarioId?: string;
  modelId: string;
  providerId: string;
  participantId?: string;
  reasoningEffort?: ReasoningEffort | string;
  schemaMode?: "structured" | "json-instructions" | "text";
  promptHash?: string;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  /** "reported" when the provider returned full real usage; "partial" for mixed provider+estimate; "estimated" for chars/4 fallback. */
  usageSource?: "reported" | "partial" | "estimated";
  reasoningTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
  providerCost?: number;
  providerCostUnit?: "usd" | "credits" | "unknown";
  estimatedUsd?: number | null;
  rawResponse?: string;
  parsedResponseJson?: string;
  retryHistory: BenchmarkModelCallTraceAttempt[];
  fallbackReason?: string;
  error?: string;
}

export interface BenchmarkReportBundleBase {
  exportedAt: string;
  suites: BenchmarkSuite[];
  runs: BenchmarkRun[];
  cases: BenchmarkCase[];
  attempts: BenchmarkAttempt[];
  metricValues: BenchmarkMetricValue[];
  artifacts: BenchmarkArtifact[];
  failures: BenchmarkFailure[];
  traces: BenchmarkModelCallTrace[];
  sourceEvidence?: {
    gameMatches: GenericGameMatchRecord[];
    buildCheckpoints: BuildCheckpoint[];
    buildStats: ModelBuildStat[];
  };
}

export interface BenchmarkReportBundleV2
  extends BenchmarkReportBundleBase {
  version: 2;
  caseV2: BenchmarkCaseV2[];
  attemptsV2: BenchmarkAttemptV2[];
  verifierResults: BenchmarkVerifierResult[];
  runEvents: BenchmarkRunEvent[];
  toolCallTraces: BenchmarkToolCallTrace[];
  teamCompositions: BenchmarkTeamComposition[];
  harnessCertifications: HarnessCertificationResult[];
  bundleHash?: string;
  redactionSummary?: {
    scannedArtifacts: number;
    scannedRecords?: number;
    redactedSecrets: number;
    warnings: string[];
  };
}

export interface BenchmarkParticipantResult extends GameParticipant {
  games: number;
  wins: number;
  losses: number;
  draws: number;
  completions: number;
  legalActions: number;
  invalidActions: number;
  schemaValid: number;
  schemaInvalid: number;
  fallbackActions: number;
  providerErrors: number;
  latencyMs: number;
  latencySamples: number;
  estimatedUsd: number;
  costSamples: number;
  verifierPasses: number;
  verifierFailures: number;
  toolValid: number;
  toolInvalid: number;
}
