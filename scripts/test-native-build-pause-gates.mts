import assert from "node:assert/strict";

import { nativeBuildPauseGate } from "../lib/client/native-build-engine";

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

console.log("PASS native Build pause gates");
