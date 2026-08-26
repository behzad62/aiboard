import { createHash } from "node:crypto";

import type { ArtifactStore } from "./artifact-store.js";
import {
  assertAcceptanceCriteria,
  assertCriterionEvidenceCoverage,
  type AcceptanceCriterion,
  type CriterionEvidenceLink,
} from "./acceptance-contracts.js";
import type { EvidenceRecord } from "./evidence-store.js";
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
  /** Immutable criterion-to-evidence contract captured with this submission. */
  criterionEvidenceLinks?: CriterionEvidenceLink[];
  acceptanceCriteria?: AcceptanceCriterion[];
  acceptanceCriteriaVersion?: number;
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
  acceptanceCriteria?: readonly AcceptanceCriterion[];
  acceptanceCriteriaVersion?: number;
  criterionEvidenceLinks?: readonly CriterionEvidenceLink[];
  evidenceRecords?: readonly EvidenceRecord[];
  taskId?: string;
  attempt?: number;
  externalEffects?: ExternalEffectReference[];
  guidanceIds?: string[];
  memoryIds?: string[];
  unresolvedConcerns?: string[];
}

export async function createChangeSet(
  options: CreateChangeSetOptions
): Promise<ChangeSet> {
  const commit = options.taskCommit;
  const hasCriteria = options.acceptanceCriteria !== undefined;
  let criterionEvidenceLinks: CriterionEvidenceLink[] | undefined;
  if (hasCriteria) {
    assertAcceptanceCriteria(options.acceptanceCriteria!);
    if (!Number.isSafeInteger(options.attempt) || options.attempt! < 1) {
      throw new Error(`Task ${commit.taskId} requires a current attempt for criterion evidence.`);
    }
    const taskId = options.taskId ?? commit.taskId;
    if (taskId !== commit.taskId) {
      throw new Error(`Change set task ${taskId} does not match commit task ${commit.taskId}.`);
    }
    criterionEvidenceLinks = (options.criterionEvidenceLinks ?? []).map((link) => ({
      ...link,
      taskId: link.taskId ?? taskId,
      attempt: link.attempt ?? options.attempt,
      artifactHashes: [...link.artifactHashes],
    }));
    assertCriterionEvidenceCoverage(options.acceptanceCriteria!, criterionEvidenceLinks, {
      evidenceRecords: options.evidenceRecords,
      runId: commit.runId,
      taskId,
      attempt: options.attempt,
    });
  }
  const evidence = hasCriteria
    ? unique(criterionEvidenceLinks!.flatMap((link) => link.artifactHashes))
    : unique(options.evidenceArtifactHashes ?? []);
  if (evidence.length === 0) {
    throw new Error(
      `Task ${commit.taskId} requires durable evidence before submission.`
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
    ...(criterionEvidenceLinks
      ? {
          criterionEvidenceLinks,
          acceptanceCriteria: options.acceptanceCriteria!.map((criterion) => ({ ...criterion })),
          ...(options.acceptanceCriteriaVersion !== undefined
            ? { acceptanceCriteriaVersion: options.acceptanceCriteriaVersion }
            : {}),
        }
      : {}),
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
