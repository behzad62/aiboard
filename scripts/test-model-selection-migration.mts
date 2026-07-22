import assert from "node:assert/strict";

import type { ClientStore } from "../lib/client/store";
import { migrateClientStoreModelSelections } from "../lib/client/model-selection-migration";

const fixture = {
  userSettings: {
    id: "default",
    defaultEffort: "balanced",
    defaultMode: "panel",
    judgeModelId: "openai:gpt-5.6",
    modelPricingOverrides: {
      "openai:gpt-5.6": { inputPerMillion: 99, outputPerMillion: 99 },
      "openai:gpt-5.6-terra": { inputPerMillion: 2.5, outputPerMillion: 15 },
      "chatgpt:gpt-5.6": { inputPerMillion: 7, outputPerMillion: 7 },
    },
    modelContextOverrides: {
      "openai:gpt-5.6-pro": { contextWindowTokens: 12 },
    },
  },
  providerKeys: [
    { providerId: "openai", defaultModel: "gpt-5.6-mini" },
    { providerId: "chatgpt", defaultModel: "gpt-5.6" },
  ],
  discussions: [
    {
      id: "discussion-1",
      modelIds: JSON.stringify([
        "openai:gpt-5.6",
        "openai:gpt-5.6-pro",
        "chatgpt:gpt-5.6",
      ]),
      judgeModelId: "openai:gpt-5.6-mini",
      reviewerModelId: "openai:gpt-5.6",
    },
  ],
  messages: [{ id: "message-1", modelId: "openai:gpt-5.6" }],
  finalResults: [],
  attachments: [],
  buildFiles: [],
  buildCheckpoints: [],
  contextBlobs: [],
  buildMemories: [],
  customModels: [],
  gameSessions: [
    {
      id: "active-session",
      status: "active",
      participants: [
        { id: "ai", kind: "ai", label: "AI", modelId: "openai:gpt-5.6-pro" },
      ],
    },
    {
      id: "complete-session",
      status: "complete",
      participants: [
        { id: "ai", kind: "ai", label: "AI", modelId: "openai:gpt-5.6-pro" },
      ],
    },
  ],
  gameMatchRecords: [
    {
      id: "match-1",
      participants: [
        { id: "ai", kind: "ai", label: "AI", modelId: "openai:gpt-5.6" },
      ],
    },
  ],
  gameStatsLegacyImportAttempted: false,
  benchmarkSuites: [],
  benchmarkRuns: [],
  benchmarkCases: [],
  benchmarkCaseV2: [],
  benchmarkAttempts: [{ id: "attempt-1", modelId: "openai:gpt-5.6" }],
  benchmarkAttemptsV2: [],
  benchmarkMetricValues: [],
  benchmarkArtifacts: [],
  benchmarkFailures: [],
  benchmarkTraces: [{ id: "trace-1", modelId: "openai:gpt-5.6" }],
  benchmarkRunEvents: [],
  benchmarkToolCallTraces: [],
  benchmarkVerifierResults: [],
  benchmarkTeamCompositions: [
    { id: "team-1", modelIds: ["openai:gpt-5.6"] },
  ],
  benchmarkHarnessCertifications: [],
  modelStats: [{ modelId: "openai:gpt-5.6" }],
} as unknown as ClientStore;

const original = structuredClone(fixture);
const first = migrateClientStoreModelSelections(fixture);

assert.equal(first.changed, true);
assert.deepEqual(fixture, original, "migration must not mutate the hydrated input");
assert.equal(first.store.userSettings.judgeModelId, "openai:gpt-5.6-terra");
assert.deepEqual(first.store.userSettings.modelPricingOverrides, {
  "openai:gpt-5.6-terra": { inputPerMillion: 2.5, outputPerMillion: 15 },
  "chatgpt:gpt-5.6": { inputPerMillion: 7, outputPerMillion: 7 },
});
assert.deepEqual(first.store.userSettings.modelContextOverrides, {
  "openai:gpt-5.6-sol": { contextWindowTokens: 12 },
});
assert.equal(first.store.providerKeys[0]?.defaultModel, "gpt-5.6-luna");
assert.equal(first.store.providerKeys[1]?.defaultModel, "gpt-5.6");
assert.deepEqual(JSON.parse(first.store.discussions[0]!.modelIds), [
  "openai:gpt-5.6-terra",
  "openai:gpt-5.6-sol",
  "chatgpt:gpt-5.6",
]);
assert.equal(first.store.discussions[0]?.judgeModelId, "openai:gpt-5.6-luna");
assert.equal(first.store.discussions[0]?.reviewerModelId, "openai:gpt-5.6-terra");
assert.equal(
  first.store.gameSessions[0]?.participants[0]?.modelId,
  "openai:gpt-5.6-sol"
);
assert.equal(
  first.store.gameSessions[1]?.participants[0]?.modelId,
  "openai:gpt-5.6-pro",
  "completed game sessions are historical"
);
assert.deepEqual(first.store.messages, original.messages);
assert.deepEqual(first.store.gameMatchRecords, original.gameMatchRecords);
assert.deepEqual(first.store.benchmarkAttempts, original.benchmarkAttempts);
assert.deepEqual(first.store.benchmarkTraces, original.benchmarkTraces);
assert.deepEqual(
  first.store.benchmarkTeamCompositions,
  original.benchmarkTeamCompositions
);
assert.deepEqual(first.store.modelStats, original.modelStats);

const second = migrateClientStoreModelSelections(first.store);
assert.equal(second.changed, false, "migration must be idempotent");
assert.equal(second.store, first.store, "an unchanged store should retain identity");

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  },
});

const checklistKey = "aiboard:benchmark:run:model-checklist";
storage.set(
  checklistKey,
  JSON.stringify(["openai:gpt-5.6", "chatgpt:gpt-5.6", "openai:gpt-5.6-mini"])
);
const { readPersistedModelChecklistSelection } = await import(
  "../components/benchmark/run/ModelChecklist"
);
assert.deepEqual(readPersistedModelChecklistSelection(), [
  "openai:gpt-5.6-terra",
  "chatgpt:gpt-5.6",
  "openai:gpt-5.6-luna",
]);
assert.equal(
  storage.get(checklistKey),
  JSON.stringify([
    "openai:gpt-5.6-terra",
    "chatgpt:gpt-5.6",
    "openai:gpt-5.6-luna",
  ]),
  "the migrated checklist must be durable immediately"
);

console.log("model selection migration: PASS");
