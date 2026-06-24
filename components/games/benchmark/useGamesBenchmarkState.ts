"use client";

import { useCallback, useEffect, useState } from "react";
import { ensureReady } from "@/lib/client/api";
import {
  getAIvsAIAggregateStats,
  getAIvsAIModelStats,
  getRecentAIvsAIMatches,
} from "@/lib/games/stats";
import type { GameMatchRecord, GameModelStat } from "@/lib/games/chess/types";
import { getAvailableModels } from "@/lib/games/chess/ai";
import type {
  AvailableBenchmarkModel,
  ChessBenchmarkConfig,
  ConnectFourBenchmarkConfig,
  SelectedBenchmarkGame,
} from "./types";
import { CONNECT_FOUR_DEFAULT_MAX_MOVES } from "./types";

export function useGamesBenchmarkState() {
  const [models, setModels] = useState<AvailableBenchmarkModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedGame, setSelectedGame] =
    useState<SelectedBenchmarkGame>("chess");
  const [config, setConfig] = useState<ChessBenchmarkConfig>({
    whiteModelId: "",
    blackModelId: "",
    whiteReasoning: "default",
    blackReasoning: "default",
    numGames: 1,
  });
  const [connectFourConfig, setConnectFourConfig] =
    useState<ConnectFourBenchmarkConfig>({
      redModelId: "",
      yellowModelId: "",
      redReasoning: "default",
      yellowReasoning: "default",
      maxMoves: CONNECT_FOUR_DEFAULT_MAX_MOVES,
      numGames: 1,
    });
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
        if (available.length >= 2) {
          const secondModelId = available[Math.min(1, available.length - 1)].modelId;
          setConfig((prev) => ({
            ...prev,
            whiteModelId: prev.whiteModelId || available[0].modelId,
            blackModelId: prev.blackModelId || secondModelId,
          }));
          setConnectFourConfig((prev) => ({
            ...prev,
            redModelId: prev.redModelId || available[0].modelId,
            yellowModelId: prev.yellowModelId || secondModelId,
          }));
        } else if (available.length === 1) {
          setConfig((prev) => ({
            ...prev,
            whiteModelId: prev.whiteModelId || available[0].modelId,
            blackModelId: prev.blackModelId || available[0].modelId,
          }));
          setConnectFourConfig((prev) => ({
            ...prev,
            redModelId: prev.redModelId || available[0].modelId,
            yellowModelId: prev.yellowModelId || available[0].modelId,
          }));
        }
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

  const updateConfig = useCallback(
    <K extends keyof ChessBenchmarkConfig>(
      key: K,
      value: ChessBenchmarkConfig[K]
    ) => {
      setConfig((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  const updateConnectFourConfig = useCallback(
    <K extends keyof ConnectFourBenchmarkConfig>(
      key: K,
      value: ConnectFourBenchmarkConfig[K]
    ) => {
      setConnectFourConfig((prev) => ({ ...prev, [key]: value }));
    },
    []
  );

  return {
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
  };
}
