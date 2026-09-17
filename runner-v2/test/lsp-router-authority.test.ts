import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LanguageProviderRouter } from "../src/language-provider-router.js";
import type { LanguageIntelligenceProvider, LanguageInvocationContext } from "../src/language-intelligence.js";
import type { LspTransportFactory, LspProtocolWriter } from "../src/lsp-transport.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";

const descriptor = { id: "python", displayName: "Python", extensions: [".py"], rootMarkers: [], priority: 5 };
function builtin(): LanguageIntelligenceProvider {
  const query = async function (_query: unknown, _signal?: AbortSignal) { assert.equal(arguments.length, 2, "built-in and extension providers must never receive private grant context"); return { status: "ok" as const, results: [], truncated: false }; };
  return { descriptor: { ...descriptor, id: "builtin", extensions: [".ts"], priority: 0 }, workspaceSymbols: query, definition: query, references: query, diagnostics: query, close: async () => undefined };
}
let sequence = 0;
const invocation = (root: string, agent = "agent"): LanguageInvocationContext => ({ runId: "run", sessionId: agent, actor: { role: "worker", id: "worker" }, toolName: "code.diagnostics", callId: `call-${++sequence}`, workspacePath: root, executionGrant: Object.freeze({}) as OpaqueExecutionGrant });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "p683-router-")); await writeFile(join(root, "main.py"), "value=1\n"); await writeFile(join(root, "main.ts"), "const value=1;\n");
  const owners: LanguageInvocationContext[] = []; let closes = 0;
  const factory: LspTransportFactory = { open: async (request) => {
    owners.push(request.invocation);
    const writer: LspProtocolWriter = { write: async (bytes) => {
      const message = JSON.parse(Buffer.from(bytes).toString().split("\r\n\r\n")[1]!);
      if (message.id === undefined) return;
      const result = message.method === "initialize" ? { capabilities: { diagnosticProvider: { workspaceDiagnostics: true } } } : message.method === "shutdown" ? null : { items: [] };
      const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      await request.onOutput("stdout", Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
    } };
    await request.initialize(writer);
    return { withInvocation: async (_owner, perform) => await perform(writer), closeVerified: async (shutdown) => { if (shutdown) await shutdown(writer); closes++; } };
  } };
  const router = new LanguageProviderRouter({ builtInProvider: builtin(), extensionProviders: [], configuredServers: [{ descriptor, command: process.execPath, args: [], languageId: "python" }], lspTransportFactory: factory, environment: {} } as ConstructorParameters<typeof LanguageProviderRouter>[0]);
  return { root, router, owners, get closes() { return closes; }, close: async () => { await router.close(); await rm(root, { recursive: true }); } };
}
test("LSP router preflight is static and configured queries require the original authorization", async () => {
  const f = await fixture();
  try {
    await f.router.preflightConfiguredServers(f.root); assert.equal(f.owners.length, 0);
    await assert.rejects(f.router.diagnostics({ root: f.root, path: "main.py" }), /authority|invocation|grant/);
    assert.equal(f.owners.length, 0);
    const owner = invocation(f.root); assert.equal((await f.router.diagnostics({ root: f.root, path: "main.py" }, undefined, owner)).status, "ok");
    assert.equal(f.owners.length, 1); assert.equal(f.owners[0]!.executionGrant, owner.executionGrant);
    await f.router.diagnostics({ root: f.root, path: "main.ts" }, undefined, owner);
    assert.equal(f.owners.length, 1);
  } finally { await f.close(); }
});
test("LSP router separates agent identities and joins only the terminating agent's owned sessions", async () => {
  const f = await fixture();
  try {
    const one = invocation(f.root, "one"); const two = invocation(f.root, "two");
    await f.router.diagnostics({ root: f.root, path: "main.py" }, undefined, one);
    await f.router.diagnostics({ root: f.root, path: "main.py" }, undefined, two);
    assert.equal(f.owners.length, 2);
    await f.router.closeAgent(one); assert.equal(f.closes, 1);
    await f.router.diagnostics({ root: f.root, path: "main.py" }, undefined, invocation(f.root, "two")); assert.equal(f.owners.length, 2);
    await f.router.close(); assert.equal(f.closes, 2);
  } finally { await f.close(); }
});
