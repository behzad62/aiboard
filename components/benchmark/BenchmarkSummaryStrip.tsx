"use client";

import type { BenchmarkDashboardData } from "@/lib/benchmark/metrics";
import { duration, pct, usd } from "@/components/benchmark/format";

export function BenchmarkSummaryStrip({
  dashboard,
  suiteCount,
  traceCount,
}: {
  dashboard: BenchmarkDashboardData;
  suiteCount: number;
  traceCount: number;
}) {
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-7">
        <SummaryCard label="Runs" value={String(dashboard.summary.totalRuns)} />
        <SummaryCard
          label="Runnable cases"
          value={String(dashboard.summary.totalCases)}
          hint={
            dashboard.summary.capturedCases > 0
              ? `+${dashboard.summary.capturedCases} captured stop-report case(s), not runnable`
              : undefined
          }
        />
        <SummaryCard label="Models" value={String(dashboard.summary.totalModels)} />
        <SummaryCard label="Completion" value={pct(dashboard.summary.completionRate)} />
        <SummaryCard label="Schema valid" value={pct(dashboard.summary.schemaValidRate)} />
        <SummaryCard label="Legal actions" value={pct(dashboard.summary.legalActionRate)} />
        <SummaryCard label="Fallback" value={pct(dashboard.summary.fallbackRate)} />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard label="Avg cost" value={usd(dashboard.summary.averageCostUsd)} />
        <SummaryCard label="Avg latency" value={duration(dashboard.summary.averageLatencyMs)} />
        <SummaryCard label="Saved suites" value={String(suiteCount)} />
        <SummaryCard label="Raw traces" value={String(traceCount)} />
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-lg border bg-card px-4 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint ? (
        <div className="mt-1 text-[11px] leading-tight text-muted-foreground">
          {hint}
        </div>
      ) : null}
    </div>
  );
}
