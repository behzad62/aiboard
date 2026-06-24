import type { GameId } from "./types";

export type RunnableGameBenchmarkId =
  | "chess"
  | "connect-four"
  | "battleship"
  | "codenames";

export interface RunnableGameBenchmarkDefinition {
  gameId: RunnableGameBenchmarkId;
  label: string;
  title: string;
  description: string;
  firstPlayerLabel: string;
  secondPlayerLabel: string;
  maxMovesLabel: string;
  defaultMaxMoves: number;
  maxMovesMax: number;
}

const RUNNABLE_GAME_BENCHMARKS: RunnableGameBenchmarkDefinition[] = [
  {
    gameId: "chess",
    label: "Chess",
    title: "AI vs AI Chess Benchmark",
    description:
      "Run head-to-head chess matches between configured AI models and compare win rate, move speed, and reliability.",
    firstPlayerLabel: "White",
    secondPlayerLabel: "Black",
    maxMovesLabel: "Max Moves",
    defaultMaxMoves: 100,
    maxMovesMax: 200,
  },
  {
    gameId: "connect-four",
    label: "Connect Four",
    title: "AI vs AI Connect Four Benchmark",
    description:
      "Run head-to-head Connect Four matches between configured AI models and track move quality, fallback use, and invalid responses.",
    firstPlayerLabel: "Red",
    secondPlayerLabel: "Yellow",
    maxMovesLabel: "Max Moves",
    defaultMaxMoves: 42,
    maxMovesMax: 42,
  },
  {
    gameId: "battleship",
    label: "Battleship",
    title: "AI vs AI Battleship Benchmark",
    description:
      "Run hidden-information Battleship matches with AI fleet placement, shot selection, fallback shots, and sink efficiency.",
    firstPlayerLabel: "Blue",
    secondPlayerLabel: "Orange",
    maxMovesLabel: "Max Shots",
    defaultMaxMoves: 120,
    maxMovesMax: 200,
  },
  {
    gameId: "codenames",
    label: "Codenames",
    title: "AI vs AI Codenames Benchmark",
    description:
      "Run Codenames team matches where each model acts as both spymaster and operative for its team.",
    firstPlayerLabel: "Red Team",
    secondPlayerLabel: "Blue Team",
    maxMovesLabel: "Max Turns",
    defaultMaxMoves: 24,
    maxMovesMax: 60,
  },
];

export function listRunnableGameBenchmarkDefinitions(): RunnableGameBenchmarkDefinition[] {
  return [...RUNNABLE_GAME_BENCHMARKS];
}

export function getRunnableGameBenchmarkDefinition(
  gameId: GameId
): RunnableGameBenchmarkDefinition | null {
  return (
    RUNNABLE_GAME_BENCHMARKS.find((definition) => definition.gameId === gameId) ??
    null
  );
}
