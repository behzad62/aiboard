export function standardWorkerId(taskId: string, attempt: number): string {
  return `worker_${taskId}_${attempt}`;
}

export function steeringReassignedWorkerId(
  taskId: string,
  attempt: number,
  planRevision: number
): string {
  return `${standardWorkerId(taskId, attempt)}_plan_${planRevision}`;
}

export function isSteeringReassignedWorkerId(
  taskId: string,
  attempt: number,
  workerId: string
): boolean {
  const prefix = `${standardWorkerId(taskId, attempt)}_plan_`;
  if (!workerId.startsWith(prefix)) return false;
  const revision = Number(workerId.slice(prefix.length));
  return Number.isSafeInteger(revision) && revision > 0 &&
    workerId === steeringReassignedWorkerId(taskId, attempt, revision);
}

export function workerSessionId(
  runId: string,
  taskId: string,
  attempt: number,
  workerId: string
): string {
  const legacySessionId = `worker:${runId}:${taskId}:${attempt}`;
  return workerId === standardWorkerId(taskId, attempt)
    ? legacySessionId
    : `${legacySessionId}:${workerId}`;
}

export function resolveWorkerSessionId(
  runId: string,
  taskId: string,
  attempt: number,
  workerId: string,
  persistedSessionId?: string
): string {
  return persistedSessionId ?? workerSessionId(runId, taskId, attempt, workerId);
}
