import assert from "node:assert/strict";

import {
  applyDiscussionLiveStatus,
  buildStopFallbackMessage,
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

console.log("PASS Build live discussion state");
