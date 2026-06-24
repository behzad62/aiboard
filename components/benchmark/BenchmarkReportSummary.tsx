"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { BenchmarkReportCounts } from "@/components/benchmark/useBenchmarkDashboard";

export function BenchmarkReportSummary({
  counts,
}: {
  counts: BenchmarkReportCounts;
}) {
  const rows = [
    ["Suites", counts.suites],
    ["Runs", counts.runs],
    ["Cases", counts.cases],
    ["Attempts", counts.attempts],
    ["Metric values", counts.metricValues],
    ["Artifacts", counts.artifacts],
    ["Failures", counts.failures],
    ["Model-call traces", counts.traces],
    ["Game match records", counts.gameMatches],
    ["Build checkpoints", counts.buildCheckpoints],
    ["Build model stats", counts.buildStats],
  ] as const;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export Contents</CardTitle>
        <CardDescription>
          These records are included in the JSON bundle and summarized in the
          Markdown report.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(([label, value]) => (
            <div key={label} className="rounded-md border bg-muted/20 px-3 py-2">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {label}
              </div>
              <div className="mt-1 text-xl font-semibold tabular-nums">
                {value}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
