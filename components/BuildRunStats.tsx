"use client";

import { AlertTriangle, BarChart3, GitBranch } from "lucide-react";
import { formatTokenCount } from "@/lib/client/token-usage";
import type { BuildRunPolicy, BuildStopReason, BuildUsageWindow } from "@/lib/db/schema";
import { buildRunPolicyLabel } from "@/lib/orchestrator/build-policy";

interface BuildRunStatsProps {
  status: string;
  policy: BuildRunPolicy;
  budgetUsd: number;
  timeLimitMinutes: number;
  stopReason?: BuildStopReason | null;
  branch?: string | null;
  prUrl?: string | null;
  usage?: BuildUsageWindow | null;
}

function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return `${hours}h ${rest}m`;
  }
  return `${minutes}m ${seconds}s`;
}

export function BuildRunStats({
  status,
  policy,
  budgetUsd,
  timeLimitMinutes,
  stopReason,
  branch,
  prUrl,
  usage,
}: BuildRunStatsProps) {
  const models = usage?.models ?? [];
  const calls = models.reduce((sum, model) => sum + model.calls, 0);
  const inputTokens = models.reduce((sum, model) => sum + model.inputTokens, 0);
  const outputTokens = models.reduce((sum, model) => sum + model.outputTokens, 0);
  const totalTokens = models.reduce((sum, model) => sum + model.totalTokens, 0);
  const hasUnknownPricing = (usage?.unknownPricedModelIds.length ?? 0) > 0;

  return (
    <section className="rounded-lg border bg-card shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Build run stats</h2>
            <p className="truncate text-xs text-muted-foreground">
              {buildRunPolicyLabel(policy)} · {stopReason ? `${status} (${stopReason})` : status}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {branch && (
            <span className="inline-flex max-w-[16rem] items-center gap-1 rounded-md border bg-background px-2 py-1">
              <GitBranch className="h-3 w-3 shrink-0" />
              <span className="truncate">{branch}</span>
            </span>
          )}
          {prUrl && (
            <a
              href={prUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-md border bg-background px-2 py-1 underline-offset-2 hover:underline"
            >
              Pull request
            </a>
          )}
        </div>
      </div>

      <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Calls" value={String(calls)} />
        <Stat
          label="Tokens"
          value={formatTokenCount(totalTokens)}
          detail={`${formatTokenCount(inputTokens)} in / ${formatTokenCount(outputTokens)} out`}
        />
        <Stat
          label="Estimated USD"
          value={formatUsd(usage?.estimatedUsd ?? 0)}
          detail={hasUnknownPricing ? "partial estimate" : "priced calls only"}
        />
        <Stat
          label="Limits"
          value={`${budgetUsd > 0 ? formatUsd(budgetUsd) : "No USD cap"} / ${
            timeLimitMinutes > 0 ? `${timeLimitMinutes}m` : "No time cap"
          }`}
          detail={formatDuration(usage?.elapsedMs ?? 0)}
        />
      </div>

      {hasUnknownPricing && (
        <div className="flex items-start gap-2 border-t border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            Partial USD estimate: {usage?.unknownPricedModelIds.length} model
            {usage?.unknownPricedModelIds.length === 1 ? "" : "s"} missing pricing.
          </span>
        </div>
      )}

      {models.length > 0 ? (
        <div className="overflow-x-auto px-4 py-3">
          <table className="w-full min-w-[42rem] text-sm">
            <thead className="border-b text-xs text-muted-foreground">
              <tr>
                <th className="pb-2 text-left font-medium">Model</th>
                <th className="pb-2 text-right font-medium">Calls</th>
                <th className="pb-2 text-right font-medium">Input</th>
                <th className="pb-2 text-right font-medium">Output</th>
                <th className="pb-2 text-right font-medium">Total</th>
                <th className="pb-2 text-right font-medium">USD</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => (
                <tr key={model.modelId} className="border-b last:border-0">
                  <td className="py-2 pr-3">
                    <div className="font-medium">{model.modelName}</div>
                    <div className="font-mono text-[0.65rem] text-muted-foreground">
                      {model.providerId}
                    </div>
                  </td>
                  <td className="py-2 text-right tabular-nums">{model.calls}</td>
                  <td className="py-2 text-right tabular-nums">
                    {formatTokenCount(model.inputTokens)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatTokenCount(model.outputTokens)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {formatTokenCount(model.totalTokens)}
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {model.estimatedUsd == null ? "unknown" : formatUsd(model.estimatedUsd)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground">
          No Build token usage has been recorded yet.
        </p>
      )}
    </section>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 truncate font-mono text-sm font-semibold tabular-nums">{value}</div>
      {detail && <div className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}
