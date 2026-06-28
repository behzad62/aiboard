"use client";

import React from "react";
import type { BenchmarkArtifact, BenchmarkAttemptV2 } from "@/lib/benchmark/types";
import type { FireworksGameMetrics } from "@/lib/games/fireworks/types";
import { FireworksMetricTable } from "./FireworksMetricTable";
import { FireworksTranscriptViewer } from "./FireworksTranscriptViewer";

interface FireworksSummaryArtifact {
  score: number;
  metrics: FireworksGameMetrics;
  team: string;
  caseScores: Array<{ caseId: string; score: number }>;
}

export function FireworksBenchmarkSummary({
  attempt,
  artifacts,
}: {
  attempt: BenchmarkAttemptV2;
  artifacts: BenchmarkArtifact[];
}) {
  const summary = parseSummary(
    artifacts.find((artifact) => artifact.id.endsWith(":fireworks-summary"))
  );
  const transcript = parseJson(
    artifacts.find((artifact) => artifact.id.endsWith(":fireworks-transcript"))
      ?.content
  );
  if (!summary) return null;

  const metrics = summary.metrics;
  const tiles = scoreTiles(summary, attempt);
  return (
    <section className="space-y-3 rounded-md border border-sky-200 bg-sky-50/50 p-3 dark:border-sky-900 dark:bg-sky-950/20">
      <div className="grid gap-2 sm:grid-cols-4">
        {tiles.map((tile) => (
          <Tile key={tile.label} label={tile.label} value={tile.value} />
        ))}
      </div>
      <FireworksMetricTable metrics={metrics} />
      {transcript !== null && <FireworksTranscriptViewer transcript={transcript} />}
    </section>
  );
}

function scoreTiles(
  summary: FireworksSummaryArtifact,
  attempt: BenchmarkAttemptV2
): Array<{ label: string; value: string }> {
  const metrics = summary.metrics;
  const tiles = [{ label: "Team score", value: summary.score.toFixed(1) }];
  if (metrics.scoreKind === "scenario" || metrics.scoreKind === "mixed") {
    tiles.push({
      label: "Scenario quality",
      value:
        metrics.scenarioQualityScore == null
          ? "n/a"
          : percent(metrics.scenarioQualityScore),
    });
  }
  if (metrics.scoreKind === "full_game" || metrics.scoreKind === "mixed") {
    tiles.push({
      label: "Stack score",
      value:
        metrics.fullGameStackScore == null
          ? "n/a"
          : `${round(metrics.fullGameStackScore)} / ${metrics.maxScore}`,
    });
    tiles.push({
      label: "Full-game team",
      value:
        metrics.fullGameTeamScore == null
          ? "n/a"
          : percent(metrics.fullGameTeamScore),
    });
  }
  tiles.push({
    label: "Team lift",
    value: attempt.teamLift == null ? "n/a" : signed(attempt.teamLift),
  });
  tiles.push({
    label: "Cost / benchmark point",
    value: costPerPoint(metrics.costUsd, summary.score),
  });
  if (metrics.scoreKind === "full_game" || metrics.scoreKind === "mixed") {
    tiles.push({
      label: "Cost / stack point",
      value: costPerPoint(metrics.costUsd, metrics.fullGameStackScore),
    });
  }
  return tiles;
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-white px-3 py-2 dark:border-slate-800 dark:bg-slate-950">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 font-semibold">{value}</div>
    </div>
  );
}

function parseSummary(artifact: BenchmarkArtifact | undefined): FireworksSummaryArtifact | null {
  const parsed = parseJson(artifact?.content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Partial<FireworksSummaryArtifact>;
  if (typeof record.score !== "number" || !record.metrics) return null;
  return record as FireworksSummaryArtifact;
}

function parseJson(content: string | undefined): unknown | null {
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function signed(value: number): string {
  return value > 0 ? `+${value.toFixed(1)}` : value.toFixed(1);
}

function costPerPoint(costUsd: number | null, points: number | null): string {
  if (costUsd === null || points == null || points <= 0) return "n/a";
  return `$${(costUsd / points).toFixed(4)}`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}
