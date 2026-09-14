import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ManagedProcessService, readHistoricalManagedProcessObservations } from "../src/managed-process.js";

for (const variant of ["legacy-active", "future-active", "token", "port", "payload", "foreign-field", "bad-id"] as const) {
  test(`managed active records refuse unsafe or unsupported representation: ${variant}`, async t => {
    const root = await mkdtemp(join(tmpdir(), "p684-managed-record-")); t.diagnostic(`synthetic managed record root: ${root}`);
    const state = join(root, "state"); await mkdir(state); let passed = false;
    const legacy = { processId: "exact", pid: 42, runId: "run", sessionId: "agent", actor: { role: "worker", id: "worker" }, command: "fixture", args: [], cwd: root,
      environmentKeys: [], startedAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z", status: "running", exitCode: null, signal: null, stdoutPath: join(root, "stdout"), stderrPath: join(root, "stderr") };
    const current = { ...legacy, recordKind: "runner.managed-process", schemaVersion: 2, stdout: "", stderr: "", configurationDigest: "a".repeat(64), launchId: "managed-launch-exact", streamingSessionId: "managed-stream-exact" } as Record<string, unknown>;
    delete current.stdoutPath; delete current.stderrPath;
    const changed = variant === "legacy-active" ? legacy : { ...current,
      ...(variant === "future-active" ? { schemaVersion: 99 } : variant === "token" ? { supervisor: { token: "must-not-be-a-capability" } } : variant === "port" ? { port: 1234 } : variant === "payload" ? { inputPayload: "not-allowed" } : variant === "foreign-field" ? { unknown: true } : { processId: "../foreign" }) };
    const path = join(state, "exact.json"); await writeFile(path, JSON.stringify(changed)); const before = await readFile(path);
    try {
      assert.throws(() => new ManagedProcessService({ stateDirectory: state }), /schema|record|unsupported|identity/i);
      assert.deepEqual(await readFile(path), before); assert.deepEqual(await readdir(state), ["exact.json"]); passed = true;
    } finally { if (passed) await rm(root, { recursive: true }); else t.diagnostic(`synthetic refused-record evidence retained: ${root}`); }
  });
}

test("managed historical terminal compatibility is read-only and never publishes legacy endpoint secrets", async t => {
  const root = await mkdtemp(join(tmpdir(), "p684-managed-history-")); t.diagnostic(`historical compatibility root: ${root}`); let passed = false;
  const stdoutPath = join(root, "stdout"), stderrPath = join(root, "stderr"); await writeFile(stdoutPath, "historical output"); await writeFile(stderrPath, "");
  const record = { processId: "old", pid: 42, runId: "run", sessionId: "agent", actor: { role: "worker", id: "worker" }, command: "fixture", args: [], cwd: root, environmentKeys: [],
    startedAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z", status: "stopped", exitCode: 0, signal: null, stdoutPath, stderrPath,
    supervisor: { protocol: "aiboard-managed-process/v1", token: "SYNTHETIC-OLD-PRIVATE-TOKEN-NEVER-DISPLAY", supervisorPid: 99, port: 30000, statusPath: join(root, "never-read") } };
  const path = join(root, "old.json"); await writeFile(path, JSON.stringify(record)); const before = await readFile(path);
  try {
    const observed = readHistoricalManagedProcessObservations(root, "run");
    assert.equal(observed[0]?.stdout, "historical output"); assert.equal(observed[0]?.status, "stopped");
    assert.doesNotMatch(JSON.stringify(observed), /supervisor|TOKEN|30000|never-read/); assert.deepEqual(await readFile(path), before); passed = true;
  } finally { if (passed) await rm(root, { recursive: true }); else t.diagnostic(`historical compatibility failure retained: ${root}`); }
});
