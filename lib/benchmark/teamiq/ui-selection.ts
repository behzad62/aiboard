import type { BenchmarkTeamCompositionRole } from "@/lib/benchmark/types";
import type { TeamIqStrategy } from "@/lib/benchmark/types";
import type { SelectedModel } from "@/lib/providers/base";
import { deriveTeamComposition, inferProviderId } from "./compositions";

export interface CreateTeamIqCompositionSelectionInput {
  models: SelectedModel[];
  selectedModelIds: string[];
  strategy?: Exclude<TeamIqStrategy, "solo">;
  roleMode?: "default" | "fireworks_players";
  playerCount?: 2 | 3;
  roleAssignments?: TeamIqRoleAssignment[];
}

export const TEAMIQ_TOOL_BENCH_STRATEGIES: Exclude<TeamIqStrategy, "solo">[] = [
  "panel",
  "debate",
  "architect_worker",
  "architect_worker_reviewer",
  "cheap_swarm_strong_judge",
];

export interface TeamIqRoleSlot {
  role: BenchmarkTeamCompositionRole["role"];
  slot: string;
  label: string;
}

export interface TeamIqRoleAssignment {
  role: BenchmarkTeamCompositionRole["role"];
  slot: string;
  modelId: string;
}

export function createTeamIqCompositionFromSelection(
  input: CreateTeamIqCompositionSelectionInput
) {
  const strategy = input.strategy ?? "architect_worker_reviewer";
  const selectedModels = selectedModelsForSelection(input, strategy);
  if (selectedModels.length < 1) {
    throw new Error("TeamIQ requires at least one selected model.");
  }
  if (
    input.roleMode === "fireworks_players" &&
    selectedModels.length !== (input.playerCount ?? 3)
  ) {
    throw new Error(
      `Fireworks ${input.playerCount ?? 3}-player runs require exactly ${input.playerCount ?? 3} selected models.`
    );
  }

  return deriveTeamComposition({
    name:
      input.roleMode === "fireworks_players"
        ? `Fireworks players: ${modelNameList(selectedModels)}`
        : teamNameForSelection(strategy, selectedModels),
    strategy: input.roleMode === "fireworks_players" ? "panel" : strategy,
    roles:
      input.roleAssignments && input.roleAssignments.length > 0
        ? rolesForAssignments(input.models, input.roleAssignments)
        : input.roleMode === "fireworks_players"
        ? rolesForFireworksPlayers(selectedModels, input.playerCount ?? 3)
        : rolesForStrategy(strategy, selectedModels),
  });
}

export function createTeamIqToolBenchCompositionsFromSelection(
  input: Omit<CreateTeamIqCompositionSelectionInput, "roleMode" | "playerCount">
) {
  return TEAMIQ_TOOL_BENCH_STRATEGIES.map((strategy) =>
    createTeamIqCompositionFromSelection({
      ...input,
      strategy,
      roleMode: "default",
    })
  );
}

export function teamIqRoleSlotsForStrategy(
  strategy: Exclude<TeamIqStrategy, "solo">,
  options: { roleMode?: "default" | "fireworks_players"; playerCount?: 2 | 3 } = {}
): TeamIqRoleSlot[] {
  if (options.roleMode === "fireworks_players") {
    const playerCount = options.playerCount ?? 3;
    return Array.from({ length: playerCount }, (_, index) => ({
      role: "player",
      slot: `P${index + 1}`,
      label: `P${index + 1}`,
    }));
  }
  if (strategy === "panel") {
    return [0, 1, 2].map((index) => ({
      role: "specialist",
      slot: `panel-${String(index + 1).padStart(2, "0")}`,
      label: `Specialist ${index + 1}`,
    }));
  }
  if (strategy === "debate") {
    return [
      { role: "critic", slot: "01-debater", label: "Critic 1" },
      { role: "critic", slot: "02-debater", label: "Critic 2" },
      { role: "judge", slot: "03-debate-judge", label: "Judge" },
    ];
  }
  if (strategy === "architect_worker") {
    return [
      { role: "architect", slot: "01-architect", label: "Architect" },
      { role: "worker", slot: "02-worker", label: "Worker" },
    ];
  }
  if (strategy === "cheap_swarm_strong_judge") {
    return [
      { role: "worker", slot: "01-swarm-worker", label: "Worker 1" },
      { role: "worker", slot: "02-swarm-worker", label: "Worker 2" },
      { role: "judge", slot: "99-strong-judge", label: "Judge" },
    ];
  }
  return [
    { role: "architect", slot: "01-architect", label: "Architect" },
    { role: "worker", slot: "02-worker", label: "Worker" },
    { role: "reviewer", slot: "03-reviewer", label: "Reviewer" },
  ];
}

export function normalizeTeamIqModelSelectionForSlots(input: {
  models: SelectedModel[];
  selectedModelIds: string[];
  slotCount: number;
}): string[] {
  const validIds = input.selectedModelIds.filter((modelId) =>
    input.models.some((model) => model.modelId === modelId)
  );
  return Array.from({ length: input.slotCount }, (_, index) => {
    const existing = input.selectedModelIds[index];
    if (existing && input.models.some((model) => model.modelId === existing)) {
      return existing;
    }
    if (index < input.selectedModelIds.length) {
      return input.models[index % input.models.length]?.modelId ?? "";
    }
    const recycled = validIds[index % Math.max(validIds.length, 1)];
    if (recycled) return recycled;
    return input.models[index % input.models.length]?.modelId ?? "";
  }).filter(Boolean);
}

function maxModelsForSelection(
  strategy: Exclude<TeamIqStrategy, "solo">,
  input: CreateTeamIqCompositionSelectionInput
): number {
  if (input.roleMode === "fireworks_players") return input.playerCount ?? 3;
  return maxModelsForStrategy(strategy);
}

function maxModelsForStrategy(strategy: Exclude<TeamIqStrategy, "solo">): number {
  return strategy === "architect_worker" ? 2 : 3;
}

function selectedModelsForSelection(
  input: CreateTeamIqCompositionSelectionInput,
  strategy: Exclude<TeamIqStrategy, "solo">
): SelectedModel[] {
  if (input.roleAssignments && input.roleAssignments.length > 0) {
    return input.roleAssignments
      .map((assignment) =>
        input.models.find((model) => model.modelId === assignment.modelId)
      )
      .filter((model): model is SelectedModel => Boolean(model));
  }
  return input.selectedModelIds
    .map((modelId) => input.models.find((model) => model.modelId === modelId))
    .filter((model): model is SelectedModel => Boolean(model))
    .slice(0, maxModelsForSelection(strategy, input));
}

function rolesForFireworksPlayers(
  models: SelectedModel[],
  playerCount: 2 | 3
): BenchmarkTeamCompositionRole[] {
  return models.slice(0, playerCount).map((model, index) =>
    roleFor("player", `P${index + 1}`, model)
  );
}

function rolesForStrategy(
  strategy: Exclude<TeamIqStrategy, "solo">,
  models: SelectedModel[]
): BenchmarkTeamCompositionRole[] {
  if (strategy === "panel") {
    return [0, 1, 2].map((index) =>
      roleFor(
        "specialist",
        `panel-${String(index + 1).padStart(2, "0")}`,
        modelForSlot(models, index)
      )
    );
  }
  if (strategy === "debate") {
    return [
      roleFor("critic", "01-debater", modelForSlot(models, 0)),
      roleFor("critic", "02-debater", modelForSlot(models, 1)),
      roleFor("judge", "03-debate-judge", modelForSlot(models, 2)),
    ];
  }
  if (strategy === "architect_worker") {
    return [
      roleFor("architect", "01-architect", modelForSlot(models, 0)),
      roleFor("worker", "02-worker", modelForSlot(models, 1)),
    ];
  }
  if (strategy === "cheap_swarm_strong_judge") {
    const judge = models[models.length - 1];
    const workers = models.length > 1 ? models.slice(0, -1) : models;
    return [
      roleFor("worker", "01-swarm-worker", modelForSlot(workers, 0)),
      roleFor("worker", "02-swarm-worker", modelForSlot(workers, 1)),
      roleFor("judge", "99-strong-judge", judge),
    ];
  }
  return [
    roleFor("architect", "01-architect", modelForSlot(models, 0)),
    roleFor("worker", "02-worker", modelForSlot(models, 1)),
    roleFor("reviewer", "03-reviewer", modelForSlot(models, 2)),
  ];
}

function rolesForAssignments(
  models: SelectedModel[],
  assignments: TeamIqRoleAssignment[]
): BenchmarkTeamCompositionRole[] {
  return assignments.map((assignment) => {
    const model = models.find((candidate) => candidate.modelId === assignment.modelId);
    if (!model) {
      throw new Error(`TeamIQ role ${assignment.slot} has no selected model.`);
    }
    return roleFor(assignment.role, assignment.slot, model);
  });
}

function modelForSlot(models: SelectedModel[], index: number): SelectedModel {
  const model = models[index % models.length];
  if (!model) throw new Error("TeamIQ requires at least one selected model.");
  return model;
}

function teamNameForSelection(
  strategy: Exclude<TeamIqStrategy, "solo">,
  models: SelectedModel[]
): string {
  return `${strategyLabel(strategy)}: ${modelNameList(models)}`;
}

function modelNameList(models: SelectedModel[]): string {
  return models.map((model) => model.displayName || model.modelId).join(" + ");
}

function strategyLabel(strategy: Exclude<TeamIqStrategy, "solo">): string {
  switch (strategy) {
    case "panel":
      return "Panel";
    case "debate":
      return "Debate";
    case "architect_worker":
      return "Architect + worker";
    case "architect_worker_reviewer":
      return "Architect + worker + reviewer";
    case "cheap_swarm_strong_judge":
      return "Cheap swarm + strong judge";
  }
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
