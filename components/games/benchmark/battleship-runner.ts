import {
  battleshipMatchToGenericGameMatchRecord,
  runBattleshipAIBenchmark,
  type BattleshipMatchRecord,
} from "@/lib/games/battleship/benchmark";
import { saveGenericGameMatchRecord } from "@/lib/games/core/session-store";
import type {
  GameBenchmarkProgressState,
  GameBenchmarkSummary,
  StandardGameBenchmarkConfig,
} from "./types";
import { summarizeBattleshipBenchmark } from "./format";

export async function runBattleshipBenchmarkSeries({
  config,
  isAborted,
  onProgress,
  signal,
}: {
  config: StandardGameBenchmarkConfig;
  isAborted: () => boolean;
  onProgress: (progress: GameBenchmarkProgressState) => void;
  signal: AbortSignal;
}): Promise<{
  results: BattleshipMatchRecord[];
  summary: GameBenchmarkSummary | null;
}> {
  const results: BattleshipMatchRecord[] = [];
  let savedGames = 0;

  for (let i = 0; i < config.numGames; i++) {
    if (signal.aborted || isAborted()) break;
    const result = await runBattleshipAIBenchmark({
      blueModelId: config.firstModelId,
      orangeModelId: config.secondModelId,
      blueReasoning: config.firstReasoning,
      orangeReasoning: config.secondReasoning,
      maxMoves: config.maxMoves,
      signal,
      onProgress: (gameProgress) => {
        onProgress({
          ...gameProgress,
          currentGame: i + 1,
          totalGames: config.numGames,
        });
      },
    });

    if (result && !signal.aborted && !isAborted()) {
      results.push(result);
      try {
        await saveGenericGameMatchRecord(
          battleshipMatchToGenericGameMatchRecord(result)
        );
        savedGames++;
      } catch (error) {
        console.warn("Failed to save Battleship benchmark result:", error);
      }
    }
  }

  return {
    results,
    summary:
      signal.aborted || isAborted()
        ? null
        : summarizeBattleshipBenchmark(results, savedGames),
  };
}
