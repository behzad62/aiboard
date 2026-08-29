import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ProcessBackend } from "../src/process-backend.js";
import { createProductionOneShotCommandFixture } from "./support/one-shot-command-executor.js";

const FAMILIES = [
  { name: "process", toolName: "process.run", taskId: undefined },
  { name: "evidence", toolName: "run_evidence_command", taskId: "task-evidence" },
  { name: "final-verification", toolName: "final-verification.command", taskId: "final-verification" },
] as const;

for (const family of FAMILIES) {
  test(`${family.name} production graph times out and cleans a TERM-ignoring grandchild`, async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), `aiboard-${family.name}-timeout-matrix-`));
    const marker = join(workspace, "grandchild.pid");
    const fixture = createProductionOneShotCommandFixture(t);
    try {
      const result = await fixture.internalExecution.execute(request(family, workspace, "timeout", 350, undefined, marker));
      assert.equal(result.process.outcome, "timed_out");
      assert.equal(result.process.cleanup.state, "verified_empty");
      const pid = Number(readFileSync(marker, "utf8"));
      assert.equal(await processExited(pid), true);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test(`${family.name} production graph cancellation cleans its TERM-ignoring grandchild`, async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), `aiboard-${family.name}-cancel-matrix-`));
    const marker = join(workspace, "grandchild.pid");
    const fixture = createProductionOneShotCommandFixture(t);
    const controller = new AbortController();
    try {
      const running = fixture.internalExecution.execute(request(family, workspace, "cancel", 10_000, controller.signal, marker));
      await waitFor(() => existsSync(marker), 5_000);
      controller.abort();
      const result = await running;
      assert.equal(result.process.outcome, "cancelled");
      assert.equal(result.process.cleanup.state, "verified_empty");
      const pid = Number(readFileSync(marker, "utf8"));
      assert.equal(await processExited(pid), true);
    } finally {
      controller.abort();
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test(`${family.name} production graph strict capability failure occurs before launch`, async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), `aiboard-${family.name}-strict-matrix-`));
    const marker = join(workspace, "must-not-launch");
    const fixture = createProductionOneShotCommandFixture(t, { permissionProfile: "project" });
    try {
      await assert.rejects(
        fixture.internalExecution.execute({
          executable: process.execPath,
          arguments: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'launched')`],
          workingDirectory: workspace,
          timeoutMs: 5_000,
          context: context(family, "strict"),
        }),
        (error: unknown) => (error as { code?: unknown }).code === "isolation_capability_unavailable",
      );
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  test(`${family.name} production graph restart preserves cleanup ownership for an outcome-unknown backend`, async (t) => {
    const workspace = mkdtempSync(join(tmpdir(), `aiboard-${family.name}-outcome-matrix-`));
    const fixture = createProductionOneShotCommandFixture(t, {
      backend: outcomeUnknownBackend(), backendId: "fixture-outcome-unknown",
      leaseDurationMs: 20, leaseHeartbeatMs: 5,
    });
    try {
      const initial = await fixture.internalExecution.execute({
        executable: process.execPath, arguments: ["--version"], workingDirectory: workspace,
        timeoutMs: 5_000, context: context(family, "outcome-unknown"),
      });
      assert.equal(initial.process.outcome, "cleanup_failed");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const recovery = await fixture.reconcileStartup();
      assert.equal(recovery.some((entry) => entry.state === "cleanup_blocked"), true, JSON.stringify(recovery));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

function outcomeUnknownBackend(): ProcessBackend {
  return {
    probe: async () => ({
      attestationVersion: 1, backendId: "fixture-outcome-unknown", verified: true,
      platformLabel: "fault-injected-beneath-runtime",
      capabilities: { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "unavailable" },
    }),
    launch: async () => ({
      opaqueIdentity: "owned-fixture-identity",
      birthFingerprint: { observedAt: new Date().toISOString(), discriminator: "owned-fixture-birth" },
      rootPid: 999_999,
      startedAt: new Date().toISOString(),
    }),
    observe: async () => ({ state: "exited", exitCode: 0 }),
    signal: async () => ({ state: "exited" }),
    verifyEmpty: async () => ({ empty: false, detail: "fault-injected unknown ownership" }),
    reconcile: async () => ({ state: "outcome_unknown" }),
    release: async () => ({ released: true }),
  };
}

function request(
  family: typeof FAMILIES[number],
  workspace: string,
  callId: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  marker: string,
) {
  const child = "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)";
  const script = `const fs=require('node:fs'); const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'}); fs.writeFileSync(${JSON.stringify(marker)},String(child.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
  return {
    executable: process.execPath,
    arguments: ["-e", script],
    workingDirectory: workspace,
    timeoutMs,
    context: { ...context(family, callId), ...(signal ? { signal } : {}) },
  };
}

function context(family: typeof FAMILIES[number], callId: string) {
  return {
    runId: `run-${family.name}`,
    sessionId: `session-${family.name}`,
    actor: { role: "worker" as const, id: `worker-${family.name}` },
    callId,
    toolName: family.toolName,
    ...(family.taskId ? { taskId: family.taskId } : {}),
    runnerInternal: true as const,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Fixture condition timed out.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function processExited(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { process.kill(pid, 0); }
    catch { return true; }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}
