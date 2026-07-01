"use client";

import { ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  approvalRate,
  charsPerSecond,
  qualityPerAttempt,
  qualityScore,
} from "@/lib/client/model-stats";
import type { ModelBuildStat } from "@/lib/db/schema";
import { BuildModelDetail } from "@/components/benchmark/BuildModelDetail";
import {
  BUILD_LEADERBOARD_COLUMNS,
  formatBuildAvailability,
  lastActive,
  pct,
  round,
} from "@/components/benchmark/BuildLeaderboardShared";

function qualityBadgeVariant(sc: number): "success" | "destructive" | "secondary" {
  return sc > 0 ? "success" : sc < 0 ? "destructive" : "secondary";
}

export function BuildModelRow({
  stat: s,
  rank,
  open,
  onToggle,
  onReset,
}: {
  stat: ModelBuildStat;
  rank: number;
  open: boolean;
  onToggle: () => void;
  onReset: () => void;
}) {
  const quality = round(qualityScore(s));
  const qpa = qualityPerAttempt(s);
  const speed = charsPerSecond(s);
  const rate = approvalRate(s);
  const availText = formatBuildAvailability(s);

  return (
    <>
      <tr
        className="cursor-pointer border-b transition-colors hover:bg-muted/30"
        onClick={onToggle}
      >
        <td className="py-2 pl-1 text-muted-foreground">
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
        <td className="max-w-[16rem] truncate px-2 py-2 font-medium" title={s.modelId}>
          {s.displayName}
        </td>
        <td className="px-2 py-2 text-right">
          <Badge variant={qualityBadgeVariant(quality)}>{quality}</Badge>
        </td>
        <td className="px-2 py-2 text-right tabular-nums">
          {qpa == null ? "-" : round(qpa, 2)}
        </td>
        <td className="px-2 py-2 text-right tabular-nums">{pct(rate)}</td>
        <td className="px-2 py-2 text-right tabular-nums">
          {speed == null ? "-" : `${Math.round(speed)}`}
        </td>
        <td className="px-2 py-2 text-right tabular-nums">{availText}</td>
        <td className="px-2 py-2 text-right tabular-nums">{s.builds}</td>
        <td className="px-2 py-2 text-right tabular-nums">{s.attempts}</td>
        <td className="px-2 py-2 text-right text-muted-foreground">
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
          <td colSpan={BUILD_LEADERBOARD_COLUMNS.length + 3} className="p-4">
            <BuildModelDetail stat={s} onReset={onReset} />
          </td>
        </tr>
      )}
    </>
  );
}
