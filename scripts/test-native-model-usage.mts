import assert from "node:assert/strict";

import { mapNativeBuildUsageModels } from "../lib/client/native-model-usage";
import type { NativeBuildUsageProjection } from "../lib/client/runner-v2";

function projection(
  effective: Partial<NativeBuildUsageProjection["effective"]>,
  models?: NativeBuildUsageProjection["models"],
  attributedModelReservationCount = 0,
): NativeBuildUsageProjection {
  return {
    scopeId: "run_1",
    reservations: {},
    activeSegments: {},
    effective: {
      modelCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      estimatedCostMicros: 0,
      activeMs: 0,
      artifactBytes: 0,
      ...effective,
    },
    ...(models === undefined ? {} : { models }),
    attributedModelReservationCount,
    lastSequence: 1,
  };
}

const realRows = mapNativeBuildUsageModels(projection(
  {
    modelCalls: 99,
    inputTokens: 999,
    cachedInputTokens: 111,
    cacheWriteInputTokens: 222,
    outputTokens: 333,
  },
  [
    {
      runtimeId: "runtime-b",
      providerId: "provider-b",
      modelId: "model-b",
      roles: ["worker", "subagent"],
      status: "cooldown",
      calls: 2,
      inputTokens: 120,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 20,
      outputTokens: 40,
      totalTokens: 160,
      estimatedCostMicros: null,
      costBasis: "account_not_metered",
      usageQuality: "mixed",
      lastUsedAt: "2026-07-12T10:11:12.000Z",
    },
    {
      runtimeId: "runtime-a",
      providerId: "provider-a",
      modelId: "model-a",
      roles: ["architect"],
      status: "unused",
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostMicros: 0,
      costBasis: "api_estimate",
      usageQuality: "none",
      lastUsedAt: null,
    },
  ]
));

assert.deepEqual(realRows, [
  {
    runtimeId: "runtime-b",
    modelId: "model-b",
    modelName: "model-b",
    providerId: "provider-b",
    roles: ["worker", "subagent"],
    status: "cooldown",
    calls: 2,
    inputTokens: 120,
    cachedInputTokens: 30,
    cacheWriteInputTokens: 20,
    outputTokens: 40,
    totalTokens: 160,
    estimatedUsd: null,
    priced: false,
    usageQuality: "mixed",
    costBasis: "account_not_metered",
    lastUsedAt: "2026-07-12T10:11:12.000Z",
    usageOrigin: "native",
  },
  {
    runtimeId: "runtime-a",
    modelId: "model-a",
    modelName: "model-a",
    providerId: "provider-a",
    roles: ["architect"],
    status: "unused",
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedUsd: 0,
    priced: true,
    usageQuality: "none",
    costBasis: "api_estimate",
    lastUsedAt: null,
    usageOrigin: "native",
  },
]);

const previewRows = mapNativeBuildUsageModels(projection(
  {
    modelCalls: 5,
    inputTokens: 11,
    cachedInputTokens: 5,
    cacheWriteInputTokens: 2,
    outputTokens: 7,
    estimatedCostMicros: 500_000,
  },
  [
    {
      runtimeId: "runtime-z",
      providerId: "provider-z",
      modelId: "model-z",
      roles: ["architect", "worker"],
      status: "healthy",
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostMicros: 0,
      costBasis: "api_estimate",
      usageQuality: "none",
      lastUsedAt: null,
    },
    {
      runtimeId: "runtime-a",
      providerId: "provider-a",
      modelId: "model-a",
      roles: ["subagent"],
      status: "unavailable",
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedCostMicros: null,
      costBasis: "account_not_metered",
      usageQuality: "none",
      lastUsedAt: null,
    },
    {
      runtimeId: "runtime-b",
      providerId: "provider-b",
      modelId: "model-b",
      roles: ["architect"],
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
  ]
));

assert.deepEqual(
  previewRows.map((row) => ({
    runtimeId: row.runtimeId,
    roles: row.roles,
    status: row.status,
    calls: row.calls,
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cachedInputTokens,
    cacheWriteInputTokens: row.cacheWriteInputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    estimatedUsd: row.estimatedUsd,
    priced: row.priced,
    usageQuality: row.usageQuality,
    costBasis: row.costBasis,
    lastUsedAt: row.lastUsedAt,
    usageOrigin: row.usageOrigin,
  })),
  [
    {
      runtimeId: "runtime-a",
      roles: ["subagent"],
      status: "unavailable",
      calls: 1,
      inputTokens: 2,
      cachedInputTokens: 1,
      cacheWriteInputTokens: 0,
      outputTokens: 1,
      totalTokens: 3,
      estimatedUsd: null,
      priced: false,
      usageQuality: "estimated",
      costBasis: "account_not_metered",
      lastUsedAt: null,
      usageOrigin: "legacy_preview",
    },
    {
      runtimeId: "runtime-b",
      roles: ["architect"],
      status: "cooldown",
      calls: 2,
      inputTokens: 4,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 1,
      outputTokens: 2,
      totalTokens: 6,
      estimatedUsd: null,
      priced: false,
      usageQuality: "estimated",
      costBasis: "unknown",
      lastUsedAt: null,
      usageOrigin: "legacy_preview",
    },
    {
      runtimeId: "runtime-z",
      roles: ["architect", "worker"],
      status: "healthy",
      calls: 2,
      inputTokens: 5,
      cachedInputTokens: 2,
      cacheWriteInputTokens: 1,
      outputTokens: 4,
      totalTokens: 9,
      estimatedUsd: null,
      priced: false,
      usageQuality: "estimated",
      costBasis: "api_estimate",
      lastUsedAt: null,
      usageOrigin: "legacy_preview",
    },
  ]
);

for (const key of [
  "calls",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
] as const) {
  assert.equal(
    previewRows.reduce((sum, row) => sum + row[key], 0),
    projection({
      modelCalls: 5,
      inputTokens: 11,
      cachedInputTokens: 5,
      cacheWriteInputTokens: 2,
      outputTokens: 7,
    }).effective[key === "calls" ? "modelCalls" : key]
  );
}
assert.equal(previewRows.reduce((sum, row) => sum + row.totalTokens, 0), 18);

const compatibilityRows = mapNativeBuildUsageModels(projection({
  modelCalls: 3,
  inputTokens: 10,
  cachedInputTokens: 4,
  cacheWriteInputTokens: 1,
  outputTokens: 2,
  estimatedCostMicros: 123_000,
}));
assert.deepEqual(compatibilityRows, [{
  modelId: "runner-v2:aggregate",
  modelName: "Runner V2 models (legacy aggregate)",
  providerId: "runner-v2",
  roles: [],
  calls: 3,
  inputTokens: 10,
  cachedInputTokens: 4,
  cacheWriteInputTokens: 1,
  outputTokens: 2,
  totalTokens: 12,
  estimatedUsd: null,
  priced: false,
  usageQuality: "estimated",
  costBasis: "unknown",
  lastUsedAt: null,
  usageOrigin: "legacy_aggregate",
}]);

const duplicateRuntimeRows: NonNullable<NativeBuildUsageProjection["models"]> = [
  {
    runtimeId: "runtime-dup",
    providerId: "provider-z",
    modelId: "model-z",
    roles: ["architect"],
    status: "unused",
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostMicros: 0,
    costBasis: "api_estimate",
    usageQuality: "none",
    lastUsedAt: null,
  },
  {
    runtimeId: "runtime-dup",
    providerId: "provider-a",
    modelId: "model-a",
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
    lastUsedAt: "2026-07-12T00:00:00.000Z",
  },
  {
    runtimeId: "runtime-other",
    providerId: "provider-other",
    modelId: "model-other",
    roles: ["subagent"],
    status: "unused",
    calls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostMicros: null,
    costBasis: "account_not_metered",
    usageQuality: "none",
    lastUsedAt: null,
  },
];
const duplicateProjection = (models: NonNullable<NativeBuildUsageProjection["models"]>) =>
  mapNativeBuildUsageModels(projection({ modelCalls: 4, inputTokens: 8 }, models));
const duplicateForward = duplicateProjection(duplicateRuntimeRows);
const duplicateReversed = duplicateProjection([...duplicateRuntimeRows].reverse());
assert.deepEqual(duplicateForward, duplicateReversed);
assert.deepEqual(
  duplicateForward.map((row) => ({
    runtimeId: row.runtimeId,
    providerId: row.providerId,
    modelId: row.modelId,
    roles: row.roles,
    status: row.status,
    calls: row.calls,
    inputTokens: row.inputTokens,
    costBasis: row.costBasis,
    lastUsedAt: row.lastUsedAt,
  })),
  [
    {
      runtimeId: "runtime-dup",
      providerId: "provider-a",
      modelId: "model-a",
      roles: ["architect", "worker"],
      status: "unavailable",
      calls: 3,
      inputTokens: 6,
      costBasis: "unknown",
      lastUsedAt: "2026-07-12T00:00:00.000Z",
    },
    {
      runtimeId: "runtime-other",
      providerId: "provider-other",
      modelId: "model-other",
      roles: ["subagent"],
      status: "unused",
      calls: 1,
      inputTokens: 2,
      costBasis: "account_not_metered",
      lastUsedAt: null,
    },
  ]
);

const tokensOnlyPreview = mapNativeBuildUsageModels(projection(
  { inputTokens: 3, cachedInputTokens: 1, outputTokens: 2 },
  duplicateRuntimeRows
));
assert.equal(tokensOnlyPreview.every((row) => row.usageOrigin === "legacy_preview"), true);
assert.equal(tokensOnlyPreview.reduce((sum, row) => sum + row.calls, 0), 0);
assert.equal(tokensOnlyPreview.reduce((sum, row) => sum + row.inputTokens, 0), 3);
assert.equal(tokensOnlyPreview.reduce((sum, row) => sum + row.cachedInputTokens!, 0), 1);
assert.equal(tokensOnlyPreview.reduce((sum, row) => sum + row.outputTokens, 0), 2);

const attributedReservedRows = mapNativeBuildUsageModels(projection(
  { modelCalls: 1, inputTokens: 100, outputTokens: 50 },
  duplicateRuntimeRows,
  1,
));
assert.equal(
  attributedReservedRows.every((row) => row.usageOrigin === "native"),
  true,
);
assert.equal(attributedReservedRows.every((row) => row.calls === 0), true);

const maxSafePreview = mapNativeBuildUsageModels(projection(
  { inputTokens: Number.MAX_SAFE_INTEGER },
  [
    { ...duplicateRuntimeRows[2], runtimeId: "runtime-a" },
    {
      ...duplicateRuntimeRows[0],
      runtimeId: "runtime-b",
      roles: ["architect"],
    },
  ]
));
assert.deepEqual(
  maxSafePreview.map((row) => row.inputTokens),
  [3_002_399_751_580_330, 6_004_799_503_160_661]
);
assert.equal(
  maxSafePreview.reduce((sum, row) => sum + row.inputTokens, 0),
  Number.MAX_SAFE_INTEGER
);

console.log("PASS native Build model usage mapping");
