"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { RotateCcw } from "lucide-react";
import type { ModelBuildStat } from "@/lib/db/schema";
import { getModelStats, isInitialized, resetModelStats } from "@/lib/client/store";
import { resolveModelName } from "@/lib/client/providers";

/**
 * Global Build-mode model leaderboard. Every build's worker scoreboard folds
 * into per-model totals (store.accumulateModelStats), so users see which
 * models actually perform on THEIR tasks over time. Three honest axes, never
 * collapsed into one number:
 *  - Quality: difficulty-weighted approvals/fixes/bad-output.
 *  - Speed: output throughput (chars/s) from successful responses only.
 *  - Reliability: how often the provider was available (infra denials excluded
 *    from quality entirely — a free-tier 429 isn't the model's fault).
 */

/** Difficulty-weighted quality score; unavailable never counts against it. */
function qualityScore(s: ModelBuildStat): number {
  return s.wApprovals * 3 - s.wFixes - s.wBadOutput * 4;
}

function approvalRate(s: ModelBuildStat): number | null {
  const decided = s.approvals + s.fixes + s.badOutput; // unavailable excluded
  return decided > 0 ? s.approvals / decided : null;
}

function availability(s: ModelBuildStat): number | null {
  return s.attempts > 0 ? 1 - s.unavailable / s.attempts : null;
}

function charsPerSecond(s: ModelBuildStat): number | null {
  return s.responseMs > 0 && s.responseChars > 0
    ? (s.responseChars / s.responseMs) * 1000
    : null;
}

/** Trust note from how this model's verdicts were judged. */
function judgeNote(s: ModelBuildStat): string {
  const verdicts = Object.values(s.judges).reduce((a, b) => a + b, 0);
  if (verdicts === 0) return "";
  const judges = Object.keys(s.judges)
    .map((id) => resolveModelName(id))
    .join(", ");
  const indepPct = Math.round((s.independentVerdicts / verdicts) * 100);
  const selfNote =
    indepPct < 100 ? ` · ${100 - indepPct}% self-graded (lower trust)` : "";
  return `judged by ${judges}${selfNote}`;
}

export function ModelStatsPanel() {
  const [stats, setStats] = useState<ModelBuildStat[] | null>(null);

  const load = useCallback(() => {
    if (isInitialized()) setStats(getModelStats());
  }, []);

  // The store initializes asynchronously alongside the dashboard — retry
  // briefly instead of racing it.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const tryLoad = () => {
      if (cancelled) return;
      if (isInitialized()) setStats(getModelStats());
      else timer = setTimeout(tryLoad, 400);
    };
    tryLoad();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  const reset = (modelId?: string) => {
    resetModelStats(modelId);
    load();
  };

  const rows = (stats ?? [])
    .slice()
    .sort((a, b) => qualityScore(b) - qualityScore(a) || b.approvals - a.approvals);

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No data yet. Run a Build discussion — each worker&apos;s approvals,
        fixes, output speed, and provider availability accumulate here across
        builds, so you can see which models actually perform on your tasks.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={() => reset()}>
          <RotateCcw className="mr-2 h-3.5 w-3.5" />
          Reset all
        </Button>
      </div>

      {rows.map((s) => {
        const rate = approvalRate(s);
        const avail = availability(s);
        const speed = charsPerSecond(s);
        const sc = Math.round(qualityScore(s) * 10) / 10;
        const note = judgeNote(s);
        return (
          <div key={s.modelId} className="rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium" title={s.modelId}>
                {s.displayName}
              </span>
              <div className="flex shrink-0 items-center gap-1.5">
                <Badge variant={sc > 0 ? "success" : sc < 0 ? "destructive" : "secondary"}>
                  quality {sc}
                </Badge>
                <button
                  type="button"
                  onClick={() => reset(s.modelId)}
                  className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  aria-label={`Reset ${s.displayName} stats`}
                  title="Reset this model's stats"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>

            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>
                {s.builds} build{s.builds === 1 ? "" : "s"} · {s.attempts} task
                attempt{s.attempts === 1 ? "" : "s"}
              </span>
              <span>
                {s.approvals} approved · {s.fixes} fix{s.fixes === 1 ? "" : "es"} ·{" "}
                {s.badOutput} bad output
              </span>
              {rate != null && <span>{Math.round(rate * 100)}% approval</span>}
              {speed != null && <span>{Math.round(speed)} chars/s</span>}
              {avail != null && s.unavailable > 0 && (
                <span>
                  {Math.round(avail * 100)}% available ({s.unavailable} denied)
                </span>
              )}
            </div>

            {rate != null && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.round(rate * 100)}%` }}
                />
              </div>
            )}

            {note && <p className="mt-1.5 text-xs text-muted-foreground">{note}</p>}
          </div>
        );
      })}

      <p className="text-xs text-muted-foreground">
        Accumulated locally from your Build runs. Quality is difficulty-weighted
        (the Architect rates each task 1–5); speed is output throughput, never
        raw task time; provider denials (rate limits, outages) are tracked
        separately and never count against a model&apos;s quality.
      </p>
    </div>
  );
}
