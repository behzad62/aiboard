import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as finalVerification from "../src/final-verification-runtime.js";
import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import { ManagedProcessService } from "../src/managed-process.js";
import type { ManagedProcessRunRuntime } from "../src/managed-process-transport.js";

const at = "2026-09-14T00:00:00.000Z";

test("final verification managed adapter issues a fresh exact run-owned grant for start poll and stop", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p684-final-managed-authority-"));
  t.diagnostic(`synthetic final-verification managed root acquired: ${root}`);
  const runId = "final-managed-run";
  const seen: Array<{ operation: string; toolName?: string; callId?: string; hasGrant: boolean }> = [];
  const snapshot = (processId: string, status: "running" | "stopped") => ({ processId, pid: 42, status, exitCode: status === "stopped" ? 0 : null,
    signal: null, startedAt: at, updatedAt: at, stdout: "ready", stderr: "" } as const);
  const runtime: ManagedProcessRunRuntime = {
    runId,
    async start(request) {
      seen.push({ operation: "start", toolName: request.context.toolName, callId: request.context.callId, hasGrant: Boolean(request.context.executionGrant) });
      assert.ok(request.context.executionGrant);
      return snapshot(request.identity.processId, "running");
    },
    async observe(target, context) {
      seen.push({ operation: "poll", toolName: context?.toolName, callId: context?.callId, hasGrant: Boolean(context?.executionGrant) });
      assert.ok(context?.executionGrant);
      return snapshot(target.processId, "running");
    },
    async stop(target, context) {
      seen.push({ operation: "stop", toolName: context?.toolName, callId: context?.callId, hasGrant: Boolean(context?.executionGrant) });
      assert.ok(context?.executionGrant);
      return snapshot(target.processId, "stopped");
    },
  };
  let processSequence = 0;
  const service = new ManagedProcessService({ stateDirectory: join(root, "managed"), runtime, idFactory: () => `owned-${++processSequence}` });
  const grants = createExecutionGrantAuthority();
  let passed = false;
  try {
    const factory = (finalVerification as unknown as Record<string, unknown>).createFinalVerificationManagedProcessAdapter;
    assert.equal(typeof factory, "function", "final verification must use an explicit run-owned managed authority adapter");
    const adapter = (factory as (input: Record<string, unknown>) => {
      start(input: { executable: string; args: string[]; cwd: string }): Promise<{ processId: string }>;
      poll(processId: string): Promise<unknown>;
      stop(processId: string): Promise<unknown>;
    })({ service, executionGrants: grants, permissionProfile: "full", runId, taskId: "verify", callScope: "runtime-smoke", actor: { role: "verifier", id: "verifier" } });
    const started = await adapter.start({ executable: "fixture", args: [], cwd: root });
    await adapter.poll(started.processId);
    await adapter.stop(started.processId);
    const browserAdapter = (factory as (input: Record<string, unknown>) => {
      start(input: { executable: string; args: string[]; cwd: string }): Promise<{ processId: string }>;
      stop(processId: string): Promise<unknown>;
    })({ service, executionGrants: grants, permissionProfile: "full", runId, taskId: "verify", callScope: "browser", actor: { role: "verifier", id: "verifier" } });
    const browser = await browserAdapter.start({ executable: "fixture", args: [], cwd: root });
    await browserAdapter.stop(browser.processId);
    assert.deepEqual(seen.map(item => item.toolName), ["process.start", "process.poll", "process.signal", "process.start", "process.signal"]);
    assert.equal(new Set(seen.map(item => item.callId)).size, 5, "each operation and verification check requires fresh call authority");
    assert.ok(seen.every(item => item.hasGrant));
    assert.deepEqual(grants.activeSnapshots(), [], "runner-internal grants are revoked after each exact operation");
    passed = true;
  } finally {
    await service.close().catch(() => undefined);
    if (passed) { await rm(root, { recursive: true }); t.diagnostic(`verified final-verification managed root removed: ${root}`); }
    else t.diagnostic(`final-verification managed RED evidence retained: ${root}`);
  }
});
// VF8: which start failures leave nothing running. Only the managed service's own primary error
// (its exact cleanup verified) is a clean failure; its AggregateError, and a call that fails after
// the start resolved, leave the program not proven stopped.
test("final verification managed adapter tells a clean failed start from one whose cleanup is unverified", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "vf8-final-managed-start-"));
  const runId = "final-managed-start-run";
  const snapshot = (processId: string, status: "running" | "stopped") => ({ processId, pid: 42, status, exitCode: status === "stopped" ? 0 : null,
    signal: null, startedAt: at, updatedAt: at, stdout: "", stderr: "" } as const);
  let startFails = true;
  let stopFails = false;
  const stops: string[] = [];
  const runtime: ManagedProcessRunRuntime = {
    runId,
    async start(request) {
      if (startFails) throw new Error("fixture start failed");
      return snapshot(request.identity.processId, "running");
    },
    async observe(target) { return snapshot(target.processId, "running"); },
    async stop(target) {
      stops.push(target.processId);
      if (stopFails) throw new Error("fixture cleanup failed");
      return snapshot(target.processId, "stopped");
    },
  };
  let processSequence = 0;
  const service = new ManagedProcessService({ stateDirectory: join(root, "managed"), runtime, idFactory: () => `owned-${++processSequence}` });
  const grants = createExecutionGrantAuthority();
  let failRevokes = 0;
  const flakyGrants = {
    issue: (...args: Parameters<typeof grants.issue>) => grants.issue(...args),
    revoke: async (...args: Parameters<typeof grants.revoke>) => {
      await grants.revoke(...args);
      if (failRevokes > 0) {
        failRevokes -= 1;
        throw new AggregateError([new Error("fixture revoke failed")], "Execution grant revocation failed closed with an active cleanup blocker.");
      }
    },
  };
  type Adapter = { start(input: { executable: string; args: string[]; cwd: string }): Promise<{ processId: string }>; stop(processId: string): Promise<{ status: string }> };
  const adapterFor = (executionGrants: unknown) => finalVerification.createFinalVerificationManagedProcessAdapter({
    service, executionGrants, permissionProfile: "full", runId, taskId: "verify", callScope: "runtime-smoke", actor: { role: "verifier", id: "verifier" },
  } as Parameters<typeof finalVerification.createFinalVerificationManagedProcessAdapter>[0]) as unknown as Adapter;
  let passed = false;
  try {
    // The start failed and the service stopped what it launched: a clean failure.
    const clean = await adapterFor(grants).start({ executable: "fixture", args: [], cwd: root }).then(() => undefined, (error: unknown) => error);
    assert.ok(clean instanceof finalVerification.FinalVerificationStartFailedCleanly, String(clean));
    assert.equal((clean as Error).message, "fixture start failed");
    assert.deepEqual(stops, ["owned-1"]);
    // The start failed and so did its cleanup: the service's AggregateError is unverified.
    stopFails = true;
    const unverified = await adapterFor(grants).start({ executable: "fixture", args: [], cwd: root }).then(() => undefined, (error: unknown) => error);
    assert.ok(unverified instanceof finalVerification.FinalVerificationStartUnverified, String(unverified));
    assert.ok((unverified as Error).cause instanceof AggregateError);
    assert.equal((unverified as finalVerification.FinalVerificationStartUnverified).snapshot, undefined);
    // The start resolved, then the grant revoke failed: unverified, and the snapshot is kept so
    // the Runner can still stop the program.
    startFails = false;
    stopFails = false;
    failRevokes = 1;
    const adapter = adapterFor(flakyGrants);
    const revoked = await adapter.start({ executable: "fixture", args: [], cwd: root }).then(() => undefined, (error: unknown) => error);
    assert.ok(revoked instanceof finalVerification.FinalVerificationStartUnverified, String(revoked));
    const kept = (revoked as finalVerification.FinalVerificationStartUnverified).snapshot;
    assert.equal(kept?.processId, "owned-3");
    assert.equal(kept?.status, "running");
    assert.equal((await adapter.stop(kept!.processId)).status, "stopped");
    // An error before the service ran (the grant could not be issued) is unverified too.
    const unissued = await adapterFor({ issue: async () => { throw new Error("fixture issue failed"); }, revoke: async () => undefined })
      .start({ executable: "fixture", args: [], cwd: root }).then(() => undefined, (error: unknown) => error);
    assert.ok(unissued instanceof finalVerification.FinalVerificationStartUnverified, String(unissued));
    passed = true;
  } finally {
    await service.close().catch(() => undefined);
    if (passed) await rm(root, { recursive: true });
    else t.diagnostic(`final-verification managed start evidence retained: ${root}`);
  }
});
