import type { BenchmarkTeamCompositionRole } from "@/lib/benchmark/types";
import type { TeamIqStrategy } from "@/lib/benchmark/types";
import type { SelectedModel } from "@/lib/providers/base";
import { deriveTeamComposition, inferProviderId } from "./compositions";

export interface CreateTeamIqCompositionSelectionInput {
  models: SelectedModel[];
  selectedModelIds: string[];
  strategy?: Exclude<TeamIqStrategy, "solo">;
}

export function createTeamIqCompositionFromSelection(
  input: CreateTeamIqCompositionSelectionInput
) {
  const strategy = input.strategy ?? "architect_worker_reviewer";
  const selectedModels = input.selectedModelIds
    .map((modelId) => input.models.find((model) => model.modelId === modelId))
    .filter((model): model is SelectedModel => Boolean(model))
    .slice(0, maxModelsForStrategy(strategy));
  if (selectedModels.length < 2) {
    throw new Error("TeamIQ requires at least two selected models.");
  }

  return deriveTeamComposition({
    name: selectedModels
      .map((model) => model.displayName || model.modelId)
      .join(" + "),
    strategy,
    roles: rolesForStrategy(strategy, selectedModels),
  });
}

function maxModelsForStrategy(strategy: Exclude<TeamIqStrategy, "solo">): number {
  return strategy === "panel" || strategy === "cheap_swarm_strong_judge" ? 4 : 3;
}

function rolesForStrategy(
  strategy: Exclude<TeamIqStrategy, "solo">,
  models: SelectedModel[]
): BenchmarkTeamCompositionRole[] {
  if (strategy === "panel") {
    return models.map((model, index) =>
      roleFor("specialist", `panel-${String(index + 1).padStart(2, "0")}`, model)
    );
  }
  if (strategy === "debate") {
    return [
      roleFor("critic", "01-debater", models[0]),
      roleFor("critic", "02-debater", models[1]),
      roleFor("judge", "03-debate-judge", models[2] ?? models[0]),
    ];
  }
  if (strategy === "architect_worker") {
    return [
      roleFor("architect", "01-architect", models[0]),
      roleFor("worker", "02-worker", models[1]),
    ];
  }
  if (strategy === "cheap_swarm_strong_judge") {
    const judge = models[models.length - 1];
    return [
      ...models.slice(0, -1).map((model, index) =>
        roleFor("worker", `${String(index + 1).padStart(2, "0")}-swarm-worker`, model)
      ),
      roleFor("judge", "99-strong-judge", judge),
    ];
  }
  return [
    roleFor("architect", "01-architect", models[0]),
    roleFor("worker", "02-worker", models[1]),
    roleFor("reviewer", "03-reviewer", models[2] ?? models[0]),
  ];
}

function roleFor(
  role: BenchmarkTeamCompositionRole["role"],
  slot: string,
  model: SelectedModel
): BenchmarkTeamCompositionRole {
  return {
    role,
    slot,
    modelId: model.modelId,
    providerId: model.providerId || inferProviderId(model.modelId),
    displayName: model.displayName || model.modelId,
    temperature: 0,
  };
}
