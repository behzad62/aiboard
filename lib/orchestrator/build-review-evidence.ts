import type { BuildTask, ReviewResult } from "./build";

export interface BuildTaskVerificationFact {
  taskId: string;
  wave: number;
  at: string;
  action: string;
  status: "passed" | "failed" | "skipped";
  summary: string;
  coveredPaths: string[];
}

export interface BuildReviewContractIssue {
  code:
    | "missing_task_verification"
    | "stale_task_verification"
    | "failed_task_verification";
  taskId: string;
  message: string;
}

export function appendBuildTaskVerificationFact(
  facts: ReadonlyArray<BuildTaskVerificationFact>,
  fact: BuildTaskVerificationFact,
  maxFacts = 96
): BuildTaskVerificationFact[] {
  return [...facts, {
    ...fact,
    taskId: fact.taskId.trim().slice(0, 80),
    action: fact.action.trim().slice(0, 160),
    summary: fact.summary.replace(/\s+/g, " ").trim().slice(0, 1_200),
    coveredPaths: [...new Set(fact.coveredPaths.map((path) => path.trim()).filter(Boolean))]
      .slice(0, 64),
  }].slice(-Math.max(1, maxFacts));
}

export function discardSupersededTaskVerificationFacts(
  facts: ReadonlyArray<BuildTaskVerificationFact>,
  taskId: string,
  writeWave: number
): BuildTaskVerificationFact[] {
  return facts.filter(
    (fact) => fact.taskId !== taskId || fact.wave >= writeWave
  );
}

function requiredVerificationActions(
  task: BuildTask,
  facts: ReadonlyArray<BuildTaskVerificationFact>,
  wave: number
): string[] {
  if (task.verificationPolicy !== "tool") return [];
  const declared = (task.requiredToolActions ?? [])
    .map((action) => action.trim())
    .filter(Boolean);
  const projectVerifierCoveredTask = facts.some(
    (fact) =>
      fact.taskId === task.id && fact.wave === wave && fact.action === "run"
  );
  return [
    ...new Set(
      projectVerifierCoveredTask ? [...declared, "run"] : declared
    ),
  ];
}

export function validateBuildReviewApprovals(input: {
  tasks: ReadonlyArray<BuildTask>;
  results: ReadonlyArray<ReviewResult>;
  facts: ReadonlyArray<BuildTaskVerificationFact>;
  wave: number;
}): { valid: boolean; errors: BuildReviewContractIssue[] } {
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  const errors: BuildReviewContractIssue[] = [];

  for (const result of input.results) {
    if (result.specVerdict !== "approve" || result.qualityVerdict !== "approve") {
      continue;
    }
    const task = tasksById.get(result.taskId);
    if (!task) continue;

    for (const action of requiredVerificationActions(task, input.facts, input.wave)) {
      const matching = input.facts.filter(
        (fact) => fact.taskId === task.id && fact.action === action
      );
      const current = matching
        .filter((fact) => fact.wave === input.wave)
        .sort((left, right) => left.at.localeCompare(right.at));
      if (current.length === 0) {
        const stale = matching.some((fact) => fact.wave !== input.wave);
        errors.push({
          code: stale ? "stale_task_verification" : "missing_task_verification",
          taskId: task.id,
          message: stale
            ? `Task ${task.id} approval requires current-wave ${action} evidence; only stale evidence is recorded.`
            : `Task ${task.id} approval requires current-wave ${action} evidence, but none is recorded.`,
        });
        continue;
      }
      const latestPassingIndex = current.findLastIndex(
        (fact) => fact.status === "passed"
      );
      const laterFailure = current.find(
        (fact, index) =>
          fact.status === "failed" && index > latestPassingIndex
      );
      if (laterFailure) {
        errors.push({
          code: "failed_task_verification",
          taskId: task.id,
          message: `Task ${task.id} approval contradicts current-wave ${action} evidence: failed — ${laterFailure.summary}`,
        });
      } else if (latestPassingIndex < 0) {
        errors.push({
          code: "missing_task_verification",
          taskId: task.id,
          message: `Task ${task.id} approval requires a successful current-wave ${action} fact; the action was skipped.`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export async function resolveBuildReviewContract<T>(input: {
  initialAction: T;
  validate: (action: T) => { valid: boolean; errors: BuildReviewContractIssue[] };
  revise: (
    action: T,
    errors: BuildReviewContractIssue[],
    revision: number
  ) => Promise<T | null>;
  maxRevisions?: number;
}): Promise<
  | { status: "valid"; action: T; revisions: number }
  | {
      status: "blocked";
      action: T;
      revisions: number;
      errors: BuildReviewContractIssue[];
    }
> {
  const maxRevisions = Math.max(0, input.maxRevisions ?? 2);
  let action = input.initialAction;
  let validation = input.validate(action);
  let revisions = 0;

  while (!validation.valid && revisions < maxRevisions) {
    revisions += 1;
    const revised = await input.revise(action, validation.errors, revisions);
    if (revised === null) break;
    action = revised;
    validation = input.validate(action);
  }

  return validation.valid
    ? { status: "valid", action, revisions }
    : { status: "blocked", action, revisions, errors: validation.errors };
}
