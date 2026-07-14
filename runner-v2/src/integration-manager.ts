import { createHash } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type { ChangeSet } from "./change-set.js";
import {
  runGit,
  runGitBytes,
  type GitBinaryRunner,
  type GitCommandOptions,
} from "./git-command.js";
import type { GitRunner } from "./git-repository.js";

const RUNNER_IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "AIBoard Integrator",
  GIT_AUTHOR_EMAIL: "integrator@aiboard.local",
  GIT_COMMITTER_NAME: "AIBoard Integrator",
  GIT_COMMITTER_EMAIL: "integrator@aiboard.local",
};

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILE_RESPONSE_BYTES = 10 * 1024 * 1024;

export interface IntegrationManagerOptions {
  repositoryRoot: string;
  stateDirectory: string;
  runId: string;
  baselineRevision: string;
  execute?: GitRunner;
  executeBytes?: GitBinaryRunner;
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
  projectRevision?: string;
}

export interface IntegrationCommit {
  revision: string;
  parents: string[];
  subject: string;
}

export type IntegrationFileSource = "integration" | "project";

export interface IntegrationFile {
  path: string;
  content: string;
}

export interface IntegrationFileSnapshot {
  source: IntegrationFileSource;
  revision: string;
  appliedToProject: boolean;
  omittedFileCount: number;
  files: IntegrationFile[];
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
  private readonly executeBytes: GitBinaryRunner;
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
    this.executeBytes = options.executeBytes ?? runGitBytes;
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

  descriptor(
    appliedToProject = false,
    projectRevision?: string
  ): ProjectHandoffResult {
    return {
      integrationRevision: this.revision,
      integrationBranch: this.integrationBranch,
      appliedToProject,
      ...(projectRevision ? { projectRevision } : {}),
    };
  }

  async history(limit = 50): Promise<IntegrationCommit[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Integration history limit must be an integer from 1 to 100.");
    }
    return await this.serialized(async () => {
      const revision = await this.fileRevision("integration");
      const result = await this.git(this.repositoryRoot, [
        "log",
        "-n",
        String(limit),
        "--format=%H%x1f%P%x1f%s%x1e",
        `${this.baselineRevision}..${revision}`,
      ]);
      const commits: IntegrationCommit[] = [];
      for (const record of result.stdout.split("\x1e").map((item) => item.trim()).filter(Boolean)) {
        const [revision = "", parents = "", subject = ""] = record.split("\x1f");
        if (!revision) continue;
        commits.push({
          revision,
          parents: parents ? parents.split(/\s+/) : [],
          subject,
        });
      }
      return commits;
    });
  }

  async files(
    source: IntegrationFileSource,
    projectRevision?: string
  ): Promise<IntegrationFileSnapshot> {
    return await this.serialized(async () => {
      const revision = await this.fileRevision(source, projectRevision);
      const tree = await this.execute({
        cwd: this.repositoryRoot,
        args: [
          "ls-tree",
          "-r",
          "-z",
          "--format=%(objecttype)%x1f%(objectsize)%x1f%(path)",
          revision,
        ],
        maxOutputBytes: MAX_FILE_RESPONSE_BYTES,
      });
      const entries = parseTreeEntries(tree.stdout);
      const files: IntegrationFile[] = [];
      let omittedFileCount = 0;
      let responseBytes = snapshotBytes(source, revision, entries.length, []);
      for (const entry of entries) {
        const { path, size } = entry;
        if (
          entry.type !== "blob" ||
          !Number.isSafeInteger(size) ||
          size < 0 ||
          size > MAX_FILE_BYTES
        ) {
          omittedFileCount += 1;
          continue;
        }
        const object = `${revision}:${path}`;
        const content = await this.executeBytes({
          cwd: this.repositoryRoot,
          args: ["show", object],
          maxOutputBytes: MAX_FILE_BYTES + 4096,
        });
        const text = decodeUtf8Text(content.stdout, size);
        if (text === null) {
          omittedFileCount += 1;
          continue;
        }
        const candidate = { path, content: text };
        const candidateBytes = Buffer.byteLength(JSON.stringify(candidate), "utf8");
        const separatorBytes = files.length === 0 ? 0 : 1;
        if (responseBytes + separatorBytes + candidateBytes > MAX_FILE_RESPONSE_BYTES) {
          omittedFileCount += 1;
          continue;
        }
        files.push(candidate);
        responseBytes += separatorBytes + candidateBytes;
      }
      return {
        source,
        revision,
        appliedToProject: source === "project",
        omittedFileCount,
        files,
      };
    });
  }

  async initialize(): Promise<void> {
    await this.serialized(async () => {
      await this.ensureIntegrationWorkspace();
    });
  }

  async cleanup(): Promise<void> {
    await this.serialized(async () => {
      if (await pathExists(this.path)) {
        await this.assertWorkspace();
        this.currentRevision ??= await this.head();
        await this.git(this.repositoryRoot, [
          "worktree",
          "remove",
          "--force",
          this.path,
        ]);
      }
      await this.git(this.repositoryRoot, ["worktree", "prune", "--expire", "now"]);
    });
  }

  async integrate(changeSet: ChangeSet): Promise<IntegrationResult> {
    return await this.serialized(async () => {
      await this.ensureIntegrationWorkspace();
      await this.assertCompatible(changeSet);
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
      const projectBranch = await this.git(
        this.repositoryRoot,
        ["symbolic-ref", "--quiet", "HEAD"],
        true
      );
      if (
        projectBranch.exitCode !== 0 ||
        !projectBranch.stdout.trim().startsWith("refs/heads/")
      ) {
        throw new Error("Automatic project handoff requires a named branch.");
      }
      const projectRevision = (
        await this.git(this.repositoryRoot, [
          "rev-parse",
          "--verify",
          "HEAD^{commit}",
        ])
      ).stdout.trim();
      const status = await this.git(this.repositoryRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      if (status.stdout.length > 0) {
        throw new Error(
          "Automatic project handoff requires a clean project worktree and index."
        );
      }
      const diff = await this.git(this.path, [
        "diff",
        "--binary",
        "--full-index",
        this.baselineRevision,
        this.revision,
        "--",
      ]);
      if (!diff.stdout) return this.descriptor(true, projectRevision);
      if (await this.isAppliedProjectCommit(projectRevision)) {
        return this.descriptor(true, projectRevision);
      }

      const handoffDirectory = resolve(this.stateDirectory, "handoff");
      const patchPath = resolve(handoffDirectory, `${this.runSegment}.patch`);
      const indexPath = resolve(handoffDirectory, `${this.runSegment}.index`);
      if (
        relative(handoffDirectory, patchPath).startsWith("..") ||
        relative(handoffDirectory, indexPath).startsWith("..")
      ) {
        throw new Error("Project handoff files escaped the runner state directory.");
      }
      await mkdir(handoffDirectory, { recursive: true });
      await rm(indexPath, { force: true });
      await rm(`${indexPath}.lock`, { force: true });
      await writeFile(patchPath, diff.stdout, "utf8");
      try {
        const isolatedIndex = { GIT_INDEX_FILE: indexPath };
        await this.execute({
          cwd: this.repositoryRoot,
          args: ["read-tree", projectRevision],
          env: isolatedIndex,
        });
        const check = await this.execute({
          cwd: this.repositoryRoot,
          args: ["apply", "--check", "--cached", "--binary", patchPath],
          env: isolatedIndex,
          allowFailure: true,
        });
        if (check.exitCode !== 0) {
          throw new Error(
            `The integrated result cannot be applied safely to the project: ${check.stderr.trim()}`
          );
        }
        const applied = await this.execute({
          cwd: this.repositoryRoot,
          args: ["apply", "--cached", "--binary", patchPath],
          env: isolatedIndex,
          allowFailure: true,
        });
        if (applied.exitCode !== 0) {
          throw new Error(
            `The integrated result could not be applied to the project: ${applied.stderr.trim()}`
          );
        }
        const treeRevision = (
          await this.execute({
            cwd: this.repositoryRoot,
            args: ["write-tree"],
            env: isolatedIndex,
          })
        ).stdout.trim();
        const commit = await this.execute({
          cwd: this.repositoryRoot,
          args: [
            "commit-tree",
            treeRevision,
            "-p",
            projectRevision,
            "-m",
            "Apply completed AIBoard build",
            "-m",
            `AIBoard-Run: ${this.runId}\nAIBoard-Integration: ${this.revision}`,
          ],
          env: RUNNER_IDENTITY,
          allowFailure: true,
        });
        if (commit.exitCode !== 0) {
          throw new Error(
            `The integrated result could not be committed to the project: ${commit.stderr.trim()}`
          );
        }
        const committedRevision = commit.stdout.trim();
        await this.assertProjectUnchanged(projectBranch.stdout.trim(), projectRevision);
        const advanced = await this.git(
          this.repositoryRoot,
          [
            "update-ref",
            projectBranch.stdout.trim(),
            committedRevision,
            projectRevision,
          ],
          true
        );
        if (advanced.exitCode !== 0) {
          throw new Error("The project changed during automatic handoff.");
        }
        try {
          const currentBranch = await this.git(
            this.repositoryRoot,
            ["symbolic-ref", "--quiet", "HEAD"],
            true
          );
          const currentRevision = (
            await this.git(this.repositoryRoot, ["rev-parse", "--verify", "HEAD"])
          ).stdout.trim();
          if (
            currentBranch.exitCode !== 0 ||
            currentBranch.stdout.trim() !== projectBranch.stdout.trim() ||
            currentRevision !== committedRevision
          ) {
            throw new Error("The project changed during automatic handoff.");
          }
          const checkout = await this.git(
            this.repositoryRoot,
            ["read-tree", "-u", "-m", projectRevision, committedRevision],
            true
          );
          if (checkout.exitCode !== 0) {
            throw new Error(
              `The committed result could not be checked out safely: ${checkout.stderr.trim()}`
            );
          }
        } catch (error) {
          const rollback = await this.git(
            this.repositoryRoot,
            [
              "update-ref",
              projectBranch.stdout.trim(),
              projectRevision,
              committedRevision,
            ],
            true
          );
          if (rollback.exitCode !== 0) {
            throw new AggregateError(
              [error, new Error(rollback.stderr.trim())],
              "Automatic handoff failed after advancing the project branch and could not roll it back."
            );
          }
          throw error;
        }
        return this.descriptor(true, committedRevision);
      } finally {
        await rm(patchPath, { force: true });
        await rm(indexPath, { force: true });
        await rm(`${indexPath}.lock`, { force: true });
      }
    });
  }

  private async assertProjectUnchanged(
    branch: string,
    revision: string
  ): Promise<void> {
    const [currentBranch, currentRevision, status] = await Promise.all([
      this.git(this.repositoryRoot, ["symbolic-ref", "--quiet", "HEAD"], true),
      this.git(this.repositoryRoot, ["rev-parse", "--verify", "HEAD"]),
      this.git(this.repositoryRoot, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]),
    ]);
    if (
      currentBranch.exitCode !== 0 ||
      currentBranch.stdout.trim() !== branch ||
      currentRevision.stdout.trim() !== revision ||
      status.stdout.length > 0
    ) {
      throw new Error("The project changed during automatic handoff.");
    }
  }

  private async isAppliedProjectCommit(revision: string): Promise<boolean> {
    const message = (
      await this.git(this.repositoryRoot, ["show", "-s", "--format=%B", revision])
    ).stdout;
    const lines = message.split(/\r?\n/);
    return (
      lines.includes(`AIBoard-Run: ${this.runId}`) &&
      lines.includes(`AIBoard-Integration: ${this.revision}`)
    );
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

  private async fileRevision(
    source: IntegrationFileSource,
    projectRevision?: string
  ): Promise<string> {
    if (source === "project") {
      if (projectRevision !== undefined) {
        if (!/^[a-f0-9]{40,64}$/.test(projectRevision)) {
          throw new Error("Project file revision is invalid.");
        }
        return (
          await this.git(this.repositoryRoot, [
            "rev-parse",
            "--verify",
            `${projectRevision}^{commit}`,
          ])
        ).stdout.trim();
      }
      return (
        await this.git(this.repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"])
      ).stdout.trim();
    }
    if (source !== "integration") {
      throw new Error(`Unknown file source: ${String(source)}`);
    }
    if (projectRevision !== undefined) {
      throw new Error("An explicit revision is valid only for project files.");
    }
    if (this.currentRevision) return this.currentRevision;
    const branchRevision = await this.resolveRef(this.branch);
    if (!branchRevision) {
      await this.ensureIntegrationWorkspace();
      return this.revision;
    }
    const ancestor = await this.git(
      this.repositoryRoot,
      ["merge-base", "--is-ancestor", this.baselineRevision, branchRevision],
      true
    );
    if (ancestor.exitCode !== 0) {
      throw new Error("Integration branch escaped its run baseline.");
    }
    this.currentRevision = branchRevision;
    return branchRevision;
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

  private async assertCompatible(changeSet: ChangeSet): Promise<void> {
    if (changeSet.runId !== this.runId) {
      throw new Error(`Change set ${changeSet.id} belongs to another run.`);
    }
    const [belongsToRun, basedOnIntegration] = await Promise.all([
      this.git(
        this.repositoryRoot,
        [
          "merge-base",
          "--is-ancestor",
          this.baselineRevision,
          changeSet.baselineRevision,
        ],
        true
      ),
      this.git(
        this.repositoryRoot,
        [
          "merge-base",
          "--is-ancestor",
          changeSet.baselineRevision,
          this.revision,
        ],
        true
      ),
    ]);
    if (belongsToRun.exitCode !== 0 || basedOnIntegration.exitCode !== 0) {
      throw new Error(
        `Change set ${changeSet.id} is not based on this run's integration history.`
      );
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
        changeSet.baselineRevision,
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
      `${changeSet.baselineRevision}..${changeSet.taskRevision}`,
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

function decodeUtf8Text(bytes: Buffer, objectBytes: number): string | null {
  if (bytes.length !== objectBytes || bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

interface TreeEntry {
  type: string;
  size: number;
  path: string;
}

function parseTreeEntries(output: string): TreeEntry[] {
  return output
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const firstSeparator = record.indexOf("\x1f");
      const secondSeparator = record.indexOf("\x1f", firstSeparator + 1);
      if (firstSeparator < 1 || secondSeparator < 0) {
        throw new Error("Git returned malformed tree metadata.");
      }
      return {
        type: record.slice(0, firstSeparator),
        size: Number(record.slice(firstSeparator + 1, secondSeparator)),
        path: record.slice(secondSeparator + 1),
      };
    });
}

function snapshotBytes(
  source: IntegrationFileSource,
  revision: string,
  maximumOmittedFileCount: number,
  files: IntegrationFile[]
): number {
  return Buffer.byteLength(
    JSON.stringify({
      source,
      revision,
      appliedToProject: source === "project",
      omittedFileCount: maximumOmittedFileCount,
      files,
    }),
    "utf8"
  );
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
