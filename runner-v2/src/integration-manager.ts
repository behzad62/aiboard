import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import type { ChangeSet } from "./change-set.js";
import {
  GitCommandError,
  unavailableGitRunner,
  type GitBinaryRunner,
  type GitCommandOptions,
} from "./git-command.js";
import type { GitRunner } from "./git-repository.js";
import {
  agentsMarkedSectionSatisfies,
  agentsMarkedSectionSatisfiesV2,
  claudePointerSatisfies,
  claudePointerSatisfiesV2,
  handoffEntryCollisionSkipReason,
  handoffEntryGenericSkipReason,
  handoffStateBlockerSkipReason,
  handoffStateSkipReason,
  type HandoffStateBlockerKind,
  HANDOFF_STATE_LINK_COMPONENTS,
  resolveHandoffLinkTarget,
  spliceMarkedArchitectSectionBytes,
  validateProjectDocPath,
  type DocumentTipRelation,
  type ProjectDocCommitRequest,
  type ProjectDocCommitResult,
  type ProjectDocWrite,
} from "./project-docs.js";
import {
  classifyOwnedWorktreeAssociations,
  isEmptyDirectory,
  parseWorktreeAssociations,
} from "./worktree-state.js";

const RUNNER_IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "AIBoard Integrator",
  GIT_AUTHOR_EMAIL: "integrator@aiboard.local",
  GIT_COMMITTER_NAME: "AIBoard Integrator",
  GIT_COMMITTER_EMAIL: "integrator@aiboard.local",
};

const ARCHITECT_DOC_IDENTITY: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: "AIBoard Architect",
  GIT_AUTHOR_EMAIL: "architect@aiboard.local",
  GIT_COMMITTER_NAME: "AIBoard Architect",
  GIT_COMMITTER_EMAIL: "architect@aiboard.local",
};

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILE_RESPONSE_BYTES = 10 * 1024 * 1024;

interface ProjectApplyJournalBase {
  runId: string;
  projectIdentity: string;
  projectBranch: string;
  expectedParent: string;
  targetCommit: string;
  integrationRevision: string;
}

interface LegacyProjectApplyJournal extends ProjectApplyJournalBase {
  version: 1;
}

interface OwnedProjectApplyJournal extends ProjectApplyJournalBase {
  version: 2;
  state: "prepared" | "retiring";
  retiringOwnershipRevision?: string;
  retirementKind?: "winner" | "abandoned";
  winningRevision?: string;
  transitionId: string;
  transitionRef: string;
  patchFile: string;
  indexFile: string;
}

type ProjectApplyJournal = LegacyProjectApplyJournal | OwnedProjectApplyJournal;

interface CommitBody {
  revision: string;
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
  body: string;
}

/**
 * The commit message trailer block (C2b N4): the trailing contiguous run
 * of `Key: value` lines. Lines quoted anywhere else in the message --
 * for example a cherry-picked worker summary -- are not trailers.
 */
function commitTrailerBlock(body: string): Set<string> {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const block = new Set<string>();
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!;
    if (!/^[A-Za-z0-9-]+:[ \t]+\S/.test(line)) break;
    block.add(line);
  }
  return block;
}

/**
 * C3c: authoritative runner trailers for a new-policy integration commit.
 * Reserved `AIBoard-` trailer claims already present in the worker message
 * (model free text reaches the message through the submit summary) are
 * removed, so a forged Run/Task/Requirements line can never establish
 * authority; the kernel-derived run id, task id, and trusted run-level
 * requirement ids are then appended. The cherry-pick line is preserved so
 * recovery still finds the integration by it.
 */
const RESERVED_TRAILER_PATTERN = /^\s*AIBoard-[A-Za-z0-9-]+:[ \t]*\S/;
const CHERRY_PICK_LINE_PATTERN = /\(cherry picked from commit [a-f0-9]{40}\)/;

function stampIntegrationTrailers(
  body: string,
  input: { runId: string; taskId: string; requirementIds: readonly string[]; sourceRevision: string },
): string {
  // The source marker is built from the TRUSTED for-loop revision (a
  // validated ChangeSet commit), never from message text. A worker summary
  // may quote a forged "(cherry picked from commit ...)" line; every
  // marker-looking line is stripped as untrusted and exactly one exact
  // trusted marker is appended, so no message claim can establish source
  // identity and recovery never follows a spoofed marker.
  if (!/^[a-f0-9]{40,64}$/.test(input.sourceRevision)) {
    throw new Error("Refusing to stamp an integration trailer with an invalid source revision.");
  }
  const kept = body
    .split(/\r?\n/)
    .filter((line) => !CHERRY_PICK_LINE_PATTERN.test(line) && !RESERVED_TRAILER_PATTERN.test(line));
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  return [
    ...kept,
    "",
    `(cherry picked from commit ${input.sourceRevision})`,
    `AIBoard-Run: ${input.runId}`,
    `AIBoard-Task: ${input.taskId}`,
    `AIBoard-Requirements: ${input.requirementIds.join(" ")}`,
    "",
  ].join("\n");
}

/**
 * Whether a commit body carries the AUTHORITATIVE runner stamp for one
 * integrated source commit: exactly one cherry-pick marker line, and the
 * message ends with the exact trusted marker plus the exact
 * Run/Task/Requirements trailers in order. Position is part of authority --
 * a quoted marker or forged trailer anywhere else in the message never
 * validates, so message text cannot smuggle source identity.
 */
function isAuthoritativeIntegrationBody(
  body: string,
  input: { runId: string; taskId: string; requirementIds: readonly string[]; source: string },
): boolean {
  const markerLines = body.split(/\r?\n/).filter((line) => CHERRY_PICK_LINE_PATTERN.test(line));
  if (markerLines.length !== 1) return false;
  const lines = body.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  const tail = lines.slice(-4);
  return (
    tail.length === 4 &&
    tail[0]!.trim() === `(cherry picked from commit ${input.source})` &&
    tail[1]!.trim() === `AIBoard-Run: ${input.runId}` &&
    tail[2]!.trim() === `AIBoard-Task: ${input.taskId}` &&
    tail[3]!.trim() === `AIBoard-Requirements: ${[...input.requirementIds].join(" ")}`
  );
}

/** Kernel handoff snapshot commit (docs policy v2, C2a: STATE.md only). */
export interface HandoffSnapshotCommitRequest {
  writes: readonly ProjectDocWrite[];
  summary: string;
  runId: string;
  snapshotKey: string;
}

export interface IntegrationManagerOptions {
  repositoryRoot: string;
  stateDirectory: string;
  runId: string;
  baselineRevision: string;
  initializationMode?: "active" | "cleanup-only";
  execute?: GitRunner;
  executeBytes?: GitBinaryRunner;
  afterProjectApplyJournalWritten?: (input: {
    projectBranch: string;
    expectedParent: string;
    targetCommit: string;
    journalPath: string;
  }) => void | Promise<void>;
  afterProjectRefAdvanced?: (input: {
    projectBranch: string;
    expectedParent: string;
    targetCommit: string;
    journalPath: string;
  }) => void | Promise<void>;
  afterProjectBranchAdvanced?: (input: {
    projectBranch: string;
    expectedParent: string;
    targetCommit: string;
    journalPath: string;
  }) => void | Promise<void>;
  afterAbandonedProjectAppliesRetired?: (input: {
    targetCommit: string;
  }) => void | Promise<void>;
  afterProjectApplyOwnershipReleased?: (input: {
    expectedOwnershipRevision: string;
    retirementKind: "winner" | "abandoned";
    targetCommit: string;
    journalPath: string;
  }) => void | Promise<void>;
}

export interface IntegrationOptions {
  /**
   * New-policy runs stamp runner trailers; legacy runs omit it and stay
   * byte-identical.
   */
  planningPolicyVersion?: number;
  /**
   * C3c: kernel-derived trusted run-level requirement ids from the CURRENT
   * accepted ready-plan contract. Required and non-empty on new-policy
   * runs. The trailer never falls back to task-local criterion ids, worker
   * ChangeSet fields, or model summary text.
   */
  requirementIds?: readonly string[];
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
  /** Present only when a terminal reader reports historical file state. */
  historicalProvenance?: import("./historical-read-provenance.js").HistoricalReadProvenance;
}

export class IntegrationManager {
  readonly path: string;
  private readonly repositoryRoot: string;
  private readonly stateDirectory: string;
  private readonly runId: string;
  private readonly runSegment: string;
  private readonly baselineRevision: string;
  private readonly initializationMode: "active" | "cleanup-only";
  private readonly branch: string;
  private readonly execute: GitRunner;
  private readonly executeBytes: GitBinaryRunner;
  private readonly afterProjectApplyJournalWritten?: IntegrationManagerOptions["afterProjectApplyJournalWritten"];
  private readonly afterProjectRefAdvanced?: IntegrationManagerOptions["afterProjectRefAdvanced"];
  private readonly afterProjectBranchAdvanced?: IntegrationManagerOptions["afterProjectBranchAdvanced"];
  private readonly afterAbandonedProjectAppliesRetired?: IntegrationManagerOptions["afterAbandonedProjectAppliesRetired"];
  private readonly afterProjectApplyOwnershipReleased?: IntegrationManagerOptions["afterProjectApplyOwnershipReleased"];
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
    this.initializationMode = options.initializationMode ?? "active";
    this.branch = `refs/heads/aiboard/${this.runSegment}/integration`;
    this.execute = options.execute ?? unavailableGitRunner;
    this.executeBytes = options.executeBytes ?? unavailableGitRunner;
    this.afterProjectApplyJournalWritten = options.afterProjectApplyJournalWritten;
    this.afterProjectRefAdvanced = options.afterProjectRefAdvanced;
    this.afterProjectBranchAdvanced = options.afterProjectBranchAdvanced;
    this.afterAbandonedProjectAppliesRetired = options.afterAbandonedProjectAppliesRetired;
    this.afterProjectApplyOwnershipReleased = options.afterProjectApplyOwnershipReleased;
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
      return await this.historyAtRevision(revision, limit);
    });
  }

  async files(
    source: IntegrationFileSource,
    projectRevision?: string
  ): Promise<IntegrationFileSnapshot> {
    return await this.serialized(async () => {
      const revision = await this.fileRevision(source, projectRevision);
      return await this.filesAtRevision(source, revision);
    });
  }

  /**
   * Reads a terminal Build's recorded revision without recovering or creating
   * an integration worktree.
   */
  async historicalFiles(input: {
    integrationRevision?: string;
    appliedToProject?: boolean;
    projectRevision?: string;
  }): Promise<IntegrationFileSnapshot> {
    return await this.serialized(async () => {
      if (input.appliedToProject) {
        if (!input.projectRevision) {
          throw new Error("Historical project handoff is missing its project revision.");
        }
        return await this.filesAtRevision(
          "project",
          await this.resolveHistoricalCommit(input.projectRevision),
        );
      }
      if (!input.integrationRevision) {
        throw new Error("Historical Build is missing its integration revision.");
      }
      return await this.filesAtRevision(
        "integration",
        await this.resolveHistoricalCommit(input.integrationRevision),
      );
    });
  }

  /** Reads durable integration history without touching the integration worktree. */
  async historicalHistory(
    integrationRevision: string | undefined,
    limit = 50,
  ): Promise<IntegrationCommit[]> {
    if (!integrationRevision) return [];
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Integration history limit must be an integer from 1 to 100.");
    }
    return await this.serialized(async () =>
      await this.historyAtRevision(
        await this.resolveHistoricalCommit(integrationRevision),
        limit,
      )
    );
  }

  private async historyAtRevision(
    revision: string,
    limit: number,
  ): Promise<IntegrationCommit[]> {
    const result = await this.git(this.repositoryRoot, [
      "log",
      "-n",
      String(limit),
      "--format=%H%x1f%P%x1f%s%x1e",
      `${this.baselineRevision}..${revision}`,
    ]);
    const commits: IntegrationCommit[] = [];
    for (const record of result.stdout.split("\x1e").map((item) => item.trim()).filter(Boolean)) {
      const [commitRevision = "", parents = "", subject = ""] = record.split("\x1f");
      if (!commitRevision) continue;
      commits.push({
        revision: commitRevision,
        parents: parents ? parents.split(/\s+/) : [],
        subject,
      });
    }
    return commits;
  }

  private async filesAtRevision(
    source: IntegrationFileSource,
    revision: string,
  ): Promise<IntegrationFileSnapshot> {
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
  }

  private async resolveHistoricalCommit(revision: string): Promise<string> {
    if (!/^[a-f0-9]{40,64}$/i.test(revision)) {
      throw new Error("Historical Build revision is invalid.");
    }
    return (
      await this.git(this.repositoryRoot, [
        "rev-parse",
        "--verify",
        `${revision}^{commit}`,
      ])
    ).stdout.trim();
  }

  async initialize(): Promise<void> {
    await this.serialized(async () => {
      if (
        this.initializationMode === "cleanup-only"
          ? await this.retainEmptyLegacyWorkspaceForCleanup()
          : await this.recoverEmptyLegacyWorkspace()
      ) {
        return;
      }
      await this.ensureIntegrationWorkspace();
    });
  }

  async cleanup(): Promise<void> {
    await this.serialized(async () => {
      const branchRevision = await this.resolveRef(this.branch);
      if (branchRevision) {
        const ancestry = await this.git(
          this.repositoryRoot,
          ["merge-base", "--is-ancestor", this.baselineRevision, branchRevision],
          true
        );
        if (ancestry.exitCode !== 0) {
          throw new Error("Integration branch escaped its run baseline.");
        }
      }
      const descriptorExists = await pathExists(this.path);
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
        this.branch,
        this.path
      );
      const descriptorIsEmpty =
        descriptorExists && (await isEmptyDirectory(this.path));
      let recoveredInvalidWorkspace = false;
      if (
        branchRevision !== null &&
        associationState !== "unexpected" &&
        (!descriptorExists || descriptorIsEmpty)
      ) {
        if (descriptorExists) {
          await rmdir(this.path);
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
            this.branch,
            this.path
          ) !== "none"
        ) {
          throw new Error("Integration branch still has an unexpected worktree path.");
        }
      } else if (descriptorExists) {
        await this.assertWorkspace();
        this.currentRevision ??= await this.head();
        if (associationState !== "exact") {
          throw new Error("Integration branch has an unexpected worktree path.");
        }
      } else if (associationState !== "none") {
        throw new Error("Integration branch has an unexpected worktree path.");
      }
      if (descriptorExists && !recoveredInvalidWorkspace) {
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

  async integrate(changeSet: ChangeSet, options?: IntegrationOptions): Promise<IntegrationResult> {
    const newPolicy = options?.planningPolicyVersion === 1;
    const trustedRequirementIds = [...(options?.requirementIds ?? [])].filter((id) => id.trim().length > 0);
    if (newPolicy && trustedRequirementIds.length === 0) {
      throw new Error(
        `Change set ${changeSet.id} is not bound to the current ready plan contract: no trusted requirement ids.`
      );
    }
    return await this.serialized(async () => {
      await this.ensureIntegrationWorkspace();
      await this.assertCompatible(changeSet);
      await this.assertTaskHistory(changeSet);
      const documentConflicts = projectDocumentConflictPaths(changeSet.changedPaths);
      if (documentConflicts.length > 0) {
        return {
          status: "conflict",
          changeSetId: changeSet.id,
          taskId: changeSet.taskId,
          integrationRevision: this.revision,
          conflictPaths: documentConflicts,
        };
      }
      if (changeSet.commits.length === 0) {
        return {
          status: "integrated",
          changeSetId: changeSet.id,
          taskId: changeSet.taskId,
          integrationRevision: this.revision,
          changedPaths: [],
        };
      }
      if (newPolicy) {
        // F4: refuse a dirty index/worktree before any new-policy mutation,
        // so the transaction baseline below is provably ours and a later
        // rollback can never delete foreign edits. Legacy keeps its
        // abort-only behavior.
        await this.assertCleanForNewPolicyIntegration(changeSet.id);
        // F2: refuse to resume through an unfinished cherry-pick/merge
        // sequencer instead of rolling it back blindly.
        await this.assertNoIncompleteIntegrationTransaction(changeSet.id);
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
        if (newPolicy) {
          // F2: never silently accept the ref. The recorded chain must
          // carry the authoritative stamp for every source commit;
          // anything else (unstamped, forged, or legacy trailers) is
          // refused fail-closed instead of reported as integrated.
          await this.assertAuthoritativeAppliedChain(changeSet, trustedRequirementIds, appliedRef, alreadyApplied);
        }
        return {
          status: "integrated",
          changeSetId: changeSet.id,
          taskId: changeSet.taskId,
          integrationRevision: alreadyApplied,
          changedPaths: [...changeSet.changedPaths],
        };
      }

      // F2: bounded recovery over the owned prefix (new-policy only). A
      // restart after a stamped prefix resumes exactly at the gap without
      // duplicating changes; an interrupted unstamped tip is refused without mutation;
      // anything ambiguous is refused. Legacy keeps text-only reuse.
      let prefixCount = 0;
      if (newPolicy) {
        const recovered = await this.recoverOwnedIntegrationPrefix(changeSet, trustedRequirementIds);
        if (recovered.prefixCount >= changeSet.commits.length && recovered.prefixRevision) {
          await this.recordAppliedRef(appliedRef, recovered.prefixRevision);
          return {
            status: "integrated",
            changeSetId: changeSet.id,
            taskId: changeSet.taskId,
            integrationRevision: recovered.prefixRevision,
            changedPaths: [...changeSet.changedPaths],
          };
        }
        prefixCount = recovered.prefixCount;
      } else {
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
      if (!newPolicy) {
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
      } else {
        // C3c: stage one source patch, then publish one fully stamped commit.
        // No unstamped HEAD is published between pick and trailer creation.
        // Every integrated commit carries
        // the authoritative runner trailers (from the trusted ready-plan
        // contract, never worker text). A mid-loop failure resets to the
        // pre-integration revision, preserving the legacy atomicity fence.
        // After a restart the validated owned prefix is never re-picked:
        // only the remaining sources are applied, so the first pick can
        // never stick as an empty duplicate.
        for (const revision of changeSet.commits.slice(prefixCount)) {
          const cherryPick = await this.execute({
            cwd: this.path,
            args: ["cherry-pick", "--no-commit", revision],
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
            await this.git(this.path, ["reset", "--hard", before], true);
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
          const picked = (await this.git(this.path, ["log", "-1", "--format=%B", revision])).stdout;
          const author = (await this.git(this.path, ["log", "-1", "--format=%an <%ae>", revision])).stdout.trim();
          const stamped = stampIntegrationTrailers(picked, {
            runId: changeSet.runId,
            taskId: changeSet.taskId,
            requirementIds: trustedRequirementIds,
            sourceRevision: revision,
          });
          const amend = await this.execute({
            cwd: this.path,
            args: ["commit", "--author", author, "-m", stamped],
            env: RUNNER_IDENTITY,
            allowFailure: true,
          });
          if (amend.exitCode !== 0) {
            await this.git(this.path, ["reset", "--hard", before], true);
            this.currentRevision = await this.head();
            if (this.currentRevision !== before) {
              throw new Error("Failed integration did not restore its original revision.");
            }
            throw new Error(
              `Change set ${changeSet.id} trailer stamp failed: ${amend.stderr.trim()}`
            );
          }
        }
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

  /**
   * Commit a kernel-rendered handoff snapshot on the integration branch.
   * Docs policy v2 (C2a: STATE.md only): one commit with a runner identity,
   * `AIBoard-Author: runner` and `AIBoard-Generated: handoff-snapshot`
   * trailers plus the `AIBoard-Snapshot-Key` trailer. A key already present
   * in a commit body is returned unchanged, so a crash between the commit
   * and the event append never creates a second commit. No model call.
   */
  async commitHandoffSnapshot(
    input: HandoffSnapshotCommitRequest,
  ): Promise<ProjectDocCommitResult> {
    return await this.serialized(async () => {
      if (input.runId !== this.runId) {
        throw new Error("Project document commit belongs to another run.");
      }
      if (!input.summary.trim() || input.summary.includes("\n") || input.summary.includes("\0")) {
        throw new Error("Project document summary is invalid.");
      }
      if (!input.snapshotKey.trim() || /[\r\n\0]/.test(input.snapshotKey)) {
        throw new Error("Handoff snapshot key is invalid.");
      }
      if (input.writes.length === 0) {
        throw new Error("Project document commit requires at least one write.");
      }
      await this.ensureIntegrationWorkspace();
      const existing = await this.findSnapshotCommit(input.snapshotKey, input.runId);
      if (existing) {
        // C2b repair m2: a reused commit still describes the committed tree.
        // The caller derives previousSnapshotEdited and specCopied from the
        // read-back, never from fresh reads, so the reuse is marked.
        // C2e (m-4): a reused commit carries no stage-time records, so the
        // shared describer would re-word every entry skip generically. The
        // skip reasons below are re-derived from the same commit tree in the
        // fresh wording, so the reuse records exactly what a fresh commit
        // of the same layout records.
        const reusedResult = await this.documentCommitResult(existing);
        reusedResult.reused = true;
        const reusedSkips = await this.commitEntrySkipReasonsFromTree(existing, reusedResult.entryPoint);
        if (reusedSkips.length > 0) reusedResult.skipped = reusedSkips;
        return reusedResult;
      }
      // C2b (M7): entry files go through the marked-section splice, never a
      // whole-file overwrite -- the same staging the Architect path uses, so
      // bytes outside the markers survive every kernel commit.
      const { staged: paths, skipped, redirected } = await this.stageProjectDocWrites(
        input.writes.filter((write) => !isHandoffSpecCopyPath(write.path)),
        { skipClaudeAgentsLink: true },
      );
      // C2b repair N-1/N-2: the spec copy is conditional, the snapshot is
      // not. A spec write that cannot be staged (a blocked directory, a
      // user's own bytes at the path) is skipped with a recorded reason
      // instead of failing the snapshot; entry writes still throw exactly
      // as before.
      const specStaging = await this.stageHandoffSpecCopies(
        input.writes.filter((write) => isHandoffSpecCopyPath(write.path)),
      );
      paths.push(...specStaging.staged);
      skipped.push(...specStaging.skipped);
      if (paths.length === 0) {
        // C2c repair cycle 4 (NB-9): every write skipped with a recorded
        // reason (a docs link together with both entry files linked
        // elsewhere) still hands off. The reducer accepts the `paths: []`
        // shape with those reasons (round 3, NB-4), so record an empty
        // snapshot commit instead of wedging the run. Nothing else may be
        // staged into it: the index must be clean, and the commit carries
        // every runner trailer so key reuse still finds it. The v1
        // Architect path below keeps the throw.
        // C2e (m-11): the unclean-index refusal names the integration
        // index, not "wrote nothing" -- the skips are recorded, the staged
        // stranger is the cause. Fail closed: HEAD is unchanged and nothing
        // is staged into the empty commit.
        const indexStatus = await this.git(this.path, ["diff", "--cached", "--quiet"], true);
        if (indexStatus.exitCode !== 0) {
          throw new Error(`Project document commit refused: the integration index is not clean (staged changes remain while every write was skipped: ${skipped.map((entry) => entry.reason).join(" ") || "every write was skipped."}).`);
        }
        try {
          await this.execute({
            cwd: this.path,
            args: [
              "commit",
              "--allow-empty",
              "-m",
              input.summary,
              "--trailer",
              `AIBoard-Run: ${input.runId}`,
              "--trailer",
              "AIBoard-Author: runner",
              "--trailer",
              "AIBoard-Generated: handoff-snapshot",
              "--trailer",
              `AIBoard-Snapshot-Key: ${input.snapshotKey}`,
            ],
            env: RUNNER_IDENTITY,
          });
        } catch (error) {
          await this.git(this.path, ["reset", "--hard", "HEAD"], true);
          throw error;
        }
        const commit = await this.head();
        this.currentRevision = commit;
        const committed = await this.documentCommitResult(commit);
        if (skipped.length > 0) committed.skipped = skipped;
        if (redirected.length > 0) committed.redirected = redirected;
        return committed;
      }
      // C2c (NF-1): the spec copy stages in its own `git add`. A gitignored
      // (or otherwise unstageable) specs path then drops only the copy --
      // recorded below -- while STATE.md and the entry lines still commit.
      // A single batch add would fail every path together and wedge the run.
      const entryPaths = paths.filter((path) => !isHandoffSpecCopyPath(path));
      const specPaths = paths.filter((path) => isHandoffSpecCopyPath(path));
      await this.git(this.path, ["add", "--", ...entryPaths]);
      const droppedSpec: Array<{ path: string; reason: string }> = [];
      if (specPaths.length > 0) {
        const specAdd = await this.git(this.path, ["add", "--", ...specPaths], true);
        if (specAdd.exitCode !== 0) {
          const detail = `${specAdd.stdout} ${specAdd.stderr}`.replace(/\s+/g, " ").trim().slice(0, 160) || "unknown error";
          for (const path of specPaths) {
            // C2d repair cycle 1 (m-2): the skip record keeps the
            // canonical path (`specPaths` holds the index's own
            // spelling, say `Docs/...`). The runtime matches
            // `entry.path.startsWith("docs/project/specs/")` exactly,
            // so a resolved spelling would detach the reason. Only
            // case differs between the spellings, so the mapping is
            // exact.
            const canonical = canonicalHandoffSpelling(path);
            droppedSpec.push({
              path: canonical,
              reason: `spec copy skipped (write_failed): git add failed for ${canonical} (${detail}).`,
            });
          }
        }
      }
      const commitPaths = droppedSpec.length > 0 ? entryPaths : paths;
      try {
        await this.execute({
          cwd: this.path,
          args: [
            "commit",
            "--allow-empty",
            "-m",
            input.summary,
            "--trailer",
            `AIBoard-Run: ${input.runId}`,
            "--trailer",
            "AIBoard-Author: runner",
            "--trailer",
            "AIBoard-Generated: handoff-snapshot",
            "--trailer",
            `AIBoard-Snapshot-Key: ${input.snapshotKey}`,
            "--",
            ...commitPaths,
          ],
          env: RUNNER_IDENTITY,
        });
      } catch (error) {
        await this.git(this.path, ["reset", "--hard", "HEAD"], true);
        await this.git(this.path, ["clean", "-fd", "--", ...paths], true);
        throw error;
      }
      const commit = await this.head();
      this.currentRevision = commit;
      const committed = await this.documentCommitResult(commit);
      // A skipped spec copy (N-1/N-2, C2c NF-1) is recorded on the result so
      // the skip is never silent; the runtime maps it to specCopySkipped.
      const allSkipped = [...skipped, ...droppedSpec];
      if (allSkipped.length > 0) committed.skipped = allSkipped;
      if (redirected.length > 0) committed.redirected = redirected;
      return committed;
    });
  }

  /**
   * Stage the kernel's spec-copy writes without ever failing the snapshot
   * (C2b repair N-1/N-2). Each write is validated, link-refused, and
   * written like the shared staging, but a failure is reported instead of
   * thrown. A user's own file holding different bytes is never overwritten.
   * C2c repair M-4: the runtime resolves the final path (target or digest
   * sibling) from the tip blobs before STATE.md renders, and each write
   * arrives carrying that resolved path -- the stager stages exactly it, or
   * skips it as path_occupied when it holds different bytes. It never
   * diverts to a sibling of its own, so the committed copy always matches
   * the `spec:` line (or the copy is skipped and the line says
   * "not recorded").
   */
  private async stageHandoffSpecCopies(
    writes: readonly ProjectDocWrite[],
  ): Promise<{ staged: string[]; skipped: Array<{ path: string; reason: string }> }> {
    const staged: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    for (const write of writes) {
      const checked = validateProjectDocPath(write.path);
      if (!checked.ok) {
        skipped.push({ path: write.path, reason: `spec copy skipped (write_failed): refused path (${checked.reason}).` });
        continue;
      }
      const path = checked.path;
      try {
        await this.refuseProjectDocLink(path);
      } catch (error) {
        skipped.push({ path, reason: `spec copy skipped (write_failed): ${briefErrorDetail(error)}.` });
        continue;
      }
      // C2d repair cycle 1 (escalation C-1): a case collision at a spec
      // ancestor (say `docs` with `Docs`) skips the optional copy before
      // any write. On disk there is one directory, so a write stages under
      // the other spelling and every commit wedges on the pathspec. The
      // commit-tree attestation is the same one the STATE.md stage uses;
      // a single variant spelling (legitimate Docs/Project) is not a
      // collision and still copies.
      const ancestorCollision = await this.commitStateNonLinkBlocker("HEAD");
      if (ancestorCollision !== null && ancestorCollision.kind === "case-collision") {
        skipped.push({ path, reason: `spec copy skipped (write_failed): the commit tree tracks two spellings of ${ancestorCollision.component}.` });
        continue;
      }
      // C2d (DOCS-dir): a spec copy under a case-variant docs directory
      // writes and stages through the index's own spelling, like STATE.md.
      // The skipped record keeps the canonical path.
      const realPath = await this.resolveIndexSpelling(path);
      const outcome = await this.writeHandoffSpecCopy(realPath, write.content);
      if ("skipped" in outcome) {
        skipped.push({ path, reason: outcome.skipped });
        continue;
      }
      staged.push(outcome.staged);
    }
    return { staged, skipped };
  }

  private async writeHandoffSpecCopy(
    path: string,
    content: string,
  ): Promise<{ staged: string } | { skipped: string }> {
    const absolute = this.containedProjectDocPath(path);
    const wanted = Buffer.from(content, "utf8");
    let existing: Buffer | null = null;
    try {
      existing = await readFile(absolute);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        return { skipped: `spec copy skipped (write_failed): cannot read ${path} (${briefErrorDetail(error)}).` };
      }
    }
    if (existing !== null && existing.equals(wanted)) {
      return { staged: path };
    }
    if (existing !== null) {
      return { skipped: `spec copy skipped (path_occupied): ${path} holds different bytes.` };
    }
    try {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, wanted);
    } catch (error) {
      return { skipped: `spec copy skipped (write_failed): cannot stage ${path} (${briefErrorDetail(error)}).` };
    }
    return { staged: path };
  }

  /**
   * Read back a committed handoff snapshot file with the commit's real
   * paths (C2a repair B4). The runtime records the digest of the bytes
   * the commit actually holds -- never a fresh render -- so the event
   * describes the committed tree even when a retry reuses an earlier
   * commit. Runs through the audited git path like every other read.
   */
  async readHandoffSnapshotFile(input: {
    commit: string;
    path: string;
  }): Promise<{ content: string | null; paths: string[] }> {
    return await this.serialized(async () => {
      const checked = validateProjectDocPath(input.path);
      if (!checked.ok) {
        throw new Error(`Project document path is refused: ${checked.reason}.`);
      }
      if (!input.commit.trim()) {
        throw new Error("Handoff snapshot commit is required.");
      }
      // C2d (DOCS-dir, D-rd-lcagents): the blob is read through the commit's
      // own spelling when the canonical one matches nothing (git stores
      // `Docs/project/STATE.md` or `claude.md`).
      // C2d repair cycle 1 (B2): remember which spelling the content came
      // from. A tree that tracks two spellings of the same handoff file
      // (say `docs/project/STATE.md` holding an old body alongside
      // `docs/project/state.md` holding the new one) must read back
      // fail-closed: the changed path maps to the canonical spelling only
      // when it is the spelling the content was read from. Otherwise the
      // gate would accept the stale exact-spelling bytes under the changed
      // canonical name. No extra git call: the spelling is the one the
      // read above already resolved to.
      let contentPath = checked.path;
      let stored = await this.git(
        this.path,
        ["show", `${input.commit}:${checked.path}`],
        true,
      );
      if (stored.exitCode !== 0 && (await this.checkoutIgnoresCase())) {
        const real = await this.resolveSpellingInTree(input.commit, checked.path);
        if (real !== checked.path) {
          stored = await this.git(this.path, ["show", `${input.commit}:${real}`], true);
          contentPath = real;
        }
      }
      const names = await this.git(this.path, [
        "show",
        "--name-only",
        "--format=",
        input.commit,
      ]);
      // C2d: on a case-insensitive checkout the commit's real spellings are
      // reported under the canonical handoff spellings, so the unchanged
      // AR-R05 gate (exact `docs/project/STATE.md` membership) and the
      // commit-tree describer keep working. The real spellings stay
      // observable through `git show --name-only` itself.
      const insensitive = await this.checkoutIgnoresCase();
      const paths = names.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((path) => {
          if (!insensitive) return path;
          const canonical = canonicalHandoffSpelling(path);
          if (canonical === "docs/project/STATE.md" && path !== contentPath) return path;
          return canonical;
        });
      return { content: stored.exitCode === 0 ? stored.stdout : null, paths };
    });
  }

  /**
   * Read a file from the integration tip commit (C2b AR-R07): blob bytes,
   * never the working tree. The caller detects a hand-edited previous
   * snapshot from these bytes. Runs through the audited git path.
   */
  async readIntegrationTipFile(input: {
    path: string;
  }): Promise<{ content: string | null; commit: string }> {
    return await this.serialized(async () => {
      const checked = validateProjectDocPath(input.path);
      if (!checked.ok) {
        throw new Error(`Project document path is refused: ${checked.reason}.`);
      }
      await this.ensureIntegrationWorkspace();
      const commit = await this.head();
      // C2d (DOCS-dir): read through the tip's own spelling when the
      // canonical one matches nothing, so hand-edit detection still sees a
      // snapshot committed under a case-variant docs directory.
      let stored = await this.git(
        this.path,
        ["show", `${commit}:${checked.path}`],
        true,
      );
      if (stored.exitCode !== 0 && (await this.checkoutIgnoresCase())) {
        const real = await this.resolveSpellingInTree(commit, checked.path);
        if (real !== checked.path) {
          stored = await this.git(this.path, ["show", `${commit}:${real}`], true);
        }
      }
      return { content: stored.exitCode === 0 ? stored.stdout : null, commit };
    });
  }

  /**
   * Find a tracked file at the integration tip whose bytes hash to the
   * given sha256 (C2b CD-5): the approved source is "already a repository
   * file" exactly when this returns a path, so the kernel skips the spec
   * copy. Bounded: only same-byte-length blobs are read and hashed, all
   * through the audited git path.
   */
  async findTrackedFileWithDigest(input: {
    digest: string;
    byteLength: number;
  }): Promise<{ path: string } | null> {
    return await this.serialized(async () => {
      if (!/^[a-f0-9]{64}$/.test(input.digest)) {
        throw new Error("Tracked file digest is invalid.");
      }
      if (!Number.isSafeInteger(input.byteLength) || input.byteLength <= 0) {
        throw new Error("Tracked file byte length is invalid.");
      }
      await this.ensureIntegrationWorkspace();
      const listing = await this.git(this.path, [
        "ls-tree",
        "-r",
        "-l",
        "-z",
        "HEAD",
        "--",
      ]);
      const entries = listing.stdout.split("\0").filter(Boolean);
      const candidates: string[] = [];
      for (const entry of entries) {
        const tab = entry.lastIndexOf("\t");
        if (tab < 0) continue;
        const meta = entry.slice(0, tab).split(/ +/);
        const path = entry.slice(tab + 1);
        if (meta.length < 4 || meta[1] !== "blob") continue;
        if (Number(meta[3]) !== input.byteLength) continue;
        if (!path || path.includes("\n") || path.includes("\r")) continue;
        candidates.push(path);
      }
      for (const path of candidates) {
        const stored = await this.git(this.path, ["show", `HEAD:${path}`], true);
        if (stored.exitCode !== 0) continue;
        if (createHash("sha256").update(stored.stdout, "utf8").digest("hex") === input.digest) {
          return { path };
        }
      }
      return null;
    });
  }

  /**
   * Validate, link-refuse and stage project-document writes in the
   * integration worktree. AGENTS.md and CLAUDE.md go through the
   * marked-section splice (never a whole-file overwrite): a missing file is
   * created with just the section, and bytes outside the markers are kept
   * byte-for-byte. Shared by the Architect path and the kernel handoff path
   * (C2b M7: one splice implementation, not two).
   */
  private async stageProjectDocWrites(
    writes: readonly ProjectDocWrite[],
    options: { skipClaudeAgentsLink?: boolean } = {},
  ): Promise<{
    staged: string[];
    skipped: Array<{ path: string; reason: string }>;
    redirected: Array<{ path: string; target: string; reason: string }>;
  }> {
    const skipped: Array<{ path: string; reason: string }> = [];
    const redirected: Array<{ path: string; target: string; reason: string }> = [];
    const staged = writes.map((write) => {
      const checked = validateProjectDocPath(write.path);
      if (!checked.ok) {
        throw new Error(`Project document path is refused: ${checked.reason}.`);
      }
      return { path: checked.path, content: write.content };
    });
    // C2b repair N-4: only the kernel snapshot path skips a CLAUDE.md link
    // to AGENTS.md. The v1 Architect path keeps the HEAD refusal below
    // (refuseProjectDocLink throws exactly as before).
    const skipClaudeAgentsLink = options.skipClaudeAgentsLink === true;
    // C2c (NF-2/CD-15): the kernel snapshot path never writes through a
    // link. Each entry write lands on a physical path: its own path, or the
    // link target when the entry file is a link to a regular tracked file.
    // C2d repair cycle 1 (escalation): the HEAD tree's entry-file
    // spellings, once per snapshot, so a colliding entry file (say
    // `AGENTS.md` with `agents.md`) is skipped with a recorded reason
    // instead of wedging the run. One git call on a case-insensitive
    // checkout with entry writes, zero otherwise.
    const entryCollisions = skipClaudeAgentsLink && staged.some((write) => write.path === "AGENTS.md" || write.path === "CLAUDE.md")
      ? await this.commitEntryCollisionSpellings("HEAD")
      : { agents: [], claude: [] };
    const planned: Array<{ writePath: string; physicalPath: string; content: string }> = [];
    for (const write of staged) {
      // C2d (DOCS-dir, D-walk-projdir, F-LC-agents, D-rd-lcagents): on a
      // case-insensitive checkout the commit pathspec must use the index's
      // own spelling of each existing path component (the canonical spelling
      // matches nothing when git stores `Docs/`, `docs/Project/` or
      // `agents.md`). Components that do not exist yet keep the canonical
      // spelling. The recorded skip/redirect reasons keep the canonical
      // entry path; only the physical write and the staged path use the
      // resolved spelling, so no write lands in a file the commit does not
      // record. Redirect targets are never resolved here: they keep the
      // NB-8 exact-spelling rule below.
      const realPath = await this.resolveIndexSpelling(write.path);
      if (skipClaudeAgentsLink && write.path === "CLAUDE.md" && (await this.claudeLinksAgents())) {
        skipped.push({
          path: write.path,
          reason: "CLAUDE.md is a symbolic link to AGENTS.md; the pointer is satisfied through the link.",
        });
        continue;
      }
      // C2c repair CD-17: a linked directory above a handoff file never
      // blocks the handoff on the kernel path -- the file is skipped with a
      // recorded reason (the AR-R05 gate accepts it the way it accepts
      // export_only) and nothing is written under the link. Entry files
      // live at the repository root and keep their CD-15 handling below.
      // The v1 Architect path (skipClaudeAgentsLink false) keeps refusing
      // through refuseProjectDocLink, which now checks docs too.
      if (skipClaudeAgentsLink && write.path !== "AGENTS.md" && write.path !== "CLAUDE.md") {
        const linked = await this.firstLinkComponent(write.path);
        if (linked !== null) {
          skipped.push({
            path: write.path,
            reason: `${write.path} is not written: ${linked} is a symbolic link or junction; the handoff proceeds without it.`,
          });
          continue;
        }
        // C2e (F-matrix): a tracked file where docs/ or docs/project/ is
        // expected, or a tracked directory where STATE.md is expected,
        // stalls every attempt today (ENOTDIR/EEXIST/EISDIR from the write
        // below). The kernel skips STATE.md instead with the same
        // tree-derived reason the commit walk reports (dirLinks), which
        // the AR-R05 gate accepts exactly as the CD-17 link reason -- and
        // the run hands off. Nothing is written under the blocker.
        if (write.path === "docs/project/STATE.md") {
          const blocker = await this.commitStateNonLinkBlocker("HEAD");
          if (blocker !== null) {
            // C2e repair cycle 1 (N-1): the recorded skip names the
            // blocker accurately; a case collision keeps the legacy
            // wording so stored logs replay unchanged.
            const reasonKind = stateBlockerReasonKind(blocker.kind);
            skipped.push({
              path: write.path,
              reason: reasonKind === null
                ? handoffStateSkipReason(blocker.component)
                : handoffStateBlockerSkipReason(blocker.component, reasonKind),
            });
            continue;
          }
        }
      }
      if (!skipClaudeAgentsLink && write.path !== "AGENTS.md" && write.path !== "CLAUDE.md" && write.path.toLowerCase().startsWith("docs/")) {
        // C2e (F-matrix): the v1 Architect path refuses with a clear
        // reason naming the blocker (as it does for a docs link), never
        // with a raw ENOTDIR/EEXIST/EISDIR crash from the write below.
        // C2e repair cycle 1 (N-2): only the write the blocker can
        // affect is refused -- a directory (or submodule entry, or
        // case collision) at STATE.md never blocks an unrelated write
        // like docs/project/README.md. N-1/N-3: a submodule entry is
        // named accurately.
        // C2e repair cycle 2 (N-R2-1): any blocker ABOVE STATE.md (at
        // `docs` or `docs/project`, whatever its kind) blocks every write
        // under docs/ -- nothing below a file, a submodule entry or a
        // collision can be written, so the batch is refused here, before
        // any write lands, instead of failing later on a raw `git add`
        // with a stray file left behind.
        const blocker = await this.commitStateNonLinkBlocker("HEAD");
        if (blocker !== null && (blocker.component !== "docs/project/STATE.md" || write.path === "docs/project/STATE.md")) {
          throw new Error(
            blocker.kind === "file-not-dir"
              ? `Project document path ${write.path} is refused because ${blocker.component} is a regular file, not a directory.`
              : blocker.kind === "case-collision"
                ? `Project document path ${write.path} is refused because the commit tree tracks two spellings of ${blocker.component}.`
                : blocker.kind === "submodule"
                  ? `Project document path ${write.path} is refused because ${blocker.component} is a submodule entry.`
                  : `Project document path ${write.path} is refused because ${blocker.component} is a directory.`,
          );
        }
      }
      if (skipClaudeAgentsLink && (write.path === "AGENTS.md" || write.path === "CLAUDE.md")) {
        const link = await this.entryLinkRawTarget(write.path);
        if (link.isLink) {
          const target = link.raw === undefined ? null : resolveEntryLinkTarget(link.raw);
          const display = (link.raw ?? "").replace(/\s+/g, " ").trim().slice(0, 120) || "an unreadable target";
          if (target !== null && await this.isEntryLinkRedirectTarget(target)) {
            planned.push({ writePath: write.path, physicalPath: target, content: write.content });
            redirected.push({
              path: write.path,
              target,
              reason: `${write.path} is a symbolic link to ${target}; the section is written into ${target}.`,
            });
          } else {
            // C2c repair cycle 2 (m-4): name the real cause. A target that
            // resolves but sits under a linked directory (a junction above
            // it) is refused for the junction, not for its own tracking.
            const ancestor = target !== null ? await this.ancestorLinkComponent(target) : null;
            const detail = entryLinkSkipDetail(link.raw ?? "", target, ancestor);
            skipped.push({
              path: write.path,
              reason: `${write.path} is a symbolic link to ${display}; the entry is skipped (${detail}).`,
            });
          }
          continue;
        }
        // C2d repair cycle 1 (escalation): a non-link entry the tree
        // tracks under two spellings (say `AGENTS.md` with `agents.md`)
        // is skipped with a recorded, commit-tree-derived reason the
        // AR-R05 gate accepts. On disk there is one file, so splicing
        // the section would substitute one entry's bytes for the other's
        // and pause every attempt at the gate. Link layouts keep the
        // link machinery above; the v1 Architect path below is unchanged.
        const spellings = write.path === "AGENTS.md" ? entryCollisions.agents : entryCollisions.claude;
        if (spellings.length > 1 && spellings[0] !== undefined && spellings[1] !== undefined) {
          skipped.push({
            path: write.path,
            reason: handoffEntryCollisionSkipReason(
              write.path === "AGENTS.md" ? "AGENTS.md" : "CLAUDE.md",
              spellings[0],
              spellings[1],
            ),
          });
          continue;
        }
      }
      await this.refuseProjectDocLink(write.path);
      planned.push({ writePath: write.path, physicalPath: realPath, content: write.content });
    }
    // Two entry writes can land on one physical file (AGENTS.md linking to
    // CLAUDE.md): the marked section holds a single body, so the AGENTS.md
    // body wins alone.
    // C2c repair M-6: the @AGENTS.md pointer is never merged into a file
    // AGENTS.md resolves to -- it would import the file into itself. The
    // omission is recorded below; the runtime accepts it when the commit
    // tree proves the redirect, so both entry lines still count.
    // C2d: a physical path that only differs in case from the entry file
    // (a lowercase `agents.md` regular file) is the entry's own file, not a
    // redirect -- otherwise the M-6 omission below would drop the CLAUDE.md
    // pointer for a layout that holds two distinct entry files.
    // C2d repair cycle 1 (m-1): the omission compares folded -- a CLAUDE.md
    // write resolving to the index's own `claude.md` spelling is the same
    // file as an AGENTS.md redirect into `CLAUDE.md` only when the
    // spellings agree case-insensitively.
    const agentsRedirectTargets = new Set(
      planned
        .filter((op) => op.writePath === "AGENTS.md" && op.physicalPath.toLowerCase() !== "agents.md")
        .map((op) => op.physicalPath.toLowerCase()),
    );
    const merged = new Map<string, { entry: boolean; bodies: string[] }>();
    let claudePointerOmittedFor: string | null = null;
    for (const op of planned) {
      if (op.writePath === "CLAUDE.md" && agentsRedirectTargets.has(op.physicalPath.toLowerCase())) {
        claudePointerOmittedFor = op.physicalPath;
        continue;
      }
      const slot = merged.get(op.physicalPath) ?? { entry: false, bodies: [] };
      slot.entry = slot.entry || op.writePath === "AGENTS.md" || op.writePath === "CLAUDE.md";
      slot.bodies.push(op.content);
      merged.set(op.physicalPath, slot);
    }
    if (claudePointerOmittedFor !== null) {
      skipped.push({
        path: "CLAUDE.md",
        reason: `CLAUDE.md pointer omitted: AGENTS.md resolves to ${claudePointerOmittedFor}, so @AGENTS.md here would import the file into itself; the AGENTS.md section satisfies both entry lines.`,
      });
      for (let index = redirected.length - 1; index >= 0; index -= 1) {
        if (redirected[index]?.path === "CLAUDE.md" && redirected[index]?.target === claudePointerOmittedFor) {
          redirected.splice(index, 1);
        }
      }
    }
    const stagedPaths: string[] = [];
    for (const [physicalPath, slot] of merged) {
      const absolute = this.containedProjectDocPath(physicalPath);
      if (slot.entry) {
        // C2b repair m3: splice on bytes, never through a string decode. The
        // markers and section bodies are ASCII, so bytes outside the markers
        // survive untouched even when the file is not valid UTF-8, and the
        // inserted section takes the file's own line ending. This is strictly
        // safer for the v1 Architect path too (same preservation; UTF-8 files
        // behave exactly as before), so both paths share it. A redirected
        // write splices into the TARGET path (never through the link), so
        // the target's own bytes outside the markers survive too.
        let existing: Buffer | null = null;
        try {
          existing = await readFile(absolute);
        } catch (error) {
          if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        }
        await writeFile(absolute, spliceMarkedArchitectSectionBytes(existing, slot.bodies.join("\n")));
      } else {
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, slot.bodies.join("\n"));
      }
      stagedPaths.push(physicalPath);
    }
    return { staged: stagedPaths, skipped, redirected };
  }

  /**
   * Commit Architect project documents on the integration branch.
   * A request id already present in a commit body is returned unchanged.
   * A new request still commits when the tree is unchanged.
   */
  async commitProjectDocuments(
    input: ProjectDocCommitRequest,
  ): Promise<ProjectDocCommitResult> {
    return await this.serialized(async () => {
      if (input.runId !== this.runId) {
        throw new Error("Project document commit belongs to another run.");
      }
      if (!input.summary.trim() || input.summary.includes("\n") || input.summary.includes("\0")) {
        throw new Error("Project document summary is invalid.");
      }
      if (!input.requestId.trim() || /[\r\n\0]/.test(input.requestId)) {
        throw new Error("Project document request id is invalid.");
      }
      if (input.writes.length === 0) {
        throw new Error("Project document commit requires at least one write.");
      }
      await this.ensureIntegrationWorkspace();
      const existing = await this.findDocumentCommit(input.requestId);
      if (existing) {
        return await this.documentCommitResult(existing);
      }
      // C2b repair N-4: the v1 Architect path never skips a link; a
      // CLAUDE.md link to AGENTS.md is refused exactly as at HEAD.
      const { staged: paths, skipped } = await this.stageProjectDocWrites(input.writes, { skipClaudeAgentsLink: false });
      if (paths.length === 0) {
        throw new Error(`Project document commit wrote nothing: ${skipped.map((entry) => entry.reason).join(" ") || "every write was skipped."}`);
      }
      await this.git(this.path, ["add", "--", ...paths]);
      try {
        await this.execute({
          cwd: this.path,
          args: [
            "commit",
            "--allow-empty",
            "-m",
            input.summary,
            "--trailer",
            `AIBoard-Run: ${input.runId}`,
            "--trailer",
            "AIBoard-Author: architect",
            "--trailer",
            `AIBoard-Doc-Request: ${input.requestId}`,
            "--",
            ...paths,
          ],
          env: ARCHITECT_DOC_IDENTITY,
        });
      } catch (error) {
        await this.git(this.path, ["reset", "--hard", "HEAD"], true);
        await this.git(this.path, ["clean", "-fd", "--", ...paths], true);
        throw error;
      }
      const commit = await this.head();
      this.currentRevision = commit;
      const committed = await this.documentCommitResult(commit);
      // C2b repair m5: a skipped CLAUDE.md link is recorded on the result
      // so the skip is never silent; the v1 checks themselves are unchanged.
      if (skipped.length > 0) committed.skipped = skipped;
      return committed;
    });
  }

  /** Classify an integrated revision against the document tip. Equal is not a descendant. */
  async relateToDocumentTip(input: {
    revision: string;
    tip: string;
  }): Promise<DocumentTipRelation> {
    return await this.serialized(async () => {
      await this.ensureIntegrationWorkspace();
      if (input.revision === input.tip) return "equal_to_tip";
      const descendant = await this.git(
        this.path,
        ["merge-base", "--is-ancestor", input.tip, input.revision],
        true,
      );
      if (descendant.exitCode === 0) return "strict_descendant";
      const ancestor = await this.git(
        this.path,
        ["merge-base", "--is-ancestor", input.revision, input.tip],
        true,
      );
      if (ancestor.exitCode === 0) return "ancestor";
      throw new Error("Integrated revision is not related to the document tip.");
    });
  }

  async applyToProject(): Promise<ProjectHandoffResult> {
    return await this.serialized(async () => {
      await this.ensureIntegrationWorkspace();
      const recovered = await this.recoverProjectApply();
      if (recovered) return recovered;
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
      const handoffDirectory = resolve(this.stateDirectory, "handoff");
      const transitionId = randomUUID();
      const transitionSegment = safeName(transitionId);
      const transitionRef = `refs/aiboard/runs/${this.runSegment}/handoff/${transitionSegment}`;
      const patchFile = `${this.runSegment}.${transitionSegment}.patch`;
      const indexFile = `${this.runSegment}.${transitionSegment}.index`;
      const patchPath = resolve(
        handoffDirectory,
        patchFile
      );
      const indexPath = resolve(
        handoffDirectory,
        indexFile
      );
      let preserveHandoffFiles = false;
      if (
        relative(handoffDirectory, patchPath).startsWith("..") ||
        relative(handoffDirectory, indexPath).startsWith("..")
      ) {
        throw new Error("Project handoff files escaped the runner state directory.");
      }
      await mkdir(handoffDirectory, { recursive: true });
      await rm(indexPath, { force: true });
      await rm(`${indexPath}.lock`, { force: true });
      // C2e (G1): the integration diff of a large tree (40,000 files under
      // docs/generated/) exceeds the 4 MiB git output cap, so buffering the
      // whole diff refuses the owner's selection. Git writes the patch file
      // directly (--output) instead: the runner's git output stays a few
      // bytes no matter how large the tree is, while the patch bytes -- and
      // every downstream guarantee (conflict refusal via --check, the audit
      // patch file, the journal) -- are unchanged.
      // C2e repair cycle 2 (crash leak): a failed diff call never leaves
      // a partial patch file behind.
      try {
        await this.git(this.path, [
          "diff",
          "--binary",
          "--full-index",
          `--output=${patchPath}`,
          this.baselineRevision,
          this.revision,
          "--",
        ]);
      } catch (error) {
        await rm(patchPath, { force: true });
        throw error;
      }
      if ((await stat(patchPath)).size === 0) {
        await rm(patchPath, { force: true });
        return this.descriptor(true, projectRevision);
      }
      if (await this.isAppliedProjectCommit(projectRevision)) {
        await rm(patchPath, { force: true });
        return this.descriptor(true, projectRevision);
      }
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
            `AIBoard-Run: ${this.runId}\nAIBoard-Integration: ${this.revision}\nAIBoard-Transition: ${transitionId}`,
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
        const journal: OwnedProjectApplyJournal = {
          version: 2,
          state: "prepared",
          runId: this.runId,
          projectIdentity: await this.projectIdentity(),
          projectBranch: projectBranch.stdout.trim(),
          expectedParent: projectRevision,
          targetCommit: committedRevision,
          integrationRevision: this.revision,
          transitionId,
          transitionRef,
          patchFile,
          indexFile,
        };
        await this.assertCheckoutWillNotOverwriteUntracked(
          projectRevision,
          committedRevision,
          `${indexPath}.names`
        );
        const ownership = await this.git(
          this.repositoryRoot,
          ["update-ref", transitionRef, projectRevision, ""],
          true
        );
        if (ownership.exitCode !== 0) {
          throw new Error("The automatic handoff transition could not claim ownership.");
        }
        let journalPath: string;
        try {
          journalPath = await this.writeProjectApplyJournal(journal, transitionId);
        } catch (error) {
          await this.git(
            this.repositoryRoot,
            ["update-ref", "-d", transitionRef, projectRevision],
            true
          );
          throw error;
        }
        if (this.afterProjectApplyJournalWritten) {
          try {
            await this.afterProjectApplyJournalWritten({
              projectBranch: projectBranch.stdout.trim(),
              expectedParent: projectRevision,
              targetCommit: committedRevision,
              journalPath,
            });
          } catch (error) {
            preserveHandoffFiles = true;
            throw error;
          }
        }
        try {
          await this.assertProjectUnchanged(projectBranch.stdout.trim(), projectRevision);
        } catch (error) {
          await this.cleanupOwnedProjectApply({ path: journalPath, journal }, projectRevision);
          throw error;
        }
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
          await this.cleanupOwnedProjectApply({ path: journalPath, journal }, projectRevision);
          throw new Error("The project changed during automatic handoff.");
        }
        if (this.afterProjectBranchAdvanced) {
          try {
            await this.afterProjectBranchAdvanced({
              projectBranch: projectBranch.stdout.trim(),
              expectedParent: projectRevision,
              targetCommit: committedRevision,
              journalPath,
            });
          } catch (error) {
            preserveHandoffFiles = true;
            throw error;
          }
        }
        const ownershipAdvanced = await this.git(
          this.repositoryRoot,
          ["update-ref", transitionRef, committedRevision, projectRevision],
          true
        );
        if (ownershipAdvanced.exitCode !== 0) {
          preserveHandoffFiles = true;
          throw new Error("The automatic handoff transition ownership could not advance.");
        }
        if (this.afterProjectRefAdvanced) {
          try {
            await this.afterProjectRefAdvanced({
              projectBranch: projectBranch.stdout.trim(),
              expectedParent: projectRevision,
              targetCommit: committedRevision,
              journalPath,
            });
          } catch (error) {
            preserveHandoffFiles = true;
            throw error;
          }
        }
        try {
          await this.assertCheckoutWillNotOverwriteUntracked(
            projectRevision,
            committedRevision,
            `${indexPath}.names`
          );
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
          // C2e repair cycle 2 (N-R2-3): the repair check itself must
          // never replace the original error -- a throw from the listing
          // or the match only skips the cleanup, then the original
          // failure propagates.
          let rolledBackClean = false;
          try {
            rolledBackClean = await this.projectMatchesRevision(
              projectRevision,
              await this.applyChangedPathSet(projectRevision, committedRevision),
            );
          } catch {
            rolledBackClean = false;
          }
          if (rolledBackClean) {
            await this.cleanupOwnedProjectApply(
              { path: journalPath, journal },
              committedRevision
            );
          }
          throw error;
        }
        preserveHandoffFiles = true;
        await this.retireAbandonedBeforeWinnerCleanup(committedRevision);
        await this.cleanupOwnedProjectApply(
          { path: journalPath, journal },
          committedRevision,
          "winner"
        );
        return this.descriptor(true, committedRevision);
      } finally {
        if (!preserveHandoffFiles) {
          await rm(patchPath, { force: true });
          await rm(indexPath, { force: true });
          await rm(`${indexPath}.lock`, { force: true });
          // C2e repair cycle 2 (crash leak): the written-path check's
          // scratch file shares the transition index name.
          await rm(`${indexPath}.names`, { force: true });
        }
      }
    });
  }

  private async recoverProjectApply(): Promise<ProjectHandoffResult | null> {
    let records = await this.readProjectApplyJournals();
    if (records.length === 0) return null;
    const fail = (reason: string): never => {
      throw new Error(
        `The journaled automatic handoff cannot be recovered safely: ${reason}`
      );
    };
    const projectIdentity = await this.projectIdentity();
    for (const { journal } of records) {
      if (
        ![1, 2].includes(journal.version) ||
        journal.runId !== this.runId ||
        journal.integrationRevision !== this.revision ||
        journal.projectIdentity !== projectIdentity ||
        !journal.projectBranch.startsWith("refs/heads/") ||
        !isRevision(journal.expectedParent) ||
        !isRevision(journal.targetCommit)
      ) {
        fail("its recorded project or run identity does not match.");
      }
      if (journal.version === 2) {
        try {
          this.ownedProjectApplyPaths(journal);
          const preparedStateIsValid =
            journal.state === "prepared" &&
            journal.retiringOwnershipRevision === undefined &&
            journal.retirementKind === undefined &&
            journal.winningRevision === undefined;
          const retiringStateIsValid =
            journal.state === "retiring" &&
            [journal.expectedParent, journal.targetCommit].includes(
              journal.retiringOwnershipRevision ?? ""
            ) &&
            (
              (journal.retirementKind === "winner" &&
                journal.winningRevision === journal.targetCommit) ||
              (journal.retirementKind === "abandoned" &&
                journal.winningRevision === undefined)
            );
          if (
            !preparedStateIsValid &&
            !retiringStateIsValid
          ) {
            throw new Error("Invalid transition retirement state.");
          }
        } catch {
          fail("its transition ownership metadata is invalid.");
        }
      }
    }
    const branch = await this.git(
      this.repositoryRoot,
      ["symbolic-ref", "--quiet", "HEAD"],
      true
    );
    const head = (
      await this.git(this.repositoryRoot, ["rev-parse", "--verify", "HEAD^{commit}"])
    ).stdout.trim();
    if (
      branch.exitCode !== 0 ||
      records.some(({ journal }) => branch.stdout.trim() !== journal.projectBranch)
    ) {
      fail("the checked-out branch does not match the journal.");
    }
    let recoveredRetiringWinner:
      | { path: string; journal: OwnedProjectApplyJournal }
      | undefined;
    for (const record of records) {
      const journal = record.journal;
      if (journal.version !== 2 || journal.state !== "retiring") continue;
      const retirementRevision = journal.retiringOwnershipRevision!;
      if (journal.retirementKind === "winner") {
        if (
          head !== journal.targetCommit ||
          !await this.projectMatchesRevision(
            journal.targetCommit,
            await this.applyChangedPathSet(journal.expectedParent, journal.targetCommit),
          )
        ) {
          fail("a retiring winning transition no longer matches the project state.");
        }
        recoveredRetiringWinner = record as {
          path: string;
          journal: OwnedProjectApplyJournal;
        };
        continue;
      } else if (head === journal.targetCommit) {
        fail("a retiring abandoned transition unexpectedly became the project head.");
      }
      await this.cleanupOwnedProjectApply(
        record as { path: string; journal: OwnedProjectApplyJournal },
        retirementRevision
      );
    }
    if (recoveredRetiringWinner) {
      await this.retireAbandonedBeforeWinnerCleanup(
        recoveredRetiringWinner.journal.targetCommit
      );
      await this.cleanupOwnedProjectApply(
        recoveredRetiringWinner,
        recoveredRetiringWinner.journal.retiringOwnershipRevision!,
        "winner"
      );
      return this.descriptor(true, recoveredRetiringWinner.journal.targetCommit);
    }
    records = await this.readProjectApplyJournals();
    if (records.length === 0) return null;
    const matching = records.filter(({ journal }) => journal.targetCommit === head);
    if (matching.length === 0) {
      if (records.every(({ journal }) => journal.expectedParent === head)) {
        // C2e repair cycle 1 (B-1): the clobber check covers the union of
        // the paths the journaled applies would write, never a
        // whole-project listing.
        const written = new Set<string>();
        for (const { journal: pending } of records) {
          for (const path of await this.applyChangedPathSet(pending.expectedParent, pending.targetCommit)) {
            written.add(path);
          }
        }
        if (!await this.projectMatchesRevision(head, written)) {
          fail("the pre-advance project state contains unrelated changes.");
        }
        return null;
      }
      fail("the project ref moved after the journal was written.");
    }
    const record = matching[0];
    const { journal } = record;
    const parent = await this.git(
      this.repositoryRoot,
      ["rev-parse", "--verify", `${journal.targetCommit}^`],
      true
    );
    if (parent.exitCode !== 0 || parent.stdout.trim() !== journal.expectedParent) {
      fail("the target commit parent does not match the journal.");
    }
    if (!await this.isAppliedProjectCommit(journal.targetCommit)) {
      fail("the target commit is not this run's integrated result.");
    }

    // C2e repair cycle 1 (B-1): the clobber check covers the paths this
    // journaled apply writes, never a whole-project listing.
    const written = await this.applyChangedPathSet(journal.expectedParent, journal.targetCommit);
    if (await this.projectMatchesRevision(journal.targetCommit, written)) {
      await this.retireAbandonedBeforeWinnerCleanup(journal.targetCommit);
      await this.completeRecoveredProjectApply(record);
      return this.descriptor(true, journal.targetCommit);
    }
    if (!await this.projectMatchesRevision(journal.expectedParent, written)) {
      fail("the post-advance index or worktree contains unrelated changes.");
    }
    const repaired = await this.git(
      this.repositoryRoot,
      ["read-tree", "-u", "-m", journal.expectedParent, journal.targetCommit],
      true
    );
    if (repaired.exitCode !== 0 || !await this.projectMatchesRevision(journal.targetCommit, written)) {
      fail(`the exact journaled checkout could not be repaired: ${repaired.stderr.trim()}`);
    }
    await this.retireAbandonedBeforeWinnerCleanup(journal.targetCommit);
    await this.completeRecoveredProjectApply(record);
    return this.descriptor(true, journal.targetCommit);
  }

  private async projectMatchesRevision(revision: string, writtenPaths: ReadonlySet<string>): Promise<boolean> {
    const [indexTree, revisionTree, worktree] = await Promise.all([
      this.git(this.repositoryRoot, ["write-tree"], true),
      this.git(this.repositoryRoot, ["rev-parse", `${revision}^{tree}`], true),
      this.git(this.repositoryRoot, ["diff", "--quiet"], true),
    ]);
    if (!(
      indexTree.exitCode === 0 &&
      revisionTree.exitCode === 0 &&
      indexTree.stdout.trim() === revisionTree.stdout.trim() &&
      worktree.exitCode === 0
    )) return false;
    // C2e repair cycle 1 (B-1): no whole-project `ls-files --others`
    // listing ever enters a capped buffer -- it includes every IGNORED
    // file (invisible to `git status --porcelain`) and overflows the cap
    // on node_modules-sized trees. Two checks replace it. First, a plain
    // untracked listing with the standard excludes: a user file sitting
    // anywhere outside the apply still blocks recovery, exactly as
    // before, with the same exposure as the apply's own `status
    // --porcelain` clean check. Second, the paths the pending apply
    // writes are checked in byte-bounded chunks of literal pathspecs,
    // WITHOUT --exclude-standard: `--others` still reports ignored files
    // at those paths, so crash recovery still refuses when an ignored
    // file sits at a target path instead of overwriting it.
    // C2e repair cycle 2 (N-R2-2): more than ~4 MiB of non-ignored
    // untracked paths would overflow the capped buffer instead of proving
    // anything -- that only means "not proven clean", so recovery refuses
    // (false) instead of throwing on tree size. Fail-closed either way.
    let untracked;
    try {
      untracked = await this.git(this.repositoryRoot, [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
      ], true);
    } catch (error) {
      if (error instanceof GitCommandError && error.code === "output_limit") return false;
      throw error;
    }
    if (untracked.exitCode !== 0 || untracked.stdout.length > 0) return false;
    for (const chunk of chunkLiteralPathspecs([...writtenPaths])) {
      const present = await this.git(this.repositoryRoot, [
        "ls-files",
        "--others",
        "-z",
        "--",
        ...chunk,
      ], true);
      if (present.exitCode !== 0 || present.stdout.length > 0) return false;
    }
    return true;
  }

  /**
   * The paths one apply revision changes into the next (C2e repair cycle
   * 1, B-1): the changed-name listing goes through `diff --output` into a
   * scratch file (removed before returning) instead of one capped git
   * buffer, so the set stays available no matter how large the tree is.
   */
  private async applyChangedPathSet(fromRevision: string, toRevision: string): Promise<Set<string>> {
    const directory = resolve(this.stateDirectory, "handoff");
    await mkdir(directory, { recursive: true });
    const scratchPath = resolve(directory, `${this.runSegment}.${safeName(randomUUID())}.names`);
    if (relative(directory, scratchPath).startsWith("..")) {
      throw new Error("Project handoff files escaped the runner state directory.");
    }
    try {
      // C2e repair cycle 2 (N-R2-3): the diff call sits inside the try so
      // a failed or crashed call never leaves a partial scratch file.
      await this.git(this.repositoryRoot, [
        "diff",
        "--name-only",
        "-z",
        `--output=${scratchPath}`,
        fromRevision,
        toRevision,
        "--",
      ]);
      return new Set((await readFile(scratchPath)).toString("utf8").split("\0").filter(Boolean));
    } finally {
      await rm(scratchPath, { force: true });
    }
  }

  private async projectIdentity(): Promise<string> {
    const gitDirectory = (
      await this.git(this.repositoryRoot, ["rev-parse", "--absolute-git-dir"])
    ).stdout.trim();
    return createHash("sha256")
      .update(`${this.repositoryRoot}\0${gitDirectory}`)
      .digest("hex");
  }

  private projectApplyJournalPath(transitionId?: string): string {
    const directory = resolve(this.stateDirectory, "handoff");
    const suffix = transitionId ? `.${safeName(transitionId)}` : "";
    const path = resolve(directory, `${this.runSegment}${suffix}.apply.json`);
    if (relative(directory, path).startsWith("..")) {
      throw new Error("Project apply journal escaped the runner state directory.");
    }
    return path;
  }

  private async readProjectApplyJournals(): Promise<Array<{
    path: string;
    journal: ProjectApplyJournal;
  }>> {
    const directory = resolve(this.stateDirectory, "handoff");
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw new Error("The project apply journal directory is unreadable.", { cause: error });
    }
    const prefix = `${this.runSegment}.`;
    const legacy = `${this.runSegment}.apply.json`;
    const paths = names
      .filter((name) => name === legacy || (name.startsWith(prefix) && name.endsWith(".apply.json")))
      .sort()
      .map((name) => resolve(directory, name));
    try {
      return await Promise.all(paths.map(async (path) => {
        const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
        if (!parsed || typeof parsed !== "object") {
          throw new Error("Project apply journal must be an object.");
        }
        return { path, journal: parsed as ProjectApplyJournal };
      }));
    } catch (error) {
      throw new Error("The project apply journal is unreadable.", { cause: error });
    }
  }

  private async writeProjectApplyJournal(
    journal: ProjectApplyJournal,
    transitionId: string
  ): Promise<string> {
    const path = this.projectApplyJournalPath(transitionId);
    await this.persistProjectApplyJournal(path, journal);
    return path;
  }

  private async persistProjectApplyJournal(
    path: string,
    journal: ProjectApplyJournal
  ): Promise<void> {
    const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(resolve(path, ".."), { recursive: true });
    try {
      await writeFile(temporary, `${JSON.stringify(journal)}\n`, { flag: "wx" });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async clearProjectApplyJournal(path: string): Promise<void> {
    await rm(path, { force: true });
  }

  private ownedProjectApplyPaths(journal: OwnedProjectApplyJournal): {
    patchPath: string;
    indexPath: string;
  } {
    const transitionSegment = safeName(journal.transitionId);
    const expectedRef = `refs/aiboard/runs/${this.runSegment}/handoff/${transitionSegment}`;
    const expectedPatch = `${this.runSegment}.${transitionSegment}.patch`;
    const expectedIndex = `${this.runSegment}.${transitionSegment}.index`;
    if (
      journal.transitionRef !== expectedRef ||
      journal.patchFile !== expectedPatch ||
      journal.indexFile !== expectedIndex
    ) {
      throw new Error("Project apply transition ownership metadata is invalid.");
    }
    const directory = resolve(this.stateDirectory, "handoff");
    const patchPath = resolve(directory, journal.patchFile);
    const indexPath = resolve(directory, journal.indexFile);
    if (
      relative(directory, patchPath).startsWith("..") ||
      relative(directory, indexPath).startsWith("..")
    ) {
      throw new Error("Project apply transition artifacts escaped runner state.");
    }
    return { patchPath, indexPath };
  }

  private async cleanupOwnedProjectApply(
    record: { path: string; journal: OwnedProjectApplyJournal },
    expectedOwnershipRevision: string,
    retirementKind: "winner" | "abandoned" = "abandoned"
  ): Promise<void> {
    let journal = record.journal;
    const { patchPath, indexPath } = this.ownedProjectApplyPaths(journal);
    if (journal.state === "prepared") {
      const ownership = await this.git(
        this.repositoryRoot,
        ["rev-parse", "--verify", journal.transitionRef],
        true
      );
      if (
        ownership.exitCode !== 0 ||
        ownership.stdout.trim() !== expectedOwnershipRevision
      ) {
        throw new Error("Project apply transition ownership changed unexpectedly.");
      }
      journal = {
        ...journal,
        state: "retiring",
        retiringOwnershipRevision: expectedOwnershipRevision,
        retirementKind,
        ...(retirementKind === "winner"
          ? { winningRevision: journal.targetCommit }
          : {}),
      };
      record.journal = journal;
      await this.persistProjectApplyJournal(record.path, journal);
    } else if (
      journal.retiringOwnershipRevision !== expectedOwnershipRevision ||
      journal.retirementKind !== retirementKind
    ) {
      throw new Error("Project apply transition retirement ownership is ambiguous.");
    }
    const ownership = await this.git(
      this.repositoryRoot,
      ["rev-parse", "--verify", journal.transitionRef],
      true
    );
    if (ownership.exitCode === 0 && ownership.stdout.trim() !== expectedOwnershipRevision) {
      throw new Error("Project apply transition ownership changed unexpectedly.");
    }
    if (ownership.exitCode === 0) {
      const released = await this.git(
        this.repositoryRoot,
        [
          "update-ref",
          "-d",
          journal.transitionRef,
          expectedOwnershipRevision,
        ],
        true
      );
      if (released.exitCode !== 0) {
        throw new Error("Project apply transition ownership could not be released.");
      }
      if (this.afterProjectApplyOwnershipReleased) {
        await this.afterProjectApplyOwnershipReleased({
          expectedOwnershipRevision,
          retirementKind,
          targetCommit: journal.targetCommit,
          journalPath: record.path,
        });
      }
    }
    await rm(patchPath, { force: true });
    await rm(indexPath, { force: true });
    await rm(`${indexPath}.lock`, { force: true });
    // C2e repair cycle 2 (crash leak): the written-path check's scratch
    // file shares the transition index name; a crash between the check
    // and this cleanup leaves it behind otherwise.
    await rm(`${indexPath}.names`, { force: true });
    await this.clearProjectApplyJournal(record.path);
  }

  private async completeRecoveredProjectApply(record: {
    path: string;
    journal: ProjectApplyJournal;
  }): Promise<void> {
    if (record.journal.version === 1) {
      await this.clearProjectApplyJournal(record.path);
      return;
    }
    const ownership = await this.git(
      this.repositoryRoot,
      ["rev-parse", "--verify", record.journal.transitionRef],
      true
    );
    const revision = ownership.stdout.trim();
    if (
      ownership.exitCode !== 0 ||
      ![record.journal.expectedParent, record.journal.targetCommit].includes(revision)
    ) {
      throw new Error("The winning project apply transition ownership is ambiguous.");
    }
    await this.cleanupOwnedProjectApply(record as {
      path: string;
      journal: OwnedProjectApplyJournal;
    }, revision, "winner");
  }

  private async retireAbandonedBeforeWinnerCleanup(
    currentHead: string
  ): Promise<void> {
    await this.retireAbandonedProjectApplies(currentHead);
    await this.afterAbandonedProjectAppliesRetired?.({ targetCommit: currentHead });
  }

  private async retireAbandonedProjectApplies(currentHead: string): Promise<void> {
    const records = await this.readProjectApplyJournals();
    for (const record of records) {
      const journal = record.journal;
      if (
        journal.version !== 2 ||
        journal.targetCommit === currentHead ||
        journal.expectedParent === currentHead
      ) continue;
      this.ownedProjectApplyPaths(journal);
      const ownership = await this.git(
        this.repositoryRoot,
        ["rev-parse", "--verify", journal.transitionRef],
        true
      );
      if (
        ownership.exitCode !== 0 ||
        ownership.stdout.trim() !== journal.expectedParent
      ) {
        throw new Error("An abandoned project apply transition cannot be retired safely.");
      }
      await this.cleanupOwnedProjectApply(record as {
        path: string;
        journal: OwnedProjectApplyJournal;
      }, journal.expectedParent);
    }
  }

  private async assertCheckoutWillNotOverwriteUntracked(
    fromRevision: string,
    toRevision: string,
    scratchPath: string
  ): Promise<void> {
    // C2e (G1): the changed-name listing of a large apply is a whole-tree
    // listing too, so it also goes through --output into a scratch file
    // (removed before returning) instead of one capped git buffer.
    // C2e repair cycle 1 (B-1): the untracked listing below used to be
    // buffered the same way, but `ls-files --others` without
    // --exclude-standard reports every IGNORED file too, which `git status
    // --porcelain` never shows -- a project with a large ignored tree
    // (node_modules-sized) refused a tiny apply on the 4 MiB cap. Only the
    // paths the apply will write are checked now, in byte-bounded chunks
    // of literal pathspecs (C2e repair cycle 2, B-2): each git call's
    // output holds only collisions, so it stays a few bytes no matter how
    // many ignored files the project holds, and no call's command line
    // overflows no matter how long the paths are. `--others` still
    // reports ignored files at those paths, so the ignored-path collision
    // refusal is exactly as strong; `:(literal)` keeps glob characters in
    // file names exact.
    try {
      // C2e repair cycle 2 (N-R2-3): the diff call sits inside the try so
      // a failed or crashed call never leaves a partial scratch file.
      await this.git(this.repositoryRoot, [
        "diff",
        "--name-only",
        "-z",
        `--output=${scratchPath}`,
        fromRevision,
        toRevision,
        "--",
      ]);
      const changedBytes = await readFile(scratchPath);
      const changedPaths = changedBytes.toString("utf8").split("\0").filter(Boolean);
      const changedSet = new Set(changedPaths);
      for (const chunk of chunkLiteralPathspecs(changedPaths)) {
        const untracked = await this.git(this.repositoryRoot, [
          "ls-files",
          "--others",
          "-z",
          "--",
          ...chunk,
        ]);
        const collision = untracked.stdout
          .split("\0")
          .filter(Boolean)
          .find((path) => changedSet.has(path));
        if (collision) {
          throw new Error(
            `Automatic project handoff would overwrite the untracked or ignored path ${collision}.`
          );
        }
      }
    } finally {
      await rm(scratchPath, { force: true });
    }
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

  private async recoverEmptyLegacyWorkspace(): Promise<boolean> {
    const branchRevision = await this.verifiedEmptyLegacyRevision();
    if (!branchRevision) return false;
    await rmdir(this.path);
    await this.git(this.repositoryRoot, [
      "worktree",
      "prune",
      "--expire",
      "now",
    ]);
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
        this.branch,
        this.path
      ) !== "none"
    ) {
      throw new Error("Integration branch still has an unexpected worktree path.");
    }
    await this.git(this.repositoryRoot, [
      "worktree",
      "add",
      this.path,
      this.branch.slice("refs/heads/".length),
    ]);
    await this.assertWorkspace();
    const restoredRevision = await this.head();
    if (restoredRevision !== branchRevision) {
      throw new Error("Integration branch changed during workspace recovery.");
    }
    this.currentRevision = restoredRevision;
    return true;
  }

  private async retainEmptyLegacyWorkspaceForCleanup(): Promise<boolean> {
    const branchRevision = await this.verifiedEmptyLegacyRevision();
    if (!branchRevision) return false;
    this.currentRevision = branchRevision;
    return true;
  }

  private async verifiedEmptyLegacyRevision(): Promise<string | null> {
    if (!(await pathExists(this.path)) || !(await isEmptyDirectory(this.path))) {
      return null;
    }
    const branchRevision = await this.resolveRef(this.branch);
    if (!branchRevision) return null;
    const associations = parseWorktreeAssociations(
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
      classifyOwnedWorktreeAssociations(associations, this.branch, this.path) ===
      "unexpected"
    ) {
      throw new Error("Integration branch has an unexpected worktree path.");
    }
    const ancestry = await this.git(
      this.repositoryRoot,
      ["merge-base", "--is-ancestor", this.baselineRevision, branchRevision],
      true
    );
    if (ancestry.exitCode !== 0) {
      throw new Error("Integration branch escaped its run baseline.");
    }
    return branchRevision;
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

  private async findDocumentCommit(requestId: string): Promise<string | null> {
    const needle = `AIBoard-Doc-Request: ${requestId}`;
    for (const commit of await this.commitBodies()) {
      if (commit.body.split(/\r?\n/).some((line) => line.trim() === needle)) {
        return commit.revision;
      }
    }
    return null;
  }

  /**
   * C2a repair (M3): reuse only a runner-authored snapshot commit. The
   * key line alone is not enough (worker messages survive cherry-picks
   * with `-x`): the candidate must carry every runner trailer. The
   * caller additionally verifies the committed tree (B4) before
   * recording anything about it.
   *
   * C2b (N4): the trailer lines must sit in the commit's trailer block
   * (the trailing contiguous `Key: value` lines), never anywhere in the
   * body, and the commit must carry the runner author/committer identity.
   * A cherry-picked worker commit quoting all four lines in its summary
   * is not reused.
   */
  private async findSnapshotCommit(snapshotKey: string, runId: string): Promise<string | null> {
    const trailers = [
      `AIBoard-Run: ${runId}`,
      "AIBoard-Author: runner",
      "AIBoard-Generated: handoff-snapshot",
      `AIBoard-Snapshot-Key: ${snapshotKey}`,
    ];
    for (const commit of await this.commitBodies()) {
      if (
        commit.authorName !== RUNNER_IDENTITY.GIT_AUTHOR_NAME ||
        commit.authorEmail !== RUNNER_IDENTITY.GIT_AUTHOR_EMAIL ||
        commit.committerName !== RUNNER_IDENTITY.GIT_COMMITTER_NAME ||
        commit.committerEmail !== RUNNER_IDENTITY.GIT_COMMITTER_EMAIL
      ) {
        continue;
      }
      const block = commitTrailerBlock(commit.body);
      if (trailers.every((trailer) => block.has(trailer))) {
        return commit.revision;
      }
    }
    return null;
  }

  private async commitBodies(): Promise<CommitBody[]> {
    const history = await this.git(this.path, [
      "log",
      "--reverse",
      "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00",
      `${this.baselineRevision}..HEAD`,
    ]);
    const fields = history.stdout.split("\0");
    const commits: CommitBody[] = [];
    for (let index = 0; index + 5 < fields.length; index += 6) {
      const revision = fields[index].trim();
      if (revision) {
        commits.push({
          revision,
          authorName: (fields[index + 1] ?? "").trim(),
          authorEmail: (fields[index + 2] ?? "").trim(),
          committerName: (fields[index + 3] ?? "").trim(),
          committerEmail: (fields[index + 4] ?? "").trim(),
          body: fields[index + 5] ?? "",
        });
      }
    }
    return commits;
  }

  private async documentCommitResult(commit: string): Promise<ProjectDocCommitResult> {
    const parent = (
      await this.git(this.repositoryRoot, ["rev-parse", "--verify", `${commit}^`])
    ).stdout.trim();
    const head = await this.head();
    this.currentRevision = head;
    const entryPoint = await this.projectDocEntryPointFacts(commit);
    // C2b repair m5: a CLAUDE.md that links to AGENTS.md satisfies the v2
    // pointer through the link. The blob itself holds no marked line, so
    // that fact stays false and this separate flag carries the reason; the
    // runtime records it and the gate accepts it. Never write through it.
    // C2c (NF-2/CD-15, NF-3): every link fact below comes from the COMMIT
    // tree alone (mode 120000 plus the target blob in the same commit). The
    // live worktree/index fallback is gone: a commit tree without the entry
    // lines is refused even when the live checkout holds a link (probes U1,
    // U2). A link whose regular-file target blob holds the marked section
    // (AGENTS.md) or line (CLAUDE.md) satisfies that file through the link,
    // because the runner wrote the section into the target path directly. A
    // link to anything else carries only its target, so the runtime can
    // accept the recorded skip reason for that file instead.
    const agentsLink = await this.commitEntryLinkTarget(commit, "AGENTS.md");
    if (agentsLink !== undefined) {
      entryPoint.agentsLinkTarget = agentsLink;
      if (await this.commitEntryTargetHoldsSection(commit, agentsLink, "agents")) {
        entryPoint.agentsSectionV2ViaLink = true;
      }
    }
    const claudeLink = await this.commitEntryLinkTarget(commit, "CLAUDE.md");
    if (claudeLink !== undefined) {
      entryPoint.claudeLinkTarget = claudeLink;
      if (linkTargetPointsAtAgentsDotMd(claudeLink)) {
        entryPoint.claudePointerV2ViaAgentsLink = true;
      } else if (await this.commitEntryTargetHoldsSection(commit, claudeLink, "claude")) {
        entryPoint.claudePointerV2ViaLink = true;
      }
    }
    // C2c repair cycle 2 (NB-2, m-1): commit-tree link facts for STATE.md,
    // read from the commit alone like every other link fact above. The
    // walk covers the ancestors plus STATE.md itself (a linked STATE.md
    // skips the same way), case-folded where the checkout is
    // case-insensitive (a committed `Docs` link), and never specs (m-1: it
    // is not an ancestor of STATE.md). The runtime derives every
    // skipped-STATE.md reason from these through the shared describer; the
    // AR-R05 gate accepts the recorded reason the way it accepts
    // export_only.
    const blockers = await this.commitStateBlockers(commit);
    const dirLinks = blockers.map((blocker) => blocker.component);
    // C2e repair cycle 1 (N-1): the first blocker's kind travels with the
    // result so the runtime records an accurate skip reason. Links carry
    // no kind: the describer keeps the legacy wording for them, so stored
    // logs replay unchanged. C2e repair cycle 2 (N-R2-4): a case
    // collision travels as "collision" with its own accurate wording.
    const firstKind = blockers[0]?.kind;
    const stateBlockerKind: HandoffStateBlockerKind | undefined =
      firstKind === "file" || firstKind === "submodule" || firstKind === "directory"
        ? firstKind
        : firstKind === "case-collision"
          ? "collision"
          : undefined;
    // C2d repair cycle 1 (escalation): the commit tree's entry-file
    // spellings, so the shared describer can corroborate a colliding
    // entry skip from the tree (fresh, reused and withdrawn commits
    // alike). One git call on a case-insensitive checkout, zero
    // otherwise. Absent means a single spelling -- the common path adds
    // no fact.
    const entryCollisions = await this.commitEntryCollisionSpellings(commit);
    if (entryCollisions.agents.length > 1) entryPoint.agentsCollisionSpellings = entryCollisions.agents;
    if (entryCollisions.claude.length > 1) entryPoint.claudeCollisionSpellings = entryCollisions.claude;
    return {
      commit,
      parent,
      head,
      entryPoint,
      ...(dirLinks.length > 0 ? { dirLinks } : {}),
      ...(stateBlockerKind !== undefined ? { stateBlockerKind } : {}),
    };
  }

  /**
   * The STATE.md ancestor-or-self components the COMMIT tree holds as links
   * (C2c repair cycle 2, NB-2/m-1). Each level lists only its parent tree,
   * so the queries stay bounded no matter how large the docs tree is, and
   * names compare case-folded where the checkout is case-insensitive.
   * Returns expected spellings (HANDOFF_STATE_LINK_COMPONENTS) in
   * first-link order; the walk stops at the first link.
   * C2e (F-matrix): a tracked non-link blocker counts the same way -- a
   * file where a directory is expected (`docs`, `docs/project`), or a
   * directory where STATE.md is expected. The shared describer records the
   * same tree-derived skip reason for it, which the AR-R05 gate accepts
   * exactly as it accepts the CD-17 link reason, so no such layout wedges
   * the run.
   * C2e repair cycle 1 (N-1): each blocker carries its kind, so the
   * recorded skip reason names a regular file, a submodule entry or a
   * directory accurately instead of calling everything a link. Links carry
   * no forward kind (the describer keeps the legacy wording for them), so
   * stored logs replay unchanged. C2e repair cycle 2 (N-R2-4) gives a case
   * collision its own "collision" kind; a link among the colliding
   * spellings still wins (INT-1).
   */
  private async commitStateBlockers(commit: string): Promise<Array<{ component: string; kind: "link" | "file" | "submodule" | "directory" | "case-collision" }>> {
    const parts = ["docs", "project", "STATE.md"];
    const actual: string[] = [];
    for (let level = 0; level < parts.length; level += 1) {
      const treeRef = actual.length === 0 ? commit : `${commit}:${actual.join("/")}`;
      const want = parts[level] ?? "";
      // C2c round 3 (NB-5): query the single entry, never the whole parent
      // listing (40,000 files directly under docs/ exceed the 4 MiB git
      // output cap). The expected spelling first; on a case-insensitive
      // checkout the other spellings come from the COMMIT tree itself (C2c
      // repair cycle 4, NB-7): every upper/lower-case variant of the fixed
      // name as exact pathspecs in one `ls-tree` call per level (16 for
      // `docs`, 128 for `project`, 128 for `STATE.md`; the output holds
      // only the matching entries). The live worktree is never consulted --
      // a withdrawn stop describes an older commit, and the worktree may no
      // longer hold that spelling.
      // C2d repair cycle 1 (escalation): a case collision at a
      // directory level (say `docs` with `Docs`) reports the component
      // the same way a link does, so the run skips STATE.md with the
      // shared tree-derived reason instead of wedging every attempt on
      // the commit pathspec. Two spellings of STATE.md itself (B2) keep
      // the read-back fail-closed instead: the commit may record one
      // spelling, and the canonical name never covers the other.
      const resolved = await this.commitTreeEntryResolved(treeRef, want);
      const entry = resolved.entry;
      if (entry === undefined) return [];
      const component = HANDOFF_STATE_LINK_COMPONENTS[level] ?? "";
      if (component === "") return [];
      const { mode, name } = entry;
      // C2d m-9 / INT-1 fix: a link among the folded spellings wins over the
      // collision (the resolved entry prefers the 120000 match), so the walk
      // agrees with the stage-time link check (probe F-collide); a collision
      // with no link keeps its own "two spellings" reason.
      if (mode === "120000") {
        return [{ component, kind: "link" as const }];
      }
      if (resolved.collision.length > 1 && level < parts.length - 1) {
        return [{ component, kind: "case-collision" as const }];
      }
      if (level < parts.length - 1) {
        // C2e (F-matrix): a tracked file where a directory is expected
        // blocks STATE.md the way a link does -- nothing below can be a
        // link, and the blocker itself is reported.
        if (mode !== "040000") {
          return [{ component, kind: mode === "160000" ? "submodule" as const : "file" as const }];
        }
        actual.push(name);
      } else if (mode !== "100644" && mode !== "100755") {
        // C2e (F-matrix): a tracked directory where STATE.md is expected.
        // C2e repair cycle 1 (N-3): a submodule entry (mode 160000, an
        // empty directory on disk) or any other non-regular, non-link
        // mode at the STATE.md level blocks the write the same way --
        // without this the run stalls on EISDIR every attempt.
        return [{ component, kind: mode === "160000" ? "submodule" as const : "directory" as const }];
      }
    }
    return [];
  }

  /**
   * The first STATE.md ancestor-or-self component the HEAD tree holds as a
   * tracked non-link blocker (C2e F-matrix): a file where `docs/` or
   * `docs/project/` is expected, or a directory where `STATE.md` is
   * expected. Links are NOT reported here (the CD-17 link path owns them);
   * a missing entry is not a blocker either. Bounded: three exact
   * `ls-tree` queries against the commit, never a directory listing and
   * never the live worktree.
   */
  private async commitStateNonLinkBlocker(
    treeRef: string,
  ): Promise<{ component: string; kind: "file-not-dir" | "dir-not-file" | "case-collision" | "submodule" } | null> {
    const parts = ["docs", "project", "STATE.md"];
    const actual: string[] = [];
    for (let level = 0; level < parts.length; level += 1) {
      const parentRef = actual.length === 0 ? treeRef : `${treeRef}:${actual.join("/")}`;
      const want = parts[level] ?? "";
      const resolved = await this.commitTreeEntryResolved(parentRef, want);
      const entry = resolved.entry;
      if (entry === undefined) return null;
      const component = HANDOFF_STATE_LINK_COMPONENTS[level] ?? "";
      if (!component) return null;
      // C2d repair cycle 1 (escalation): two tracked spellings of one
      // directory component (say `docs` with `Docs`) block STATE.md the
      // way a non-directory does -- on disk there is one directory, so
      // a write stages under the other spelling and every commit wedges
      // on the pathspec. The kernel skips STATE.md with the shared
      // tree-derived reason instead. Two spellings of STATE.md itself
      // (B2) are not a blocker: the read-back stays fail-closed.
      if (resolved.collision.length > 1 && level < parts.length - 1) return { component, kind: "case-collision" };
      if (entry.mode === "120000") return null;
      if (level < parts.length - 1) {
        // C2e repair cycle 1 (N-1/N-3): a submodule entry where a
        // directory is expected carries its own kind so the recorded
        // reason and the v1 refusal name it accurately.
        if (entry.mode === "160000") return { component, kind: "submodule" };
        if (entry.mode !== "040000") return { component, kind: "file-not-dir" };
        actual.push(entry.name);
      } else if (entry.mode === "160000") {
        // C2e repair cycle 1 (N-3): a submodule entry (mode 160000, an
        // empty directory on disk) at STATE.md blocks the write the way
        // a directory does -- without this the run stalls on EISDIR
        // every attempt.
        return { component, kind: "submodule" };
      } else if (entry.mode === "040000") {
        return { component, kind: "dir-not-file" };
      } else if (entry.mode !== "100644" && entry.mode !== "100755") {
        return { component, kind: "dir-not-file" };
      } else {
        return null;
      }
    }
    return null;
  }

  /**
   * Entry-file skip reasons re-derived from a landed commit's own tree in
   * the fresh stage-time wording (C2e m-4). A reused or withdrawn commit
   * carries no stage-time records, so without this the shared describer
   * re-words every skip generically ("the target holds no marked
   * section") while a fresh commit of the same layout records the real
   * cause ("target MISSING.md is not a regular tracked file"). Only
   * commit-tree facts are used: an unresolvable target keeps the
   * outside/".." wording, a kernel-owned target keeps its wording, a
   * commit-tree ancestor link names the junction, and a missing or
   * non-regular target keeps "not a regular tracked file" -- each through
   * the same detail function the stager uses. A redirect the tree proves
   * (the target blob holds the section) is left to the describer, whose
   * redirect wording already matches; a regular blob without the section
   * (worktree/index tampering the tree cannot corroborate) keeps the
   * generic wording so the outcome never regresses to a pause.
   */
  private async commitEntrySkipReasonsFromTree(
    commit: string,
    entryPoint: ProjectDocCommitResult["entryPoint"],
  ): Promise<Array<{ path: string; reason: string }>> {
    const skipped: Array<{ path: string; reason: string }> = [];
    for (const entryPath of ["AGENTS.md", "CLAUDE.md"] as const) {
      const raw = entryPath === "AGENTS.md" ? entryPoint.agentsLinkTarget : entryPoint.claudeLinkTarget;
      if (raw === undefined) {
        // C2d repair cycle 1 (escalation): a colliding entry file
        // carries no link, so re-derive its fresh-worded skip from the
        // commit tree's corroborating spellings (no git call: the facts
        // above already hold them). A reused or withdrawn commit of the
        // same layout then records exactly what a fresh commit records.
        // A link layout keeps the link wording below even when a second
        // spelling exists, matching the fresh stage-time choice.
        const spellings = entryPath === "AGENTS.md" ? entryPoint.agentsCollisionSpellings : entryPoint.claudeCollisionSpellings;
        if (spellings !== undefined && spellings.length > 1 && spellings[0] !== undefined && spellings[1] !== undefined) {
          skipped.push({ path: entryPath, reason: handoffEntryCollisionSkipReason(entryPath, spellings[0], spellings[1]) });
        }
        continue;
      }
      const viaLink = entryPath === "AGENTS.md"
        ? entryPoint.agentsSectionV2ViaLink === true
        : entryPoint.claudePointerV2ViaLink === true || entryPoint.claudePointerV2ViaAgentsLink === true;
      if (viaLink) continue;
      const display = raw.replace(/\s+/g, " ").trim().slice(0, 120) || "an unreadable target";
      const shape = (detail: string): { path: string; reason: string } => ({
        path: entryPath,
        reason: `${entryPath} is a symbolic link to ${display}; the entry is skipped (${detail}).`,
      });
      const target = resolveEntryLinkTarget(raw);
      if (target === null) {
        skipped.push(shape(entryLinkSkipDetail(raw, null)));
        continue;
      }
      if (target === "docs/project/STATE.md" || isHandoffSpecCopyPath(target)) {
        skipped.push(shape(entryLinkSkipDetail(raw, target)));
        continue;
      }
      const ancestor = await this.commitTreeAncestorLink(commit, target);
      if (ancestor !== null) {
        skipped.push(shape(entryLinkSkipDetail(raw, target, ancestor)));
        continue;
      }
      const found = await this.commitTreePathMode(commit, target);
      if (found === undefined || found.mode === "120000") {
        skipped.push(shape(entryLinkSkipDetail(raw, target)));
        continue;
      }
      // C2e repair cycle 1 (N-4): a directory target, a submodule entry,
      // or a target the tree holds only under another spelling reads
      // exactly as a fresh commit words it ("not a regular tracked
      // file"). Only a regular blob at the exact requested spelling keeps
      // the generic re-description, so tampering layouts (a blob without
      // the section) still complete instead of pausing.
      if (found.mode === "040000" || found.mode === "160000" || !found.exact) {
        skipped.push(shape(entryLinkSkipDetail(raw, target)));
        continue;
      }
      skipped.push({ path: entryPath, reason: handoffEntryGenericSkipReason(entryPath, raw) });
    }
    return skipped;
  }

  /**
   * The first linked directory above a commit-tree path, in requested
   * spelling (C2e m-4): the commit-tree counterpart of the stage-time
   * ancestor check, so a re-derived skip names the same junction a fresh
   * commit names. Bounded: one exact `ls-tree` per path level.
   */
  private async commitTreeAncestorLink(commit: string, target: string): Promise<string | null> {
    const slash = target.lastIndexOf("/");
    if (slash <= 0) return null;
    const parts = target.slice(0, slash).split("/");
    const actual: string[] = [];
    const requested: string[] = [];
    const insensitive = await this.checkoutIgnoresCase();
    for (const part of parts) {
      requested.push(part);
      const parentRef = actual.length === 0 ? commit : `${commit}:${actual.join("/")}`;
      let entry = await this.commitTreeEntry(parentRef, part);
      if (entry === undefined && insensitive) {
        entry = await this.commitTreeEntryFolded(parentRef, part);
      }
      if (entry === undefined) return null;
      if (entry.mode === "120000") return requested.join("/");
      if (entry.mode !== "040000") return null;
      actual.push(entry.name);
    }
    return null;
  }

  /**
   * The mode of one commit-tree path, or undefined when any level misses
   * (C2e m-4). A mid-level non-tree (a file where a directory is expected)
   * also reports undefined: the target is unreachable, which the caller
   * words as "not a regular tracked file" exactly as the stager does.
   * C2e repair cycle 1 (N-4): `exact` tells whether the tree holds the
   * target under the requested spelling at every level -- a folded
   * (case-only) match is not the regular tracked file the stager checked,
   * so the caller words it as "not a regular tracked file" too.
   */
  private async commitTreePathMode(commit: string, path: string): Promise<{ mode: string; exact: boolean } | undefined> {
    const parts = path.split("/");
    const actual: string[] = [];
    const insensitive = await this.checkoutIgnoresCase();
    for (let index = 0; index < parts.length; index += 1) {
      const want = parts[index] ?? "";
      if (!want) return undefined;
      const parentRef = actual.length === 0 ? commit : `${commit}:${actual.join("/")}`;
      let entry = await this.commitTreeEntry(parentRef, want);
      if (entry === undefined && insensitive) {
        entry = await this.commitTreeEntryFolded(parentRef, want);
      }
      if (entry === undefined) return undefined;
      actual.push(entry.name);
      if (index < parts.length - 1) {
        if (entry.mode !== "040000") return undefined;
      } else {
        return { mode: entry.mode, exact: actual.join("/") === path };
      }
    }
    return undefined;
  }

  /** One exact entry of a commit tree (mode and name), or undefined. */
  private async commitTreeEntry(treeRef: string, name: string): Promise<{ mode: string; name: string } | undefined> {
    if (!name || name.includes("/")) return undefined;
    const listing = await this.git(this.path, ["ls-tree", treeRef, "--", name], true);
    if (listing.exitCode !== 0) return undefined;
    for (const record of listing.stdout.split("\n")) {
      const line = record.trim();
      const tab = line.lastIndexOf("\t");
      if (tab < 0) continue;
      if (line.slice(tab + 1) !== name) continue;
      const mode = line.slice(0, tab).split(" ")[0];
      if (mode) return { mode, name };
    }
    return undefined;
  }

  /**
   * One entry of a commit tree matching `want` ignoring case (C2c repair
   * cycle 4, NB-7): every upper/lower-case variant of the fixed name as an
   * exact pathspec in a single `ls-tree` call. The output holds only the
   * matching entries, so the call stays bounded (16 variants for `docs`,
   * 128 for `project`, 128 for `STATE.md`) no matter how large the parent
   * tree is. The spellings come from the commit being described, never from
   * the live worktree.
   */
  private async commitTreeEntryFolded(treeRef: string, want: string): Promise<{ mode: string; name: string } | undefined> {
    const matches = await this.commitTreeFoldedMatches(treeRef, want);
    // C2d (F-collide): when several case variants match (a colliding tree),
    // prefer the link entry (mode 120000), so the commit-tree walk agrees
    // with the stage-time check, which sees the link and skips.
    return matches.find((match) => match.mode === "120000") ?? matches[0];
  }

  /**
   * Every commit-tree entry matching `want` ignoring case, in `ls-tree`
   * output order (C2d repair cycle 1): the same bounded single `ls-tree`
   * call as `commitTreeEntryFolded`, but with all matches kept so a
   * caller can also see a case collision (two tracked spellings of one
   * name). Empty when nothing matches or the tree reference is missing.
   */
  private async commitTreeFoldedMatches(treeRef: string, want: string): Promise<Array<{ mode: string; name: string }>> {
    if (!want || want.includes("/")) return [];
    const variants = caseVariants(want);
    if (variants.length === 0) return [];
    const wanted = new Set(variants);
    const listing = await this.git(this.path, ["ls-tree", treeRef, "--", ...variants], true);
    if (listing.exitCode !== 0) return [];
    const matches: Array<{ mode: string; name: string }> = [];
    for (const record of listing.stdout.split("\n")) {
      const line = record.trim();
      const tab = line.lastIndexOf("\t");
      if (tab < 0) continue;
      const name = line.slice(tab + 1);
      if (!wanted.has(name)) continue;
      const mode = line.slice(0, tab).split(" ")[0];
      if (!mode) continue;
      matches.push({ mode, name });
    }
    return matches;
  }

  /**
   * One level of a commit-tree walk with its case-collision sighting (C2d
   * repair cycle 1, escalation): the selected entry plus every distinct
   * tracked spelling that folds to `want`. On a case-sensitive checkout
   * this is the single exact query, exactly as before. On a
   * case-insensitive checkout it is one folded multi-name `ls-tree` (the
   * same call the miss path already spent): the exact spelling wins when
   * present, else the F-collide link preference applies, and a second
   * distinct spelling is reported as a collision instead of being
   * silently descended past. The common path spends no extra git call.
   */
  private async commitTreeEntryResolved(
    treeRef: string,
    want: string,
  ): Promise<{ entry: { mode: string; name: string } | undefined; collision: string[] }> {
    if (!(await this.checkoutIgnoresCase())) {
      return { entry: await this.commitTreeEntry(treeRef, want), collision: [] };
    }
    const matches = await this.commitTreeFoldedMatches(treeRef, want);
    const spellings = [...new Set(matches.map((match) => match.name))];
    const exact = matches.find((match) => match.name === want);
    const entry = exact ?? matches.find((match) => match.mode === "120000") ?? matches[0];
    return { entry, collision: spellings.length > 1 ? spellings : [] };
  }

  /**
   * The commit tree's distinct spellings of the two entry files (C2d
   * repair cycle 1, escalation): every case variant of `AGENTS.md` and
   * `CLAUDE.md` as exact pathspecs in one `ls-tree` call, grouped by
   * file. A group with two spellings (say `AGENTS.md` with `agents.md`)
   * collides: on a case-insensitive checkout the worktree holds one
   * file, so writing the entry would substitute one entry's bytes for
   * the other's and the commit would record a file the gate refuses.
   * Zero git calls on a case-sensitive checkout (no aliasing there, so
   * two spellings are two files and nothing wedges).
   */
  private async commitEntryCollisionSpellings(
    treeRef: string,
  ): Promise<{ agents: string[]; claude: string[] }> {
    const empty = { agents: [], claude: [] };
    if (!(await this.checkoutIgnoresCase())) return empty;
    const variants = [...caseVariants("AGENTS.md"), ...caseVariants("CLAUDE.md")];
    const listing = await this.git(this.path, ["ls-tree", treeRef, "--", ...variants], true);
    if (listing.exitCode !== 0) return empty;
    const wanted = new Set(variants);
    const agents = new Set<string>();
    const claude = new Set<string>();
    for (const record of listing.stdout.split("\n")) {
      const line = record.trim();
      const tab = line.lastIndexOf("\t");
      if (tab < 0) continue;
      const name = line.slice(tab + 1);
      if (!wanted.has(name)) continue;
      if (name.toLowerCase() === "agents.md") agents.add(name);
      else if (name.toLowerCase() === "claude.md") claude.add(name);
    }
    return { agents: [...agents], claude: [...claude] };
  }

  /**
   * True when the integration checkout is case-insensitive (C2c repair
   * cycle 2, NB-2): a committed `Docs` link must back the same STATE.md
   * skip as `docs` there. A pure filesystem probe (lstat a
   * case-toggled sibling of the worktree): no git command, no writes.
   */
  private checkoutCaseInsensitive: boolean | undefined;

  private async checkoutIgnoresCase(): Promise<boolean> {
    if (this.checkoutCaseInsensitive === undefined) {
      const fallback = process.platform === "win32" || process.platform === "darwin";
      const leaf = basename(this.path);
      const toggled = leaf.replace(/[A-Za-z]/, (letter) =>
        letter === letter.toUpperCase() ? letter.toLowerCase() : letter.toUpperCase(),
      );
      if (toggled === leaf) {
        this.checkoutCaseInsensitive = fallback;
      } else {
        try {
          await lstat(resolve(this.path, "..", toggled));
          this.checkoutCaseInsensitive = true;
        } catch (error) {
          this.checkoutCaseInsensitive = isNodeError(error) && error.code === "ENOENT" ? false : fallback;
        }
      }
    }
    return this.checkoutCaseInsensitive;
  }

  private async projectDocEntryPointFacts(revision: string): Promise<ProjectDocCommitResult["entryPoint"]> {
    // C2d repair cycle 1 (B1): the README fact reads through the commit's
    // own spelling, like the AGENTS.md/CLAUDE.md facts below. The exact
    // spelling is still tried first, so exact-case repositories spend the
    // same single `cat-file` as before; only a miss on a case-insensitive
    // checkout pays the tree walk. Otherwise a v1 commit into `Docs/`
    // lands while the completion gate reports "missing
    // docs/project/README.md" forever.
    let readme = await this.git(
      this.repositoryRoot,
      ["cat-file", "-e", `${revision}:docs/project/README.md`],
      true,
    );
    if (readme.exitCode !== 0 && (await this.checkoutIgnoresCase())) {
      const real = await this.resolveSpellingInTree(revision, "docs/project/README.md");
      if (real !== "docs/project/README.md") {
        readme = await this.git(
          this.repositoryRoot,
          ["cat-file", "-e", `${revision}:${real}`],
          true,
        );
      }
    }
    // C2d (D-rd-lcagents, F-LC-agents): entry facts fold case on a
    // case-insensitive checkout, so a section committed through the index's
    // own spelling (`agents.md`, `claude.md`) still satisfies the gate.
    const agents = await this.readBlobFolded(revision, "AGENTS.md");
    const claude = await this.readBlobFolded(revision, "CLAUDE.md");
    return {
      readme: readme.exitCode === 0,
      agentsMarkedSection: agents !== null && agentsMarkedSectionSatisfies(agents),
      claudePointer: claude !== null && claudePointerSatisfies(claude),
      agentsMarkedSectionV2: agents !== null && agentsMarkedSectionSatisfiesV2(agents),
      claudePointerV2: claude !== null && claudePointerSatisfiesV2(claude),
    };
  }

  private async readBlob(revision: string, path: string): Promise<string | null> {
    const result = await this.git(
      this.repositoryRoot,
      ["show", `${revision}:${path}`],
      true,
    );
    return result.exitCode === 0 ? result.stdout : null;
  }

  /**
   * The blob for a canonical entry path, folding case on a case-insensitive
   * checkout (C2d): the exact spelling first, then the commit's own spelling
   * of that path. Exact-case repositories behave byte-identically.
   */
  private async readBlobFolded(revision: string, path: string): Promise<string | null> {
    const exact = await this.readBlob(revision, path);
    if (exact !== null) return exact;
    if (!(await this.checkoutIgnoresCase())) return null;
    const real = await this.resolveSpellingInTree(revision, path);
    if (real === path) return null;
    return await this.readBlob(revision, real);
  }

  /**
   * The index's own spelling of a canonical write path (C2d root cause):
   * each existing path component resolved through the HEAD commit tree,
   * keeping the canonical spelling only for components that do not exist
   * yet. On a case-sensitive checkout this is the identity. Bounded: one
   * exact `ls-tree` per level, plus one folded multi-name `ls-tree` per
   * missed level; the live worktree is never consulted.
   */
  private async resolveIndexSpelling(canonical: string): Promise<string> {
    if (!(await this.checkoutIgnoresCase())) return canonical;
    return await this.resolveSpellingInTree("HEAD", canonical);
  }

  /**
   * One component at a time from `treeRef` down: the exact entry, else its
   * case-folded match (link entries preferred, per F-collide), else the
   * canonical remainder for everything below the first miss.
   */
  private async resolveSpellingInTree(treeRef: string, canonical: string): Promise<string> {
    if (!canonical || canonical.includes("\0")) return canonical;
    const parts = canonical.split("/");
    const actual: string[] = [];
    for (let level = 0; level < parts.length; level += 1) {
      const parentRef = actual.length === 0 ? treeRef : `${treeRef}:${actual.join("/")}`;
      const want = parts[level] ?? "";
      let entry = await this.commitTreeEntry(parentRef, want);
      if (entry === undefined && (await this.checkoutIgnoresCase())) {
        entry = await this.commitTreeEntryFolded(parentRef, want);
      }
      if (entry === undefined) {
        actual.push(want, ...parts.slice(level + 1));
        break;
      }
      actual.push(entry.name);
    }
    return actual.join("/");
  }

  private containedProjectDocPath(relativePath: string): string {
    const absolute = resolve(this.path, ...relativePath.split("/"));
    const fromRoot = relative(resolve(this.path), absolute);
    if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
      throw new Error(`Project document path escapes the integration worktree: ${relativePath}`);
    }
    return absolute;
  }

  /**
   * True when the worktree CLAUDE.md is a symbolic link resolving to the
   * worktree AGENTS.md (C2b repair m5). Any other link (or a dangling one)
   * is not this layout and keeps the existing refusal below.
   * C2b repair B3: a link-mode index entry (mode 120000) is a link even
   * when core.symlinks=false checked it out as a plain file, so the index
   * is consulted too -- either source refuses the write.
   */
  private async claudeLinksAgents(): Promise<boolean> {
    const claude = this.containedProjectDocPath("CLAUDE.md");
    let stats;
    try {
      stats = await lstat(claude);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return await this.indexClaudeLinksAgents();
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      let target: string;
      try {
        target = await readlink(claude);
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") return await this.indexClaudeLinksAgents();
        throw error;
      }
      if (resolve(dirname(claude), target) === this.containedProjectDocPath("AGENTS.md")) return true;
      return false;
    }
    return await this.indexClaudeLinksAgents();
  }

  /**
   * True when the index holds CLAUDE.md as a link (mode 120000) whose
   * target resolves to AGENTS.md (C2b repair B3). Read from git, never the
   * worktree, so a link-mode entry checked out as a plain file still
   * counts. A worktree symlink that was never staged is invisible here;
   * the lstat check above owns that case.
   */
  private async indexClaudeLinksAgents(): Promise<boolean> {
    const modes = await this.indexEntryModes(["CLAUDE.md"]);
    // C2c repair cycle 4 (NB-8): the link-ness of CLAUDE.md itself folds
    // case; the blob is read by the index's own spelling.
    const found = IntegrationManager.findIndexEntry(modes, "CLAUDE.md", true);
    if (found?.mode !== "120000") return false;
    const target = await this.indexBlobText(found.path);
    return target !== null && linkTargetPointsAtAgentsDotMd(target);
  }

  /**
   * The raw link target when the COMMIT tree holds the entry path as a link
   * (mode 120000), otherwise undefined (C2c NF-2/NF-3). The gate reads this
   * fact from the commit, never the checkout.
   */
  private async commitEntryLinkTarget(commit: string, entryPath: string): Promise<string | undefined> {
    // C2d (F-LC-agents): on a case-insensitive checkout the entry file itself
    // may be stored under its own spelling (`agents.md`, `claude.md`); fall
    // back to the folded lookup so the link fact is still found.
    const exact = await this.commitEntryLinkBlob(commit, [entryPath]);
    if (exact !== undefined) return exact;
    if (!(await this.checkoutIgnoresCase())) return undefined;
    return await this.commitEntryLinkBlob(commit, caseVariants(entryPath));
  }

  /**
   * The raw link target when one of the given pathspecs names a link (mode
   * 120000) in the commit tree, otherwise undefined (C2c NF-2/NF-3). With
   * several matches the first link entry wins.
   */
  private async commitEntryLinkBlob(commit: string, pathspecs: readonly string[]): Promise<string | undefined> {
    const tree = await this.git(this.path, ["ls-tree", commit, "--", ...pathspecs], true);
    if (tree.exitCode !== 0) return undefined;
    for (const record of tree.stdout.split("\n")) {
      const line = record.trim();
      if (!line) continue;
      const match = /^120000 blob ([a-f0-9]{40,64})\t(\S.*)$/.exec(line);
      if (!match) continue;
      const target = await this.blobText(match[1] ?? "");
      if (target !== null) return target;
    }
    return undefined;
  }

  /**
   * True when the COMMIT tree holds the link target as a regular (non-link)
   * blob whose bytes carry the marked v2 section (agents) or line (claude).
   * A single hop only: a target that is itself a link never counts, so a
   * chained layout skips the entry file with a recorded reason instead.
   */
  private async commitEntryTargetHoldsSection(
    commit: string,
    rawTarget: string,
    kind: "agents" | "claude",
  ): Promise<boolean> {
    const target = resolveEntryLinkTarget(rawTarget);
    if (target === null) return false;
    const tree = await this.git(this.path, ["ls-tree", commit, "--", target], true);
    if (tree.exitCode !== 0) return false;
    const line = tree.stdout.split("\n").map((entry) => entry.trim()).find(Boolean) ?? "";
    const match = /^(100[0-9]{3}) blob ([a-f0-9]{40,64})\t(\S.*)$/.exec(line);
    if (!match || match[3] !== target) return false;
    const content = await this.blobText(match[2] ?? "");
    if (content === null) return false;
    return kind === "agents" ? agentsMarkedSectionSatisfiesV2(content) : claudePointerSatisfiesV2(content);
  }

  /**
   * Stage-time link sighting for one entry file (C2c NF-2): a real worktree
   * symlink (readlink text), else a git link entry (mode 120000, checked out
   * as a plain file under core.symlinks=false) from the index blob. The
   * write decision refuses from either source; the gate later verifies from
   * the commit tree alone.
   */
  private async entryLinkRawTarget(entryPath: string): Promise<{ isLink: boolean; raw?: string }> {
    // C2c repair M-2: when the index holds mode 120000 the link target
    // comes from the index blob (the commit-tree truth), never readlink --
    // git for Windows stores real-link targets with backslashes, and the
    // worktree sighting may disagree with the committed target.
    const modes = await this.indexEntryModes([entryPath]);
    // C2c repair cycle 4 (NB-8): the link-ness of the entry file itself
    // folds case; the target blob is read by the index's own spelling.
    const found = IntegrationManager.findIndexEntry(modes, entryPath, true);
    if (found?.mode === "120000") {
      const target = await this.indexBlobText(found.path);
      if (target !== null) return { isLink: true, raw: target };
      return { isLink: true };
    }
    const absolute = this.containedProjectDocPath(entryPath);
    let stats;
    try {
      stats = await lstat(absolute);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      return { isLink: false };
    }
    if (stats.isSymbolicLink()) {
      try {
        return { isLink: true, raw: await readlink(absolute) };
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      }
      return { isLink: true };
    }
    return { isLink: false };
  }

  /**
   * True when an entry-file link target may receive the marked section
   * directly (C2c NF-2/CD-15): it resolves inside the worktree, is a
   * tracked regular (non-link) file, exists on disk as a regular file (not
   * through another link), and is not a kernel-owned or spec-copy path a
   * redirect must never land on.
   */
  private async isEntryLinkRedirectTarget(target: string): Promise<boolean> {
    if (isHandoffSpecCopyPath(target) || target === "docs/project/STATE.md") return false;
    // C2c repair M-1: the directories on the way to the target must be
    // link-free too -- a directory link or junction above the target
    // refuses the redirect, so the write can never land outside through it.
    const slash = target.lastIndexOf("/");
    if (slash > 0 && (await this.firstLinkComponent(target.slice(0, slash))) !== null) return false;
    // C2c repair cycle 4 (NB-8): a redirect target resolves ONLY by the
    // exact spelling the index holds -- never folded. A link to `notes.md`
    // when the index holds `NOTES.md` is refused here, and the entry file
    // is skipped with a reason instead of wedging on a pathspec commit.
    const modes = await this.indexEntryModes([target]);
    const found = IntegrationManager.findIndexEntry(modes, target, false);
    if (found?.mode === undefined || found?.mode === "120000") return false;
    // C2d (D-rd-collide): refuse a redirect whose target collides
    // case-insensitively with another index entry (tracked `NOTES.md` and
    // `notes.md`). On disk there is one file, so writing through the target
    // would substitute one entry's bytes for the other's; the entry file is
    // skipped with a reason instead.
    for (const entryPath of modes.keys()) {
      if (entryPath !== found.path && entryPath.toLowerCase() === target.toLowerCase()) return false;
    }
    let stats;
    try {
      stats = await lstat(this.containedProjectDocPath(target));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
      return false;
    }
    return stats !== undefined && stats.isFile() && !stats.isSymbolicLink();
  }

  /** Blob bytes for an index entry path, or null when it is not staged. */
  private async indexBlobText(path: string): Promise<string | null> {
    const listing = await this.git(this.path, ["ls-files", "-s", "-z", "--", path], true);
    if (listing.exitCode !== 0) return null;
    for (const record of listing.stdout.split("\0")) {
      if (!record) continue;
      const tab = record.lastIndexOf("\t");
      if (tab < 0) continue;
      if (record.slice(tab + 1) !== path) continue;
      const hash = record.slice(0, tab).split(" ")[1] ?? "";
      return await this.blobText(hash);
    }
    return null;
  }

  /** Raw text of one blob by hash, or null. Link targets are short text. */
  private async blobText(hash: string): Promise<string | null> {
    if (!/^[a-f0-9]{40,64}$/.test(hash)) return null;
    const stored = await this.git(this.path, ["cat-file", "-p", hash], true);
    return stored.exitCode === 0 ? stored.stdout : null;
  }

  /** Index entry modes for paths (missing paths are absent from the map). */
  private async indexEntryModes(paths: readonly string[]): Promise<Map<string, string>> {
    const modes = new Map<string, string>();
    if (paths.length === 0) return modes;
    // C2c repair cycle 2 (NB-3): query only each component entry itself,
    // one git call per path. `ls-files -- <dir>` lists the whole subtree,
    // so 40,000 tracked files under docs/generated/ exceed the 4 MiB git
    // output cap and fail every snapshot (plus the v1 document commit),
    // while `<path> ':(exclude)<path>/*'` returns exactly the entry: a link
    // entry is listed, a directory yields nothing. The calls stay separate
    // because one combined call lets an ancestor exclude swallow a nested
    // exact hit (`:(exclude)docs/*` matches docs/project/STATE.md itself).
    // C2c round 3 (NB-6): on a case-insensitive checkout a committed `Docs`
    // link must count for `docs`, so both pathspecs fold case there.
    // C2c repair cycle 4 (NB-8): every entry is keyed by the index's own
    // (real) spelling, never by the requested spelling. Callers that detect
    // a link fold case through findIndexEntry below; a redirect TARGET
    // resolves only by its exact spelling, so a link to `notes.md` when the
    // index holds `NOTES.md` is refused instead of redirected.
    const insensitive = await this.checkoutIgnoresCase();
    for (const path of paths) {
      const pathspec = insensitive
        ? [`:(icase)${path}`, `:(exclude,icase)${path}/*`]
        : [path, `:(exclude)${path}/*`];
      const listing = await this.git(this.path, ["ls-files", "-s", "-z", "--", ...pathspec], true);
      if (listing.exitCode !== 0) continue;
      for (const record of listing.stdout.split("\0")) {
        if (!record) continue;
        const tab = record.lastIndexOf("\t");
        if (tab < 0) continue;
        const entryPath = record.slice(tab + 1);
        const mode = record.slice(0, tab).split(" ")[0] ?? "";
        if (!entryPath || !mode) continue;
        if (entryPath === path || (insensitive && entryPath.toLowerCase() === path.toLowerCase())) {
          modes.set(entryPath, mode);
        }
      }
    }
    return modes;
  }

  /**
   * The index entry for a requested path (C2c repair cycle 4, NB-8): the
   * exact-spelling hit, or -- only when `foldCase` is set for LINK
   * DETECTION (the CD-17 directory check, the link-ness of AGENTS.md and
   * CLAUDE.md themselves) -- a case-insensitive hit carrying the index's
   * own spelling. Redirect targets never fold: they resolve only by the
   * exact spelling the index holds.
   */
  private static findIndexEntry(
    modes: Map<string, string>,
    path: string,
    foldCase: boolean,
  ): { path: string; mode: string } | undefined {
    const exact = modes.get(path);
    if (exact !== undefined) return { path, mode: exact };
    if (!foldCase) return undefined;
    const want = path.toLowerCase();
    for (const [entryPath, mode] of modes) {
      if (entryPath.toLowerCase() === want) return { path: entryPath, mode };
    }
    return undefined;
  }

  /**
   * Lookup-only snapshot find for a stop key (C2b repair B1): the runner
   * snapshot commit carrying the key, or null. Never commits. The runtime
   * reconciles withdrawn stops' landed commits through this before the next
   * stop commits, so a commit that landed but was never recorded still moves
   * the document chain instead of breaking it.
   */
  async findHandoffSnapshotCommit(input: {
    snapshotKey: string;
  }): Promise<ProjectDocCommitResult | null> {
    return await this.serialized(async () => {
      if (!input.snapshotKey.trim() || /[\r\n\0]/.test(input.snapshotKey)) {
        throw new Error("Handoff snapshot key is invalid.");
      }
      await this.ensureIntegrationWorkspace();
      const existing = await this.findSnapshotCommit(input.snapshotKey, this.runId);
      if (!existing) return null;
      // C2e (m-4): the withdrawn-stop path carries no stage-time records
      // either, so re-derive the fresh-worded entry skips here as well; the
      // runtime passes them to the shared describer as the reuse path does.
      const found = await this.documentCommitResult(existing);
      const foundSkips = await this.commitEntrySkipReasonsFromTree(existing, found.entryPoint);
      if (foundSkips.length > 0) found.skipped = foundSkips;
      return found;
    });
  }

  /**
   * The recorded integration baseline revision (C2b repair CD-14/N6): the
   * handed-off revision for a docs-v2 run with no plan revision and no
   * integration revision yet, so it never spins in a snapshot-failure pause.
   */
  async readIntegrationBaselineRevision(): Promise<{ revision: string }> {
    return { revision: this.baselineRevision };
  }

  /**
   * Whether a spec-copy path can be staged right now (C2c NF-1 residual).
   * The check writes nothing: a dry-run `git add` predicts the stage-time
   * add exactly (a tracked path stays stageable even under an ignore rule,
   * while a gitignored path refuses) and stages nothing into the index.
   * C2c repair BL-1: there is deliberately no worktree preview -- writing
   * the copy's bytes before any link check would send them outside the
   * repository through a committed directory link, so every component of
   * the spec path (from the repository root down) is refused first when it
   * is a link. C2c repair M-4: a resolved path already holding other bytes
   * can never land where the snapshot names it (the stager honors the
   * resolved path), so it reports unstageable here and STATE.md renders
   * "not recorded". The runtime asks before rendering STATE.md so the
   * `spec:` line says "not recorded" when the copy will be skipped.
   * `git check-ignore` would answer this directly but sits outside the
   * Runner Git policy; the dry-run add is the policy-held equivalent
   * (non-interactive `add` modes are permitted).
   */
  async canStageSpecPath(input: {
    path: string;
    content: string;
  }): Promise<{ stageable: boolean; unstageableReason?: "path_occupied" | "write_failed" }> {
    return await this.serialized(async () => {
      const checked = validateProjectDocPath(input.path);
      if (!checked.ok) return { stageable: false };
      await this.ensureIntegrationWorkspace();
      if (await this.specPathHasLinkComponent(checked.path)) return { stageable: false };
      // C2d repair cycle 1 (escalation C-1): the pre-render check agrees
      // with the stage-time guard above. A colliding ancestor makes the
      // copy unstageable here, so STATE.md renders "not recorded" instead
      // of naming a copy the commit cannot hold.
      const ancestorCollision = await this.commitStateNonLinkBlocker("HEAD");
      if (ancestorCollision !== null && ancestorCollision.kind === "case-collision") return { stageable: false };
      const absolute = this.containedProjectDocPath(checked.path);
      let existing: Buffer | null = null;
      try {
        existing = await readFile(absolute);
      } catch (error) {
        if (!isNodeError(error) || error.code !== "ENOENT") return { stageable: false };
      }
      if (existing !== null && !existing.equals(Buffer.from(input.content, "utf8"))) {
        // C2c repair cycle 2 (m-4): an occupant is path_occupied, not a
        // generic write failure -- the runtime records the real cause.
        return { stageable: false, unstageableReason: "path_occupied" };
      }
      const dry = await this.git(this.path, ["add", "--dry-run", "--ignore-missing", "--", checked.path], true);
      return { stageable: dry.exitCode === 0 };
    });
  }

  /**
   * True when any component of a spec-copy path -- every component from
   * the repository root down to the file itself -- is a link (C2c repair
   * BL-1). Delegates to firstLinkComponent below.
   */
  private async specPathHasLinkComponent(relativePath: string): Promise<boolean> {
    return (await this.firstLinkComponent(relativePath)) !== null;
  }

  /**
   * The first path component -- every component from the repository root
   * down to the file itself -- that is a link, or null (C2c repair CD-17,
   * M-1). Link-ness comes from the worktree AND the git index, so a
   * link-mode entry (mode 120000) checked out as a plain file under
   * core.symlinks=false still counts. A directory the worktree reports as
   * a plain directory is additionally probed with readlink, which resolves
   * Windows junctions (lstat reports those as directories). A path through
   * a link can never stage inside the repository, so callers refuse before
   * any byte is written anywhere.
   */
  private async firstLinkComponent(relativePath: string): Promise<string | null> {
    const parts = relativePath.split("/");
    const components: string[] = [];
    let accumulated = "";
    for (const part of parts) {
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      components.push(accumulated);
    }
    const modes = await this.indexEntryModes(components);
    for (const component of components) {
      // C2c repair cycle 4 (NB-8): the CD-17 directory check folds case
      // (a committed `Docs` link counts for `docs`).
      if (IntegrationManager.findIndexEntry(modes, component, true)?.mode === "120000") return component;
      const absolute = this.containedProjectDocPath(component);
      let stats;
      try {
        stats = await lstat(absolute);
      } catch (error) {
        // C2e (F-matrix): a component below a tracked file (a `docs` file
        // with `docs/project` queried) reports ENOTDIR, not ENOENT. Neither
        // means a link: the file itself is not one, and nothing below it
        // can be one either.
        if (!isNodeError(error) || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) throw error;
        continue;
      }
      if (stats.isSymbolicLink()) return component;
      if (stats.isDirectory() && await isJunction(absolute)) return component;
    }
    return null;
  }

  /**
   * The first linked directory above a redirect target, if any (C2c repair
   * cycle 2, m-4): the stager names this junction in the skip reason instead
   * of blaming the target's own tracking.
   */
  private async ancestorLinkComponent(target: string): Promise<string | null> {
    const slash = target.lastIndexOf("/");
    if (slash <= 0) return null;
    return await this.firstLinkComponent(target.slice(0, slash));
  }

  private async refuseProjectDocLink(relativePath: string): Promise<void> {
    // C2c repair CD-17: every path component from the repository root is
    // checked (docs, docs/project, ...), so a docs link can never send a
    // write outside the repository. The v1 Architect path keeps refusing
    // (this throw); the kernel path skips with a recorded reason instead.
    // C2b repair B3: link-ness comes from the worktree AND the git index,
    // so a link-mode entry (mode 120000) checked out as a plain file under
    // core.symlinks=false is still refused. The refusal message is
    // unchanged from HEAD.
    const linked = await this.firstLinkComponent(relativePath);
    if (linked !== null) {
      throw new Error(
        `Project document path ${relativePath} is refused because ${linked} is a symbolic link or junction.`,
      );
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

  /**
   * Refuse a dirty index/worktree before any new-policy mutation. With a
   * clean preflight the transaction baseline recorded below is provably
   * ours, so a later rollback can never delete foreign edits.
   */
  private async assertCleanForNewPolicyIntegration(changeSetId: string): Promise<void> {
    const status = await this.git(this.path, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ]);
    if (status.stdout.length !== 0) {
      throw new Error(
        `Refusing new-policy integration of change set ${changeSetId} on a dirty worktree; clean the integration checkout first.`
      );
    }
  }

  /** Refuse to resume through an unfinished cherry-pick/merge sequencer state. */
  private async assertNoIncompleteIntegrationTransaction(changeSetId: string): Promise<void> {
    for (const state of ["CHERRY_PICK_HEAD", "MERGE_HEAD"] as const) {
      const pending = await this.git(this.path, ["rev-parse", "--verify", state], true);
      if (pending.exitCode === 0) {
        throw new Error(
          `Refusing new-policy integration of change set ${changeSetId} with an unfinished ${state} transaction; resolve it by hand first.`
        );
      }
    }
  }

  /** Whether an integration history commit is this change set's owned stamp for one source. */
  private isOwnedStampedCommit(
    commit: { committerName: string; committerEmail: string; body: string },
    changeSet: ChangeSet,
    requirementIds: readonly string[],
    source: string,
  ): boolean {
    return (
      commit.committerName === RUNNER_IDENTITY.GIT_COMMITTER_NAME &&
      commit.committerEmail === RUNNER_IDENTITY.GIT_COMMITTER_EMAIL &&
      isAuthoritativeIntegrationBody(commit.body, {
        runId: changeSet.runId,
        taskId: changeSet.taskId,
        requirementIds,
        source,
      })
    );
  }

  /**
   * Never silently accept an applied ref: the recorded chain must carry
   * the authoritative stamp for every source commit. Anything else
   * (unstamped, forged, or legacy trailers) is refused fail-closed.
   */
  private async assertAuthoritativeAppliedChain(
    changeSet: ChangeSet,
    requirementIds: readonly string[],
    appliedRef: string,
    appliedRevision: string,
  ): Promise<void> {
    const sources = changeSet.commits;
    const history = await this.git(this.path, [
      "log",
      "--format=%H%x00%cn%x00%ce%x00%B%x00",
      "-n",
      String(sources.length),
      appliedRevision,
    ]);
    const fields = history.stdout.split("\0");
    const entries: Array<{ revision: string; committerName: string; committerEmail: string; body: string }> = [];
    for (let index = 0; index + 3 < fields.length; index += 4) {
      const revision = fields[index].trim();
      if (revision) {
        entries.push({
          revision,
          committerName: (fields[index + 1] ?? "").trim(),
          committerEmail: (fields[index + 2] ?? "").trim(),
          body: fields[index + 3] ?? "",
        });
      }
    }
    const valid =
      entries.length === sources.length &&
      entries.every((entry, position) =>
        this.isOwnedStampedCommit(entry, changeSet, requirementIds, sources[sources.length - 1 - position]!)
      );
    if (!valid) {
      throw new Error(
        `Applied change-set ref ${appliedRef} does not carry the authoritative integration trailers; refusing to accept it.`
      );
    }
  }

  /** Oldest-first integration history entries with committer identity and bodies. */
  private async integrationHistoryEntries(): Promise<Array<{ revision: string; committerName: string; committerEmail: string; body: string }>> {
    const history = await this.git(this.path, [
      "log",
      "--reverse",
      "--format=%H%x00%cn%x00%ce%x00%B%x00",
      `${this.baselineRevision}..HEAD`,
    ]);
    const fields = history.stdout.split("\0");
    const commits: Array<{ revision: string; committerName: string; committerEmail: string; body: string }> = [];
    for (let index = 0; index + 3 < fields.length; index += 4) {
      const revision = fields[index].trim();
      if (revision) {
        commits.push({
          revision,
          committerName: (fields[index + 1] ?? "").trim(),
          committerEmail: (fields[index + 2] ?? "").trim(),
          body: fields[index + 3] ?? "",
        });
      }
    }
    return commits;
  }

  /**
   * Bounded recovery over the owned prefix. Returns the longest validated
   * stamped prefix (possibly complete). Never repairs an unstamped tip from message claims alone: without a
   * durable exact transaction receipt it is unproven. Refuses ambiguity instead of duplicating
   * changes or silently accepting them.
   */
  private async recoverOwnedIntegrationPrefix(
    changeSet: ChangeSet,
    requirementIds: readonly string[],
  ): Promise<{ prefixCount: number; prefixRevision: string | null }> {
    const sources = changeSet.commits;
    const commits = await this.integrationHistoryEntries();
    let count = 0;
    let end = -1;
    for (let start = 0; start < commits.length; start += 1) {
      let run = 0;
      while (
        run < sources.length &&
        start + run < commits.length &&
        this.isOwnedStampedCommit(commits[start + run]!, changeSet, requirementIds, sources[run]!)
      ) {
        run += 1;
      }
      if (run > count) {
        count = run;
        end = start + run - 1;
      }
    }
    if (count >= sources.length) {
      return { prefixCount: count, prefixRevision: commits[end]!.revision };
    }
    const rest = commits.slice(end + 1);
    const downstream = new Set<number>();
    for (const commit of rest) {
      for (let index = count; index < sources.length; index += 1) {
        if (commit.body.includes(`(cherry picked from commit ${sources[index]})`)) downstream.add(index);
      }
    }
    if (downstream.size > 0) {
      throw new Error(
        `Change set ${changeSet.id} has unexpected downstream integration commits after its owned prefix; refusing to resume.`
      );
    }
    return { prefixCount: count, prefixRevision: count > 0 ? commits[end]!.revision : null };
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

/**
 * Kernel spec-copy writes live under docs/project/specs/ (C2b CD-5). Only
 * these writes get the conditional-copy tolerance in commitHandoffSnapshot;
 * entry writes keep their strict staging.
 */
function isHandoffSpecCopyPath(path: string): boolean {
  // C2d: fold case so a spec copy staged through the index's own spelling
  // (`Docs/project/specs/...`) still classifies as a spec copy.
  const folded = path.toLowerCase();
  return folded.startsWith("docs/project/specs/") && folded.endsWith(".md");
}

/**
 * Report a commit's real spelling under the canonical handoff spelling
 * (C2d): `Docs/project/STATE.md` reads as `docs/project/STATE.md`, and the
 * same for the entry files and spec copies. Applied only on a
 * case-insensitive checkout, where both spellings name the same file, so
 * the unchanged AR-R05 gate and describer keep working while the commit
 * holds the index's own spelling. Every other path passes through
 * untouched.
 */
function canonicalHandoffSpelling(path: string): string {
  if (path === "AGENTS.md" || path === "CLAUDE.md" || path === "docs/project/STATE.md") return path;
  const folded = path.toLowerCase();
  if (folded === "agents.md") return "AGENTS.md";
  if (folded === "claude.md") return "CLAUDE.md";
  if (folded === "docs/project/state.md") return "docs/project/STATE.md";
  if (folded.startsWith("docs/project/specs/") && folded.endsWith(".md")) {
    return `docs/project/specs/${path.slice("docs/project/specs/".length)}`;
  }
  return path;
}

/**
 * True when a link target resolves to the sibling AGENTS.md (C2b repair
 * B3): "AGENTS.md" (also "./AGENTS.md" or other dot-only spellings), never
 * an escape (".."), an absolute path, or a backslash layout.
 */
/**
 * Resolve a raw entry-file link target to a repository-relative path, or
 * null when it escapes or is unusable (C2c NF-2/CD-15): dot-only spellings
 * ("./AGENTS.md") resolve to the sibling; an absolute path, a drive-letter
 * path, or any ".." escape is outside the repository and never written.
 * C2c repair M-2: backslashes normalize to slashes first (git for Windows
 * stores real-link targets like "docs\notes.md"); the checks below still
 * refuse absolute paths, drive letters, and every ".." escape.
 */
function resolveEntryLinkTarget(target: string): string | null {
  // C2c repair cycle 2: one shared spelling with the commit describer.
  return resolveHandoffLinkTarget(target);
}

/**
 * Every upper/lower-case variant of a fixed name (C2c repair cycle 4,
 * NB-7): each ASCII letter doubles the set, non-letters stay fixed
 * (`docs` gives 16, `project` and `STATE.md` give 128 each). The exact
 * spelling is always included.
 */
function caseVariants(want: string): string[] {
  // C2d: bound the explosion. Folding doubles per ASCII letter; the fixed
  // handoff names need at most 128 variants (`project`, `STATE.md`). A
  // longer dynamic name (a spec-copy filename) would produce millions of
  // pathspecs and break the `ls-tree` call, so folding is skipped there
  // and the single exact spelling is returned (one harmless repeat of the
  // exact query in `commitTreeEntryFolded`).
  let letters = 0;
  for (const char of want) {
    if (char.toLowerCase() !== char.toUpperCase()) {
      letters += 1;
      if (letters > 8) return [want];
    }
  }
  let variants = [""];
  for (const char of want) {
    const lower = char.toLowerCase();
    const upper = char.toUpperCase();
    if (lower !== upper) {
      variants = variants.flatMap((prefix) => [`${prefix}${lower}`, `${prefix}${upper}`]);
    } else {
      variants = variants.map((prefix) => `${prefix}${char}`);
    }
  }
  return variants;
}

/**
 * True when a raw link target lexically resolves inside the repository
 * when ".." is allowed to cancel a previous segment without escaping the
 * root (C2c repair M-5): "sub/../CLAUDE.md" lands inside, while absolute
 * paths, drive letters, and root-escaping ".." do not. Used only to NAME
 * the skip reason -- ".." targets are still never followed.
 */
function linkTargetResolvesInsideAllowingDotDot(target: string): boolean {
  const normalized = target.trim().replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0")) return false;
  if (normalized.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(normalized)) return false;
  let depth = 0;
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      depth -= 1;
      if (depth < 0) return false;
    } else {
      depth += 1;
    }
  }
  return true;
}

/**
 * The recorded STATE.md skip-reason kind for a stage-time non-link
 * blocker (C2e repair cycle 1, N-1; C2e repair cycle 2, N-R2-4). A case
 * collision records the collision wording, so stored logs (which carry
 * the legacy link sentence as a plain string) still replay unchanged.
 */
function stateBlockerReasonKind(
  kind: "file-not-dir" | "dir-not-file" | "case-collision" | "submodule",
): HandoffStateBlockerKind | null {
  if (kind === "file-not-dir") return "file";
  if (kind === "dir-not-file") return "directory";
  if (kind === "submodule") return "submodule";
  if (kind === "case-collision") return "collision";
  return null;
}

/**
 * Literal-pathspec chunks bounded by command-line bytes as well as count
 * (C2e repair cycle 2, B-2). The written-path checks pass every path as a
 * `:(literal)` argument of one git call; a fixed count alone overflows the
 * Windows 32,767-character command line when paths are long (200 paths
 * averaging 150+ characters fail with Win32 206 / ENAMETOOLONG). Each
 * chunk holds at most 16 KiB of pathspec text and at most 200 paths; a
 * single path longer than the budget still goes out alone (one path per
 * call), so a path of any length is checked.
 */
const WRITTEN_PATH_CHUNK_BYTES = 16 * 1024;
const WRITTEN_PATH_CHUNK_COUNT = 200;

function* chunkLiteralPathspecs(paths: readonly string[]): Generator<string[]> {
  let chunk: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const spec = `:(literal)${path}`;
    const size = Buffer.byteLength(spec, "utf8") + 1;
    if (chunk.length > 0 && (chunk.length >= WRITTEN_PATH_CHUNK_COUNT || bytes + size > WRITTEN_PATH_CHUNK_BYTES)) {
      yield chunk;
      chunk = [];
      bytes = 0;
    }
    chunk.push(spec);
    bytes += size;
  }
  if (chunk.length > 0) yield chunk;
}

/**
 * The recorded detail for a skipped entry-file link (C2c repair M-5): the
 * real reason, not a blanket "outside". A kernel-owned target
 * (docs/project/STATE.md, spec copies) is named as kernel-owned; a ".."
 * target that resolves inside is named as a refused ".." (it is still
 * never followed); anything else unusable is outside; a resolved target
 * that is no regular tracked file keeps that reason.
 */
function entryLinkSkipDetail(raw: string, target: string | null, ancestorLink: string | null = null): string {
  const display = raw.replace(/\s+/g, " ").trim().slice(0, 120) || "an unreadable target";
  if (target !== null) {
    if (target === "docs/project/STATE.md" || isHandoffSpecCopyPath(target)) {
      return `target ${target} is kernel-owned (the runner writes it; entry sections never redirect into it)`;
    }
    if (ancestorLink !== null) {
      return `target ${target} is not reachable: ${ancestorLink} is a symbolic link or junction`;
    }
    return `target ${target} is not a regular tracked file`;
  }
  if (linkTargetResolvesInsideAllowingDotDot(raw)) {
    return `target ${display} uses ".." and is never followed (it resolves inside the repository)`;
  }
  return `target ${display} is outside the repository`;
}

/**
 * True when an absolute worktree path is a Windows junction (C2c repair
 * M-1/CD-17): lstat reports junctions as plain directories, but readlink
 * resolves them. A readlink failure means a plain directory (or file);
 * other errors propagate. No child_process: pure fs probing.
 */
async function isJunction(absolute: string): Promise<boolean> {
  try {
    await readlink(absolute);
    return true;
  } catch (error) {
    if (!isNodeError(error)) throw error;
    if (error.code === "EINVAL" || error.code === "ENOENT" || error.code === "ENOSYS" || error.code === "ENOTSUP" || error.code === "UNKNOWN") {
      return false;
    }
    throw error;
  }
}

function linkTargetPointsAtAgentsDotMd(target: string): boolean {
  const trimmed = target.trim();
  if (!trimmed || trimmed.includes("\0") || trimmed.includes("\\")) return false;
  if (trimmed.startsWith("/")) return false;
  const parts: string[] = [];
  for (const segment of trimmed.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return false;
    parts.push(segment);
  }
  // C2d repair cycle 1 (m-1): the identity folds case -- a link to the
  // index's own `agents.md` spelling counts the way `AGENTS.md` does, so
  // the pointer is satisfied through the link instead of merged into the
  // file itself. Only this comparison folds; link detection itself still
  // requires the exact index entry.
  return parts.length === 1 && (parts[0] ?? "").toLowerCase() === "agents.md";
}

/** Bounded, message-only error detail for recorded skip reasons. */
function briefErrorDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 160) || "unknown error";
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
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

function projectDocumentConflictPaths(paths: readonly string[]): string[] {
  return paths.filter((path) => {
    const normalized = path.replace(/\\/g, "/");
    return normalized === "docs/project" || normalized.startsWith("docs/project/");
  });
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
