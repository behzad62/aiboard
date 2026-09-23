import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { failBuildIfActive, syncAutonomousBuildLifecycle } from "../src/cli-lifecycle.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import type { SchedulerProjection } from "../src/scheduler-store.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";

test("failBuildIfActive fails a live run once and ignores a terminal run", () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-cli-fail-build-"));
  const supervisor = openSupervisor(directory);
  try {
    supervisor.createRun({
      runId: "run_1",
      projectPath: join(directory, "project"),
      permissionProfile: "full",
      idempotencyKey: "create:run_1",
    });
    supervisor.captureBaseline("run_1", "baseline:run_1", "a".repeat(40), "refs/aiboard/runs/run-1/baseline");
    supervisor.start("run_1", "start:run_1");
    failBuildIfActive(supervisor, "run_1", "context_recording_aborted");
    failBuildIfActive(supervisor, "run_1", "context_recording_aborted");
    assert.equal(supervisor.getRun("run_1").state, "failed");
    assert.equal(supervisor.events("run_1").filter((event) => event.type === "run.failed").length, 1);
  } finally {
    supervisor.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("syncAutonomousBuildLifecycle fails a failed pump and still pauses a paused pump", () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-cli-sync-build-"));
  const supervisor = openSupervisor(directory);
  try {
    supervisor.createRun({
      runId: "run_failed",
      projectPath: join(directory, "project"),
      permissionProfile: "full",
      idempotencyKey: "create:failed",
    });
    supervisor.captureBaseline("run_failed", "baseline:failed", "b".repeat(40), "refs/aiboard/runs/failed/baseline");
    supervisor.start("run_failed", "start:failed");
    syncAutonomousBuildLifecycle(
      supervisor,
      "run_failed",
      { status: "failed", action: "context_recording_aborted" },
      {} as SchedulerProjection,
    );
    assert.equal(supervisor.getRun("run_failed").state, "failed");

    supervisor.createRun({
      runId: "run_paused",
      projectPath: join(directory, "project"),
      permissionProfile: "full",
      idempotencyKey: "create:paused",
    });
    supervisor.captureBaseline("run_paused", "baseline:paused", "c".repeat(40), "refs/aiboard/runs/paused/baseline");
    supervisor.start("run_paused", "start:paused");
    syncAutonomousBuildLifecycle(
      supervisor,
      "run_paused",
      { status: "paused", action: "context_recording_failed" },
      {} as SchedulerProjection,
    );
    assert.equal(supervisor.getRun("run_paused").state, "paused");
  } finally {
    supervisor.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

function openSupervisor(directory: string): RunSupervisor {
  return new RunSupervisor(new SqliteEventStore(join(directory, "events.sqlite")), {
    clock: () => "2026-09-23T00:00:00.000Z",
  });
}
