import type {
  WorkBenchRunCommandResult,
  WorkBenchRunVerifierResult,
  WorkBenchRunnerConfig,
  WorkBenchCase,
} from "@/lib/benchmark/workbench/types";
import type { WorkBenchTrustedPolicy } from "@/lib/benchmark/workbench/types";

export const DEFAULT_BENCH_RUNNER_URL = "http://127.0.0.1:8797";

export type BenchRunnerConfig = WorkBenchRunnerConfig;

export class BenchRunnerRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly disposition?: string;

  constructor(message: string, status: number, code?: string, disposition?: string) {
    super(message);
    this.name = "BenchRunnerRequestError";
    this.status = status;
    this.code = code;
    this.disposition = disposition;
  }
}

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
  rjs?: {
    ready: boolean;
    nodeVersion?: string;
    quickjsVersion?: string;
    contractHash?: string;
    suiteHash?: string;
    profile?: string;
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
  trustedPolicy?: WorkBenchTrustedPolicy;
}

export function getTrustedBenchRunnerReadiness(
  health: BenchRunnerHealth | null,
  workBenchCase?: WorkBenchCase | null
): { ready: boolean; error?: string } {
  if (!health?.ok) {
    return { ready: false, error: health?.error ?? "Bench Runner is not ready." };
  }
  if (!health.runnerV2?.ready) {
    return {
      ready: false,
      error:
        health.runnerV2?.error ??
        "Managed Runner V2 is unavailable; configure --runner-v2-dir.",
    };
  }
  const policy = workBenchCase?.trustedPolicy;
  if (!policy) return { ready: true };

  const trusted = health.rjs;
  if (!trusted?.ready) {
    return {
      ready: false,
      error: trusted?.error ?? "Recoverable Job Service trusted runtime is unavailable.",
    };
  }
  if (trusted.nodeVersion !== policy.requiredNodeVersion) {
    return {
      ready: false,
      error: `Recoverable Job Service requires Bench Runner Node ${policy.requiredNodeVersion}.`,
    };
  }
  if (trusted.quickjsVersion !== policy.requiredQuickJsVersion) {
    return {
      ready: false,
      error: `Recoverable Job Service requires QuickJS ${policy.requiredQuickJsVersion}.`,
    };
  }
  if (trusted.contractHash !== policy.contractHash) {
    return { ready: false, error: "Recoverable Job Service contract identity does not match the selected case." };
  }
  if (trusted.suiteHash !== policy.suiteHash) {
    return { ready: false, error: "Recoverable Job Service suite identity does not match the selected case." };
  }
  const expectedProfile = readFixtureProfile(workBenchCase.fixtureFiles?.["case-meta.json"]);
  if (!expectedProfile || trusted.profile !== expectedProfile) {
    return { ready: false, error: "Recoverable Job Service profile identity does not match the selected case." };
  }
  return { ready: true };
}

function readFixtureProfile(caseMetadata: string | undefined): string | null {
  if (typeof caseMetadata !== "string") return null;
  try {
    const value = JSON.parse(caseMetadata) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) &&
      typeof (value as { profile?: unknown }).profile === "string"
      ? (value as { profile: string }).profile
      : null;
  } catch {
    return null;
  }
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
  config: BenchRunnerConfig,
  signal?: AbortSignal
): Promise<BenchRunnerHealth> {
  try {
    return await requestJson<BenchRunnerHealth>(config, "/bench/health", undefined, signal);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function prepareBenchCase(
  config: BenchRunnerConfig,
  input: PrepareBenchCaseInput,
  signal?: AbortSignal
): Promise<PrepareBenchCaseResult> {
  return requestJson(config, "/bench/prepare", input, signal);
}

export function startManagedAttemptRunner(
  config: BenchRunnerConfig,
  input: BenchAttemptInput,
  signal?: AbortSignal
): Promise<ManagedAttemptRunnerResult> {
  return requestJson(config, "/bench/attempt-runner/start", input, signal);
}

export function getManagedAttemptRunner(
  config: BenchRunnerConfig,
  input: BenchAttemptInput,
  signal?: AbortSignal
): Promise<ManagedAttemptRunnerResult> {
  return requestJson(config, "/bench/attempt-runner/status", input, signal);
}

export function restoreManagedAttemptOracle(
  config: BenchRunnerConfig,
  input: BenchAttemptInput,
  signal?: AbortSignal
): Promise<RestoreAttemptOracleResult> {
  return requestJson(config, "/bench/attempt-runner/restore-oracle", input, signal);
}

export function stopManagedAttemptRunner(
  config: BenchRunnerConfig,
  input: BenchAttemptInput,
  signal?: AbortSignal
): Promise<ManagedAttemptRunnerResult> {
  return requestJson(config, "/bench/attempt-runner/stop", input, signal);
}

export function readBenchTree(
  config: BenchRunnerConfig,
  input: BenchAttemptInput,
  signal?: AbortSignal
): Promise<BenchTreeResult> {
  return requestJson(config, "/bench/read-tree", input, signal);
}

export function readBenchFile(
  config: BenchRunnerConfig,
  input: BenchFileInput,
  signal?: AbortSignal
): Promise<BenchReadFileResult> {
  return requestJson(config, "/bench/read-file", input, signal);
}

export function writeBenchFile(
  config: BenchRunnerConfig,
  input: BenchWriteFileInput,
  signal?: AbortSignal
): Promise<BenchWriteFileResult> {
  return requestJson(config, "/bench/write-file", input, signal);
}

export function patchBenchFile(
  config: BenchRunnerConfig,
  input: BenchPatchFileInput,
  signal?: AbortSignal
): Promise<BenchPatchFileResult> {
  return requestJson(config, "/bench/patch-file", input, signal);
}

export function runBenchCommand(
  config: BenchRunnerConfig,
  input: BenchRunCommandInput,
  signal?: AbortSignal
): Promise<WorkBenchRunCommandResult> {
  return requestJson(config, "/bench/run-command", input, signal);
}

export function runBenchVerifier(
  config: BenchRunnerConfig,
  input: BenchRunVerifierInput,
  signal?: AbortSignal
): Promise<WorkBenchRunVerifierResult> {
  return requestJson(config, "/bench/run-verifier", input, signal);
}

export function getBenchDiff(
  config: BenchRunnerConfig,
  input: BenchAttemptInput,
  signal?: AbortSignal
): Promise<BenchDiffResult> {
  return requestJson(config, "/bench/diff", input, signal);
}

export function getBenchArtifact(
  config: BenchRunnerConfig,
  input: BenchFileInput,
  signal?: AbortSignal
): Promise<BenchArtifactResult> {
  return requestJson(config, "/bench/artifact", input, signal);
}

export function cleanupBenchRun(
  config: BenchRunnerConfig,
  input: BenchAttemptInput,
  signal?: AbortSignal
): Promise<BenchCleanupResult> {
  return requestJson(config, "/bench/cleanup", input, signal);
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
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const response = await fetch(runnerUrl(config, path), {
    method: body === undefined ? "GET" : "POST",
    headers: headers(config.token),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
    disposition?: string;
  };
  if (!response.ok) {
    throw new BenchRunnerRequestError(
      data.error ?? `Bench runner request failed (HTTP ${response.status})`,
      response.status,
      typeof data.code === "string" ? data.code : undefined,
      typeof data.disposition === "string" ? data.disposition : undefined
    );
  }
  return data as T;
}
