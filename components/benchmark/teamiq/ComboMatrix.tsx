"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { duration, formatScore, usd } from "@/components/benchmark/format";
import type { TeamIqComboMatrixRow } from "@/lib/benchmark/teamiq";

export function ComboMatrix({ rows }: { rows: TeamIqComboMatrixRow[] }) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Combo matrix</CardTitle>
          <CardDescription>
            TeamIQ combo rows appear after team attempts and complete solo
            baselines exist for the same case and harness.
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
        <table className="w-full min-w-[760px] text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-medium">Team</th>
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
                <td className="px-3 py-3 text-right tabular-nums">
                  {row.attempts}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {formatScore(row.verifiedQuality)}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
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

function formatLift(value: number | null): string {
  if (value == null) return "n/a";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded > 0 ? "+" : ""}${rounded}`;
}

function label(value: string): string {
  return value.replace(/_/g, " ");
}
