"use client";

import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  charsPerSecond,
  judgeSummary,
} from "@/lib/client/model-stats";
import type { ModelBuildStat } from "@/lib/db/schema";
import {
  outcomeSegmentCounts,
  round,
} from "@/components/benchmark/BuildLeaderboardShared";

const SEGMENTS = [
  { key: "approved", label: "Approved", className: "bg-emerald-500" },
  { key: "fixes", label: "Fixes", className: "bg-amber-500" },
  { key: "badOutput", label: "Bad output", className: "bg-destructive" },
  { key: "unavailable", label: "Unavailable", className: "bg-muted-foreground/40" },
  { key: "ungraded", label: "Ungraded", className: "bg-muted-foreground/20" },
] as const;

export function BuildModelDetail({
  stat: s,
  onReset,
}: {
  stat: ModelBuildStat;
  onReset: () => void;
}) {
  const judge = judgeSummary(s);
  const speed = charsPerSecond(s);
  const totalSecs = s.responseMs / 1000;
  const { total, counts } = outcomeSegmentCounts(s);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">
          Outcomes (raw / difficulty-weighted)
        </h3>
        <dl className="space-y-1.5 text-sm">
          <CountRow label="Approvals" raw={s.approvals} weighted={s.wApprovals} />
          <CountRow label="Fixes" raw={s.fixes} weighted={s.wFixes} />
          <CountRow label="Bad output" raw={s.badOutput} weighted={s.wBadOutput} />
        </dl>

        {total > 0 && (
          <div className="space-y-2 pt-1">
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
              {SEGMENTS.map((seg) => {
                const w = (counts[seg.key] / total) * 100;
                if (w <= 0) return null;
                return (
                  <div
                    key={seg.key}
                    className={seg.className}
                    style={{ width: `${w}%` }}
                    title={`${seg.label}: ${counts[seg.key]}`}
                  />
                );
              })}
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
              {SEGMENTS.map((seg) => (
                <span key={seg.key} className="inline-flex items-center gap-1.5">
                  <span className={`h-2.5 w-2.5 rounded-sm ${seg.className}`} />
                  {seg.label} ({counts[seg.key]})
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <h3 className="text-sm font-semibold">Throughput</h3>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-muted-foreground">
            <span>{s.responseChars.toLocaleString()} chars</span>
            <span>{round(totalSecs)}s total</span>
            <span>{speed == null ? "-" : `${Math.round(speed)} chars/s`}</span>
          </div>
        </div>

        <div className="space-y-1.5">
          <h3 className="text-sm font-semibold">Judges</h3>
          {judge.totalVerdicts === 0 ? (
            <p className="text-sm text-muted-foreground">
              No Architect verdicts recorded.
            </p>
          ) : (
            <>
              <ul className="space-y-0.5 text-sm text-muted-foreground">
                {judge.judges.map((j) => (
                  <li key={j.id} className="flex justify-between gap-2">
                    <span className="truncate" title={j.id}>
                      {j.name}
                    </span>
                    <span className="tabular-nums">
                      {j.verdicts} verdict{j.verdicts === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
              {judge.independentPct != null && (
                <p className="text-xs text-muted-foreground">
                  {judge.independentPct}% independently graded
                  {judge.independentPct < 100 && (
                    <>
                      {" - "}
                      <span className="text-amber-600 dark:text-amber-400">
                        {100 - judge.independentPct}% self-graded (lower trust)
                      </span>
                    </>
                  )}
                </p>
              )}
            </>
          )}
        </div>

        <Button type="button" variant="outline" size="sm" onClick={onReset}>
          <RotateCcw className="mr-2 h-3.5 w-3.5" />
          Reset this model
        </Button>
      </div>
    </div>
  );
}

function CountRow({
  label,
  raw,
  weighted,
}: {
  label: string;
  raw: number;
  weighted: number;
}) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">
        {raw} <span className="text-muted-foreground">raw</span> /{" "}
        {round(weighted)} <span className="text-muted-foreground">w</span>
      </dd>
    </div>
  );
}
