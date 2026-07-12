import assert from "node:assert/strict";

import {
  applyDiscussionLiveStatus,
  buildStopFallbackMessage,
  durableBuildHandoffPanels,
  nativeBuildTaskStatus,
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

console.log("PASS Build live discussion state");
