import { createHash } from "node:crypto";
import { readyPlanIdentity, resolveTaskContractReference, type SchedulerProjection } from "./scheduler-store.js";
import { assignmentMatchesTask, claimPathsEqual } from "./task-resource-claims.js";
import type { SubmissionScopeIdentity } from "./submission-scope-contracts.js";
import { bindSubmissionScope, type SubmissionScopeRecord } from "./submission-scope-contracts.js";
import { inspectSubmissionScope } from "./submission-guard.js";
import { localSubmissionClaim } from "./submission-guard-git.js";

/** Capture runner-owned authority while the claim is active, before submission releases it. */
export function captureSubmissionScopeIdentity(projection: SchedulerProjection, context: {
  runId: string; taskId: string; attempt: number; workerId: string; sessionId: string;
  workspacePath: string; baselineRevision: string;
}): SubmissionScopeIdentity | undefined {
  if (projection.submissionScopePolicyVersion !== 1) return undefined;
  const task = projection.tasks[context.taskId];
  const ready = readyPlanIdentity(projection);
  const authority = resolveTaskContractReference(projection, context.taskId);
  const runtime = projection.runtime.workerAssignments[`${context.taskId}:${context.attempt}`];
  const claims = Object.values(projection.planning?.assignments ?? {}).map((entry) => entry.claim)
    .filter((claim) => assignmentMatchesTask(claim.packetId, context.taskId));
  const claim = claims.sort((left, right) => right.ownershipGeneration - left.ownershipGeneration)[0];
  if (projection.runId !== context.runId || !task || task.attempt !== context.attempt || task.assignedWorkerId !== context.workerId ||
    !ready || authority.status !== "current" || authority.ref.revisionId !== ready.revisionId || authority.ref.digest !== ready.digest ||
    !runtime || runtime.sessionId !== context.sessionId || !claim || claim.state !== "claimed" || claim.workerOrSessionId !== context.workerId ||
    !claimPathsEqual(claim.branchOrWorktree, context.workspacePath) || claim.acceptedBaseRevision !== context.baselineRevision) {
    throw new Error("Submission guard requires the exact current task, runtime session, claim and ready plan.");
  }
  return { version: 1, runId: context.runId, taskId: context.taskId, attempt: context.attempt,
    sessionId: context.sessionId, workerId: context.workerId, baselineRevision: context.baselineRevision,
    contractRef: { ...authority.ref }, claim: structuredClone(claim) };
}

/** Kernel recomputes all scope facts and their IDs from the exact captured authority. */
export function validateSubmissionScopeRecord(projection: SchedulerProjection, taskId: string, changeSetId: string, value: unknown): SubmissionScopeRecord {
  const task = projection.tasks[taskId];
  const runtime = task && projection.runtime.workerAssignments[`${taskId}:${task.attempt}`];
  if (!value || typeof value !== "object" || Array.isArray(value) || !task?.workspacePath || !task.workspaceBaselineRevision || !task.assignedWorkerId || !runtime) throw new Error("Submission scope record requires current owned task authority.");
  const record = value as SubmissionScopeRecord;
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.taskRevision) || !Array.isArray(record.files) || record.files.length > 10_000 ||
    record.files.some((file) => !file || typeof file.path !== "string" || typeof file.added !== "boolean") || new Set(record.files.map((file) => file.path)).size !== record.files.length) throw new Error("Submission scope inventory is invalid.");
  const expectedId = `changeset_${createHash("sha256").update(`${projection.runId}\0${taskId}\0${record.taskRevision}`).digest("hex")}`;
  if (changeSetId !== expectedId) throw new Error("Submission scope change set identity differs from the exact task revision.");
  const identity = captureSubmissionScopeIdentity(projection, { runId: projection.runId, taskId, attempt: task.attempt,
    workerId: task.assignedWorkerId, sessionId: runtime.sessionId, workspacePath: task.workspacePath, baselineRevision: task.workspaceBaselineRevision });
  if (!identity) throw new Error("Submission scope record requires activated policy.");
  const findings = inspectSubmissionScope(record.files.map((file) => ({ ...file, addedLines: [] })), localSubmissionClaim(identity.claim, task.workspacePath));
  const expected = bindSubmissionScope(identity, changeSetId, record.taskRevision, findings, record.files);
  if (JSON.stringify(record) !== JSON.stringify(expected)) throw new Error("Submission scope record differs from its exact runner authority or mechanical findings.");
  return expected;
}
