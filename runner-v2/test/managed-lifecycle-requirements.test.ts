import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { OpaqueExecutionGrant } from "../src/execution-grants.js";
import { createExecutionHostManagedRuntime } from "../src/execution-host-managed-transport.js";
import type { ExecutionHostRunBinding } from "../src/execution-host.js";

for (const flag of ["requireCompleteCleanup", "knownUnavoidableDetachment"] as const) {
  test(`managed launch request with ${flag} requests contained_workload`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), `managed-lifecycle-${flag}-`));
    let observed: string | undefined;
    const stop = new Error("controlled managed lifecycle boundary");
    const run = {
      runId: "run",
      openStreaming: async (request: { intent: { requiredLifecycleScope: string } }) => {
        observed = request.intent.requiredLifecycleScope;
        throw stop;
      },
      streamingState: {
        readSession: () => undefined,
        readHostLaunch: () => undefined,
      },
      streamingRuntime: {
        cleanupOwnedSession: async () => undefined,
        cleanupOwnedLaunch: async () => undefined,
      },
    } as unknown as ExecutionHostRunBinding;
    const runtime = createExecutionHostManagedRuntime({
      run,
      permissionProfile: "full",
      environment: {},
    });
    try {
      await assert.rejects(runtime.start({
        identity: {
          processId: `proc-${flag}`,
          runId: "run",
          sessionId: "agent",
          actor: { role: "worker", id: "worker" },
        },
        context: {
          runId: "run",
          sessionId: "agent",
          actor: { role: "worker", id: "worker" },
          callId: flag,
          toolName: "process.start",
          workspacePath: cwd,
          executionGrant: Object.freeze({}) as OpaqueExecutionGrant,
        },
        command: process.execPath,
        args: ["--version"],
        cwd,
        environment: {},
        startTimeoutMs: 5_000,
        cleanupTimeoutMs: 1_000,
        maxOutputBytes: 1_024,
        lifecycleRequirements: { [flag]: true },
        onTerminal: () => undefined,
      }), (error: unknown) => error === stop);
      assert.equal(observed, "contained_workload");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}

test("managed ordinary full launch still requests process_group", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "managed-lifecycle-ordinary-"));
  let observed: string | undefined;
  const stop = new Error("controlled managed ordinary boundary");
  const run = {
    runId: "run",
    openStreaming: async (request: { intent: { requiredLifecycleScope: string } }) => {
      observed = request.intent.requiredLifecycleScope;
      throw stop;
    },
    streamingState: { readSession: () => undefined, readHostLaunch: () => undefined },
    streamingRuntime: {
      cleanupOwnedSession: async () => undefined,
      cleanupOwnedLaunch: async () => undefined,
    },
  } as unknown as ExecutionHostRunBinding;
  const runtime = createExecutionHostManagedRuntime({
    run,
    permissionProfile: "full",
    environment: {},
  });
  try {
    await assert.rejects(runtime.start({
      identity: {
        processId: "proc-ordinary",
        runId: "run",
        sessionId: "agent",
        actor: { role: "worker", id: "worker" },
      },
      context: {
        runId: "run",
        sessionId: "agent",
        actor: { role: "worker", id: "worker" },
        callId: "ordinary",
        toolName: "process.start",
        workspacePath: cwd,
        executionGrant: Object.freeze({}) as OpaqueExecutionGrant,
      },
      command: process.execPath,
      args: ["--version"],
      cwd,
      environment: {},
      startTimeoutMs: 5_000,
      cleanupTimeoutMs: 1_000,
      maxOutputBytes: 1_024,
      onTerminal: () => undefined,
    }), (error: unknown) => error === stop);
    assert.equal(observed, "process_group");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
