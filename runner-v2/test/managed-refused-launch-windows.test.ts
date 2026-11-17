import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import type { ToolExecutionContext } from "../src/agent-contracts.js";
import { ToolBroker } from "../src/tool-broker.js";
import { createManagedProcessTools } from "../src/managed-process-tools.js";
import { isProcessStopUnprovenError } from "../src/process-stop-proof.js";
import { WindowsBatchLaunchUnavailableError } from "../src/windows-process-backend.js";
import type { ProcessHostSemanticFacts } from "../src/process-host-semantic-probes.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

// CW5a: a real `.cmd` launch on a host whose batch-argv fact is not `verified`, through the production
// ExecutionHost, its managed runtime and ManagedProcessService. It runs under facts that select each Windows backend;
// the refusal comes before backend selection, so neither backend is reached.
for (const [backend, facts] of [
  ["portable", { portableDuplex: "verified", windowsBatchArgv: "unavailable", exactTreeBirth: "verified", jobContainment: "unavailable" }],
  ["Job", { portableDuplex: "unavailable", windowsBatchArgv: "unavailable", exactTreeBirth: "unavailable", jobContainment: "verified" }],
] as const satisfies readonly (readonly [string, ProcessHostSemanticFacts])[]) {
  test(`a refused .cmd launch (facts selecting the ${backend} backend) is never started: coded refusal, stopped record, clean detach`, { timeout: 60_000 }, async (t) => {
    if (process.platform !== "win32") { t.skip("The batch-argv refusal is Windows-only."); return; }
    const root = await mkdtemp(join(tmpdir(), "managed-refused-launch-"));
    const project = join(root, "project"), state = join(root, "state");
    await mkdir(project); await mkdir(state);
    const shim = join(project, "tool.cmd");
    await writeFile(shim, "@echo off\r\necho unreachable\r\n");
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment(), processHostFacts: facts });
    let run: Awaited<ReturnType<typeof host.bindRun>> | undefined, runClosed = false, failed = false, primary: unknown;
    try {
      run = await host.bindRun({ runId: "refused-launch", permissionProfile: "full", capabilityContract: { digest: "d".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
      const binding = run;
      const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, executionGrants: binding.executionGrants, artifacts, maxInlineOutputBytes: 64 * 1024 });
      // process.start runs ManagedProcessService.start on the broker's exact grant; the raw error is kept for the checks.
      let error: unknown, processId: string | undefined;
      for (const tool of createManagedProcessTools(binding.managedProcesses)) {
        broker.register(tool.definition.name !== "process.start" ? tool : { ...tool, execute: async (input: unknown, context: ToolExecutionContext) => {
          try { await binding.managedProcesses.start(input as { command: string }, context); }
          catch (caught) { error = caught; }
          return { content: [{ type: "text", text: "start returned" }], isError: false };
        } });
      }
      const owner = { runId: binding.runId, sessionId: "agent", actor: { role: "worker" as const, id: "worker" }, workspacePath: project };
      await broker.invoke({ type: "tool_call", callId: "call-1", name: "process.start", arguments: { command: shim } }, owner);

      assert.ok(error instanceof WindowsBatchLaunchUnavailableError, `expected the coded refusal, got ${String(error)}`);
      assert.equal(error.code, "windows_batch_argv_unverified");
      assert.equal(error instanceof AggregateError, false);
      assert.equal(isProcessStopUnprovenError(error), false, "the scheduler must not pause for a launch that never started");

      // The one managed record says stopped, and the owner's poll agrees.
      const files = (await readdir(join(state, "managed-processes"))).filter((name) => name.endsWith(".json"));
      assert.equal(files.length, 1, files.join(", "));
      processId = files[0]!.slice(0, -".json".length);
      const record = JSON.parse(await readFile(join(state, "managed-processes", files[0]!), "utf8")) as { status: string; pid: number };
      assert.equal(record.status, "stopped"); assert.equal(record.pid, 0);
      const polled = await broker.invoke({ type: "tool_call", callId: "call-2", name: "process.poll", arguments: { processId } }, owner);
      assert.equal(polled.isError, false, JSON.stringify(polled));
      const block = polled.content.find((item) => item.type === "json");
      assert.ok(block?.type === "json", JSON.stringify(polled.content));
      assert.equal((block.value as { status?: unknown }).status, "stopped");
      // Nothing of the launch exists: no streaming session and no host launch record for it.
      assert.deepEqual(binding.streamingState.listSessionIds(), []);
      assert.equal(binding.streamingState.readHostLaunch(`managed-launch-${processId}`), undefined);

      // The run detaches its managed runtime and closes with nothing left to stop.
      await binding.close(); runClosed = true;
    } catch (error) { failed = true; primary = error; }
    finally {
      await finalizeCertifiedFixture({ fixtureName: `refused .cmd launch (${backend})`, root, hasPrimaryFailure: failed, primaryFailure: primary,
        cleanup: async () => { const errors: unknown[] = []; for (const close of [() => runClosed ? undefined : run?.close(), () => host.close()]) { try { await close(); } catch (error) { errors.push(error); } } if (errors.length) throw new AggregateError(errors, "refused launch fixture cleanup failed"); },
        certify: async () => { assert.deepEqual(host.activeRunIds(), []); },
        removeRoot: async () => { await rm(root, { recursive: true }); } });
    }
  });
}
