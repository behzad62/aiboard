import { saveGenericGameMatchRecord } from "@/lib/games/core/session-store";
import {
  connectFourMatchToGenericGameMatchRecord,
  runConnectFourAIBenchmark,
  type ConnectFourBenchmarkProgress,
} from "@/lib/games/connect-four/benchmark";
import type { ConnectFourMatchRecord } from "@/lib/games/connect-four/types";
import type {
  ConnectFourBenchmarkConfig,
  ConnectFourBenchmarkSummary,
} from "./types";
import { summarizeConnectFourBenchmark } from "./format";

export async function runConnectFourBenchmarkSeries({
  config,
  isAborted,
  onProgress,
  signal,
}: {
  config: ConnectFourBenchmarkConfig;
  isAborted: () => boolean;
  onProgress: (
    progress: ConnectFourBenchmarkProgress & {
      currentGame: number;
      totalGames: number;
    }
  ) => void;
  signal: AbortSignal;
}): Promise<{
  results: ConnectFourMatchRecord[];
  summary: ConnectFourBenchmarkSummary | null;
}> {
  const results: ConnectFourMatchRecord[] = [];
  let savedGames = 0;

  for (let i = 0; i < config.numGames; i++) {
    if (signal.aborted || isAborted()) break;
    const result = await runConnectFourAIBenchmark({
      redModelId: config.redModelId,
      yellowModelId: config.yellowModelId,
      redReasoning: config.redReasoning,
      yellowReasoning: config.yellowReasoning,
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
          connectFourMatchToGenericGameMatchRecord(result)
        );
        savedGames++;
      } catch (error) {
        console.warn("Failed to save Connect Four benchmark result:", error);
      }
    }
  }

  return {
    results,
    summary:
      signal.aborted || isAborted()
        ? null
        : summarizeConnectFourBenchmark(results, savedGames),
  };
}
