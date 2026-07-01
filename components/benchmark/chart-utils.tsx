"use client";

export const CHART_COLORS = [
  "#0072B2",
  "#E69F00",
  "#009E73",
  "#CC79A7",
  "#D55E00",
  "#56B4E9",
];

export const CHART_DASHES = ["0", "6 3", "2 2", "8 4"] as const;

export function moveSuccessRate(fallbackRate: number): number {
  return 100 - fallbackRate;
}

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

export function ChartDataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: string[];
  rows: object[];
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column} scope="col">
              {column}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => {
          const record = row as Record<
            string,
            string | number | null | undefined
          >;
          return (
            <tr key={String(record.id ?? record.modelId ?? record.date ?? index)}>
              {columns.map((column) => (
                <td key={column}>{record[column] ?? ""}</td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
