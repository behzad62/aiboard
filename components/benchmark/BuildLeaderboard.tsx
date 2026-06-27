"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ensureReady } from "@/lib/client/api";
import {
  getModelStats,
  isInitialized,
  resetModelStats,
} from "@/lib/client/store";
import {
  approvalRate,
  availability,
  charsPerSecond,
  qualityPerAttempt,
  qualityScore,
} from "@/lib/client/model-stats";
import type { ModelBuildStat } from "@/lib/db/schema";
import {
  BuildLeaderboardTable,
  type BuildSortKey,
} from "@/components/benchmark/BuildLeaderboardTable";
import { BuildSummaryStrip } from "@/components/benchmark/BuildLeaderboardSummary";

type SortDir = "asc" | "desc";

function sortValue(s: ModelBuildStat, key: BuildSortKey): number | string | null {
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

export function BuildLeaderboard() {
  const [stats, setStats] = useState<ModelBuildStat[] | null>(null);
  const [locked, setLocked] = useState(false);
  const [sortKey, setSortKey] = useState<BuildSortKey>("quality");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(() => {
    if (isInitialized()) setStats(getModelStats());
  }, []);

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

  const toggleSort = (key: BuildSortKey) => {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "model" ? "asc" : "desc");
    }
  };

  const rows = useMemo(() => {
    const list = (stats ?? []).slice();
    list.sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      let cmp: number;
      if (typeof va === "string" || typeof vb === "string") {
        cmp = String(va).localeCompare(String(vb));
      } else {
        cmp = va - vb;
      }
      if (cmp === 0) cmp = qualityScore(b) - qualityScore(a);
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
              Settings - Storage
            </a>{" "}
            and enter your passphrase to unlock it.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold tracking-tight">Build Lab leaderboard</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Architect-reviewed quality, speed, and reliability accumulated from
            Build runs in this browser.
          </p>
        </div>
        {!loading && !isEmpty && (
          <Button type="button" variant="ghost" size="sm" onClick={() => reset()}>
            <RotateCcw className="mr-2 h-3.5 w-3.5" />
            Reset all
          </Button>
        )}
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading stats...</p>
      ) : isEmpty ? (
        <Card>
          <CardContent className="py-10 text-center">
            <p className="mx-auto max-w-xl text-sm text-muted-foreground">
              No data yet. Run a Build discussion; each worker&apos;s approvals, fixes,
              output speed, and provider availability accumulate here across builds.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          <BuildSummaryStrip summary={summary} />
          <BuildLeaderboardTable
            rows={rows}
            sortKey={sortKey}
            sortDir={sortDir}
            expanded={expanded}
            onToggleSort={toggleSort}
            onToggleExpanded={(modelId) =>
              setExpanded((cur) => (cur === modelId ? null : modelId))
            }
            onResetModel={(modelId) => reset(modelId)}
          />
          <p className="text-xs text-muted-foreground">
            Accumulated locally from your Build runs. Architect-reviewed quality
            is difficulty-weighted; quality/attempt normalizes for usage volume;
            speed is output throughput, never raw task time; provider denials are
            tracked separately and never count against model quality.
          </p>
        </>
      )}
    </section>
  );
}
