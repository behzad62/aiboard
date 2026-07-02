"use client";

import type { TooltipContentProps } from "recharts";
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
  // Total attempts per model gives the failure counts context: "318 rules"
  // means little without knowing how many attempts it is out of.
  const attemptsByDisplayName = new Map<string, number>();
  for (const model of dashboard.models) {
    attemptsByDisplayName.set(
      model.displayName,
      model.games + model.buildAttempts
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle id="failure-categories-title">Failure Categories</CardTitle>
        <CardDescription id="failure-categories-description">
          Provider, parser, rules, tool, verifier, and uncategorized issues.
          Hover a bar to see the model&apos;s total attempts. Select a model from
          the Scorecards table below.
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
                <Tooltip
                  content={(props) => (
                    <FailureTooltip
                      active={props.active}
                      payload={props.payload as FailureTooltipPayload}
                      label={props.label}
                      attemptsByDisplayName={attemptsByDisplayName}
                    />
                  )}
                />
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

type FailureTooltipPayload = TooltipContentProps<number, string>["payload"];

function FailureTooltip({
  active,
  payload,
  label,
  attemptsByDisplayName,
}: {
  active?: boolean;
  payload?: FailureTooltipPayload;
  label?: string | number;
  attemptsByDisplayName: Map<string, number>;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const displayName = String(label ?? "");
  const totalAttempts = attemptsByDisplayName.get(displayName);
  const totalFailures = payload.reduce(
    (sum: number, item) =>
      sum + (typeof item.value === "number" ? item.value : 0),
    0
  );

  return (
    <div className="rounded-md border bg-background px-3 py-2 text-xs shadow-sm">
      <div className="font-medium">{displayName}</div>
      <div className="mt-1 text-muted-foreground">
        {totalFailures} failure{totalFailures === 1 ? "" : "s"}
        {totalAttempts != null
          ? ` across ${totalAttempts} attempt${totalAttempts === 1 ? "" : "s"}`
          : ""}
      </div>
      <div className="mt-1 space-y-0.5">
        {payload
          .filter((item) => typeof item.value === "number" && item.value > 0)
          .map((item) => (
            <div key={String(item.dataKey)} className="flex items-center gap-2">
              <span
                className="inline-block h-2 w-2 rounded-sm"
                style={{ backgroundColor: item.color }}
                aria-hidden="true"
              />
              <span className="capitalize">{String(item.name ?? item.dataKey)}</span>
              <span className="ml-auto tabular-nums">{item.value}</span>
            </div>
          ))}
      </div>
    </div>
  );
}
