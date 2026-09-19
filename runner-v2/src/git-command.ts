import type { GitCommandRunner } from "./git-runtime-runner.js";

export type GitCommandErrorCode =
  | "git_unavailable"
  | "command_failed"
  | "output_limit"
  | "policy_refused";

export interface GitCommandOptions {
  cwd: string;
  args: readonly string[];
  env?: Readonly<Record<string, string | undefined>>;
  maxOutputBytes?: number;
  allowFailure?: boolean;
}

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitBinaryCommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
}

export type GitBinaryRunner = (
  options: GitCommandOptions
) => Promise<GitBinaryCommandResult>;

export class GitCommandError extends Error {
  constructor(
    readonly code: GitCommandErrorCode,
    message: string,
    readonly result?: GitCommandResult
  ) {
    super(message);
    this.name = "GitCommandError";
  }
}

/** Compatibility entry points require an explicit Runner-owned capability. */
export async function runGit(options: GitCommandOptions, runner: Pick<GitCommandRunner, "run">): Promise<GitCommandResult> {
  if (!runner || typeof runner.run !== "function") return unavailableGitRunner();
  return await runner.run(options);
}

export async function runGitBytes(options: GitCommandOptions, runner: Pick<GitCommandRunner, "runBytes">): Promise<GitBinaryCommandResult> {
  if (!runner || typeof runner.runBytes !== "function") return unavailableGitRunner();
  return await runner.runBytes(options);
}

/** Missing composition fails before effects; there is deliberately no fallback. */
export async function unavailableGitRunner(): Promise<never> {
  throw new GitCommandError("git_unavailable", "An explicit run-owned Git runner is required.");
}

export function requireGitRunner<T>(runner: T | undefined): T {
  if (!runner) throw new GitCommandError("git_unavailable", "An explicit run-owned Git runner is required.");
  return runner;
}
