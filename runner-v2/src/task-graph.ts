import type {
  BuildTask,
  TaskGraphIssue,
  TaskGraphValidation,
  TaskStatus,
} from "./task-contracts.js";
import { validateAcceptanceCriteria } from "./acceptance-contracts.js";

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
  const strictCriteria = options.requireAcceptanceCriteria === true ||
    tasks.some((task) => task.acceptanceCriteria !== undefined);
  if (strictCriteria) {
    for (const task of tasks) {
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
  if (!TRANSITIONS[task.status].includes(status)) {
    throw new Error(
      `Task ${task.id} cannot transition from ${task.status} to ${status}.`
    );
  }
  if (Object.hasOwn(patch, "acceptanceCriteria")) {
    throw new Error("Acceptance criteria cannot mutate through a task transition.");
  }
  return {
    ...task,
    ...patch,
    ...(task.acceptanceCriteria
      ? { acceptanceCriteria: task.acceptanceCriteria.map((criterion) => ({ ...criterion })) }
      : {}),
    status,
  };
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
