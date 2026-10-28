import assert from "node:assert/strict";
import test from "node:test";
import { McpRpcPeer, McpProtocolError, parseMcpToolList } from "../src/mcp-rpc-peer.js";
import type { OperationAuthorizationAssertion, SessionOperationAuthorization } from "../src/session-authority.js";
import { createStreamingRequestOperation, type StreamingRequestChannel } from "../src/streaming-request-operation.js";

const frame = (id: number, result: unknown) => Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
function deferred() { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; }

for (const split of [1, 7, 64]) test(`MCP RPC accepts partial/coalesced UTF8 frames split at ${split}`, async () => {
  const peer = new McpRpcPeer({ maximumLineBytes: 1024 });
  const writer = { write: async (bytes: Uint8Array) => {
    const request = JSON.parse(Buffer.from(bytes).toString());
    const data = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","method":"notifications/message","params":{}}\r\n'), frame(request.id, { text: "سلام 😀" })]);
    for (let index = 0; index < data.length; index += split) peer.feed("stdout", data.subarray(index, index + split));
  } };
  assert.deepEqual(await peer.request(writer, "tools/call", {}, 1000), { text: "سلام 😀" });
  assert.equal(peer.idle, true); peer.close();
});

for (const payload of ["not json\n", "null\n", "[]\n", '{"id":1,"result":{}}\n',
  '{"jsonrpc":"2.0","id":1,"result":1,"error":{}}\n', '{"jsonrpc":"2.0","id":1}\n',
  '{"jsonrpc":"2.0","id":999,"result":1}\n', '{"jsonrpc":"2.0","id":"1","result":1}\n',
  '{"jsonrpc":"2.0","id":1,"method":"sampling/createMessage"}\n']) {
  test(`MCP RPC rejects malformed or unauthorized protocol ${payload.trim()}`, async () => {
    const peer = new McpRpcPeer({ maximumLineBytes: 1024 }); let writes = 0;
    await assert.rejects(peer.request({ write: async () => { writes++; peer.feed("stdout", Buffer.from(payload)); } }, "tools/call", {}, 1000),
      (error: unknown) => error instanceof McpProtocolError && error.outcome === "outcome_unknown");
    assert.equal(writes, 1); assert.equal(peer.idle, false);
    await assert.rejects(peer.request({ write: async () => { writes++; } }, "tools/call", {}, 1000));
    assert.equal(writes, 1); peer.close();
  });
}

test("MCP RPC refuses invalid UTF8 rather than presenting replacement characters as protocol", async () => {
  const peer = new McpRpcPeer({ maximumLineBytes: 1024 });
  const bytes = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"result":"'), Buffer.from([255]), Buffer.from('"}\n')]);
  await assert.rejects(peer.request({ write: async () => peer.feed("stdout", bytes) }, "tools/call", {}, 1000), /UTF|protocol/i);
  peer.close();
});

test("MCP RPC enforces incoming and outgoing byte bounds before growing buffers or writing", async () => {
  const inbound = new McpRpcPeer({ maximumLineBytes: 128 });
  await assert.rejects(inbound.request({ write: async () => inbound.feed("stdout", Buffer.alloc(129, 65)) }, "tools/call", {}, 1000), /bound/i);
  assert.ok(inbound.bufferedBytes <= 128); inbound.close();
  const outbound = new McpRpcPeer({ maximumLineBytes: 128 }); let writes = 0;
  await assert.rejects(outbound.request({ write: async () => { writes++; } }, "tools/call", { text: "x".repeat(200) }, 1000),
    (error: unknown) => error instanceof McpProtocolError && error.outcome === "not_sent");
  assert.equal(writes, 0); outbound.close();
});

test("MCP RPC waits for actual write acknowledgement even if response arrives first", async () => {
  const peer = new McpRpcPeer({ maximumLineBytes: 1024 }); const gate = deferred();
  let completed = false;
  const request = peer.request({ write: async () => { peer.feed("stdout", frame(1, "reply")); await gate.promise; } }, "tools/call", {}, 1000).then((result) => { completed = true; return result; });
  try { await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(completed, false); }
  finally { gate.resolve(); }
  assert.equal(await request, "reply"); peer.close();
});

test("MCP RPC never reports success or replays after a write rejection following an early response", async () => {
  const peer = new McpRpcPeer({ maximumLineBytes: 1024 }); let writes = 0;
  const reason = new Error("lost write acknowledgement");
  await assert.rejects(peer.request({ write: async () => { writes++; peer.feed("stdout", frame(1, "early")); throw reason; } }, "tools/call", {}, 1000),
    (error: unknown) => error instanceof McpProtocolError && error.outcome === "outcome_unknown" && error.cause === reason);
  assert.equal(writes, 1); assert.equal(peer.idle, false); peer.close();
});

for (const phase of ["write", "response"] as const) test(`MCP RPC ${phase} timeout keeps unknown outcome and never replays`, async () => {
  const peer = new McpRpcPeer({ maximumLineBytes: 1024 }); const gate = deferred(); let writes = 0;
  try {
    await assert.rejects(peer.request({ write: async () => { writes++; if (phase === "write") await gate.promise; } }, "tools/call", {}, 30),
      (error: unknown) => error instanceof McpProtocolError && error.code === "mcp_request_timeout" && error.outcome === "outcome_unknown");
    assert.equal(writes, 1); assert.equal(peer.idle, false);
  } finally { gate.resolve(); peer.close(); }
});

for (const initially of [true, false]) test(`MCP RPC cancellation initially=${initially} distinguishes unsent from unknown`, async () => {
  const peer = new McpRpcPeer({ maximumLineBytes: 1024 }); const abort = new AbortController(); let writes = 0;
  if (initially) abort.abort();
  await assert.rejects(peer.request({ write: async () => { writes++; abort.abort(); } }, "tools/call", {}, 1000, abort.signal),
    (error: unknown) => error instanceof McpProtocolError && error.outcome === (initially ? "not_sent" : "outcome_unknown"));
  assert.equal(writes, initially ? 0 : 2); peer.close();
});

test("MCP RPC sends one cancellation notification for the written request ID", async () => {
  const peer = new McpRpcPeer({ maximumLineBytes: 1024 });
  const abort = new AbortController();
  const frames: Array<{ id?: number; method: string; params: unknown }> = [];
  const writer = { write: async (bytes: Uint8Array) => {
    frames.push(JSON.parse(Buffer.from(bytes).toString()) as { id?: number; method: string; params: unknown });
  } };
  const request = peer.request(writer, "tools/call", { name: "slow" }, 1000, abort.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();
  await assert.rejects(request, (error: unknown) =>
    error instanceof McpProtocolError && error.code === "mcp_request_cancelled" && error.outcome === "outcome_unknown");
  assert.equal(frames.length, 2);
  assert.equal(frames[0]!.method, "tools/call");
  assert.deepEqual(frames[1], {
    jsonrpc: "2.0", method: "notifications/cancelled",
    params: { requestId: frames[0]!.id, reason: "Cancelled by caller" },
  });
  peer.close();
});

test("the owned request channel permits only the acknowledged call's exact cancellation", async () => {
  const writes: string[] = [];
  let assertions = 0;
  const request = createStreamingRequestOperation({
    sessionId: "session", assert: () => { assertions++; },
    write: async (payload, _timeout, assertCurrent) => { assertCurrent(); writes.push(Buffer.from(payload).toString()); },
    waitForOutput: async () => false, deliver: async () => false,
  });
  const authorization = {} as SessionOperationAuthorization;
  const assertion: OperationAuthorizationAssertion = {
    sessionId: "session", operation: "request", requestAccess: [], credentialNames: [],
    networkApproved: false, externalApproved: false, destructiveApproved: false,
    binding: { runId: "run", sessionId: "agent", actor: { role: "remote", id: "client" },
      toolName: "plugin_fixture", callId: "call", permissionProfile: "full" },
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value) + "\n");
  const original = encode({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {} });
  const cancellation = encode({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7, reason: "Cancelled by caller" } });
  let retained!: StreamingRequestChannel;
  await request(authorization, assertion, async (channel) => {
    retained = channel;
    await channel.write(original, 1000);
    await assert.rejects(channel.write(encode({ jsonrpc: "2.0", id: 8, method: "tools/call", params: {} }), 1000));
    await assert.rejects(channel.write(encode({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 8, reason: "Cancelled by caller" } }), 1000));
    await channel.write(cancellation, 1000);
    await assert.rejects(channel.write(cancellation, 1000));
  }, 1000);
  await assert.rejects(retained.write(cancellation, 1000));
  assert.deepEqual(writes, [original.toString(), cancellation.toString()]);
  assert.ok(assertions >= 2);
});

test("MCP cancellation notification traverses the owned request channel", async () => {
  const frames: string[] = [];
  const operation = createStreamingRequestOperation({
    sessionId: "session", assert: () => undefined,
    write: async (payload, _timeout, assertCurrent) => { assertCurrent(); frames.push(Buffer.from(payload).toString()); },
    waitForOutput: async () => false, deliver: async () => false,
  });
  const assertion: OperationAuthorizationAssertion = {
    sessionId: "session", operation: "request", requestAccess: [], credentialNames: [],
    networkApproved: false, externalApproved: false, destructiveApproved: false,
    binding: { runId: "run", sessionId: "agent", actor: { role: "remote", id: "client" },
      toolName: "plugin_fixture", callId: "call", permissionProfile: "full" },
  };
  const peer = new McpRpcPeer({ maximumLineBytes: 1024 });
  const abort = new AbortController();
  const pending = operation({} as SessionOperationAuthorization, assertion,
    (channel) => peer.request(channel, "tools/call", { name: "slow" }, 1000, abort.signal), 1000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof McpProtocolError && error.outcome === "outcome_unknown");
  assert.equal(frames.length, 2);
  assert.equal((JSON.parse(frames[1]!) as { method: string }).method, "notifications/cancelled");
  peer.close();
});

test("the owned channel refuses cancellation before write acknowledgement or after authority loss", async () => {
  const gate = deferred();
  let revoked = false;
  let writes = 0;
  const operation = createStreamingRequestOperation({
    sessionId: "session", assert: () => { if (revoked) throw new Error("authority revoked"); },
    write: async (_payload, _timeout, assertCurrent) => { assertCurrent(); writes++; await gate.promise; },
    waitForOutput: async () => false, deliver: async () => false,
  });
  const assertion: OperationAuthorizationAssertion = {
    sessionId: "session", operation: "request", requestAccess: [], credentialNames: [],
    networkApproved: false, externalApproved: false, destructiveApproved: false,
    binding: { runId: "run", sessionId: "agent", actor: { role: "remote", id: "client" },
      toolName: "plugin_fixture", callId: "call", permissionProfile: "full" },
  };
  const original = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: {} }) + "\n");
  const cancellation = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled",
    params: { requestId: 7, reason: "Cancelled by caller" } }) + "\n");
  await assert.rejects(operation({} as SessionOperationAuthorization, assertion, async (channel) => {
    const first = channel.write(original, 1000);
    await assert.rejects(channel.write(cancellation, 1000));
    gate.resolve();
    await first;
    revoked = true;
    await assert.rejects(channel.write(cancellation, 1000));
  }, 1000), /authority revoked/);
  assert.equal(writes, 1);
});

test("MCP RPC has a bounded in-flight request count and monotonic exact IDs", async () => {
  const peer = new McpRpcPeer({ maximumLineBytes: 1024 }); const gate = deferred(); const ids: number[] = [];
  const writer = { write: async (bytes: Uint8Array) => { const id = JSON.parse(Buffer.from(bytes).toString()).id; ids.push(id); await gate.promise; peer.feed("stdout", frame(id, id)); } };
  const first = peer.request(writer, "tools/call", {}, 1000);
  await assert.rejects(peer.request(writer, "tools/call", {}, 1000), /pending|progress|busy/i);
  gate.resolve(); assert.equal(await first, 1); assert.equal(await peer.request(writer, "tools/call", {}, 1000), 2);
  assert.deepEqual(ids, [1, 2]); peer.close();
});

test("MCP RPC schema replacement invalidates the connection before another external call", async () => {
  const peer = new McpRpcPeer({ maximumLineBytes: 1024 });
  peer.feed("stdout", Buffer.from('{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n'));
  await assert.rejects(peer.request({ write: async () => assert.fail("changed schema must not execute") }, "tools/call", {}, 1000), /schema|changed/i);
  peer.close();
});

test("MCP RPC remote error keeps an acknowledged failure without tainting an idle connection", async () => {
  const peer = new McpRpcPeer({ maximumLineBytes: 1024 });
  await assert.rejects(peer.request({ write: async () => peer.feed("stdout", Buffer.from('{"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"invalid argument"}}\n')) }, "tools/call", {}, 1000),
    (error: unknown) => error instanceof McpProtocolError && error.code === "mcp_remote_error" && error.outcome === "response_received");
  assert.equal(peer.idle, true); peer.close();
});

test("MCP RPC closing a pending call retains failure and prevents late frame adoption", async () => {
  const peer = new McpRpcPeer({ maximumLineBytes: 1024 }); const reason = new Error("transport vanished");
  const result = peer.request({ write: async () => peer.close(reason) }, "tools/call", {}, 1000);
  await assert.rejects(result, (error: unknown) => error instanceof McpProtocolError && error.outcome === "outcome_unknown");
  peer.feed("stdout", frame(1, "too late")); assert.equal(peer.idle, false);
});

test("MCP schema parsing preserves definitions immutably and rejects duplicates or malformed schemas", () => {
  const value = { tools: [{ name: "lookup", inputSchema: { type: "object" }, annotations: { readOnlyHint: true, destructiveHint: false } }] };
  const parsed = parseMcpToolList(value); value.tools[0]!.inputSchema.type = "array";
  assert.equal(parsed[0]!.inputSchema!.type, "object"); assert.equal(Object.isFrozen(parsed[0]!.inputSchema), true);
  for (const bad of [{ tools: null }, { tools: [{ name: "" }] }, { tools: [{ name: "a" }, { name: "a" }] }, { tools: [{ name: "a", inputSchema: "bad" }] }, { tools: Array.from({ length: 1025 }, (_, i) => ({ name: String(i) })) }])
    assert.throws(() => parseMcpToolList(bad), /tool|schema/i);
});
