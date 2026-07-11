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
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let exceeded = false;
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const capture = (target: "stdout" | "stderr", chunk: string) => {
      if (exceeded) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > maximum) {
        exceeded = true;
        child.kill("SIGTERM");
        return;
      }
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    };
    child.stdout.on("data", (chunk: string) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: string) => capture("stderr", chunk));
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
      const result = { exitCode: exitCode ?? 1, stdout, stderr };
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
      resolve(result);
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
