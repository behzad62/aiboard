import assert from "node:assert/strict";
import test from "node:test";

import type { BudgetProjection, BudgetReservationProjection } from "../src/budget-ledger.js";
import {
  projectNativeModelUsage,
  type NativeModelUsageRuntime,
} from "../src/model-usage-projection.js";
import type { ProviderHealthState } from "../src/provider-health.js";

test("projects every configured runtime with deterministic roles and truthful health", () => {
  const runtimes: NativeModelUsageRuntime[] = [
    runtime("unused", "provider-unused", "model-unused", ["worker"]),
    runtime("healthy", "provider-healthy", "model-healthy", ["worker", "architect"], {
      inputCostMicrosPerMillion: 2_000_000,
      outputCostMicrosPerMillion: 10_000_000,
      cachedInputCostMicrosPerMillion: 500_000,
      cacheWriteInputCostMicrosPerMillion: 3_000_000,
    }),
    runtime("cooldown", "provider-cooldown", "model-cooldown", ["worker"]),
    { ...runtime("unavailable", "provider-unavailable", "model-unavailable", ["worker"]), selectable: false },
  ];
  const health: ProviderHealthState[] = [{
    providerId: "provider-cooldown",
    status: "cooldown",
    consecutiveFailures: 1,
    updatedAt: 1_000,
    failureKind: "rate_limit",
    failureMessage: "slow down",
    cooldownUntil: 61_000,
  }];
  const budget = projection({
    healthy_1: settled("healthy_1", "healthy", "provider-healthy", "model-healthy", "worker", {
      inputTokens: 800,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 100,
      outputTokens: 100,
      estimatedCostMicros: 999_999,
    }, { inputTokens: "reported", outputTokens: "reported" }, "2026-07-13T10:00:00.000Z"),
    healthy_2: settled("healthy_2", "healthy", "provider-healthy", "model-healthy", "subagent", {
      inputTokens: 200,
      outputTokens: 50,
    }, { inputTokens: "reported", outputTokens: "estimated" }, "2026-07-13T10:05:00.000Z"),
    reserved: {
      reservationId: "reserved",
      kind: "model",
      attribution: attribution("healthy", "provider-healthy", "model-healthy", "architect"),
      estimate: { inputTokens: 99_999, outputTokens: 99_999 },
      status: "reserved",
      windowIndex: 1,
    },
    legacy: {
      reservationId: "legacy",
      kind: "model",
      estimate: { inputTokens: 50, outputTokens: 20 },
      actual: { inputTokens: 50, outputTokens: 20 },
      status: "settled",
      windowIndex: 1,
    },
  });

  assert.deepEqual(projectNativeModelUsage({
    budget,
    runtimes,
    providerHealth: health,
    now: 1_000,
  }), [
    {
      runtimeId: "cooldown",
      providerId: "provider-cooldown",
      modelId: "model-cooldown",
      roles: ["worker"],
      status: "cooldown",
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostMicros: null,
      costBasis: "unknown",
      usageQuality: "none",
      lastUsedAt: null,
    },
    {
      runtimeId: "healthy",
      providerId: "provider-healthy",
      modelId: "model-healthy",
      roles: ["architect", "worker", "subagent"],
      status: "healthy",
      calls: 2,
      inputTokens: 1_000,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 100,
      outputTokens: 150,
      totalTokens: 1_150,
      estimatedCostMicros: 3_300,
      costBasis: "api_estimate",
      usageQuality: "mixed",
      lastUsedAt: "2026-07-13T10:05:00.000Z",
    },
    {
      runtimeId: "unavailable",
      providerId: "provider-unavailable",
      modelId: "model-unavailable",
      roles: ["worker"],
      status: "unavailable",
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostMicros: null,
      costBasis: "unknown",
      usageQuality: "none",
      lastUsedAt: null,
    },
    {
      runtimeId: "unused",
      providerId: "provider-unused",
      modelId: "model-unused",
      roles: ["worker"],
      status: "unused",
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostMicros: null,
      costBasis: "unknown",
      usageQuality: "none",
      lastUsedAt: null,
    },
  ]);
});

test("requires pricing for consumed token classes while treating explicit zero as known", () => {
  const budget = projection({
    missing_cached_price: settled(
      "missing_cached_price",
      "missing-cached",
      "provider-missing",
      "model-missing",
      "worker",
      { inputTokens: 10, cachedInputTokens: 10, outputTokens: 1 },
      { inputTokens: "reported", outputTokens: "reported" },
      "2026-07-13T12:00:00.000Z",
    ),
    zero_price: settled(
      "zero_price",
      "zero-price",
      "provider-zero",
      "model-zero",
      "worker",
      { inputTokens: 10, outputTokens: 1 },
      { inputTokens: "reported", outputTokens: "reported" },
      "2026-07-13T12:00:00.000Z",
    ),
    missing_cache_write_price: settled(
      "missing_cache_write_price",
      "missing-cache-write",
      "provider-cache-write",
      "model-cache-write",
      "worker",
      { inputTokens: 10, cacheWriteInputTokens: 10, outputTokens: 1 },
      { inputTokens: "reported", outputTokens: "reported" },
      "2026-07-13T12:00:00.000Z",
    ),
  });

  const rows = projectNativeModelUsage({
    budget,
    runtimes: [
      runtime("missing-cached", "provider-missing", "model-missing", ["worker"], {
        inputCostMicrosPerMillion: 1_000_000,
        outputCostMicrosPerMillion: 1_000_000,
      }),
      runtime(
        "missing-cache-write",
        "provider-cache-write",
        "model-cache-write",
        ["worker"],
        {
          inputCostMicrosPerMillion: 1_000_000,
          outputCostMicrosPerMillion: 1_000_000,
        },
      ),
      runtime("zero-price", "provider-zero", "model-zero", ["worker"], {
        inputCostMicrosPerMillion: 0,
        outputCostMicrosPerMillion: 0,
      }),
      runtime("partial-unused", "provider-partial", "model-partial", ["worker"], {
        inputCostMicrosPerMillion: 1_000_000,
      }),
    ],
    providerHealth: [],
  });

  assert.deepEqual(
    rows.map((row) => ({
      runtimeId: row.runtimeId,
      estimatedCostMicros: row.estimatedCostMicros,
      costBasis: row.costBasis,
    })),
    [
      {
        runtimeId: "missing-cache-write",
        estimatedCostMicros: null,
        costBasis: "unknown",
      },
      {
        runtimeId: "missing-cached",
        estimatedCostMicros: null,
        costBasis: "unknown",
      },
      {
        runtimeId: "partial-unused",
        estimatedCostMicros: null,
        costBasis: "unknown",
      },
      {
        runtimeId: "zero-price",
        estimatedCostMicros: 0,
        costBasis: "api_estimate",
      },
    ],
  );
});

test("preserves inconsistent cache counts and makes their API cost unknown", () => {
  const budget = projection({
    sum_exceeds_input: settled(
      "sum_exceeds_input",
      "sum-exceeds",
      "provider-sum",
      "model-sum",
      "worker",
      { inputTokens: 10, cachedInputTokens: 8, cacheWriteInputTokens: 5, outputTokens: 1 },
      { inputTokens: "reported", outputTokens: "reported" },
      "2026-07-13T12:10:00.000Z",
    ),
    class_exceeds_input: settled(
      "class_exceeds_input",
      "class-exceeds",
      "provider-class",
      "model-class",
      "worker",
      { inputTokens: 10, cachedInputTokens: 11, outputTokens: 1 },
      { inputTokens: "reported", outputTokens: "reported" },
      "2026-07-13T12:10:00.000Z",
    ),
  });
  const pricing = {
    inputCostMicrosPerMillion: 1_000_000,
    cachedInputCostMicrosPerMillion: 500_000,
    cacheWriteInputCostMicrosPerMillion: 2_000_000,
    outputCostMicrosPerMillion: 1_000_000,
  };

  const rows = projectNativeModelUsage({
    budget,
    runtimes: [
      runtime("sum-exceeds", "provider-sum", "model-sum", ["worker"], pricing),
      runtime("class-exceeds", "provider-class", "model-class", ["worker"], pricing),
    ],
    providerHealth: [],
  });

  assert.deepEqual(rows.map((row) => ({
    runtimeId: row.runtimeId,
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    cacheWriteInputTokens: row.cacheWriteInputTokens,
    estimatedCostMicros: row.estimatedCostMicros,
    costBasis: row.costBasis,
  })), [
    {
      runtimeId: "class-exceeds",
      inputTokens: 10,
      cachedInputTokens: 11,
      cacheWriteInputTokens: 0,
      estimatedCostMicros: null,
      costBasis: "unknown",
    },
    {
      runtimeId: "sum-exceeds",
      inputTokens: 10,
      cachedInputTokens: 8,
      cacheWriteInputTokens: 5,
      estimatedCostMicros: null,
      costBasis: "unknown",
    },
  ]);
});

test("rejects unsafe aggregate token dimensions and totals", () => {
  const runtimeConfig = runtime("overflow", "provider-overflow", "model-overflow", ["worker"], {
    inputCostMicrosPerMillion: 1,
    outputCostMicrosPerMillion: 1,
  });
  assert.throws(
    () => projectNativeModelUsage({
      budget: projection({
        max: settled(
          "max",
          "overflow",
          "provider-overflow",
          "model-overflow",
          "worker",
          { inputTokens: Number.MAX_SAFE_INTEGER },
          { inputTokens: "reported", outputTokens: "reported" },
          "2026-07-13T12:20:00.000Z",
        ),
        plus_one: settled(
          "plus_one",
          "overflow",
          "provider-overflow",
          "model-overflow",
          "worker",
          { inputTokens: 1 },
          { inputTokens: "reported", outputTokens: "reported" },
          "2026-07-13T12:20:01.000Z",
        ),
      }),
      runtimes: [runtimeConfig],
      providerHealth: [],
    }),
    /Model usage inputTokens for overflow exceeds the safe integer range/,
  );
  assert.throws(
    () => projectNativeModelUsage({
      budget: projection({
        total: settled(
          "total",
          "overflow",
          "provider-overflow",
          "model-overflow",
          "worker",
          { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 },
          { inputTokens: "reported", outputTokens: "reported" },
          "2026-07-13T12:20:00.000Z",
        ),
      }),
      runtimes: [runtimeConfig],
      providerHealth: [],
    }),
    /Model usage totalTokens for overflow exceeds the safe integer range/,
  );
});

test("rejects an estimated API cost outside the safe integer range", () => {
  assert.throws(
    () => projectNativeModelUsage({
      budget: projection({
        cost: settled(
          "cost",
          "cost-overflow",
          "provider-cost",
          "model-cost",
          "worker",
          { inputTokens: Number.MAX_SAFE_INTEGER },
          { inputTokens: "reported", outputTokens: "reported" },
          "2026-07-13T12:30:00.000Z",
        ),
      }),
      runtimes: [runtime(
        "cost-overflow",
        "provider-cost",
        "model-cost",
        ["worker"],
        {
          inputCostMicrosPerMillion: Number.MAX_SAFE_INTEGER,
          outputCostMicrosPerMillion: 0,
        },
      )],
      providerHealth: [],
    }),
    /Estimated model cost for cost-overflow exceeds the safe integer range/,
  );
});

test("provider cooldown expires exactly at its durable boundary", () => {
  const input = {
    budget: projection({}),
    runtimes: [runtime("boundary", "provider-boundary", "model-boundary", ["worker"])],
    providerHealth: [{
      providerId: "provider-boundary",
      status: "cooldown" as const,
      consecutiveFailures: 1,
      updatedAt: 1_000,
      cooldownUntil: 61_000,
    }],
  };

  assert.equal(projectNativeModelUsage({ ...input, now: 60_999 })[0].status, "cooldown");
  assert.equal(projectNativeModelUsage({ ...input, now: 61_000 })[0].status, "unused");
});

test("account runtimes are not metered and fully estimated calls retain that provenance", () => {
  const budget = projection({
    account_1: settled("account_1", "account", "chatgpt", "gpt", "architect", {
      inputTokens: 12,
      outputTokens: 3,
      estimatedCostMicros: 123_456,
    }, { inputTokens: "estimated", outputTokens: "estimated" }, "2026-07-13T11:00:00.000Z"),
  });

  assert.deepEqual(projectNativeModelUsage({
    budget,
    runtimes: [{
      ...runtime("account", "chatgpt", "gpt", ["architect"], {
        inputCostMicrosPerMillion: 1,
        outputCostMicrosPerMillion: 1,
      }),
      transport: "account-runner",
    }],
    providerHealth: [],
  })[0], {
    runtimeId: "account",
    providerId: "chatgpt",
    modelId: "gpt",
    roles: ["architect"],
    status: "healthy",
    calls: 1,
    inputTokens: 12,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 3,
    totalTokens: 15,
    estimatedCostMicros: null,
    costBasis: "account_not_metered",
    usageQuality: "estimated",
    lastUsedAt: "2026-07-13T11:00:00.000Z",
  });
});

function runtime(
  runtimeId: string,
  providerId: string,
  modelId: string,
  roles: NativeModelUsageRuntime["roles"],
  pricing: Pick<
    NativeModelUsageRuntime,
    | "inputCostMicrosPerMillion"
    | "outputCostMicrosPerMillion"
    | "cachedInputCostMicrosPerMillion"
    | "cacheWriteInputCostMicrosPerMillion"
  > = {},
): NativeModelUsageRuntime {
  return {
    runtimeId,
    providerId,
    modelId,
    transport: "openai-compatible",
    roles,
    selectable: true,
    ...pricing,
  };
}

function settled(
  reservationId: string,
  runtimeId: string,
  providerId: string,
  modelId: string,
  role: "architect" | "worker" | "subagent",
  actual: NonNullable<BudgetReservationProjection["actual"]>,
  tokenSources: NonNullable<BudgetReservationProjection["tokenSources"]>,
  settledAt: string,
): BudgetReservationProjection {
  return {
    reservationId,
    kind: "model",
    attribution: attribution(runtimeId, providerId, modelId, role),
    estimate: {},
    actual,
    tokenSources,
    settledAt,
    status: "settled",
    windowIndex: 1,
  };
}

function attribution(
  runtimeId: string,
  providerId: string,
  modelId: string,
  role: "architect" | "worker" | "subagent",
) {
  return { runtimeId, providerId, modelId, role, sessionId: `session:${runtimeId}` };
}

function projection(
  reservations: Record<string, BudgetReservationProjection>,
): BudgetProjection {
  const usage = {
    modelCalls: Object.values(reservations).filter((item) => item.kind === "model").length,
    toolCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    estimatedCostMicros: 0,
    activeMs: 0,
    artifactBytes: 0,
  };
  return {
    scopeId: "run_1",
    reservations,
    activeSegments: {},
    effective: { ...usage },
    lifetime: { ...usage },
    window: { index: 1 },
    lastSequence: 0,
  };
}
