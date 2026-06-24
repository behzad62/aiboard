"use client";

import type {
  AvailableBenchmarkModel,
  ConnectFourBenchmarkConfig,
} from "./types";
import { ModelAndReasoningField } from "./ModelAndReasoningField";
import { NumberField } from "./NumberField";

export function ConnectFourBenchmarkConfigFields({
  config,
  models,
  running,
  updateConfig,
}: {
  config: ConnectFourBenchmarkConfig;
  models: AvailableBenchmarkModel[];
  running: boolean;
  updateConfig: <K extends keyof ConnectFourBenchmarkConfig>(
    key: K,
    value: ConnectFourBenchmarkConfig[K]
  ) => void;
}) {
  return (
    <>
      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <ModelAndReasoningField
          label="Red"
          modelId={config.redModelId}
          reasoning={config.redReasoning}
          models={models}
          running={running}
          onModelChange={(value) => updateConfig("redModelId", value)}
          onReasoningChange={(value) => updateConfig("redReasoning", value)}
        />
        <ModelAndReasoningField
          label="Yellow"
          modelId={config.yellowModelId}
          reasoning={config.yellowReasoning}
          models={models}
          running={running}
          onModelChange={(value) => updateConfig("yellowModelId", value)}
          onReasoningChange={(value) => updateConfig("yellowReasoning", value)}
        />
      </div>
      <div className="mt-4 flex flex-wrap gap-4">
        <NumberField
          label="Max Moves (1-42)"
          max={42}
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
    </>
  );
}
