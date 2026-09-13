import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { LspClient, LspClientError } from "../src/lsp-client.js";
import type { LspTransportFactory } from "../src/lsp-transport.js";
import type { LanguageInvocationContext } from "../src/language-intelligence.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
function gate() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

async function fixture(t: TestContext, body: (f: {
  client: LspClient; root: string; writes: string[]; owners: LanguageInvocationContext[];
  writeGate: ReturnType<typeof gate>; closeGate: ReturnType<typeof gate>;
  setBlockedWrite(): void; setBlockedClose(): void; setFailure(value: LspClientError): void;
  invoke<T>(perform: () => Promise<T>, signal?: AbortSignal): Promise<T>;
}) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "p683-lifetime-"));
  t.diagnostic(`exact synthetic LSP lifetime root acquired: ${root}`);
  const writes: string[] = []; const owners: LanguageInvocationContext[] = [];
  const writeGate = gate(); const closeGate = gate();
  let blockedWrite = false; let blockedClose = false; let failure: LspClientError | undefined; let ordinal = 0;
  const factory: LspTransportFactory = { open: async (request) => {
    const writer = { write: async (bytes: Uint8Array) => {
      const message = JSON.parse(Buffer.from(bytes).toString().split("\r\n\r\n")[1]!); writes.push(message.method);
      if (message.method === "fixture/error" && failure) { request.onFailure(failure); return; }
      if (message.method === "textDocument/didOpen" && blockedWrite) await writeGate.promise;
      if (message.id !== undefined) {
        const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id,
          result: message.method === "initialize" ? { capabilities: {} } : message.method === "shutdown" ? null : {} }));
        await request.onOutput("stdout", Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
      }
    } };
    await request.initialize(writer);
    return {
      withInvocation: async (owner, operation) => {
        owners.push(owner);
        try { return await operation(writer); }
        catch (cause) { throw new LspClientError("process_error", "lower shared transport failure", true, { cause }); }
      },
      closeVerified: async (shutdown) => { if (blockedClose) await closeGate.promise; if (shutdown) await shutdown(writer); },
    };
  } };
  const client = new LspClient({ command: process.execPath, workspaceRoot: root, transportFactory: factory, requestTimeoutMs: 60, writeTimeoutMs: 2000 });
  const invoke = <T>(perform: () => Promise<T>, signal?: AbortSignal) => client.withInvocation({
    runId: "lifetime-run", sessionId: "agent", actor: { role: "worker", id: "worker" },
    callId: `call-${++ordinal}`, toolName: "code.definition", workspacePath: root,
    executionGrant: Object.freeze({}) as OpaqueExecutionGrant, ...(signal ? { signal } : {}),
  }, perform);
  let passed = false;
  try { await body({ client, root, writes, owners, writeGate, closeGate, invoke,
    setBlockedWrite: () => { blockedWrite = true; }, setBlockedClose: () => { blockedClose = true; }, setFailure: (value) => { failure = value; } }); passed = true; }
  finally {
    writeGate.resolve(); closeGate.resolve(); await client.close();
    if (passed) { await rm(root, { recursive: true }); t.diagnostic(`closed synthetic LSP lifetime root removed: ${root}`); }
    else t.diagnostic(`closed synthetic LSP failure evidence retained: ${root}`);
  }
}

for (const code of ["protocol_error", "frame_too_large", "process_exited", "request_timeout"] as const)
test(`LSP preserves its first ${code} protocol cause when shared transport subsequently becomes unavailable`, async (t) => fixture(t, async (f) => {
  const original = new LspClientError(code, "original family failure", true); f.setFailure(original);
  await assert.rejects(f.invoke(() => f.client.request("fixture/error", {})), (error: unknown) => error === original);
  assert.equal(f.writes.filter((method) => method === "fixture/error").length, 1);
}));

test("LSP caller failure is bounded independently of retained exact cleanup", async (t) => fixture(t, async (f) => {
  await f.invoke(async () => undefined); f.setBlockedClose();
  const original = new LspClientError("request_cancelled", "controlled cancelled request"); f.setFailure(original);
  let settled = false;
  const call = f.invoke(() => f.client.request("fixture/error", {})).catch((error: unknown) => { settled = true; return error; });
  try {
    for (let i = 0; i < 30 && !f.writes.includes("fixture/error"); i++) await turn();
    assert.ok(f.writes.includes("fixture/error"));
    for (let i = 0; i < 15; i++) await turn();
    assert.equal(settled, true, "a caller must not wait for the cleanup provider to release");
    assert.equal(await call, original);
    let closed = false; const closing = f.client.close().then(() => { closed = true; });
    await turn(); assert.equal(closed, false, "close still joins the retained resource owner");
    f.closeGate.resolve(); await closing;
  } finally { f.closeGate.resolve(); await call; }
}));

test("LSP queued invocations time out or cancel without borrowing an active writer", async (t) => fixture(t, async (f) => {
  await f.invoke(async () => undefined); f.setBlockedWrite();
  const first = f.invoke(() => f.client.openDocument({ path: "main.py", languageId: "python", version: 1, text: "owned" }));
  void first.catch(() => undefined);
  for (let i = 0; i < 30 && !f.writes.includes("textDocument/didOpen"); i++) await turn();
  assert.ok(f.writes.includes("textDocument/didOpen"));
  const admitted = f.owners.length;
  const second = f.invoke(() => f.client.request("fixture/queued-timeout", {}));
  const abort = new AbortController(); const third = f.invoke(() => f.client.request("fixture/queued-cancel", {}), abort.signal);
  const results = Promise.allSettled([second, third]); abort.abort();
  try {
    const values = await results;
    for (const [index, expected] of ["request_timeout", "request_cancelled"].entries()) {
      const value = values[index]!; assert.equal(value.status, "rejected");
      if (value.status === "rejected") { assert.ok(value.reason instanceof LspClientError); assert.equal(value.reason.code, expected); }
    }
    assert.equal(f.owners.length, admitted, "queued authority cannot enter the active protocol scope");
    assert.equal(f.writes.some((method) => method?.startsWith("fixture/queued-")), false);
    f.writeGate.resolve(); await first;
    assert.equal(f.client.stats().state, "running", "an unsent queued cancellation cannot retire someone else's active call");
  } finally { f.writeGate.resolve(); await first.catch(() => undefined); await results; }
}));

test("LSP language operation budget lets the typed write timeout settle before the shared ownership deadline", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p683-language-budget-"));
  t.diagnostic(`exact synthetic LSP language-budget root acquired: ${root}`);
  let observedBudget = 0; let blockedWriteStarted = false;
  const factory: LspTransportFactory = { open: async (request) => {
    const writer = { write: async (bytes: Uint8Array) => {
      const message = JSON.parse(Buffer.from(bytes).toString().split("\r\n\r\n")[1]!);
      if (message.method === "textDocument/didOpen") { blockedWriteStarted = true; await new Promise<void>(() => undefined); }
      if (message.id !== undefined) {
        const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id,
          result: message.method === "initialize" ? { capabilities: {} } : message.method === "shutdown" ? null : {} }));
        await request.onOutput("stdout", Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
      }
    } };
    await request.initialize(writer);
    return {
      withInvocation: async (_owner, operation, timeoutMs) => {
        observedBudget = timeoutMs; let timer: NodeJS.Timeout | undefined;
        try { return await Promise.race([operation(writer), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new LspClientError("process_error", "shared language scope expired first", true)), Math.max(1, timeoutMs - 10));
        })]); } finally { if (timer) clearTimeout(timer); }
      },
      closeVerified: async () => undefined,
    };
  } };
  const client = new LspClient({ command: process.execPath, workspaceRoot: root, transportFactory: factory,
    requestTimeoutMs: 40, writeTimeoutMs: 80, restartLimit: 0 });
  const owner: LanguageInvocationContext = { runId: "budget-run", sessionId: "agent", actor: { role: "worker", id: "worker" },
    callId: "budget-call", toolName: "code.definition", workspacePath: root, executionGrant: Object.freeze({}) as OpaqueExecutionGrant };
  let passed = false;
  try {
    await assert.rejects(client.withInvocation(owner, () => client.openDocument({ path: "main.py", languageId: "python", version: 1, text: "blocked" })),
      (error: unknown) => error instanceof LspClientError && error.code === "write_failed");
    assert.equal(blockedWriteStarted, true);
    assert.equal(observedBudget, 120, "one compound language_request owns one request deadline plus one bounded protocol-write phase");
    passed = true;
  } finally {
    await client.close().catch(() => undefined);
    if (passed) { await rm(root, { recursive: true }); t.diagnostic(`closed synthetic LSP language-budget root removed: ${root}`); }
    else t.diagnostic(`closed synthetic LSP language-budget failure root retained: ${root}`);
  }
});
