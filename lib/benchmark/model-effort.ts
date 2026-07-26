import type { ReasoningEffort } from "../db/schema";
import { REASONING_OPTIONS } from "../orchestrator/config";
import { parseModelId, type SelectedModel } from "../providers/base";
import { providerSupportsReasoningEffortFeature } from "../providers/provider-registry";

export type BenchmarkModelEffortMap = Record<string, ReasoningEffort>;

export const BENCHMARK_REASONING_EFFORTS: ReasoningEffort[] = [
  "default",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const BENCHMARK_REASONING_EFFORT_SET = new Set<ReasoningEffort>(
  BENCHMARK_REASONING_EFFORTS
);

type BenchmarkModel = Pick<SelectedModel, "modelId" | "providerId">;

function providerModelName(modelId: string): string {
  const parsed = parseModelId(modelId);
  return parsed.model || modelId;
}

function hasModelPrefix(model: string, prefix: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized === prefix ||
    normalized.startsWith(`${prefix}-`) ||
    normalized.startsWith(`${prefix}@`)
  );
}

function anthropicEfforts(model: string): ReasoningEffort[] {
  const adaptive =
    hasModelPrefix(model, "claude-fable-5") ||
    hasModelPrefix(model, "claude-mythos-5") ||
    hasModelPrefix(model, "claude-mythos-preview") ||
    hasModelPrefix(model, "claude-opus-5") ||
    hasModelPrefix(model, "claude-opus-4-8") ||
    hasModelPrefix(model, "claude-opus-4-7") ||
    hasModelPrefix(model, "claude-opus-4-6") ||
    hasModelPrefix(model, "claude-sonnet-5") ||
    hasModelPrefix(model, "claude-sonnet-4-6");

  if (adaptive) {
    return ["default", "low", "medium", "high", "xhigh", "max"];
  }
  if (hasModelPrefix(model, "claude-opus-4-5")) {
    return ["default", "low", "medium", "high"];
  }
  return ["default"];
}

function googleEfforts(model: string): ReasoningEffort[] {
  const normalized = model.trim().toLowerCase();
  if (normalized === "gemini-3.6-flash") {
    return ["default", "medium", "high"];
  }
  if (/gemini-3/i.test(normalized)) {
    return normalized.includes("pro") && !normalized.startsWith("gemini-3.5-")
      ? ["default", "low", "high"]
      : ["default", "none", "low", "medium", "high"];
  }
  return ["default", "none", "low", "medium", "high", "max"];
}

export function normalizeBenchmarkReasoningEffort(
  value: unknown
): ReasoningEffort {
  return typeof value === "string" &&
    BENCHMARK_REASONING_EFFORT_SET.has(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : "default";
}

export function benchmarkEffortForModel(
  map: BenchmarkModelEffortMap,
  modelId: string
): ReasoningEffort {
  return normalizeBenchmarkReasoningEffort(map[modelId]);
}

export function benchmarkVariantKey(modelId: string, effort: unknown): string {
  return `${modelId}\u0000${normalizeBenchmarkReasoningEffort(effort)}`;
}

export function benchmarkVariantLabel(
  displayName: string,
  effort: unknown
): string {
  const normalized = normalizeBenchmarkReasoningEffort(effort);
  const option = REASONING_OPTIONS.find(({ value }) => value === normalized);
  const label =
    normalized === "default" ? "Default" : (option?.label ?? normalized);
  return `${displayName} · ${label}`;
}

export function supportedBenchmarkReasoningEfforts(
  model: BenchmarkModel
): ReasoningEffort[] {
  const providerId = model.providerId.trim().toLowerCase();
  const providerModel = providerModelName(model.modelId);
  if (!providerSupportsReasoningEffortFeature(providerId, providerModel)) {
    return ["default"];
  }

  if (providerId === "openai" || providerId === "chatgpt") {
    const efforts: ReasoningEffort[] = [
      "default",
      "none",
      "low",
      "medium",
      "high",
      "xhigh",
    ];
    return providerModel.trim().toLowerCase().startsWith("gpt-5.6")
      ? [...efforts, "max"]
      : efforts;
  }
  if (providerId === "github-copilot") {
    return providerModel.trim().toLowerCase() === "gemini-3.5-flash"
      ? googleEfforts(providerModel).filter((effort) => effort !== "none")
      : ["default", "low", "medium", "high", "xhigh"];
  }
  if (providerId === "openrouter") {
    const normalized = providerModel.trim().toLowerCase();
    return normalized === "moonshotai/kimi-k3" || normalized === "kimi-k3"
      ? ["default", "max"]
      : BENCHMARK_REASONING_EFFORTS.slice();
  }
  if (providerId === "anthropic" || providerId === "foundry") {
    return anthropicEfforts(providerModel);
  }
  if (providerId === "google") {
    return googleEfforts(providerModel);
  }
  if (providerId === "xai") {
    const efforts: ReasoningEffort[] = ["default", "low", "medium", "high"];
    return providerModel.trim().toLowerCase().includes("multi-agent")
      ? [...efforts, "xhigh"]
      : efforts;
  }
  return ["default"];
}

export function normalizeBenchmarkEffortForModel(
  model: BenchmarkModel,
  effort: unknown
): ReasoningEffort {
  const normalized = normalizeBenchmarkReasoningEffort(effort);
  return supportedBenchmarkReasoningEfforts(model).includes(normalized)
    ? normalized
    : "default";
}
