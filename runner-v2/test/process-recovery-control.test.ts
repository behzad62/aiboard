import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BuildRuntime } from "../src/build-runtime.js";
import type { NativeBuildSpec } from "../src/build-spec.js";
import { ControlServer } from "../src/control-server.js";
import { NativeBuildManager, type NativeBuildRuntimeHandle } from "../src/native-build-manager.js";
import type { RecoveryAuditRecord } from "../src/process-recovery.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";

const spec: NativeBuildSpec = {
  version: 2, runId: "run-recovery", projectId: "project", objective: "Recover exceptional process",
  architectRuntimeId: "architect", workerRuntimeIds: ["worker"], verifierRuntimeIds: ["verifier"],
  alwaysRequireIndependentVerifier: false, maxConcurrency: 1, permissionProfile: "project",
  runPolicy: "finish", budgetLimits: {},
  createdAt: "2026-09-15T00:00:00.000Z", idempotencyKey: "spec:recovery",
};
const record = { proposalId: "proposal-1", proposalFingerprint: "a".repeat(64), state: "user_decision_required" } as RecoveryAuditRecord;
test("native Build manager exposes recovery only through the live handle", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-task11-manager-"));
  const calls: string[] = [];
  const recovery = {
    records: () => ({ [record.proposalId]: record }),
    generate: async (invocationId: string, proposalId: string) => { calls.push(`generate:${invocationId}:${proposalId}`); return record; },
    decide: async (proposalId: string, fingerprint: string, decision: "approve" | "reject") => { calls.push(`decide:${proposalId}:${fingerprint}:${decision}`); return record; },
    execute: async (proposalId: string, fingerprint: string) => { calls.push(`execute:${proposalId}:${fingerprint}`); return record; },
  };
  const runtime = { id: spec.runId, projection: () => ({ runId: spec.runId, status: "paused" }) } as unknown as BuildRuntime;
  const handle = { runtime, processRecovery: recovery, cleanup: async () => {}, close: async () => {} } as unknown as NativeBuildRuntimeHandle;
  const manager = new NativeBuildManager({ specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")), createRuntime: async () => handle,
    shouldAutoRun: () => false, onPumpResult: () => {}, onPumpError: () => {} });
  try {
    await manager.create(spec);
    assert.deepEqual(manager.processRecoveryRecords(spec.runId), { [record.proposalId]: record });
    assert.equal(await manager.generateProcessRecovery(spec.runId, "invocation", "proposal-1"), record);
    assert.equal(await manager.decideProcessRecovery(spec.runId, "proposal-1", record.proposalFingerprint, "approve"), record);
    assert.equal(await manager.executeProcessRecovery(spec.runId, "proposal-1", record.proposalFingerprint), record);
    assert.deepEqual(calls, [`generate:invocation:proposal-1`, `decide:proposal-1:${record.proposalFingerprint}:approve`, `execute:proposal-1:${record.proposalFingerprint}`]);
  } finally { await manager.close(); rmSync(root, { recursive: true, force: true }); }
});
test("control server recovery routes are authenticated, closed and serialize exact decisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-task11-control-"));
  const supervisor = new RunSupervisor(new SqliteEventStore(join(root, "runs.sqlite")));
  supervisor.createRun({ runId: spec.runId, projectPath: root, permissionProfile: "project", idempotencyKey: "create" });
  const calls: string[] = [];
  const processRecovery = {
    processRecoveryRecords: (runId: string) => { assert.equal(runId, spec.runId); return { [record.proposalId]: record }; },
    generateProcessRecovery: async (runId: string, invocationId: string, proposalId: string) => { calls.push(`generate:${runId}:${invocationId}:${proposalId}`); return record; },
    decideProcessRecovery: async (runId: string, proposalId: string, fingerprint: string, decision: "approve" | "reject") => { calls.push(`decide:${runId}:${proposalId}:${fingerprint}:${decision}`); return record; },
    executeProcessRecovery: async (runId: string, proposalId: string, fingerprint: string) => { calls.push(`execute:${runId}:${proposalId}:${fingerprint}`); return record; },
  };
  const server = new ControlServer({ supervisor, token: "secret", processRecovery, bootstrapRun: async () => ({ baselineRevision: "b".repeat(40), baselineRef: "refs/baseline" }) });
  try {
    const { url } = await server.start(0);
    assert.equal((await fetch(`${url}/v2/runs/${spec.runId}/build/recovery`)).status, 401);
    const auth = { Authorization: "Bearer secret", "Content-Type": "application/json" };
    const listed = await fetch(`${url}/v2/runs/${spec.runId}/build/recovery`, { headers: auth });
    assert.equal(listed.status, 200); assert.deepEqual((await listed.json() as { records: unknown }).records, [record]);
    const generated = await fetch(`${url}/v2/runs/${spec.runId}/build/recovery/generate`, { method: "POST", headers: auth, body: JSON.stringify({ invocationId: "invocation", proposalId: "proposal-1" }) });
    assert.equal(generated.status, 200);
    const decision = await fetch(`${url}/v2/runs/${spec.runId}/build/recovery/proposal-1/decision`, { method: "POST", headers: auth,
      body: JSON.stringify({ fingerprint: record.proposalFingerprint, decision: "approve" }) });
    assert.equal(decision.status, 200);
    const executed = await fetch(`${url}/v2/runs/${spec.runId}/build/recovery/proposal-1/execute`, { method: "POST", headers: auth,
      body: JSON.stringify({ fingerprint: record.proposalFingerprint }) });
    assert.equal(executed.status, 200);
    const widened = await fetch(`${url}/v2/runs/${spec.runId}/build/recovery/generate`, { method: "POST", headers: auth,
      body: JSON.stringify({ invocationId: "invocation", proposalId: "proposal-1", command: "taskkill /F" }) });
    assert.equal(widened.status, 400);
    assert.deepEqual(calls, [
      `generate:${spec.runId}:invocation:proposal-1`,
      `decide:${spec.runId}:proposal-1:${record.proposalFingerprint}:approve`,
      `execute:${spec.runId}:proposal-1:${record.proposalFingerprint}`,
    ]);
  } finally { await server.close(); supervisor.close(); rmSync(root, { recursive: true, force: true }); }
});

test("CLI connects the native Build recovery plane to the authenticated control server", () => {
  const source = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");
  assert.match(source, /new ControlServer\(\{[\s\S]*?processRecovery:\s*builds[\s\S]*?\}\)/);
});
