"use client";

import type { AvailableBenchmarkModel, ChessBenchmarkConfig } from "./types";
import { ModelAndReasoningField } from "./ModelAndReasoningField";
import { NumberField } from "./NumberField";

export function ChessBenchmarkConfigFields({
  config,
  models,
  running,
  updateConfig,
}: {
  config: ChessBenchmarkConfig;
  models: AvailableBenchmarkModel[];
  running: boolean;
  updateConfig: <K extends keyof ChessBenchmarkConfig>(
    key: K,
    value: ChessBenchmarkConfig[K]
  ) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <ModelAndReasoningField
          label="White"
          modelId={config.whiteModelId}
          reasoning={config.whiteReasoning}
          models={models}
          running={running}
          onModelChange={(value) => updateConfig("whiteModelId", value)}
          onReasoningChange={(value) => updateConfig("whiteReasoning", value)}
        />
        <ModelAndReasoningField
          label="Black"
          modelId={config.blackModelId}
          reasoning={config.blackReasoning}
          models={models}
          running={running}
          onModelChange={(value) => updateConfig("blackModelId", value)}
          onReasoningChange={(value) => updateConfig("blackReasoning", value)}
        />
      </div>
      <NumberField
        className="mt-4"
        label="Number of Games (1-10)"
        max={10}
        min={1}
        value={config.numGames}
        running={running}
        onChange={(value) => updateConfig("numGames", value)}
      />
    </>
  );
}
