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
  const service = new ManagedProcessService({ stateDirectory: join(root, "managed"), runtime, idFactory: () => "owned" });
  const grants = createExecutionGrantAuthority();
  let passed = false;
  try {
    const factory = (finalVerification as unknown as Record<string, unknown>).createFinalVerificationManagedProcessAdapter;
    assert.equal(typeof factory, "function", "final verification must use an explicit run-owned managed authority adapter");
    const adapter = (factory as (input: Record<string, unknown>) => {
      start(input: { executable: string; args: string[]; cwd: string }): Promise<{ processId: string }>;
      poll(processId: string): Promise<unknown>;
      stop(processId: string): Promise<unknown>;
    })({ service, executionGrants: grants, permissionProfile: "full", runId, taskId: "verify", actor: { role: "verifier", id: "verifier" } });
    const started = await adapter.start({ executable: "fixture", args: [], cwd: root });
    await adapter.poll(started.processId);
    await adapter.stop(started.processId);
    assert.deepEqual(seen.map(item => item.toolName), ["process.start", "process.poll", "process.signal"]);
    assert.equal(new Set(seen.map(item => item.callId)).size, 3, "each operation requires fresh call authority");
    assert.ok(seen.every(item => item.hasGrant));
    assert.deepEqual(grants.activeSnapshots(), [], "runner-internal grants are revoked after each exact operation");
    passed = true;
  } finally {
    await service.close().catch(() => undefined);
    if (passed) { await rm(root, { recursive: true }); t.diagnostic(`verified final-verification managed root removed: ${root}`); }
    else t.diagnostic(`final-verification managed RED evidence retained: ${root}`);
  }
});