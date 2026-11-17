import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost, type ExecutionHostRunBinding } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import type { ToolExecutionContext, ToolExecutionOutput } from "../src/agent-contracts.js";
import { ToolBroker } from "../src/tool-broker.js";
import { createManagedProcessTools } from "../src/managed-process-tools.js";
import { isProcessStopUnprovenError } from "../src/process-stop-proof.js";
import { WindowsBatchLaunchUnavailableError } from "../src/windows-process-backend.js";
import type { ProcessHostSemanticFacts } from "../src/process-host-semantic-probes.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

// CW5a: real `.cmd` launches through the production ExecutionHost, its managed runtime and ManagedProcessService.
const unverifiedPortable = { portableDuplex: "verified", windowsBatchArgv: "unavailable", exactTreeBirth: "verified", jobContainment: "unavailable" } as const;
const unverifiedJob = { portableDuplex: "unavailable", windowsBatchArgv: "unavailable", exactTreeBirth: "unavailable", jobContainment: "verified" } as const;
const verifiedPortable = { ...unverifiedPortable, windowsBatchArgv: "verified" } as const;

interface Fixture {
  project: string; state: string; run: ExecutionHostRunBinding;
  /** process.start through the broker; the service's own error is kept, not the tool's text. */
  start(command: string, args?: string[]): Promise<{ processId?: string; error?: unknown }>;
  invoke(name: string, input: Record<string, unknown>): Promise<ToolExecutionOutput>;
  /** The id of the one managed record a failed start left. */
  failedId(): Promise<string>;
}

async function withRun(t: TestContext, label: string, facts: ProcessHostSemanticFacts, body: (f: Fixture) => Promise<void>): Promise<void> {
  if (process.platform !== "win32") { t.skip("The batch-argv refusal is Windows-only."); return; }
  const root = await mkdtemp(join(tmpdir(), "managed-refused-launch-"));
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(project); await mkdir(state);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment(), processHostFacts: facts });
  let run: ExecutionHostRunBinding | undefined, runClosed = false, failed = false, primary: unknown;
  try {
    run = await host.bindRun({ runId: "refused-launch", permissionProfile: "full", capabilityContract: { digest: "d".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
    const binding = run;
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, executionGrants: binding.executionGrants, artifacts, maxInlineOutputBytes: 64 * 1024 });
    let lastError: unknown, lastId: string | undefined;
    for (const tool of createManagedProcessTools(binding.managedProcesses)) {
      broker.register(tool.definition.name !== "process.start" ? tool : { ...tool, execute: async (input: unknown, context: ToolExecutionContext) => {
        try { lastId = (await binding.managedProcesses.start(input as { command: string; args?: string[] }, context)).processId; }
        catch (caught) { lastError = caught; }
        return { content: [{ type: "text", text: "start returned" }], isError: false };
      } });
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
      async failedId() {
        const ids = (await readdir(join(state, "managed-processes"))).filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).filter((id) => !known.has(id));
        assert.equal(ids.length, 1, ids.join(", ")); known.add(ids[0]!); return ids[0]!;
      },
    });
    // The run detaches its managed runtime and closes with nothing left to stop.
    await binding.close(); runClosed = true;
  } catch (error) { failed = true; primary = error; }
  finally {
    await finalizeCertifiedFixture({ fixtureName: `refused .cmd launch (${label})`, root, hasPrimaryFailure: failed, primaryFailure: primary,
      cleanup: async () => { const errors: unknown[] = []; for (const close of [() => runClosed ? undefined : run?.close(), () => host.close()]) { try { await close(); } catch (error) { errors.push(error); } } if (errors.length) throw new AggregateError(errors, "refused launch fixture cleanup failed"); },
      certify: async () => { assert.deepEqual(host.activeRunIds(), []); },
      removeRoot: async () => { await rm(root, { recursive: true }); } });
  }
}

function json(output: ToolExecutionOutput): Record<string, unknown> {
  assert.equal(output.isError, false, JSON.stringify(output));
  const block = output.content.find((item) => item.type === "json");
  assert.ok(block?.type === "json", JSON.stringify(output.content));
  return block.value as Record<string, unknown>;
}

async function assertNeverStarted(f: Fixture, processId: string): Promise<void> {
  const record = JSON.parse(await readFile(join(f.state, "managed-processes", `${processId}.json`), "utf8")) as { status: string; pid: number };
  assert.equal(record.status, "stopped"); assert.equal(record.pid, 0);
  assert.equal(f.run.streamingState.readSession(`managed-stream-${processId}`), undefined);
  assert.equal(f.run.streamingState.readHostLaunch(`managed-launch-${processId}`), undefined);
  assert.equal(json(await f.invoke("process.poll", { processId })).status, "stopped");
}

for (const [backend, facts] of [["portable", unverifiedPortable], ["Job", unverifiedJob]] as const) {
  test(`a refused .cmd launch (facts selecting the ${backend} backend) is never started: coded refusal, stopped record, clean detach`, { timeout: 60_000 }, async (t) => withRun(t, backend, facts, async (f) => {
    const shim = join(f.project, "tool.cmd");
    await writeFile(shim, "@echo off\r\necho unreachable\r\n");
    const { error } = await f.start(shim);
    assert.ok(error instanceof WindowsBatchLaunchUnavailableError, `expected the coded refusal, got ${String(error)}`);
    assert.equal(error.code, "windows_batch_argv_unverified");
    assert.equal(error instanceof AggregateError, false);
    assert.equal(error.cause, undefined);
    assert.equal(isProcessStopUnprovenError(error), false, "the scheduler must not pause for a launch that never started");
    await assertNeverStarted(f, await f.failedId());
  }));
}

test("a .cmd on a host whose batch-argv fact is verified still runs through the managed runtime", { timeout: 60_000 }, async (t) => withRun(t, "verified", verifiedPortable, async (f) => {
  const shim = join(f.project, "ran.cmd");
  await writeFile(shim, "@echo off\r\necho batch-ran\r\n");
  const { processId, error } = await f.start(shim);
  assert.equal(error, undefined, String(error));
  assert.ok(processId);
  let read = json(await f.invoke("process.read_output", { processId, stream: "stdout", waitMs: 15_000, until: { pattern: "batch-ran" } }));
  let text = JSON.stringify(read);
  const deadline = Date.now() + 15_000;
  while (read.status === "running" && Date.now() < deadline) {
    read = json(await f.invoke("process.read_output", { processId, stream: "stdout", waitMs: 5_000, until: { exit: true } }));
    text += JSON.stringify(read);
  }
  assert.match(text, /batch-ran/);
  json(await f.invoke("process.signal", { processId, signal: "SIGTERM" }));
}));

test("after a refused .cmd and a command-not-found start, list and signal answer the stopped records beside a live process", { timeout: 60_000 }, async (t) => withRun(t, "list", unverifiedPortable, async (f) => {
  const shim = join(f.project, "tool.cmd");
  await writeFile(shim, "@echo off\r\necho unreachable\r\n");
  // The live process ends itself once the quit file exists, so the test waits on no stop deadline.
  const quit = join(f.project, "quit");
  const live = await f.start(process.execPath, ["-e", "const fs = require('node:fs'); const t = setInterval(() => { if (fs.existsSync(process.argv[1])) { clearInterval(t); process.exit(0); } }, 20);", quit]);
  assert.equal(live.error, undefined, String(live.error)); assert.ok(live.processId);
  assert.ok((await f.start(shim)).error instanceof WindowsBatchLaunchUnavailableError);
  const refused = await f.failedId();
  const missing = await f.start("aiboard-cw5a-no-such-command");
  assert.ok(missing.error !== undefined && !(missing.error instanceof AggregateError), String(missing.error));
  assert.equal(isProcessStopUnprovenError(missing.error), false);
  const notFound = await f.failedId();
  for (const processId of [refused, notFound]) await assertNeverStarted(f, processId);

  const listed = json(await f.invoke("process.list", {})) as { processes: Array<{ processId: string; status: string }> };
  const status = new Map(listed.processes.map((entry) => [entry.processId, entry.status]));
  assert.equal(status.get(live.processId!), "running");
  assert.equal(status.get(refused), "stopped");
  assert.equal(status.get(notFound), "stopped");
  for (const processId of [refused, notFound]) assert.equal(json(await f.invoke("process.signal", { processId, signal: "SIGTERM" })).status, "stopped");
  await writeFile(quit, "quit");
  let read = json(await f.invoke("process.read_output", { processId: live.processId!, waitMs: 15_000, until: { exit: true } }));
  const deadline = Date.now() + 15_000;
  while (read.status === "running" && Date.now() < deadline) read = json(await f.invoke("process.read_output", { processId: live.processId!, waitMs: 5_000, until: { exit: true } }));
  assert.equal(read.exitCode, 0);
  const after = json(await f.invoke("process.list", {})) as { processes: Array<{ processId: string; status: string }> };
  const final = new Map(after.processes.map((entry) => [entry.processId, entry.status]));
  assert.equal(final.size, 3);
  assert.notEqual(final.get(live.processId!), "running");
  assert.equal(final.get(refused), "stopped"); assert.equal(final.get(notFound), "stopped");
}));
