"use client";

import type { SelectedModel } from "@/lib/providers/base";
import type { TeamIqStrategy } from "@/lib/benchmark/types";
import { TEAM_IQ_STRATEGIES } from "@/lib/benchmark/teamiq";

type TeamIqUiStrategy = Exclude<TeamIqStrategy, "solo">;

export function TeamCompositionBuilder({
  models,
  selectedModelIds,
  strategy,
  onChange,
  onStrategyChange,
}: {
  models: SelectedModel[];
  selectedModelIds: string[];
  strategy: TeamIqUiStrategy;
  onChange: (modelIds: string[]) => void;
  onStrategyChange: (strategy: TeamIqUiStrategy) => void;
}) {
  if (models.length === 0) {
    return (
      <div className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
        Add and enable at least two provider models in Settings to run TeamIQ.
      </div>
    );
  }
  const maxSelected = maxModelsForStrategy(strategy);

  return (
    <div className="space-y-2">
      <div className="grid gap-2 md:grid-cols-[220px_1fr]">
        <label className="space-y-1 text-sm">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Strategy
          </span>
          <select
            className="h-10 w-full rounded-md border bg-background px-3 text-sm"
            value={strategy}
            onChange={(event) => {
              const next = event.target.value as TeamIqUiStrategy;
              onStrategyChange(next);
              onChange(selectedModelIds.slice(0, maxModelsForStrategy(next)));
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
        <div className="text-xs text-muted-foreground md:self-end">
          Certified TeamIQ runs create solo baselines before scoring team lift.
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {models.slice(0, 8).map((model) => {
          const checked = selectedModelIds.includes(model.modelId);
          const disabled = !checked && selectedModelIds.length >= maxSelected;
          return (
            <label
              key={model.modelId}
              className={`flex min-h-16 cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                checked ? "border-primary bg-primary/5" : "bg-card"
              } ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
            >
              <input
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={checked}
                disabled={disabled}
                onChange={(event) => {
                  if (event.target.checked) {
                    onChange([...selectedModelIds, model.modelId].slice(0, maxSelected));
                  } else {
                    onChange(
                      selectedModelIds.filter((modelId) => modelId !== model.modelId)
                    );
                  }
                }}
              />
              <span className="min-w-0">
                <span className="block truncate font-medium">
                  {model.displayName || model.modelId}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {model.providerId}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Select two to {maxSelected} models. Roles follow the selected strategy
        in selection order.
      </p>
    </div>
  );
}

function maxModelsForStrategy(strategy: TeamIqUiStrategy): number {
  return strategy === "panel" || strategy === "cheap_swarm_strong_judge" ? 4 : 3;
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
