import type { ReasoningEffort } from "@/lib/db/schema";
import type { ConnectFourBenchmarkProgress } from "@/lib/games/connect-four/benchmark";

export const MAX_CHESS_BENCHMARK_MOVES = 100;
export const CONNECT_FOUR_DEFAULT_MAX_MOVES = 42;
export const BENCHMARK_MOVE_DELAY_MS = 300;

export const REASONING_LEVELS: {
  value: ReasoningEffort;
  label: string;
}[] = [
  { value: "default", label: "Disabled" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "max", label: "Max" },
];

export interface AvailableBenchmarkModel {
  modelId: string;
  displayName: string;
}

export type SelectedBenchmarkGame = "chess" | "connect-four";

export interface ChessBenchmarkConfig {
  whiteModelId: string;
  blackModelId: string;
  whiteReasoning: ReasoningEffort;
  blackReasoning: ReasoningEffort;
  numGames: number;
}

export interface ConnectFourBenchmarkConfig {
  redModelId: string;
  yellowModelId: string;
  redReasoning: ReasoningEffort;
  yellowReasoning: ReasoningEffort;
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

export interface ConnectFourBenchmarkProgressState
  extends ConnectFourBenchmarkProgress {
  currentGame: number;
  totalGames: number;
}

export interface ConnectFourBenchmarkSummary {
  completedGames: number;
  savedGames: number;
  redWins: number;
  yellowWins: number;
  draws: number;
  avgMoves: number;
  avgDurationMs: number;
}
