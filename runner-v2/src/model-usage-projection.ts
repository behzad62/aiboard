import type {
  BudgetProjection,
  ModelCallRole,
  ModelTokenSource,
} from "./budget-ledger.js";
import type { ProviderUsageConfig } from "./provider-config-store.js";
import type { ProviderFailureKind, ProviderHealthState } from "./provider-health.js";

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
  displayName?: string;
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
  cooldownUntil?: number;
  failureCode?: ProviderFailureKind;
  failureSummary?: string;
}

export interface NativeBuildUsageProjection extends BudgetProjection {
  models: NativeModelUsageProjection[];
  attributedModelReservationCount: number;
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
  inconsistentCacheTokens: boolean;
  tokenSources: ModelTokenSource[];
  missingTokenSources: boolean;
  costBasisKinds: NativeModelCostBasis[];
  missingCostBasis: boolean;
  settledCostMicros: number;
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
    const actualInputTokens = reservation.actual.inputTokens ?? 0;
    const actualCachedInputTokens = reservation.actual.cachedInputTokens ?? 0;
    const actualCacheWriteInputTokens =
      reservation.actual.cacheWriteInputTokens ?? 0;
    if (hasInconsistentCacheTokens(
      actualInputTokens,
      actualCachedInputTokens,
      actualCacheWriteInputTokens
    )) {
      usage.inconsistentCacheTokens = true;
    }
    usage.inputTokens = checkedAdd(
      usage.inputTokens,
      actualInputTokens,
      "inputTokens",
      runtime.runtimeId
    );
    usage.cachedInputTokens = checkedAdd(
      usage.cachedInputTokens,
      actualCachedInputTokens,
      "cachedInputTokens",
      runtime.runtimeId
    );
    usage.cacheWriteInputTokens = checkedAdd(
      usage.cacheWriteInputTokens,
      actualCacheWriteInputTokens,
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
    if (reservation.costBasis) {
      usage.costBasisKinds.push(reservation.costBasis.kind);
    } else {
      usage.missingCostBasis = true;
    }
    usage.settledCostMicros = checkedAdd(
      usage.settledCostMicros,
      reservation.actual.estimatedCostMicros ?? 0,
      "estimatedCostMicros",
      runtime.runtimeId
    );
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
      const health = healthByProvider.get(runtime.providerId);
      return {
        runtimeId: runtime.runtimeId,
        providerId: runtime.providerId,
        modelId: runtime.modelId,
        ...(runtime.displayName ? { displayName: runtime.displayName } : {}),
        roles: [...usage.roles].sort(
          (left, right) => ROLE_ORDER[left] - ROLE_ORDER[right]
        ),
        status: projectStatus(
          runtime,
          usage.calls,
          health,
          now
        ),
        ...operationalMetadata(health, now),
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

const SAFE_FAILURE_SUMMARIES: Record<ProviderFailureKind, string> = {
  usage_limit: "Usage limit reached.",
  rate_limit: "Rate limited.",
  authentication: "Authentication failed.",
  provider_unavailable: "Provider unavailable.",
  transient: "Temporary provider failure.",
  invalid_request: "Provider rejected the request.",
  cancelled: "Request cancelled.",
};

function operationalMetadata(
  health: ProviderHealthState | undefined,
  now: number
): Pick<
  NativeModelUsageProjection,
  "cooldownUntil" | "failureCode" | "failureSummary"
> {
  if (!health?.failureKind) return {};
  return {
    ...(health.status === "cooldown" &&
    health.cooldownUntil !== undefined &&
    health.cooldownUntil > now
      ? { cooldownUntil: health.cooldownUntil }
      : {}),
    failureCode: health.failureKind,
    failureSummary: SAFE_FAILURE_SUMMARIES[health.failureKind],
  };
}

function emptyMutableUsage(roles: readonly ModelCallRole[]): MutableUsage {
  return {
    roles: new Set(roles),
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    inconsistentCacheTokens: false,
    tokenSources: [],
    missingTokenSources: false,
    costBasisKinds: [],
    missingCostBasis: false,
    settledCostMicros: 0,
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
  if (usage.calls > 0) {
    if (usage.missingCostBasis || usage.costBasisKinds.includes("unknown")) {
      return { estimatedCostMicros: null, costBasis: "unknown" };
    }
    if (usage.costBasisKinds.every((basis) => basis === "account_not_metered")) {
      return { estimatedCostMicros: null, costBasis: "account_not_metered" };
    }
    if (usage.costBasisKinds.every((basis) => basis === "api_estimate")) {
      return {
        estimatedCostMicros: usage.settledCostMicros,
        costBasis: "api_estimate",
      };
    }
    return { estimatedCostMicros: null, costBasis: "unknown" };
  }
  if (runtime.billingBasis === "account_not_metered") {
    return { estimatedCostMicros: null, costBasis: "account_not_metered" };
  }
  return runtime.billingBasis === "api_priced" &&
    runtime.inputCostMicrosPerMillion !== undefined &&
    runtime.outputCostMicrosPerMillion !== undefined
    ? { estimatedCostMicros: 0, costBasis: "api_estimate" }
    : { estimatedCostMicros: null, costBasis: "unknown" };
}

function hasInconsistentCacheTokens(
  inputTokens: number,
  cachedInputTokens: number,
  cacheWriteInputTokens: number
): boolean {
  return (
    cachedInputTokens > inputTokens ||
    cacheWriteInputTokens > inputTokens ||
    BigInt(cachedInputTokens) + BigInt(cacheWriteInputTokens) >
      BigInt(inputTokens)
  );
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
