"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ensureReady } from "@/lib/client/api";
import {
  getAIvsAIAggregateStats,
  getAIvsAIModelStats,
  getRecentAIvsAIMatches,
} from "@/lib/games/stats";
import type { GameMatchRecord, GameModelStat } from "@/lib/games/chess/types";
import { getAvailableModels } from "@/lib/games/chess/ai";
import {
  getRunnableGameBenchmarkDefinition,
  listRunnableGameBenchmarkDefinitions,
} from "@/lib/games/core/benchmark-definitions";
import type {
  AvailableBenchmarkModel,
  GameBenchmarkConfigMap,
  SelectedBenchmarkGame,
  StandardGameBenchmarkConfig,
} from "./types";

const BENCHMARK_DEFINITIONS = listRunnableGameBenchmarkDefinitions();

function createDefaultConfigMap(): GameBenchmarkConfigMap {
  return Object.fromEntries(
    BENCHMARK_DEFINITIONS.map((definition) => [
      definition.gameId,
      {
        firstModelId: "",
        secondModelId: "",
        firstReasoning: "none",
        secondReasoning: "none",
        maxMoves: definition.defaultMaxMoves,
        numGames: 1,
      } satisfies StandardGameBenchmarkConfig,
    ])
  ) as GameBenchmarkConfigMap;
}

function applyModelDefaults(
  configs: GameBenchmarkConfigMap,
  available: AvailableBenchmarkModel[]
): GameBenchmarkConfigMap {
  if (available.length === 0) return configs;

  const firstModelId = available[0].modelId;
  const secondModelId = available[Math.min(1, available.length - 1)].modelId;
  const next = { ...configs };

  for (const definition of BENCHMARK_DEFINITIONS) {
    const current = configs[definition.gameId];
    next[definition.gameId] = {
      ...current,
      firstModelId: current.firstModelId || firstModelId,
      secondModelId: current.secondModelId || secondModelId,
    };
  }

  return next;
}

export function useGamesBenchmarkState() {
  const [models, setModels] = useState<AvailableBenchmarkModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedGame, setSelectedGame] =
    useState<SelectedBenchmarkGame>("chess");
  const [configs, setConfigs] = useState<GameBenchmarkConfigMap>(() =>
    createDefaultConfigMap()
  );
  const [modelStats, setModelStats] = useState<GameModelStat[]>([]);
  const [recentMatches, setRecentMatches] = useState<GameMatchRecord[]>([]);
  const [aggregateStats, setAggregateStats] = useState<{
    totalGames: number;
    avgMoves: number;
    avgDurationMs: number;
    whiteWins: number;
    blackWins: number;
    draws: number;
  } | null>(null);

  const selectedDefinition = useMemo(
    () =>
      getRunnableGameBenchmarkDefinition(selectedGame) ??
      BENCHMARK_DEFINITIONS[0],
    [selectedGame]
  );
  const selectedConfig = configs[selectedGame];

  const loadStats = useCallback(() => {
    setModelStats(getAIvsAIModelStats());
    setRecentMatches(getRecentAIvsAIMatches(10));
    setAggregateStats(getAIvsAIAggregateStats());
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadModels() {
      try {
        const { needsPassphrase } = await ensureReady();
        if (cancelled || needsPassphrase) return;

        const available = getAvailableModels();
        setModels(available);
        setConfigs((prev) => applyModelDefaults(prev, available));
        loadStats();
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to load models:", err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadModels();
    return () => {
      cancelled = true;
    };
  }, [loadStats]);

  const updateSelectedConfig = useCallback(
    <K extends keyof StandardGameBenchmarkConfig>(
      key: K,
      value: StandardGameBenchmarkConfig[K]
    ) => {
      setConfigs((prev) => ({
        ...prev,
        [selectedGame]: {
          ...prev[selectedGame],
          [key]: value,
        },
      }));
    },
    [selectedGame]
  );

  return {
    aggregateStats,
    benchmarkDefinitions: BENCHMARK_DEFINITIONS,
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
  };
}
