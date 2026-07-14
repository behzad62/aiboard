import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { runGit, type GitCommandOptions } from "./git-command.js";
import type { GitRunner } from "./git-repository.js";

const RUNNER_IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "AIBoard Worker",
  GIT_AUTHOR_EMAIL: "worker@aiboard.local",
  GIT_COMMITTER_NAME: "AIBoard Worker",
  GIT_COMMITTER_EMAIL: "worker@aiboard.local",
};

export interface WorkspaceManagerOptions {
  repositoryRoot: string;
  stateDirectory: string;
  runId: string;
  baselineRevision: string;
  execute?: GitRunner;
}

export interface TaskWorkspace {
  runId: string;
  taskId: string;
  workspaceId: string;
  path: string;
  branch: string;
  baselineRevision: string;
}

export interface TaskWorkspaceOptions {
  workspaceId?: string;
  baselineRevision?: string;
}

export interface TaskCommit {
  runId: string;
  taskId: string;
  revision: string;
  baselineRevision: string;
  commits: string[];
  changedPaths: string[];
}

export class NoTaskChangesError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} has no changes to commit.`);
    this.name = "NoTaskChangesError";
  }
}

export class WorkspaceManager {
  private readonly repositoryRoot: string;
  private readonly workspaceRoot: string;
  private readonly runId: string;
  private readonly runSegment: string;
  private readonly baselineRevision: string;
  private readonly execute: GitRunner;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceManagerOptions) {
    this.repositoryRoot = resolve(options.repositoryRoot);
    this.runId = options.runId;
    this.runSegment = safeName(options.runId);
    this.workspaceRoot = resolve(
      options.stateDirectory,
      "workspaces",
      this.runSegment
    );
    this.baselineRevision = options.baselineRevision;
    this.execute = options.execute ?? runGit;
  }

  async createTaskWorkspace(
    taskId: string,
    options: TaskWorkspaceOptions = {}
  ): Promise<TaskWorkspace> {
    return await this.serialized(async () => {
      const descriptor = this.describe(
        taskId,
        options.workspaceId ?? taskId,
        options.baselineRevision ?? this.baselineRevision
      );
      await mkdir(this.workspaceRoot, { recursive: true });
      if (await pathExists(descriptor.path)) {
        await this.assertOwnedWorkspace(descriptor);
        return descriptor;
      }

      const branchExists = await this.git(this.repositoryRoot, [
        "rev-parse",
        "--verify",
        descriptor.branch,
      ], true);
      const shortBranch = descriptor.branch.slice("refs/heads/".length);
      if (branchExists.exitCode === 0) {
        await this.git(this.repositoryRoot, [
          "worktree",
          "add",
          descriptor.path,
          shortBranch,
        ]);
      } else {
        await this.git(this.repositoryRoot, [
          "worktree",
          "add",
          "-b",
          shortBranch,
          descriptor.path,
          descriptor.baselineRevision,
        ]);
      }
      await this.assertOwnedWorkspace(descriptor);
      return descriptor;
    });
  }

  async commitTask(taskId: string, summary: string): Promise<TaskCommit> {
    return await this.serialized(async () => {
      const workspace = await this.ensureWorkspace(taskId);
      return await this.commitWorkspaceUnlocked(workspace, summary);
    });
  }

  async commitWorkspace(
    workspace: TaskWorkspace,
    summary: string
  ): Promise<TaskCommit> {
    return await this.serialized(async () => {
      if (workspace.runId !== this.runId) {
        throw new Error(`Task workspace ${workspace.workspaceId} belongs to another run.`);
      }
      await this.assertOwnedWorkspace(workspace);
      return await this.commitWorkspaceUnlocked(workspace, summary);
    });
  }

  async cleanup(): Promise<void> {
    await this.serialized(async () => {
      const branchPrefix = `refs/heads/aiboard/${this.runSegment}/tasks/`;
      const refs = await this.git(this.repositoryRoot, [
        "for-each-ref",
        "--format=%(refname)",
        branchPrefix,
      ]);
      for (const branch of refs.stdout.split(/\r?\n/).filter(Boolean)) {
        const workspaceSegment = branch.slice(branchPrefix.length);
        if (
          !branch.startsWith(branchPrefix) ||
          !workspaceSegment ||
          workspaceSegment.includes("/") ||
          !/^[a-z0-9-]+-[0-9a-f]{10}$/.test(workspaceSegment)
        ) {
          throw new Error(`Task branch ${branch} has unexpected ownership metadata.`);
        }
        const workspace: TaskWorkspace = {
          runId: this.runId,
          taskId: workspaceSegment,
          workspaceId: workspaceSegment,
          path: this.ownedWorkspacePath(workspaceSegment),
          branch,
          baselineRevision: this.baselineRevision,
        };
        const branchRevision = (
          await this.git(this.repositoryRoot, ["rev-parse", "--verify", branch])
        ).stdout.trim();
        const ancestry = await this.git(
          this.repositoryRoot,
          ["merge-base", "--is-ancestor", this.baselineRevision, branchRevision],
          true
        );
        if (ancestry.exitCode !== 0) {
          throw new Error(`Task branch ${branch} escaped its run baseline.`);
        }
        if (await pathExists(workspace.path)) {
          await this.assertOwnedWorkspace(workspace);
          await this.git(this.repositoryRoot, [
            "worktree",
            "remove",
            "--force",
            workspace.path,
          ]);
        }
        await this.git(this.repositoryRoot, [
          "update-ref",
          "-d",
          branch,
          branchRevision,
        ]);
      }
      await this.git(this.repositoryRoot, ["worktree", "prune", "--expire", "now"]);
      if (await pathExists(this.workspaceRoot)) {
        const unexpected = await readdir(this.workspaceRoot);
        if (unexpected.length > 0) {
          throw new Error("Task workspace root contains unexpected entries.");
        }
        await rm(this.workspaceRoot, { recursive: true, force: true });
      }
    });
  }

  private async commitWorkspaceUnlocked(
    workspace: TaskWorkspace,
    summary: string
  ): Promise<TaskCommit> {
      const status = await this.git(workspace.path, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      if (status.stdout.length === 0) {
        const head = await this.head(workspace.path);
        if (head === workspace.baselineRevision) {
          throw new NoTaskChangesError(workspace.taskId);
        }
        return await this.taskCommit(workspace, head);
      }
      const subject = summary.trim();
      if (!subject) throw new Error("Task commit summary is required.");
      await this.git(workspace.path, ["add", "-A"]);
      const staged = await this.git(
        workspace.path,
        ["diff", "--cached", "--quiet"],
        true
      );
      if (staged.exitCode === 0) {
        const head = await this.head(workspace.path);
        if (head === workspace.baselineRevision) {
          throw new NoTaskChangesError(workspace.taskId);
        }
        return await this.taskCommit(workspace, head);
      }
      if (staged.exitCode !== 1) {
        throw new Error(`Could not inspect staged task changes: ${staged.stderr}`);
      }
      await this.execute({
        cwd: workspace.path,
        args: [
          "commit",
          "-m",
          subject,
          "-m",
          `AIBoard-Run: ${this.runId}\nAIBoard-Task: ${workspace.taskId}`,
        ],
        env: RUNNER_IDENTITY,
      });
      return await this.taskCommit(workspace, await this.head(workspace.path));
  }

  private async ensureWorkspace(taskId: string): Promise<TaskWorkspace> {
    const descriptor = this.describe(taskId, taskId, this.baselineRevision);
    if (!(await pathExists(descriptor.path))) {
      throw new Error(`Task workspace ${taskId} has not been created.`);
    }
    await this.assertOwnedWorkspace(descriptor);
    return descriptor;
  }

  private describe(
    taskId: string,
    workspaceId: string,
    baselineRevision: string
  ): TaskWorkspace {
    const workspaceSegment = safeName(workspaceId);
    const path = this.ownedWorkspacePath(workspaceSegment);
    return {
      runId: this.runId,
      taskId,
      workspaceId,
      path,
      branch: `refs/heads/aiboard/${this.runSegment}/tasks/${workspaceSegment}`,
      baselineRevision,
    };
  }

  private ownedWorkspacePath(workspaceSegment: string): string {
    const path = resolve(this.workspaceRoot, workspaceSegment);
    const traversal = relative(this.workspaceRoot, path);
    if (
      traversal.startsWith("..") ||
      traversal === "" ||
      traversal.includes("/") ||
      traversal.includes("\\")
    ) {
      throw new Error(`Workspace segment ${workspaceSegment} produced an invalid path.`);
    }
    return path;
  }

  private async assertOwnedWorkspace(workspace: TaskWorkspace): Promise<void> {
    const [root, branch, ancestry] = await Promise.all([
      this.git(workspace.path, ["rev-parse", "--show-toplevel"]),
      this.git(workspace.path, ["symbolic-ref", "--quiet", "HEAD"]),
      this.git(
        workspace.path,
        ["merge-base", "--is-ancestor", workspace.baselineRevision, "HEAD"],
        true
      ),
    ]);
    if (resolve(root.stdout.trim()) !== workspace.path) {
      throw new Error(`Path ${workspace.path} is not the expected task worktree.`);
    }
    if (branch.stdout.trim() !== workspace.branch) {
      throw new Error(`Task workspace ${workspace.taskId} is on an unexpected branch.`);
    }
    if (ancestry.exitCode !== 0) {
      throw new Error(`Task workspace ${workspace.taskId} escaped its baseline.`);
    }
  }

  private async taskCommit(
    workspace: TaskWorkspace,
    revision: string
  ): Promise<TaskCommit> {
    const [commits, changedPaths] = await Promise.all([
      this.git(workspace.path, [
        "rev-list",
        "--reverse",
        `${workspace.baselineRevision}..${revision}`,
      ]),
      this.git(workspace.path, [
        "diff",
        "--name-only",
        "-z",
        workspace.baselineRevision,
        revision,
      ]),
    ]);
    return {
      runId: this.runId,
      taskId: workspace.taskId,
      revision,
      baselineRevision: workspace.baselineRevision,
      commits: commits.stdout.split(/\r?\n/).filter(Boolean),
      changedPaths: changedPaths.stdout.split("\0").filter(Boolean),
    };
  }

  private async head(cwd: string): Promise<string> {
    return (await this.git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  }

  private async git(
    cwd: string,
    args: readonly string[],
    allowFailure = false
  ) {
    const options: GitCommandOptions = { cwd, args, allowFailure };
    return await this.execute(options);
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release!: () => void;
    this.operationQueue = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

function safeName(value: string): string {
  const readable = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "item";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `${readable}-${hash}`;
}
