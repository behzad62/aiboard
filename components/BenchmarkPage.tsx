"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import type { ModelBuildStat } from "@/lib/db/schema";
import { ensureReady } from "@/lib/client/api";
import { getModelStats, isInitialized, resetModelStats } from "@/lib/client/store";
import {
  approvalRate,
  availability,
  charsPerSecond,
  judgeSummary,
  qualityPerAttempt,
  qualityScore,
} from "@/lib/client/model-stats";

/**
 * Detailed global Build-mode model leaderboard. Every build's worker
 * scoreboard folds into per-model totals (store.accumulateModelStats), so
 * users see which models actually perform on THEIR tasks over time. Three
 * honest axes are kept separate (quality / speed / reliability) rather than
 * collapsed into one number — see lib/client/model-stats.ts.
 */

type SortKey =
  | "quality"
  | "qualityPerAttempt"
  | "approval"
  | "speed"
  | "availability"
  | "builds"
  | "attempts"
  | "lastActive"
  | "model";

type SortDir = "asc" | "desc";

/** Distinct semantic colors for the attempt-distribution segments. */
const SEGMENTS = [
  { key: "approved", label: "Approved", className: "bg-emerald-500" },
  { key: "fixes", label: "Fixes", className: "bg-amber-500" },
  { key: "badOutput", label: "Bad output", className: "bg-destructive" },
  { key: "unavailable", label: "Unavailable", className: "bg-muted-foreground/40" },
] as const;

function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function pct(n: number | null): string {
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}

/** Short relative-ish date from an ISO timestamp. */
function lastActive(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** Numeric value for a sort key; null sorts last regardless of direction. */
function sortValue(s: ModelBuildStat, key: SortKey): number | string | null {
  switch (key) {
    case "quality":
      return qualityScore(s);
    case "qualityPerAttempt":
      return qualityPerAttempt(s);
    case "approval":
      return approvalRate(s);
    case "speed":
      return charsPerSecond(s);
    case "availability":
      return availability(s);
    case "builds":
      return s.builds;
    case "attempts":
      return s.attempts;
    case "lastActive":
      return new Date(s.updatedAt).getTime() || null;
    case "model":
      return s.displayName.toLowerCase();
  }
}

const COLUMNS: { key: SortKey; label: string; align?: "right" }[] = [
  { key: "model", label: "Model" },
  { key: "quality", label: "Quality", align: "right" },
  { key: "qualityPerAttempt", label: "Quality/att.", align: "right" },
  { key: "approval", label: "Approval", align: "right" },
  { key: "speed", label: "Speed", align: "right" },
  { key: "availability", label: "Avail.", align: "right" },
  { key: "builds", label: "Builds", align: "right" },
  { key: "attempts", label: "Attempts", align: "right" },
  { key: "lastActive", label: "Last active", align: "right" },
];

function qualityBadgeVariant(sc: number): "success" | "destructive" | "secondary" {
  return sc > 0 ? "success" : sc < 0 ? "destructive" : "secondary";
}

export function BenchmarkPage() {
  const [stats, setStats] = useState<ModelBuildStat[] | null>(null);
  const [locked, setLocked] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("quality");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    if (isInitialized()) setStats(getModelStats());
  }, []);

  // This page can be the first one visited, so it must initialize the store
  // itself (ensureReady is idempotent) rather than wait on another page to.
  useEffect(() => {
    let cancelled = false;
    void ensureReady()
      .then(({ needsPassphrase }) => {
        if (cancelled) return;
        if (needsPassphrase) setLocked(true);
        else setStats(getModelStats());
      })
      .catch(() => {
        if (!cancelled) setStats([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reset = (modelId?: string) => {
    const ok = modelId
      ? window.confirm("Reset this model's accumulated Build stats? This can't be undone.")
      : window.confirm("Reset ALL accumulated Build stats for every model? This can't be undone.");
    if (!ok) return;
    resetModelStats(modelId);
    load();
  };

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      // Text default asc; numeric metrics default to "best first" (desc).
      setSortDir(key === "model" ? "asc" : "desc");
    }
  };

  const rows = useMemo(() => {
    const list = (stats ?? []).slice();
    list.sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      // nulls always sort last.
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      let cmp: number;
      if (typeof va === "string" || typeof vb === "string") {
        cmp = String(va).localeCompare(String(vb));
      } else {
        cmp = va - vb;
      }
      if (cmp === 0) cmp = qualityScore(b) - qualityScore(a); // stable tiebreak
      return sortDir === "asc" ? cmp : -cmp;
    });
    return list;
  }, [stats, sortKey, sortDir]);

  const summary = useMemo(() => {
    const list = stats ?? [];
    let approvals = 0;
    let decided = 0;
    let attempts = 0;
    let builds = 0;
    let denials = 0;
    for (const s of list) {
      approvals += s.approvals;
      decided += s.approvals + s.fixes + s.badOutput;
      attempts += s.attempts;
      builds += s.builds;
      denials += s.unavailable;
    }
    return {
      models: list.length,
      builds,
      attempts,
      approvalRate: decided > 0 ? approvals / decided : null,
      denials,
    };
  }, [stats]);

  // null = store still initializing — don't claim "no data yet" prematurely.
  const loading = stats === null;
  const isEmpty = !loading && stats.length === 0;

  if (locked) {
    return (
      <Card className="mx-auto max-w-md">
        <CardHeader>
          <CardTitle>Storage is locked</CardTitle>
          <CardDescription>
            Your data is encrypted. Open{" "}
            <a href="/settings?tab=storage" className="underline">
              Settings → Storage
            </a>{" "}
            and enter your passphrase to unlock it.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-7xl space-y-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold tracking-tight">
            Model benchmark
          </h1>
          <p className="mt-1 max-w-2xl text-muted-foreground">
            How each worker model has performed across all your Build runs —
            quality, speed, and reliability, accumulated locally in your browser.
          </p>
        </div>
        {!loading && !isEmpty && (
          <Button type="button" variant="ghost" size="sm" onClick={() => reset()}>
            <RotateCcw className="mr-2 h-3.5 w-3.5" />
            Reset all
          </Button>
        )}
      </header>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading stats…</p>
      ) : isEmpty ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="mx-auto max-w-xl text-sm text-muted-foreground">
              No data yet. Run a Build discussion — each worker&apos;s
              approvals, fixes, output speed, and provider availability
              accumulate here across builds, so you can see which models
              actually perform on your tasks. Stats accumulate from Build
              discussions only.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Summary strip */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            <SummaryCard label="Models tracked" value={String(summary.models)} />
            <SummaryCard label="Total builds" value={String(summary.builds)} />
            <SummaryCard label="Task attempts" value={String(summary.attempts)} />
            <SummaryCard label="Approval rate" value={pct(summary.approvalRate)} />
            <SummaryCard label="Provider denials" value={String(summary.denials)} />
          </div>

          {/* Leaderboard */}
          <Card>
            <CardHeader>
              <CardTitle>Leaderboard</CardTitle>
              <CardDescription>
                Click a column to sort; click a row for the full breakdown.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="w-8 py-2" />
                      <th className="w-10 py-2 pr-2 text-right font-medium">#</th>
                      {COLUMNS.map((c) => (
                        <th
                          key={c.key}
                          className={`py-2 px-2 font-medium ${
                            c.align === "right" ? "text-right" : "text-left"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => toggleSort(c.key)}
                            className={`inline-flex items-center gap-1 hover:text-foreground ${
                              sortKey === c.key ? "text-foreground" : ""
                            }`}
                          >
                            {c.label}
                            {sortKey === c.key && (
                              <span aria-hidden>{sortDir === "asc" ? "▲" : "▼"}</span>
                            )}
                          </button>
                        </th>
                      ))}
                      <th className="w-8 py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((s, i) => {
                      const sc = round(qualityScore(s));
                      const qpa = qualityPerAttempt(s);
                      const speed = charsPerSecond(s);
                      const avail = availability(s);
                      const open = expanded === s.modelId;
                      return (
                        <ModelRow
                          key={s.modelId}
                          stat={s}
                          rank={i + 1}
                          quality={sc}
                          qualityPerAttempt={qpa}
                          speed={speed}
                          availability={avail}
                          open={open}
                          onToggle={() =>
                            setExpanded((cur) => (cur === s.modelId ? null : s.modelId))
                          }
                          onReset={() => reset(s.modelId)}
                        />
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">
            Accumulated locally from your Build runs. Quality is
            difficulty-weighted (the Architect rates each task 1–5);
            quality/attempt normalizes for usage volume so a high-throughput
            model doesn&apos;t outrank a sharper one purely on volume; speed is
            output throughput, never raw task time; provider denials (rate
            limits, outages) are tracked separately and never count against a
            model&apos;s quality.
          </p>
        </>
      )}
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border bg-muted/20 p-3">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function ModelRow({
  stat: s,
  rank,
  quality,
  qualityPerAttempt: qpa,
  speed,
  availability: avail,
  open,
  onToggle,
  onReset,
}: {
  stat: ModelBuildStat;
  rank: number;
  quality: number;
  qualityPerAttempt: number | null;
  speed: number | null;
  availability: number | null;
  open: boolean;
  onToggle: () => void;
  onReset: () => void;
}) {
  const rate = approvalRate(s);
  // A % only appears once a denial exists — zero denials shows "—" (nothing
  // to report) rather than a 100% that's mostly small-sample noise.
  const availText = s.unavailable > 0 ? pct(avail) : "—";

  return (
    <>
      <tr
        className="cursor-pointer border-b transition-colors hover:bg-muted/30"
        onClick={onToggle}
      >
        <td className="py-2 pl-1 text-muted-foreground">
          {/* Real button so the breakdown is reachable by keyboard, not just row click. */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            className="rounded p-0.5 hover:text-foreground"
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} ${s.displayName} breakdown`}
          >
            {open ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        </td>
        <td className="py-2 pr-2 text-right tabular-nums text-muted-foreground">
          {rank}
        </td>
        <td className="max-w-[16rem] truncate py-2 px-2 font-medium" title={s.modelId}>
          {s.displayName}
        </td>
        <td className="py-2 px-2 text-right">
          <Badge variant={qualityBadgeVariant(quality)}>{quality}</Badge>
        </td>
        <td className="py-2 px-2 text-right tabular-nums">
          {qpa == null ? "—" : round(qpa, 2)}
        </td>
        <td className="py-2 px-2 text-right tabular-nums">{pct(rate)}</td>
        <td className="py-2 px-2 text-right tabular-nums">
          {speed == null ? "—" : `${Math.round(speed)}`}
        </td>
        <td className="py-2 px-2 text-right tabular-nums">{availText}</td>
        <td className="py-2 px-2 text-right tabular-nums">{s.builds}</td>
        <td className="py-2 px-2 text-right tabular-nums">{s.attempts}</td>
        <td className="py-2 px-2 text-right text-muted-foreground">
          {lastActive(s.updatedAt)}
        </td>
        <td className="py-2 pr-1 text-right">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onReset();
            }}
            className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
            aria-label={`Reset ${s.displayName} stats`}
            title="Reset this model's stats"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-b bg-muted/10">
          <td colSpan={COLUMNS.length + 3} className="p-4">
            <ModelDetail stat={s} onReset={onReset} />
          </td>
        </tr>
      )}
    </>
  );
}

function ModelDetail({ stat: s, onReset }: { stat: ModelBuildStat; onReset: () => void }) {
  const judge = judgeSummary(s);
  const speed = charsPerSecond(s);
  const totalSecs = s.responseMs / 1000;
  // Distribution segments (raw counts).
  const counts: Record<string, number> = {
    approved: s.approvals,
    fixes: s.fixes,
    badOutput: s.badOutput,
    unavailable: s.unavailable,
  };
  const total = s.attempts || SEGMENTS.reduce((acc, seg) => acc + counts[seg.key], 0);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      {/* Raw vs difficulty-weighted counts */}
      <div className="space-y-3">
        <h3 className="text-sm font-semibold">Outcomes (raw / difficulty-weighted)</h3>
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

      {/* Throughput + judges */}
      <div className="space-y-4">
        <div className="space-y-1.5">
          <h3 className="text-sm font-semibold">Throughput</h3>
          <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-muted-foreground">
            <span>{s.responseChars.toLocaleString()} chars</span>
            <span>{round(totalSecs)}s total</span>
            <span>{speed == null ? "—" : `${Math.round(speed)} chars/s`}</span>
          </div>
        </div>

        <div className="space-y-1.5">
          <h3 className="text-sm font-semibold">Judges</h3>
          {judge.totalVerdicts === 0 ? (
            <p className="text-sm text-muted-foreground">No Architect verdicts recorded.</p>
          ) : (
            <>
              <ul className="space-y-0.5 text-sm text-muted-foreground">
                {judge.judges.map((j) => (
                  <li key={j.id} className="flex justify-between gap-2">
                    <span className="truncate" title={j.id}>{j.name}</span>
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
                      {" · "}
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

function CountRow({ label, raw, weighted }: { label: string; raw: number; weighted: number }) {
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
