import type { ConnectFourMatchRecord } from "@/lib/games/connect-four/types";
import type { BattleshipMatchRecord } from "@/lib/games/battleship/benchmark";
import type { CodenamesMatchRecord } from "@/lib/games/codenames/benchmark";
import type { GameBenchmarkSummary } from "./types";

export function generateBenchmarkId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

export function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
  });
}

export function getModelDisplayName(modelId: string): string {
  const parts = modelId.split(":");
  return parts.length > 1 ? parts[parts.length - 1] : modelId;
}

export function summarizeConnectFourBenchmark(
  results: ConnectFourMatchRecord[],
  savedGames: number
): GameBenchmarkSummary | null {
  if (results.length === 0) return null;

  const totalMoves = results.reduce((sum, result) => sum + result.moves, 0);
  const totalDurationMs = results.reduce(
    (sum, result) => sum + result.durationMs,
    0
  );

  return {
    gameId: "connect-four",
    title: "Latest Connect Four Benchmark",
    completedGames: results.length,
    savedGames,
    winners: [
      {
        label: "Red Wins",
        value: results.filter((result) => result.result === "red").length,
        className: "text-red-600 dark:text-red-400",
      },
      {
        label: "Yellow Wins",
        value: results.filter((result) => result.result === "yellow").length,
        className: "text-yellow-600 dark:text-yellow-400",
      },
    ],
    draws: results.filter((result) => result.result === "draw").length,
    avgMoves: totalMoves / results.length,
    avgDurationMs: totalDurationMs / results.length,
    invalidResponses: results.reduce(
      (sum, result) => sum + (result.invalidResponses ?? 0),
      0
    ),
    fallbackMoves: results.reduce(
      (sum, result) => sum + (result.fallbackMoves ?? 0),
      0
    ),
  };
}

export function summarizeBattleshipBenchmark(
  results: BattleshipMatchRecord[],
  savedGames: number
): GameBenchmarkSummary | null {
  if (results.length === 0) return null;
  return {
    gameId: "battleship",
    title: "Latest Battleship Benchmark",
    completedGames: results.length,
    savedGames,
    winners: [
      {
        label: "Blue Wins",
        value: results.filter((result) => result.result === "blue").length,
        className: "text-sky-600 dark:text-sky-400",
      },
      {
        label: "Orange Wins",
        value: results.filter((result) => result.result === "orange").length,
        className: "text-orange-600 dark:text-orange-400",
      },
    ],
    draws: results.filter((result) => result.result === "draw").length,
    avgMoves:
      results.reduce((sum, result) => sum + result.shots, 0) / results.length,
    avgDurationMs:
      results.reduce((sum, result) => sum + result.durationMs, 0) /
      results.length,
    invalidResponses: results.reduce(
      (sum, result) => sum + result.invalidResponses,
      0
    ),
    fallbackMoves: results.reduce((sum, result) => sum + result.fallbackMoves, 0),
    extraStats: [
      {
        label: "Placement Fallbacks",
        value: results.reduce(
          (sum, result) => sum + result.placementFallbacks,
          0
        ),
      },
    ],
  };
}

export function summarizeCodenamesBenchmark(
  results: CodenamesMatchRecord[],
  savedGames: number
): GameBenchmarkSummary | null {
  if (results.length === 0) return null;
  return {
    gameId: "codenames",
    title: "Latest Codenames Benchmark",
    completedGames: results.length,
    savedGames,
    winners: [
      {
        label: "Red Wins",
        value: results.filter((result) => result.result === "red").length,
        className: "text-red-600 dark:text-red-400",
      },
      {
        label: "Blue Wins",
        value: results.filter((result) => result.result === "blue").length,
        className: "text-blue-600 dark:text-blue-400",
      },
    ],
    draws: results.filter((result) => result.result === "draw").length,
    avgMoves:
      results.reduce((sum, result) => sum + result.moves, 0) / results.length,
    avgDurationMs:
      results.reduce((sum, result) => sum + result.durationMs, 0) /
      results.length,
    invalidResponses: results.reduce(
      (sum, result) => sum + result.invalidResponses,
      0
    ),
    fallbackMoves: results.reduce((sum, result) => sum + result.fallbackMoves, 0),
    extraStats: [
      {
        label: "Assassin Hits",
        value: results.reduce((sum, result) => sum + result.assassinHits, 0),
      },
    ],
  };
}
