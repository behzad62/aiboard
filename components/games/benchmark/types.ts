import type { ReasoningEffort } from "@/lib/db/schema";
import type { RunnableGameBenchmarkId } from "@/lib/games/core/benchmark-definitions";

export const MAX_CHESS_BENCHMARK_MOVES = 100;
export const BENCHMARK_MOVE_DELAY_MS = 300;

export const REASONING_LEVELS: {
  value: ReasoningEffort;
  label: string;
}[] = [
  { value: "none", label: "Off" },
  { value: "default", label: "Default" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

export interface AvailableBenchmarkModel {
  modelId: string;
  displayName: string;
}

export type SelectedBenchmarkGame = RunnableGameBenchmarkId;

export interface StandardGameBenchmarkConfig {
  firstModelId: string;
  secondModelId: string;
  firstReasoning: ReasoningEffort;
  secondReasoning: ReasoningEffort;
  maxMoves: number;
  numGames: number;
}

export type GameBenchmarkConfigMap = Record<
  RunnableGameBenchmarkId,
  StandardGameBenchmarkConfig
>;

export interface ChessBenchmarkConfig {
  whiteModelId: string;
  blackModelId: string;
  whiteReasoning: ReasoningEffort;
  blackReasoning: ReasoningEffort;
  maxMoves: number;
  numGames: number;
}

export interface ChessBenchmarkProgress {
  currentGame: number;
  totalGames: number;
  moveCount: number;
  currentTurn: "white" | "black";
  status: string;
  fen: string;
}

export interface GameBenchmarkProgressState {
  currentGame: number;
  totalGames: number;
  moveCount: number;
  currentTurn: string;
  status: string;
  result: string | null;
  invalidResponses: number;
  fallbackMoves: number;
  maxMoves: number;
}

export interface GameBenchmarkSummary {
  gameId: RunnableGameBenchmarkId;
  title: string;
  completedGames: number;
  savedGames: number;
  winners: Array<{
    label: string;
    value: number;
    className?: string;
  }>;
  draws: number;
  avgMoves: number;
  avgDurationMs: number;
  invalidResponses: number;
  fallbackMoves: number;
  extraStats?: Array<{
    label: string;
    value: number;
  }>;
}
