import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArtifactStore } from "../../../src/artifact-store.js";
import { createExecutionHost, type ExecutionHostRunBinding } from "../../../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../../../src/native-build-factory.js";
import { ToolBroker } from "../../../src/tool-broker.js";
import { createManagedProcessTools } from "../../../src/managed-process-tools.js";
import { emptyRunnerCapabilitiesConfig } from "../../../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../../../src/runner-capability-contract.js";
import type { ToolExecutionOutput } from "../../../src/agent-contracts.js";
import { createRunnerInternalExecutionContext } from "../../../src/runner-internal-execution-context.js";
import { createExecutionHostMcpTransportFactory } from "../../../src/execution-host-mcp-transport.js";
import { McpManager, createMcpTools } from "../../../src/mcp-tools.js";
import { createRunnerCapabilityContract } from "../../../src/runner-capability-contract.js";
import { finalizeCertifiedFixture } from "../../support/certified-fixture-cleanup.js";
import {
  createQualificationFixtureRoot,
  deferQualificationFixtureRemoval,
  exitScenarioMain,
  summarizeError,
} from "../../support/qualification-harness.js";
import { isQualificationScenarioEntry } from "../../support/qualification-scenario-entry.js";

const program = `import fs from 'node:fs';
let n=0;const timer=setInterval(()=>{if(fs.existsSync(process.argv[2])){clearInterval(timer);process.stdout.write('managed-terminal\\n',()=>process.exit(7));return;}process.stdout.write('managed-ready-'+(++n)+' '+ 'x'.repeat(8192)+'\\n');},15);`;

async function withHost(body: (f: {
  project: string; quit: string; run: ExecutionHostRunBinding;
  outputMetadata: (output: ToolExecutionOutput) => Promise<Record<string, unknown>>;
  outputText: (output: ToolExecutionOutput) => Promise<string>;
  invoke: (name: string, input: Record<string, unknown>, agent?: string) => Promise<ToolExecutionOutput>;
}) => Promise<void>): Promise<void> {
  const root = createQualificationFixtureRoot("managed-native");
  const project = join(root, "project"), state = join(root, "state"), script = join(project, "server.mjs"), quit = join(project, "quit");
  await mkdir(project); await mkdir(state); await writeFile(script, program);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  let run: ExecutionHostRunBinding | undefined, failed = false, primary: unknown;
  try {
    run = await host.bindRun({
      runId: "managed-native", permissionProfile: "full",
      capabilityContract: { digest: "d".repeat(64) } as RunnerCapabilityContract,
      capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
    });
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, executionGrants: run.executionGrants, artifacts });
    for (const tool of createManagedProcessTools(run.managedProcesses)) broker.register(tool);
    let sequence = 0;
    const invoke = (name: string, input: Record<string, unknown>, agent = "agent") => broker.invoke({
      type: "tool_call", callId: `managed-call-${++sequence}`, name,
      arguments: name === "process.start" ? { command: process.execPath, args: [script, quit], ...input } : input,
    }, { runId: run!.runId, sessionId: agent, actor: { role: "worker", id: "worker" }, workspacePath: project });
    const outputText = async (output: ToolExecutionOutput): Promise<string> => (await Promise.all(output.content.map(async (block) => {
      if (block.type === "text") return block.text;
      if (block.type === "artifact") { const bytes = await artifacts.get(block.hash); return bytes.toString("utf8"); }
      return "";
    }))).join("\n");
    const outputMetadata = async (output: ToolExecutionOutput): Promise<Record<string, unknown>> => {
      assert.equal(output.isError, false, JSON.stringify(output));
      const json = output.content.find((block) => block.type === "json");
      if (json?.type === "json") return json.value as Record<string, unknown>;
      const artifact = output.content.find((block) => block.type === "artifact" && block.mediaType === "application/json");
      assert.ok(artifact?.type === "artifact");
      return JSON.parse((await artifacts.get(artifact.hash)).toString("utf8"));
    };
    await body({ project, quit, run, invoke, outputText, outputMetadata });
  } catch (error) { failed = true; primary = error; }
  finally {
    await finalizeCertifiedFixture({
      fixtureName: "managed native shared session", root, hasPrimaryFailure: failed, primaryFailure: primary,
      cleanup: async () => {
        const errors: unknown[] = [];
        for (const close of [() => run?.close(), () => host.close()]) {
          try { await close(); } catch (error) { errors.push(error); }
        }
        if (errors.length) throw new AggregateError(errors, "Exact managed fixture cleanup failed");
      },
      certify: async () => { assert.deepEqual(host.activeRunIds(), []); },
      removeRoot: async () => { deferQualificationFixtureRemoval(root); },
    });
  }
}

function metadata(output: ToolExecutionOutput): Record<string, unknown> {
  assert.equal(output.isError, false, JSON.stringify(output));
  const block = output.content.find((item) => item.type === "json");
  assert.ok(block?.type === "json");
  return block.value as Record<string, unknown>;
}

async function until(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("Managed observation did not reach its expected state.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function runManagedShared(): Promise<void> {
  await withHost(async (f) => {
    const one = metadata(await f.invoke("process.start", {})), two = metadata(await f.invoke("process.start", {}));
    assert.equal(one.status, "running"); assert.equal(two.status, "running");
    const sessions = f.run.streamingState.listSessionIds(); assert.equal(sessions.length, 2);
    assert.deepEqual(f.run.executionGrants.activeSnapshots(), []);
    await until(async () => {
      const output = await f.invoke("process.poll", { processId: one.processId });
      metadata(output);
      return (await f.outputText(output)).includes("managed-ready-");
    });
    const listed = await f.outputMetadata(await f.invoke("process.list", {}));
    assert.equal((listed.processes as unknown[]).length, 2);
    const foreign = await f.invoke("process.poll", { processId: one.processId }, "foreign-agent");
    assert.equal(foreign.isError, true);
    assert.equal(metadata(await f.invoke("process.signal", { processId: one.processId, signal: "SIGTERM" })).status, "stopped");
    await f.invoke("process.signal", { processId: two.processId, signal: "SIGTERM" });
    for (const id of sessions) {
      const record = f.run.streamingState.readSession(id)!;
      assert.equal(record.state, "released");
    }
  });
}

async function runManagedNaturalExit(): Promise<void> {
  await withHost(async (f) => {
    const started = metadata(await f.invoke("process.start", {}));
    await writeFile(f.quit, "exit only this owned fixture");
    let last: ToolExecutionOutput | undefined;
    await until(async () => {
      last = await f.invoke("process.poll", { processId: started.processId });
      return metadata(last).status === "stopped";
    }, 30_000);
    assert.equal(metadata(last!).exitCode, 7);
    assert.match(await f.outputText(last!), /managed-terminal/);
  });
}

async function runMcpLazy(): Promise<void> {
  const root = createQualificationFixtureRoot("mcp-lazy");
  const project = join(root, "project"); const state = join(root, "state");
  await mkdir(project); await mkdir(state);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const ambientEnvironment = snapshotNativeBuildAmbientEnvironment();
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment });
  const internal = createRunnerInternalExecutionContext({ projectDirectory: project, stateDirectory: state, processKernel: host.internalProcesses, ambientEnvironment });
  let manager: McpManager | undefined; let failed = false; let primary: unknown;
  try {
    const config = emptyRunnerCapabilitiesConfig(); const runId = "mcp-lazy-real";
    const servers = [{ name: "docs", command: `"${process.execPath}" "${fileURLToPath(new URL("../../fixtures/mcp-server.mjs", import.meta.url))}"` }];
    const attestation = await internal.attestConfiguredCapabilities({ mcpServers: servers, capabilitiesConfig: config });
    const discoverer = internal.createMcpDiscoveryExecutor({ runId, servers, attestation: attestation.mcp });
    const discovery = await discoverer.discover(); await discoverer.close();
    assert.equal(discovery.servers[0]!.status, "ready");
    const run = await host.bindRun({ runId, permissionProfile: "full", capabilitiesConfig: config, capabilityContract: await createRunnerCapabilityContract(config) });
    const reattest = () => internal.resolveMcpRuntimeLaunches({ servers, attestation: attestation.mcp });
    manager = new McpManager({
      cwd: project, servers, runId, discovery, reattest,
      transportFactory: createExecutionHostMcpTransportFactory({ run, projectDirectory: project, permissionProfile: "full", launches: await reattest() }),
      requestTimeoutMs: 30_000,
    });
    await manager.start();
    assert.deepEqual(run.streamingState.listSessionIds(), []);
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, artifacts, executionGrants: run.executionGrants, git: run.git });
    for (const tool of createMcpTools(manager, artifacts)) broker.register(tool);
    const invoke = (callId: string, sessionId = "actual-agent-1") => broker.invoke(
      { type: "tool_call", callId, name: "mcp.docs.lookup", arguments: { query: callId } },
      { runId, sessionId, actor: { role: "worker", id: "actual-worker" }, workspacePath: project },
    );
    const first = await invoke("first");
    assert.equal(first.isError, false, JSON.stringify(first));
    assert.equal(run.streamingState.listSessionIds().length, 1);
    const second = await invoke("other", "actual-agent-2");
    assert.equal(second.isError, false, JSON.stringify(second));
    assert.equal(run.streamingState.listSessionIds().length, 2);
    await manager.closeAgent({ runId, sessionId: "actual-agent-1", actor: { role: "worker", id: "actual-worker" } });
    await manager.close();
    await run.close();
    assert.deepEqual(host.activeRunIds(), []);
  } catch (error) { failed = true; primary = error; console.error(JSON.stringify(summarizeError(error))); }
  finally {
    await finalizeCertifiedFixture({
      fixtureName: "MCP lazy real host", root, hasPrimaryFailure: failed, primaryFailure: primary,
      cleanup: async () => {
        const failures: unknown[] = [];
        for (const close of [() => manager?.close(), () => internal.close(), () => host.close()]) {
          try { await close(); } catch (error) { failures.push(error); }
        }
        if (failures.length) throw new AggregateError(failures, "Every exact MCP fixture owner was attempted; cleanup remains unverified.");
      },
      certify: async () => { assert.deepEqual(host.activeRunIds(), []); },
      removeRoot: async () => { deferQualificationFixtureRemoval(root); },
    });
  }
}

if (isQualificationScenarioEntry(import.meta.url)) {
  const name = process.env.RUNNER_V2_QUALIFICATION_SCENARIO ?? "";
  const runners: Record<string, () => Promise<void>> = {
    "managed-shared": runManagedShared,
    "managed-natural-exit": runManagedNaturalExit,
    "mcp-lazy": runMcpLazy,
  };
  await exitScenarioMain(async () => {
    const run = runners[name];
    if (!run) throw new Error(`Unknown managed scenario: ${name}`);
    await run();
  });
}
