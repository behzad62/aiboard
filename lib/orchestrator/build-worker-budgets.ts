export interface BuildWorkerBudget {
  reads: number;
  rangeReads: number;
  searches: number;
  runs: number;
  patches: number;
  appends: number;
  toolTurns: number;
  badToolCalls: number;
}

export type BuildWorkerToolInstructionBudget = Pick<
  BuildWorkerBudget,
  "reads" | "rangeReads" | "searches" | "runs" | "patches" | "appends"
>;

export interface BuildWorkerBudgetInput {
  difficulty?: number | null;
  activeSkillIds?: readonly string[];
  runsLeft: number;
  /** Prior failed attempts on this task — fix rounds escalate one tier per
   * failure (capped) so a retry is never starved into the same failure. */
  failCount?: number | null;
}

const BASE_WORKER_BUDGET: BuildWorkerBudget = {
  reads: 4,
  rangeReads: 8,
  searches: 4,
  runs: 2,
  patches: 8,
  appends: 12,
  toolTurns: 24,
  badToolCalls: 3,
};

const HARD_WORKER_BUDGET: BuildWorkerBudget = {
  reads: 6,
  rangeReads: 12,
  searches: 6,
  runs: 4,
  patches: 10,
  appends: 14,
  toolTurns: 32,
  badToolCalls: 3,
};

const HARDEST_WORKER_BUDGET: BuildWorkerBudget = {
  reads: 8,
  rangeReads: 16,
  searches: 8,
  runs: 6,
  patches: 12,
  appends: 16,
  toolTurns: 40,
  badToolCalls: 3,
};

const TDD_SKILL_IDS = new Set([
  "agent:test-driven-development",
  "superpowers:strict-test-driven-development",
]);

function normalizeTaskDifficulty(difficulty: number | null | undefined): number {
  return Math.max(1, Math.min(5, Math.round(difficulty ?? 3)));
}

function escalatedDifficulty(
  difficulty: number | null | undefined,
  failCount: number | null | undefined
): number {
  const failures = Math.max(0, Math.min(2, Math.floor(failCount ?? 0)));
  return Math.min(5, normalizeTaskDifficulty(difficulty) + failures);
}

function baseBudgetForDifficulty(difficulty: number): BuildWorkerBudget {
  if (difficulty >= 5) return HARDEST_WORKER_BUDGET;
  if (difficulty >= 4) return HARD_WORKER_BUDGET;
  return BASE_WORKER_BUDGET;
}

function finiteRunBudget(runsLeft: number): number {
  return Number.isFinite(runsLeft) ? Math.max(0, Math.floor(runsLeft)) : 0;
}

function hasTddSkill(activeSkillIds: readonly string[]): boolean {
  return activeSkillIds.some((id) => TDD_SKILL_IDS.has(id));
}

export function createBuildWorkerBudget(input: BuildWorkerBudgetInput): BuildWorkerBudget {
  const baseBudget = baseBudgetForDifficulty(
    escalatedDifficulty(input.difficulty, input.failCount)
  );
  const uncappedRuns = hasTddSkill(input.activeSkillIds ?? [])
    ? Math.max(baseBudget.runs, 3)
    : baseBudget.runs;

  return {
    ...baseBudget,
    runs: Math.min(uncappedRuns, finiteRunBudget(input.runsLeft)),
  };
}

export function workerBudgetToolInstructionInput(
  budget: BuildWorkerBudget
): BuildWorkerToolInstructionBudget {
  return {
    reads: budget.reads,
    rangeReads: budget.rangeReads,
    searches: budget.searches,
    runs: budget.runs,
    patches: budget.patches,
    appends: budget.appends,
  };
}
