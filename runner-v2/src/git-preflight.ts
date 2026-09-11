import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createRunnerInternalProcessKernel,
  type RunnerInternalOwnedProcess,
  type RunnerInternalProcessKernel,
} from "./runner-internal-process-kernel.js";

export type GitPreflightCode = "git_missing" | "git_too_old" | "git_ready";

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitCommandExecutor = (
  command: string,
  args: readonly string[]
) => Promise<GitCommandResult>;

export type GitPreflightResult =
  | {
      available: true;
      version: string;
      code: "git_ready";
      reason: null;
    }
  | {
      available: false;
      version: string | null;
      code: "git_missing" | "git_too_old";
      reason: string;
    };

export interface GitPreflightOptions {
  minimumVersion?: string;
}

export type GitCommandExecutionErrorCode =
  | "git_command_timeout"
  | "git_output_limit_exceeded"
  | "git_command_cleanup_unverified";

export class GitCommandExecutionError extends Error {
  constructor(
    readonly code: GitCommandExecutionErrorCode,
    message: string,
    readonly cleanupVerified: boolean,
  ) {
    super(message);
    this.name = "GitCommandExecutionError";
  }
}

export interface BoundedGitCommandExecutorOptions {
  readonly executionDeadlineMs: number;
  readonly terminationDeadlineMs: number;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly cwd?: string;
  readonly maxOutputBytes?: number;
  readonly platform?: NodeJS.Platform;
  /** Production supplies the one CLI-owned portable internal process kernel. */
  readonly processKernel?: RunnerInternalProcessKernel;
}

const DEFAULT_MINIMUM_VERSION = "2.39.0";
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/** Compatibility helper with explicit closed Runner-owned execution. */
export async function executeGitCommand(command: string, args: readonly string[], execute: GitCommandExecutor): Promise<GitCommandResult> {
  if (typeof execute !== "function") throw new Error("An explicit Runner-owned Git execution context is required.");
  return await execute(command, args);
}

export function createBoundedGitCommandExecutor(
  options: BoundedGitCommandExecutorOptions,
): GitCommandExecutor {
  const executionDeadlineMs = positiveDeadline(
    options.executionDeadlineMs,
    "executionDeadlineMs",
  );
  const terminationDeadlineMs = positiveDeadline(
    options.terminationDeadlineMs,
    "terminationDeadlineMs",
  );
  const maxOutputBytes = positiveDeadline(
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    "maxOutputBytes",
  );
  const environment = Object.freeze(Object.fromEntries(
    Object.entries(options.environment)
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  ));

  return async (command, args) => {
    const ephemeralRoot = options.processKernel
      ? undefined
      : join(tmpdir(), `runner-git-preflight-${randomUUID()}`);
    const processKernel = options.processKernel ?? createRunnerInternalProcessKernel({
      stateDirectory: ephemeralRoot!,
      platform: options.platform ?? process.platform,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let stopping: GitCommandExecutionErrorCode | undefined;
    let wakeStop: (() => void) | undefined;
    const stopRequested = new Promise<void>((resolveStop) => { wakeStop = resolveStop; });
    let owned: Awaited<ReturnType<RunnerInternalProcessKernel["launch"]>> | undefined;
    let cleanupVerified = false;
    try {
      try {
        owned = await processKernel.launch({
          principalId: `git-preflight-${randomUUID()}`,
          callId: `git-command-${randomUUID()}`,
          runId: "runner-git-preflight",
          kind: "command",
          executable: command,
          arguments: args,
          workingDirectory: options.cwd ?? process.cwd(),
          environment,
          access: options.cwd ? [{ canonicalPath: options.cwd, mode: "read" }] : [],
        });
      } catch (error) {
        return {
          exitCode: errorChainCode(error, "ENOENT") ? 127 : 1,
          stdout: "",
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
      owned.setOutputSink((metadata, chunk) => {
        if (stopping) return;
        outputBytes += chunk.byteLength;
        if (outputBytes > maxOutputBytes) {
          stopping = "git_output_limit_exceeded";
          wakeStop?.();
          return;
        }
        (metadata.stream === "stdout" ? stdout : stderr).push(Buffer.from(chunk));
      });
      let deadline: NodeJS.Timeout | undefined;
      const deadlineReached = new Promise<void>((resolveDeadline) => {
        deadline = setTimeout(() => {
          stopping ??= "git_command_timeout";
          resolveDeadline();
        }, executionDeadlineMs);
      });
      const terminalWait = new AbortController();
      const terminal = waitForGitTerminal(owned, terminalWait.signal);
      await Promise.race([terminal, deadlineReached, stopRequested]);
      terminalWait.abort();
      if (deadline) clearTimeout(deadline);
      const disposition = await owned.closeVerified({
        shutdownTimeoutMs: stopping ? 1 : terminationDeadlineMs,
        terminationTimeoutMs: terminationDeadlineMs,
      });
      cleanupVerified = true;
      if (stopping) {
        throw new GitCommandExecutionError(
          stopping,
          stopping === "git_command_timeout"
            ? "Git preflight exceeded its configured execution deadline."
            : "Git preflight output exceeded its configured byte limit.",
          true,
        );
      }
      return {
        exitCode: disposition.exitCode ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
    } catch (error) {
      if (error instanceof GitCommandExecutionError) throw error;
      if (owned && !cleanupVerified) {
        try {
          await owned.closeVerified({
            shutdownTimeoutMs: 1,
            terminationTimeoutMs: terminationDeadlineMs,
          });
          cleanupVerified = true;
      } catch {}
      }
      throw new GitCommandExecutionError(
        "git_command_cleanup_unverified",
        "Git preflight process cleanup could not be verified.",
        cleanupVerified,
      );
    } finally {
      if (ephemeralRoot) {
        try {
          await processKernel.close();
          await rm(ephemeralRoot, { recursive: true, force: true });
        } catch {
          // Exact evidence is intentionally retained when cleanup is uncertain.
        }
      }
    }
  };
}

export async function checkGit(
  execute: GitCommandExecutor,
  options: GitPreflightOptions = {}
): Promise<GitPreflightResult> {
  if (typeof execute !== "function") return missingGit();
  const minimumVersion = options.minimumVersion ?? DEFAULT_MINIMUM_VERSION;
  const result = await execute("git", ["--version"]);
  if (result.exitCode !== 0) return missingGit();

  const match = /^git version\s+([^\s]+)\s*$/im.exec(result.stdout);
  if (!match) return missingGit();
  const version = match[1];
  if (compareVersions(version, minimumVersion) < 0) {
    return {
      available: false,
      version,
      code: "git_too_old",
      reason: `Git ${minimumVersion} or newer is required for Build V2.`,
    };
  }
  return { available: true, version, code: "git_ready", reason: null };
}

function missingGit(): GitPreflightResult {
  return {
    available: false,
    version: null,
    code: "git_missing",
    reason: "Git is required for Build V2.",
  };
}

function compareVersions(left: string, right: string): number {
  const leftParts = numericVersion(left);
  const rightParts = numericVersion(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function numericVersion(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

async function waitForGitTerminal(
  owned: RunnerInternalOwnedProcess,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    if ((await owned.reconcile()).state === "exited") return;
    await new Promise<void>((resolveWait) => {
      const onAbort = () => {
        clearTimeout(timeout);
        resolveWait();
      };
      const timeout = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolveWait();
      }, 25);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function errorChainCode(error: unknown, code: string, seen = new Set<unknown>()): boolean {
  if (seen.has(error)) return false;
  seen.add(error);
  if ((error as NodeJS.ErrnoException | undefined)?.code === code) return true;
  if (error instanceof AggregateError) {
    return error.errors.some((nested) => errorChainCode(nested, code, seen));
  }
  return error instanceof Error && error.cause !== undefined
    ? errorChainCode(error.cause, code, seen)
    : false;
}

function positiveDeadline(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) {
    throw new Error(`Git ${label} is invalid.`);
  }
  return value;
}
