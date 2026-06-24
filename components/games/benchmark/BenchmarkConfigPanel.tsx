"use client";

import type { RunnableGameBenchmarkDefinition } from "@/lib/games/core/benchmark-definitions";
import type {
  AvailableBenchmarkModel,
  StandardGameBenchmarkConfig,
} from "./types";
import { ModelAndReasoningField } from "./ModelAndReasoningField";
import { NumberField } from "./NumberField";

export function BenchmarkConfigPanel({
  canRunBenchmark,
  config,
  definition,
  models,
  onAbortBenchmark,
  onRunBenchmark,
  running,
  updateConfig,
}: {
  canRunBenchmark: boolean;
  config: StandardGameBenchmarkConfig;
  definition: RunnableGameBenchmarkDefinition;
  models: AvailableBenchmarkModel[];
  onAbortBenchmark: () => void;
  onRunBenchmark: () => void;
  running: boolean;
  updateConfig: <K extends keyof StandardGameBenchmarkConfig>(
    key: K,
    value: StandardGameBenchmarkConfig[K]
  ) => void;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-4 text-lg font-semibold">Benchmark Configuration</h3>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <ModelAndReasoningField
          label={definition.firstPlayerLabel}
          modelId={config.firstModelId}
          reasoning={config.firstReasoning}
          models={models}
          running={running}
          onModelChange={(value) => updateConfig("firstModelId", value)}
          onReasoningChange={(value) => updateConfig("firstReasoning", value)}
        />
        <ModelAndReasoningField
          label={definition.secondPlayerLabel}
          modelId={config.secondModelId}
          reasoning={config.secondReasoning}
          models={models}
          running={running}
          onModelChange={(value) => updateConfig("secondModelId", value)}
          onReasoningChange={(value) => updateConfig("secondReasoning", value)}
        />
      </div>
      <div className="mt-4 flex flex-wrap gap-4">
        <NumberField
          label={`${definition.maxMovesLabel} (1-${definition.maxMovesMax})`}
          max={definition.maxMovesMax}
          min={1}
          value={config.maxMoves}
          running={running}
          onChange={(value) => updateConfig("maxMoves", value)}
        />
        <NumberField
          label="Number of Games (1-10)"
          max={10}
          min={1}
          value={config.numGames}
          running={running}
          onChange={(value) => updateConfig("numGames", value)}
        />
      </div>
      <div className="mt-4 flex gap-3">
        {!running ? (
          <button
            type="button"
            onClick={onRunBenchmark}
            disabled={!canRunBenchmark}
            className="rounded-md bg-primary px-4 py-2 text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            Run Benchmark
          </button>
        ) : (
          <button
            type="button"
            onClick={onAbortBenchmark}
            className="rounded-md bg-destructive px-4 py-2 text-destructive-foreground hover:bg-destructive/90"
          >
            Stop Benchmark
          </button>
        )}
      </div>
    </div>
  );
}
