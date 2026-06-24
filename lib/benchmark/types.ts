import type {
  BuildProblemCode,
  BuildProblemSeverity,
  BuildProblemSource,
  GameId,
  GameParticipant,
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
  | "transcript"
  | "raw-response"
  | "screenshot"
  | "log";
export type BenchmarkMetricDirection = "higher" | "lower" | "neutral";

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
  estimatedUsd?: number | null;
  rawResponse?: string;
  parsedResponseJson?: string;
  retryHistory: BenchmarkModelCallTraceAttempt[];
  fallbackReason?: string;
  error?: string;
}

export interface BenchmarkReportBundle {
  version: 1;
  exportedAt: string;
  suites: BenchmarkSuite[];
  runs: BenchmarkRun[];
  cases: BenchmarkCase[];
  attempts: BenchmarkAttempt[];
  metricValues: BenchmarkMetricValue[];
  artifacts: BenchmarkArtifact[];
  failures: BenchmarkFailure[];
  traces: BenchmarkModelCallTrace[];
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
