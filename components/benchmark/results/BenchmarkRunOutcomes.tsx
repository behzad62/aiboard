import type { BenchmarkRunOutcome } from "@/lib/benchmark/run-outcomes";

export function BenchmarkRunOutcomes({ certified }: { certified: unknown }) {
  const rows = certified && typeof certified === "object" && Array.isArray((certified as { runOutcomes?: unknown }).runOutcomes)
    ? (certified as { runOutcomes: BenchmarkRunOutcome[] }).runOutcomes : [];
  if (!rows.length) return null;
  return (
    <section className="overflow-hidden rounded-xl border bg-card" aria-labelledby="benchmark-outcomes-heading">
      <div className="space-y-1 p-4">
        <h2 id="benchmark-outcomes-heading" className="font-semibold">Recorded benchmark outcomes</h2>
        <p className="text-xs text-muted-foreground">Case outcomes stay visible for every run. Budget failures count as failures; harness, provider, and environment errors are excluded from model scoring. A batch with excluded or missing evidence cannot receive a leaderboard ranking.</p>
      </div>
      <div className="divide-y border-t">{rows.map((row, index) => (
        <details key={row.id} open={index === 0}>
          <summary className="cursor-pointer space-y-1 p-4 text-sm">
            <span className="font-semibold">{row.tracks.join(" + ")} · {row.subject}</span>
            <span className="ml-3 text-xs font-medium">{row.status === "pending" ? "Running" : row.ranked ? "Published" : row.status === "cancelled" ? "Cancelled" : "Finished · not ranked"}</span>
            <span className="block text-xs text-muted-foreground">{row.recorded}/{row.expected} cases recorded · {row.passed} passed · {row.failed} failed · {row.excluded} excluded</span>
          </summary>
          <div className="space-y-2 px-4 pb-3 text-xs text-muted-foreground">
            <p>{row.configuration}</p>
            <p>Started {formatDate(row.startedAt)}{row.terminalAt ? ` · Finished ${formatDate(row.terminalAt)}` : ""}</p>
            {!row.ranked && row.excluded > 0 && <p className="text-amber-700 dark:text-amber-300">Not ranked: {row.excluded} cases have excluded errors. Review the case reasons below.</p>}
            {row.failure && <details><summary className="cursor-pointer">Run diagnostics</summary><p className="mt-1 break-words">{row.failure}</p></details>}
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-y bg-muted/30 text-xs text-muted-foreground"><tr><th className="px-4 py-2 text-left">Case / reason</th><th className="px-3 py-2 text-left">Outcome</th><th className="px-3 py-2 text-right">Input / output tokens</th><th className="px-3 py-2 text-right">Calculated cost</th><th className="px-3 py-2 text-right">Time</th></tr></thead>
              <tbody className="divide-y">{row.cases.map(item => <tr key={item.key}>
                <td className="max-w-xl px-4 py-3"><div className="font-medium">{item.title}</div>{item.reason && <p className="mt-1 break-words text-xs text-muted-foreground">{formatOutcomeReason(item.status, item.reason)}</p>}</td>
                <td className="whitespace-nowrap px-3 py-3 text-xs">{outcomeLabel(item.status, row.status === "pending")}</td>
                <td className="px-3 py-3 text-right text-xs tabular-nums">{item.inputTokens === null ? "—" : `${item.inputTokens.toLocaleString()} / ${item.outputTokens?.toLocaleString()}`}</td>
                <td className="px-3 py-3 text-right tabular-nums">{item.costUsd === null ? "Unavailable" : `$${item.costUsd.toFixed(6)}`}</td>
                <td className="whitespace-nowrap px-3 py-3 text-right tabular-nums">{item.durationMs === null ? "—" : `${(item.durationMs / 1000).toFixed(1)} s`}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </details>
      ))}</div>
    </section>
  );
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString(undefined, {dateStyle:"medium", timeStyle:"short"});
}

function outcomeLabel(status: string, running: boolean): string {
  const labels: Record<string, string> = {passed:"Passed", failed_budget:"Failed · budget exhausted", failed_tool_use:"Failed · tool use", failed_model:"Failed · model", failed_verifier:"Failed · verification", invalid_harness:"Excluded · harness error", invalid_environment:"Excluded · environment error", invalid_case:"Excluded · case error", provider_unavailable:"Excluded · provider unavailable", aborted_user:"Cancelled", conflicting_records:"Excluded · conflicting records"};
  return status === "not_recorded" ? running ? "Pending" : "Not completed" : labels[status] ?? status;
}

function formatOutcomeReason(status: string, reason: string): string {
  const budget = status === "failed_budget" ? /Budget (\w+) .*would reach (\d+), above limit (\d+)/.exec(reason) : null;
  if (!budget) return reason;
  const labels: Record<string, string> = {inputTokens:"input-token", outputTokens:"output-token", modelCalls:"model-call", toolCalls:"tool-call"};
  return `Next call would exceed the ${labels[budget[1]] ?? budget[1]} budget (${Number(budget[2]).toLocaleString()} > ${Number(budget[3]).toLocaleString()}).`;
}
