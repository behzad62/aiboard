import assert from "node:assert/strict";
import test from "node:test";
import { settleModernToolCall } from "../src/mcp-optional-features.js";
import { createMcpHandler, inputRequired, Server } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import { RemoteMcpClient } from "../src/mcp-remote.js";

const stamp = "2026-11-26T00:00:00.000Z";
const task = { taskId: "job-1", createdAt: stamp, lastUpdatedAt: stamp, ttlMs: 30000, pollIntervalMs: 100 };
const done = { resultType: "complete", content: [{ type: "text", text: "done" }] };
const ask = { method: "elicitation/create", params: { mode: "form", message: "Continue?", requestedSchema: { type: "object", properties: { answer: { type: "string" } } } } };

test("modern HTTP Tasks polls the exact handle and never replays tools/call", async () => {
  const methods: string[] = [];
  const client = new RemoteMcpClient({ url: "http://127.0.0.1:18000/mcp", timeoutMs: 5000, fetch: async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    methods.push(body.method);
    assert.deepEqual(body.params._meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/tasks"], {});
    const result = body.method === "server/discover" ? { supportedVersions: ["2026-07-28"] }
      : body.method === "tools/call" ? { ...task, resultType: "task", status: "working" }
      : (assert.equal(body.params.taskId, task.taskId), { ...task, status: "completed", resultType: "complete", result: done });
    return Response.json({ jsonrpc: "2.0", id: body.id, result });
  } });
  try {
    await client.initialize();
    assert.deepEqual((await client.callTool("work", {})).content, done.content);
    assert.deepEqual(methods, ["server/discover", "tools/call", "tasks/get"]);
  } finally { await client.close(); }
});

test("MRTR echoes opaque state and uses only trusted input", async () => {
  const calls: unknown[] = [];
  const result = await settleModernToolCall({ initial: { resultType: "input_required", inputRequests: { a: ask }, requestState: "opaque" },
    params: { name: "work", arguments: { n: 2 } }, timeoutMs: 3000,
    resolveInput: async () => ({ action: "accept", content: { answer: "yes" } }),
    request: async (method, payload) => { calls.push([method, payload]); return done; } });
  assert.deepEqual(result, done);
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [["tools/call", { name: "work", arguments: { n: 2 }, inputResponses: { a: { action: "accept", content: { answer: "yes" } } }, requestState: "opaque" }]]);
});

test("no input resolver declines; sampling requests never trigger another dispatch", async () => {
  const initial = { resultType: "input_required", inputRequests: { a: ask }, requestState: "opaque" };
  await settleModernToolCall({ initial, params: { name: "work" }, timeoutMs: 3000, request: async (_, p) => {
    assert.deepEqual(JSON.parse(JSON.stringify(p.inputResponses)), { a: { action: "decline" } }); return done;
  } });
  await assert.rejects(settleModernToolCall({ initial: { ...initial, inputRequests: { a: { method: "roots/list" } } },
    params: {}, timeoutMs: 3000, request: async () => assert.fail("must not dispatch") }), /not authorized|Invalid/);
});

test("task input update and completion stay on the original handle", async () => {
  const calls: string[] = [];
  let polls = 0;
  const result = await settleModernToolCall({ initial: { ...task, resultType: "task", status: "working" },
    params: {}, timeoutMs: 3000, request: async (method, p) => {
      calls.push(method); assert.equal(p.taskId, task.taskId);
      if (method === "tasks/update") { assert.deepEqual(JSON.parse(JSON.stringify(p.inputResponses)), { a: { action: "decline" } }); return { resultType: "complete" }; }
      return ++polls === 1 ? { ...task, resultType: "complete", status: "input_required", inputRequests: { a: ask } }
        : { ...task, resultType: "complete", status: "completed", result: done };
    } });
  assert.deepEqual(result, done);
  assert.deepEqual(calls, ["tasks/get", "tasks/update", "tasks/get"]);
});

test("foreign task handles fail closed and cancel only original", async () => {
  const calls: string[] = [];
  await assert.rejects(settleModernToolCall({ initial: { ...task, resultType: "task", status: "working" },
    params: {}, timeoutMs: 3000, request: async (method, p) => {
      calls.push(method); assert.equal(p.taskId, task.taskId);
      return method === "tasks/cancel" ? { resultType: "complete" } : { ...task, taskId: "foreign", resultType: "complete", status: "working" };
    } }), /did not match/);
  assert.deepEqual(calls, ["tasks/get", "tasks/cancel"]);
});

test("real SDK multi-round-trip server receives explicit user answer on a new request", async () => {
  const schema = z.object({ answer: z.string() });
  const handler = createMcpHandler(() => {
    const server = new Server({ name: "mrtr-test", version: "1" }, { capabilities: { tools: {} }, supportedProtocolVersions: ["2026-07-28"] });
    server.setRequestHandler("tools/call", async (_, ctx) => {
      const received = ctx.mcpReq.inputResponses;
      if (!received) return inputRequired({ inputRequests: { a: inputRequired.elicit({ message: "Confirm?", requestedSchema: schema }) }, requestState: "opaque-test-state" });
      assert.equal(ctx.mcpReq.requestState(), "opaque-test-state");
      return { content: [{ type: "text", text: JSON.stringify(received) }] };
    });
    return server;
  });
  let prompts = 0; let authorizations = 0;
  const client = new RemoteMcpClient({ url: "http://127.0.0.1:18000/mcp", fetch: async (url, init) => handler.fetch(new Request(url, init)),
    resolveInput: async () => { prompts++; return { action: "accept", content: { answer: "yes" } }; } });
  try {
    await client.initialize();
    const result = await client.callTool("work", {}, undefined, undefined, () => { authorizations++; return true; });
    assert.equal(prompts, 1);
    assert.equal(authorizations, 2);
    assert.match(JSON.stringify(result.content), /yes/);
  } finally { await client.close(); await handler.close(); }
});

test("expired input resolver cannot send a later continuation", async () => {
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(settleModernToolCall({
      initial: { resultType: "input_required", inputRequests: { a: ask }, requestState: "opaque" },
      params: { name: "work" }, timeoutMs: 30, resolveInput: async () => new Promise(() => {}),
      request: async () => assert.fail("no dispatch after timeout"),
    }), /abort|timeout/i);
  } finally { clearInterval(keepAlive); }
});

test("real SDK Tasks server accepts encoded Mcp-Name task handle and returns result", async () => {
  const opaque = { ...task, taskId: " task-\u03bb " };
  const methods: string[] = [];
  const handler = createMcpHandler(() => {
    const server = new Server({ name: "tasks-test", version: "1" }, { capabilities: { tools: {}, extensions: { "io.modelcontextprotocol/tasks": {} } }, supportedProtocolVersions: ["2026-07-28"] });
    server.setRequestHandler("tools/call", async () => ({ ...opaque, resultType: "task", status: "working", content: [] }));
    server.setRequestHandler("tasks/get", { params: z.object({ taskId: z.string() }).passthrough(), result: z.object({ resultType: z.literal("complete") }).passthrough() },
      async request => {
        assert.equal(request.taskId, opaque.taskId);
        return { ...opaque, resultType: "complete" as const, status: "completed", result: done };
      });
    return server;
  });
  const client = new RemoteMcpClient({ url: "http://127.0.0.1:18000/mcp", timeoutMs: 5000, fetch: async (url, init) => {
    const request = new Request(url, init);
    methods.push(request.headers.get("mcp-method") ?? "");
    if (methods.at(-1) === "tasks/get") assert.ok(request.headers.get("mcp-name")?.startsWith("=?base64?"));
    return handler.fetch(request);
  } });
  try {
    await client.initialize();
    assert.deepEqual((await client.callTool("work", {})).content, done.content);
    assert.deepEqual(methods, ["server/discover", "tools/call", "tasks/get"]);
  } finally { await client.close(); await handler.close(); }
});

test("task receipt follows the credential actually sent, never a replacement used for polling",async()=>{
  const methods:string[]=[];
  let binding="a".repeat(64);
  const client=new RemoteMcpClient({url:"http://127.0.0.1:18000/mcp",timeoutMs:2000,
    authorization:async()=>{
      const captured=binding;
      return {header:"Bearer "+captured,binding:captured,current:()=>captured===binding};
    },fetch:async(_url,init)=>{
      const req=JSON.parse(String(init?.body));methods.push(req.method);
      if(req.method==="server/discover")return Response.json({jsonrpc:"2.0",id:req.id,result:{supportedVersions:["2026-07-28"]}});
      assert.equal(req.method,"tools/call");
      assert.equal(new Headers(init?.headers).get("authorization"),"Bearer "+"a".repeat(64));
      binding="b".repeat(64);
      const createdAt=new Date().toISOString();
      return Response.json({jsonrpc:"2.0",id:req.id,result:{...task,createdAt,lastUpdatedAt:createdAt,resultType:"task",status:"working"}});
    }});
  try{
    await client.initialize();
    let receipt:import("../src/mcp-task-recovery.js").McpTaskHandleObservation|undefined;
    await assert.rejects(client.callTool("work",{},undefined,undefined,undefined,undefined,r=>{receipt=r;}),/original call was not replayed/);
    assert.equal(receipt?.credentialBinding,"a".repeat(64));
    assert.deepEqual(methods,["server/discover","tools/call"]);
  }finally{await client.close();}
});

test("a reused task ID with different creation time cannot receive input, cancel or a result",async()=>{
  for(const status of ["working","input_required","completed"] as const){
    const methods:string[]=[];
    let resolved=0;
    await assert.rejects(settleModernToolCall({initial:{...task,resultType:"task",status:"working"},
      params:{name:"work"},timeoutMs:3000,resolveInput:async()=>{resolved++;return {action:"decline"};},
      request:async method=>{
        methods.push(method);
        return {...task,createdAt:"2026-11-26T01:00:00Z",lastUpdatedAt:"2026-11-26T01:00:00Z",
          resultType:"complete",status,...(status==="input_required"?{inputRequests:{a:ask}}:status==="completed"?{result:done}:{})};
      }}),/creation time did not match/);
    assert.equal(resolved,0);
    assert.deepEqual(methods,["tasks/get"]);
  }
});
