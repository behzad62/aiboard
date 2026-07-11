import type { BudgetLimits } from "./budget-ledger.js";
import type { PermissionProfile } from "./contracts.js";
import { assertBudgetLimits } from "./budget-policy.js";

export interface NativeBuildSpec {
  version: 1;
  runId: string;
  projectId: string;
  objective: string;
  architectRuntimeId: string;
  workerRuntimeIds: string[];
  maxConcurrency: number;
  permissionProfile: PermissionProfile;
  budgetLimits: BudgetLimits;
  createdAt: string;
  idempotencyKey: string;
}

export interface BuildSpecStore {
  save(spec: NativeBuildSpec): NativeBuildSpec;
  get(runId: string): NativeBuildSpec;
  list(): NativeBuildSpec[];
  close(): void;
}

export function validateBuildSpec(spec: NativeBuildSpec): void {
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
  assertBudgetLimits(spec.budgetLimits);
}

export function cloneBuildSpec(spec: NativeBuildSpec): NativeBuildSpec {
  return {
    ...spec,
    workerRuntimeIds: [...spec.workerRuntimeIds],
    budgetLimits: { ...spec.budgetLimits },
  };
}
