"use client";

import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type {
  ScatterShapeProps,
  TooltipContentProps,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  chartColorForIdentity,
  EmptyChart,
} from "@/components/benchmark/chart-utils";
import type { DecisionRow } from "@/lib/benchmark/certified/decision-dashboard";
import {
  VariantRosterBadges,
  variantRosterText,
} from "./VariantRosterBadges";

export interface TradeoffPoint {
  id: string;
  label: string;
  kind: "Solo model" | "Team";
  tracks: string[];
  quality: number;
  x: number;
  attempts: number;
  color: string;
  reasoningEffortDetails: DecisionRow["reasoningEffortDetails"];
}

export function DecisionTradeoffCharts({ rows }: { rows: DecisionRow[] }) {
  const tokenPoints = projectDecisionTradeoffPoints(rows, "tokens");
  const timePoints = projectDecisionTradeoffPoints(rows, "time");
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <TradeoffChart
        title="Overall index vs tokens per successful case"
        description="Closer to the upper-left means a stronger cross-track overall index with less token use."
        points={tokenPoints}
        xLabel="Tokens per successful case"
        formatX={(value) => Math.round(value).toLocaleString()}
        empty="No successful results include token measurements."
      />
      <TradeoffChart
        title="Overall index vs time per successful case"
        description="Closer to the upper-left means a stronger cross-track overall index with less elapsed time."
        points={timePoints}
        xLabel="Time per successful case"
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
            <ul
              className="mb-3 flex flex-wrap gap-x-4 gap-y-2 text-xs"
              aria-label={`${title} legend`}
            >
              {points.map((point) => (
                <li key={point.id} className="flex min-w-0 items-center gap-2">
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full border border-border"
                    style={{ backgroundColor: point.color }}
                    aria-hidden="true"
                  />
                  <span className="truncate font-medium">
                    {decisionTradeoffPointLabel(point)}
                  </span>
                  <span className="text-muted-foreground">{point.kind}</span>
                </li>
              ))}
            </ul>
            <div
              className="h-72"
              role="img"
              aria-labelledby={`${id}-title`}
              aria-describedby={`${id}-description`}
            >
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 8, right: 12, bottom: 12, left: 0 }}>
                  <CartesianGrid
                    stroke="var(--border)"
                    strokeDasharray="3 3"
                  />
                  <XAxis
                    dataKey="x"
                    type="number"
                    name={xLabel}
                    tickFormatter={(value) => formatX(Number(value))}
                    tick={{
                      fill: "var(--muted-foreground)",
                      fontSize: 12,
                    }}
                  />
                  <YAxis
                    dataKey="quality"
                    type="number"
                    name="Overall index"
                    domain={[0, 100]}
                    tickFormatter={(value) => `${value}`}
                    tick={{
                      fill: "var(--muted-foreground)",
                      fontSize: 12,
                    }}
                    width={34}
                  />
                  <Tooltip
                    cursor={{ strokeDasharray: "3 3" }}
                    content={(props) => (
                      <DecisionTradeoffTooltip
                        active={props.active}
                        payload={props.payload as TradeoffTooltipPayload}
                        xLabel={xLabel}
                        formatX={formatX}
                      />
                    )}
                  />
                  <Scatter
                    name={title}
                    data={points}
                    shape={(props: ScatterShapeProps) => (
                      <DecisionTradeoffPointShape
                        cx={props.cx}
                        cy={props.cy}
                        payload={props.payload as TradeoffPoint | undefined}
                        xLabel={xLabel}
                        formatX={formatX}
                      />
                    )}
                  />
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
                      <th className="px-3 py-2 text-right font-medium">Overall index</th>
                      <th className="px-3 py-2 text-right font-medium">{xLabel}</th>
                      <th className="px-3 py-2 text-right font-medium">Attempts</th>
                    </tr>
                  </thead>
                  <tbody>
                    {points.map((point) => (
                      <tr key={point.id} className="border-t">
                        <td className="px-3 py-2">
                          <div>{point.label}</div>
                          <div className="text-muted-foreground">
                            {point.kind} · {formatTrackNames(point.tracks)}
                          </div>
                          <VariantRosterBadges
                            details={point.reasoningEffortDetails}
                          />
                        </td>
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

export function decisionTradeoffPointLabel(point: {
  label: string;
  reasoningEffortDetails: DecisionRow["reasoningEffortDetails"];
}): string {
  const roster = variantRosterText(point.reasoningEffortDetails);
  return roster ? `${point.label} — ${roster}` : point.label;
}

export function projectDecisionTradeoffPoints(
  rows: DecisionRow[],
  basis: "tokens" | "time"
): TradeoffPoint[] {
  return rows.flatMap((row) => {
    const quality = row.overallScore ?? row.verifiedQuality;
    const measured =
      basis === "tokens" ? row.tokensPerPass : row.speedPerPassMs;
    if (quality == null || measured == null || measured < 0) return [];
    return [
      {
        id: row.id,
        label: row.label,
        kind: row.isTeam ? "Team" : "Solo model",
        tracks: row.tracks,
        quality: quality * 100,
        x: basis === "time" ? measured / 1000 : measured,
        attempts: row.attempts,
        color: chartColorForIdentity(row.id),
        reasoningEffortDetails: row.reasoningEffortDetails,
      },
    ];
  });
}

export function decisionTradeoffPointAriaLabel(
  point: TradeoffPoint,
  xLabel: string,
  formatX: (value: number) => string
): string {
  return [
    decisionTradeoffPointLabel(point),
    point.kind,
    `Tracks: ${formatTrackNames(point.tracks)}`,
    `Overall index: ${point.quality.toFixed(1)}`,
    `${xLabel}: ${formatX(point.x)}`,
    `Attempts: ${point.attempts}`,
  ].join(". ");
}

export function DecisionTradeoffPointShape({
  cx,
  cy,
  payload,
  xLabel,
  formatX,
}: {
  cx?: number;
  cy?: number;
  payload?: TradeoffPoint;
  xLabel: string;
  formatX: (value: number) => string;
}) {
  if (cx == null || cy == null || !payload) return null;
  return (
    <circle
      cx={cx}
      cy={cy}
      r={5}
      fill={payload.color}
      stroke="var(--background)"
      strokeWidth={1.5}
      tabIndex={0}
      role="img"
      aria-label={decisionTradeoffPointAriaLabel(payload, xLabel, formatX)}
      className="outline-none focus-visible:stroke-ring focus-visible:stroke-[3px]"
    />
  );
}

type TradeoffTooltipPayload = TooltipContentProps<
  number,
  string
>["payload"];

function DecisionTradeoffTooltip({
  active,
  payload,
  xLabel,
  formatX,
}: {
  active?: boolean;
  payload?: TradeoffTooltipPayload;
  xLabel: string;
  formatX: (value: number) => string;
}) {
  const point = payload?.[0]?.payload as TradeoffPoint | undefined;
  if (!active || !point) return null;
  return (
    <div className="max-w-80 rounded-md border bg-background px-3 py-2 text-xs shadow-sm">
      <div className="font-medium">{decisionTradeoffPointLabel(point)}</div>
      <div className="mt-1 text-muted-foreground">
        {point.kind} · {formatTrackNames(point.tracks)}
      </div>
      <dl className="mt-2 grid grid-cols-[auto_auto] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">Overall index</dt>
        <dd className="text-right tabular-nums">{point.quality.toFixed(1)}</dd>
        <dt className="text-muted-foreground">{xLabel}</dt>
        <dd className="text-right tabular-nums">{formatX(point.x)}</dd>
        <dt className="text-muted-foreground">Attempts</dt>
        <dd className="text-right tabular-nums">{point.attempts}</dd>
      </dl>
    </div>
  );
}

const TRACK_LABELS: Record<string, string> = {
  gameiq: "GameIQ",
  harnessbench: "HarnessBench",
  teamiq: "TeamIQ",
  toolreliability: "Tool Reliability",
  workbench: "WorkBench",
};

function formatTrackNames(tracks: string[]): string {
  return tracks.map((track) => TRACK_LABELS[track] ?? track).join(", ");
}
