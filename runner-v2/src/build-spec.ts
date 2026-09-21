import type { BudgetLimits } from "./budget-ledger.js";
import type { PermissionProfile } from "./contracts.js";
import { assertBudgetLimits } from "./budget-policy.js";
import {
  assertRunnerCapabilityContract,
  cloneRunnerCapabilityContract,
  type RunnerCapabilityContract,
} from "./runner-capability-contract.js";
import {
  PLAN_CRITIQUE_MODES,
  type PlanCritiqueMode,
} from "./plan-critique-contracts.js";

export type NativeBuildRunPolicy = "finish" | "budgeted" | "plan_only";

export interface NativeBuildBenchmarkPolicy {
  attemptId: string;
  allowedCommands: string[];
  hiddenPaths: string[];
  protectedPaths: string[];
}

export interface NativeBuildSpec {
  version: 2;
  runId: string;
  projectId: string;
  objective: string;
  architectRuntimeId: string;
  workerRuntimeIds: string[];
  verifierRuntimeIds: string[];
  /** Strengthens low-risk qualification; it never disables the high-risk gate. */
  alwaysRequireIndependentVerifier: boolean;
  /** Kernel-counted repair plans per run; omitted means the runtime default. */
  repairPlanLimit?: number;
  maxConcurrency: number;
  permissionProfile: PermissionProfile;
  runPolicy: NativeBuildRunPolicy;
  /** Digest-only manifests by default; "full" also stores rendered pack text. */
  contextRecording?: "manifest" | "full";
  /** Plan-critique policy; omitted means the runtime default of risk_based. */
  planCritique?: PlanCritiqueMode;
  budgetLimits: BudgetLimits;
  createdAt: string;
  idempotencyKey: string;
  /** Durable identity of executable extension and language-provider capabilities. */
  capabilityContract?: RunnerCapabilityContract;
  benchmark?: NativeBuildBenchmarkPolicy;
}

export type LegacyNativeBuildSpec = Omit<
  NativeBuildSpec,
  "version" | "runPolicy" | "verifierRuntimeIds" | "alwaysRequireIndependentVerifier"
> & {
  version: 1;
} & Partial<Pick<
  NativeBuildSpec,
  "runPolicy" | "verifierRuntimeIds" | "alwaysRequireIndependentVerifier"
>>;

export interface BuildSpecStore {
  save(spec: NativeBuildSpec): NativeBuildSpec;
  get(runId: string): NativeBuildSpec;
  list(): NativeBuildSpec[];
  close(): void;
}

function validateBuildSpecCore(spec: NativeBuildSpec): void {
  if (spec.version !== 2) throw new Error("Unsupported Build spec version.");
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
  if (
    !Array.isArray(spec.verifierRuntimeIds) ||
    spec.verifierRuntimeIds.length < 1
  ) {
    throw new Error("Build spec requires at least one verifier runtime.");
  }
  if (
    spec.verifierRuntimeIds.some(
      (id) => typeof id !== "string" || !id.trim() || id !== id.trim()
    )
  ) {
    throw new Error("Build spec verifier runtime IDs must be non-empty normalized strings.");
  }
  if (new Set(spec.verifierRuntimeIds).size !== spec.verifierRuntimeIds.length) {
    throw new Error("Build spec contains a duplicate verifier runtime.");
  }
  if (typeof spec.alwaysRequireIndependentVerifier !== "boolean") {
    throw new Error(
      "Build spec independent verifier qualification must be a boolean."
    );
  }
  if (
    spec.repairPlanLimit !== undefined &&
    (!Number.isSafeInteger(spec.repairPlanLimit) || spec.repairPlanLimit < 0)
  ) {
    throw new Error("Build spec repairPlanLimit must be a non-negative integer.");
  }
  if (!Number.isSafeInteger(spec.maxConcurrency) || spec.maxConcurrency < 1) {
    throw new Error("Build spec maxConcurrency must be positive.");
  }
  if (!(["guarded", "project", "full"] as unknown[]).includes(spec.permissionProfile)) {
    throw new Error("Build spec permission profile is invalid.");
  }
  if (!(["finish", "budgeted", "plan_only"] as unknown[]).includes(spec.runPolicy)) {
    throw new Error("Build spec run policy is invalid.");
  }
  if (
    spec.contextRecording !== undefined &&
    spec.contextRecording !== "manifest" &&
    spec.contextRecording !== "full"
  ) {
    throw new Error("Build spec contextRecording must be manifest or full.");
  }
  if (
    spec.planCritique !== undefined &&
    !(PLAN_CRITIQUE_MODES as readonly string[]).includes(spec.planCritique)
  ) {
    throw new Error("Build spec planCritique must be risk_based, always, or off.");
  }
  assertBudgetLimits(spec.budgetLimits);
  if (spec.capabilityContract !== undefined) {
    assertRunnerCapabilityContract(spec.capabilityContract);
  }
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
  spec: LegacyNativeBuildSpec
): NativeBuildSpec {
  if (spec.version !== 1) {
    throw new Error("Unsupported legacy Build spec version.");
  }
  const legacyRunPolicy = spec.runPolicy === undefined;
  const recovered: NativeBuildSpec = {
    ...spec,
    version: 2,
    runPolicy: spec.runPolicy ?? "finish",
    budgetLimits: legacyRunPolicy ? {} : { ...spec.budgetLimits },
    verifierRuntimeIds:
      spec.verifierRuntimeIds === undefined
        ? [...new Set(spec.workerRuntimeIds)]
        : [...spec.verifierRuntimeIds],
    alwaysRequireIndependentVerifier:
      spec.alwaysRequireIndependentVerifier ?? false,
  };
  validateBuildSpec(recovered);
  return recovered;
}

export function cloneBuildSpec(spec: NativeBuildSpec): NativeBuildSpec {
  return {
    ...spec,
    workerRuntimeIds: [...spec.workerRuntimeIds],
    verifierRuntimeIds: [...spec.verifierRuntimeIds],
    budgetLimits: { ...spec.budgetLimits },
    ...(spec.capabilityContract
      ? { capabilityContract: cloneRunnerCapabilityContract(spec.capabilityContract) }
      : {}),
    ...(spec.repairPlanLimit !== undefined ? { repairPlanLimit: spec.repairPlanLimit } : {}),
    ...(spec.contextRecording !== undefined ? { contextRecording: spec.contextRecording } : {}),
    ...(spec.planCritique !== undefined ? { planCritique: spec.planCritique } : {}),
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
