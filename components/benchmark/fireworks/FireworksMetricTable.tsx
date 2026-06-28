"use client";

import type { FireworksGameMetrics } from "@/lib/games/fireworks/types";

export function FireworksMetricTable({ metrics }: { metrics: FireworksGameMetrics }) {
  const rows = [
    ["Legal actions", `${metrics.legalActions}`],
    ["Fallback actions", `${metrics.fallbackActions}`],
    ["Useful clues", `${metrics.usefulClues} / ${metrics.cluesGiven}`],
    ["Bad plays", `${metrics.badPlays}`],
    ["Critical discards", `${metrics.criticalDiscards}`],
    ["Model calls", `${metrics.modelCalls}`],
    ["Tokens", `${metrics.inputTokens} in / ${metrics.outputTokens} out`],
    ["Duration", `${(metrics.durationMs / 1000).toFixed(1)}s`],
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label} className="rounded-md border px-3 py-2">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {label}
          </div>
          <div className="mt-1 font-medium">{value}</div>
        </div>
      ))}
    </div>
  );
}
