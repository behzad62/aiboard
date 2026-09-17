import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LspClient, LspClientError } from "../src/lsp-client.js";
import type { LspTransportFactory, LspProtocolWriter } from "../src/lsp-transport.js";
import type { LanguageInvocationContext } from "../src/language-intelligence.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";
let ordinal = 0;
function context(root: string): LanguageInvocationContext {
  return { runId: "lsp-run", sessionId: "actual-agent", actor: { role: "worker", id: "worker" }, callId: `code-${++ordinal}`, toolName: "code.definition", workspacePath: root, executionGrant: Object.freeze({}) as OpaqueExecutionGrant };
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "p683-client-"));
  const calls: string[] = []; const owners: LanguageInvocationContext[] = []; let starts = 0; let closes = 0;
  let hold: Promise<void> | undefined; let release!: () => void;
  const factory: LspTransportFactory = { open: async (request) => {
    starts++;
    const writer: LspProtocolWriter = { write: async (bytes) => {
      const message = JSON.parse(Buffer.from(bytes).toString().split("\r\n\r\n")[1]!); calls.push(message.method ?? "reply");
      if ((message.method === "fixture/crash" || message.method === "fixture/cancelled")) { request.onFailure(new LspClientError(message.method === "fixture/cancelled" ? "request_cancelled" : "process_exited", "controlled request failure", message.method !== "fixture/cancelled")); return; }
      if (message.id !== undefined) {
        const result = message.method === "initialize" ? { capabilities: { positionEncoding: "utf-16" } } : message.method === "shutdown" ? null : message.params;
        const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
        for (let i = 0; i < frame.length; i += 7) await request.onOutput("stdout", frame.subarray(i, i + 7));
        if (message.method === "fixture/held") await hold;
      }
    } };
    await request.initialize(writer);
    return {
      withInvocation: async (invocation, operation) => { owners.push(invocation); return await operation(writer); },
      closeVerified: async (shutdown) => { if (shutdown) await shutdown(writer); closes++; },
    };
  } };
  const client = new LspClient({ command: process.execPath, workspaceRoot: root, transportFactory: factory, requestTimeoutMs: 500, restartLimit: 1 });
  return { root, client, calls, owners, get starts() { return starts; }, get closes() { return closes; },
    hold: () => { hold = new Promise<void>((r) => { release = r; }); }, release: () => release?.(),
    close: async () => { release?.(); await client.close(); await rm(root, { recursive: true }); } };
}
test("LSP shared client preserves framing, document versions and exact invocation without private spawn", async () => {
  const f = await fixture(); const owner = context(f.root);
  try {
    assert.equal(typeof f.client.withInvocation, "function", "LSP client needs an explicit shared invocation seam");
    assert.deepEqual(await f.client.withInvocation(owner, async () => {
      await f.client.openDocument({ path: "main.py", languageId: "python", text: "value=1", version: 1 });
      await f.client.updateDocument({ path: "main.py", text: "value=2", version: 2 });
      return await f.client.request("fixture/echo", { unicode: "Ω😀", value: 2 });
    }), { unicode: "Ω😀", value: 2 });
    assert.equal(f.starts, 1); assert.equal(f.owners[0]!.executionGrant, owner.executionGrant);
    assert.deepEqual(f.client.stats(), { starts: 1, restarts: 0, state: "running", openDocuments: 1 });
    await f.client.close(); assert.ok(f.calls.includes("shutdown")); assert.ok(f.calls.includes("exit"));
    assert.equal(f.closes, 1); assert.equal(f.client.stats().state, "closed");
  } finally { await f.close(); }
});
test("LSP shared client never replays a crashed request and reopens documents only on a fresh invocation", async () => {
  const f = await fixture();
  try {
    assert.equal(typeof f.client.withInvocation, "function");
    await f.client.withInvocation(context(f.root), async () => { await f.client.openDocument({ path: "main.py", languageId: "python", text: "value=1", version: 1 }); });
    await assert.rejects(f.client.withInvocation(context(f.root), async () => f.client.request("fixture/crash", {})), (error: unknown) => error instanceof LspClientError && error.code === "process_exited" && error.retryable);
    assert.equal(f.starts, 1); assert.equal(f.calls.filter((method) => method === "fixture/crash").length, 1);
    const result = await f.client.withInvocation(context(f.root), async () => f.client.request("fixture/echo", { fresh: true }));
    assert.deepEqual(result, { fresh: true }); assert.equal(f.starts, 2); assert.equal(f.client.stats().restarts, 1);
    assert.equal(f.calls.filter((method) => method === "textDocument/didOpen").length, 2);
  } finally { await f.close(); }
});
test("LSP response cannot report success before the shared write acknowledgement", async () => {
  const f = await fixture(); f.hold(); let completed = false;
  try {
    assert.equal(typeof f.client.withInvocation, "function");
    const operation = f.client.withInvocation(context(f.root), async () => f.client.request("fixture/held", {})).then(() => { completed = true; });
    for (let i = 0; i < 30 && !f.calls.includes("fixture/held"); i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(f.calls.includes("fixture/held")); assert.equal(completed, false);
    f.release(); await operation; assert.equal(completed, true);
  } finally { await f.close(); }
});


test("LSP fresh invocation may restart a cancelled non-idle session without changing the original error retryability", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.client.withInvocation(context(f.root), () => f.client.request("fixture/cancelled", {})),
      (error: unknown) => error instanceof LspClientError && error.code === "request_cancelled" && error.retryable === false);
    assert.equal(f.starts, 1); assert.equal(f.calls.filter((method) => method === "fixture/cancelled").length, 1);
    assert.deepEqual(await f.client.withInvocation(context(f.root), () => f.client.request("fixture/echo", { fresh: true })), { fresh: true });
    assert.equal(f.starts, 2); assert.equal(f.client.stats().restarts, 1);
  } finally { await f.close(); }
});


test("LSP provider callback validation errors retain their exact type without poisoning a quiescent protocol", async () => {
  const f = await fixture();
  class ProviderValidationError extends Error { readonly code = "out_of_workspace_uri"; }
  const failure = new ProviderValidationError("untrusted response path");
  try {
    await assert.rejects(f.client.withInvocation(context(f.root), async () => {
      await f.client.request("fixture/echo", {}); throw failure;
    }), (error: unknown) => error === failure);
    assert.equal(f.client.stats().state, "running");
    await f.client.withInvocation(context(f.root), () => f.client.request("fixture/echo", { later: true }));
    assert.equal(f.starts, 1);
  } finally { await f.close(); }
});


test("LSP shared shutdown budgets response and acknowledged exit as serial bounded phases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p683-shutdown-budget-"));
  const shutdownMs = 100, writeMs = 200;
  const phases: string[] = []; let elapsed = 0; let budget = 0; let closing = false; let closed = false;
  const factory: LspTransportFactory = { open: async (request) => {
    const writer: LspProtocolWriter = { write: async (bytes) => {
      const message = JSON.parse(Buffer.from(bytes).toString().split("\r\n\r\n")[1]!);
      if (closing) {
        phases.push(message.method);
        elapsed += message.method === "shutdown" ? shutdownMs - 1 : writeMs - 1;
        if (elapsed >= budget) throw new LspClientError("write_failed", "serial cleanup phases exceeded their shared grace budget");
      }
      if (message.id !== undefined) {
        const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { capabilities: {} } : null }));
        await request.onOutput("stdout", Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
      }
    } };
    await request.initialize(writer);
    return { withInvocation: async (_owner, operation) => await operation(writer),
      closeVerified: async (shutdown, graceMs) => {
        assert.ok(shutdown); closing = true; budget = graceMs!; elapsed = 0;
        await shutdown(writer); closed = true;
      } };
  } };
  const client = new LspClient({ command: process.execPath, workspaceRoot: root, transportFactory: factory,
    shutdownTimeoutMs: shutdownMs, writeTimeoutMs: writeMs });
  let passed = false;
  try {
    await client.withInvocation(context(root), async () => undefined);
    await client.close();
    assert.deepEqual(phases, ["shutdown", "exit"]);
    assert.equal(elapsed, shutdownMs + writeMs - 2);
    assert.equal(budget, shutdownMs + writeMs, "one fixed grace contains both serial phases without resetting either configured bound");
    assert.equal(closed, true); passed = true;
  } finally {
    await client.close().catch(() => undefined);
    if (passed) { await rm(root, { recursive: true }); t.diagnostic(`closed synthetic shutdown-budget root removed: ${root}`); }
    else t.diagnostic(`synthetic shutdown-budget failure retained: ${root}`);
  }
});
