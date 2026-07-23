"use client";

import {
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CHART_COLORS, EmptyChart } from "@/components/benchmark/chart-utils";
import type { DecisionRow } from "@/lib/benchmark/certified/decision-dashboard";

interface TradeoffPoint {
  id: string;
  label: string;
  quality: number;
  x: number;
  attempts: number;
}

export function DecisionTradeoffCharts({ rows }: { rows: DecisionRow[] }) {
  const tokenPoints = project(rows, "tokens");
  const timePoints = project(rows, "time");
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <TradeoffChart
        title="Quality vs tokens per successful case"
        description="Closer to the upper-left means stronger verified quality with less token use."
        points={tokenPoints}
        xLabel="Tokens per pass"
        formatX={(value) => Math.round(value).toLocaleString()}
        empty="No successful results include token measurements."
      />
      <TradeoffChart
        title="Quality vs time per successful case"
        description="Closer to the upper-left means stronger verified quality with less elapsed time."
        points={timePoints}
        xLabel="Seconds per pass"
        formatX={(value) => `${value.toFixed(value >= 10 ? 0 : 1)}s`}
        empty="No successful results include timing measurements."
      />
    </div>
  );
}

function TradeoffChart({
  title,
  description,
  points,
  xLabel,
  formatX,
  empty,
}: {
  title: string;
  description: string;
  points: TradeoffPoint[];
  xLabel: string;
  formatX: (value: number) => string;
  empty: string;
}) {
  const id = title.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-");
  return (
    <Card>
      <CardHeader>
        <CardTitle id={`${id}-title`} className="text-base">{title}</CardTitle>
        <p id={`${id}-description`} className="text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      </CardHeader>
      <CardContent>
        {points.length > 0 ? (
          <>
            <div
              className="h-72"
              role="img"
              aria-labelledby={`${id}-title`}
              aria-describedby={`${id}-description`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 8, right: 12, bottom: 12, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" opacity={0.35} />
                  <XAxis
                    dataKey="x"
                    type="number"
                    name={xLabel}
                    tickFormatter={(value) => formatX(Number(value))}
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis
                    dataKey="quality"
                    type="number"
                    name="Verified quality"
                    domain={[0, 100]}
                    tickFormatter={(value) => `${value}`}
                    tick={{ fontSize: 11 }}
                    width={34}
                  />
                  <Tooltip
                    cursor={{ strokeDasharray: "3 3" }}
                    formatter={(value, name) => {
                      const numeric = Number(value);
                      return name === "Verified quality"
                        ? [`${numeric.toFixed(1)}`, name]
                        : [formatX(numeric), xLabel];
                    }}
                    labelFormatter={(_, payload) =>
                      payload?.[0]?.payload?.label ?? "Result"
                    }
                  />
                  <Scatter name={title} data={points}>
                    {points.map((point, index) => (
                      <Cell
                        key={point.id}
                        fill={CHART_COLORS[index % CHART_COLORS.length]}
                      />
                    ))}
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <details className="mt-2 rounded-md border bg-muted/20">
              <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-muted-foreground">
                Accessible data
              </summary>
              <div className="overflow-x-auto border-t">
                <table className="w-full min-w-96 text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground">
                      <th className="px-3 py-2 font-medium">Model or team</th>
                      <th className="px-3 py-2 text-right font-medium">Quality</th>
                      <th className="px-3 py-2 text-right font-medium">{xLabel}</th>
                      <th className="px-3 py-2 text-right font-medium">Attempts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {points.map((point) => (
                      <tr key={point.id} className="border-t">
                        <td className="px-3 py-2">{point.label}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{point.quality.toFixed(1)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatX(point.x)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{point.attempts}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        ) : (
          <EmptyChart label={empty} />
        )}
      </CardContent>
    </Card>
  );
}

function project(
  rows: DecisionRow[],
  metric: "tokens" | "time"
): TradeoffPoint[] {
  return rows.flatMap((row) => {
    const quality = row.overallScore ?? row.verifiedQuality;
    const measured = metric === "tokens" ? row.tokensPerPass : row.speedPerPassMs;
    if (quality == null || measured == null || measured < 0) return [];
    return [
      {
        id: row.id,
        label: row.label,
        quality: quality * 100,
        x: metric === "time" ? measured / 1000 : measured,
        attempts: row.attempts,
      },
    ];
  });
}
