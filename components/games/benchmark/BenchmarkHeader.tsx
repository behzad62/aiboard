"use client";

import type { Dispatch, SetStateAction } from "react";
import type { RunnableGameBenchmarkDefinition } from "@/lib/games/core/benchmark-definitions";
import type { SelectedBenchmarkGame } from "./types";

export function BenchmarkHeader({
  benchmarkDefinitions,
  benchmarkDescription,
  benchmarkTitle,
  running,
  selectedGame,
  setSelectedGame,
}: {
  benchmarkDefinitions: RunnableGameBenchmarkDefinition[];
  benchmarkDescription: string;
  benchmarkTitle: string;
  running: boolean;
  selectedGame: SelectedBenchmarkGame;
  setSelectedGame: Dispatch<SetStateAction<SelectedBenchmarkGame>>;
}) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
      <div>
        <h2 className="text-xl font-semibold">{benchmarkTitle}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {benchmarkDescription}
        </p>
      </div>
      <div
        className="inline-flex flex-wrap rounded-md border bg-muted p-1"
        role="group"
        aria-label="Benchmark game"
      >
        {benchmarkDefinitions.map((definition) => (
          <button
            key={definition.gameId}
            type="button"
            onClick={() => setSelectedGame(definition.gameId)}
            disabled={running}
            aria-pressed={selectedGame === definition.gameId}
            className={`rounded px-3 py-1.5 text-sm font-medium ${
              selectedGame === definition.gameId
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            } disabled:opacity-50`}
          >
            {definition.label}
          </button>
        ))}
      </div>
    </div>
  );
}
