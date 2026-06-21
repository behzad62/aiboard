import type { BuildUsageModelTotal, BuildUsageWindow } from "@/lib/db/schema";
import type { ModelPricing } from "@/lib/providers/pricing";

export interface TokenPricingInput {
  inputTokens: number;
  outputTokens: number;
  pricing: Pick<ModelPricing, "inputUsdPer1M" | "outputUsdPer1M">;
}

export function estimatedUsdForTokens(input: TokenPricingInput): number {
  return (
    (input.inputTokens * input.pricing.inputUsdPer1M +
      input.outputTokens * input.pricing.outputUsdPer1M) /
    1_000_000
  );
}

export function createBuildUsageWindow(startedAt: string): BuildUsageWindow {
  return {
    startedAt,
    elapsedMs: 0,
    estimatedUsd: 0,
    unknownPricedModelIds: [],
    models: [],
  };
}

export function addBuildUsageCall(
  window: BuildUsageWindow,
  input: {
    modelId: string;
    modelName: string;
    providerId: string;
    inputTokens: number;
    outputTokens: number;
    pricing: Pick<ModelPricing, "inputUsdPer1M" | "outputUsdPer1M"> | null;
    elapsedMs: number;
  }
): BuildUsageWindow {
  const totalTokens = input.inputTokens + input.outputTokens;
  const callUsd = input.pricing
    ? estimatedUsdForTokens({
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        pricing: input.pricing,
      })
    : null;
  const models = window.models.map((m) => ({ ...m }));
  let model = models.find((m) => m.modelId === input.modelId);
  if (!model) {
    model = {
      modelId: input.modelId,
      modelName: input.modelName,
      providerId: input.providerId,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedUsd: input.pricing ? 0 : null,
      priced: !!input.pricing,
    } satisfies BuildUsageModelTotal;
    models.push(model);
  }
  model.calls += 1;
  model.inputTokens += input.inputTokens;
  model.outputTokens += input.outputTokens;
  model.totalTokens += totalTokens;
  model.priced = model.priced && !!input.pricing;
  model.estimatedUsd =
    model.estimatedUsd == null || callUsd == null
      ? null
      : model.estimatedUsd + callUsd;

  const unknownPricedModelIds = new Set(window.unknownPricedModelIds);
  if (!input.pricing) unknownPricedModelIds.add(input.modelId);

  return {
    startedAt: window.startedAt,
    elapsedMs: Math.max(window.elapsedMs, input.elapsedMs),
    estimatedUsd: window.estimatedUsd + (callUsd == null ? 0 : callUsd),
    unknownPricedModelIds: [...unknownPricedModelIds].sort(),
    models,
  };
}
