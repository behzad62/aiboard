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

export const BUILD_LEADERBOARD_COLUMNS: {
  key: BuildSortKey;
  label: string;
  align?: "right";
}[] = [
  { key: "model", label: "Model" },
  { key: "quality", label: "Architect-reviewed quality", align: "right" },
  { key: "qualityPerAttempt", label: "Architect-reviewed quality/att.", align: "right" },
  { key: "approval", label: "Approval", align: "right" },
  { key: "speed", label: "Speed", align: "right" },
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
