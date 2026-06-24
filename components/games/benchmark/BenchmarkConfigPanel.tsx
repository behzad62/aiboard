"use client";

import type {
  AvailableBenchmarkModel,
  ChessBenchmarkConfig,
  ConnectFourBenchmarkConfig,
} from "./types";
import { ChessBenchmarkConfigFields } from "./ChessBenchmarkConfigFields";
import { ConnectFourBenchmarkConfigFields } from "./ConnectFourBenchmarkConfigFields";

export function BenchmarkConfigPanel({
  canRunBenchmark,
  config,
  connectFourConfig,
  isConnectFourSelected,
  models,
  onAbortBenchmark,
  onRunBenchmark,
  running,
  updateConfig,
  updateConnectFourConfig,
}: {
  canRunBenchmark: boolean;
  config: ChessBenchmarkConfig;
  connectFourConfig: ConnectFourBenchmarkConfig;
  isConnectFourSelected: boolean;
  models: AvailableBenchmarkModel[];
  onAbortBenchmark: () => void;
  onRunBenchmark: () => void;
  running: boolean;
  updateConfig: <K extends keyof ChessBenchmarkConfig>(
    key: K,
    value: ChessBenchmarkConfig[K]
  ) => void;
  updateConnectFourConfig: <K extends keyof ConnectFourBenchmarkConfig>(
    key: K,
    value: ConnectFourBenchmarkConfig[K]
  ) => void;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-4 text-lg font-semibold">Benchmark Configuration</h3>
      {isConnectFourSelected ? (
        <ConnectFourBenchmarkConfigFields
          config={connectFourConfig}
          models={models}
          running={running}
          updateConfig={updateConnectFourConfig}
        />
      ) : (
        <ChessBenchmarkConfigFields
          config={config}
          models={models}
          running={running}
          updateConfig={updateConfig}
        />
      )}
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
