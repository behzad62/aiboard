"use client";

import { pct } from "@/components/benchmark/BuildLeaderboardShared";

export function BuildSummaryStrip({
  summary,
}: {
  summary: {
    models: number;
    builds: number;
    attempts: number;
    approvalRate: number | null;
    denials: number;
  };
}) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      <SummaryCard label="Models tracked" value={String(summary.models)} />
      <SummaryCard label="Total builds" value={String(summary.builds)} />
      <SummaryCard label="Task attempts" value={String(summary.attempts)} />
      <SummaryCard label="Approval rate" value={pct(summary.approvalRate)} />
      <SummaryCard label="Provider denials" value={String(summary.denials)} />
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
