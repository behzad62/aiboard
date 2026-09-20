import assert from "node:assert/strict";
import { AsyncResource } from "node:async_hooks";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { LspClient } from "../src/lsp-client.js";
import { LspLanguageProvider } from "../src/lsp-language-provider.js";
import { LanguageProviderRouter } from "../src/language-provider-router.js";
import type { LspTransportFactory } from "../src/lsp-transport.js";
import type { LanguageIntelligenceProvider } from "../src/language-intelligence.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";

for (const method of ["workspace/configuration", "window/workDoneProgress/create", "workspace/applyEdit"] as const)
test(`LSP ${method} server reply stays in the exact active scope across external output callbacks`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p683-server-control-")); t.diagnostic(`synthetic server-control root acquired: ${root}`);
  // Native pipe callbacks have their own async provenance, not the writer's ALS.
  const external = new AsyncResource("test-external-language-pipe");
  const replies: unknown[] = []; let closeCount = 0; let passed = false;
  const factory: LspTransportFactory = { open: async (request) => {
    const emit = async (message: unknown) => {
      const body = Buffer.from(JSON.stringify(message));
      await external.runInAsyncScope(request.onOutput, undefined, "stdout", Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
    };
    let queryId: number | undefined;
    const writer = { write: async (bytes: Uint8Array) => {
      const value = JSON.parse(Buffer.from(bytes).toString().split("\r\n\r\n")[1]!);
      if (value.id === "server-control") {
        replies.push(value);
        await emit({ jsonrpc: "2.0", id: queryId, result: { exactReply: true } });
      } else if (value.method === "fixture/query") {
        queryId = value.id;
        await emit({ jsonrpc: "2.0", id: "server-control", method, params: { items: [{}, {}], edit: { dangerous: true } } });
      } else if (value.id !== undefined) await emit({ jsonrpc: "2.0", id: value.id, result: value.method === "initialize" ? { capabilities: {} } : null });
    } };
    await request.initialize(writer);
    return { withInvocation: async (_owner, perform) => await perform(writer), closeVerified: async (shutdown) => { if (shutdown) await shutdown(writer); closeCount++; } };
  } };
  const client = new LspClient({ command: process.execPath, workspaceRoot: root, transportFactory: factory, requestTimeoutMs: 200 });
  try {
    const result = await client.withInvocation({ runId: "control-run", sessionId: "agent", actor: { role: "worker", id: "worker" }, toolName: "code.definition", callId: "exact-query", workspacePath: root, executionGrant: {} as OpaqueExecutionGrant }, () => client.request("fixture/query", {}));
    assert.deepEqual(result, { exactReply: true });
    assert.deepEqual(replies, [method === "workspace/configuration" ? { jsonrpc: "2.0", id: "server-control", result: [null, null] } : method === "window/workDoneProgress/create" ? { jsonrpc: "2.0", id: "server-control", result: null } : { jsonrpc: "2.0", id: "server-control", error: { code: -32601, message: "Unsupported server request workspace/applyEdit" } }]);
    await client.close(); assert.equal(closeCount, 1); passed = true;
  } finally {
    await client.close(); external.emitDestroy();
    if (passed) { await rm(root, { recursive: true }); t.diagnostic(`closed server-control root removed: ${root}`); }
    else t.diagnostic(`closed server-control failure root retained: ${root}`);
  }
});

test("LSP router never forwards opaque grants to an extension object with an LSP prototype", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p683-extension-boundary-")); await mkdir(join(root, "project"));
  t.diagnostic(`synthetic extension-boundary root acquired: ${root}`);
  let argumentCount = -1; let third: unknown; let passed = false;
  const descriptor = { id: "extension-language", displayName: "Extension", extensions: [".py"], rootMarkers: [], priority: 9 };
  const query = async (...args: unknown[]) => { argumentCount = args.length; third = args[2]; return { status: "ok" as const, results: [], truncated: false }; };
  const provider = Object.assign(Object.create(LspLanguageProvider.prototype), { descriptor, diagnostics: query, definition: query, references: query, workspaceSymbols: query, close: async () => undefined }) as LanguageIntelligenceProvider;
  const builtin = { ...provider, descriptor: { ...descriptor, id: "builtin", priority: 0 } };
  const router = new LanguageProviderRouter({ builtInProvider: builtin, extensionProviders: [{ extensionId: "configured-extension", descriptor, provider }], configuredServers: [] });
  try {
    await router.diagnostics({ root, path: "main.py" }, undefined, { runId: "run", sessionId: "agent", actor: { role: "worker", id: "worker" }, callId: "query", toolName: "code.diagnostics", executionGrant: {} as OpaqueExecutionGrant });
    assert.equal(argumentCount, 2); assert.equal(third, undefined); passed = true;
  } finally { await router.close(); if (passed) await rm(root, { recursive: true }); }
});
