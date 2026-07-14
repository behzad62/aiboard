import { spawn } from "node:child_process";

export type GitCommandErrorCode =
  | "git_unavailable"
  | "command_failed"
  | "output_limit";

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

export async function runGit(
  options: GitCommandOptions
): Promise<GitCommandResult> {
  const result = await runGitRaw(options);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
  };
}

export async function runGitBytes(
  options: GitCommandOptions
): Promise<GitBinaryCommandResult> {
  const result = await runGitRaw(options);
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr.toString("utf8"),
  };
}

interface RawGitCommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

async function runGitRaw(
  options: GitCommandOptions
): Promise<RawGitCommandResult> {
  const maximum = options.maxOutputBytes ?? 4 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1) {
    throw new Error("maxOutputBytes must be a positive integer.");
  }

  return await new Promise((resolve, reject) => {
    const child = spawn("git", [...options.args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let exceeded = false;
    let settled = false;

    const capture = (target: Buffer[], chunk: Buffer) => {
      if (exceeded) return;
      outputBytes += chunk.length;
      if (outputBytes > maximum) {
        exceeded = true;
        child.kill("SIGTERM");
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      reject(
        new GitCommandError(
          "git_unavailable",
          error.code === "ENOENT" ? "Git executable was not found." : error.message
        )
      );
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      const rawResult = {
        exitCode: exitCode ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      const result = {
        exitCode: rawResult.exitCode,
        stdout: rawResult.stdout.toString("utf8"),
        stderr: rawResult.stderr.toString("utf8"),
      };
      if (exceeded) {
        reject(
          new GitCommandError(
            "output_limit",
            `Git output exceeded ${maximum} bytes.`,
            result
          )
        );
        return;
      }
      if (result.exitCode !== 0 && !options.allowFailure) {
        reject(
          new GitCommandError(
            "command_failed",
            describeFailure(options.args, result),
            result
          )
        );
        return;
      }
      resolve(rawResult);
    });
  });
}

function describeFailure(
  args: readonly string[],
  result: GitCommandResult
): string {
  const detail = result.stderr.trim() || result.stdout.trim() || "no output";
  return `git ${args.join(" ")} failed with exit code ${result.exitCode}: ${detail}`;
}
