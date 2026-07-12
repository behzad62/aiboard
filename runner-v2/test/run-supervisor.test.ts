import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";

test("restart rebuilds state and commands remain idempotent", () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-runner-v2-supervisor-"));
  const databasePath = join(directory, "events.sqlite");
  const projectPath = join(directory, "project");
  let instant = 0;
  const clock = () =>
    new Date(Date.UTC(2026, 6, 11, 0, 0, instant++)).toISOString();

  const supervisor = new RunSupervisor(new SqliteEventStore(databasePath), {
    clock,
  });
  supervisor.createRun({
    runId: "run_1",
    projectPath,
    permissionProfile: "project",
    idempotencyKey: "create:run_1",
  });
  supervisor.captureBaseline(
    "run_1",
    "baseline:run_1",
    "a".repeat(40),
    "refs/aiboard/runs/run-1/baseline"
  );
  supervisor.start("run_1", "start:run_1");
  supervisor.pause("run_1", "pause:run_1", "user");
  assert.equal(
    supervisor.getRun("run_1").stopReason,
    undefined,
    "a pause reason is not a terminal stop reason"
  );
  supervisor.close();

  const recovered = new RunSupervisor(new SqliteEventStore(databasePath), {
    clock,
  });
  try {
    assert.equal(recovered.getRun("run_1").state, "paused");
    assert.equal(recovered.getRun("run_1").baselineRevision, "a".repeat(40));
    recovered.resume("run_1", "resume:run_1");
    recovered.resume("run_1", "resume:run_1");
    assert.equal(recovered.getRun("run_1").state, "running");
    assert.equal(
      recovered
        .events("run_1")
        .filter((event) => event.type === "run.resumed").length,
      1
    );
  } finally {
    recovered.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stop is two-stage and terminal runs reject new lifecycle commands", () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-runner-v2-stop-"));
  const store = new SqliteEventStore(join(directory, "events.sqlite"));
  const supervisor = new RunSupervisor(store, {
    clock: () => "2026-07-11T00:00:00.000Z",
  });

  try {
    supervisor.createRun({
      runId: "run_1",
      projectPath: join(directory, "project"),
      permissionProfile: "full",
      idempotencyKey: "create:run_1",
    });
    assert.throws(
      () => supervisor.start("run_1", "start-without-baseline:run_1"),
      /baseline/i
    );
    supervisor.captureBaseline(
      "run_1",
      "baseline:run_1",
      "b".repeat(40),
      "refs/aiboard/runs/run-1/baseline"
    );
    supervisor.start("run_1", "start:run_1");
    supervisor.requestStop("run_1", "stop-request:run_1", "user requested");
    assert.equal(supervisor.getRun("run_1").state, "stopping");
    supervisor.confirmStopped("run_1", "stopped:run_1", "user requested");
    assert.equal(supervisor.getRun("run_1").state, "stopped");
    assert.throws(
      () => supervisor.resume("run_1", "resume-after-stop:run_1"),
      /cannot accept run\.resumed/i
    );
    assert.equal(
      supervisor.events("run_1").length,
      5,
      "rejected transitions must not enter the durable event log"
    );
  } finally {
    supervisor.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a paused run can complete after its required user handoff", () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-runner-v2-paused-complete-"));
  const supervisor = new RunSupervisor(
    new SqliteEventStore(join(directory, "events.sqlite")),
    { clock: () => "2026-07-12T00:00:00.000Z" }
  );
  try {
    supervisor.createRun({
      runId: "run_1",
      projectPath: join(directory, "project"),
      permissionProfile: "full",
      idempotencyKey: "create:run_1",
    });
    supervisor.captureBaseline(
      "run_1",
      "baseline:run_1",
      "c".repeat(40),
      "refs/aiboard/runs/run-1/baseline"
    );
    supervisor.start("run_1", "start:run_1");
    supervisor.pause("run_1", "handoff-wait:run_1", "native-build");
    supervisor.complete("run_1", "handoff-complete:run_1");
    assert.equal(supervisor.getRun("run_1").state, "completed");
  } finally {
    supervisor.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
