import type {
  WorkBenchRunCommandResult,
  WorkBenchRunVerifierResult,
  WorkBenchRunnerConfig,
} from "@/lib/benchmark/workbench/types";

export const DEFAULT_BENCH_RUNNER_URL = "http://127.0.0.1:8797";

export type BenchRunnerConfig = WorkBenchRunnerConfig;

export interface BenchRunnerHealth {
  ok: boolean;
  version?: number;
  host?: string;
  root?: string;
  mcp?: boolean;
  error?: string;
  runnerV2?: {
    ready: boolean;
    source?: string;
    nodeVersion?: string;
    error?: string;
  };
}

export interface ManagedAttemptRunnerResult {
  attemptId: string;
  running: boolean;
  url?: string;
  token?: string;
  projectPath: string;
  statePath: string;
  pid?: number | null;
  nodeVersion?: string;
}

export interface RestoreAttemptOracleResult {
  attemptId: string;
  restored: boolean;
}

export interface PrepareBenchCaseInput {
  attemptId?: string;
  caseId: string;
  repoUrl: string;
  baseCommit: string;
  setupCommand?: string;
  network?: "none" | "dependency-only";
  timeoutSeconds?: number;
  verifierCommand?: string;
  verifierResultFile?: string;
  allowedCommands?: string[];
  files?: Record<string, string>;
}

export interface PrepareBenchCaseResult {
  attemptId: string;
  caseId: string;
  root?: string;
}

export interface BenchAttemptInput {
  attemptId: string;
}

export interface BenchFileInput extends BenchAttemptInput {
  path: string;
}

export interface BenchWriteFileInput extends BenchFileInput {
  content: string;
}

export interface BenchPatchFileInput extends BenchFileInput {
  search: string;
  replace: string;
}

export interface BenchRunCommandInput extends BenchAttemptInput {
  command: string;
  timeoutSeconds?: number;
}

export interface BenchRunVerifierInput extends BenchAttemptInput {
  command?: string;
  timeoutSeconds?: number;
}

export interface BenchTreeResult {
  files: string[];
}

export interface BenchReadFileResult {
  content: string;
  bytes: number;
}

export interface BenchWriteFileResult {
  bytes: number;
}

export interface BenchPatchFileResult {
  applied: number;
  bytes: number;
  content: string;
}

export interface BenchDiffResult {
  diff: string;
}

export interface BenchArtifactResult {
  path: string;
  content: string;
  mimeType: string;
  bytes: number;
}

export interface BenchCleanupResult {
  removed: boolean;
}

export async function checkBenchRunner(
  config: BenchRunnerConfig
): Promise<BenchRunnerHealth> {
  try {
    return await requestJson<BenchRunnerHealth>(config, "/bench/health");
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function prepareBenchCase(
  config: BenchRunnerConfig,
  input: PrepareBenchCaseInput
): Promise<PrepareBenchCaseResult> {
  return requestJson(config, "/bench/prepare", input);
}

export function startManagedAttemptRunner(
  config: BenchRunnerConfig,
  input: BenchAttemptInput
): Promise<ManagedAttemptRunnerResult> {
  return requestJson(config, "/bench/attempt-runner/start", input);
}

export function getManagedAttemptRunner(
  config: BenchRunnerConfig,
  input: BenchAttemptInput
): Promise<ManagedAttemptRunnerResult> {
  return requestJson(config, "/bench/attempt-runner/status", input);
}

export function restoreManagedAttemptOracle(
  config: BenchRunnerConfig,
  input: BenchAttemptInput
): Promise<RestoreAttemptOracleResult> {
  return requestJson(config, "/bench/attempt-runner/restore-oracle", input);
}

export function stopManagedAttemptRunner(
  config: BenchRunnerConfig,
  input: BenchAttemptInput
): Promise<ManagedAttemptRunnerResult> {
  return requestJson(config, "/bench/attempt-runner/stop", input);
}

export function readBenchTree(
  config: BenchRunnerConfig,
  input: BenchAttemptInput
): Promise<BenchTreeResult> {
  return requestJson(config, "/bench/read-tree", input);
}

export function readBenchFile(
  config: BenchRunnerConfig,
  input: BenchFileInput
): Promise<BenchReadFileResult> {
  return requestJson(config, "/bench/read-file", input);
}

export function writeBenchFile(
  config: BenchRunnerConfig,
  input: BenchWriteFileInput
): Promise<BenchWriteFileResult> {
  return requestJson(config, "/bench/write-file", input);
}

export function patchBenchFile(
  config: BenchRunnerConfig,
  input: BenchPatchFileInput
): Promise<BenchPatchFileResult> {
  return requestJson(config, "/bench/patch-file", input);
}

export function runBenchCommand(
  config: BenchRunnerConfig,
  input: BenchRunCommandInput
): Promise<WorkBenchRunCommandResult> {
  return requestJson(config, "/bench/run-command", input);
}

export function runBenchVerifier(
  config: BenchRunnerConfig,
  input: BenchRunVerifierInput
): Promise<WorkBenchRunVerifierResult> {
  return requestJson(config, "/bench/run-verifier", input);
}

export function getBenchDiff(
  config: BenchRunnerConfig,
  input: BenchAttemptInput
): Promise<BenchDiffResult> {
  return requestJson(config, "/bench/diff", input);
}

export function getBenchArtifact(
  config: BenchRunnerConfig,
  input: BenchFileInput
): Promise<BenchArtifactResult> {
  return requestJson(config, "/bench/artifact", input);
}

export function cleanupBenchRun(
  config: BenchRunnerConfig,
  input: BenchAttemptInput
): Promise<BenchCleanupResult> {
  return requestJson(config, "/bench/cleanup", input);
}

function runnerUrl(config: BenchRunnerConfig, path: string): string {
  return `${config.url.replace(/\/$/, "")}${path}`;
}

function headers(token: string): HeadersInit {
  return {
    "content-type": "application/json",
    "x-runner-token": token,
  };
}

async function requestJson<T>(
  config: BenchRunnerConfig,
  path: string,
  body?: unknown
): Promise<T> {
  const response = await fetch(runnerUrl(config, path), {
    method: body === undefined ? "GET" : "POST",
    headers: headers(config.token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(data.error ?? `Bench runner request failed (HTTP ${response.status})`);
  }
  return data as T;
}
