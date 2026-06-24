"use client";

import type {
  ChessBenchmarkProgress,
  ConnectFourBenchmarkProgressState,
} from "./types";

export function BenchmarkProgress({
  connectFourProgress,
  isConnectFourSelected,
  progress,
  running,
}: {
  connectFourProgress: ConnectFourBenchmarkProgressState | null;
  isConnectFourSelected: boolean;
  progress: ChessBenchmarkProgress | null;
  running: boolean;
}) {
  if (!running) return null;
  if (isConnectFourSelected) {
    return connectFourProgress ? (
      <ConnectFourProgressPanel progress={connectFourProgress} />
    ) : null;
  }
  return progress ? <ChessProgressPanel progress={progress} /> : null;
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

function ConnectFourProgressPanel({
  progress,
}: {
  progress: ConnectFourBenchmarkProgressState;
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
            Move {progress.moveCount} of {progress.maxMoves}
          </span>
          <span
            className={`text-sm font-medium ${
              progress.currentTurn === "red"
                ? "text-red-600 dark:text-red-400"
                : "text-yellow-600 dark:text-yellow-400"
            }`}
          >
            {progress.currentTurn === "red" ? "Red" : "Yellow"} to move
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
          {progress.result
            ? ` Result: ${progress.result === "draw" ? "Draw" : progress.result}.`
            : ""}
        </div>
      </div>
    </div>
  );
}
