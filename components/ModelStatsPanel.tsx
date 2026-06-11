"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { ModelBuildStat } from "@/lib/db/schema";
import { getModelStats, isInitialized } from "@/lib/client/store";

/**
 * Global Build-mode model leaderboard: every build's worker scoreboard is
 * folded into per-model totals (lib/client/store accumulateModelStats), so
 * users can see which models actually perform on THEIR tasks over time.
 * Score mirrors the in-build formula; speed is throughput (chars/s of output),
 * never raw elapsed time — bigger tasks legitimately take longer.
 */

function score(s: ModelBuildStat): number {
  return s.approvals * 3 - s.fixes - s.failures * 4;
}

function approvalRate(s: ModelBuildStat): number | null {
  const decided = s.approvals + s.fixes + s.failures;
  return decided > 0 ? s.approvals / decided : null;
}

function charsPerSecond(s: ModelBuildStat): number | null {
  return s.totalMs > 0 && s.totalChars > 0
    ? (s.totalChars / s.totalMs) * 1000
    : null;
}

export function ModelStatsPanel() {
  const [stats, setStats] = useState<ModelBuildStat[] | null>(null);

  // The store initializes asynchronously alongside the dashboard load —
  // retry briefly instead of racing it.
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

  const rows = (stats ?? [])
    .slice()
    .sort((a, b) => score(b) - score(a) || b.approvals - a.approvals);

  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No data yet. Run a Build discussion — each worker&apos;s approvals,
        fixes, failures, and output speed accumulate here across builds, so
        you can see which models actually perform on your tasks.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((s) => {
        const rate = approvalRate(s);
        const speed = charsPerSecond(s);
        const sc = score(s);
        return (
          <div key={s.modelId} className="rounded-lg border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-sm font-medium" title={s.modelId}>
                {s.displayName}
              </span>
              <Badge variant={sc > 0 ? "success" : sc < 0 ? "destructive" : "secondary"}>
                score {sc}
              </Badge>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              <span>
                {s.builds} build{s.builds === 1 ? "" : "s"} · {s.attempts} task
                attempt{s.attempts === 1 ? "" : "s"}
              </span>
              <span>
                {s.approvals} approved · {s.fixes} fix{s.fixes === 1 ? "" : "es"} ·{" "}
                {s.failures} failed
              </span>
              {rate != null && <span>{Math.round(rate * 100)}% approval</span>}
              {speed != null && <span>{Math.round(speed)} chars/s output</span>}
            </div>
            {rate != null && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary"
                  style={{ width: `${Math.round(rate * 100)}%` }}
                />
              </div>
            )}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        Accumulated locally from your Build runs. Speed is output throughput —
        never raw task time, which would punish models given bigger tasks.
      </p>
    </div>
  );
}
