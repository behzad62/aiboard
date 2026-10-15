import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { unavailableGitRunner, type GitCommandOptions } from "./git-command.js";
import type { GitRunner } from "./git-repository.js";
import {
  classifyOwnedWorktreeAssociations,
  isEmptyDirectory,
  parseWorktreeAssociations,
} from "./worktree-state.js";

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
  beforeWorkspaceRootRemoval?: (
    workspaceRoot: string
  ) => void | Promise<void>;
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

interface TaskWorkspaceOwner {
  runId: string;
  taskId: string;
  workspaceId: string;
  active: boolean;
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
  private readonly beforeWorkspaceRootRemoval?: WorkspaceManagerOptions["beforeWorkspaceRootRemoval"];
  private operationQueue: Promise<void> = Promise.resolve();
  /**
   * T4 (EP11): exclusive worktree ownership — resolved worktree path to
   * owning task id. No two writers share one worktree; defense in depth
   * behind the scheduler claim gate, which refuses the second writer
   * before a workspace is even allocated.
   */
  private readonly ownershipPath: string;
  private readonly workspaceOwners = new Map<string, TaskWorkspaceOwner>();

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
    this.ownershipPath = resolve(
      options.stateDirectory,
      "workspace-owners",
      `${this.runSegment}.json`,
    );
    this.execute = options.execute ?? unavailableGitRunner;
    this.beforeWorkspaceRootRemoval = options.beforeWorkspaceRootRemoval;
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
      await this.loadWorkspaceOwners();
      const ownedBy = this.workspaceOwners.get(descriptor.path);
      if (ownedBy && ownedBy.taskId !== taskId) {
        throw new Error(
          `Workspace ${descriptor.path} is already owned by task ${ownedBy.taskId}; ` +
          `no two writers share one worktree.`,
        );
      }
      await mkdir(this.workspaceRoot, { recursive: true });
      if (await pathExists(descriptor.path)) {
        await this.assertOwnedWorkspace(descriptor);
        await this.setWorkspaceTaskOwner(descriptor, taskId);
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
      await this.assertOwnedWorkspace(descriptor, true);
      await this.setWorkspaceTaskOwner(descriptor, taskId);
      return descriptor;
    });
  }

  /**
   * T4: releases the exclusive worktree ownership held by a task. Called
   * when a task no longer writes (integrated, cancelled, or fenced after
   * failure). Unknown task ids are ignored.
   */
  async commitTask(taskId: string, summary: string): Promise<TaskCommit> {
    return await this.serialized(async () => {
      const workspace = await this.ensureWorkspace(taskId);
      return await this.commitWorkspaceUnlocked(workspace, summary);
    });
  }

  async commitWorkspace(
    workspace: TaskWorkspace,
    summary: string,
    inspectCandidate?: (revision: string) => Promise<void>,
  ): Promise<TaskCommit> {
    return await this.serialized(async () => {
      if (workspace.runId !== this.runId) {
        throw new Error(`Task workspace ${workspace.workspaceId} belongs to another run.`);
      }
      await this.assertOwnedWorkspace(workspace);
      return await this.commitWorkspaceUnlocked(workspace, summary, inspectCandidate);
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
        await this.loadWorkspaceOwners();
        const owner = this.workspaceOwners.get(this.ownedWorkspacePath(workspaceSegment));
        const workspace: TaskWorkspace = {
          runId: this.runId,
          taskId: owner?.taskId ?? workspaceSegment,
          workspaceId: owner?.workspaceId ?? workspaceSegment,
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
        const descriptorExists = await pathExists(workspace.path);
        let associations = parseWorktreeAssociations(
          (
            await this.git(this.repositoryRoot, [
              "worktree",
              "list",
              "--porcelain",
              "-z",
            ])
          ).stdout
        );
        const associationState = classifyOwnedWorktreeAssociations(
          associations,
          branch,
          workspace.path
        );
        const descriptorIsEmpty =
          descriptorExists && (await isEmptyDirectory(workspace.path));
        let recoveredInvalidWorkspace = false;
        if (
          associationState !== "unexpected" &&
          (!descriptorExists || descriptorIsEmpty)
        ) {
          if (descriptorExists) {
            await rmdir(workspace.path);
          }
          await this.git(this.repositoryRoot, [
            "worktree",
            "prune",
            "--expire",
            "now",
          ]);
          recoveredInvalidWorkspace = true;
          associations = parseWorktreeAssociations(
            (
              await this.git(this.repositoryRoot, [
                "worktree",
                "list",
                "--porcelain",
                "-z",
              ])
            ).stdout
          );
          if (
            classifyOwnedWorktreeAssociations(
              associations,
              branch,
              workspace.path
            ) !== "none"
          ) {
            throw new Error(`Task branch ${branch} still has an unexpected worktree path.`);
          }
        } else if (descriptorExists) {
          await this.assertOwnedWorkspace(workspace);
          if (associationState !== "exact") {
            throw new Error(`Task branch ${branch} has an unexpected worktree path.`);
          }
        } else {
          throw new Error(`Task branch ${branch} has an unexpected worktree path.`);
        }
        if (descriptorExists && !recoveredInvalidWorkspace) {
          await this.git(this.repositoryRoot, [
            "worktree",
            "remove",
            "--force",
            workspace.path,
          ]);
        }
        const remainingAssociations = parseWorktreeAssociations(
          (
            await this.git(this.repositoryRoot, [
              "worktree",
              "list",
              "--porcelain",
              "-z",
            ])
          ).stdout
        );
        if (
          classifyOwnedWorktreeAssociations(
            remainingAssociations,
            branch,
            workspace.path
          ) !== "none"
        ) {
          throw new Error(`Task branch ${branch} still has an unexpected worktree path.`);
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
        await this.beforeWorkspaceRootRemoval?.(this.workspaceRoot);
        await rmdir(this.workspaceRoot);
      }
      this.workspaceOwners.clear();
      if (await pathExists(this.ownershipPath)) {
        await writeFile(this.ownershipPath, "{}\n", "utf8");
      }
    });
  }

  private async commitWorkspaceUnlocked(
    workspace: TaskWorkspace,
    summary: string,
    inspectCandidate?: (revision: string) => Promise<void>,
  ): Promise<TaskCommit> {
      if (inspectCandidate) {
        for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "sequencer"]) {
          const metadata = (await this.git(workspace.path, ["rev-parse", "--git-path", name])).stdout.trim();
          if (await pathExists(resolve(workspace.path, metadata))) throw new Error("Guarded submission requires a settled Git operation.");
        }
      }
      const status = await this.git(workspace.path, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      if (status.stdout.length === 0) {
        const head = await this.head(workspace.path);
        await inspectCandidate?.(head);
        if (inspectCandidate) await this.assertGuardedParent(workspace, head);
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
        await inspectCandidate?.(head);
        if (inspectCandidate) await this.assertGuardedParent(workspace, head);
        if (head === workspace.baselineRevision) {
          throw new NoTaskChangesError(workspace.taskId);
        }
        return await this.taskCommit(workspace, head);
      }
      if (staged.exitCode !== 1) {
        throw new Error(`Could not inspect staged task changes: ${staged.stderr}`);
      }
      if (inspectCandidate) {
        // The guard and commit consume the same immutable tree, even if the
        // index changes while the asynchronous inspection is in progress.
        const previousHead = await this.head(workspace.path);
        const tree = (await this.git(workspace.path, ["write-tree"])).stdout.trim();
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(previousHead) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(tree)) throw new Error("Guarded task tree identity is invalid.");
        await inspectCandidate(tree);
        await this.assertGuardedParent(workspace, previousHead);
        const committed = await this.execute({ cwd: workspace.path,
          args: ["commit-tree", tree, "-p", previousHead, "-m", subject, "-m", `AIBoard-Run: ${this.runId}\nAIBoard-Task: ${workspace.taskId}`], env: RUNNER_IDENTITY });
        if (committed.exitCode !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(committed.stdout.trim())) throw new Error("Guarded task commit could not be created.");
        const revision = committed.stdout.trim();
        await this.git(workspace.path, ["update-ref", workspace.branch, revision, previousHead]);
        return await this.taskCommit(workspace, revision);
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

  private async assertGuardedParent(workspace: TaskWorkspace, previousHead: string): Promise<void> {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(previousHead)) throw new Error("Guarded task parent identity is invalid.");
    await this.assertOwnedWorkspace(workspace);
    if ((await this.head(workspace.path)) !== previousHead) throw new Error("Guarded task parent changed during inspection.");
    await this.git(workspace.path, ["merge-base", "--is-ancestor", workspace.baselineRevision, previousHead]);
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

  private async loadWorkspaceOwners(): Promise<void> {
    const serialized = await readFile(this.ownershipPath, "utf8").catch(() => "{}");
    const value = JSON.parse(serialized) as Record<string, TaskWorkspaceOwner>;
    this.workspaceOwners.clear();
    for (const [path, owner] of Object.entries(value)) {
      this.workspaceOwners.set(path, owner);
    }
  }

  private async saveWorkspaceOwners(): Promise<void> {
    await mkdir(resolve(this.ownershipPath, ".."), { recursive: true });
    const value = Object.fromEntries(this.workspaceOwners);
    const temporary = `${this.ownershipPath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, this.ownershipPath);
  }

  private async setWorkspaceTaskOwner(
    workspace: TaskWorkspace,
    taskId: string,
  ): Promise<void> {
    await this.loadWorkspaceOwners();
    const existing = this.workspaceOwners.get(workspace.path);
    if (existing && existing.taskId !== taskId) {
      throw new Error(
        `Workspace ${workspace.path} is owned by task ${existing.taskId}; no two writers share one worktree.`,
      );
    }
    this.workspaceOwners.set(workspace.path, {
      runId: this.runId,
      taskId,
      workspaceId: workspace.workspaceId,
      active: true,
    });
    await this.saveWorkspaceOwners();
  }

  private async assertWorkspaceTaskOwner(
    workspace: TaskWorkspace,
    taskId: string,
  ): Promise<void> {
    await this.loadWorkspaceOwners();
    const owner = this.workspaceOwners.get(workspace.path);
    if (!owner) return;
    if (owner.taskId !== taskId || owner.runId !== this.runId) {
      throw new Error(
        `Workspace ${workspace.path} is owned by task ${owner.taskId}; no two writers share one worktree.`,
      );
    }
  }

  private async assertOwnedWorkspace(
    workspace: TaskWorkspace,
    allowUnownedCreation = false,
  ): Promise<void> {
    const [root, branch, ancestry] = await Promise.all([
      this.git(workspace.path, ["rev-parse", "--show-toplevel"]),
      this.git(workspace.path, ["symbolic-ref", "--quiet", "HEAD"]),
      this.git(
        workspace.path,
        ["merge-base", "--is-ancestor", workspace.baselineRevision, "HEAD"],
        true
      ),
    ]);
    if (!allowUnownedCreation) {
      await this.assertWorkspaceTaskOwner(workspace, workspace.taskId);
    }
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
    .slice(0, 12) || "item";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 10);
  return `${readable}-${hash}`;
}
