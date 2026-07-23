"use client";

import { Fragment, useRef } from "react";
import { ArrowUpDown, Eye } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatNormalizedScore,
  formatScore as formatPointScore,
} from "@/components/benchmark/format";
import { ModelEvidenceProfile } from "./ModelEvidenceProfile";
import {
  SORT_OPTIONS,
  type LeaderboardSortKey,
} from "@/lib/benchmark/certified/dashboard-selectors";
import {
  wilsonInterval,
  type DecisionRow,
} from "@/lib/benchmark/certified/decision-dashboard";

export function DecisionLeaderboard({
  rows,
  totalRows,
  sortKey,
  onSortChange,
  selectedId,
  onSelect,
}: {
  rows: DecisionRow[];
  totalRows: number;
  sortKey: LeaderboardSortKey;
  onSortChange: (key: LeaderboardSortKey) => void;
  selectedId: string | null;
  onSelect: (row: DecisionRow) => void;
}) {
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());

  function closeProfile(row: DecisionRow) {
    onSelect(row);
    requestAnimationFrame(() => triggerRefs.current.get(row.id)?.focus());
  }

  return (
    <Card>
      <CardHeader className="gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Compare
          </p>
          <CardTitle className="mt-1">Model and team leaderboard</CardTitle>
          <p className="mt-1 text-xs text-muted-foreground">
            Showing {rows.length} of {totalRows} results. Missing measurements remain unavailable.
          </p>
        </div>
        <label className="flex min-w-56 items-center gap-2 text-xs font-medium text-muted-foreground">
          <ArrowUpDown className="h-4 w-4" aria-hidden="true" />
          Rank by
          <select
            value={sortKey}
            onChange={(event) => onSortChange(event.target.value as LeaderboardSortKey)}
            className="h-9 flex-1 rounded-md border border-input bg-background px-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
      </CardHeader>
      {rows.length === 0 ? (
        <CardContent className="py-10 text-center text-sm text-muted-foreground">
          No certified results match these filters. Reset a filter or run the missing benchmark track.
        </CardContent>
      ) : (
        <CardContent className="overflow-x-auto px-0 pb-0">
          <table className="w-full min-w-[980px] text-sm">
            <thead>
              <tr className="border-y bg-muted/30 text-left text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                <th className="px-5 py-2.5 font-medium">Model or team</th>
                <th className="px-3 py-2.5 text-right font-medium">
                  {rankMetricLabel(sortKey)}
                </th>
                <th className="px-3 py-2.5 text-right font-medium">Pass · 95% range</th>
                <th className="px-3 py-2.5 font-medium">Coverage</th>
                <th className="px-3 py-2.5 text-right font-medium">Reliability</th>
                <th className="px-3 py-2.5 text-right font-medium">Tokens/pass</th>
                <th className="px-3 py-2.5 text-right font-medium">Time/pass</th>
                <th className="px-5 py-2.5 text-right font-medium">Profile</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const interval = passInterval(row);
                const selected = selectedId === row.id;
                const profileId = evidenceProfileId(row);
                return (
                  <Fragment key={row.id}>
                    <tr
                      className={`border-b ${selected ? "bg-sky-500/[0.06]" : "hover:bg-muted/20"}`}
                    >
                      <td className="px-5 py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{row.label}</span>
                          {row.isTeam && <Badge variant="secondary">Team</Badge>}
                          {row.preliminary && (
                            <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-300">
                              Preliminary
                            </Badge>
                          )}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground">
                          {row.attempts} scored attempt{row.attempts === 1 ? "" : "s"}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-semibold tabular-nums">
                        {formatRankMetric(row, sortKey)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        <div>{formatPercent(row.passRate)}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {interval
                            ? `${formatPercent(interval.lower)}–${formatPercent(interval.upper)}`
                            : "Unavailable"}
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex max-w-56 flex-wrap gap-1">
                          {row.tracks.map((track) => (
                            <span key={track} className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {trackLabel(track)}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {formatPointScore(row.toolReliabilityScore)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {formatCount(row.tokensPerPass)}
                      </td>
                      <td className="px-3 py-3 text-right tabular-nums">
                        {formatDuration(row.speedPerPassMs)}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <Button
                          ref={(node) => {
                            if (node) triggerRefs.current.set(row.id, node);
                            else triggerRefs.current.delete(row.id);
                          }}
                          type="button"
                          size="sm"
                          variant={selected ? "secondary" : "outline"}
                          aria-expanded={selected}
                          aria-controls={profileId}
                          onClick={() => onSelect(row)}
                        >
                          <Eye className="h-4 w-4" aria-hidden="true" />
                          View profile
                        </Button>
                      </td>
                    </tr>
                    {selected && (
                      <tr className="border-b bg-sky-500/[0.025]">
                        <td colSpan={8} className="sticky left-0 p-3">
                          <div className="w-[calc(100vw-3rem)] max-w-[calc(100vw-3rem)] sm:w-[calc(100vw-5rem)] sm:max-w-[calc(100vw-5rem)] xl:w-auto xl:max-w-none">
                            <ModelEvidenceProfile
                              id={profileId}
                              row={row}
                              onClose={() => closeProfile(row)}
                            />
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      )}
    </Card>
  );
}

function evidenceProfileId(row: DecisionRow): string {
  return `benchmark-evidence-${row.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function passInterval(row: DecisionRow) {
  if (row.passRate == null) return null;
  const passed = row.passed ?? Math.round(row.passRate * row.attempts);
  return wilsonInterval(passed, row.attempts);
}

function rankMetricLabel(sortKey: LeaderboardSortKey): string {
  if (sortKey === "quality") return "Verified quality";
  if (sortKey === "overall") return "Overall index";
  if (sortKey === "teamLift") return "Team lift";
  if (sortKey === "costPerPass") return "Cost or tokens/pass";
  if (sortKey === "speedPerPass") return "Time/pass";
  if (sortKey === "toolReliability") return "Reliability";
  return "Efficiency";
}

function formatRankMetric(row: DecisionRow, sortKey: LeaderboardSortKey): string {
  if (sortKey === "quality") return formatQualityScore(row.verifiedQuality);
  if (sortKey === "overall") return formatQualityScore(row.overallScore);
  if (sortKey === "teamLift") return formatSignedPoints(row.teamLift);
  if (sortKey === "costPerPass") {
    if (row.costBasis === "usd" && row.costPerPass != null) {
      return `$${row.costPerPass.toFixed(row.costPerPass < 0.01 ? 4 : 3)}`;
    }
    return row.tokensPerPass == null
      ? "—"
      : `${formatCount(row.tokensPerPass)} tokens`;
  }
  if (sortKey === "speedPerPass") return formatDuration(row.speedPerPassMs);
  if (sortKey === "toolReliability") {
    return row.toolReliabilityScore == null
      ? "—"
      : formatPointScore(row.toolReliabilityScore);
  }
  return row.efficiencyScore == null
    ? "—"
    : formatPointScore(row.efficiencyScore);
}

function formatQualityScore(value: number | null): string {
  return value == null ? "—" : formatNormalizedScore(value);
}

function formatSignedPoints(value: number | null): string {
  if (value == null) return "—";
  return `${value >= 0 ? "+" : ""}${formatPointScore(value)}`;
}

function formatPercent(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function formatCount(value: number | null): string {
  return value == null ? "—" : Math.round(value).toLocaleString();
}

function formatDuration(milliseconds: number | null): string {
  if (milliseconds == null) return "—";
  const seconds = milliseconds / 1000;
  return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
}

function trackLabel(track: string): string {
  if (track === "gameiq") return "GameIQ";
  if (track === "teamiq") return "TeamIQ";
  if (track === "workbench") return "WorkBench";
  if (track === "toolreliability") return "Tool Reliability";
  if (track === "harnessbench") return "HarnessBench";
  return track;
}
