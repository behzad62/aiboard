import type { BuildUsageModelTotal } from "@/lib/db/schema";
import type {
  NativeBuildUsageProjection,
  NativeModelUsageProjection,
} from "@/lib/client/runner-v2";

interface WeightedIdentity {
  model: NativeModelUsageProjection;
  weight: number;
}

export function mapNativeBuildUsageModels(
  projection: NativeBuildUsageProjection
): BuildUsageModelTotal[] {
  const models = projection.models ?? [];
  if (models.some((model) => model.calls > 0) || !hasAggregateUsage(projection)) {
    return models.map(mapNativeRow);
  }

  if (models.length === 0) {
    return [legacyAggregateRow(projection)];
  }

  return legacyPreviewRows(projection, models);
}

function mapNativeRow(model: NativeModelUsageProjection): BuildUsageModelTotal {
  return {
    runtimeId: model.runtimeId,
    modelId: model.modelId,
    modelName: model.modelId,
    providerId: model.providerId,
    roles: [...model.roles],
    status: model.status,
    calls: model.calls,
    inputTokens: model.inputTokens,
    cachedInputTokens: model.cachedInputTokens,
    cacheWriteInputTokens: model.cacheWriteInputTokens,
    outputTokens: model.outputTokens,
    totalTokens: model.totalTokens,
    estimatedUsd:
      model.estimatedCostMicros === null
        ? null
        : model.estimatedCostMicros / 1_000_000,
    priced: model.estimatedCostMicros !== null,
    usageQuality: model.usageQuality,
    costBasis: model.costBasis,
    lastUsedAt: model.lastUsedAt,
    usageOrigin: "native",
  };
}

function legacyPreviewRows(
  projection: NativeBuildUsageProjection,
  models: readonly NativeModelUsageProjection[]
): BuildUsageModelTotal[] {
  const identities = distinctRuntimeIdentities(models);
  const calls = allocateLargestRemainder(
    projection.effective.modelCalls,
    identities
  );
  const inputTokens = allocateLargestRemainder(
    projection.effective.inputTokens,
    identities
  );
  const cachedInputTokens = allocateLargestRemainder(
    projection.effective.cachedInputTokens ?? 0,
    identities
  );
  const cacheWriteInputTokens = allocateLargestRemainder(
    projection.effective.cacheWriteInputTokens ?? 0,
    identities
  );
  const outputTokens = allocateLargestRemainder(
    projection.effective.outputTokens,
    identities
  );

  return identities.map(({ model }, index) => ({
    runtimeId: model.runtimeId,
    modelId: model.modelId,
    modelName: `${model.modelId} (legacy estimate)`,
    providerId: model.providerId,
    roles: [...model.roles],
    status: model.status,
    calls: calls[index],
    inputTokens: inputTokens[index],
    cachedInputTokens: cachedInputTokens[index],
    cacheWriteInputTokens: cacheWriteInputTokens[index],
    outputTokens: outputTokens[index],
    totalTokens: inputTokens[index] + outputTokens[index],
    estimatedUsd: null,
    priced: false,
    usageQuality: "estimated",
    costBasis: model.costBasis,
    lastUsedAt: model.lastUsedAt,
    usageOrigin: "legacy_preview",
  }));
}

function distinctRuntimeIdentities(
  models: readonly NativeModelUsageProjection[]
): WeightedIdentity[] {
  const byRuntime = new Map<string, NativeModelUsageProjection>();
  for (const model of models) {
    if (!byRuntime.has(model.runtimeId)) byRuntime.set(model.runtimeId, model);
  }
  return [...byRuntime.values()]
    .sort((left, right) => compareRuntimeIds(left.runtimeId, right.runtimeId))
    .map((model) => ({ model, weight: roleWeight(model) }));
}

function roleWeight(model: NativeModelUsageProjection): number {
  const roles = new Set(model.roles);
  const weight = (roles.has("architect") ? 2 : 0) +
    (roles.has("worker") ? 1 : 0);
  return weight || 1;
}

function allocateLargestRemainder(
  amount: number,
  identities: readonly WeightedIdentity[]
): number[] {
  const totalWeight = identities.reduce(
    (sum, identity) => sum + identity.weight,
    0
  );
  const denominator = BigInt(totalWeight);
  const numerator = BigInt(amount);
  const allocations = identities.map((identity) => {
    const weighted = numerator * BigInt(identity.weight);
    return {
      value: Number(weighted / denominator),
      remainder: weighted % denominator,
      runtimeId: identity.model.runtimeId,
    };
  });
  const remaining =
    amount - allocations.reduce((sum, row) => sum + row.value, 0);
  const remainderOrder = [...allocations].sort((left, right) => {
    if (left.remainder !== right.remainder) {
      return left.remainder > right.remainder ? -1 : 1;
    }
    return compareRuntimeIds(left.runtimeId, right.runtimeId);
  });
  for (let index = 0; index < remaining; index += 1) {
    remainderOrder[index].value += 1;
  }
  return allocations.map((row) => row.value);
}

function compareRuntimeIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function hasAggregateUsage(projection: NativeBuildUsageProjection): boolean {
  const usage = projection.effective;
  return (
    usage.modelCalls > 0 ||
    usage.inputTokens > 0 ||
    (usage.cachedInputTokens ?? 0) > 0 ||
    (usage.cacheWriteInputTokens ?? 0) > 0 ||
    usage.outputTokens > 0
  );
}

function legacyAggregateRow(
  projection: NativeBuildUsageProjection
): BuildUsageModelTotal {
  const usage = projection.effective;
  return {
    modelId: "runner-v2:aggregate",
    modelName: "Runner V2 models (legacy aggregate)",
    providerId: "runner-v2",
    roles: [],
    calls: usage.modelCalls,
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    cacheWriteInputTokens: usage.cacheWriteInputTokens ?? 0,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    estimatedUsd: null,
    priced: false,
    usageQuality: "estimated",
    costBasis: "unknown",
    lastUsedAt: null,
    usageOrigin: "legacy_aggregate",
  };
}
