"use client";

import type { RunnableGameBenchmarkDefinition } from "@/lib/games/core/benchmark-definitions";
import type {
  ChessBenchmarkProgress,
  GameBenchmarkProgressState,
  SelectedBenchmarkGame,
} from "./types";

export function BenchmarkProgress({
  chessProgress,
  definition,
  gameProgress,
  running,
  selectedGame,
}: {
  chessProgress: ChessBenchmarkProgress | null;
  definition: RunnableGameBenchmarkDefinition;
  gameProgress: GameBenchmarkProgressState | null;
  running: boolean;
  selectedGame: SelectedBenchmarkGame;
}) {
  if (!running) return null;
  if (selectedGame === "chess") {
    return chessProgress ? <ChessProgressPanel progress={chessProgress} /> : null;
  }
  return gameProgress ? (
    <GameProgressPanel definition={definition} progress={gameProgress} />
  ) : null;
}

function ChessProgressPanel({ progress }: { progress: ChessBenchmarkProgress }) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-3 text-lg font-semibold">Benchmark Progress</h3>
      <div className="space-y-2">
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium">
            Game {progress.currentGame} of {progress.totalGames}
          </span>
          <span className="text-sm text-muted-foreground">
            Move {progress.moveCount}
          </span>
          <span
            className={`text-sm font-medium ${
              progress.currentTurn === "white"
                ? "text-amber-500"
                : "text-slate-700 dark:text-slate-300"
            }`}
          >
            {progress.currentTurn === "white" ? "White" : "Black"} to move
          </span>
        </div>
        <div className="text-sm text-muted-foreground">{progress.status}</div>
        <code className="mt-2 block overflow-x-auto rounded bg-muted px-2 py-1 font-mono text-xs">
          {progress.fen}
        </code>
      </div>
    </div>
  );
}

function GameProgressPanel({
  definition,
  progress,
}: {
  definition: RunnableGameBenchmarkDefinition;
  progress: GameBenchmarkProgressState;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="mb-3 text-lg font-semibold">Benchmark Progress</h3>
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-sm font-medium">
            Game {progress.currentGame} of {progress.totalGames}
          </span>
          <span className="text-sm text-muted-foreground">
            {definition.maxMovesLabel}: {progress.moveCount} of{" "}
            {progress.maxMoves}
          </span>
          <span className={`text-sm font-medium ${turnColor(progress.currentTurn)}`}>
            {formatTurn(progress.currentTurn)} to move
          </span>
          <span className="text-sm text-muted-foreground">
            Invalid responses: {progress.invalidResponses}
          </span>
          <span className="text-sm text-muted-foreground">
            Fallback moves: {progress.fallbackMoves}
          </span>
        </div>
        <div className="text-sm text-muted-foreground">
          {progress.status}
          {progress.result ? ` Result: ${formatTurn(progress.result)}.` : ""}
        </div>
      </div>
    </div>
  );
}

function formatTurn(value: string): string {
  if (value === "draw") return "Draw";
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function turnColor(value: string): string {
  if (value === "red") return "text-red-600 dark:text-red-400";
  if (value === "yellow") return "text-yellow-600 dark:text-yellow-400";
  if (value === "blue") return "text-blue-600 dark:text-blue-400";
  if (value === "orange") return "text-orange-600 dark:text-orange-400";
  return "text-foreground";
}
