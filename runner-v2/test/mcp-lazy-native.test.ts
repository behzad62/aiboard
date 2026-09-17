import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { createRunnerInternalExecutionContext } from "../src/runner-internal-execution-context.js";
import { createExecutionHostMcpTransportFactory } from "../src/execution-host-mcp-transport.js";
import { McpManager, createMcpTools } from "../src/mcp-tools.js";
import { ToolBroker } from "../src/tool-broker.js";
import { createRunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

test("MCP real host stays lazy then reuses only exact fresh-grant agent sessions with verified shutdown", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p682-native-")); t.diagnostic(`exact native MCP fixture acquired: ${root}`);
  const project = join(root, "project"); const state = join(root, "state"); await mkdir(project); await mkdir(state);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const ambientEnvironment = snapshotNativeBuildAmbientEnvironment();
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment });
  const internal = createRunnerInternalExecutionContext({ projectDirectory: project, stateDirectory: state, processKernel: host.internalProcesses, ambientEnvironment });
  let manager: McpManager | undefined; let failed = false; let primary: unknown;
  try {
    const config = emptyRunnerCapabilitiesConfig(); const runId = "mcp-lazy-real";
    const servers = [{ name: "docs", command: `"${process.execPath}" "${fileURLToPath(new URL("./fixtures/mcp-server.mjs", import.meta.url))}"` }];
    const attestation = await internal.attestConfiguredCapabilities({ mcpServers: servers, capabilitiesConfig: config });
    const discoverer = internal.createMcpDiscoveryExecutor({ runId, servers, attestation: attestation.mcp });
    const discovery = await discoverer.discover(); await discoverer.close();
    assert.equal(discovery.servers[0]!.status, "ready"); assert.equal(discovery.servers[0]!.cleanupVerified, true);
    const run = await host.bindRun({ runId, permissionProfile: "full", capabilitiesConfig: config, capabilityContract: await createRunnerCapabilityContract(config) });
    const reattest = () => internal.resolveMcpRuntimeLaunches({ servers, attestation: attestation.mcp });
    manager = new McpManager({ cwd: project, servers, runId, discovery, reattest,
      transportFactory: createExecutionHostMcpTransportFactory({ run, projectDirectory: project, permissionProfile: "full", launches: await reattest() }), requestTimeoutMs: 10_000 });
    await manager.start(); assert.equal(manager.status()[0]!.status, "ready");
    assert.deepEqual(run.streamingState.listSessionIds(), [], "configuration/discovery must not leave a live per-run server");
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: project, artifacts, executionGrants: run.executionGrants, git: run.git });
    for (const tool of createMcpTools(manager, artifacts)) broker.register(tool);
    const invoke = (callId: string, sessionId = "actual-agent-1") => broker.invoke({ type: "tool_call", callId, name: "mcp.docs.lookup", arguments: { query: callId } },
      { runId, sessionId, actor: { role: "worker", id: "actual-worker" }, workspacePath: project });
    for (const call of ["first", "later"]) {
      const result = await invoke(call); assert.equal(result.isError, false, JSON.stringify(result));
      assert.ok(result.content.some((block) => block.type === "text" && block.text === `found:${call}`));
      assert.ok(result.content.some((block) => block.type === "artifact"));
      assert.equal(run.streamingState.listSessionIds().length, 1);
      assert.deepEqual(run.executionGrants.activeSnapshots(), [], "the ToolBroker parent must settle without preventing later fresh authority");
    }
    const firstId = run.streamingState.listSessionIds()[0]!; const first = run.streamingState.readSession(firstId)!;
    assert.equal(first.agentSessionId, "actual-agent-1"); assert.deepEqual(first.actor, { role: "worker", id: "actual-worker" });
    assert.equal(first.callId, "first"); assert.equal(first.toolName, "mcp.docs.lookup"); assert.deepEqual(first.envelope.access, []);
    assert.equal(first.envelope.networkApproved, false);
    const other = await invoke("other", "actual-agent-2");
    assert.equal(other.isError, false, JSON.stringify(other)); assert.equal(run.streamingState.listSessionIds().length, 2);
    await manager.closeAgent({ runId, sessionId: "actual-agent-1", actor: { role: "worker", id: "actual-worker" } });
    assert.equal(run.streamingState.readSession(firstId)!.state, "released");
    assert.equal(run.streamingState.listSessionIds().map((id) => run.streamingState.readSession(id)).filter((record) => record?.state === "active").length, 1);
    await manager.close();
    assert.ok(run.streamingState.listSessionIds().every((id) => run.streamingState.readSession(id)!.state === "released"));
    await run.close(); assert.deepEqual(host.activeRunIds(), []);
    t.diagnostic("real discovery, first retained grant, fresh reuse, separate agent and graceful cleanup verified");
  } catch (error) { failed = true; primary = error; }
  finally { await finalizeCertifiedFixture({ fixtureName: "MCP lazy real host", root, hasPrimaryFailure: failed, primaryFailure: primary,
    cleanup: async () => {
      const failures: unknown[] = [];
      for (const close of [() => manager?.close(), () => internal.close(), () => host.close()]) {
        try { await close(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "Every exact MCP fixture owner was attempted; cleanup remains unverified.");
    },
    certify: async () => { assert.deepEqual(host.activeRunIds(), []); },
    removeRoot: async () => { await rm(root, { recursive: true }); t.diagnostic(`certified native MCP fixture removed: ${root}`); } }); }
});
