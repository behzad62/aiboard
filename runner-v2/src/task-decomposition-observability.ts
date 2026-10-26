import type { BudgetProjection } from "./budget-ledger.js";
import type { SchedulerEvent, SchedulerProjection } from "./scheduler-store.js";
import type {
  DecompositionReviewUsage,
  TaskDecompositionObservation,
  TaskDecompositionObservability,
} from "./task-decomposition-contracts.js";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/** An inventory counts only when durably bound to this exact submitted attempt. */
function submissionPaths(event: SchedulerEvent, attempt: number | undefined): string[] | undefined {
  const patch = record(event.payload.patch);
  const scope = record(patch?.submissionScope);
  if (!scope || attempt === undefined || scope.runId !== event.runId || scope.taskId !== event.payload.taskId ||
    scope.attempt !== attempt || scope.changeSetId !== patch?.changeSetId ||
    !Array.isArray(scope.files)) return undefined;
  const paths: string[] = [];
  for (const entry of scope.files) {
    const file = record(entry);
    if (typeof file?.path !== "string" || !file.path.trim()) return undefined;
    paths.push(file.path);
  }
  return paths;
}

function projectReviewUsage(budget: BudgetProjection | undefined): DecompositionReviewUsage | null {
  if (!budget) return null;
  const usage: DecompositionReviewUsage = {
    settledCalls: 0, pendingCalls: 0, inputTokens: 0, outputTokens: 0,
    apiEstimatedCostMicros: null, apiPricedCalls: 0, accountBackedCalls: 0,
    unknownCostCalls: 0, unattributedModelCalls: 0,
  };
  // Reservations retain prior usage windows; effective/lifetime aggregates cannot isolate reviewers.
  for (const reservation of Object.values(budget.reservations)) {
    if (reservation.kind !== "model") continue;
    if (!reservation.attribution) {
      usage.unattributedModelCalls++;
      continue;
    }
    if (reservation.attribution.role !== "verifier") continue;
    if (reservation.status !== "settled") {
      usage.pendingCalls++;
      continue;
    }
    usage.settledCalls++;
    usage.inputTokens += reservation.actual?.inputTokens ?? 0;
    usage.outputTokens += reservation.actual?.outputTokens ?? 0;
    if (reservation.costBasis?.kind === "account_not_metered") {
      usage.accountBackedCalls++;
    } else if (reservation.costBasis?.kind === "api_estimate" &&
      reservation.actual?.estimatedCostMicros !== undefined) {
      usage.apiPricedCalls++;
      usage.apiEstimatedCostMicros = (usage.apiEstimatedCostMicros ?? 0) + reservation.actual.estimatedCostMicros;
    } else {
      usage.unknownCostCalls++;
    }
  }
  return usage;
}

/**
 * Replay-only diagnostics from the FULL durable event history, never the UI's bounded tail.
 * These facts help evaluate decomposition over time; they never accept/reject a task or size it.
 */
export function projectTaskDecompositionObservability(
  projection: Pick<SchedulerProjection, "tasks">,
  events: readonly SchedulerEvent[],
  budget?: BudgetProjection,
): TaskDecompositionObservability {
  const tasks = Object.values(projection.tasks)
    .filter((task) => task.kind !== "final_verification")
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map((task): TaskDecompositionObservation => ({
      taskId: task.id, status: task.status, attempts: task.attempt,
      submissions: 0, submissionsWithFileInventory: 0, changedFileCount: null,
      independentReviews: 0, reusedReviews: 0, reviewDecisions: 0,
      correctionCycles: 0, integrationConflicts: 0,
    }));
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  const submissions = new Map<string, Map<string, string[] | undefined>>();
  const currentAttempts = new Map<string, number>();
  for (const event of events) {
    const task = byId.get(String(event.payload.taskId));
    if (!task) continue;
    const patch = record(event.payload.patch);
    if (event.type === "task.transitioned" && typeof patch?.attempt === "number" &&
      Number.isSafeInteger(patch.attempt) && patch.attempt > 0) {
      currentAttempts.set(task.taskId, patch.attempt);
    }
    if (event.type === "task.transitioned" && event.payload.status === "submitted") {
      const attempt = currentAttempts.get(task.taskId);
      const key = JSON.stringify([attempt, patch?.changeSetId ?? event.eventId]);
      const attempts = submissions.get(task.taskId) ?? new Map<string, string[] | undefined>();
      // The same lifecycle receipt can be observed by both the worker tool and scheduler.
      const paths = submissionPaths(event, attempt);
      if (!attempts.has(key) || paths !== undefined) attempts.set(key, paths);
      submissions.set(task.taskId, attempts);
    } else if (event.type === "task.transitioned" && event.payload.status === "integration_resolution") {
      task.integrationConflicts++;
    } else if (event.type === "review.decided") {
      task.reviewDecisions++;
      if (event.payload.decision === "rejected") task.correctionCycles++;
    } else if (event.type === "delivery.review_started") {
      task.independentReviews++;
    } else if (event.type === "delivery.review_reused") {
      task.reusedReviews++;
    }
  }
  const allPaths = new Set<string>();
  for (const task of tasks) {
    const attempts = submissions.get(task.taskId);
    if (!attempts) continue;
    const paths = new Set<string>();
    task.submissions = attempts.size;
    for (const inventory of attempts.values()) {
      if (inventory === undefined) continue;
      task.submissionsWithFileInventory++;
      for (const path of inventory) {
        paths.add(path);
        allPaths.add(path);
      }
    }
    if (task.submissionsWithFileInventory === task.submissions) task.changedFileCount = paths.size;
  }
  const submissionCount = tasks.reduce((sum, task) => sum + task.submissions, 0);
  const inventoryCount = tasks.reduce((sum, task) => sum + task.submissionsWithFileInventory, 0);
  const cancelledTaskCount = tasks.filter((task) => task.status === "cancelled").length;
  return {
    version: 1,
    taskCount: tasks.length,
    activeTaskCount: tasks.length - cancelledTaskCount,
    cancelledTaskCount,
    submissions: submissionCount,
    submissionsWithFileInventory: inventoryCount,
    uniqueChangedFileCount: submissionCount > 0 && inventoryCount === submissionCount ? allPaths.size : null,
    correctionCycles: tasks.reduce((sum, task) => sum + task.correctionCycles, 0),
    integrationConflicts: tasks.reduce((sum, task) => sum + task.integrationConflicts, 0),
    reviewUsage: projectReviewUsage(budget),
    tasks,
  };
}
