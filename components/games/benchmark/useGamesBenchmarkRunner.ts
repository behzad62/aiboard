"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  registerGameBenchmark,
  type GameBenchmarkRunner,
} from "@/lib/games/core/benchmark";
import type { GameMatchRecord } from "@/lib/games/chess/types";
import type { ConnectFourMatchRecord } from "@/lib/games/connect-four/types";
import type {
  ChessBenchmarkConfig,
  ChessBenchmarkProgress,
  ConnectFourBenchmarkConfig,
  ConnectFourBenchmarkProgressState,
  ConnectFourBenchmarkSummary,
  SelectedBenchmarkGame,
} from "./types";
import { runSingleChessBenchmarkGame } from "./chess-runner";
import { runConnectFourBenchmarkSeries } from "./connect-four-runner";

export function useGamesBenchmarkRunner({
  config,
  connectFourConfig,
  loadStats,
  selectedGame,
}: {
  config: ChessBenchmarkConfig;
  connectFourConfig: ConnectFourBenchmarkConfig;
  loadStats: () => void;
  selectedGame: SelectedBenchmarkGame;
}) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ChessBenchmarkProgress | null>(null);
  const [connectFourProgress, setConnectFourProgress] =
    useState<ConnectFourBenchmarkProgressState | null>(null);
  const [connectFourSummary, setConnectFourSummary] =
    useState<ConnectFourBenchmarkSummary | null>(null);
  const abortRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const runChessBenchmark = useCallback(
    async (
      benchmarkConfig: ChessBenchmarkConfig,
      signal: AbortSignal
    ): Promise<GameMatchRecord[]> => {
      if (!benchmarkConfig.whiteModelId || !benchmarkConfig.blackModelId) {
        return [];
      }

      setRunning(true);
      abortRef.current = false;
      setConnectFourProgress(null);
      setConnectFourSummary(null);

      const results: GameMatchRecord[] = [];
      try {
        for (let i = 0; i < benchmarkConfig.numGames; i++) {
          if (signal.aborted || abortRef.current) break;
          const result = await runSingleChessBenchmarkGame({
            config: benchmarkConfig,
            gameNumber: i + 1,
            isAborted: () => abortRef.current,
            onProgress: setProgress,
            totalGames: benchmarkConfig.numGames,
          });
          if (result) results.push(result);
        }
      } finally {
        setRunning(false);
        setProgress(null);
        abortControllerRef.current = null;
        loadStats();
      }
      return results;
    },
    [loadStats]
  );

  useEffect(() => {
    const runner: GameBenchmarkRunner<ChessBenchmarkConfig, GameMatchRecord[]> = {
      gameId: "chess",
      label: "AI vs AI Chess Benchmark",
      run: runChessBenchmark,
    };
    return registerGameBenchmark(runner);
  }, [runChessBenchmark]);

  const runConnectFourBenchmark = useCallback(
    async (
      benchmarkConfig: ConnectFourBenchmarkConfig,
      signal: AbortSignal
    ): Promise<ConnectFourMatchRecord[]> => {
      if (!benchmarkConfig.redModelId || !benchmarkConfig.yellowModelId) {
        return [];
      }

      setRunning(true);
      abortRef.current = false;
      setProgress(null);
      setConnectFourProgress(null);
      setConnectFourSummary(null);

      try {
        const { results, summary } = await runConnectFourBenchmarkSeries({
          config: benchmarkConfig,
          isAborted: () => abortRef.current,
          onProgress: setConnectFourProgress,
            signal,
        });
        if (summary) setConnectFourSummary(summary);
        return results;
      } finally {
        setRunning(false);
        setConnectFourProgress(null);
        abortControllerRef.current = null;
      }
    },
    []
  );

  useEffect(() => {
    const runner: GameBenchmarkRunner<
      ConnectFourBenchmarkConfig,
      ConnectFourMatchRecord[]
    > = {
      gameId: "connect-four",
      label: "AI vs AI Connect Four Benchmark",
      run: runConnectFourBenchmark,
    };
    return registerGameBenchmark(runner);
  }, [runConnectFourBenchmark]);

  const runBenchmark = useCallback(async () => {
    const controller = new AbortController();
    abortControllerRef.current = controller;

    if (selectedGame === "connect-four") {
      await runConnectFourBenchmark(connectFourConfig, controller.signal);
      return;
    }

    await runChessBenchmark(config, controller.signal);
  }, [
    config,
    connectFourConfig,
    runChessBenchmark,
    runConnectFourBenchmark,
    selectedGame,
  ]);

  const abortBenchmark = useCallback(() => {
    abortRef.current = true;
    abortControllerRef.current?.abort();
  }, []);

  return {
    abortBenchmark,
    connectFourProgress,
    connectFourSummary,
    progress,
    runBenchmark,
    running,
  };
}
