import { McpProtocolError } from "../src/mcp-rpc-peer.js";
import assert from "node:assert/strict";
import test from "node:test";
import { McpManager, createMcpTools, type McpManagerOptions, type McpTransportFactory, type McpRequestOwner, type McpTransportWriter } from "../src/mcp-tools.js";
import { mcpConfigurationDigest, canonicalMcpDigest } from "../src/mcp-configuration.js";
import type { McpDiscoveryResult } from "../src/runner-internal-execution-context.js";
import type { ToolExecutionContext } from "../src/agent-contracts.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";
import type { ArtifactStore } from "../src/artifact-store.js";

const server = { name: "docs", command: "fixture-command" };
const tools = [{ name: "lookup", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: false } }];
function discovery(): McpDiscoveryResult {
  return { version: 1, runId: "run-682", principal: { role: "runner_internal", purpose: "mcp_discovery", principalId: "discovery", callId: "discovery-call", runId: "run-682", deadlineMs: 1000 },
    servers: [{ name: "docs", configDigest: mcpConfigurationDigest(server), executableDigest: "a".repeat(64), status: "ready", tools, schemaDigest: canonicalMcpDigest(tools), cleanupVerified: true }] };
}
let sequence = 0;
function callContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return { runId: "run-682", sessionId: "agent-1", actor: { role: "worker", id: "worker-1" }, callId: `call-${++sequence}`, toolName: "mcp.docs.lookup",
    workspacePath: process.cwd(), executionGrant: Object.freeze({}) as OpaqueExecutionGrant, ...overrides };
}
function fixture(options: { maximumRestarts?: number; maximumSessions?: number; mode?: "normal" | "crash" | "schema" | "cleanup-blocked" | "hold" | "session-loss" | "session-refused" } = {}) {
  const calls = { opened: 0, closed: 0, requestWrites: 0, initializationWrites: 0, owners: [] as McpRequestOwner[], attestations: 0 };
  let mode = options.mode ?? "normal";
  let attestationGate: Promise<void> | undefined;
  let executableReplaced = false;
  let notifySchema: (() => void | Promise<void>) | undefined;
  let releaseRequest!: () => void; const requestGate = new Promise<void>((resolve) => { releaseRequest = resolve; });
  let fail: ((error: Error) => void) | undefined;
  const factory: McpTransportFactory = {
    open: async (request) => {
      calls.opened++; assert.ok(request.owner?.context.executionGrant, "a live launch must carry the actual first-call grant");
      calls.owners.push(request.owner!); fail = request.onFailure;
      notifySchema = () => request.onOutput("stdout", Buffer.from('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n'));
      const writer = { write: async (payload: Uint8Array) => {
        const message = JSON.parse(Buffer.from(payload).toString());
        if (message.method === "tools/call") {
          calls.requestWrites++;
          if (mode === "session-loss") return;
          if (mode === "hold") await requestGate;
          if (mode === "crash") { request.onFailure(new Error("lost server after request write")); return; }
        } else calls.initializationWrites++;
        if (message.id !== undefined) await request.onOutput("stdout", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id,
          result: message.method === "initialize" ? { protocolVersion: "2024-11-05" } : message.method === "tools/list" ? { tools: mode === "schema" ? [{ name: "replaced" }] : tools } : { content: [{ type: "text", text: "owned" }] } }) + "\n"));
      } };
      await request.handshake(writer);
      return { ...writer,
        request: async <T>(owner: McpRequestOwner, perform: (writer: McpTransportWriter) => Promise<T>) => { calls.owners.push(owner);
          if (mode === "session-refused") throw new Error("Streaming session is no longer active.");
          const result = perform(writer);
          if (mode === "session-loss") {
            void result.catch(() => undefined);
            while (!calls.requestWrites) await new Promise<void>((resolve) => setImmediate(resolve));
            throw new Error("Streaming session is no longer active.");
          }
          return await result; },
        closeVerified: async () => { calls.closed++; if (mode === "cleanup-blocked") throw new Error("retained cleanup blocker"); },
      };
    },
  };
  const manager = new McpManager({ cwd: process.cwd(), servers: [server], runId: "run-682", discovery: discovery(),
    transportFactory: factory, requestTimeoutMs: 100, maximumRestarts: options.maximumRestarts ?? 1, maximumSessions: options.maximumSessions ?? 8,
    reattest: async () => { calls.attestations++; await attestationGate; if (executableReplaced) throw new Error("pinned executable was replaced"); return [{ ...server, envelope: { paths: [], network: false, credentialNames: [] },
      executablePath: process.execPath, arguments: [], configDigest: mcpConfigurationDigest(server), executableDigest: "a".repeat(64) }]; },
  } as McpManagerOptions);
  return { manager, calls, releaseRequest, replaceExecutable: () => { executableReplaced = true; }, notifySchema: () => notifySchema!(), holdAttestation: (gate: Promise<void>) => { attestationGate = gate; }, setMode: (value: typeof mode) => { mode = value; }, fail: (error: Error) => fail?.(error),
    invoke: (context = callContext()) => manager.toolEntries()[0]!.client.call("lookup", {}, context) };
}

test("MCP start advertises attested discovered tools without launching an idle child", async () => {
  const f = fixture(); await f.manager.start();
  assert.equal(f.calls.opened, 0, "discovery readiness must not eagerly launch a live server");
  assert.equal(f.manager.status()[0]!.status, "ready"); assert.equal(f.manager.status()[0]!.toolCount, 1);
  assert.equal(f.manager.toolEntries().length, 1); await f.manager.close(); assert.equal(f.calls.closed, 0);
});

test("MCP calls pass the same launch grant then fresh exact requests without minting internal actors", async () => {
  const f = fixture(); await f.manager.start(); const first = callContext(); const next = callContext();
  try {
    assert.deepEqual(await f.invoke(first), { content: [{ type: "text", text: "owned" }] }); await f.invoke(next);
    assert.equal(f.calls.opened, 1); assert.equal(f.calls.requestWrites, 2);
    assert.equal(f.calls.owners[0]!.context.executionGrant, first.executionGrant);
    assert.equal(f.calls.owners[1]!.context.executionGrant, first.executionGrant);
    assert.equal(f.calls.owners[2]!.context.executionGrant, next.executionGrant);
    assert.deepEqual(f.calls.owners[0]!.context.actor, first.actor);
    assert.deepEqual(f.calls.owners[0]!.envelope.access, []); assert.equal(f.calls.owners[0]!.envelope.networkApproved, false);
  } finally { await f.manager.close(); }
});

test("MCP server sessions do not cross actors or agent sessions and close only their exact owner", async () => {
  const f = fixture(); await f.manager.start();
  try {
    await f.invoke(); await f.invoke(callContext({ sessionId: "agent-2" }));
    await f.invoke(callContext({ actor: { role: "architect", id: "architect-1" } }));
    assert.equal(f.calls.opened, 3);
    await f.manager.closeAgent({ runId: "run-682", sessionId: "agent-1", actor: { role: "worker", id: "worker-1" } });
    assert.equal(f.calls.closed, 1);
    await f.invoke(callContext({ sessionId: "agent-2" })); assert.equal(f.calls.opened, 3);
  } finally { await f.manager.close(); }
  assert.equal(f.calls.closed, 3);
});

test("MCP refuses absent or foreign real call identity before any live launch", async () => {
  const f = fixture(); await f.manager.start();
  try {
    await assert.rejects(f.manager.toolEntries()[0]!.client.call("lookup", {}), /authority|grant|context/i);
    await assert.rejects(f.invoke(callContext({ runId: "foreign" })), /run|owner|authority/i);
    assert.equal(f.calls.opened, 0);
  } finally { await f.manager.close(); }
});

test("MCP already cancelled requests never launch or write a server", async () => {
  const f = fixture(); await f.manager.start(); const abort = new AbortController(); abort.abort();
  await assert.rejects(f.invoke(callContext({ signal: abort.signal })), /cancel/i);
  assert.equal(f.calls.opened, 0); await f.manager.close();
});

test("MCP crash after write is outcome unknown and only a later fresh call may restart", async () => {
  const f = fixture({ mode: "crash", maximumRestarts: 1 }); await f.manager.start();
  const first = callContext();
  try {
    await assert.rejects(f.invoke(first), /unknown|write|closed|unavailable/i);
    assert.equal(f.calls.requestWrites, 1); assert.equal(f.calls.opened, 1); assert.equal(f.calls.closed, 1);
    await assert.rejects(f.invoke(first), /replay|used|call/i); assert.equal(f.calls.requestWrites, 1);
    f.setMode("normal"); await f.invoke(); assert.equal(f.calls.opened, 2);
  } finally { await f.manager.close(); }
});

test("MCP restart budget is bounded across fresh grants and never reset by cleanup", async () => {
  const f = fixture({ mode: "crash", maximumRestarts: 1 }); await f.manager.start();
  try {
    await assert.rejects(f.invoke()); await assert.rejects(f.invoke());
    await assert.rejects(f.invoke(), /restart|exhaust/i);
    assert.equal(f.calls.opened, 2); assert.equal(f.calls.requestWrites, 2);
  } finally { await f.manager.close(); }
});

test("MCP refuses schema replacement before the application request is written", async () => {
  const f = fixture({ mode: "schema" }); await f.manager.start();
  try { await assert.rejects(f.invoke(), /schema|handshake/i); assert.equal(f.calls.requestWrites, 0); }
  finally { await f.manager.close(); }
});

test("MCP bounds concurrent live identities and refuses overflow without a new child", async () => {
  const f = fixture({ maximumSessions: 1 }); await f.manager.start();
  try { await f.invoke(); await assert.rejects(f.invoke(callContext({ sessionId: "agent-overflow" })), /session|bound|capacity/i); assert.equal(f.calls.opened, 1); }
  finally { await f.manager.close(); }
});

test("MCP closes active exact ownership after a transport failure and retains blocked cleanup for retry", async () => {
  const f = fixture(); await f.manager.start(); await f.invoke(); f.setMode("cleanup-blocked"); f.fail(new Error("backend disappeared"));
  await assert.rejects(f.manager.close(), /cleanup|blocker/i);
  assert.ok(f.calls.closed >= 1); f.setMode("normal"); await f.manager.close();
});

test("MCP tool wrapper forwards exact invocation context and fixed access without implicit network", async () => {
  const f = fixture(); await f.manager.start();
  const artifactStore = { put: async () => assert.fail("text should not create artifacts") } as unknown as ArtifactStore;
  const tool = createMcpTools(f.manager, artifactStore)[0]!; const context = callContext();
  try {
    const access = tool.assessAccess!({}, context); assert.deepEqual(access.paths, []); assert.equal(access.network, false);
    const result = await tool.execute({}, context); assert.equal(result.isError, false);
    assert.equal(f.calls.owners[0]!.context.executionGrant, context.executionGrant);
  } finally { await f.manager.close(); }
});


test("MCP queued cancellation is caller-bounded while another request owns the live protocol", async () => {
  const f = fixture({ mode: "hold" }); await f.manager.start();
  const first = f.invoke(); const abort = new AbortController();
  let rejected = false; let second: Promise<void> | undefined;
  try {
    // Filesystem canonicalization may finish concurrent call preparations in
    // either order. Establish the first actual write before queuing its sibling.
    const deadline = Date.now() + 1000;
    while (f.calls.requestWrites === 0 && Date.now() < deadline) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.calls.requestWrites, 1);
    second = f.invoke(callContext({ signal: abort.signal })).then(() => assert.fail("queued cancelled call executed"), () => { rejected = true; });
    const slots = (f.manager as unknown as { slots: Map<string, { waiting: number }> }).slots;
    for (let i = 0; i < 100 && ![...slots.values()].some((slot) => slot.waiting === 2); i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok([...slots.values()].some((slot) => slot.waiting === 2), "the test must reach the actual queued boundary");
    abort.abort(); await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(rejected, true, "queued caller must settle before the first request is released");
    assert.equal(f.calls.requestWrites, 1);
  } finally { f.releaseRequest(); await Promise.allSettled([first, second]); await f.manager.close(); }
});

test("MCP agent cleanup frees a bounded live slot and a resumed agent needs a new call grant", async () => {
  const f = fixture({ maximumSessions: 1 }); await f.manager.start();
  try {
    await f.invoke(); await f.manager.closeAgent({ runId: "run-682", sessionId: "agent-1", actor: { role: "worker", id: "worker-1" } });
    await f.invoke(callContext()); assert.equal(f.calls.opened, 2);
    await f.manager.closeAgent({ runId: "run-682", sessionId: "agent-1", actor: { role: "worker", id: "worker-1" } });
    await f.invoke(callContext({ sessionId: "agent-2" })); assert.equal(f.calls.opened, 3);
  } finally { await f.manager.close(); }
});


test("MCP agent exit revokes an in-flight pre-slot acquisition without banning a later fresh call", async () => {
  const f = fixture(); await f.manager.start();
  const owner = callContext();
  const pending = f.invoke(owner).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
  try {
    await f.manager.closeAgent(owner);
    assert.equal((await pending).ok, false, "the old operation must not publish a live slot after its agent exited");
    assert.equal(f.calls.opened, 0);
    await f.invoke(callContext()); assert.equal(f.calls.opened, 1);
  } finally { await pending; await f.manager.close(); }
});

test("MCP agent close bounds pending executable re-attestation and never launches on its late return", async () => {
  const f = fixture(); await f.manager.start();
  let release!: () => void; f.holdAttestation(new Promise<void>((resolve) => { release = resolve; }));
  const owner = callContext(); const pending = f.invoke(owner).then(() => undefined, (error: unknown) => error);
  let closing: Promise<void> | undefined; let closed = false;
  try {
    for (let i = 0; i < 100 && f.calls.attestations === 0; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.calls.attestations, 1, "the controlled race must reach the real attestation await");
    closing = f.manager.closeAgent(owner).then(() => { closed = true; });
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(closed, true, "agent shutdown must not wait on a noncooperative pure attestation");
    assert.equal(f.calls.opened, 0);
  } finally { release(); await pending; await closing; await f.manager.close(); }
  assert.equal(f.calls.opened, 0, "late successful attestation cannot revive terminated authority");
});

for (const mode of ["session-loss", "session-refused"] as const) test(`MCP shared runtime ${mode} retains a typed outcome and never replays`, async () => {
  const f = fixture({ mode }); await f.manager.start(); const owner = callContext();
  try {
    await assert.rejects(f.invoke(owner), (error: unknown) => error instanceof McpProtocolError &&
      error.code === "mcp_transport_unavailable" && error.outcome === (mode === "session-loss" ? "outcome_unknown" : "not_sent"));
    assert.equal(f.calls.requestWrites, mode === "session-loss" ? 1 : 0);
    assert.equal(f.calls.closed, 1);
    await assert.rejects(f.invoke(owner), /replay|reuse/i);
    assert.equal(f.calls.opened, 1);
  } finally { await f.manager.close(); }
});

for (const replacement of ["executable", "schema"] as const) test(`MCP ${replacement} replacement retires every live agent of that exact configured server`, async () => {
  const f = fixture(); await f.manager.start();
  const entry = f.manager.toolEntries()[0]!;
  try {
    await f.invoke(); await f.invoke(callContext({ sessionId: "agent-2" }));
    assert.equal(f.calls.opened, 2);
    if (replacement === "executable") {
      f.replaceExecutable(); await assert.rejects(f.invoke(), /executable|attestation/i);
    } else await f.notifySchema();
    for (let i = 0; i < 100 && f.calls.closed < 2; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(f.calls.closed, 2, "all live servers with the invalidated executable/schema must be closed");
    assert.equal(f.manager.toolEntries().length, 0);
    await assert.rejects(entry.client.call("lookup", {}, callContext({ sessionId: "agent-3" })), /available|discovery/i);
    assert.equal(f.calls.opened, 2);
  } finally { await f.manager.close(); }
});
