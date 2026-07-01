import type { HarnessProfile } from "@/lib/benchmark/types";

export type WorkBenchRoleMode =
  | "solo"
  | "architect_worker"
  | "architect_worker_reviewer";

export interface WorkBenchSelectableModel {
  modelId: string;
}

export function workBenchRoleCount(roleMode: WorkBenchRoleMode): number {
  if (roleMode === "architect_worker_reviewer") return 3;
  if (roleMode === "architect_worker") return 2;
  return 1;
}

export function workBenchHarnessProfileForRoleMode(
  roleMode: WorkBenchRoleMode
): HarnessProfile {
  return roleMode === "solo"
    ? "aiboard-build-single-worker"
    : "aiboard-build-multi-worker";
}

export function normalizeWorkBenchModelSelection(input: {
  models: WorkBenchSelectableModel[];
  selectedModelIds: string[];
  roleMode: WorkBenchRoleMode;
}): string[] {
  const validModelIds = new Set(input.models.map((model) => model.modelId));
  const selected = input.selectedModelIds.filter((modelId) =>
    validModelIds.has(modelId)
  );
  const roleCount = workBenchRoleCount(input.roleMode);
  const normalized: string[] = [];

  for (let index = 0; index < roleCount; index++) {
    const explicit = selected[index];
    if (explicit) {
      normalized.push(explicit);
      continue;
    }
    const fallback = defaultModelIdForSlot({
      models: input.models,
      selectedModelIds: normalized,
      index,
    });
    if (fallback) normalized.push(fallback);
  }

  return normalized;
}

function defaultModelIdForSlot(input: {
  models: WorkBenchSelectableModel[];
  selectedModelIds: string[];
  index: number;
}): string {
  const preferred = input.models[input.index]?.modelId;
  if (preferred && !input.selectedModelIds.includes(preferred)) {
    return preferred;
  }
  return (
    input.models.find(
      (model) => !input.selectedModelIds.includes(model.modelId)
    )?.modelId ??
    preferred ??
    ""
  );
}
