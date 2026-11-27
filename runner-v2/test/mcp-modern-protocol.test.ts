import { z } from "zod/v4";
import { McpStdioContinuation } from "../src/mcp-stdio-continuation.js";
import { settleModernToolCall } from "../src/mcp-optional-features.js";
import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { createMcpHandler, inputRequired, Server } from "@modelcontextprotocol/server";
import { serveStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { McpRpcPeer, listMcpStdioTools } from "../src/mcp-rpc-peer.js";
import { RemoteMcpClient } from "../src/mcp-remote.js";
import { createLocalMcpProxy } from "../src/local-stdio-mcp.js";

const version = "2026-07-28";
const meta = {
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" },
};
test("remote client uses real SDK modern HTTP discovery and stateless tool calls", async () => {
  const handler = createMcpHandler(() => {
    const server = new Server({ name: "modern-test", version: "1" }, { capabilities: { tools: {} }, supportedProtocolVersions: [version] });
    server.setRequestHandler("tools/list", async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }));
    server.setRequestHandler("tools/call", async (request) => ({ content: [{ type: "text", text: JSON.stringify(request.params.arguments) }] }));
    return server;
  });
  const methods: string[] = [];
  const client = new RemoteMcpClient({ url: "http://127.0.0.1:18000/mcp", fetch: async (url, init) => {
    const request = new Request(url, init);
    assert.equal(request.headers.get("mcp-protocol-version"), version);
    assert.equal(request.headers.has("mcp-session-id"), false);
    methods.push(request.headers.get("mcp-method")!);
    return handler.fetch(request);
  } });
  try {
    assert.equal((await client.initialize()).protocolVersion, version);
    assert.equal((await client.listTools())[0]?.name, "echo");
    assert.deepEqual((await client.callTool("echo", { hello: true })).content, [{ type: "text", text: '{"hello":true}' }]);
    assert.deepEqual(methods, ["server/discover", "tools/list", "tools/call"]);
  } finally { await client.close(); await handler.close(); }
});
test("local stdio proxy answers modern discovery and tools/list", async () => {
  const input = new PassThrough(), output = new PassThrough();
  const handle = serveStdio(() => createLocalMcpProxy(async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] })), { transport: new StdioServerTransport(input, output) });
  const request = async (id: number, method: string) => {
    const reply = once(output, "data");
    input.write(JSON.stringify({ jsonrpc: "2.0", id, method, params: { _meta: meta } }) + "\n");
    return JSON.parse(String((await reply)[0]));
  };
  try {
    const discover = await request(1, "server/discover");
    assert.ok(discover.result?.supportedVersions.includes(version), JSON.stringify(discover));
    const tools = await request(2, "tools/list");
    assert.equal(tools.result?.tools[0]?.name, "echo", JSON.stringify(tools));
  } finally { await handle.close(); input.destroy(); output.destroy(); }
});

test("owned stdio RPC peer negotiates SDK v2 and sends modern envelope for tools", async () => {
  const input = new PassThrough(), output = new PassThrough();
  const methods: string[] = [];
  const peer = new McpRpcPeer();
  output.on("data", (chunk: Buffer) => peer.feed("stdout", chunk));
  const handle = serveStdio(() => createLocalMcpProxy(async (body) => {
    const request = body as { operation: string };
    return request.operation === "list" ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
      : { content: [{ type: "text", text: "modern" }] };
  }), { transport: new StdioServerTransport(input, output) });
  const writer = { async write(payload: Uint8Array) {
    const message = JSON.parse(Buffer.from(payload).toString());
    methods.push(message.method);
    assert.equal(message.params._meta["io.modelcontextprotocol/protocolVersion"], version);
    input.write(payload);
  } };
  try {
    assert.ok(await peer.probeModern(writer, { name: "test", version: "1" }, 2_000));
    assert.equal(peer.modern, true);
    assert.equal((await listMcpStdioTools(peer, writer, 2_000))[0]?.name, "echo");
    const result = await peer.request(writer, "tools/call", { name: "echo", arguments: {} }, 2_000);
    assert.deepEqual((result as { content: unknown }).content, [{ type: "text", text: "modern" }]);
    assert.deepEqual(methods, ["server/discover", "tools/list", "tools/call"]);
  } finally { await handle.close(); input.destroy(); output.destroy(); }
});

test("real SDK stdio MRTR and Tasks pass the exact response-proven wire gate",async()=>{
  const input=new PassThrough(),output=new PassThrough();
  const peer=new McpRpcPeer();
  let fence:McpStdioContinuation|undefined;
  output.on("data",(chunk:Buffer)=>{fence?.feed(chunk);peer.feed("stdout",chunk);});
  const stamp="2026-11-26T00:00:00Z";
  const task={taskId:"sdk-stdio-task",createdAt:stamp,lastUpdatedAt:stamp,ttlMs:30000,pollIntervalMs:100};
  let calls=0;
  const handle=serveStdio(()=>{
    const server=new Server({name:"stdio-optional",version:"1"},{capabilities:{tools:{},extensions:{"io.modelcontextprotocol/tasks":{}}},supportedProtocolVersions:[version]});
    server.setRequestHandler("tools/call",async(_,ctx)=>{
      calls++;
      if(!ctx.mcpReq.inputResponses)return inputRequired({inputRequests:{a:inputRequired.elicit({message:"Confirm?",requestedSchema:z.object({answer:z.string()})})},requestState:"opaque-stdio"});
      assert.equal(ctx.mcpReq.requestState(),"opaque-stdio");
      assert.match(JSON.stringify(ctx.mcpReq.inputResponses),/yes/);
      return {...task,resultType:"task",status:"working",content:[]};
    });
    server.setRequestHandler("tasks/get",{params:z.object({taskId:z.string()}).passthrough(),result:z.object({resultType:z.literal("complete")}).passthrough()},async request=>{
      assert.equal(request.taskId,task.taskId);
      return {...task,resultType:"complete" as const,status:"completed",result:{content:[{type:"text",text:"done"}]}};
    });
    return server;
  },{transport:new StdioServerTransport(input,output)});
  const methods:string[]=[];
  const writer={async write(payload:Uint8Array){
    const f=JSON.parse(Buffer.from(payload).toString());methods.push(f.method);
    if(f.method==="tools/call"&&!fence){fence=new McpStdioContinuation();assert.equal(fence.begin(payload),true);}
    else if(fence)assert.equal(fence.permit(payload),true);
    input.write(payload);
  }};
  try{
    assert.ok(await peer.probeModern(writer,{name:"test",version:"1"},2000));
    const params={name:"work",arguments:{}};
    const request=(method:string,payload:Record<string,unknown>,signal?:AbortSignal)=>peer.request(writer,method,payload,2000,signal);
    const initial=await request("tools/call",params);
    const result=await settleModernToolCall({initial,params,request,timeoutMs:3000,resolveInput:async()=>({action:"accept",content:{answer:"yes"}})});
    assert.deepEqual(result.content,[{type:"text",text:"done"}]);
    assert.deepEqual(methods,["server/discover","tools/call","tools/call","tasks/get"]);assert.equal(calls,2);
  }finally{await handle.close();input.destroy();output.destroy();}
});
