import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionHostLspTransportFactory } from "../src/execution-host-lsp-transport.js";
import type { ExecutionHostRunBinding } from "../src/execution-host.js";
import type { LanguageInvocationContext } from "../src/language-intelligence.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";
import type { StreamingHandshakeControl } from "../src/streaming-process-session-runtime.js";

async function fixture(write: StreamingHandshakeControl["write"]) {
  const owner: LanguageInvocationContext = { runId: "framing", sessionId: "agent", actor: { role: "worker", id: "worker" },
    callId: "call", toolName: "code.definition", workspacePath: process.cwd(), executionGrant: {} as OpaqueExecutionGrant };
  const waitForOutput = (signal?: AbortSignal) => new Promise<boolean>((resolve) => {
    if (signal?.aborted) resolve(false); else signal?.addEventListener("abort", () => resolve(false), { once: true });
  });
  const run = { runId: owner.runId, openStreaming: async () => ({
    authorizeFirstOperation: () => ({}), waitForOutput,
    languageRequest: async (_grant: unknown, _expected: unknown, perform: (io: StreamingHandshakeControl) => Promise<unknown>) =>
      await perform({ write, waitForOutput, deliverOutput: async () => false }),
  }), streamingState: { readSession: () => ({ state: "released" }) },
    streamingRuntime: { cleanupOwnedSession: async () => undefined } } as unknown as ExecutionHostRunBinding;
  const factory = createExecutionHostLspTransportFactory({ run, permissionProfile: "full", environment: {} });
  const transport = await factory.open({ command: process.execPath, arguments: [], workspaceRoot: process.cwd(), invocation: owner,
    initialize: async () => "a".repeat(64), onOutput: () => undefined, onFailure: () => undefined });
  return { owner, transport };
}

test("LSP shared chunking serializes whole frames against concurrent server-control replies", async () => {
  const chunks: Buffer[] = [];
  const f = await fixture(async (bytes) => { chunks.push(Buffer.from(bytes)); await Promise.resolve(); });
  const body = Buffer.alloc(2 * 1024 * 1024 + 17, 65), reply = Buffer.from("control-reply");
  try {
    await f.transport.withInvocation(f.owner, async (writer) => { await Promise.all([writer.write(body, 1000), writer.write(reply, 1000)]); }, 2000);
    assert.ok(chunks.every((chunk) => chunk.length <= 1024 * 1024));
    assert.deepEqual(chunks.map((chunk) => chunk.length), [1024 * 1024, 1024 * 1024, 17, reply.length]);
    assert.deepEqual(Buffer.concat(chunks), Buffer.concat([body, reply]), "frame suffixes and protocol replies cannot interleave");
  } finally { await f.transport.closeVerified(); }
});

test("LSP shared chunking never issues a queued frame after a failed predecessor", async () => {
  const calls: number[] = [], failure = new Error("unknown first write acknowledgement");
  const f = await fixture(async (bytes) => { calls.push(bytes.length); await Promise.resolve(); throw failure; });
  try {
    await assert.rejects(f.transport.withInvocation(f.owner, async (writer) => {
      await Promise.all([writer.write(Buffer.alloc(2 * 1024 * 1024), 1000), writer.write(Buffer.from("later"), 1000)]);
    }, 2000), (error: unknown) => error === failure);
    assert.deepEqual(calls, [1024 * 1024], "an uncertain prefix forbids both its suffix and any later frame");
  } finally { await f.transport.closeVerified(); }
});
