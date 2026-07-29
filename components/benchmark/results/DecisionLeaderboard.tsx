"use client";

import { Fragment, useRef, useState } from "react";
import { ArrowUpDown, ChevronDown, Eye, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatNormalizedScore,
  formatScore as formatPointScore
} from "@/components/benchmark/format";
import { ModelEvidenceProfile } from "./ModelEvidenceProfile";
import {
  SORT_OPTIONS,
  type CertifiedResultHistorySeriesData,
  type LeaderboardSortKey
} from "@/lib/benchmark/certified/dashboard-selectors";
import { wilsonInterval, type DecisionRow } from "@/lib/benchmark/certified/decision-dashboard";
import { VariantRosterBadges } from "./VariantRosterBadges";
import {
  RESULT_HISTORY_PAGE_SIZE,
  ResultHistoryRows,
  encodeIdentity,
  formatCompletion,
  historyRegionId,
} from "./ResultHistoryRows";

export function DecisionLeaderboard({
  rows,
  totalRows,
  sortKey,
  onSortChange,
  history = [],
  selectedResultSetId = null,
  selectedId = null,
  onSelect,
  deletingIds = EMPTY_DELETING_IDS,
  deleteInFlight = false,
  onDelete = () => undefined,
  hasRawEvidence = false,
}: {
  rows: DecisionRow[];
  totalRows: number;
  sortKey: LeaderboardSortKey;
  onSortChange: (key: LeaderboardSortKey) => void;
  history?: CertifiedResultHistorySeriesData[];
  selectedResultSetId?: string | null;
  /** @deprecated Snapshot-aware callers use selectedResultSetId. */
  selectedId?: string | null;
  onSelect: (row: DecisionRow) => void;
  deletingIds?: ReadonlySet<string>;
  deleteInFlight?: boolean;
  onDelete?: (row: DecisionRow) => void;
  hasRawEvidence?: boolean;
}) {
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());
  const [visibleCounts, setVisibleCounts] = useState<Map<string, number>>(
    () => new Map()
  );
  const historyByLatestId = new Map(
    history.map((series) => [series.latestResultSetId, series.older])
  );
  const selectedSnapshotId = selectedResultSetId ?? selectedId;

  function closeProfile(row: DecisionRow, layout: "desktop" | "mobile") {
    onSelect(row);
    requestAnimationFrame(() => triggerRefs.current.get(resultProfileTriggerKey(row, layout))?.focus());
  }

  function registerProfileTrigger(
    row: DecisionRow,
    layout: "desktop" | "mobile",
    node: HTMLButtonElement | null
  ) {
    const key = resultProfileTriggerKey(row, layout);
    if (node) triggerRefs.current.set(key, node);
    else triggerRefs.current.delete(key);
  }

  function toggleHistory(configurationKey: string) {
    setExpandedKeys((current) => {
      const next = new Set(current);
      if (next.has(configurationKey)) next.delete(configurationKey);
      else next.add(configurationKey);
      return next;
    });
  }

  function showMore(configurationKey: string) {
    setVisibleCounts((current) => {
      const next = new Map(current);
      next.set(
        configurationKey,
        (next.get(configurationKey) ?? RESULT_HISTORY_PAGE_SIZE) +
          RESULT_HISTORY_PAGE_SIZE
      );
      return next;
    });
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
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Only fully completed benchmark snapshots appear here. Expand a row to compare older runs of the same configuration.
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
          {hasRawEvidence
            ? "Benchmark evidence is stored, but no fully completed snapshot qualifies for Results. Open Data to inspect incomplete runs."
            : "No certified results match these filters. Reset a filter or run the missing benchmark track."}
        </CardContent>
      ) : (
        <CardContent className="px-0 pb-0">
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full min-w-[980px] text-sm">
              <thead>
                <tr className="border-y bg-muted/30 text-left text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                  <th className="px-5 py-2.5 font-medium">Model or team</th>
                  <th className="px-3 py-2.5 text-right font-medium">{rankMetricLabel(sortKey)}</th>
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
                  const selected = selectedSnapshotId === rowIdentity(row);
                  const profileId = evidenceProfileId(row, "desktop");
                  const older = historyByLatestId.get(rowIdentity(row)) ?? [];
                  const expanded = expandedKeys.has(row.configurationKey);
                  const visibleCount =
                    visibleCounts.get(row.configurationKey) ??
                    RESULT_HISTORY_PAGE_SIZE;
                  return (
                    <Fragment key={rowIdentity(row)}>
                      <tr
                        className={`border-b ${selected ? "bg-sky-500/[0.06]" : "hover:bg-muted/20"}`}
                      >
                        <td className="px-5 py-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold">{row.label}</span>
                            {row.isTeam && <Badge variant="secondary">Team</Badge>}
                            {row.preliminary && (
                              <Badge
                                variant="outline"
                                className="border-amber-500/40 text-amber-700 dark:text-amber-300"
                              >
                                Preliminary
                              </Badge>
                            )}
                          </div>
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {row.attempts} scored attempt
                            {row.attempts === 1 ? "" : "s"}
                          </div>
                          {row.configurationDetails && (
                            <p className="mt-0.5 max-w-xl break-words text-[11px] leading-snug text-muted-foreground">
                              {row.configurationDetails}
                            </p>
                          )}
                          <div className="mt-0.5 text-xs text-muted-foreground">
                            {formatCompletion(row.completedAt)}
                          </div>
                          <div className="mt-1 flex flex-wrap gap-2">
                            <SignedDelta metric="Overall" value={row.overallDelta} />
                            <SignedDelta metric="Pass" value={row.passRateDelta} percentagePoints />
                            {older.length > 0 && (
                              <HistoryToggle
                                row={row}
                                layout="desktop"
                                count={older.length + 1}
                                expanded={expanded}
                                onClick={() => toggleHistory(row.configurationKey)}
                              />
                            )}
                          </div>
                          {row.isTeam && (
                            <div className="mt-1">
                              <VariantRosterBadges details={row.reasoningEffortDetails} />
                            </div>
                          )}
                          <FailureEvidenceNotice row={row} />
                        </td>
                        <td className="px-3 py-3 text-right font-semibold tabular-nums">
                          {formatRankMetric(row, sortKey)}
                          {sortKey === "teamLift" && isTeamLiftUnavailable(row) && (
                            <div className="mt-0.5 max-w-44 text-[11px] font-normal leading-snug text-muted-foreground">
                              Run the same track solo and as a team.
                            </div>
                          )}
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
                              <span
                                key={track}
                                className="rounded-sm bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                              >
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
                            ref={(node) => registerProfileTrigger(row, "desktop", node)}
                            type="button"
                            size="sm"
                            variant={selected ? "secondary" : "outline"}
                            aria-expanded={selected}
                            aria-controls={profileId}
                            data-result-set-id={row.resultSetId}
                            onClick={() => onSelect(row)}
                          >
                            <Eye className="h-4 w-4" aria-hidden="true" />
                            View profile
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="ml-1"
                            disabled={deleteInFlight || deletingIds.has(rowIdentity(row))}
                            data-focus-return={`desktop:${row.configurationKey}`}
                            data-result-set-id={row.resultSetId}
                            onClick={() => onDelete(row)}
                            aria-label="Delete snapshot"
                          >
                            <Trash2 className="h-4 w-4" aria-hidden="true" />
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
                                onClose={() => closeProfile(row, "desktop")}
                              />
                            </div>
                          </td>
                        </tr>
                      )}
                      <ResultHistoryRows
                        layout="desktop"
                        latest={row}
                        older={older}
                        expanded={expanded}
                        visibleCount={visibleCount}
                        selectedResultSetId={selectedSnapshotId}
                        deletingIds={deletingIds}
                        deleteInFlight={deleteInFlight}
                        onShowMore={() => showMore(row.configurationKey)}
                        onSelectProfile={(historyRow) => onSelect(historyRow)}
                        onDelete={onDelete}
                        onCloseProfile={closeProfile}
                        registerProfileTrigger={registerProfileTrigger}
                      />
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="md:hidden">
            {rows.map((row) => {
              const interval = passInterval(row);
              const selected = selectedSnapshotId === rowIdentity(row);
              const profileId = evidenceProfileId(row, "mobile");
              const older = historyByLatestId.get(rowIdentity(row)) ?? [];
              const expanded = expandedKeys.has(row.configurationKey);
              const visibleCount =
                visibleCounts.get(row.configurationKey) ??
                RESULT_HISTORY_PAGE_SIZE;
              return (
                <Fragment key={rowIdentity(row)}>
                  <li className={`border-t px-4 py-4 ${selected ? "bg-sky-500/[0.06]" : ""}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="break-words text-base font-semibold">{row.label}</h3>
                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Badge>{row.isTeam ? "Team" : "Solo"}</Badge>
                          {row.preliminary && (
                            <Badge
                              variant="outline"
                              className="border-amber-500/40 text-amber-700 dark:text-amber-300"
                            >
                              Preliminary
                            </Badge>
                          )}
                        </div>
                      </div>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {row.attempts} attempt{row.attempts === 1 ? "" : "s"}
                      </span>
                    </div>
                    {row.isTeam && (
                      <div className="mt-2">
                        <VariantRosterBadges details={row.reasoningEffortDetails} />
                      </div>
                    )}
                    {row.configurationDetails && (
                      <p className="mt-2 break-words text-[11px] leading-snug text-muted-foreground">
                        {row.configurationDetails}
                      </p>
                    )}
                    <FailureEvidenceNotice row={row} />
                    <div className="mt-2 text-xs text-muted-foreground">
                      {formatCompletion(row.completedAt)}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      <SignedDelta metric="Overall" value={row.overallDelta} />
                      <SignedDelta metric="Pass" value={row.passRateDelta} percentagePoints />
                      {older.length > 0 && (
                        <HistoryToggle
                          row={row}
                          layout="mobile"
                          count={older.length + 1}
                          expanded={expanded}
                          onClick={() => toggleHistory(row.configurationKey)}
                        />
                      )}
                    </div>
                    <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3">
                      <MobileMetric
                        label="Overall index"
                        value={formatQualityScore(row.overallScore)}
                      />
                      <MobileMetric
                        label={"Pass \u00b7 95% range"}
                        value={formatPercent(row.passRate)}
                        detail={
                          interval
                            ? `${formatPercent(interval.lower)}\u2013${formatPercent(interval.upper)}`
                            : "Unavailable"
                        }
                      />
                      <MobileMetric
                        label="Coverage"
                        value={
                          row.tracks.length > 0
                            ? row.tracks.map(trackLabel).join(", ")
                            : "Unavailable"
                        }
                      />
                      <MobileMetric
                        label="Reliability"
                        value={formatPointScore(row.toolReliabilityScore)}
                      />
                      <MobileMetric label="Tokens/pass" value={formatCount(row.tokensPerPass)} />
                      <MobileMetric label="Time/pass" value={formatDuration(row.speedPerPassMs)} />
                      {row.isTeam && (
                        <MobileMetric
                          label="Team lift"
                          value={
                            isTeamLiftUnavailable(row)
                              ? "Not comparable"
                              : formatSignedPoints(row.teamLift)
                          }
                          detail={
                            isTeamLiftUnavailable(row)
                              ? "Run the same track solo and as a team."
                              : row.teamLiftTracks.map(trackLabel).join(", ")
                          }
                        />
                      )}
                    </dl>
                    <div className="mt-4 flex justify-end">
                      <Button
                        ref={(node) => registerProfileTrigger(row, "mobile", node)}
                        type="button"
                        size="sm"
                        variant={selected ? "secondary" : "outline"}
                        aria-expanded={selected}
                        aria-controls={profileId}
                        data-result-set-id={row.resultSetId}
                        onClick={() => onSelect(row)}
                      >
                        <Eye className="h-4 w-4" aria-hidden="true" />
                        View profile
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={deleteInFlight || deletingIds.has(rowIdentity(row))}
                        data-focus-return={`mobile:${row.configurationKey}`}
                        data-result-set-id={row.resultSetId}
                        onClick={() => onDelete(row)}
                        aria-label="Delete snapshot"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </li>
                  {selected && (
                    <li className="border-t bg-sky-500/[0.025] p-3">
                      <ModelEvidenceProfile
                        id={profileId}
                        row={row}
                        onClose={() => closeProfile(row, "mobile")}
                      />
                    </li>
                  )}
                  <ResultHistoryRows
                    layout="mobile"
                    latest={row}
                    older={older}
                    expanded={expanded}
                    visibleCount={visibleCount}
                    selectedResultSetId={selectedSnapshotId}
                    deletingIds={deletingIds}
                    deleteInFlight={deleteInFlight}
                    onShowMore={() => showMore(row.configurationKey)}
                    onSelectProfile={(historyRow) => onSelect(historyRow)}
                    onDelete={onDelete}
                    onCloseProfile={closeProfile}
                    registerProfileTrigger={registerProfileTrigger}
                  />
                </Fragment>
              );
            })}
          </ul>
        </CardContent>
      )}
    </Card>
  );
}

function evidenceProfileId(row: DecisionRow, layout: "desktop" | "mobile"): string {
  return `benchmark-evidence-${layout}-${encodeIdentity(rowIdentity(row))}`;
}

const EMPTY_DELETING_IDS: ReadonlySet<string> = new Set();

export function resultProfileTriggerKey(
  row: DecisionRow,
  layout: "desktop" | "mobile"
): string {
  return `${layout}:${rowIdentity(row)}`;
}

function rowIdentity(row: DecisionRow): string {
  return row.resultSetId || row.id;
}

function HistoryToggle({
  row,
  layout,
  count,
  expanded,
  onClick,
}: {
  row: DecisionRow;
  layout: "desktop" | "mobile";
  count: number;
  expanded: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={historyRegionId(row.configurationKey, layout)}
      data-focus-return={`${layout}:${row.configurationKey}`}
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-sky-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring dark:text-sky-300"
    >
      <ChevronDown
        className={`h-3.5 w-3.5 motion-reduce:transition-none ${
          expanded ? "rotate-180" : ""
        }`}
        aria-hidden="true"
      />
      {count} runs
    </button>
  );
}

function SignedDelta({
  metric,
  value,
  percentagePoints = false,
}: {
  metric: "Overall" | "Pass";
  value: number | null;
  percentagePoints?: boolean;
}) {
  if (value == null) return null;
  const scaled = percentagePoints ? value * 100 : value * 100;
  const rounded = Math.round(scaled);
  const direction = rounded > 0 ? "higher" : rounded < 0 ? "lower" : "unchanged";
  const sign = rounded > 0 ? "+" : "";
  return (
    <span
      aria-label={`${metric} ${direction} by ${Math.abs(rounded)}${
        percentagePoints ? " percentage points" : " points"
      } versus the previous completed run`}
      className={`text-[11px] font-medium tabular-nums ${
        rounded > 0
          ? "text-emerald-700 dark:text-emerald-300"
          : rounded < 0
            ? "text-rose-700 dark:text-rose-300"
            : "text-muted-foreground"
      }`}
    >
      {metric} {sign}{rounded}{percentagePoints ? " pp" : ""}
    </span>
  );
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
  if (sortKey === "teamLift") {
    return isTeamLiftUnavailable(row) ? "Not comparable" : formatSignedPoints(row.teamLift);
  }
  if (sortKey === "costPerPass") {
    if (row.costBasis === "usd" && row.costPerPass != null) {
      return `$${row.costPerPass.toFixed(row.costPerPass < 0.01 ? 4 : 3)}`;
    }
    return row.tokensPerPass == null ? "—" : `${formatCount(row.tokensPerPass)} tokens`;
  }
  if (sortKey === "speedPerPass") return formatDuration(row.speedPerPassMs);
  if (sortKey === "toolReliability") {
    return row.toolReliabilityScore == null ? "—" : formatPointScore(row.toolReliabilityScore);
  }
  return row.efficiencyScore == null ? "—" : formatPointScore(row.efficiencyScore);
}

function isTeamLiftUnavailable(row: DecisionRow): boolean {
  return row.isTeam && (row.teamLift == null || row.teamLiftTracks.length === 0);
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

function MobileMetric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-0.5 break-words text-sm font-semibold tabular-nums">{value}</dd>
      {detail && (
        <dd className="mt-0.5 break-words text-[11px] leading-snug text-muted-foreground">
          {detail}
        </dd>
      )}
    </div>
  );
}

function FailureEvidenceNotice({ row }: { row: DecisionRow }) {
  const groups = failureEvidenceGroups(row);
  if (groups.length === 0) return null;

  return (
    <aside className="mt-2 border-l-2 border-red-500/50 bg-red-500/[0.04] px-2.5 py-2 text-left">
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-red-700 dark:text-red-300">
        Failure evidence
      </div>
      {groups.map((group) => (
        <div key={group.track} className="mt-1 text-xs leading-snug text-muted-foreground">
          <span className="font-medium text-foreground">{trackLabel(group.track)}:</span>{" "}
          {group.messages.join(" ")}
        </div>
      ))}
    </aside>
  );
}

function failureEvidenceGroups(row: DecisionRow): Array<{ track: string; messages: string[] }> {
  const messagesByTrack = new Map<string, Set<string>>();
  for (const detail of row.failureDetails) {
    const message = detail.message.trim();
    if (!message) continue;
    const messages = messagesByTrack.get(detail.track) ?? new Set<string>();
    messages.add(message);
    messagesByTrack.set(detail.track, messages);
  }
  const hasPersistedBudgetMessage = row.failureDetails.some(
    (detail) =>
      detail.status === "failed_budget" &&
      detail.message.trim().length > 0 &&
      (!row.latestAttemptId || detail.attemptId === row.latestAttemptId)
  );
  if (row.latestAttemptStatus === "failed_budget" && !hasPersistedBudgetMessage) {
    const track = row.latestAttemptTrack ?? row.tracks[0] ?? "unknown";
    const messages = messagesByTrack.get(track) ?? new Set<string>();
    messages.add("Certified budget exhausted before this track completed.");
    messagesByTrack.set(track, messages);
  }
  return Array.from(messagesByTrack, ([track, messages]) => ({
    track,
    messages: Array.from(messages)
  }));
}
