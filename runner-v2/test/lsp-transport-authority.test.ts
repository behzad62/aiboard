import assert from "node:assert/strict";
import test from "node:test";
import { createExecutionHostLspTransportFactory } from "../src/execution-host-lsp-transport.js";
import { resolveLanguageServerExecutable } from "../src/language-server-executable.js";
import { LspClientError } from "../src/lsp-client.js";
import type { ExecutionHostRunBinding } from "../src/execution-host.js";
import type { LanguageInvocationContext } from "../src/language-intelligence.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";

const context = (id: string): LanguageInvocationContext => ({ runId: "run", sessionId: "agent", actor: { role: "worker", id: "worker" }, callId: id, toolName: "code.definition", workspacePath: process.cwd(), executionGrant: Object.freeze({}) as OpaqueExecutionGrant });
for (const mode of ["missing", "foreign-run", "strict-host-only"] as const) test(`LSP shared transport rejects ${mode} before backend launch or invented grant`, async () => {
  let launches = 0; let issued = 0;
  const run = { runId: "run", executionGrants: { issue: async () => { issued++; } }, openStreaming: async () => { launches++; } } as unknown as ExecutionHostRunBinding;
  const factory = createExecutionHostLspTransportFactory({ run, permissionProfile: mode === "strict-host-only" ? "project" : "full", environment: {} });
  const invocation = mode === "missing" ? {} : { ...context("call"), runId: mode === "foreign-run" ? "foreign" : "run" };
  await assert.rejects(factory.open({ command: process.execPath, arguments: [], workspaceRoot: process.cwd(), invocation: invocation as LanguageInvocationContext,
    initialize: async () => "a".repeat(64), onOutput: () => undefined, onFailure: () => undefined }),
    (error: unknown) => error instanceof LspClientError && error.code === "invalid_configuration");
  assert.equal(launches, 0); assert.equal(issued, 0);
});
test("LSP shared transport uses the real launching call and fresh exact language request authority", async () => {
  const first = context("first"); const next = context("next"); const large = context("large"); const semanticOwner = context("semantic"); const calls: string[] = []; const writeSizes: number[] = []; let state = "active"; let sessionId = "";
  const identity = await resolveLanguageServerExecutable(process.execPath, { environment: {} });
  const facade = { authorizeFirstOperation: (request: { operation: string }) => { assert.equal(request.operation, "language_request"); calls.push("first"); return {}; },
    authorizeOperation: (request: { binding: { callId: string }; grant: unknown }) => { assert.ok(["next", "large", "semantic"].includes(request.binding.callId)); const expectedGrant = request.binding.callId === "next" ? next.executionGrant : request.binding.callId === "large" ? large.executionGrant : semanticOwner.executionGrant; assert.equal(request.grant, expectedGrant); calls.push("next"); return {}; },
    waitForOutput: async (signal?: AbortSignal) => new Promise<boolean>((resolve) => { if (signal?.aborted) resolve(false); else signal?.addEventListener("abort", () => resolve(false), { once: true }); }),
    languageRequest: async (_authorization: unknown, expected: { operation: string }, perform: (io: { write(bytes: Uint8Array, timeout: number): Promise<void>; waitForOutput(signal?: AbortSignal): Promise<boolean>; deliverOutput(): Promise<boolean> }) => Promise<unknown>) => {
      assert.equal(expected.operation, "language_request");
      return await perform({ write: async (bytes) => { assert.ok(bytes.byteLength <= 1024 * 1024, "shared LSP transport must respect the concrete channel write bound"); writeSizes.push(bytes.byteLength); calls.push("write"); }, waitForOutput: async (signal) => signal?.aborted ? false : new Promise<boolean>((resolve) => signal?.addEventListener("abort", () => resolve(false), { once: true })), deliverOutput: async () => false });
    } };
  const run = { runId: "run", openStreaming: async (request: { sessionId: string; binding: unknown; grant: unknown; intent: { kind: string; requestedCapabilities: string[] }; envelope: { access: unknown[] } }) => {
    sessionId = request.sessionId; assert.equal(request.grant, first.executionGrant); assert.equal(request.intent.kind, "language_server");
    assert.deepEqual(request.intent.requestedCapabilities, ["tree_termination", "verified_emptiness"]); assert.deepEqual(request.envelope.access, []);
    return facade;
  }, streamingState: { readSession: () => ({ state }) }, streamingRuntime: { cleanupOwnedSession: async (request: { sessionId: string }) => { assert.equal(request.sessionId, sessionId); calls.push("cleanup"); state = "released"; } } } as unknown as ExecutionHostRunBinding;
  const factory = createExecutionHostLspTransportFactory({ run, permissionProfile: "full", environment: {} });
  const transport = await factory.open({ command: identity.path, attestedCommand: identity, arguments: [], workspaceRoot: process.cwd(), invocation: first,
    initialize: async () => "a".repeat(64), onOutput: () => undefined, onFailure: () => undefined });
  try {
    await transport.withInvocation(first, async (io) => { await io.write(Buffer.from("first"), 100); return 1; }, 1000);
    await transport.withInvocation(next, async (io) => { await io.write(Buffer.from("next"), 100); return 2; }, 1000);
    assert.deepEqual(calls.slice(0, 4), ["first", "write", "next", "write"]);
    await transport.withInvocation(large, async (io) => { await io.write(Buffer.alloc(2 * 1024 * 1024 + 17), 100); return 3; }, 1000);
    assert.deepEqual(writeSizes.slice(-3), [1024 * 1024, 1024 * 1024, 17]);
    const semantic = Object.assign(new Error("provider validation"), { code: "out_of_workspace_uri" });
    await assert.rejects(transport.withInvocation(semanticOwner, async () => { throw semantic; }, 1000), (error: unknown) => error === semantic);
    await assert.rejects(transport.withInvocation({ ...next, actor: { role: "worker", id: "foreign" } }, async () => undefined, 100), /owner|identity|authority/);
  } finally { await transport.closeVerified(); }
  assert.equal(state, "released"); assert.equal(calls.filter((call) => call === "cleanup").length, 1);
});


test("LSP failed initialization retains its typed cause and joins exact shared launch cleanup", async () => {
  const failure = new LspClientError("protocol_error", "unsupported position encoding");
  let state = "cleanup_blocked"; let cleaned = 0; let launched = "";
  const run = { runId: "run", openStreaming: async (request: { launchId: string; verifyHandshake: (io: unknown) => Promise<string> }) => {
    launched = request.launchId;
    try { await request.verifyHandshake({ write: async () => undefined,
      waitForOutput: async (signal?: AbortSignal) => new Promise<boolean>((resolve) => { if (signal?.aborted) resolve(false); else signal?.addEventListener("abort", () => resolve(false), { once: true }); }), deliverOutput: async () => false }); }
    catch { throw new Error("lower runtime launch wrapper"); }
    assert.fail("invalid initialization cannot adopt");
  }, streamingState: { readHostLaunch: () => ({ state }) }, streamingRuntime: { cleanupOwnedLaunch: async (request: { launchId: string }) => { assert.equal(request.launchId, launched); cleaned++; state = "released"; } } } as unknown as ExecutionHostRunBinding;
  const factory = createExecutionHostLspTransportFactory({ run, permissionProfile: "full", environment: {} });
  await assert.rejects(factory.open({ command: process.execPath, arguments: [], workspaceRoot: process.cwd(), invocation: context("bad-start"),
    initialize: async () => { throw failure; }, onOutput: () => undefined, onFailure: () => undefined }), (error: unknown) => error === failure);
  assert.equal(cleaned, 1); assert.equal(state, "released");
});
