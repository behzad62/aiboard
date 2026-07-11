import { createHash } from "node:crypto";

import type { ArtifactStore } from "./artifact-store.js";
import { runGit } from "./git-command.js";
import type { TaskCommit } from "./workspace-manager.js";

export interface ExternalEffectReference {
  kind: string;
  idempotencyKey: string;
  artifactHash?: string;
}

export interface ChangeSet {
  id: string;
  runId: string;
  taskId: string;
  baselineRevision: string;
  taskRevision: string;
  commits: string[];
  changedPaths: string[];
  diffArtifactHash: string;
  evidenceArtifactHashes: string[];
  externalEffects: ExternalEffectReference[];
  guidanceIds: string[];
  memoryIds: string[];
  unresolvedConcerns: string[];
}

export interface CreateChangeSetOptions {
  workspacePath: string;
  taskCommit: TaskCommit;
  artifacts: ArtifactStore;
  evidenceArtifactHashes?: string[];
  externalEffects?: ExternalEffectReference[];
  guidanceIds?: string[];
  memoryIds?: string[];
  unresolvedConcerns?: string[];
}

export async function createChangeSet(
  options: CreateChangeSetOptions
): Promise<ChangeSet> {
  const commit = options.taskCommit;
  const evidence = unique(options.evidenceArtifactHashes ?? []);
  if (commit.commits.length === 0 && evidence.length === 0) {
    throw new Error(
      `No-change task ${commit.taskId} requires durable evidence before submission.`
    );
  }
  for (const hash of evidence) assertArtifactHash(hash);
  for (const effect of options.externalEffects ?? []) {
    if (!effect.kind || !effect.idempotencyKey) {
      throw new Error("External effects require kind and idempotencyKey.");
    }
    if (effect.artifactHash) assertArtifactHash(effect.artifactHash);
  }

  const diff = await runGit({
    cwd: options.workspacePath,
    args: [
      "diff",
      "--binary",
      "--full-index",
      commit.baselineRevision,
      commit.revision,
      "--",
    ],
    maxOutputBytes: 64 * 1024 * 1024,
  });
  const artifact = await options.artifacts.put(
    Buffer.from(diff.stdout),
    "text/x-diff",
    `Change set ${commit.runId}/${commit.taskId}`
  );
  const id = `changeset_${createHash("sha256")
    .update(`${commit.runId}\0${commit.taskId}\0${commit.revision}`)
    .digest("hex")}`;
  return {
    id,
    runId: commit.runId,
    taskId: commit.taskId,
    baselineRevision: commit.baselineRevision,
    taskRevision: commit.revision,
    commits: [...commit.commits],
    changedPaths: [...commit.changedPaths],
    diffArtifactHash: artifact.hash,
    evidenceArtifactHashes: evidence,
    externalEffects: [...(options.externalEffects ?? [])],
    guidanceIds: unique(options.guidanceIds ?? []),
    memoryIds: unique(options.memoryIds ?? []),
    unresolvedConcerns: unique(options.unresolvedConcerns ?? []),
  };
}

function assertArtifactHash(hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error(`Invalid artifact hash ${hash}.`);
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
