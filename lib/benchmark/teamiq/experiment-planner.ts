import type {
  BenchmarkTeamComposition,
  BenchmarkTeamCompositionRole,
  TeamIqStrategy,
} from "@/lib/benchmark/types";
import type { SelectedModel } from "@/lib/providers/base";
import {
  deriveSoloTeamComposition,
  deriveTeamComposition,
  inferProviderId,
} from "./compositions";

export const TEAM_IQ_STRATEGIES: TeamIqStrategy[] = [
  "solo",
  "panel",
  "debate",
  "architect_worker",
  "architect_worker_reviewer",
  "cheap_swarm_strong_judge",
];

export interface PlanTeamIqExperimentInput {
  architectCandidates: SelectedModel[];
  workerCandidates: SelectedModel[];
  reviewerCandidates?: SelectedModel[];
  includeSoloBaselines: boolean;
  maxCombos?: number;
  strategies?: TeamIqStrategy[];
}

export function planTeamIqExperiment(input: PlanTeamIqExperimentInput) {
  const strategies: TeamIqStrategy[] =
    input.strategies && input.strategies.length > 0
      ? uniqueStrategies(input.strategies)
      : [
          input.reviewerCandidates?.length
            ? "architect_worker_reviewer"
            : "architect_worker",
        ];
  const allCandidates = uniqueModels([
    ...input.architectCandidates,
    ...input.workerCandidates,
    ...(input.reviewerCandidates ?? []),
  ]);
  const soloCompositions =
    input.includeSoloBaselines || strategies.includes("solo")
      ? allCandidates.map((candidate) =>
          deriveSoloTeamComposition({
            modelId: candidate.modelId,
            providerId: candidate.providerId,
            displayName: candidate.displayName,
            temperature: 0,
            strategy: "solo",
          })
        )
      : [];

  const teamCompositions: BenchmarkTeamComposition[] = [];
  const reviewers = input.reviewerCandidates?.length
    ? input.reviewerCandidates
    : [undefined];
  const pushTeam = (
    strategy: Exclude<TeamIqStrategy, "solo">,
    roles: BenchmarkTeamCompositionRole[],
    name: string
  ): boolean => {
    if (input.maxCombos !== undefined && teamCompositions.length >= input.maxCombos) {
      return false;
    }
    teamCompositions.push(deriveTeamComposition({ name, roles, strategy }));
    return true;
  };

  outer:
  for (const strategy of strategies) {
    if (strategy === "solo") continue;
    if (strategy === "panel") {
      const members = uniqueModels([
        ...input.architectCandidates.slice(0, 1),
        ...input.workerCandidates.slice(0, 2),
        ...(input.reviewerCandidates ?? []).slice(0, 1),
      ]).slice(0, 4);
      if (
        members.length >= 2 &&
        !pushTeam(
          strategy,
          members.map((member, index) =>
            roleFor(
              "specialist",
              `panel-${String(index + 1).padStart(2, "0")}`,
              member
            )
          ),
          strategyTeamName("Panel", members)
        )
      ) {
        break outer;
      }
      continue;
    }
    if (strategy === "cheap_swarm_strong_judge") {
      for (const judge of [
        ...(input.reviewerCandidates ?? []),
        ...input.architectCandidates,
      ]) {
        const workers = input.workerCandidates
          .filter((worker) => worker.modelId !== judge.modelId)
          .slice(0, 3);
        if (workers.length < 2) continue;
        if (
          !pushTeam(
            strategy,
            [
              ...workers.map((worker, index) =>
                roleFor(
                  "worker",
                  `${String(index + 1).padStart(2, "0")}-swarm-worker`,
                  worker
                )
              ),
              roleFor("judge", "99-strong-judge", judge),
            ],
            strategyTeamName("Cheap swarm + strong judge", [...workers, judge])
          )
        ) {
          break outer;
        }
      }
      continue;
    }

    for (const architect of input.architectCandidates) {
      for (const worker of input.workerCandidates) {
        for (const reviewer of reviewers) {
          if (strategy === "architect_worker_reviewer" && !reviewer) continue;
          const members = [architect, worker, reviewer].filter(
            (model): model is SelectedModel => Boolean(model)
          );
          const roles =
            strategy === "debate"
              ? [
                  roleFor("critic", "01-debater", architect),
                  roleFor("critic", "02-debater", worker),
                  roleFor("judge", "03-debate-judge", reviewer ?? architect),
                ]
              : [
                  roleFor("architect", "01-architect", architect),
                  roleFor("worker", "02-worker", worker),
                  ...(strategy === "architect_worker_reviewer" && reviewer
                    ? [roleFor("reviewer", "03-reviewer", reviewer)]
                    : []),
                ];
          if (!pushTeam(strategy, roles, strategyTeamName(strategyLabel(strategy), members))) {
            break outer;
          }
        }
      }
    }
  }

  return { soloCompositions, teamCompositions };
}

function uniqueModels(models: SelectedModel[]): SelectedModel[] {
  return [...new Map(models.map((model) => [model.modelId, model])).values()];
}

function uniqueStrategies(strategies: TeamIqStrategy[]): TeamIqStrategy[] {
  const supported = new Set(TEAM_IQ_STRATEGIES);
  return [...new Set(strategies.filter((strategy) => supported.has(strategy)))];
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

function strategyLabel(strategy: TeamIqStrategy): string {
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
    case "solo":
      return "Solo";
  }
}

function strategyTeamName(label: string, models: SelectedModel[]): string {
  return `${label}: ${models
    .map((model) => model.displayName || model.modelId)
    .filter(Boolean)
    .join(" + ")}`;
}
