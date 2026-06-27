import type {
  BenchmarkArtifact,
  BenchmarkAttemptV2,
  BenchmarkVerifierResult,
  CertifiedAttemptStatus,
} from "@/lib/benchmark/types";
import type { WorkBenchScore } from "@/lib/benchmark/scoring/types";

export type WorkBenchDifficulty = "easy" | "medium" | "hard" | "expert";
export type WorkBenchNetwork = "none" | "dependency-only";

export interface WorkBenchPrompt {
  userRequest: string;
  publicContext?: string;
  hiddenNotesHash?: string;
  systemPromptHash?: string;
  attachmentIds?: string[];
}

export interface WorkBenchRepo {
  url: string;
  baseCommit: string;
  shallowClone: boolean;
  fixtureHash?: string;
}

export interface WorkBenchEnvironment {
  type: "local-runner";
  setupCommand?: string;
  timeoutSeconds: number;
  memoryMb?: number;
  network: WorkBenchNetwork;
}

export interface WorkBenchVerifier {
  command: string;
  resultFile?: string;
  publicCommand?: string;
  hiddenCommandHash?: string;
  timeoutSeconds?: number;
}

export interface WorkBenchBudget {
  maxUsd?: number;
  maxWallClockSeconds?: number;
  maxModelCalls?: number;
  maxToolCalls?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface WorkBenchScoring {
  scoringVersion: string;
  costTargetUsd?: number;
  timeTargetSeconds?: number;
}

export interface WorkBenchContamination {
  originalTask: boolean;
  canary: string;
  referenceSolutionPrivate: boolean;
  publicAfter?: string;
}

export interface WorkBenchCase {
  schemaVersion: 1;
  id: string;
  title: string;
  description: string;
  difficulty: WorkBenchDifficulty;
  tags: string[];
  caseVersion: string;
  prompt: WorkBenchPrompt;
  repo: WorkBenchRepo;
  environment: WorkBenchEnvironment;
  verifier: WorkBenchVerifier;
  budget: WorkBenchBudget;
  scoring: WorkBenchScoring;
  contamination: WorkBenchContamination;
  allowedCommands: string[];
}

export interface WorkBenchVerifierAssertionInput {
  id?: unknown;
  label?: unknown;
  passed?: unknown;
  weight?: unknown;
  message?: unknown;
}

export interface WorkBenchVerifierAssertion {
  id: string;
  label: string;
  passed: boolean;
  weight: number;
  message?: string;
}

export interface ParsedWorkBenchVerifierResult {
  passed: boolean;
  score: number;
  summary: string;
  assertions: WorkBenchVerifierAssertion[];
  rawJson: string;
}

export interface WorkBenchRunnerConfig {
  url: string;
  token: string;
}

export interface WorkBenchRunCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

export interface WorkBenchRunVerifierResult {
  passed: boolean;
  score: number;
  durationMs: number;
  exitCode: number;
  stdoutPreview: string;
  stderrPreview: string;
  resultJson: string;
  artifactIds: string[];
}

export interface WorkBenchBuildExecutionInput {
  case: WorkBenchCase;
  runner: WorkBenchRunnerConfig;
  attemptId: string;
  runId: string;
  teamCompositionId: string;
  harnessProfile: BenchmarkAttemptV2["harnessProfile"];
  allowedCommands: string[];
}

export interface WorkBenchBuildExecutionResult {
  traceIds: string[];
  artifactIds?: string[];
  costUsd?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  modelCalls: number;
  toolCalls?: number;
  validToolCalls?: number;
  durationMs?: number;
}

export interface WorkBenchExecutionInput {
  case: WorkBenchCase;
  runner: WorkBenchRunnerConfig;
  attemptId: string;
  runId: string;
  teamCompositionId: string;
  harnessProfile?: BenchmarkAttemptV2["harnessProfile"];
  runBuild?: (
    input: WorkBenchBuildExecutionInput
  ) => Promise<WorkBenchBuildExecutionResult>;
  costUsd?: number | null;
  inputTokens?: number;
  outputTokens?: number;
  modelCalls?: number;
  toolCalls?: number;
  validToolCalls?: number;
  cleanup?: boolean;
}

export interface WorkBenchExecutionResult {
  attempt: BenchmarkAttemptV2;
  verifierResult: BenchmarkVerifierResult;
  parsedVerifierResult: ParsedWorkBenchVerifierResult;
  score: WorkBenchScore;
  artifacts: BenchmarkArtifact[];
}

export type WorkBenchVerifierFailureClass = CertifiedAttemptStatus;
