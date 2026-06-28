"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { BenchmarkReportCounts } from "@/components/benchmark/useBenchmarkDashboard";

export function RunBundlePanel({ counts }: { counts: BenchmarkReportCounts }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bundle evidence</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 text-sm sm:grid-cols-3">
        <BundleCount label="Attempts" value={counts.certifiedAttempts} />
        <BundleCount label="Verifiers" value={counts.verifierResults} />
        <BundleCount label="Traces" value={counts.traces} />
      </CardContent>
    </Card>
  );
}

function BundleCount({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
    </div>
  );
}
