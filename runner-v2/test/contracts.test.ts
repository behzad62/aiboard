import assert from "node:assert/strict";
import test from "node:test";

import {
  RUNNER_V2_SCHEMA_VERSION,
  assertRunEvent,
  type RunEvent,
} from "../src/contracts.js";

test("run events require identity, ordering, provenance, and idempotency", () => {
  const event: RunEvent = {
    schemaVersion: 1,
    eventId: "evt_1",
    runId: "run_1",
    sequence: 1,
    type: "run.created",
    occurredAt: "2026-07-11T00:00:00.000Z",
    actor: { kind: "user", id: "local-user" },
    idempotencyKey: "create:run_1",
    payload: { projectPath: "C:/work/project", permissionProfile: "project" },
  };

  assert.equal(RUNNER_V2_SCHEMA_VERSION, 1);
  assert.doesNotThrow(() => assertRunEvent(event));
  assert.throws(
    () => assertRunEvent({ ...event, idempotencyKey: "" }),
    /idempotencyKey/
  );
});
