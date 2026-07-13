"use client";

import { AlertTriangle, BarChart3, GitBranch } from "lucide-react";
import { buildRunWorkflowStatus } from "@/lib/client/discussion-live-state";
import { formatTokenCount } from "@/lib/client/token-usage";
import type {
  BuildRunPolicy,
  BuildStopReason,
  BuildUsageModelTotal,
  BuildUsageWindow,
} from "@/lib/db/schema";
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
  projectHandoffRequested?: boolean;
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

export function formatBuildRunStatusText(
  status: string,
  stopReason?: BuildStopReason | null,
  projectHandoffRequested = false
): string {
  return buildRunWorkflowStatus({ status, stopReason, projectHandoffRequested });
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
  projectHandoffRequested = false,
}: BuildRunStatsProps) {
  const suppliedModels = usage?.models ?? [];
  const hasNativeRows = suppliedModels.some((model) => model.usageOrigin === "native");
  const models = hasNativeRows
    ? suppliedModels.filter(
        (model) =>
          model.usageOrigin !== "legacy_aggregate" &&
          model.usageOrigin !== "legacy_preview"
      )
    : suppliedModels;
  const calls = models.reduce((sum, model) => sum + model.calls, 0);
  const inputTokens = models.reduce((sum, model) => sum + model.inputTokens, 0);
  const outputTokens = models.reduce((sum, model) => sum + model.outputTokens, 0);
  const totalTokens = models.reduce((sum, model) => sum + model.totalTokens, 0);
  const cost = summarizeCost({ usage, models, hasNativeRows });
  const hasUnknownPricing = cost.unknownModelIds.length > 0;
  const summaryStats = policy === "budgeted"
    ? [
        { label: "Calls", value: String(calls) },
        {
          label: "Tokens",
          value: formatTokenCount(totalTokens),
          detail: `${formatTokenCount(inputTokens)} in / ${formatTokenCount(outputTokens)} out`,
        },
        { label: "Active time", value: formatDuration(usage?.elapsedMs ?? 0) },
        {
          label: "Budget progress",
          value: budgetProgress({
            cost: cost.value,
            elapsedMs: usage?.elapsedMs ?? 0,
            budgetUsd,
            timeLimitMinutes,
          }),
          detail: cost.detail,
        },
      ]
    : [
        { label: "Calls", value: String(calls) },
        {
          label: "Tokens",
          value: formatTokenCount(totalTokens),
          detail: `${formatTokenCount(inputTokens)} in / ${formatTokenCount(outputTokens)} out`,
        },
        { label: "Active time", value: formatDuration(usage?.elapsedMs ?? 0) },
        { label: "Cost", value: cost.value, detail: cost.detail },
      ];

  return (
    <section className="rounded-lg border bg-card shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <BarChart3 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold">Build run stats</h2>
            <p className="text-xs text-muted-foreground">
              {buildRunPolicyLabel(policy)} · {formatBuildRunStatusText(
                status,
                stopReason,
                projectHandoffRequested
              )}
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

      <p className="border-b px-4 py-2 text-xs text-muted-foreground">
        {policyDescription(policy)}
      </p>

      <div className="grid gap-px bg-border sm:grid-cols-2 xl:grid-cols-4">
        {summaryStats.map((stat) => (
          <Stat key={stat.label} {...stat} />
        ))}
      </div>

      {hasUnknownPricing && (
        <div className="flex items-start gap-2 border-t border-amber-300 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {cost.value === "Unknown" ? "Cost unknown" : "Partial USD estimate"}: {cost.unknownModelIds.length} contributing model
            {cost.unknownModelIds.length === 1 ? "" : "s"} missing pricing.
          </span>
        </div>
      )}

      {models.length > 0 ? (
        <div className="overflow-x-auto px-4 py-3">
          <table className="w-full min-w-[68rem] text-sm">
            <caption className="sr-only">Configured Build models and usage</caption>
            <thead className="border-b text-xs text-muted-foreground">
              <tr>
                <th className="pb-2 text-left font-medium">Model</th>
                <th className="pb-2 text-left font-medium">Role</th>
                <th className="pb-2 text-left font-medium">Status</th>
                <th className="pb-2 text-left font-medium">Usage quality</th>
                <th className="pb-2 text-right font-medium">Calls</th>
                <th className="pb-2 text-right font-medium">Input</th>
                <th className="pb-2 text-right font-medium">Output</th>
                <th className="pb-2 text-right font-medium">Total</th>
                <th className="pb-2 text-right font-medium">Cost</th>
                <th className="pb-2 text-right font-medium">Last used</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model, index) => (
                <tr
                  key={`${model.runtimeId ?? model.modelId}:${index}`}
                  className="border-b last:border-0"
                >
                  <td className="py-2 pr-3">
                    <div className="font-medium">{model.modelName}</div>
                    <div className="font-mono text-[0.65rem] text-muted-foreground">
                      {model.providerId}
                    </div>
                  </td>
                  <td className="py-2 pr-3">
                    <span className="inline-flex rounded-md border bg-muted/40 px-2 py-0.5 text-xs">
                      {formatRoles(model)}
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    <ModelStatus status={model.status} />
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">
                    {formatUsageQuality(model)}
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
                    {formatModelCost(model)}
                  </td>
                  <td className="whitespace-nowrap py-2 pl-3 text-right font-mono text-xs text-muted-foreground">
                    {formatLastUsed(model.lastUsedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="border-t px-4 py-3 text-sm text-muted-foreground">
          No Build model usage has been recorded yet.
        </p>
      )}
    </section>
  );
}

function policyDescription(policy: BuildRunPolicy): string {
  if (policy === "finish") {
    return "Runs until completion, user stop, provider unavailability, permission decision, or a mechanical blocker.";
  }
  if (policy === "plan_only") {
    return "Architect planning activity only. Workers and integration stay idle.";
  }
  return "Tracks this run against the configured cost and active-time window.";
}

function hasUsage(model: BuildUsageModelTotal): boolean {
  return (
    model.calls > 0 ||
    model.inputTokens > 0 ||
    (model.cachedInputTokens ?? 0) > 0 ||
    (model.cacheWriteInputTokens ?? 0) > 0 ||
    model.outputTokens > 0 ||
    model.totalTokens > 0
  );
}

function summarizeCost(input: {
  usage?: BuildUsageWindow | null;
  models: readonly BuildUsageModelTotal[];
  hasNativeRows: boolean;
}): {
  value: string;
  detail?: string;
  unknownModelIds: string[];
} {
  const { usage, models, hasNativeRows } = input;
  if (!usage) return { value: "No usage", unknownModelIds: [] };
  const contributing = models.filter(hasUsage);
  const knownRows = contributing.filter(hasKnownModelCost);
  const accountRows = contributing.filter(
    (model) => model.costBasis === "account_not_metered"
  );
  const suppliedUnknownModelIds = new Set(usage.unknownPricedModelIds);
  const aggregateBackedLegacyEstimate =
    !hasNativeRows &&
    contributing.some(
      (model) =>
        model.usageOrigin === "legacy_preview" &&
        model.costBasis === "api_estimate"
    ) &&
    contributing.every(
      (model) =>
        model.costBasis === "account_not_metered" ||
        (model.usageOrigin === "legacy_preview" &&
          model.costBasis === "api_estimate")
    ) &&
    !contributing.some((model) => suppliedUnknownModelIds.has(model.modelId)) &&
    Number.isFinite(usage.estimatedUsd);
  const unknownRows = contributing.filter(
    (model) =>
      hasUnknownModelCost(model) &&
      !(
        aggregateBackedLegacyEstimate &&
        model.usageOrigin === "legacy_preview" &&
        model.costBasis === "api_estimate"
      )
  );
  const unknownRowIds = new Set(unknownRows.map((model) => model.modelId));
  const unknownModelIds = hasNativeRows
    ? [...unknownRowIds].sort()
    : [...suppliedUnknownModelIds]
        .filter((modelId) => unknownRowIds.has(modelId))
        .sort();
  const hasKnown = knownRows.length > 0 || aggregateBackedLegacyEstimate;
  const knownUsd = aggregateBackedLegacyEstimate
    ? usage.estimatedUsd
    : knownRows.reduce((sum, model) => sum + (model.estimatedUsd ?? 0), 0);

  if (hasKnown) {
    return {
      value: formatUsd(knownUsd),
      detail:
        unknownRows.length > 0 || accountRows.length > 0
          ? "Partial estimate"
          : "Estimated",
      unknownModelIds,
    };
  }
  if (unknownRows.length > 0) return { value: "Unknown", unknownModelIds };
  if (accountRows.length > 0) return { value: "Not metered", unknownModelIds };
  if (contributing.length === 0) {
    const configuredCostBases = models.map((model) => model.costBasis);
    if (
      configuredCostBases.length > 0 &&
      configuredCostBases.every((basis) => basis === "account_not_metered")
    ) {
      return { value: "Not metered", unknownModelIds };
    }
    if (
      configuredCostBases.length > 0 &&
      configuredCostBases.every((basis) => basis === "unknown")
    ) {
      return { value: "Unknown", unknownModelIds };
    }
  }
  return {
    value: formatUsd(0),
    detail: "Estimated",
    unknownModelIds,
  };
}

function hasKnownModelCost(model: BuildUsageModelTotal): boolean {
  return (
    model.estimatedUsd != null &&
    (model.costBasis === "api_estimate" ||
      (model.costBasis === undefined && model.priced))
  );
}

function hasUnknownModelCost(model: BuildUsageModelTotal): boolean {
  if (model.costBasis === "account_not_metered") return false;
  if (model.costBasis === "unknown") return true;
  if (model.costBasis === undefined && !model.priced) return true;
  return model.estimatedUsd == null;
}

function budgetProgress(input: {
  cost: string;
  elapsedMs: number;
  budgetUsd: number;
  timeLimitMinutes: number;
}): string {
  const parts: string[] = [];
  if (input.budgetUsd > 0) {
    parts.push(`${input.cost} / ${formatUsd(input.budgetUsd)}`);
  }
  if (input.timeLimitMinutes > 0) {
    parts.push(`${formatDuration(input.elapsedMs)} / ${input.timeLimitMinutes}m`);
  }
  return parts.length > 0 ? parts.join(" · ") : "Not configured";
}

function formatRoles(model: BuildUsageModelTotal): string {
  if (!model.roles || model.roles.length === 0) return "Legacy aggregate";
  return model.roles.map(titleCase).join(", ");
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatUsageQuality(model: BuildUsageModelTotal): string {
  if (model.usageOrigin === "legacy_preview") return "Legacy estimate";
  if (model.usageOrigin === "legacy_aggregate") return "Legacy aggregate";
  if (model.usageQuality === "reported") return "Provider-reported";
  if (model.usageQuality === "mixed") return "Mixed";
  if (model.usageQuality === "estimated") return "Estimated";
  if (model.usageQuality === undefined && hasUsage(model)) return "Legacy estimate";
  return "No usage yet";
}

function formatModelCost(model: BuildUsageModelTotal): string {
  if (model.costBasis === "account_not_metered") return "Not metered";
  if (
    model.costBasis === "unknown" ||
    (model.costBasis === undefined && !model.priced) ||
    model.estimatedUsd == null
  ) {
    return "Unknown";
  }
  return formatUsd(model.estimatedUsd);
}

function formatLastUsed(value?: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${day} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${hours}:${minutes} UTC`;
}

function ModelStatus({ status }: { status?: BuildUsageModelTotal["status"] }) {
  const value = status ? titleCase(status) : "Legacy data";
  const tone = status === "healthy"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    : status === "cooldown"
      ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
      : status === "unavailable"
        ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
        : "border-border bg-muted/40 text-muted-foreground";
  return (
    <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs ${tone}`}>
      {value}
    </span>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{value}</div>
      {detail && <div className="mt-0.5 text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}
