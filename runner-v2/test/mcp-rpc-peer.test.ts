import assert from "node:assert/strict";
import test from "node:test";
import { McpRpcPeer, McpProtocolError, parseMcpToolList } from "../src/mcp-rpc-peer.js";

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
  assert.equal(writes, initially ? 0 : 1); peer.close();
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
