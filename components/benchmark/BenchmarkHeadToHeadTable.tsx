"use client";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { BenchmarkDashboardData } from "@/lib/benchmark/metrics";

export function BenchmarkHeadToHeadTable({
  rows,
}: {
  rows: BenchmarkDashboardData["headToHeadRows"];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Model vs Model Outcomes</CardTitle>
        <CardDescription>
          Head-to-head game outcomes. Use mirrored roles before treating these as
          stable ratings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="py-2 text-left">Model A</th>
                  <th className="py-2 text-left">Model B</th>
                  <th className="py-2 text-right">A wins</th>
                  <th className="py-2 text-right">B wins</th>
                  <th className="py-2 text-right">Draws</th>
                  <th className="py-2 text-right">Games</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.modelA}:${row.modelB}`} className="border-b">
                    <td className="py-2">{row.modelADisplay}</td>
                    <td className="py-2">{row.modelBDisplay}</td>
                    <td className="py-2 text-right">{row.modelAWins}</td>
                    <td className="py-2 text-right">{row.modelBWins}</td>
                    <td className="py-2 text-right">{row.draws}</td>
                    <td className="py-2 text-right">{row.games}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            No head-to-head game outcomes recorded yet.
          </div>
        )}
      </CardContent>
    </Card>
  );
}
