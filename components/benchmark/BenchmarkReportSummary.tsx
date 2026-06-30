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
  const labRows = [
    ["Suites", counts.suites],
    ["Runs", counts.runs],
    ["Cases", counts.cases],
    ["Attempts", counts.attempts],
    ["Metric values", counts.metricValues],
    ["Artifacts", counts.artifacts],
    ["Failures", counts.failures],
    ["Game match records", counts.gameMatches],
    ["Build checkpoints", counts.buildCheckpoints],
    ["Build model stats", counts.buildStats],
  ] as const;
  const certifiedRows = [
    ["Certified cases", counts.certifiedCases],
    ["Certified attempts", counts.certifiedAttempts],
    ["Verifier results", counts.verifierResults],
    ["Team compositions", counts.teamCompositions],
    ["Harness certifications", counts.harnessCertifications],
  ] as const;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Export Contents</CardTitle>
        <CardDescription>
          Lab evidence and certified records are exported together in the
          current bundle format.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <ReportCountGroup title="Lab evidence" rows={labRows} />
        <ReportCountGroup title="Certified records" rows={certifiedRows} />
      </CardContent>
    </Card>
  );
}

function ReportCountGroup({
  title,
  rows,
}: {
  title: string;
  rows: readonly (readonly [string, number])[];
}) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
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
    </div>
  );
}
