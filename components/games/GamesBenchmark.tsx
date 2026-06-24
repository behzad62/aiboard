"use client";

import { BenchmarkConfigPanel } from "./benchmark/BenchmarkConfigPanel";
import { BenchmarkHeader } from "./benchmark/BenchmarkHeader";
import { BenchmarkProgress } from "./benchmark/BenchmarkProgress";
import { ChessBenchmarkStats } from "./benchmark/ChessBenchmarkStats";
import { GameBenchmarkResult } from "./benchmark/GameBenchmarkResult";
import { useGamesBenchmarkRunner } from "./benchmark/useGamesBenchmarkRunner";
import { useGamesBenchmarkState } from "./benchmark/useGamesBenchmarkState";

export function GamesBenchmark() {
  const {
    aggregateStats,
    benchmarkDefinitions,
    loading,
    loadStats,
    models,
    modelStats,
    recentMatches,
    selectedConfig,
    selectedDefinition,
    selectedGame,
    setSelectedGame,
    updateSelectedConfig,
  } = useGamesBenchmarkState();

  const {
    abortBenchmark,
    chessProgress,
    gameProgress,
    gameSummary,
    runBenchmark,
    running,
  } = useGamesBenchmarkRunner({
    config: selectedConfig,
    loadStats,
    selectedGame,
  });

  const canRunBenchmark = Boolean(
    selectedConfig.firstModelId && selectedConfig.secondModelId
  );

  if (loading) {
    return (
      <div className="p-6">
        <div className="text-muted-foreground">Loading available models...</div>
      </div>
    );
  }

  if (models.length === 0) {
    return (
      <div className="space-y-6">
        <BenchmarkHeader
          benchmarkDefinitions={benchmarkDefinitions}
          benchmarkDescription={selectedDefinition.description}
          benchmarkTitle={selectedDefinition.title}
          running={running}
          selectedGame={selectedGame}
          setSelectedGame={setSelectedGame}
        />
        <div className="rounded-lg border bg-card p-8 text-center">
          <div className="mb-2 text-lg font-medium">No AI Models Available</div>
          <div className="text-sm text-muted-foreground">
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
        benchmarkDefinitions={benchmarkDefinitions}
        benchmarkDescription={selectedDefinition.description}
        benchmarkTitle={selectedDefinition.title}
        running={running}
        selectedGame={selectedGame}
        setSelectedGame={setSelectedGame}
      />

      <BenchmarkConfigPanel
        canRunBenchmark={canRunBenchmark}
        config={selectedConfig}
        definition={selectedDefinition}
        models={models}
        onAbortBenchmark={abortBenchmark}
        onRunBenchmark={runBenchmark}
        running={running}
        updateConfig={updateSelectedConfig}
      />

      <BenchmarkProgress
        chessProgress={chessProgress}
        definition={selectedDefinition}
        gameProgress={gameProgress}
        running={running}
        selectedGame={selectedGame}
      />

      {selectedGame === "chess" ? (
        <ChessBenchmarkStats
          aggregateStats={aggregateStats}
          modelStats={modelStats}
          recentMatches={recentMatches}
          running={running}
        />
      ) : (
        <GameBenchmarkResult
          definition={selectedDefinition}
          running={running}
          summary={gameSummary}
        />
      )}
    </div>
  );
}
