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
import {
  CHART_COLORS,
  CHART_DASHES,
  ChartDataTable,
  EmptyChart,
} from "@/components/benchmark/chart-utils";

export function PerformanceTrendChart({
  dashboard,
}: {
  dashboard: BenchmarkDashboardData;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle id="performance-trend-title">Performance Over Time</CardTitle>
        <CardDescription id="performance-trend-description">
          Game and Build evidence grouped by day.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {dashboard.trendRows.length > 0 ? (
          <div
            className="h-[280px]"
            role="img"
            aria-labelledby="performance-trend-title"
            aria-describedby="performance-trend-description"
          >
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
                  stroke={CHART_COLORS[0]}
                  strokeDasharray={CHART_DASHES[0]}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="buildAttempts"
                  name="Build attempts"
                  stroke={CHART_COLORS[1]}
                  strokeDasharray={CHART_DASHES[1]}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="quality"
                  name="Game quality"
                  stroke={CHART_COLORS[2]}
                  strokeDasharray={CHART_DASHES[2]}
                />
              </LineChart>
            </ResponsiveContainer>
            <ChartDataTable
              caption="Performance over time data"
              columns={["date", "games", "buildAttempts", "quality"]}
              rows={dashboard.trendRows}
            />
          </div>
        ) : (
          <EmptyChart label="No dated benchmark evidence yet." />
        )}
      </CardContent>
    </Card>
  );
}
