"use client";

import React from "react";
import type { FireworksGameMetrics } from "@/lib/games/fireworks/types";
import { computeFireworksMetricRates } from "@/lib/games/fireworks/scoring";

export function FireworksMetricTable({ metrics }: { metrics: FireworksGameMetrics }) {
  const rates = computeFireworksMetricRates({ metrics });
  const rows = [
    [
      "Legal actions",
      rates.legalActionSampled
        ? `${metrics.legalActions} (${percent(rates.legalActionRate)})`
        : "not sampled",
    ],
    ["Fallback actions", `${metrics.fallbackActions}`],
    [
      "Useful clues",
      rates.usefulClueSampled
        ? `${metrics.usefulClues} / ${metrics.cluesGiven} (${percent(rates.usefulClueRate)})`
        : "not sampled",
    ],
    [
      "Safe plays",
      rates.safePlaySampled
        ? `${metrics.safePlays} / ${metrics.plays} (${percent(rates.safePlayRate)})`
        : "not sampled",
    ],
    ["Bad plays", `${metrics.badPlays}`],
    [
      "Critical discard safety",
      rates.criticalDiscardSampled
        ? `${metrics.criticalDiscards} critical (${percent(rates.criticalDiscardSafety)})`
        : "not sampled",
    ],
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

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}
