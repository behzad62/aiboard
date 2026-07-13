import assert from "node:assert/strict";

import {
  applyDiscussionLiveStatus,
  buildStopFallbackMessage,
  durableBuildHandoffPanels,
  nativeBuildTaskStatus,
  nativeBuildUsageWindow,
  shouldRestoreDurableBuildProjection,
  shouldShowBuildStopFallback,
} from "../lib/client/discussion-live-state";

const stopped = {
  id: "discussion_1",
  mode: "build",
  status: "stopped",
  buildStopReason: "blocked",
  buildStoppedAt: "2026-07-12T00:00:00.000Z",
} as never;

assert.deepEqual(
  applyDiscussionLiveStatus(stopped, "running"),
  {
    id: "discussion_1",
    mode: "build",
    status: "running",
    buildStopReason: null,
    buildStoppedAt: null,
  }
);

assert.equal(
  buildStopFallbackMessage("blocked"),
  "Build paused at its durable checkpoint after a recoverable blocker."
);
assert.doesNotMatch(buildStopFallbackMessage("blocked"), /repeated|budget/i);
assert.equal(
  shouldShowBuildStopFallback({
    stopReason: "blocked",
    status: "stopped",
    hasStopReport: false,
    hasArchitectHandoff: false,
    hasProjectHandoff: true,
  }),
  false
);
assert.equal(
  shouldShowBuildStopFallback({
    stopReason: "blocked",
    status: "stopped",
    hasStopReport: false,
    hasArchitectHandoff: false,
    hasProjectHandoff: false,
  }),
  true
);
assert.deepEqual(
  durableBuildHandoffPanels({
    projectHandoff: {
      status: "requested",
      summary: "Ready",
      options: ["keep_integration_branch", "apply_to_project"],
    },
    runtime: { architect: {} },
  } as never),
  {
    architect: null,
    project: {
      summary: "Ready",
      options: ["keep_integration_branch", "apply_to_project"],
    },
  }
);
assert.equal(nativeBuildTaskStatus("integrated"), "done");
assert.equal(nativeBuildTaskStatus("running"), "in_progress");
assert.equal(nativeBuildTaskStatus("submitted"), "review");
assert.equal(shouldRestoreDurableBuildProjection("stopped"), true);
assert.equal(shouldRestoreDurableBuildProjection("failed"), true);
assert.equal(shouldRestoreDurableBuildProjection("running"), false);
assert.equal(shouldRestoreDurableBuildProjection("completed"), false);
assert.deepEqual(
  nativeBuildUsageWindow({
    scopeId: "run_1",
    reservations: {},
    activeSegments: {},
    effective: {
      modelCalls: 9,
      toolCalls: 27,
      inputTokens: 12_000,
      outputTokens: 3_000,
      estimatedCostMicros: 125_000,
      activeMs: 45_000,
      artifactBytes: 1_024,
    },
    lastSequence: 42,
  }, "2026-07-12T00:00:00.000Z"),
  {
    startedAt: "2026-07-12T00:00:00.000Z",
    elapsedMs: 45_000,
    estimatedUsd: 0.125,
    unknownPricedModelIds: [],
    models: [{
      modelId: "runner-v2:aggregate",
      modelName: "Runner V2 models",
      providerId: "runner-v2",
      calls: 9,
      inputTokens: 12_000,
      outputTokens: 3_000,
      totalTokens: 15_000,
      estimatedUsd: 0.125,
      priced: true,
    }],
  }
);

console.log("PASS Build live discussion state");
