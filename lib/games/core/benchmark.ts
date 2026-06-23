import type { GameId } from "./types";

export interface GameBenchmarkRunner<TConfig, TResult> {
  gameId: GameId;
  label: string;
  run(config: TConfig, signal: AbortSignal): Promise<TResult>;
}

const benchmarkRunners = new Map<
  GameId,
  GameBenchmarkRunner<unknown, unknown>
>();

export function registerGameBenchmark<TConfig, TResult>(
  runner: GameBenchmarkRunner<TConfig, TResult>
): () => void {
  benchmarkRunners.set(
    runner.gameId,
    runner as GameBenchmarkRunner<unknown, unknown>
  );

  return () => {
    if (benchmarkRunners.get(runner.gameId) === runner) {
      benchmarkRunners.delete(runner.gameId);
    }
  };
}

export function listGameBenchmarkRunners(): GameBenchmarkRunner<
  unknown,
  unknown
>[] {
  return Array.from(benchmarkRunners.values());
}

export function getGameBenchmarkRunner(
  gameId: GameId
): GameBenchmarkRunner<unknown, unknown> | null {
  return benchmarkRunners.get(gameId) ?? null;
}
