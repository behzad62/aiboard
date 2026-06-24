"use client";

import { BenchmarkConfigPanel } from "./benchmark/BenchmarkConfigPanel";
import { BenchmarkHeader } from "./benchmark/BenchmarkHeader";
import { BenchmarkProgress } from "./benchmark/BenchmarkProgress";
import { ChessBenchmarkStats } from "./benchmark/ChessBenchmarkStats";
import { ConnectFourBenchmarkResult } from "./benchmark/ConnectFourBenchmarkResult";
import { useGamesBenchmarkRunner } from "./benchmark/useGamesBenchmarkRunner";
import { useGamesBenchmarkState } from "./benchmark/useGamesBenchmarkState";

export function GamesBenchmark() {
  const {
    aggregateStats,
    config,
    connectFourConfig,
    loading,
    loadStats,
    models,
    modelStats,
    recentMatches,
    selectedGame,
    setSelectedGame,
    updateConfig,
    updateConnectFourConfig,
  } = useGamesBenchmarkState();

  const {
    abortBenchmark,
    connectFourProgress,
    connectFourSummary,
    progress,
    runBenchmark,
    running,
  } = useGamesBenchmarkRunner({
    config,
    connectFourConfig,
    loadStats,
    selectedGame,
  });

  const isConnectFourSelected = selectedGame === "connect-four";
  const benchmarkTitle = isConnectFourSelected
    ? "AI vs AI Connect Four Benchmark"
    : "AI vs AI Chess Benchmark";
  const benchmarkDescription = isConnectFourSelected
    ? "Run head-to-head Connect Four matches between configured AI models and track move quality, fallback use, and invalid responses."
    : "Run head-to-head chess matches between configured AI models and compare win rate, move speed, and reliability.";
  const canRunBenchmark = isConnectFourSelected
    ? Boolean(connectFourConfig.redModelId && connectFourConfig.yellowModelId)
    : Boolean(config.whiteModelId && config.blackModelId);

  if (loading) {
    return (
      <div className="p-6">
        <div className="text-muted-foreground">Loading available models...</div>
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="space-y-4 rounded-lg border bg-card p-6">
        <div>
          <h2 className="text-xl font-semibold">{benchmarkTitle}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {benchmarkDescription}
          </p>
        </div>
        <div className="text-center py-8">
          <div className="text-lg font-medium mb-2">No AI Models Available</div>
          <div className="text-muted-foreground text-sm">
            Configure API keys in Settings to enable AI models for
            benchmarking.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <BenchmarkHeader
        benchmarkDescription={benchmarkDescription}
        benchmarkTitle={benchmarkTitle}
        running={running}
        selectedGame={selectedGame}
        setSelectedGame={setSelectedGame}
      />

      <BenchmarkConfigPanel
        canRunBenchmark={canRunBenchmark}
        config={config}
        connectFourConfig={connectFourConfig}
        isConnectFourSelected={isConnectFourSelected}
        models={models}
        onAbortBenchmark={abortBenchmark}
        onRunBenchmark={runBenchmark}
        running={running}
        updateConfig={updateConfig}
        updateConnectFourConfig={updateConnectFourConfig}
      />

      <BenchmarkProgress
        connectFourProgress={connectFourProgress}
        isConnectFourSelected={isConnectFourSelected}
        progress={progress}
        running={running}
      />

      {!isConnectFourSelected ? (
        <ChessBenchmarkStats
          aggregateStats={aggregateStats}
          modelStats={modelStats}
          recentMatches={recentMatches}
          running={running}
        />
      ) : (
        <ConnectFourBenchmarkResult
          connectFourSummary={connectFourSummary}
          running={running}
        />
      )}
    </div>
  );
}
