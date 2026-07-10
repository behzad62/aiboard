import type { BuildTask } from "./build";

export type BuildPlanContractIssueSeverity = "error" | "warning";
export type BuildPlanContractIssueCode =
  | "duplicate_task_id"
  | "unknown_dependency"
  | "self_dependency"
  | "dependency_cycle"
  | "unordered_output_overlap"
  | "missing_strict_tdd_contract"
  | "missing_tool_verification_contract"
  | "repo_task_not_terminal";

export interface BuildPlanContractIssue {
  code: BuildPlanContractIssueCode;
  severity: BuildPlanContractIssueSeverity;
  taskIds: string[];
  message: string;
}

export interface BuildPlanContractValidation {
  valid: boolean;
  errors: BuildPlanContractIssue[];
  warnings: BuildPlanContractIssue[];
}

export interface BuildPlanContractOptions {
  strictTdd?: boolean;
  verifyCommand?: string;
  phaseVerification?: string[];
}

export type BuildPlanContractResolution<T> =
  | {
      status: "valid";
      plan: T;
      validation: BuildPlanContractValidation;
      revisions: number;
    }
  | {
      status: "blocked";
      plan: T;
      validation: BuildPlanContractValidation;
      revisions: number;
    };

export async function resolveBuildPlanContract<T>(input: {
  initialPlan: T;
  validate: (plan: T) => BuildPlanContractValidation;
  revise: (
    plan: T,
    validation: BuildPlanContractValidation,
    revision: number
  ) => Promise<T | null>;
  maxRevisions?: number;
}): Promise<BuildPlanContractResolution<T>> {
  const maxRevisions = Math.max(0, Math.floor(input.maxRevisions ?? 2));
  let plan = input.initialPlan;
  let validation = input.validate(plan);
  let revisions = 0;

  while (!validation.valid && revisions < maxRevisions) {
    revisions += 1;
    const revised = await input.revise(plan, validation, revisions);
    if (revised !== null) {
      plan = revised;
      validation = input.validate(plan);
    }
  }

  return validation.valid
    ? { status: "valid", plan, validation, revisions }
    : { status: "blocked", plan, validation, revisions };
}

const taskIdKey = (id: string): string => id.trim().toLowerCase();

const pathKey = (path: string): string =>
  path
    .trim()
    .replace(/^["'`([{]+/, "")
    .replace(/["'`.,;:)\]}]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/")
    .toLowerCase();

function explicitOwnedPaths(task: BuildTask): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const raw of [...(task.outputPaths ?? []), ...(task.testOutputPaths ?? [])]) {
    const path = pathKey(raw);
    if (!path || /\s/.test(path) || seen.has(path)) continue;
    seen.add(path);
    paths.push(path);
  }
  return paths;
}

export function isLikelyTestOutputPath(rawPath: string): boolean {
  const path = pathKey(rawPath);
  if (!path || /\s/.test(path)) return false;
  const filename = path.split("/").pop() ?? path;
  return (
    path.startsWith("tests/") ||
    path.startsWith("test/") ||
    path.includes("/tests/") ||
    path.includes("/test/") ||
    path.includes("/__tests__/") ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(filename) ||
    /^test[-_.].*\.[cm]?[jt]sx?$/.test(filename)
  );
}

export function isStrictTddCodeOutputPath(rawPath: string): boolean {
  const path = pathKey(rawPath);
  if (!path || /\s/.test(path) || isLikelyTestOutputPath(path)) return false;
  return /\.(?:[cm]?[jt]sx?|py|go|rs|java|cs|php|rb)$/i.test(path);
}

const isTypedToolActionName = (value: string): boolean =>
  /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/.test(value.trim().toLowerCase());

function issue(
  code: BuildPlanContractIssueCode,
  severity: BuildPlanContractIssueSeverity,
  taskIds: string[],
  message: string
): BuildPlanContractIssue {
  return { code, severity, taskIds, message };
}

function reachable(
  fromId: string,
  targetId: string,
  tasksById: ReadonlyMap<string, BuildTask>
): boolean {
  const target = taskIdKey(targetId);
  const pending = [taskIdKey(fromId)];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const task = tasksById.get(current);
    if (!task) continue;
    for (const dependency of task.dependsOn ?? []) {
      const key = taskIdKey(dependency);
      if (tasksById.has(key) && !visited.has(key)) pending.push(key);
    }
  }
  return false;
}

function dependencyCycleIssues(
  tasksById: ReadonlyMap<string, BuildTask>
): BuildPlanContractIssue[] {
  const issues: BuildPlanContractIssue[] = [];
  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const seenCycles = new Set<string>();

  const visit = (id: string): void => {
    state.set(id, "visiting");
    stack.push(id);
    const task = tasksById.get(id);
    for (const rawDependency of task?.dependsOn ?? []) {
      const dependency = taskIdKey(rawDependency);
      if (dependency === id || !tasksById.has(dependency)) continue;
      if (!state.has(dependency)) {
        visit(dependency);
      } else if (state.get(dependency) === "visiting") {
        const start = stack.lastIndexOf(dependency);
        const cycle = stack.slice(start);
        const cycleKey = [...cycle].sort().join("|");
        if (!seenCycles.has(cycleKey)) {
          seenCycles.add(cycleKey);
          const taskIds = cycle.map((key) => tasksById.get(key)?.id ?? key);
          issues.push(
            issue(
              "dependency_cycle",
              "error",
              taskIds,
              `Dependency cycle detected: ${[...taskIds, taskIds[0]].join(" -> ")}.`
            )
          );
        }
      }
    }
    stack.pop();
    state.set(id, "visited");
  };

  for (const id of tasksById.keys()) {
    if (!state.has(id)) visit(id);
  }
  return issues;
}

export function validateBuildPlanContract(
  tasks: ReadonlyArray<BuildTask>,
  options: BuildPlanContractOptions = {}
): BuildPlanContractValidation {
  const errors: BuildPlanContractIssue[] = [];
  const warnings: BuildPlanContractIssue[] = [];
  const tasksById = new Map<string, BuildTask>();

  for (const task of tasks) {
    const key = taskIdKey(task.id);
    const existing = tasksById.get(key);
    if (existing) {
      errors.push(
        issue(
          "duplicate_task_id",
          "error",
          [existing.id, task.id],
          `Task id ${JSON.stringify(task.id)} is duplicated.`
        )
      );
    } else {
      tasksById.set(key, task);
    }
  }

  for (const task of tasks) {
    const taskKey = taskIdKey(task.id);
    for (const dependency of task.dependsOn ?? []) {
      const dependencyKey = taskIdKey(dependency);
      if (dependencyKey === taskKey) {
        errors.push(
          issue(
            "self_dependency",
            "error",
            [task.id],
            `Task ${task.id} depends on itself.`
          )
        );
      } else if (!tasksById.has(dependencyKey)) {
        errors.push(
          issue(
            "unknown_dependency",
            "error",
            [task.id],
            `Task ${task.id} depends on unknown task ${JSON.stringify(dependency)}.`
          )
        );
      }
    }
  }
  errors.push(...dependencyCycleIssues(tasksById));

  const pathOwners = new Map<string, BuildTask[]>();
  for (const task of tasks) {
    const owned = new Set(explicitOwnedPaths(task));
    for (const path of owned) {
      const owners = pathOwners.get(path) ?? [];
      owners.push(task);
      pathOwners.set(path, owners);
    }
  }
  for (const [path, owners] of pathOwners) {
    for (let left = 0; left < owners.length; left++) {
      for (let right = left + 1; right < owners.length; right++) {
        const first = owners[left];
        const second = owners[right];
        if (
          reachable(first.id, second.id, tasksById) ||
          reachable(second.id, first.id, tasksById)
        ) {
          continue;
        }
        errors.push(
          issue(
            "unordered_output_overlap",
            "error",
            [first.id, second.id],
            `Tasks ${first.id} and ${second.id} both own ${path} without a dependency ordering.`
          )
        );
      }
    }
  }

  const hasProjectVerifier = Boolean(options.verifyCommand?.trim());
  const hasPhaseVerification = Boolean(
    options.phaseVerification?.some((entry) => entry.trim())
  );
  for (const task of tasks) {
    const ownedPaths = explicitOwnedPaths(task);
    const ownsSource = task.kind === "modify" && ownedPaths.some(isStrictTddCodeOutputPath);
    if (options.strictTdd && ownsSource) {
      const ownsTest = ownedPaths.some(isLikelyTestOutputPath);
      const evidence = (task.requiredEvidence ?? []).join("\n");
      const hasRedEvidence = /\bRED\b/i.test(evidence);
      const hasGreenEvidence = /\bGREEN\b/i.test(evidence);
      const hasRunAction = (task.requiredToolActions ?? []).some(
        (action) => action.trim().toLowerCase() === "run"
      );
      if (!ownsTest || !hasRedEvidence || !hasGreenEvidence || !hasRunAction) {
        errors.push(
          issue(
            "missing_strict_tdd_contract",
            "error",
            [task.id],
            `Strict-TDD task ${task.id} must own a recognized test path, require RED and GREEN evidence, and declare the run tool action.`
          )
        );
      }
    }

    const requiredToolActions = task.requiredToolActions ?? [];
    const hasMalformedToolAction = requiredToolActions.some(
      (action) => !isTypedToolActionName(action)
    );
    if (
      hasMalformedToolAction ||
      (task.verificationPolicy === "tool" &&
        requiredToolActions.length === 0 &&
        !hasProjectVerifier &&
        !hasPhaseVerification)
    ) {
      errors.push(
        issue(
          "missing_tool_verification_contract",
          "error",
          [task.id],
          hasMalformedToolAction
            ? `Task ${task.id} declares a malformed required tool action; use typed action names such as run or server.tool.`
            : `Tool-policy task ${task.id} must declare required tool actions or be covered by project or phase verification.`
        )
      );
    }
  }

  const nonRepoTasks = tasks.filter((task) => task.kind !== "repo");
  for (const repoTask of tasks.filter((task) => task.kind === "repo")) {
    const unordered = nonRepoTasks.filter(
      (task) => !reachable(repoTask.id, task.id, tasksById)
    );
    if (unordered.length > 0) {
      warnings.push(
        issue(
          "repo_task_not_terminal",
          "warning",
          [repoTask.id, ...unordered.map((task) => task.id)],
          `Repo task ${repoTask.id} is not explicitly ordered after: ${unordered
            .map((task) => task.id)
            .join(", ")}. The scheduler terminal barrier will still hold it.`
        )
      );
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function renderBuildPlanContractErrors(
  validation: BuildPlanContractValidation
): string {
  return validation.errors
    .map((item) => `[${item.code}] ${item.message}`)
    .join("\n");
}

export function isBuildTaskRunnable(
  task: BuildTask,
  tasks: ReadonlyArray<BuildTask>
): boolean {
  const tasksById = new Map(tasks.map((item) => [taskIdKey(item.id), item]));
  const dependenciesDone = (task.dependsOn ?? []).every((dependency) => {
    const match = tasksById.get(taskIdKey(dependency));
    return match?.status === "done";
  });
  if (!dependenciesDone) return false;
  if (task.kind !== "repo") return true;
  return tasks.every((candidate) => candidate.kind === "repo" || candidate.status === "done");
}
