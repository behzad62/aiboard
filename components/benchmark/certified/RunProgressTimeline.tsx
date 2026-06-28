"use client";

export function RunProgressTimeline({
  items,
}: {
  items: Array<{ label: string; status: "idle" | "running" | "done" | "failed" }>;
}) {
  return (
    <ol className="grid gap-2 text-sm md:grid-cols-4">
      {items.map((item) => (
        <li
          key={item.label}
          className="rounded-md border px-3 py-2"
          data-status={item.status}
        >
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {item.status}
          </div>
          <div className="mt-1 font-medium">{item.label}</div>
        </li>
      ))}
    </ol>
  );
}
