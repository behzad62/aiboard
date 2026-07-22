import type { BudgetLimits } from "./budget-ledger.js";
import type { PermissionProfile } from "./contracts.js";
import { assertBudgetLimits } from "./budget-policy.js";

export type NativeBuildRunPolicy = "finish" | "budgeted" | "plan_only";

export interface NativeBuildBenchmarkPolicy {
  attemptId: string;
  allowedCommands: string[];
  hiddenPaths: string[];
  protectedPaths: string[];
}

export interface NativeBuildSpec {
  version: 1;
  runId: string;
  projectId: string;
  objective: string;
  architectRuntimeId: string;
  workerRuntimeIds: string[];
  maxConcurrency: number;
  permissionProfile: PermissionProfile;
  runPolicy: NativeBuildRunPolicy;
  budgetLimits: BudgetLimits;
  createdAt: string;
  idempotencyKey: string;
  benchmark?: NativeBuildBenchmarkPolicy;
}

export interface BuildSpecStore {
  save(spec: NativeBuildSpec): NativeBuildSpec;
  get(runId: string): NativeBuildSpec;
  list(): NativeBuildSpec[];
  close(): void;
}

function validateBuildSpecCore(spec: NativeBuildSpec): void {
  if (spec.version !== 1) throw new Error("Unsupported Build spec version.");
  if (
    !spec.runId ||
    !spec.projectId ||
    !spec.objective.trim() ||
    !spec.architectRuntimeId ||
    !spec.idempotencyKey
  ) throw new Error("Build spec identity is incomplete.");
  if (Number.isNaN(Date.parse(spec.createdAt))) {
    throw new Error("Build spec createdAt must be an ISO timestamp.");
  }
  if (
    !Array.isArray(spec.workerRuntimeIds) ||
    spec.workerRuntimeIds.length < 1 ||
    spec.workerRuntimeIds.some((id) => !id)
  ) throw new Error("Build spec requires at least one worker runtime.");
  if (!Number.isSafeInteger(spec.maxConcurrency) || spec.maxConcurrency < 1) {
    throw new Error("Build spec maxConcurrency must be positive.");
  }
  if (!(["guarded", "project", "full"] as unknown[]).includes(spec.permissionProfile)) {
    throw new Error("Build spec permission profile is invalid.");
  }
  if (!(["finish", "budgeted", "plan_only"] as unknown[]).includes(spec.runPolicy)) {
    throw new Error("Build spec run policy is invalid.");
  }
  assertBudgetLimits(spec.budgetLimits);
  if (spec.benchmark) {
    if (!spec.benchmark.attemptId.trim()) {
      throw new Error("Build spec benchmark attempt identity is incomplete.");
    }
    if (
      !Array.isArray(spec.benchmark.allowedCommands) ||
      spec.benchmark.allowedCommands.some(
        (command) => typeof command !== "string" || !command.trim()
      )
    ) {
      throw new Error("Build spec benchmark commands must be non-empty strings.");
    }
    const normalized = spec.benchmark.allowedCommands.map((command) => command.trim());
    if (new Set(normalized).size !== normalized.length) {
      throw new Error("Build spec contains a duplicate benchmark command.");
    }
    for (const [label, paths] of [
      ["hidden", spec.benchmark.hiddenPaths],
      ["protected", spec.benchmark.protectedPaths],
    ] as const) {
      if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string" || !path.trim())) {
        throw new Error(`Build spec benchmark ${label} paths must be non-empty strings.`);
      }
      if (new Set(paths.map((path) => path.trim())).size !== paths.length) {
        throw new Error(`Build spec contains a duplicate benchmark ${label} path.`);
      }
    }
  }
}

export function assertBuildRunPolicyLimits(
  runPolicy: NativeBuildRunPolicy,
  budgetLimits: BudgetLimits
): void {
  if (runPolicy !== "budgeted") {
    if (Object.keys(budgetLimits).length > 0) {
      throw new Error(`${runPolicy} runs require empty budgetLimits.`);
    }
    return;
  }
  if (
    (budgetLimits.maxEstimatedCostMicros ?? 0) <= 0 &&
    (budgetLimits.maxActiveMs ?? 0) <= 0
  ) {
    throw new Error(
      "Budgeted runs require a positive maxEstimatedCostMicros or maxActiveMs limit."
    );
  }
}

export function validateBuildSpec(spec: NativeBuildSpec): void {
  validateBuildSpecCore(spec);
  assertBuildRunPolicyLimits(spec.runPolicy, spec.budgetLimits);
}

export function recoverLegacyBuildSpec(
  spec: Omit<NativeBuildSpec, "runPolicy">
): NativeBuildSpec {
  const recovered: NativeBuildSpec = {
    ...spec,
    runPolicy: "finish",
    budgetLimits: {},
  };
  validateBuildSpec(recovered);
  return recovered;
}

export function cloneBuildSpec(spec: NativeBuildSpec): NativeBuildSpec {
  return {
    ...spec,
    workerRuntimeIds: [...spec.workerRuntimeIds],
    budgetLimits: { ...spec.budgetLimits },
    ...(spec.benchmark
      ? {
          benchmark: {
            attemptId: spec.benchmark.attemptId,
            allowedCommands: [...spec.benchmark.allowedCommands],
            hiddenPaths: [...spec.benchmark.hiddenPaths],
            protectedPaths: [...spec.benchmark.protectedPaths],
          },
        }
      : {}),
  };
}
