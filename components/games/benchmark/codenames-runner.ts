import {
  codenamesMatchToGenericGameMatchRecord,
  runCodenamesAIBenchmark,
  type CodenamesMatchRecord,
} from "@/lib/games/codenames/benchmark";
import { saveGenericGameMatchRecord } from "@/lib/games/core/session-store";
import type {
  GameBenchmarkProgressState,
  GameBenchmarkSummary,
  StandardGameBenchmarkConfig,
} from "./types";
import { summarizeCodenamesBenchmark } from "./format";

export async function runCodenamesBenchmarkSeries({
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
  results: CodenamesMatchRecord[];
  summary: GameBenchmarkSummary | null;
}> {
  const results: CodenamesMatchRecord[] = [];
  let savedGames = 0;

  for (let i = 0; i < config.numGames; i++) {
    if (signal.aborted || isAborted()) break;
    const result = await runCodenamesAIBenchmark({
      redModelId: config.firstModelId,
      blueModelId: config.secondModelId,
      redReasoning: config.firstReasoning,
      blueReasoning: config.secondReasoning,
      maxTurns: config.maxMoves,
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
          codenamesMatchToGenericGameMatchRecord(result)
        );
        savedGames++;
      } catch (error) {
        console.warn("Failed to save Codenames benchmark result:", error);
      }
    }
  }

  return {
    results,
    summary:
      signal.aborted || isAborted()
        ? null
        : summarizeCodenamesBenchmark(results, savedGames),
  };
}
