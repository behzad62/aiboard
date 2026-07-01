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
  CHART_COLORS,
  EmptyChart,
  moveSuccessRate,
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
          Win, legality, schema, move success, and verifier signals by model.
          Select a model from the Scorecards table below.
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
                <Bar dataKey="winRate" name="Win" fill={CHART_COLORS[2]} />
                <Bar dataKey="legalActionRate" name="Legal" fill={CHART_COLORS[5]} />
                <Bar dataKey="schemaValidRate" name="Schema" fill={CHART_COLORS[3]} />
                <Bar
                  dataKey={(row) => moveSuccessRate(row.fallbackRate)}
                  name="Move success"
                  fill={CHART_COLORS[1]}
                />
                <Bar dataKey="verifierPassRate" name="Verifier" fill={CHART_COLORS[4]} />
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
