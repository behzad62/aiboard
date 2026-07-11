import { spawn } from "node:child_process";

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

const DEFAULT_MINIMUM_VERSION = "2.39.0";

export async function executeGitCommand(
  command: string,
  args: readonly string[]
): Promise<GitCommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(command, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error: NodeJS.ErrnoException) => {
      resolve({
        exitCode: error.code === "ENOENT" ? 127 : 1,
        stdout,
        stderr: stderr || error.message,
      });
    });
    child.once("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

export async function checkGit(
  execute: GitCommandExecutor = executeGitCommand,
  options: GitPreflightOptions = {}
): Promise<GitPreflightResult> {
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
