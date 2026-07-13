import type {
  BudgetProjection,
  ModelCallRole,
  ModelTokenSource,
} from "./budget-ledger.js";
import type { ProviderUsageConfig } from "./provider-config-store.js";
import type { ProviderHealthState } from "./provider-health.js";

export type NativeModelUsageStatus =
  | "healthy"
  | "cooldown"
  | "unavailable"
  | "unused";

export type NativeModelCostBasis =
  | "api_estimate"
  | "account_not_metered"
  | "unknown";

export type NativeModelUsageQuality =
  | "reported"
  | "mixed"
  | "estimated"
  | "none";

export interface NativeModelUsageRuntime extends ProviderUsageConfig {
  roles: readonly ModelCallRole[];
  selectable: boolean;
}

export interface NativeModelUsageProjection {
  runtimeId: string;
  providerId: string;
  modelId: string;
  roles: ModelCallRole[];
  status: NativeModelUsageStatus;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostMicros: number | null;
  costBasis: NativeModelCostBasis;
  usageQuality: NativeModelUsageQuality;
  lastUsedAt: string | null;
}

export interface NativeBuildUsageProjection extends BudgetProjection {
  models: NativeModelUsageProjection[];
}

export interface ProjectNativeModelUsageInput {
  budget: BudgetProjection;
  runtimes: readonly NativeModelUsageRuntime[];
  providerHealth: readonly ProviderHealthState[];
  now?: number;
}

interface MutableUsage {
  roles: Set<ModelCallRole>;
  calls: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  tokenSources: ModelTokenSource[];
  missingTokenSources: boolean;
  lastUsedAt: string | null;
}

const ROLE_ORDER: Record<ModelCallRole, number> = {
  architect: 0,
  worker: 1,
  subagent: 2,
};

export function projectNativeModelUsage(
  input: ProjectNativeModelUsageInput
): NativeModelUsageProjection[] {
  const runtimeById = new Map(
    input.runtimes.map((runtime) => [runtime.runtimeId, runtime])
  );
  const healthByProvider = new Map(
    input.providerHealth.map((health) => [health.providerId, health])
  );
  const usageByRuntime = new Map<string, MutableUsage>();

  for (const runtime of input.runtimes) {
    if (usageByRuntime.has(runtime.runtimeId)) {
      throw new Error(`Duplicate model usage runtime ${runtime.runtimeId}.`);
    }
    usageByRuntime.set(runtime.runtimeId, emptyMutableUsage(runtime.roles));
  }

  for (const reservation of Object.values(input.budget.reservations)) {
    if (
      reservation.kind !== "model" ||
      reservation.status !== "settled" ||
      !reservation.actual ||
      !reservation.attribution
    ) continue;
    const runtime = runtimeById.get(reservation.attribution.runtimeId);
    if (!runtime) continue;
    if (
      runtime.providerId !== reservation.attribution.providerId ||
      runtime.modelId !== reservation.attribution.modelId
    ) {
      throw new Error(
        `Model usage attribution conflicts with runtime ${runtime.runtimeId}.`
      );
    }
    const usage = usageByRuntime.get(runtime.runtimeId)!;
    usage.calls = checkedAdd(usage.calls, 1, "calls", runtime.runtimeId);
    usage.roles.add(reservation.attribution.role);
    usage.inputTokens = checkedAdd(
      usage.inputTokens,
      reservation.actual.inputTokens ?? 0,
      "inputTokens",
      runtime.runtimeId
    );
    usage.cachedInputTokens = checkedAdd(
      usage.cachedInputTokens,
      reservation.actual.cachedInputTokens ?? 0,
      "cachedInputTokens",
      runtime.runtimeId
    );
    usage.cacheWriteInputTokens = checkedAdd(
      usage.cacheWriteInputTokens,
      reservation.actual.cacheWriteInputTokens ?? 0,
      "cacheWriteInputTokens",
      runtime.runtimeId
    );
    usage.outputTokens = checkedAdd(
      usage.outputTokens,
      reservation.actual.outputTokens ?? 0,
      "outputTokens",
      runtime.runtimeId
    );
    if (reservation.tokenSources) {
      usage.tokenSources.push(
        reservation.tokenSources.inputTokens,
        reservation.tokenSources.outputTokens
      );
    } else {
      usage.missingTokenSources = true;
    }
    if (
      reservation.settledAt &&
      (!usage.lastUsedAt || reservation.settledAt > usage.lastUsedAt)
    ) {
      usage.lastUsedAt = reservation.settledAt;
    }
  }

  const now = input.now ?? Date.now();
  return [...input.runtimes]
    .sort((left, right) => left.runtimeId.localeCompare(right.runtimeId))
    .map((runtime) => {
      const usage = usageByRuntime.get(runtime.runtimeId)!;
      const cost = projectCost(runtime, usage);
      return {
        runtimeId: runtime.runtimeId,
        providerId: runtime.providerId,
        modelId: runtime.modelId,
        roles: [...usage.roles].sort(
          (left, right) => ROLE_ORDER[left] - ROLE_ORDER[right]
        ),
        status: projectStatus(
          runtime,
          usage.calls,
          healthByProvider.get(runtime.providerId),
          now
        ),
        calls: usage.calls,
        inputTokens: usage.inputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: checkedAdd(
          usage.inputTokens,
          usage.outputTokens,
          "totalTokens",
          runtime.runtimeId
        ),
        ...cost,
        usageQuality: projectUsageQuality(usage),
        lastUsedAt: usage.lastUsedAt,
      };
    });
}

function emptyMutableUsage(roles: readonly ModelCallRole[]): MutableUsage {
  return {
    roles: new Set(roles),
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    tokenSources: [],
    missingTokenSources: false,
    lastUsedAt: null,
  };
}

function projectStatus(
  runtime: NativeModelUsageRuntime,
  calls: number,
  health: ProviderHealthState | undefined,
  now: number
): NativeModelUsageStatus {
  if (!runtime.selectable) return "unavailable";
  if (
    health?.status === "cooldown" &&
    (health.cooldownUntil === undefined || health.cooldownUntil > now)
  ) return "cooldown";
  return calls === 0 ? "unused" : "healthy";
}

function projectUsageQuality(usage: MutableUsage): NativeModelUsageQuality {
  if (usage.calls === 0) return "none";
  if (usage.missingTokenSources) return "mixed";
  if (usage.tokenSources.every((source) => source === "reported")) {
    return "reported";
  }
  if (usage.tokenSources.every((source) => source === "estimated")) {
    return "estimated";
  }
  return "mixed";
}

function projectCost(
  runtime: NativeModelUsageRuntime,
  usage: MutableUsage
): Pick<NativeModelUsageProjection, "estimatedCostMicros" | "costBasis"> {
  if (runtime.transport === "account-runner") {
    return { estimatedCostMicros: null, costBasis: "account_not_metered" };
  }
  if (
    usage.cachedInputTokens > usage.inputTokens ||
    usage.cacheWriteInputTokens > usage.inputTokens ||
    BigInt(usage.cachedInputTokens) + BigInt(usage.cacheWriteInputTokens) >
      BigInt(usage.inputTokens)
  ) {
    return { estimatedCostMicros: null, costBasis: "unknown" };
  }
  const cached = usage.cachedInputTokens;
  const cacheWrite = usage.cacheWriteInputTokens;
  const uncached = usage.inputTokens - cached - cacheWrite;
  if (
    (usage.calls === 0 &&
      (runtime.inputCostMicrosPerMillion === undefined ||
        runtime.outputCostMicrosPerMillion === undefined)) ||
    (uncached > 0 && runtime.inputCostMicrosPerMillion === undefined) ||
    (cached > 0 && runtime.cachedInputCostMicrosPerMillion === undefined) ||
    (cacheWrite > 0 &&
      runtime.cacheWriteInputCostMicrosPerMillion === undefined) ||
    (usage.outputTokens > 0 &&
      runtime.outputCostMicrosPerMillion === undefined)
  ) {
    return { estimatedCostMicros: null, costBasis: "unknown" };
  }
  const numerator =
    BigInt(uncached) * BigInt(runtime.inputCostMicrosPerMillion ?? 0) +
    BigInt(cached) * BigInt(runtime.cachedInputCostMicrosPerMillion ?? 0) +
    BigInt(cacheWrite) *
      BigInt(runtime.cacheWriteInputCostMicrosPerMillion ?? 0) +
    BigInt(usage.outputTokens) *
      BigInt(runtime.outputCostMicrosPerMillion ?? 0);
  const estimatedCostMicros = (numerator + 500_000n) / 1_000_000n;
  if (estimatedCostMicros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `Estimated model cost for ${runtime.runtimeId} exceeds the safe integer range.`
    );
  }
  return {
    estimatedCostMicros: Number(estimatedCostMicros),
    costBasis: "api_estimate",
  };
}

function checkedAdd(
  left: number,
  right: number,
  dimension: string,
  runtimeId: string
): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) {
    throw new Error(
      `Model usage ${dimension} for ${runtimeId} exceeds the safe integer range.`
    );
  }
  const sum = BigInt(left) + BigInt(right);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `Model usage ${dimension} for ${runtimeId} exceeds the safe integer range.`
    );
  }
  return Number(sum);
}
