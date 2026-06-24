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
        <CardTitle>Failure Categories</CardTitle>
        <CardDescription>
          Provider, parser, rules, tool, verifier, and uncategorized issues.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {dashboard.failureRows.length > 0 ? (
          <div className="h-[280px]">
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
                <Bar dataKey="provider" stackId="failures" fill="#ef4444" />
                <Bar dataKey="parser" stackId="failures" fill="#a78bfa" />
                <Bar dataKey="rules" stackId="failures" fill="#f59e0b" />
                <Bar dataKey="tool" stackId="failures" fill="#38bdf8" />
                <Bar dataKey="verifier" stackId="failures" fill="#22c55e" />
                <Bar dataKey="other" stackId="failures" fill="#64748b" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <EmptyChart label="No categorized failures recorded." />
        )}
      </CardContent>
    </Card>
  );
}
