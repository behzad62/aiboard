import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BuildRunStats } from "../components/BuildRunStats";
import type { BuildRunPolicy, BuildUsageWindow } from "../lib/db/schema";

const usage: BuildUsageWindow = {
  startedAt: "2026-07-12T10:00:00.000Z",
  elapsedMs: 65_000,
  estimatedUsd: 0.5,
  unknownPricedModelIds: ["api:unknown"],
  models: [
    {
      runtimeId: "architect-account",
      modelId: "chatgpt:gpt-5.4",
      modelName: "GPT-5.4",
      providerId: "chatgpt",
      roles: ["architect"],
      status: "healthy",
      calls: 2,
      inputTokens: 1_200,
      outputTokens: 300,
      totalTokens: 1_500,
      estimatedUsd: null,
      priced: false,
      usageQuality: "reported",
      costBasis: "account_not_metered",
      lastUsedAt: "2026-07-12T10:11:12.000Z",
      usageOrigin: "native",
    },
    {
      runtimeId: "worker-unknown",
      modelId: "api:unknown",
      modelName: "Unknown API model",
      providerId: "custom",
      roles: ["worker", "subagent"],
      status: "cooldown",
      calls: 1,
      inputTokens: 400,
      outputTokens: 100,
      totalTokens: 500,
      estimatedUsd: null,
      priced: false,
      usageQuality: "mixed",
      costBasis: "unknown",
      lastUsedAt: "2026-07-12T10:12:00.000Z",
      usageOrigin: "native",
    },
    {
      runtimeId: "worker-priced",
      modelId: "api:priced",
      modelName: "Priced API model",
      providerId: "openai",
      roles: ["worker"],
      status: "unavailable",
      calls: 1,
      inputTokens: 2_000,
      outputTokens: 500,
      totalTokens: 2_500,
      estimatedUsd: 0.5,
      priced: true,
      usageQuality: "estimated",
      costBasis: "api_estimate",
      lastUsedAt: "2026-07-12T10:13:00.000Z",
      usageOrigin: "native",
    },
    {
      runtimeId: "worker-unused",
      modelId: "api:unused",
      modelName: "Unused API model",
      providerId: "anthropic",
      roles: ["worker"],
      status: "unused",
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      estimatedUsd: null,
      priced: false,
      usageQuality: "none",
      costBasis: "unknown",
      lastUsedAt: null,
      usageOrigin: "native",
    },
  ],
};

function renderStats(
  policy: BuildRunPolicy,
  overrides: Record<string, unknown> = {}
): string {
  const markup = renderToStaticMarkup(createElement(BuildRunStats, {
    status: "running",
    policy,
    budgetUsd: 5,
    timeLimitMinutes: 120,
    usage,
    ...overrides,
  } as never));
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&middot;|&#xB7;/g, "·")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const finish = renderStats("finish");
assert.match(finish, /Finish job · running/);
assert.match(finish, /Calls 4/);
assert.match(finish, /Tokens 4\.5k 3\.6k in \/ 900 out/);
assert.match(finish, /Active time 1m 5s/);
assert.match(finish, /Cost \$0\.50 Partial estimate/);
assert.match(
  finish,
  /Runs until completion, user stop, provider unavailability, permission decision, or a mechanical blocker\./
);
assert.doesNotMatch(finish, /Limits/);
assert.doesNotMatch(finish, /\$5\.00|120m/);

const budgeted = renderStats("budgeted");
assert.match(budgeted, /Budgeted run · running/);
assert.match(
  budgeted,
  /Budget progress \$0\.50 \/ \$5\.00 · 1m 5s \/ 120m/
);
assert.doesNotMatch(budgeted, /Limits/);

const planOnly = renderStats("plan_only");
assert.match(planOnly, /Plan only · running/);
assert.match(planOnly, /Architect planning/);
assert.doesNotMatch(planOnly, /implementation budget|implementation limit/i);
assert.doesNotMatch(planOnly, /\$5\.00|120m/);

const handoff = renderStats("finish", {
  status: "failed",
  stopReason: "blocked",
  projectHandoffRequested: true,
});
assert.match(handoff, /Finish job · Awaiting project handoff/);
assert.doesNotMatch(handoff, /Failed|failed|stopped \(blocked\)/);

assert.match(finish, /Model Role Status Usage quality Calls Input Output Total Cost Last used/);
assert.match(
  finish,
  /GPT-5\.4 chatgpt Architect Healthy Provider-reported 2 1\.2k 300 1\.5k Not metered 12 Jul 2026, 10:11 UTC/
);
assert.match(
  finish,
  /Unknown API model custom Worker, Subagent Cooldown Mixed 1 400 100 500 Unknown 12 Jul 2026, 10:12 UTC/
);
assert.match(
  finish,
  /Priced API model openai Worker Unavailable Estimated 1 2\.0k 500 2\.5k \$0\.50 12 Jul 2026, 10:13 UTC/
);
assert.match(
  finish,
  /Unused API model anthropic Worker Unused No usage yet 0 0 0 0 Unknown Never/
);

const legacy = renderStats("finish", {
  usage: {
    ...usage,
    unknownPricedModelIds: [],
    models: [{
      ...usage.models[0],
      modelName: "Legacy Architect",
      usageQuality: "estimated",
      usageOrigin: "legacy_preview",
    }],
  },
});
assert.match(legacy, /Legacy Architect chatgpt Architect Healthy Legacy estimate/);

const cachedOnlyUnknown = renderStats("finish", {
  usage: {
    ...usage,
    estimatedUsd: 0,
    unknownPricedModelIds: ["api:cached-only"],
    models: [{
      ...usage.models[3],
      modelId: "api:cached-only",
      modelName: "Cached-only API model",
      cachedInputTokens: 1,
    }],
  },
});
assert.match(cachedOnlyUnknown, /Cost Unknown/);
assert.match(cachedOnlyUnknown, /Cost unknown: 1 contributing model missing pricing\./);

const pricedAndAccount = renderStats("finish", {
  usage: {
    ...usage,
    unknownPricedModelIds: [],
    models: [usage.models[0], usage.models[2]],
  },
});
assert.match(pricedAndAccount, /Cost \$0\.50 Partial estimate/);
assert.doesNotMatch(pricedAndAccount, /contributing model missing pricing/);

const realRowsWithStaleAggregate = renderStats("finish", {
  usage: {
    ...usage,
    models: [
      ...usage.models,
      {
        ...usage.models[2],
        modelId: "runner-v2:aggregate",
        modelName: "Runner V2 models (legacy aggregate)",
        providerId: "runner-v2",
        usageOrigin: "legacy_aggregate",
      },
    ],
  },
});
assert.doesNotMatch(realRowsWithStaleAggregate, /Runner V2 models/);

const realRowsWithStalePreview = renderStats("finish", {
  usage: {
    ...usage,
    models: [
      ...usage.models,
      {
        ...usage.models[2],
        modelId: "api:stale-preview",
        modelName: "Stale legacy preview",
        usageOrigin: "legacy_preview",
      },
    ],
  },
});
assert.doesNotMatch(realRowsWithStalePreview, /Stale legacy preview/);

const storedLegacyRow = renderStats("finish", {
  usage: {
    ...usage,
    unknownPricedModelIds: [],
    models: [{
      ...usage.models[2],
      modelName: "Stored legacy model",
      usageQuality: undefined,
      usageOrigin: undefined,
    }],
  },
});
assert.match(storedLegacyRow, /Stored legacy model openai Worker Unavailable Legacy estimate/);

const storedUnknownCost = renderStats("finish", {
  usage: {
    ...usage,
    estimatedUsd: 0,
    unknownPricedModelIds: ["legacy:unknown"],
    models: [{
      ...usage.models[1],
      modelId: "legacy:unknown",
      modelName: "Stored unknown-cost model",
      costBasis: undefined,
      usageOrigin: undefined,
    }],
  },
});
assert.match(storedUnknownCost, /Cost Unknown/);
assert.doesNotMatch(storedUnknownCost, /Cost \$0\.00/);

const storedPartialCost = renderStats("finish", {
  usage: {
    ...usage,
    unknownPricedModelIds: ["legacy:unknown"],
    models: [
      {
        ...usage.models[2],
        costBasis: undefined,
        usageOrigin: undefined,
      },
      {
        ...usage.models[1],
        modelId: "legacy:unknown",
        modelName: "Stored unknown-cost model",
        costBasis: undefined,
        usageOrigin: undefined,
      },
    ],
  },
});
assert.match(storedPartialCost, /Cost \$0\.50 Partial estimate/);

console.log("PASS Build run stats render contract");
