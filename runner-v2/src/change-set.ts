import { createHash } from "node:crypto";
import { captureEncodingSubmission, type EncodingSubmissionRecord } from "./encoding-safety.js";
import type { GitBinaryRunner } from "./git-command.js";
import { captureReviewSignals, type ReviewSignalsRecord } from "./review-integrity.js";

import type { ArtifactStore } from "./artifact-store.js";
import {
  assertAcceptanceCriteria,
  assertCriterionEvidenceCoverage,
  type AcceptanceCriterion,
  type CriterionEvidenceLink,
} from "./acceptance-contracts.js";
import type { EvidenceRecord } from "./evidence-store.js";
import { requireGitRunner } from "./git-command.js";
import type { GitRunner } from "./git-repository.js";
import type { TaskCommit } from "./workspace-manager.js";
import { inspectSubmissionTree } from "./submission-guard-git.js";
import { bindSubmissionScope, type SubmissionScopeIdentity, type SubmissionScopeRecord } from "./submission-scope-contracts.js";

export interface ExternalEffectReference {
  kind: string;
  idempotencyKey: string;
  artifactHash?: string;
}

export interface ChangeSet {
  encodingSubmission?: EncodingSubmissionRecord;
  reviewSignals?: ReviewSignalsRecord;
  submissionScope?: SubmissionScopeRecord;
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
  encodingSafetyPolicyVersion?: 1;
  executeBytes?: GitBinaryRunner;
  reviewIntegrityPolicyVersion?: 1;
  submissionScopeIdentity?: SubmissionScopeIdentity;
  execute?: GitRunner;
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
  /** Accountable worker whose evidence may support this submission. */
  assignedWorkerId?: string;
  /** Compatibility alias for callers that identify the submitting worker. */
  actorId?: string;
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
      ...(options.assignedWorkerId ?? options.actorId
        ? { assignedWorkerId: options.assignedWorkerId ?? options.actorId }
        : {}),
    });
  }
  if (criterionEvidenceLinks) {
    let submittedTreeId: string | undefined;
    try {
      const result = await requireGitRunner(options.execute)({cwd: options.workspacePath, args: ["rev-parse", "--verify", `${commit.revision}^{tree}`]});
      if (result.exitCode === 0 && /^[a-f0-9]{40,64}$/.test(result.stdout.trim())) submittedTreeId = result.stdout.trim();
    } catch { /* Unknown identities never imply freshness. */ }
    criterionEvidenceLinks = criterionEvidenceLinks.map((link) => {
      const record = options.evidenceRecords?.find((entry) => entry.id === link.evidenceId);
      if (record?.fact.kind !== "command" || record.fact.workingTreeIdentity === undefined) {
        const {freshness: _untrusted, ...legacy} = link; void _untrusted; return legacy;
      }
      const identity = record.fact.workingTreeIdentity;
      const evidenceTreeId = identity.status === "known" ? identity.treeId : identity.capturedTreeId;
      const status = evidenceTreeId && submittedTreeId ? evidenceTreeId === submittedTreeId ? identity.status === "known" ? "current" : "unknown" : "stale" : "unknown";
      return {...link, freshness: {status, ...(submittedTreeId ? {submittedTreeId} : {}), ...(evidenceTreeId ? {evidenceTreeId} : {}),
        ...(status === "stale" ? {reason: "taken before later edits"} : status === "unknown" ? {reason: "working-tree identity unavailable"} : {})}};
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

  let submissionFileInventory: Array<{ path: string; added: boolean }> = [];
  const submissionScope = options.submissionScopeIdentity
    ? bindSubmissionScope(options.submissionScopeIdentity,
      `changeset_${createHash("sha256").update(`${commit.runId}\0${commit.taskId}\0${commit.revision}`).digest("hex")}`,
      commit.revision, await inspectSubmissionTree({ git: requireGitRunner(options.execute), workspacePath: options.workspacePath,
        baselineRevision: commit.baselineRevision, candidateRevision: commit.revision, claim: options.submissionScopeIdentity.claim,
        captureInventory: (files) => { submissionFileInventory = files; } }), submissionFileInventory)
    : undefined;
  const diff = await requireGitRunner(options.execute)({
    cwd: options.workspacePath,
    args: [
      "diff",
      "--binary",
      "--full-index",
      ...(submissionScope ? ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"] : []),
      commit.baselineRevision,
      commit.revision,
      "--",
    ],
    maxOutputBytes: 64 * 1024 * 1024,
  });
  if (submissionScope && diff.exitCode !== 0) throw new Error("Submission diff capture failed.");
  const artifact = await options.artifacts.put(
    Buffer.from(diff.stdout),
    "text/x-diff",
    `Change set ${commit.runId}/${commit.taskId}`
  );
  const id = `changeset_${createHash("sha256")
    .update(`${commit.runId}\0${commit.taskId}\0${commit.revision}`)
    .digest("hex")}`;
  return {
    ...(options.encodingSafetyPolicyVersion === 1 ? { encodingSubmission: await captureEncodingSubmission({ git: requireGitRunner(options.execute), gitBytes: requireGitRunner(options.executeBytes), workspacePath: options.workspacePath, runId: commit.runId, taskId: commit.taskId, baselineRevision: commit.baselineRevision, taskRevision: commit.revision }) } : {}),
    ...(options.reviewIntegrityPolicyVersion === 1 ? { reviewSignals: await captureReviewSignals({ git: requireGitRunner(options.execute), workspacePath: options.workspacePath, runId: commit.runId, taskId: commit.taskId, baselineRevision: commit.baselineRevision, taskRevision: commit.revision }) } : {}),
    ...(submissionScope ? { submissionScope } : {}),
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
