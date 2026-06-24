"use client";

export const CHART_COLORS = [
  "#38bdf8",
  "#f59e0b",
  "#22c55e",
  "#a78bfa",
  "#ef4444",
  "#14b8a6",
];

export function modelIdFromChartClick(value: unknown): string | null {
  const payload = (
    value as { activePayload?: Array<{ payload?: { modelId?: unknown } }> }
  )?.activePayload?.[0]?.payload?.modelId;
  return typeof payload === "string" && payload.length > 0 ? payload : null;
}

export function EmptyChart({ label }: { label: string }) {
  return (
    <div className="flex h-[260px] items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
      {label}
    </div>
  );
}
