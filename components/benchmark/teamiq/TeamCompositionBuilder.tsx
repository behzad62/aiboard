"use client";

import type { SelectedModel } from "@/lib/providers/base";
import type { TeamIqStrategy } from "@/lib/benchmark/types";
import {
  TEAM_IQ_STRATEGIES,
  normalizeTeamIqModelSelectionForSlots,
  teamIqRoleSlotsForStrategy,
} from "@/lib/benchmark/teamiq";

type TeamIqUiStrategy = Exclude<TeamIqStrategy, "solo">;
type TeamIqRoleMode = "default" | "fireworks_players";

export function TeamCompositionBuilder({
  models,
  selectedModelIds,
  strategy,
  roleMode = "default",
  playerCount = 3,
  allModes = false,
  onChange,
  onStrategyChange,
}: {
  models: SelectedModel[];
  selectedModelIds: string[];
  strategy: TeamIqUiStrategy;
  roleMode?: TeamIqRoleMode;
  playerCount?: 2 | 3;
  allModes?: boolean;
  onChange: (modelIds: string[]) => void;
  onStrategyChange: (strategy: TeamIqUiStrategy) => void;
}) {
  if (models.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
        Add and enable at least one provider model in Settings to run TeamIQ.
      </div>
    );
  }
  const roleSlots =
    roleMode === "fireworks_players"
      ? teamIqRoleSlotsForStrategy(strategy, { roleMode, playerCount })
      : allModes
        ? allModePoolSlots()
        : teamIqRoleSlotsForStrategy(strategy);
  const normalizedSelection = normalizeTeamIqModelSelectionForSlots({
    models,
    selectedModelIds,
    slotCount: roleSlots.length,
  });

  return (
    <div className="space-y-2">
      <div className="grid gap-2 md:grid-cols-[220px_1fr]">
        {roleMode === "fireworks_players" || allModes ? (
          <StaticStrategyLabel
            label={roleMode === "fireworks_players" ? "Fireworks players" : "All modes"}
          />
        ) : (
          <label className="space-y-1 text-sm">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Strategy
            </span>
            <select
              className="h-10 w-full rounded-md border bg-background px-3 text-sm"
              value={strategy}
              onChange={(event) => {
                const next = event.target.value as TeamIqUiStrategy;
                const nextSlotCount = teamIqRoleSlotsForStrategy(next).length;
                onStrategyChange(next);
                onChange(
                  normalizeTeamIqModelSelectionForSlots({
                    models,
                    selectedModelIds,
                    slotCount: nextSlotCount,
                  })
                );
              }}
            >
              {TEAM_IQ_STRATEGIES.filter(
                (item): item is TeamIqUiStrategy => item !== "solo"
              ).map((item) => (
                <option key={item} value={item}>
                  {strategyLabel(item)}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="text-xs text-muted-foreground md:self-end">
          Certified TeamIQ runs create solo baselines before scoring team lift.
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {roleSlots.map((slot, index) => {
          return (
            <label
              key={slot.slot}
              className="grid min-h-20 gap-1 rounded-md border bg-card px-3 py-2 text-sm"
            >
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {slot.label}
              </span>
              <select
                className="h-10 w-full min-w-0 rounded-md border bg-background px-3 text-sm"
                value={normalizedSelection[index] ?? models[0]!.modelId}
                onChange={(event) => {
                  const next = [...normalizedSelection];
                  next[index] = event.target.value;
                  onChange(next);
                }}
              >
                {models.map((model) => (
                  <option key={model.modelId} value={model.modelId}>
                    {model.displayName || model.modelId}
                  </option>
                ))}
              </select>
              <span className="truncate text-xs text-muted-foreground">
                {providerForModel(models, normalizedSelection[index])}
              </span>
            </label>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Each slot is recorded as part of the certified team composition.
      </p>
    </div>
  );
}

function providerForModel(models: SelectedModel[], modelId: string | undefined): string {
  return models.find((model) => model.modelId === modelId)?.providerId ?? "";
}

function allModePoolSlots() {
  return [
    { role: "specialist" as const, slot: "01-model", label: "Model 1" },
    { role: "specialist" as const, slot: "02-model", label: "Model 2" },
    { role: "specialist" as const, slot: "03-model", label: "Model 3" },
  ];
}

function StaticStrategyLabel({ label }: { label: string }) {
  return (
    <div className="space-y-1 text-sm">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Strategy
      </span>
      <div className="flex h-10 items-center rounded-md border bg-muted/40 px-3">
        {label}
      </div>
    </div>
  );
}

function strategyLabel(strategy: TeamIqUiStrategy): string {
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
