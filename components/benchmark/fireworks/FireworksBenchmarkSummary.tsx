"use client";

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
  return (
    <section className="space-y-3 rounded-md border border-sky-200 bg-sky-50/50 p-3 dark:border-sky-900 dark:bg-sky-950/20">
      <div className="grid gap-2 sm:grid-cols-4">
        <Tile label="Team score" value={summary.score.toFixed(1)} />
        <Tile
          label="Stack score"
          value={`${round(metrics.finalScore)} / ${metrics.maxScore}`}
        />
        <Tile
          label="Team lift"
          value={attempt.teamLift == null ? "n/a" : signed(attempt.teamLift)}
        />
        <Tile
          label="Cost per point"
          value={costPerPoint(metrics.costUsd, metrics.finalScore)}
        />
      </div>
      <FireworksMetricTable metrics={metrics} />
      {transcript !== null && <FireworksTranscriptViewer transcript={transcript} />}
    </section>
  );
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

function costPerPoint(costUsd: number | null, score: number): string {
  if (costUsd === null || score <= 0) return "n/a";
  return `$${(costUsd / score).toFixed(4)}`;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
