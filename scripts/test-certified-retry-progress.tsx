import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyPresetProgressEvent,
  RunProgressList
} from "../components/benchmark/run/RunProgressList";
import { BENCHMARK_PRESETS } from "../lib/benchmark/certified/run-presets";
import {
  DIRECT_MODEL_HARNESS,
  runGameIqMultiModel,
  type GameIqModelRunState
} from "../lib/benchmark/certified/run-execution";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { __resetBenchmarkStoreForTests } from "../lib/benchmark/store";
import {
  __resetClientStoreForTests,
  upsertProviderKey
} from "../lib/client/store";
import { openaiProvider } from "../lib/providers/openai";
import type { StreamChunk } from "../lib/providers/base";

const leg = BENCHMARK_PRESETS.flatMap((preset) => preset.legs).find(
  (candidate) => candidate.track === "teamiq"
);
assert.ok(leg);

const detail = "Temporary provider failure (HTTP 503); retry 1/5 in 2s.";
const rows = applyPresetProgressEvent([], {
  type: "retry",
  legIndex: 0,
  leg,
  modelId: "openai:retry-visible",
  displayName: "Retry Visible",
  resultSetId: "result-set-retry-visible",
  retry: 1,
  maxRetries: 5,
  delayMs: 2_000,
  detail
});

assert.equal(rows.length, 1);
assert.equal(rows[0]?.status, "running");
assert.equal(rows[0]?.models.length, 1);
assert.equal(rows[0]?.models[0]?.displayName, "Retry Visible");
assert.equal(rows[0]?.models[0]?.detail, detail);

const markup = renderToStaticMarkup(
  <RunProgressList rows={rows} running onCancel={() => {}} />
);
assert.match(markup, /Retry Visible/);
assert.match(markup, /retry 1\/5 in 2s/);
assert.match(markup, /Running/);
console.log("PASS team-preset retry creates and renders a visible running row");

const updated = applyPresetProgressEvent(rows, {
  type: "retry",
  legIndex: 0,
  leg,
  modelId: "openai:retry-visible",
  displayName: "Retry Visible",
  retry: 2,
  maxRetries: 5,
  delayMs: 5_000,
  detail: "Temporary provider failure; retry 2/5 in 5s."
});
assert.equal(updated[0]?.models.length, 1);
assert.match(updated[0]?.models[0]?.detail ?? "", /retry 2\/5/);
console.log(
  "PASS retry progress updates rather than duplicates an existing row"
);

// Exercise the actual Advanced multi-model callback, not a copied formatter:
// its retry notification must reach both the model row and the shared message.
async function checkAdvancedRetryProgress(): Promise<void> {
  __resetBenchmarkStoreForTests();
  __resetClientStoreForTests();
  upsertProviderKey({
    providerId: "openai",
    apiKey: "test-key",
    keyHint: "test",
    updatedAt: new Date().toISOString(),
    defaultModel: null,
    enabled: true
  });
  const originalStreamChat = openaiProvider.streamChat;
  let physicalCalls = 0;
  const messages: Array<string | null> = [];
  let modelRuns: GameIqModelRunState[] = [];
  openaiProvider.streamChat = async function* (): AsyncIterable<StreamChunk> {
    physicalCalls++;
    if (physicalCalls === 1) {
      yield {
        type: "error",
        error: "temporary",
        errorMetadata: { statusCode: 503 }
      };
      return;
    }
    yield { type: "token", content: "{}" };
    yield { type: "done" };
  };
  try {
    await runGameIqMultiModel({
      models: [
        {
          modelId: "openai:retry-advanced",
          providerId: "openai",
          displayName: "Retry Advanced"
        }
      ],
      gameIqModelIds: ["openai:retry-advanced"],
      suiteId: "gameiq-v0.2-connect-four",
      fireworksPlayerCount: 2,
      certification: runHarnessCertification(DIRECT_MODEL_HARNESS),
      effortByModelId: {},
      runAbortRef: { current: null },
      setRunning: () => {},
      setRunPhase: () => {},
      setSummary: () => {},
      setMessage: (message) => messages.push(message),
      setGameIqModelRuns: (updater) => {
        modelRuns =
          typeof updater === "function" ? updater(modelRuns) : updater;
      },
      onComplete: async () => {}
    });
  } finally {
    openaiProvider.streamChat = originalStreamChat;
  }
  assert.ok(
    messages.some((message) =>
      /Retry Advanced: temporary provider failure; retry 1\/5/.test(
        message ?? ""
      )
    )
  );
  assert.ok(physicalCalls > 1);
  assert.equal(modelRuns.length, 1);
  console.log(
    "PASS Advanced GameIQ retry reaches the live shared message path"
  );
}

checkAdvancedRetryProgress().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
