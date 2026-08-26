import type {
  BuildTask,
  TaskGraphIssue,
  TaskGraphValidation,
  TaskStatus,
} from "./task-contracts.js";
import { isFinalVerificationTask } from "./task-contracts.js";
import { validateAcceptanceCriteria } from "./acceptance-contracts.js";
import { planFinalVerification } from "./final-verification-contracts.js";

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  planned: ["assigned", "cancelled"],
  assigned: ["running", "planned", "cancelled"],
  running: ["waiting_guidance", "submitted", "failed", "cancelled"],
  waiting_guidance: ["running", "planned", "cancelled"],
  submitted: ["architect_review"],
  architect_review: ["approved", "rejected"],
  approved: ["integrating", "cancelled"],
  rejected: ["planned", "cancelled"],
  integrating: ["integrated", "integration_resolution"],
  integration_resolution: ["integrating", "cancelled"],
  integrated: [],
  failed: ["planned", "cancelled"],
  cancelled: [],
};

export function validateTaskGraph(
  tasks: readonly BuildTask[],
  options: { requireAcceptanceCriteria?: boolean } = {}
): TaskGraphValidation {
  const issues: TaskGraphIssue[] = [];
  const counts = new Map<string, number>();
  for (const task of tasks) counts.set(task.id, (counts.get(task.id) ?? 0) + 1);
  for (const [id, count] of counts) {
    if (count > 1) {
      issues.push({
        code: "duplicate_task_id",
        taskId: id,
        message: `Task ID ${id} occurs ${count} times.`,
      });
    }
  }

  const ids = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    if (isFinalVerificationTask(task)) {
      try {
        if (!task.generationId.trim() || !task.targetRevision.trim()) {
          throw new Error("generation and target revision are required");
        }
        if (!Number.isSafeInteger(task.planVersion) || task.planVersion < 1) {
          throw new Error("plan version must be a positive integer");
        }
        if (Object.hasOwn(task, "changeSetId") && task.changeSetId !== undefined) {
          throw new Error("final verification tasks cannot carry a ChangeSet");
        }
        planFinalVerification(task.verificationPlan);
      } catch (error) {
        issues.push({
          code: "invalid_final_verification_task",
          taskId: task.id,
          message: `Final verification task ${task.id} is invalid: ${
            error instanceof Error ? error.message : String(error)
          }.`,
        });
      }
      continue;
    }
    if (task.kind === "verification_repair") {
      if (
        !task.verificationRepair ||
        !task.verificationRepair.sourceGenerationId.trim() ||
        !task.verificationRepair.finalVerificationTaskId.trim() ||
        !validVerificationRepairSource(task.verificationRepair.source) ||
        !task.verificationRepair.targetRevision.trim() ||
        task.verificationRepair.categories.length === 0 ||
        new Set(task.verificationRepair.categories).size !== task.verificationRepair.categories.length
      ) {
        issues.push({
          code: "invalid_final_verification_task",
          taskId: task.id,
          message: `Verification repair task ${task.id} has invalid provenance.`,
        });
      }
    } else if (task.verificationRepair !== undefined) {
      issues.push({
        code: "invalid_final_verification_task",
        taskId: task.id,
        message: `Implementation task ${task.id} cannot carry verification repair provenance.`,
      });
    }
    if (
      task.generationId !== undefined ||
      task.targetRevision !== undefined ||
      task.planVersion !== undefined ||
      task.verificationPlan !== undefined ||
      task.verificationSubmissionId !== undefined ||
      task.verificationReviewId !== undefined
    ) {
      issues.push({
        code: "invalid_final_verification_task",
        taskId: task.id,
        message: `Implementation task ${task.id} cannot carry final verification metadata.`,
      });
    }
  }
  const strictCriteria = options.requireAcceptanceCriteria === true ||
    tasks.some((task) => task.acceptanceCriteria !== undefined);
  if (strictCriteria) {
    for (const task of tasks) {
      if (isFinalVerificationTask(task)) continue;
      if (task.status === "cancelled") continue;
      if (!task.acceptanceCriteria) {
        issues.push({
          code: "missing_acceptance_criteria",
          taskId: task.id,
          message: `Task ${task.id} requires at least one acceptance criterion.`,
        });
        continue;
      }
      const criteria = validateAcceptanceCriteria(task.acceptanceCriteria);
      for (const issue of criteria.issues) {
        issues.push({
          code: issue.toLowerCase().includes("duplicate")
            ? "duplicate_acceptance_criterion_id"
            : "invalid_acceptance_criterion",
          taskId: task.id,
          message: `Task ${task.id}: ${issue}`,
        });
      }
    }
  }
  const missing = new Set<string>();
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      const key = `${task.id}\0${dependency}`;
      if (!ids.has(dependency) && !missing.has(key)) {
        missing.add(key);
        issues.push({
          code: "missing_dependency",
          taskId: task.id,
          dependencyId: dependency,
          message: `Task ${task.id} depends on missing task ${dependency}.`,
        });
      }
    }
  }

  const byId = new Map(tasks.map((task) => [task.id, task]));
  const cycle = findCycle(byId);
  if (cycle) {
    issues.push({
      code: "dependency_cycle",
      cycle,
      message: `Task dependencies contain a cycle: ${cycle.join(" -> ")}.`,
    });
  }
  return { valid: issues.length === 0, issues };
}

export function readyTaskIds(tasks: readonly BuildTask[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  return tasks
    .filter(
      (task) =>
        !isFinalVerificationTask(task) &&
        task.status === "planned" &&
        task.dependencies.every(
          (dependency) => byId.get(dependency)?.status === "integrated"
        )
    )
    .map((task) => task.id);
}

export function applyTaskTransition(
  task: BuildTask,
  status: TaskStatus,
  patch: Partial<Omit<BuildTask, "id" | "status">> = {}
): BuildTask {
  if (
    task.kind === "verification_repair" &&
    (Object.hasOwn(patch, "verificationRepair") || Object.hasOwn(patch, "kind"))
  ) {
    throw new Error("Verification repair provenance and kind are immutable.");
  }
  if (isFinalVerificationTask(task)) {
    if (status !== "cancelled") {
      throw new Error(
        `Kernel-owned final verification task ${task.id} cannot be scheduled as a worker task.`
      );
    }
    if (Object.hasOwn(patch, "changeSetId") && patch.changeSetId !== undefined) {
      throw new Error("Final verification tasks cannot produce a ChangeSet.");
    }
    for (const field of [
      "kind",
      "generationId",
      "targetRevision",
      "planVersion",
      "verificationPlan",
    ] as const) {
      if (Object.hasOwn(patch, field)) {
        throw new Error(`Final verification task ${field} is immutable.`);
      }
    }
  }
  if (!TRANSITIONS[task.status].includes(status)) {
    throw new Error(
      `Task ${task.id} cannot transition from ${task.status} to ${status}.`
    );
  }
  if (Object.hasOwn(patch, "acceptanceCriteria")) {
    throw new Error("Acceptance criteria cannot mutate through a task transition.");
  }
  if (Object.hasOwn(patch, "criterionEvidenceLinks") && status !== "submitted") {
    throw new Error("Criterion evidence links may only be recorded when submitting a task.");
  }
  const startsRetry =
    status === "planned" && (task.status === "rejected" || task.status === "failed");
  return {
    ...task,
    ...patch,
    ...(task.acceptanceCriteria
      ? { acceptanceCriteria: task.acceptanceCriteria.map((criterion) => ({ ...criterion })) }
      : {}),
    ...(task.criterionEvidenceLinks
      ? {
          criterionEvidenceLinks: task.criterionEvidenceLinks.map((link) => ({
            ...link,
            artifactHashes: [...link.artifactHashes],
          })),
        }
      : {}),
    ...(patch.criterionEvidenceLinks
      ? {
          criterionEvidenceLinks: patch.criterionEvidenceLinks.map((link) => ({
            ...link,
            artifactHashes: [...link.artifactHashes],
          })),
        }
      : {}),
    ...(startsRetry
      ? {
          assignedWorkerId: undefined,
          changeSetId: undefined,
          criterionEvidenceLinks: undefined,
          failureReason: undefined,
        }
      : {}),
    status,
  };
}

function validVerificationRepairSource(
  source: import("./task-contracts.js").VerificationRepairProvenance["source"],
): boolean {
  if (source.type === "semantic_review") {
    return Boolean(source.submissionId.trim() && source.reviewId.trim());
  }
  return Boolean(
    source.failureId.trim() &&
    source.issueIds.length > 0 &&
    new Set(source.issueIds).size === source.issueIds.length &&
    new Set(source.factIds).size === source.factIds.length
  );
}

function findCycle(byId: ReadonlyMap<string, BuildTask>): string[] | null {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: string[] = [];

  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      return [...path.slice(start), id];
    }
    if (visited.has(id)) return null;
    visiting.add(id);
    path.push(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      if (!byId.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    path.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  for (const id of byId.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}
