"use client";

import type { ConnectFourBenchmarkSummary } from "./types";
import { formatDuration } from "./format";

export function ConnectFourBenchmarkResult({
  connectFourSummary,
  running,
}: {
  connectFourSummary: ConnectFourBenchmarkSummary | null;
  running: boolean;
}) {
  if (!running && connectFourSummary) {
    return (
      <div className="rounded-lg border bg-card p-4">
        <h3 className="mb-3 text-lg font-semibold">
          Latest Connect Four Benchmark
        </h3>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-6">
          <SummaryCell label="Completed" value={connectFourSummary.completedGames} />
          <SummaryCell label="Saved" value={connectFourSummary.savedGames} />
          <SummaryCell
            label="Red Wins"
            value={connectFourSummary.redWins}
            className="text-red-600 dark:text-red-400"
          />
          <SummaryCell
            label="Yellow Wins"
            value={connectFourSummary.yellowWins}
            className="text-yellow-600 dark:text-yellow-400"
          />
          <SummaryCell
            label="Draws"
            value={connectFourSummary.draws}
            className="text-muted-foreground"
          />
          <SummaryCell
            label="Avg Moves"
            value={Math.round(connectFourSummary.avgMoves)}
          />
        </div>
        <div className="mt-3 text-center text-sm text-muted-foreground">
          Average duration {formatDuration(connectFourSummary.avgDurationMs)}
        </div>
      </div>
    );
  }

  if (!running && !connectFourSummary) {
    return (
      <div className="rounded-lg border bg-card p-8 text-center">
        <div className="mb-2 text-lg font-medium">
          No Connect Four benchmark running
        </div>
        <div className="text-sm text-muted-foreground">
          Configure the models above and click &quot;Run Benchmark&quot; to start
          an AI vs AI Connect Four match.
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
