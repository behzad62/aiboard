import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlServer } from "../src/control-server.js";
import type { BuildControlPlane } from "../src/build-runtime-registry.js";
import type { GitPreflightResult } from "../src/git-preflight.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";

const token = "test-control-token";
const gitReady: GitPreflightResult = { available: true, version: "2.45.1.windows.1", code: "git_ready", reason: null };
const bootstrapRun = async () => ({ baselineRevision: "a".repeat(40), baselineRef: "refs/aiboard/runs/test/baseline" });

// Tunnel run: nothing ever confirmed a stop, so a stopped native Build stayed "stopping" forever.
test("stop confirms once the Build pause has quiesced the run; a repeated stop finishes a stuck one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-control-stop-"));
  const supervisor = new RunSupervisor(new SqliteEventStore(join(directory, "events.sqlite")));
  const paused: string[] = [];
  let failPause = false;
  const builds = {
    projection: () => ({ runId: "run_stop", status: "running", lastSequence: 3 }),
    activate: () => undefined,
    resume: async () => ({ runId: "run_stop", status: "running", lastSequence: 4 }),
    pause: async (_runId: string, reason: string) => {
      if (failPause) throw new Error("quiesce failed");
      paused.push(reason);
      return { runId: "run_stop", status: "paused", lastSequence: 5 };
    },
  } as unknown as BuildControlPlane;
  const server = new ControlServer({ supervisor, token, checkGit: async () => gitReady, bootstrapRun, builds });
  const address = await server.start(0);
  const call = (path: string, body: unknown) => fetch(`${address.url}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await call("/v2/runs", { runId: "run_stop", projectPath: join(directory, "project"), permissionProfile: "full", idempotencyKey: "create" })).status, 201);
    assert.equal((await call("/v2/runs/run_stop/commands", { command: "start", idempotencyKey: "start" })).status, 200);
    failPause = true;
    const refused = await call("/v2/runs/run_stop/commands", { command: "stop", idempotencyKey: "stop-1", reason: "owner" });
    assert.notEqual(refused.status, 200, "a stop whose Build could not quiesce is not confirmed");
    assert.equal(supervisor.getRun("run_stop").state, "stopping");
    failPause = false;
    const stopped = await call("/v2/runs/run_stop/commands", { command: "stop", idempotencyKey: "stop-2", reason: "owner" });
    assert.equal(stopped.status, 200, await stopped.clone().text());
    assert.equal(((await stopped.json()) as { state: string }).state, "stopped");
    assert.equal(supervisor.getRun("run_stop").state, "stopped");
    assert.deepEqual(paused, ["owner"]);
  } finally {
    await server.close();
    supervisor.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
