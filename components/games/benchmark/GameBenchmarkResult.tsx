"use client";

import type { RunnableGameBenchmarkDefinition } from "@/lib/games/core/benchmark-definitions";
import type { GameBenchmarkSummary } from "./types";
import { formatDuration } from "./format";

interface SummaryCellData {
  label: string;
  value: number;
  className?: string;
}

export function GameBenchmarkResult({
  definition,
  running,
  summary,
}: {
  definition: RunnableGameBenchmarkDefinition;
  running: boolean;
  summary: GameBenchmarkSummary | null;
}) {
  if (!running && summary) {
    const cells: SummaryCellData[] = [
      { label: "Completed", value: summary.completedGames },
      { label: "Saved", value: summary.savedGames },
      ...summary.winners,
      {
        label: "Draws",
        value: summary.draws,
        className: "text-muted-foreground",
      },
      { label: "Avg Moves", value: Math.round(summary.avgMoves) },
      { label: "Invalid", value: summary.invalidResponses },
      { label: "Fallbacks", value: summary.fallbackMoves },
      ...(summary.extraStats ?? []),
    ];

    return (
      <div className="rounded-lg border bg-card p-4">
        <h3 className="mb-3 text-lg font-semibold">{summary.title}</h3>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6">
          {cells.map((cell) => (
            <SummaryCell
              key={cell.label}
              label={cell.label}
              value={cell.value}
              className={cell.className}
            />
          ))}
        </div>
        <div className="mt-3 text-center text-sm text-muted-foreground">
          Average duration {formatDuration(summary.avgDurationMs)}
        </div>
      </div>
    );
  }

  if (!running && !summary) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center">
        <div className="mb-2 text-lg font-medium">
          No {definition.label} benchmark running
        </div>
        <div className="text-sm text-muted-foreground">
          Configure the models above and click &quot;Run Benchmark&quot; to start
          an AI vs AI {definition.label} match.
        </div>
      </div>
    );
  }

  return null;
}

function SummaryCell({
  className,
  label,
  value,
}: {
  className?: string;
  label: string;
  value: number;
}) {
  return (
    <div className="text-center">
      <div className={`text-2xl font-bold ${className ?? ""}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
