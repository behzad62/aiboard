import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../src/artifact-store.js";
import { createExecutionHost, type ExecutionHostRunBinding } from "../../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../../src/native-build-factory.js";
import { emptyRunnerCapabilitiesConfig } from "../../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../../src/runner-capability-contract.js";
import type { ToolExecutionContext, ToolExecutionOutput } from "../../src/agent-contracts.js";
import { ToolBroker } from "../../src/tool-broker.js";
import { createManagedProcessTools } from "../../src/managed-process-tools.js";
import type { ProcessHostSemanticFacts } from "../../src/process-host-semantic-probes.js";
import { finalizeCertifiedFixture } from "./certified-fixture-cleanup.js";

/**
 * CW5a: one production ExecutionHost run whose managed processes are driven through the ToolBroker, as an agent
 * drives them. Failed starts keep the service's own error; a list can be repeated on its own call context.
 */
export interface ManagedLaunchFixture {
  readonly project: string;
  readonly state: string;
  readonly run: ExecutionHostRunBinding;
  /** process.start through the broker; the service's own error is kept, not the tool's text. */
  start(command: string, args?: string[]): Promise<{ processId?: string; error?: unknown }>;
  invoke(name: string, input: Record<string, unknown>): Promise<ToolExecutionOutput>;
  /** process.list through the broker, then the service's list again on that same call context. */
  listTwice(): Promise<{ first: ToolExecutionOutput; again: unknown }>;
  /** The id of the one managed record the latest failed start left. */
  failedId(): Promise<string>;
}

export async function withManagedLaunchRun(
  label: string,
  facts: ProcessHostSemanticFacts | undefined,
  body: (fixture: ManagedLaunchFixture) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "managed-launch-"));
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(project); await mkdir(state);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
    ...(facts ? { processHostFacts: facts } : {}) });
  let run: ExecutionHostRunBinding | undefined, runClosed = false, failed = false, primary: unknown;
  try {
    run = await host.bindRun({ runId: "managed-launch", permissionProfile: "full", capabilityContract: { digest: "d".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
    const binding = run;
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, executionGrants: binding.executionGrants, artifacts, maxInlineOutputBytes: 64 * 1024 });
    let lastError: unknown, lastId: string | undefined, listAgain: { error?: unknown } | undefined;
    for (const tool of createManagedProcessTools(binding.managedProcesses)) {
      if (tool.definition.name === "process.start") {
        broker.register({ ...tool, execute: async (input: unknown, context: ToolExecutionContext) => {
          try { lastId = (await binding.managedProcesses.start(input as { command: string; args?: string[] }, context)).processId; }
          catch (caught) { lastError = caught; }
          return { content: [{ type: "text", text: "start returned" }], isError: false };
        } });
      } else if (tool.definition.name === "process.list") {
        broker.register({ ...tool, execute: async (input: unknown, context: ToolExecutionContext) => {
          const output = await tool.execute(input, context);
          if (listAgain) {
            try { await binding.managedProcesses.list(context); listAgain.error = undefined; }
            catch (caught) { listAgain.error = caught; }
          }
          return output;
        } });
      } else broker.register(tool);
    }
    let call = 0;
    const invoke = (name: string, input: Record<string, unknown>) => broker.invoke({ type: "tool_call", callId: `call-${++call}`, name, arguments: input },
      { runId: binding.runId, sessionId: "agent", actor: { role: "worker", id: "worker" }, workspacePath: project });
    const known = new Set<string>();
    await body({
      project, state, run: binding, invoke,
      async start(command, args = []) {
        lastError = undefined; lastId = undefined;
        await invoke("process.start", { command, args });
        if (lastId) known.add(lastId);
        return { ...(lastId ? { processId: lastId } : {}), ...(lastError !== undefined ? { error: lastError } : {}) };
      },
      async listTwice() {
        const again: { error?: unknown } = { error: new Error("the second list did not run") };
        listAgain = again;
        try { return { first: await invoke("process.list", {}), again: again.error }; }
        finally { listAgain = undefined; }
      },
      async failedId() {
        const ids = (await readdir(join(state, "managed-processes"))).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).filter((id) => !known.has(id));
        assert.equal(ids.length, 1, ids.join(", ")); known.add(ids[0]!); return ids[0]!;
      },
    });
    // The run detaches its managed runtime and closes with nothing left to stop.
    await binding.close(); runClosed = true;
  } catch (error) { failed = true; primary = error; }
  finally {
    await finalizeCertifiedFixture({ fixtureName: `managed launch (${label})`, root, hasPrimaryFailure: failed, primaryFailure: primary,
      cleanup: async () => { const errors: unknown[] = []; for (const close of [() => runClosed ? undefined : run?.close(), () => host.close()]) { try { await close(); } catch (error) { errors.push(error); } } if (errors.length) throw new AggregateError(errors, "managed launch fixture cleanup failed"); },
      certify: async () => { assert.deepEqual(host.activeRunIds(), []); },
      removeRoot: async () => { await rm(root, { recursive: true }); } });
  }
}

export function toolJson(output: ToolExecutionOutput): Record<string, unknown> {
  assert.equal(output.isError, false, JSON.stringify(output));
  const block = output.content.find((item) => item.type === "json");
  assert.ok(block?.type === "json", JSON.stringify(output.content));
  return block.value as Record<string, unknown>;
}

/** A record saved stopped with pid 0 that has no streaming session or host launch, and that poll reports stopped. */
export async function assertNeverStarted(f: ManagedLaunchFixture, processId: string): Promise<void> {
  const record = JSON.parse(await readFile(join(f.state, "managed-processes", `${processId}.json`), "utf8")) as { status: string; pid: number };
  assert.equal(record.status, "stopped"); assert.equal(record.pid, 0);
  assert.equal(f.run.streamingState.readSession(`managed-stream-${processId}`), undefined);
  assert.equal(f.run.streamingState.readHostLaunch(`managed-launch-${processId}`), undefined);
  assert.equal(toolJson(await f.invoke("process.poll", { processId })).status, "stopped");
}

/** A live node process that ends itself, exit 0, once `quit` exists: no stop deadline in the test. */
export function quittingProcessArgs(quit: string): string[] {
  return ["-e", "const fs = require('node:fs'); const t = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(t); process.exit(0); } }, 20);", quit];
}

/** Waits, through process.read_output, until the process has exited. */
export async function readUntilExit(f: ManagedLaunchFixture, processId: string): Promise<Record<string, unknown>> {
  let read = toolJson(await f.invoke("process.read_output", { processId, waitMs: 15_000, until: { exit: true } }));
  const deadline = Date.now() + 15_000;
  while (read.status === "running" && Date.now() < deadline) read = toolJson(await f.invoke("process.read_output", { processId, waitMs: 5_000, until: { exit: true } }));
  return read;
}
