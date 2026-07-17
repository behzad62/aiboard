"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { duration, formatNormalizedScore, usd } from "@/components/benchmark/format";
import { trackLabelFor } from "@/components/benchmark/certified/CertifiedResultTables";
import type { TeamIqComboMatrixRow } from "@/lib/benchmark/teamiq";

// Rows can come from any track that runs team compositions (TeamIQ,
// WorkBench, ...) since the benchmark UX overhaul's team-lift generalization
// (Task 6) — the Track column disambiguates which pack a row's lift number
// was computed against.
export function ComboMatrix({ rows }: { rows: TeamIqComboMatrixRow[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Combo matrix</CardTitle>
          <CardDescription>
            Combo rows appear after team attempts (TeamIQ or WorkBench) and
            complete solo baselines exist for the same case pack.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Combo matrix</CardTitle>
        <CardDescription>
          Team combinations are ranked with verified quality, lift, cost, speed,
          and Pareto status kept visible.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[820px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Team</th>
              <th className="px-3 py-2 text-left font-medium">Track</th>
              <th className="px-3 py-2 text-right font-medium">Attempts</th>
              <th className="px-3 py-2 text-right font-medium">Quality</th>
              <th className="px-3 py-2 text-right font-medium">Team lift</th>
              <th className="px-3 py-2 text-right font-medium">Cost</th>
              <th className="px-3 py-2 text-right font-medium">Speed</th>
              <th className="py-2 pl-3 font-medium">Signal</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 12).map((row) => (
              <tr key={row.id} className="border-b last:border-0">
                <td className="py-3 pr-3">
                  <div className="font-medium">{row.teamName}</div>
                  <div className="mt-0.5 max-w-[22rem] truncate text-xs text-muted-foreground">
                    {row.modelIds.join(" + ")}
                  </div>
                </td>
                <td className="px-3 py-3">
                  <span className="rounded-sm border px-2 py-1 text-xs uppercase tracking-wide text-muted-foreground">
                    {trackLabelFor(row.track)}
                  </span>
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {row.attempts}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {formatNormalizedScore(row.verifiedQuality)}
                </td>
                <td
                  className="px-3 py-3 text-right tabular-nums"
                  title={
                    row.teamLift == null
                      ? "No solo baseline for this pack"
                      : undefined
                  }
                >
                  {formatLift(row.teamLift)}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {usd(row.averageCostUsd)}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {duration(row.averageDurationMs)}
                </td>
                <td className="py-3 pl-3">
                  <span className="rounded-sm border px-2 py-1 text-xs">
                    {label(row.recommendationLabel)}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

export function formatLift(value: number | null): string {
  if (value == null) return "–";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

function label(value: string): string {
  return value.replace(/_/g, " ");
}
