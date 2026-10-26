import type { BenchmarkUsageCostRow } from "@/lib/benchmark/usage-costs";

const dollars = (value: number | null) => value === null ? "Unavailable" : `$${value.toFixed(value < 1 ? 6 : 4)}`;
const count = (value: number) => value.toLocaleString();

export function BenchmarkUsageCosts({ certified }: { certified: unknown }) {
  const rows = certified && typeof certified === "object" && Array.isArray((certified as { usageCosts?: unknown }).usageCosts)
    ? (certified as { usageCosts: BenchmarkUsageCostRow[] }).usageCosts : [];
  return (
    <section className="overflow-hidden rounded-xl border bg-card" aria-labelledby="benchmark-cost-heading">
      <div className="space-y-1 p-4">
        <h2 id="benchmark-cost-heading" className="font-semibold">Cost per benchmark run</h2>
        <p className="max-w-4xl text-xs leading-relaxed text-muted-foreground">Calculated API cost uses provider-reported tokens and the saved model rates, including cache pricing. Missing token usage is estimated and labeled. Provider-reported USD is optional and shown separately when returned. Time-of-day discounts, negotiated prices, and fees can change provider totals.</p>
        <p className="text-xs text-muted-foreground">Updates during a live run as calls settle. Failed and cancelled runs remain visible. Unsettled requests and charges not returned by the provider are not a final invoice.</p>
      </div>
      {rows.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">No benchmark usage recorded yet.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-y bg-muted/30 text-xs text-muted-foreground"><tr>
              <th className="px-4 py-2 text-left">Benchmark / model</th><th className="px-3 py-2 text-right">Settled calls</th><th className="px-3 py-2 text-right">Input / output tokens</th><th className="px-3 py-2 text-right">Calculated API cost</th><th className="px-3 py-2 text-right">Provider-reported USD</th>
            </tr></thead>
            <tbody className="divide-y">{rows.map(row => <tr key={row.runId}>
              <td className="max-w-sm break-words px-4 py-3"><div className="font-medium">{row.suite}</div><div className="text-xs text-muted-foreground">{row.models.join(", ") || "Model pending"}</div><div className="text-xs text-muted-foreground">{row.status} · {row.startedAt.replace("T", " ").slice(0, 19)} UTC</div></td>
              <td className="px-3 py-3 text-right tabular-nums">{row.calls}</td>
              <td className="px-3 py-3 text-right tabular-nums"><div>{count(row.inputTokens)} / {count(row.outputTokens)}</div><div className="text-[11px] text-muted-foreground">{count(row.cachedInputTokens)} cached input</div><div className="text-[11px] text-muted-foreground">{row.estimatedTokenCalls ? `${row.estimatedTokenCalls} calls with estimated/missing usage` : row.calls ? "Provider-reported tokens" : "No settled usage"}</div></td>
              <td className="px-3 py-3 text-right tabular-nums"><div>{dollars(row.calculatedUsd)}</div><div className="text-[11px] text-muted-foreground">{row.calculatedCalls}/{row.calls} calls priced</div></td>
              <td className="px-3 py-3 text-right tabular-nums"><div>{dollars(row.providerUsd)}</div><div className="text-[11px] text-muted-foreground">{row.providerCalls}/{row.calls} calls reported</div></td>
            </tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}
