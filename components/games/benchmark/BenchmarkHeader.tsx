"use client";

import type { Dispatch, SetStateAction } from "react";
import type { SelectedBenchmarkGame } from "./types";

export function BenchmarkHeader({
  benchmarkDescription,
  benchmarkTitle,
  running,
  selectedGame,
  setSelectedGame,
}: {
  benchmarkDescription: string;
  benchmarkTitle: string;
  running: boolean;
  selectedGame: SelectedBenchmarkGame;
  setSelectedGame: Dispatch<SetStateAction<SelectedBenchmarkGame>>;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h2 className="text-xl font-semibold">{benchmarkTitle}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {benchmarkDescription}
        </p>
      </div>
      <div
        className="inline-flex rounded-md border bg-muted p-1"
        role="group"
        aria-label="Benchmark game"
      >
        <button
          type="button"
          onClick={() => setSelectedGame("chess")}
          disabled={running}
          aria-pressed={selectedGame === "chess"}
          className={`rounded px-3 py-1.5 text-sm font-medium ${
            selectedGame === "chess"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          } disabled:opacity-50`}
        >
          Chess
        </button>
        <button
          type="button"
          onClick={() => setSelectedGame("connect-four")}
          disabled={running}
          aria-pressed={selectedGame === "connect-four"}
          className={`rounded px-3 py-1.5 text-sm font-medium ${
            selectedGame === "connect-four"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          } disabled:opacity-50`}
        >
          Connect Four
        </button>
      </div>
    </div>
  );
}
