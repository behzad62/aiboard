import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
} from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";

test("scheduler events recover exact task and blocking-guidance state", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-store-"));
  const database = join(root, "scheduler.sqlite");
  try {
    const first = new SqliteSchedulerStore(database);
    const plan = first.append(event("run_1", "plan.created", "plan:1", {
      revision: 1,
      tasks: [
        {
          id: "task_1",
          objective: "Implement feature",
          dependencies: [],
          status: "planned",
          requiredCapabilities: [],
          attempt: 0,
        },
      ],
    }));
    const duplicate = first.append(event("run_1", "plan.created", "plan:1", {
      revision: 1,
      tasks: [
        {
          id: "task_1",
          objective: "Implement feature",
          dependencies: [],
          status: "planned",
          requiredCapabilities: [],
          attempt: 0,
        },
      ],
    }));
    assert.equal(duplicate.eventId, plan.eventId);
    first.append(event("run_1", "task.transitioned", "assign:1", {
      taskId: "task_1",
      status: "assigned",
      patch: { assignedWorkerId: "worker_1" },
    }));
    first.append(event("run_1", "task.transitioned", "run:1", {
      taskId: "task_1",
      status: "running",
      patch: { workspacePath: "C:/workspace/task_1" },
    }));
    first.append(event("run_1", "guidance.requested", "guidance:1", {
      requestId: "guidance_1",
      taskId: "task_1",
      blocking: true,
      question: "Which API?",
      evidenceSequence: 4,
    }));
    first.close();

    const recovered = new SqliteSchedulerStore(database);
    const projection = rebuildSchedulerProjection(recovered.readRun("run_1"));
    assert.equal(projection.tasks.task_1.status, "waiting_guidance");
    assert.equal(projection.tasks.task_1.guidanceRequestId, "guidance_1");
    assert.equal(projection.guidance.guidance_1.status, "open");
    assert.equal(projection.lastSequence, 4);
    recovered.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("corrupt scheduler payload identifies the event", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-scheduler-corrupt-"));
  const database = join(root, "scheduler.sqlite");
  const store = new SqliteSchedulerStore(database);
  try {
    const appended = store.append(event("run_1", "plan.created", "plan:1", {
      revision: 1,
      tasks: [],
    }));
    const raw = new DatabaseSync(database);
    raw
      .prepare("UPDATE scheduler_events SET payload_json = ? WHERE event_id = ?")
      .run("{", appended.eventId);
    raw.close();
    assert.throws(() => store.readRun("run_1"), new RegExp(appended.eventId));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function event(
  runId: string,
  type: NewSchedulerEvent["type"],
  idempotencyKey: string,
  payload: Record<string, unknown>
): NewSchedulerEvent {
  return {
    runId,
    type,
    occurredAt: "2026-07-12T00:00:00.000Z",
    actor: { role: type === "plan.created" ? "architect" : "runner", id: "actor_1" },
    idempotencyKey,
    payload,
  };
}
