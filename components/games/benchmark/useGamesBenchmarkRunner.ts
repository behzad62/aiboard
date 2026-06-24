"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  registerGameBenchmark,
  type GameBenchmarkRunner,
} from "@/lib/games/core/benchmark";
import type { GameMatchRecord } from "@/lib/games/chess/types";
import type { ConnectFourMatchRecord } from "@/lib/games/connect-four/types";
import type { BattleshipMatchRecord } from "@/lib/games/battleship/benchmark";
import type { CodenamesMatchRecord } from "@/lib/games/codenames/benchmark";
import type {
  ChessBenchmarkConfig,
  ChessBenchmarkProgress,
  GameBenchmarkProgressState,
  GameBenchmarkSummary,
  SelectedBenchmarkGame,
  StandardGameBenchmarkConfig,
} from "./types";
import { runBattleshipBenchmarkSeries } from "./battleship-runner";
import { runSingleChessBenchmarkGame } from "./chess-runner";
import { runCodenamesBenchmarkSeries } from "./codenames-runner";
import { runConnectFourBenchmarkSeries } from "./connect-four-runner";

type NonChessBenchmarkResult =
  | ConnectFourMatchRecord[]
  | BattleshipMatchRecord[]
  | CodenamesMatchRecord[];

function toChessConfig(
  config: StandardGameBenchmarkConfig
): ChessBenchmarkConfig {
  return {
    whiteModelId: config.firstModelId,
    blackModelId: config.secondModelId,
    whiteReasoning: config.firstReasoning,
    blackReasoning: config.secondReasoning,
    maxMoves: config.maxMoves,
    numGames: config.numGames,
  };
}

export function useGamesBenchmarkRunner({
  config,
  loadStats,
  selectedGame,
}: {
  config: StandardGameBenchmarkConfig;
  loadStats: () => void;
  selectedGame: SelectedBenchmarkGame;
}) {
  const [running, setRunning] = useState(false);
  const [chessProgress, setChessProgress] =
    useState<ChessBenchmarkProgress | null>(null);
  const [gameProgress, setGameProgress] =
    useState<GameBenchmarkProgressState | null>(null);
  const [gameSummary, setGameSummary] = useState<GameBenchmarkSummary | null>(
    null
  );
  const abortRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const resetProgress = useCallback(() => {
    setChessProgress(null);
    setGameProgress(null);
    setGameSummary(null);
  }, []);

  const runChessBenchmark = useCallback(
    async (
      benchmarkConfig: StandardGameBenchmarkConfig,
      signal: AbortSignal
    ): Promise<GameMatchRecord[]> => {
      if (!benchmarkConfig.firstModelId || !benchmarkConfig.secondModelId) {
        return [];
      }

      setRunning(true);
      abortRef.current = false;
      resetProgress();

      const chessConfig = toChessConfig(benchmarkConfig);
      const results: GameMatchRecord[] = [];
      try {
        for (let i = 0; i < chessConfig.numGames; i++) {
          if (signal.aborted || abortRef.current) break;
          const result = await runSingleChessBenchmarkGame({
            config: chessConfig,
            gameNumber: i + 1,
            isAborted: () => abortRef.current,
            onProgress: setChessProgress,
            totalGames: chessConfig.numGames,
          });
          if (result) results.push(result);
        }
      } finally {
        setRunning(false);
        setChessProgress(null);
        abortControllerRef.current = null;
        loadStats();
      }
      return results;
    },
    [loadStats, resetProgress]
  );

  const runNonChessBenchmark = useCallback(
    async <TResult extends NonChessBenchmarkResult>(
      benchmarkConfig: StandardGameBenchmarkConfig,
      signal: AbortSignal,
      runner: (args: {
        config: StandardGameBenchmarkConfig;
        isAborted: () => boolean;
        onProgress: (progress: GameBenchmarkProgressState) => void;
        signal: AbortSignal;
      }) => Promise<{ results: TResult; summary: GameBenchmarkSummary | null }>
    ): Promise<TResult> => {
      if (!benchmarkConfig.firstModelId || !benchmarkConfig.secondModelId) {
        return [] as unknown as TResult;
      }

      setRunning(true);
      abortRef.current = false;
      resetProgress();

      try {
        const { results, summary } = await runner({
          config: benchmarkConfig,
          isAborted: () => abortRef.current,
          onProgress: setGameProgress,
          signal,
        });
        if (summary) setGameSummary(summary);
        return results;
      } finally {
        setRunning(false);
        setGameProgress(null);
        abortControllerRef.current = null;
      }
    },
    [resetProgress]
  );

  const runConnectFourBenchmark = useCallback(
    async (
      benchmarkConfig: StandardGameBenchmarkConfig,
      signal: AbortSignal
    ): Promise<ConnectFourMatchRecord[]> => {
      return runNonChessBenchmark(
        benchmarkConfig,
        signal,
        runConnectFourBenchmarkSeries
      );
    },
    [runNonChessBenchmark]
  );

  const runBattleshipBenchmark = useCallback(
    async (
      benchmarkConfig: StandardGameBenchmarkConfig,
      signal: AbortSignal
    ): Promise<BattleshipMatchRecord[]> => {
      return runNonChessBenchmark(
        benchmarkConfig,
        signal,
        runBattleshipBenchmarkSeries
      );
    },
    [runNonChessBenchmark]
  );

  const runCodenamesBenchmark = useCallback(
    async (
      benchmarkConfig: StandardGameBenchmarkConfig,
      signal: AbortSignal
    ): Promise<CodenamesMatchRecord[]> => {
      return runNonChessBenchmark(
        benchmarkConfig,
        signal,
        runCodenamesBenchmarkSeries
      );
    },
    [runNonChessBenchmark]
  );

  useEffect(() => {
    const runners: GameBenchmarkRunner<
      StandardGameBenchmarkConfig,
      unknown
    >[] = [
      {
        gameId: "chess",
        label: "AI vs AI Chess Benchmark",
        run: runChessBenchmark,
      },
      {
        gameId: "connect-four",
        label: "AI vs AI Connect Four Benchmark",
        run: runConnectFourBenchmark,
      },
      {
        gameId: "battleship",
        label: "AI vs AI Battleship Benchmark",
        run: runBattleshipBenchmark,
      },
      {
        gameId: "codenames",
        label: "AI vs AI Codenames Benchmark",
        run: runCodenamesBenchmark,
      },
    ];

    const unregister = runners.map((runner) => registerGameBenchmark(runner));
    return () => {
      unregister.forEach((dispose) => dispose());
    };
  }, [
    runBattleshipBenchmark,
    runChessBenchmark,
    runCodenamesBenchmark,
    runConnectFourBenchmark,
  ]);

  const runBenchmark = useCallback(async () => {
    const controller = new AbortController();
    abortControllerRef.current = controller;

    if (selectedGame === "connect-four") {
      await runConnectFourBenchmark(config, controller.signal);
      return;
    }
    if (selectedGame === "battleship") {
      await runBattleshipBenchmark(config, controller.signal);
      return;
    }
    if (selectedGame === "codenames") {
      await runCodenamesBenchmark(config, controller.signal);
      return;
    }

    await runChessBenchmark(config, controller.signal);
  }, [
    config,
    runBattleshipBenchmark,
    runChessBenchmark,
    runCodenamesBenchmark,
    runConnectFourBenchmark,
    selectedGame,
  ]);

  const abortBenchmark = useCallback(() => {
    abortRef.current = true;
    abortControllerRef.current?.abort();
  }, []);

  return {
    abortBenchmark,
    chessProgress,
    gameProgress,
    gameSummary,
    runBenchmark,
    running,
  };
}
