import type { ModelBuildStat } from "@/lib/db/schema";
import {
  availability,
  qualityScore,
} from "@/lib/client/model-stats";

export type BuildSortKey =
  | "quality"
  | "qualityPerAttempt"
  | "approval"
  | "speed"
  | "availability"
  | "builds"
  | "attempts"
  | "lastActive"
  | "model";

export type SortDir = "asc" | "desc";

export interface BuildOutcomeSegmentCounts {
  total: number;
  counts: Record<string, number>;
}

export const BUILD_LEADERBOARD_COLUMNS: {
  key: BuildSortKey;
  label: string;
  align?: "right";
}[] = [
  { key: "model", label: "Model" },
  { key: "quality", label: "Architect-reviewed quality", align: "right" },
  { key: "qualityPerAttempt", label: "Architect-reviewed quality/att.", align: "right" },
  { key: "approval", label: "Approval", align: "right" },
  { key: "speed", label: "Throughput", align: "right" },
  { key: "availability", label: "Avail.", align: "right" },
  { key: "builds", label: "Builds", align: "right" },
  { key: "attempts", label: "Attempts", align: "right" },
  { key: "lastActive", label: "Last active", align: "right" },
];

export function round(n: number, dp = 1): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export function pct(n: number | null): string {
  return n == null ? "-" : `${Math.round(n * 100)}%`;
}

export function compareBuildStats(
  a: ModelBuildStat,
  b: ModelBuildStat,
  sortValue: (s: ModelBuildStat) => number | string | null,
  sortDir: SortDir
): number {
  const va = sortValue(a);
  const vb = sortValue(b);
  if (va == null && vb == null) return 0;
  if (va == null) return 1;
  if (vb == null) return -1;
  let cmp =
    typeof va === "string" || typeof vb === "string"
      ? String(va).localeCompare(String(vb))
      : va - vb;
  if (sortDir === "desc") cmp = -cmp;
  if (cmp === 0) cmp = qualityScore(b) - qualityScore(a);
  return cmp;
}

export function formatBuildAvailability(s: ModelBuildStat): string {
  return pct(availability(s));
}

export function formatBuildQualityBadge(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

export function outcomeSegmentCounts(s: ModelBuildStat): BuildOutcomeSegmentCounts {
  const graded = s.approvals + s.fixes + s.badOutput + s.unavailable;
  const total = s.attempts || graded;
  return {
    total,
    counts: {
      approved: s.approvals,
      fixes: s.fixes,
      badOutput: s.badOutput,
      unavailable: s.unavailable,
      ungraded: Math.max(0, total - graded),
    },
  };
}

export function lastActive(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "-";
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
