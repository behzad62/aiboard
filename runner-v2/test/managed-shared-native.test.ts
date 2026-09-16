import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost, type ExecutionHostRunBinding } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { ToolBroker } from "../src/tool-broker.js";
import { createManagedProcessTools } from "../src/managed-process-tools.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import type { ToolExecutionOutput } from "../src/agent-contracts.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

const program = `import fs from 'node:fs';
let n=0;const timer=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(timer);process.stdout.write('managed-terminal\\n',()=>process.exit(7));return;}process.stdout.write('managed-ready-'+(++n)+' '+ 'x'.repeat(8192)+'\\n');},15);`;
async function withHost(t: TestContext, body: (f: { project: string; quit: string; run: ExecutionHostRunBinding; outputMetadata: (output: ToolExecutionOutput) => Promise<Record<string, unknown>>; outputText: (output: ToolExecutionOutput) => Promise<string>; invoke: (name: string, input: Record<string, unknown>, agent?: string) => Promise<ToolExecutionOutput> }) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "p684-managed-native-")); t.diagnostic(`exact native managed root acquired: ${root}`);
  const project = join(root, "project"), state = join(root, "state"), script = join(project, "server.mjs"), quit = join(project, "quit");
  await mkdir(project); await mkdir(state); await writeFile(script, program);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment() }); let run: ExecutionHostRunBinding | undefined, failed = false, primary: unknown;
  try {
    run = await host.bindRun({ runId: "managed-native", permissionProfile: "full", capabilityContract: { digest: "d".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, executionGrants: run.executionGrants, artifacts });
    for (const tool of createManagedProcessTools(run.managedProcesses)) broker.register(tool);
    let sequence = 0;
    const invoke = (name: string, input: Record<string, unknown>, agent = "agent") => broker.invoke({ type: "tool_call", callId: `managed-call-${++sequence}`, name, arguments: name === "process.start" ? { command: process.execPath, args: [script, quit], ...input } : input },
      { runId: run!.runId, sessionId: agent, actor: { role: "worker", id: "worker" }, workspacePath: project });
    const outputText = async (output: ToolExecutionOutput): Promise<string> => (await Promise.all(output.content.map(async block => {
      if (block.type === "text") return block.text;
      if (block.type === "artifact") { const bytes = await artifacts.get(block.hash); assert.ok(bytes.length <= 512 * 1024); return bytes.toString("utf8"); }
      return "";
    }))).join("\n");
    const outputMetadata = async (output: ToolExecutionOutput): Promise<Record<string, unknown>> => {
      assert.equal(output.isError, false, JSON.stringify(output));
      const json = output.content.find(block => block.type === "json");
      if (json?.type === "json") return json.value as Record<string, unknown>;
      const artifact = output.content.find(block => block.type === "artifact" && block.mediaType === "application/json");
      assert.ok(artifact?.type === "artifact"); const bytes = await artifacts.get(artifact.hash); assert.ok(bytes.length <= 512 * 1024);
      return JSON.parse(bytes.toString("utf8"));
    };
    await body({ project, quit, run, invoke, outputText, outputMetadata });
  } catch (error) { failed = true; primary = error; t.diagnostic(`managed original failure: ${JSON.stringify(errorSummary(error))}`); }
  finally {
    await finalizeCertifiedFixture({ fixtureName: "managed native shared session", root, hasPrimaryFailure: failed, primaryFailure: primary,
      cleanup: async () => { const errors: unknown[] = []; for (const close of [() => run?.close(), () => host.close()]) { try { await close(); } catch (error) { errors.push(error); t.diagnostic(`managed cleanup failure: ${JSON.stringify(errorSummary(error))}`); } } if (errors.length) throw new AggregateError(errors, "Exact managed fixture cleanup failed"); },
      certify: async () => { assert.deepEqual(host.activeRunIds(), []); },
      removeRoot: async () => { await rm(root, { recursive: true }); t.diagnostic(`verified native managed root removed: ${root}`); } });
  }
}
function metadata(output: ToolExecutionOutput): Record<string, unknown> {
  assert.equal(output.isError, false, JSON.stringify(output));
  const block = output.content.find(block => block.type === "json"); assert.ok(block?.type === "json"); return block.value as Record<string, unknown>;
}
async function until(check: () => Promise<boolean>, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) { if (Date.now() >= deadline) throw new Error("Managed observation did not reach its expected state."); await new Promise(resolve => setTimeout(resolve, 25)); }
}

test("managed real shared sessions survive start-grant revocation, drain output, list under fresh authority and stop exactly", { timeout: 120_000 }, async t => withHost(t, async f => {
  const one = metadata(await f.invoke("process.start", {})), two = metadata(await f.invoke("process.start", {}));
  assert.equal(one.status, "running"); assert.equal(two.status, "running");
  const sessions = f.run.streamingState.listSessionIds(); assert.equal(sessions.length, 2);
  assert.ok(sessions.every(id => id.startsWith("managed-stream-") && f.run.streamingState.readSession(id)!.state === "active"));
  assert.deepEqual(f.run.executionGrants.activeSnapshots(), []);
  await until(async () => { const output = await f.invoke("process.poll", { processId: one.processId }); metadata(output); return (await f.outputText(output)).includes("managed-ready-"); });
  const listed = await f.outputMetadata(await f.invoke("process.list", {})); assert.equal((listed.processes as unknown[]).length, 2);
  const foreign = await f.invoke("process.poll", { processId: one.processId }, "foreign-agent"); assert.equal(foreign.isError, true);
  assert.equal(metadata(await f.invoke("process.signal", { processId: one.processId, signal: "SIGTERM" })).status, "stopped");
  assert.equal(f.run.streamingState.readSession(sessions[0]!)!.state === "released" || f.run.streamingState.readSession(sessions[1]!)!.state === "released", true);
  assert.equal(metadata(await f.invoke("process.poll", { processId: two.processId })).status, "running");
  await f.invoke("process.signal", { processId: two.processId, signal: "SIGTERM" });
  for (const id of sessions) {
    const record = f.run.streamingState.readSession(id)!; assert.equal(record.state, "released");
    const resources = record.effects.flatMap(effect => effect.progress?.resources ?? []); assert.equal(resources.length, 6); assert.ok(resources.every(resource => resource.status === "verified"));
  }
}));

test("managed natural exit retains the exact exit code and final output after shared cleanup", { timeout: 120_000 }, async t => withHost(t, async f => {
  const started = metadata(await f.invoke("process.start", {}));
  await writeFile(f.quit, "exit only this owned fixture");
  let last: ToolExecutionOutput | undefined;
  await until(async () => { last = await f.invoke("process.poll", { processId: started.processId }); return metadata(last).status === "stopped"; }, 30_000);
  assert.equal(metadata(last!).exitCode, 7); assert.match(await f.outputText(last!), /managed-terminal/);
  assert.ok(f.run.streamingState.listSessionIds().every(id => f.run.streamingState.readSession(id)!.state === "released"));
}));

function errorSummary(error: unknown, depth = 0): unknown {
  if (depth > 5) return "bounded causes";
  if (!(error instanceof Error)) return String(error).slice(0,250);
  return { name: error.name, message: error.message.slice(0,500), code: (error as { code?: unknown }).code,
    ...(error instanceof AggregateError ? { errors: error.errors.map(e => errorSummary(e, depth + 1)) } : {}),
    ...(error.cause ? { cause: errorSummary(error.cause, depth + 1) } : {}) };
}

test("managed rejected executable discovery leaves a verifiable no-launch record and close remains repeatable", { timeout: 60000 }, async t => withHost(t, async f => {
  const refused = await f.invoke("process.start", { command: join(f.project, "missing-owned-fixture.exe") });
  assert.equal(refused.isError, true);
  assert.deepEqual(f.run.streamingState.listSessionIds(), []);
  await f.run.managedProcesses.stopRun(f.run.runId);
  await f.run.managedProcesses.stopRun(f.run.runId);
  const observations = await f.run.managedProcesses.listRun(f.run.runId);
  assert.equal(observations.length, 1); assert.equal(observations[0]!.status, "stopped");
}));
