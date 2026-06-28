"use client";

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { BenchmarkDashboardData } from "@/lib/benchmark/metrics";
import { EmptyChart } from "@/components/benchmark/chart-utils";

export function PerformanceTrendChart({
  dashboard,
}: {
  dashboard: BenchmarkDashboardData;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Performance Over Time</CardTitle>
        <CardDescription>Game and Build evidence grouped by day.</CardDescription>
      </CardHeader>
      <CardContent>
        {dashboard.trendRows.length > 0 ? (
          <div className="h-[280px]">
            <ResponsiveContainer>
              <LineChart data={dashboard.trendRows}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" />
                <YAxis yAxisId="left" />
                <YAxis yAxisId="right" orientation="right" domain={[0, 100]} />
                <Tooltip />
                <Legend />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="games"
                  name="Games"
                  stroke="#38bdf8"
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="buildAttempts"
                  name="Build attempts"
                  stroke="#f59e0b"
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="quality"
                  name="Architect-reviewed quality"
                  stroke="#22c55e"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <EmptyChart label="No dated benchmark evidence yet." />
        )}
      </CardContent>
    </Card>
  );
}
