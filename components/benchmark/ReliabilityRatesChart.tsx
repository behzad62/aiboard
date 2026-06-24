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
import { compactPct } from "@/components/benchmark/format";
import type { BenchmarkDashboardData } from "@/lib/benchmark/metrics";
import {
  EmptyChart,
  modelIdFromChartClick,
} from "@/components/benchmark/chart-utils";

export function ReliabilityRatesChart({
  dashboard,
  onSelectModel,
}: {
  dashboard: BenchmarkDashboardData;
  onSelectModel: (modelId: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Reliability Rates</CardTitle>
        <CardDescription>
          Win, legality, schema, fallback, and verifier signals by model.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {dashboard.rateBars.length > 0 ? (
          <div className="h-[320px]">
            <ResponsiveContainer>
              <BarChart
                data={dashboard.rateBars}
                onClick={(event) => {
                  const modelId = modelIdFromChartClick(event);
                  if (modelId) onSelectModel(modelId);
                }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="displayName" tick={{ fontSize: 12 }} />
                <YAxis tickFormatter={compactPct} domain={[0, 100]} />
                <Tooltip formatter={(value) => `${value}%`} />
                <Legend />
                <Bar dataKey="winRate" name="Win" fill="#22c55e" />
                <Bar dataKey="legalActionRate" name="Legal" fill="#38bdf8" />
                <Bar dataKey="schemaValidRate" name="Schema" fill="#a78bfa" />
                <Bar dataKey="fallbackRate" name="Fallback" fill="#f59e0b" />
                <Bar dataKey="verifierPassRate" name="Verifier" fill="#ef4444" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <EmptyChart label="No model rates available yet." />
        )}
      </CardContent>
    </Card>
  );
}
