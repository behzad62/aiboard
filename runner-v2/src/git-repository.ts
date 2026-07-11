import { resolve } from "node:path";

import { runGit, type GitCommandOptions } from "./git-command.js";

export interface RepositoryDirtyState {
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface RepositoryInspection {
  repository: boolean;
  root: string | null;
  headRevision: string | null;
  headRef: string | null;
  dirty: RepositoryDirtyState;
}

export type GitRunner = (
  options: GitCommandOptions
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const clean: RepositoryDirtyState = {
  staged: false,
  unstaged: false,
  untracked: false,
};

export async function inspectRepository(
  path: string,
  execute: GitRunner = runGit
): Promise<RepositoryInspection> {
  const inside = await execute({
    cwd: path,
    args: ["rev-parse", "--is-inside-work-tree"],
    allowFailure: true,
  });
  if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
    return {
      repository: false,
      root: null,
      headRevision: null,
      headRef: null,
      dirty: { ...clean },
    };
  }

  const [root, head, ref, status] = await Promise.all([
    execute({ cwd: path, args: ["rev-parse", "--show-toplevel"] }),
    execute({
      cwd: path,
      args: ["rev-parse", "--verify", "HEAD"],
      allowFailure: true,
    }),
    execute({
      cwd: path,
      args: ["symbolic-ref", "--quiet", "--short", "HEAD"],
      allowFailure: true,
    }),
    execute({
      cwd: path,
      args: ["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
    }),
  ]);

  return {
    repository: true,
    root: resolve(root.stdout.trim()),
    headRevision: head.exitCode === 0 ? head.stdout.trim() : null,
    headRef: ref.exitCode === 0 ? ref.stdout.trim() : null,
    dirty: parseDirtyState(status.stdout),
  };
}

function parseDirtyState(output: string): RepositoryDirtyState {
  const dirty = { ...clean };
  for (const entry of output.split("\0")) {
    if (entry.length < 3) continue;
    const x = entry[0];
    const y = entry[1];
    if (x === "?" && y === "?") {
      dirty.untracked = true;
      continue;
    }
    if (x !== " " && x !== "?") dirty.staged = true;
    if (y !== " " && y !== "?") dirty.unstaged = true;
  }
  return dirty;
}
