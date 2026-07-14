import assert from "node:assert/strict";
import test from "node:test";

import { integrationInitializationModeFromEvents } from "../src/native-build-factory.js";
import type { SchedulerEvent, SchedulerEventType } from "../src/scheduler-store.js";

test("only durably completed Builds use cleanup-only integration initialization", () => {
  assert.equal(integrationInitializationModeFromEvents([]), "active");
  assert.equal(
    integrationInitializationModeFromEvents([
      schedulerEvent(1, "run.initialized", "runner"),
      schedulerEvent(2, "run.paused", "runner"),
    ]),
    "active"
  );
  assert.equal(
    integrationInitializationModeFromEvents([
      schedulerEvent(1, "run.initialized", "runner"),
      schedulerEvent(2, "run.completed", "architect"),
    ]),
    "cleanup-only"
  );
});

function schedulerEvent(
  sequence: number,
  type: SchedulerEventType,
  role: SchedulerEvent["actor"]["role"]
): SchedulerEvent {
  return {
    eventId: `event_${sequence}`,
    runId: "run_initialization_mode",
    sequence,
    type,
    occurredAt: `2026-07-14T00:00:0${sequence}.000Z`,
    actor: { role, id: `${role}_1` },
    idempotencyKey: `event:${sequence}`,
    payload: {},
  };
}
