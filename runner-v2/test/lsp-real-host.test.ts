import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LanguageProviderRouter } from "../src/language-provider-router.js";
import { createCodeIntelligenceTools } from "../src/code-intelligence-tools.js";
import { createFilesystemTools } from "../src/filesystem-tools.js";
import { ToolBroker } from "../src/tool-broker.js";
import { ArtifactStore } from "../src/artifact-store.js";
import type { LanguageIntelligenceProvider } from "../src/language-intelligence.js";
import type { RepositoryIntelligence } from "../src/repository-intelligence.js";
import { createOwnedLspFixture } from "./support/lsp-owned-fixture.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

test("LSP real shared host is lazy and code plus filesystem diagnostics retain exact fresh ToolBroker authority", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p683-native-")); t.diagnostic(`exact native LSP fixture acquired: ${root}`);
  const workspace = join(root, "workspace Ω"); await mkdir(workspace); await writeFile(join(workspace, "main.py"), "value = 1\nprint(value)\n");
  const owned = createOwnedLspFixture(root, workspace);
  const fallback = { descriptor: { id: "builtin", displayName: "builtin", extensions: [".ts"], rootMarkers: [], priority: 0 },
    workspaceSymbols: async () => ({ status: "unsupported_language", results: [], truncated: false }), definition: async () => assert.fail("wrong provider"), references: async () => assert.fail("wrong provider"), diagnostics: async () => assert.fail("wrong provider"), close: async () => undefined } as LanguageIntelligenceProvider;
  const router = new LanguageProviderRouter({ builtInProvider: fallback, extensionProviders: [], environment: {}, lspTransportFactory: owned.transportFactory,
    configuredServers: [{ descriptor: { id: "python", displayName: "Python", extensions: [".py"], rootMarkers: [], priority: 1 }, command: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/lsp-server.mjs", import.meta.url))], languageId: "python", requestTimeoutMs: 5000, shutdownTimeoutMs: 2000 }] });
  let failed = false; let primary: unknown;
  try {
    const run = await owned.ensure(); await router.preflightConfiguredServers(workspace);
    assert.deepEqual(run.streamingState.listSessionIds(), [], "LSP preflight cannot eagerly start a server");
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, executionGrants: run.executionGrants, artifacts: new ArtifactStore(join(root, "artifacts")) });
    for (const tool of createCodeIntelligenceTools({ language: router, repository: {} as RepositoryIntelligence })) broker.register(tool);
    for (const tool of createFilesystemTools({ diagnostics: router })) broker.register(tool);
    const invoke = (name: string, callId: string, args: Record<string, unknown>, agent = "agent-one") => broker.invoke({ type: "tool_call", callId, name, arguments: args },
      { runId: owned.runId, sessionId: agent, actor: { role: "worker", id: "actual-worker" }, workspacePath: workspace });
    const first = await invoke("code.diagnostics", "original-code-call", { path: "main.py" });
    assert.equal(first.isError, false, JSON.stringify(first));
    const [sessionId] = run.streamingState.listSessionIds(); assert.ok(sessionId);
    const record = run.streamingState.readSession(sessionId)!;
    assert.equal(record.callId, "original-code-call"); assert.equal(record.toolName, "code.diagnostics"); assert.equal(record.agentSessionId, "agent-one");
    assert.deepEqual(record.actor, { role: "worker", id: "actual-worker" }); assert.deepEqual(record.envelope.access, []);
    const changed = await invoke("fs.write", "original-write-call", { path: "main.py", content: "value = 2\nprint(value)\n" });
    assert.equal(changed.isError, false, JSON.stringify(changed));
    assert.doesNotMatch(JSON.stringify(changed), /diagnosticsUnavailable/);
    assert.equal(run.streamingState.listSessionIds().length, 1, "same exact agent/root uses fresh grants without a replacement process");
    assert.deepEqual(run.executionGrants.activeSnapshots(), []);
    const other = await invoke("code.diagnostics", "other-agent-call", { path: "main.py" }, "agent-two"); assert.equal(other.isError, false, JSON.stringify(other));
    assert.equal(run.streamingState.listSessionIds().length, 2);
    await router.closeAgent({ runId: owned.runId, sessionId: "agent-one", actor: { role: "worker", id: "actual-worker" } });
    assert.equal(run.streamingState.readSession(sessionId)!.state, "released");
    assert.equal(run.streamingState.listSessionIds().filter((id) => run.streamingState.readSession(id)!.state === "active").length, 1);
    await router.close(); assert.ok(run.streamingState.listSessionIds().every((id) => run.streamingState.readSession(id)!.state === "released"));
    t.diagnostic("actual code grant, actual post-write grant, separate agent, protocol shutdown and shared release verified");
  } catch (error) { failed = true; primary = error; }
  finally { await finalizeCertifiedFixture({ fixtureName: "LSP exact native code/fs", root, hasPrimaryFailure: failed, primaryFailure: primary,
    cleanup: async () => { await router.close(); await owned.close(); }, certify: async () => undefined,
    removeRoot: async () => { await rm(root, { recursive: true }); t.diagnostic(`certified native LSP fixture removed: ${root}`); } }); }
});
