"use client";

import { useMemo } from "react";
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
import type {
  BenchmarkDashboardData,
  BenchmarkModelScore,
} from "@/lib/benchmark/metrics";
import {
  CHART_COLORS,
  CHART_DASHES,
  ChartDataTable,
  EmptyChart,
} from "@/components/benchmark/chart-utils";

// A model needs at least this many samples (games + Build attempts) before it
// earns a place among the radar's confident top-4.
const MIN_CONFIDENT_SAMPLES = 3;

type RadarRow = BenchmarkDashboardData["radarRows"][number];

function sampleCount(model: BenchmarkModelScore): number {
  return model.games + model.buildAttempts;
}

// Name each series with its sample count so the reader can weigh the shape.
function seriesName(model: BenchmarkModelScore): string {
  const n = sampleCount(model);
  const suffix = n < MIN_CONFIDENT_SAMPLES ? " - preliminary" : "";
  return `${model.displayName} (n=${n})${suffix}`;
}

export function CapabilityRadarChart({
  dashboard,
}: {
  dashboard: BenchmarkDashboardData;
}) {
  // Prefer models with enough samples; fall back to de-emphasized low-sample
  // models only when fewer than two confident models exist, so the chart is
  // never left empty when some (weak) evidence is available.
  const displayedModels = useMemo(() => {
    const confident = dashboard.models.filter(
      (model) => sampleCount(model) >= MIN_CONFIDENT_SAMPLES
    );
    if (confident.length >= 2) return confident.slice(0, 4);
    return dashboard.models.slice(0, 4);
  }, [dashboard.models]);

  // Hide axes where every displayed model reads 0 - those are pure clutter
  // (e.g. Tool Use / Cost when nothing exercised them).
  const { visibleRows, hiddenAxes } = useMemo(() => {
    const visible: RadarRow[] = [];
    const hidden: string[] = [];
    for (const row of dashboard.radarRows) {
      const allZero = displayedModels.every(
        (model) => Number(row[model.displayName]) === 0 || row[model.displayName] == null
      );
      if (allZero) hidden.push(String(row.axis));
      else visible.push(row);
    }
    return { visibleRows: visible, hiddenAxes: hidden };
  }, [dashboard.radarRows, displayedModels]);

  const seriesNameByModelId = useMemo(() => {
    const map = new Map<string, string>();
    for (const model of displayedModels) map.set(model.modelId, seriesName(model));
    return map;
  }, [displayedModels]);

  // Re-key the row objects to the annotated series names so the chart, legend,
  // and data table all show n.
  const chartRows = useMemo(
    () =>
      visibleRows.map((row) => {
        const next: { axis: string; [name: string]: number | string } = {
          axis: String(row.axis),
        };
        for (const model of displayedModels) {
          next[seriesName(model)] = Number(row[model.displayName]) || 0;
        }
        return next;
      }),
    [visibleRows, displayedModels]
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle id="capability-profile-title">Capability Profile</CardTitle>
        <CardDescription id="capability-profile-description">
          Multi-axis scorecard. Higher is better on every axis. Each series is
          labeled with its sample size (n).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {displayedModels.length > 0 && chartRows.length > 0 ? (
          <>
            <div
              className="h-[320px]"
              role="img"
              aria-labelledby="capability-profile-title"
              aria-describedby="capability-profile-description"
            >
              <ResponsiveContainer>
                <RadarChart data={chartRows}>
                  <PolarGrid />
                  <PolarAngleAxis dataKey="axis" />
                  <Tooltip />
                  <Legend />
                  {displayedModels.map((model, index) => (
                    <Radar
                      key={model.modelId}
                      name={seriesNameByModelId.get(model.modelId)}
                      dataKey={seriesNameByModelId.get(model.modelId)}
                      stroke={CHART_COLORS[index % CHART_COLORS.length]}
                      strokeDasharray={CHART_DASHES[index % CHART_DASHES.length]}
                      fill={CHART_COLORS[index % CHART_COLORS.length]}
                      fillOpacity={0.16}
                    />
                  ))}
                </RadarChart>
              </ResponsiveContainer>
              <ChartDataTable
                caption="Capability profile data"
                columns={[
                  "axis",
                  ...displayedModels.map((model) => seriesName(model)),
                ]}
                rows={chartRows}
              />
            </div>
            {hiddenAxes.length > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                Hidden (no data for shown models): {hiddenAxes.join(", ")}.
              </p>
            )}
          </>
        ) : (
          <EmptyChart label="Run games or save Build cases to populate profile data." />
        )}
      </CardContent>
    </Card>
  );
}
