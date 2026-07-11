import { createHash } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type { ChangeSet } from "./change-set.js";
import { runGit, type GitCommandOptions } from "./git-command.js";
import type { GitRunner } from "./git-repository.js";

const RUNNER_IDENTITY: Readonly<Record<string, string>> = {
  GIT_COMMITTER_NAME: "AIBoard Integrator",
  GIT_COMMITTER_EMAIL: "integrator@aiboard.local",
};

export interface IntegrationManagerOptions {
  repositoryRoot: string;
  stateDirectory: string;
  runId: string;
  baselineRevision: string;
  execute?: GitRunner;
}

export type IntegrationResult =
  | {
      status: "integrated";
      changeSetId: string;
      taskId: string;
      integrationRevision: string;
      changedPaths: string[];
    }
  | {
      status: "conflict";
      changeSetId: string;
      taskId: string;
      integrationRevision: string;
      conflictPaths: string[];
    };

export interface ProjectHandoffResult {
  integrationRevision: string;
  integrationBranch: string;
  appliedToProject: boolean;
}

export class IntegrationManager {
  readonly path: string;
  private readonly repositoryRoot: string;
  private readonly stateDirectory: string;
  private readonly runId: string;
  private readonly runSegment: string;
  private readonly baselineRevision: string;
  private readonly branch: string;
  private readonly execute: GitRunner;
  private operationQueue: Promise<void> = Promise.resolve();
  private currentRevision: string | undefined;

  constructor(options: IntegrationManagerOptions) {
    this.repositoryRoot = resolve(options.repositoryRoot);
    this.stateDirectory = resolve(options.stateDirectory);
    this.runId = options.runId;
    this.runSegment = safeName(options.runId);
    const integrationRoot = resolve(options.stateDirectory, "integration");
    this.path = resolve(integrationRoot, this.runSegment);
    if (relative(integrationRoot, this.path).startsWith("..")) {
      throw new Error("Integration workspace escaped the runner state directory.");
    }
    this.baselineRevision = options.baselineRevision;
    this.branch = `refs/heads/aiboard/${this.runSegment}/integration`;
    this.execute = options.execute ?? runGit;
  }

  get revision(): string {
    if (!this.currentRevision) {
      throw new Error("Integration manager has not been initialized.");
    }
    return this.currentRevision;
  }

  get integrationBranch(): string {
    return this.branch.slice("refs/heads/".length);
  }

  descriptor(appliedToProject = false): ProjectHandoffResult {
    return {
      integrationRevision: this.revision,
      integrationBranch: this.integrationBranch,
      appliedToProject,
    };
  }

  async initialize(): Promise<void> {
    await this.serialized(async () => {
      await this.ensureIntegrationWorkspace();
    });
  }

  async integrate(changeSet: ChangeSet): Promise<IntegrationResult> {
    return await this.serialized(async () => {
      await this.ensureIntegrationWorkspace();
      this.assertCompatible(changeSet);
      await this.assertTaskHistory(changeSet);
      if (changeSet.commits.length === 0) {
        return {
          status: "integrated",
          changeSetId: changeSet.id,
          taskId: changeSet.taskId,
          integrationRevision: this.revision,
          changedPaths: [],
        };
      }
      const appliedRef = this.appliedRef(changeSet.id);
      const alreadyApplied = await this.resolveRef(appliedRef);
      if (alreadyApplied) {
        const ancestor = await this.git(
          this.path,
          ["merge-base", "--is-ancestor", alreadyApplied, "HEAD"],
          true
        );
        if (ancestor.exitCode !== 0) {
          throw new Error(
            `Applied change-set ref ${appliedRef} is not in the integration history.`
          );
        }
        return {
          status: "integrated",
          changeSetId: changeSet.id,
          taskId: changeSet.taskId,
          integrationRevision: alreadyApplied,
          changedPaths: [...changeSet.changedPaths],
        };
      }

      const recoveredRevision = await this.findIntegratedRevision(changeSet);
      if (recoveredRevision) {
        await this.recordAppliedRef(appliedRef, recoveredRevision);
        return {
          status: "integrated",
          changeSetId: changeSet.id,
          taskId: changeSet.taskId,
          integrationRevision: recoveredRevision,
          changedPaths: [...changeSet.changedPaths],
        };
      }

      for (const revision of changeSet.commits) {
        const valid = await this.git(
          this.repositoryRoot,
          ["cat-file", "-e", `${revision}^{commit}`],
          true
        );
        if (valid.exitCode !== 0) {
          throw new Error(`Task commit ${revision} does not exist.`);
        }
      }
      const before = await this.head();
      const cherryPick = await this.execute({
        cwd: this.path,
        args: ["cherry-pick", "-x", ...changeSet.commits],
        env: RUNNER_IDENTITY,
        allowFailure: true,
      });
      if (cherryPick.exitCode !== 0) {
        const conflicts = await this.git(this.path, [
          "diff",
          "--name-only",
          "--diff-filter=U",
          "-z",
        ]);
        await this.git(this.path, ["cherry-pick", "--abort"], true);
        this.currentRevision = await this.head();
        if (this.currentRevision !== before) {
          throw new Error("Failed integration did not restore its original revision.");
        }
        const conflictPaths = conflicts.stdout.split("\0").filter(Boolean);
        if (conflictPaths.length === 0) {
          throw new Error(
            `Change set ${changeSet.id} could not be applied: ${cherryPick.stderr.trim()}`
          );
        }
        return {
          status: "conflict",
          changeSetId: changeSet.id,
          taskId: changeSet.taskId,
          integrationRevision: before,
          conflictPaths,
        };
      }

      this.currentRevision = await this.head();
      await this.recordAppliedRef(appliedRef, this.currentRevision);
      return {
        status: "integrated",
        changeSetId: changeSet.id,
        taskId: changeSet.taskId,
        integrationRevision: this.currentRevision,
        changedPaths: [...changeSet.changedPaths],
      };
    });
  }

  async applyToProject(): Promise<ProjectHandoffResult> {
    return await this.serialized(async () => {
      await this.ensureIntegrationWorkspace();
      const diff = await this.git(this.path, [
        "diff",
        "--binary",
        "--full-index",
        this.baselineRevision,
        this.revision,
        "--",
      ]);
      if (!diff.stdout) return this.descriptor(true);

      const handoffDirectory = resolve(this.stateDirectory, "handoff");
      const patchPath = resolve(handoffDirectory, `${this.runSegment}.patch`);
      if (relative(handoffDirectory, patchPath).startsWith("..")) {
        throw new Error("Project handoff patch escaped the runner state directory.");
      }
      await mkdir(handoffDirectory, { recursive: true });
      await writeFile(patchPath, diff.stdout, "utf8");
      try {
        const check = await this.git(
          this.repositoryRoot,
          ["apply", "--check", "--binary", patchPath],
          true
        );
        if (check.exitCode !== 0) {
          throw new Error(
            `The integrated result cannot be applied safely to the project: ${check.stderr.trim()}`
          );
        }
        const applied = await this.git(
          this.repositoryRoot,
          ["apply", "--binary", patchPath],
          true
        );
        if (applied.exitCode !== 0) {
          throw new Error(
            `The integrated result could not be applied to the project: ${applied.stderr.trim()}`
          );
        }
        return this.descriptor(true);
      } finally {
        await rm(patchPath, { force: true });
      }
    });
  }

  private async ensureIntegrationWorkspace(): Promise<void> {
    await mkdir(resolve(this.path, ".."), { recursive: true });
    if (await pathExists(this.path)) {
      await this.assertWorkspace();
      this.currentRevision = await this.head();
      return;
    }
    const branchExists = await this.git(
      this.repositoryRoot,
      ["rev-parse", "--verify", this.branch],
      true
    );
    const shortBranch = this.branch.slice("refs/heads/".length);
    if (branchExists.exitCode === 0) {
      await this.git(this.repositoryRoot, [
        "worktree",
        "add",
        this.path,
        shortBranch,
      ]);
    } else {
      await this.git(this.repositoryRoot, [
        "worktree",
        "add",
        "-b",
        shortBranch,
        this.path,
        this.baselineRevision,
      ]);
    }
    await this.assertWorkspace();
    this.currentRevision = await this.head();
  }

  private async assertWorkspace(): Promise<void> {
    const [root, branch, ancestor] = await Promise.all([
      this.git(this.path, ["rev-parse", "--show-toplevel"]),
      this.git(this.path, ["symbolic-ref", "--quiet", "HEAD"]),
      this.git(
        this.path,
        ["merge-base", "--is-ancestor", this.baselineRevision, "HEAD"],
        true
      ),
    ]);
    if (resolve(root.stdout.trim()) !== this.path) {
      throw new Error("Integration path is not the runner-owned worktree.");
    }
    if (branch.stdout.trim() !== this.branch) {
      throw new Error("Integration worktree is on an unexpected branch.");
    }
    if (ancestor.exitCode !== 0) {
      throw new Error("Integration worktree escaped its run baseline.");
    }
  }

  private assertCompatible(changeSet: ChangeSet): void {
    if (changeSet.runId !== this.runId) {
      throw new Error(`Change set ${changeSet.id} belongs to another run.`);
    }
    if (changeSet.baselineRevision !== this.baselineRevision) {
      throw new Error(`Change set ${changeSet.id} has a different baseline.`);
    }
    if (changeSet.commits.at(-1) !== changeSet.taskRevision) {
      if (
        changeSet.commits.length !== 0 ||
        changeSet.taskRevision !== changeSet.baselineRevision
      ) {
        throw new Error(`Change set ${changeSet.id} task revision is inconsistent.`);
      }
    }
  }

  private async assertTaskHistory(changeSet: ChangeSet): Promise<void> {
    const ancestry = await this.git(
      this.repositoryRoot,
      [
        "merge-base",
        "--is-ancestor",
        this.baselineRevision,
        changeSet.taskRevision,
      ],
      true
    );
    if (ancestry.exitCode !== 0) {
      throw new Error(`Change set ${changeSet.id} is not based on the run baseline.`);
    }
    const history = await this.git(this.repositoryRoot, [
      "rev-list",
      "--reverse",
      `${this.baselineRevision}..${changeSet.taskRevision}`,
    ]);
    const actual = history.stdout.split(/\r?\n/).filter(Boolean);
    if (
      actual.length !== changeSet.commits.length ||
      actual.some((revision, index) => revision !== changeSet.commits[index])
    ) {
      throw new Error(`Change set ${changeSet.id} commit history is inconsistent.`);
    }
  }

  private async findIntegratedRevision(
    changeSet: ChangeSet
  ): Promise<string | null> {
    const history = await this.git(this.path, [
      "log",
      "--reverse",
      "--format=%H%x00%B%x00",
      `${this.baselineRevision}..HEAD`,
    ]);
    const fields = history.stdout.split("\0");
    const commits: Array<{ revision: string; body: string }> = [];
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const revision = fields[index].trim();
      if (revision) commits.push({ revision, body: fields[index + 1] });
    }
    let cursor = 0;
    let matched: string | null = null;
    for (const source of changeSet.commits) {
      const index = commits.findIndex(
        (commit, position) =>
          position >= cursor &&
          commit.body.includes(`(cherry picked from commit ${source})`)
      );
      if (index < 0) return null;
      matched = commits[index].revision;
      cursor = index + 1;
    }
    return matched;
  }

  private async recordAppliedRef(ref: string, revision: string): Promise<void> {
    const recorded = await this.git(
      this.repositoryRoot,
      ["update-ref", ref, revision, ""],
      true
    );
    if (recorded.exitCode !== 0) {
      const raced = await this.resolveRef(ref);
      if (raced !== revision) {
        throw new Error(`Could not record integrated change set at ${ref}.`);
      }
    }
  }

  private appliedRef(changeSetId: string): string {
    return `refs/aiboard/runs/${this.runSegment}/integrated/${safeName(changeSetId)}`;
  }

  private async resolveRef(ref: string): Promise<string | null> {
    const result = await this.git(
      this.repositoryRoot,
      ["rev-parse", "--verify", ref],
      true
    );
    return result.exitCode === 0 ? result.stdout.trim() : null;
  }

  private async head(): Promise<string> {
    return (await this.git(this.path, ["rev-parse", "HEAD"])).stdout.trim();
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
