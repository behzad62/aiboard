"use client";

import { Fragment } from "react";
import { Eye, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatNormalizedScore } from "@/components/benchmark/format";
import type { DecisionRow } from "@/lib/benchmark/certified/decision-dashboard";
import { ModelEvidenceProfile } from "./ModelEvidenceProfile";

export const RESULT_HISTORY_PAGE_SIZE = 5;

export function visibleHistoryRows(
  older: readonly DecisionRow[],
  visibleCount: number
): DecisionRow[] {
  return older.slice(0, Math.max(0, visibleCount));
}

export function historyRegionId(
  configurationKey: string,
  layout: "desktop" | "mobile"
): string {
  return `benchmark-history-${layout}-${encodeIdentity(configurationKey)}`;
}

export function ResultHistoryRows({
  layout,
  latest,
  older,
  expanded,
  visibleCount,
  selectedResultSetId,
  deletingIds,
  deleteInFlight,
  onShowMore,
  onSelectProfile,
  onDelete,
  onCloseProfile,
  registerProfileTrigger,
}: {
  layout: "desktop" | "mobile";
  latest: DecisionRow;
  older: readonly DecisionRow[];
  expanded: boolean;
  visibleCount: number;
  selectedResultSetId: string | null;
  deletingIds: ReadonlySet<string>;
  deleteInFlight: boolean;
  onShowMore: () => void;
  onSelectProfile: (row: DecisionRow, layout: "desktop" | "mobile") => void;
  onDelete: (row: DecisionRow) => void;
  onCloseProfile: (row: DecisionRow, layout: "desktop" | "mobile") => void;
  registerProfileTrigger: (
    row: DecisionRow,
    layout: "desktop" | "mobile",
    node: HTMLButtonElement | null
  ) => void;
}) {
  if (!expanded) return null;
  const visible = visibleHistoryRows(older, visibleCount);
  const regionId = historyRegionId(latest.configurationKey, layout);
  const hasMore = visible.length < older.length;

  if (layout === "desktop") {
    return (
      <>
        {visible.map((row, index) => {
          const selected = selectedResultSetId === row.resultSetId;
          const profileId = historyProfileId(row, layout);
          return (
            <Fragment key={row.resultSetId}>
              <tr
                id={index === 0 ? regionId : undefined}
                data-result-set-id={row.resultSetId}
                className="border-b bg-slate-950/[0.025] text-muted-foreground"
              >
                <td className="relative py-3 pl-9 pr-5">
                  <span
                    aria-hidden="true"
                    className="absolute bottom-0 left-5 top-0 w-px bg-sky-500/35"
                  />
                  <span
                    aria-hidden="true"
                    className="absolute left-[17px] top-5 h-2 w-2 rounded-full border border-sky-500/70 bg-background"
                  />
                  <div className="font-medium text-foreground">{row.label}</div>
                  <div className="mt-0.5 text-xs">
                    {formatCompletion(row.completedAt)}
                  </div>
                </td>
                <td className="px-3 py-3 text-right font-medium tabular-nums text-foreground">
                  {formatNormalizedScore(row.overallScore)}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {formatPercent(row.passRate)}
                </td>
                <td className="px-3 py-3">{row.tracks.join(", ")}</td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {formatPoint(row.toolReliabilityScore)}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {formatCount(row.tokensPerPass)}
                </td>
                <td className="px-3 py-3 text-right tabular-nums">
                  {formatDuration(row.speedPerPassMs)}
                </td>
                <td className="px-5 py-3">
                  <HistoryActions
                    row={row}
                    layout={layout}
                    selected={selected}
                    profileId={profileId}
                    deletingIds={deletingIds}
                    deleteInFlight={deleteInFlight}
                    onSelectProfile={onSelectProfile}
                    onDelete={onDelete}
                    registerProfileTrigger={registerProfileTrigger}
                  />
                </td>
              </tr>
              {selected && (
                <tr className="border-b bg-sky-500/[0.025]">
                  <td colSpan={8} className="sticky left-0 p-3">
                    <ModelEvidenceProfile
                      id={profileId}
                      row={row}
                      onClose={() => onCloseProfile(row, layout)}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
        {hasMore && (
          <tr className="border-b bg-slate-950/[0.025]">
            <td colSpan={8} className="py-3 pl-9 pr-5">
              <Button type="button" variant="ghost" size="sm" onClick={onShowMore}>
                Show more
              </Button>
            </td>
          </tr>
        )}
      </>
    );
  }

  return (
    <>
      {visible.map((row, index) => {
        const selected = selectedResultSetId === row.resultSetId;
        const profileId = historyProfileId(row, layout);
        return (
          <Fragment key={row.resultSetId}>
            <li
              id={index === 0 ? regionId : undefined}
              data-result-set-id={row.resultSetId}
              className="relative border-t bg-slate-950/[0.025] py-4 pl-8 pr-4"
            >
              <span
                aria-hidden="true"
                className="absolute bottom-0 left-4 top-0 w-px bg-sky-500/35"
              />
              <span
                aria-hidden="true"
                className="absolute left-[13px] top-6 h-2 w-2 rounded-full border border-sky-500/70 bg-background"
              />
              <div className="break-words font-medium">{row.label}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">
                {formatCompletion(row.completedAt)}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <HistoryMetric label="Overall index" value={formatNormalizedScore(row.overallScore)} />
                <HistoryMetric label="Pass" value={formatPercent(row.passRate)} />
                <HistoryMetric label="Reliability" value={formatPoint(row.toolReliabilityScore)} />
                <HistoryMetric label="Tokens/pass" value={formatCount(row.tokensPerPass)} />
                <HistoryMetric label="Time/pass" value={formatDuration(row.speedPerPassMs)} />
                <HistoryMetric label="Coverage" value={row.tracks.join(", ")} />
              </dl>
              <div className="mt-4">
                <HistoryActions
                  row={row}
                  layout={layout}
                  selected={selected}
                  profileId={profileId}
                  deletingIds={deletingIds}
                  deleteInFlight={deleteInFlight}
                  onSelectProfile={onSelectProfile}
                  onDelete={onDelete}
                  registerProfileTrigger={registerProfileTrigger}
                />
              </div>
            </li>
            {selected && (
              <li className="border-t bg-sky-500/[0.025] p-3">
                <ModelEvidenceProfile
                  id={profileId}
                  row={row}
                  onClose={() => onCloseProfile(row, layout)}
                />
              </li>
            )}
          </Fragment>
        );
      })}
      {hasMore && (
        <li className="border-t bg-slate-950/[0.025] px-8 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={onShowMore}>
            Show more
          </Button>
        </li>
      )}
    </>
  );
}

function HistoryActions({
  row,
  layout,
  selected,
  profileId,
  deletingIds,
  deleteInFlight,
  onSelectProfile,
  onDelete,
  registerProfileTrigger,
}: {
  row: DecisionRow;
  layout: "desktop" | "mobile";
  selected: boolean;
  profileId: string;
  deletingIds: ReadonlySet<string>;
  deleteInFlight: boolean;
  onSelectProfile: (row: DecisionRow, layout: "desktop" | "mobile") => void;
  onDelete: (row: DecisionRow) => void;
  registerProfileTrigger: (
    row: DecisionRow,
    layout: "desktop" | "mobile",
    node: HTMLButtonElement | null
  ) => void;
}) {
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button
        ref={(node) => registerProfileTrigger(row, layout, node)}
        type="button"
        variant={selected ? "secondary" : "outline"}
        size="sm"
        aria-expanded={selected}
        aria-controls={profileId}
        data-result-set-id={row.resultSetId}
        onClick={() => onSelectProfile(row, layout)}
      >
        <Eye className="h-4 w-4" aria-hidden="true" />
        View profile
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={deleteInFlight || deletingIds.has(row.resultSetId)}
        data-focus-return={`${layout}:${row.configurationKey}`}
        data-result-set-id={row.resultSetId}
        onClick={() => onDelete(row)}
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
        Delete snapshot
      </Button>
    </div>
  );
}

function HistoryMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function historyProfileId(row: DecisionRow, layout: "desktop" | "mobile") {
  return `benchmark-evidence-${layout}-${encodeIdentity(row.resultSetId)}`;
}

export function encodeIdentity(value: string): string {
  if (!value) return "u-empty";
  return `u-${Array.from(value, (character) =>
    character.codePointAt(0)!.toString(16).padStart(6, "0")
  ).join("-")}`;
}

export function formatCompletion(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(timestamp))
    : "Completion time unavailable";
}

function formatPercent(value: number | null): string {
  return value == null ? "—" : `${Math.round(value * 100)}%`;
}

function formatPoint(value: number | null): string {
  return value == null ? "—" : Math.round(value).toLocaleString();
}

function formatCount(value: number | null): string {
  return value == null ? "—" : Math.round(value).toLocaleString();
}

function formatDuration(value: number | null): string {
  if (value == null) return "—";
  const seconds = value / 1000;
  return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
}
