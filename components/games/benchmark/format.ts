import type { ConnectFourMatchRecord } from "@/lib/games/connect-four/types";
import type { ConnectFourBenchmarkSummary } from "./types";

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
): ConnectFourBenchmarkSummary | null {
  if (results.length === 0) return null;

  const totalMoves = results.reduce((sum, result) => sum + result.moves, 0);
  const totalDurationMs = results.reduce(
    (sum, result) => sum + result.durationMs,
    0
  );

  return {
    completedGames: results.length,
    savedGames,
    redWins: results.filter((result) => result.result === "red").length,
    yellowWins: results.filter((result) => result.result === "yellow").length,
    draws: results.filter((result) => result.result === "draw").length,
    avgMoves: totalMoves / results.length,
    avgDurationMs: totalDurationMs / results.length,
  };
}
