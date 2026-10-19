import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readHistoricalManagedProcessObservations } from "../src/managed-process.js";
test("historical process observation reads persisted records without reconciliation writes", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-historical-"));
  const state = join(root, "state");
  const processDirectory = join(state, "process_legacy");
  try {
    mkdirSync(processDirectory, { recursive: true });
    const stdoutPath = join(processDirectory, "stdout.log");
    const stderrPath = join(processDirectory, "stderr.log");
    writeFileSync(stdoutPath, "durable stdout\n");
    writeFileSync(stderrPath, "durable stderr\n");
    const recordPath = join(state, "process_legacy.json");
    writeFileSync(recordPath, JSON.stringify({
      processId: "process_legacy",
      pid: 4242,
      runId: "run_legacy",
      sessionId: "worker:run_legacy:task:1",
      actor: { role: "worker", id: "worker_1" },
      command: process.execPath,
      args: ["--version"],
      cwd: root,
      environmentKeys: ["PATH"],
      startedAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:01.000Z",
      status: "running",
      exitCode: null,
      signal: null,
      stdoutPath,
      stderrPath,
    }, null, 2));
    const beforeRecord = readFileSync(recordPath);
    const beforeMtime = statSync(recordPath).mtimeMs;

    assert.deepEqual(readHistoricalManagedProcessObservations(state, "run_legacy"), [
      {
        processId: "process_legacy",
        pid: 4242,
        status: "running",
        exitCode: null,
        signal: null,
        startedAt: "2026-08-28T00:00:00.000Z",
        updatedAt: "2026-08-28T00:00:01.000Z",
        stdout: "durable stdout\n",
        stderr: "durable stderr\n",
        runId: "run_legacy",
        sessionId: "worker:run_legacy:task:1",
        actor: { role: "worker", id: "worker_1" },
        command: process.execPath,
        args: ["--version"],
        cwd: root,
        environmentKeys: ["PATH"],
      },
    ]);
    assert.deepEqual(readFileSync(recordPath), beforeRecord);
    assert.equal(statSync(recordPath).mtimeMs, beforeMtime);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("historical observations read current-schema records beside legacy ones (tunnel run)", () => {
  // A live run's current-schema record made every other run's historical open throw "malformed".
  const root = mkdtempSync(join(tmpdir(), "aiboard-managed-process-mixed-"));
  const state = join(root, "state");
  try {
    mkdirSync(state, { recursive: true });
    const current = (processId: string, runId: string) => ({
      processId, pid: 105760, runId, sessionId: `worker:${runId}:task:1`, actor: { role: "worker", id: "worker_1" },
      recordKind: "runner.managed-process", schemaVersion: 2, command: "node", args: ["npm-cli.js", "install"], cwd: root,
      environmentKeys: [], configurationDigest: "f".repeat(64), streamingSessionId: `managed-stream-${processId}`,
      launchId: `managed-launch-${processId}`, status: "stopped", exitCode: 0, signal: null,
      startedAt: "2026-10-19T19:25:06.415Z", updatedAt: "2026-10-19T19:35:32.515Z", stdout: "added 10 packages\n", stderr: "",
    });
    writeFileSync(join(state, "process_other.json"), JSON.stringify(current("process_other", "run_other")));
    writeFileSync(join(state, "process_mine.json"), JSON.stringify(current("process_mine", "run_mine")));
    assert.deepEqual(readHistoricalManagedProcessObservations(state, "run_old"), []);
    const [mine, ...rest] = readHistoricalManagedProcessObservations(state, "run_mine");
    assert.equal(rest.length, 0);
    assert.equal(mine?.processId, "process_mine");
    assert.equal(mine?.stdout, "added 10 packages\n");
    assert.equal(mine?.status, "stopped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
