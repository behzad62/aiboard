"use client";

import {
  Legend,
  PolarAngleAxis,
  PolarGrid,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { BenchmarkDashboardData } from "@/lib/benchmark/metrics";
import { CHART_COLORS, EmptyChart } from "@/components/benchmark/chart-utils";

export function CapabilityRadarChart({
  dashboard,
}: {
  dashboard: BenchmarkDashboardData;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Capability Profile</CardTitle>
        <CardDescription>
          Multi-axis scorecard. Higher is better on every axis.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {dashboard.models.length > 0 ? (
          <div className="h-[320px]">
            <ResponsiveContainer>
              <RadarChart data={dashboard.radarRows}>
                <PolarGrid />
                <PolarAngleAxis dataKey="axis" />
                <Tooltip />
                <Legend />
                {dashboard.models.slice(0, 4).map((model, index) => (
                  <Radar
                    key={model.modelId}
                    name={model.displayName}
                    dataKey={model.displayName}
                    stroke={CHART_COLORS[index % CHART_COLORS.length]}
                    fill={CHART_COLORS[index % CHART_COLORS.length]}
                    fillOpacity={0.16}
                  />
                ))}
              </RadarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <EmptyChart label="Run games or save Build cases to populate profile data." />
        )}
      </CardContent>
    </Card>
  );
}
