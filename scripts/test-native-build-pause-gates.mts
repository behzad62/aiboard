import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  loadNativeBuildAuthoritativeSnapshot,
  nativeBuildAttachAction,
  nativeBuildPauseGate,
} from "../lib/client/native-build-engine";

let attachedSnapshots = 0;
await assert.rejects(
  () => loadNativeBuildAuthoritativeSnapshot({
    loadRun: async () => ({ runId: "run-vanished" }),
    loadBuild: async () => {
      throw new Error("referenced Build vanished");
    },
    onAttached: () => { attachedSnapshots += 1; },
  }),
  /referenced Build vanished/
);
assert.equal(
  attachedSnapshots,
  0,
  "failed authoritative snapshot loading preserves requested-at provenance for retry"
);
const recoveredSnapshot = await loadNativeBuildAuthoritativeSnapshot({
  loadRun: async () => ({ runId: "run-recovered" }),
  loadBuild: async () => ({ runId: "run-recovered", status: "running" }),
  onAttached: () => { attachedSnapshots += 1; },
});
assert.equal(recoveredSnapshot.run.runId, "run-recovered");
assert.equal(recoveredSnapshot.build.runId, "run-recovered");
assert.equal(
  attachedSnapshots,
  1,
  "retry clears provenance only after both authoritative snapshots load"
);

assert.equal(nativeBuildAttachAction("created"), "start");
assert.equal(nativeBuildAttachAction("running"), "observe");
assert.equal(
  nativeBuildAttachAction("paused"),
  "observe_paused",
  "reconnecting a browser must never resume a durably paused Build"
);

assert.deepEqual(
  nativeBuildPauseGate({
    runtime: {
      architect: {
        handoff: {
          reason: "Architect unavailable",
          candidateRuntimeIds: ["chatgpt:gpt-5.4"],
        },
      },
    },
  } as never),
  {
    kind: "architect_handoff",
    reason: "Architect unavailable",
    candidateRuntimeIds: ["chatgpt:gpt-5.4"],
  }
);

assert.deepEqual(
  nativeBuildPauseGate({
    projectHandoff: {
      status: "requested",
      summary: "Ready for user handoff",
      options: ["keep_integration_branch", "apply_to_project"],
    },
    runtime: { architect: {} },
  } as never),
  { kind: "project_handoff" }
);

assert.deepEqual(
  nativeBuildPauseGate({ runtime: { architect: {} } } as never),
  { kind: "resume" }
);

const discussionClientSource = readFileSync(
  new URL("../app/discussion/discussion-client.tsx", import.meta.url),
  "utf8"
);
const projectHandoffHandler = discussionClientSource.slice(
  discussionClientSource.indexOf("const handleProjectHandoff"),
  discussionClientSource.indexOf("const handleNativePermission")
);
assert.doesNotMatch(
  projectHandoffHandler,
  /handleResume\s*\(/,
  "a completed project handoff must not re-queue the discussion or create a new native Build"
);
assert.match(
  projectHandoffHandler,
  /nativeAttachmentControllerRef\.current\?\.wake\s*\(\s*\)/,
  "a completed project handoff should refresh the existing durable run in place"
);

console.log("PASS native Build pause gates");
