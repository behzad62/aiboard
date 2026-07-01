"use client";

import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
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
  ChartDataTable,
  EmptyChart,
  modelIdFromChartClick,
} from "@/components/benchmark/chart-utils";

export function FailureCategoriesChart({
  dashboard,
  onSelectModel,
}: {
  dashboard: BenchmarkDashboardData;
  onSelectModel: (modelId: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle id="failure-categories-title">Failure Categories</CardTitle>
        <CardDescription id="failure-categories-description">
          Provider, parser, rules, tool, verifier, and uncategorized issues.
          Select a model from the Scorecards table below.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {dashboard.failureRows.length > 0 ? (
          <div
            className="h-[280px]"
            role="img"
            aria-labelledby="failure-categories-title"
            aria-describedby="failure-categories-description"
          >
            <ResponsiveContainer>
              <BarChart
                data={dashboard.failureRows}
                onClick={(event) => {
                  const modelId = modelIdFromChartClick(event);
                  if (modelId && modelId !== "unknown") onSelectModel(modelId);
                }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="displayName" tick={{ fontSize: 12 }} />
                <YAxis allowDecimals={false} />
                <Tooltip />
                <Legend />
                <Bar dataKey="provider" stackId="failures" fill={CHART_COLORS[4]} />
                <Bar dataKey="parser" stackId="failures" fill={CHART_COLORS[3]} />
                <Bar dataKey="rules" stackId="failures" fill={CHART_COLORS[1]} />
                <Bar dataKey="tool" stackId="failures" fill={CHART_COLORS[0]} />
                <Bar dataKey="verifier" stackId="failures" fill={CHART_COLORS[2]} />
                <Bar dataKey="other" stackId="failures" fill="#64748b" />
              </BarChart>
            </ResponsiveContainer>
            <ChartDataTable
              caption="Failure category data"
              columns={[
                "displayName",
                "provider",
                "parser",
                "rules",
                "tool",
                "verifier",
                "other",
              ]}
              rows={dashboard.failureRows}
            />
          </div>
        ) : (
          <EmptyChart label="No categorized failures recorded." />
        )}
      </CardContent>
    </Card>
  );
}
