// Managed-MCP fixture. Modes: "ok" (default), "crash" (exits before the handshake),
// "needs-token" (exits unless FIXTURE_API_TOKEN is set). Never echoes a secret value.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "ok";
if (mode === "crash") process.exit(3);
if (mode === "needs-token" && !process.env.FIXTURE_API_TOKEN) {
  process.stderr.write("FIXTURE_API_TOKEN is required\n");
  process.exit(4);
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if ((mode==="durable"||mode==="volatile") && message.method==="server/discover"){
    reply(message.id,{supportedVersions:["2026-07-28"],capabilities:{tools:{},extensions:{"io.modelcontextprotocol/tasks":{},
      ...(mode==="durable"?{"io.aiboard/durable-tasks":{crossProcess:true}}:{})}}});
  } else if ((mode==="durable"||mode==="volatile") && message.method==="tools/call"){
    const createdAt=new Date().toISOString();
    const task={taskId:"persisted-task",createdAt,lastUpdatedAt:createdAt,ttlMs:120000,pollIntervalMs:100};
    writeFileSync(process.argv[3],JSON.stringify({...task,pid:process.pid}));
    appendFileSync(process.argv[3]+".log",JSON.stringify({method:message.method,pid:process.pid})+"\n");
    reply(message.id,{...task,resultType:"task",status:"working"});
  } else if ((mode==="durable"||mode==="volatile") && message.method==="tasks/get"){
    const {pid,...task}=JSON.parse(readFileSync(process.argv[3],"utf8"));
    appendFileSync(process.argv[3]+".log",JSON.stringify({method:message.method,pid:process.pid})+"\n");
    if(pid===process.pid) process.exit(2);
    if(message.params.taskId!==task.taskId)throw Error("wrong task");
    reply(message.id,{...task,resultType:"complete",status:"completed",result:{content:[{type:"text",text:"durable result"}]}});
  } else if (mode === "app" && message.method === "server/discover") {
    reply(message.id,{supportedVersions:["2026-07-28"],capabilities:{tools:{},resources:{},extensions:{"io.modelcontextprotocol/ui":{}}}});
  } else if (message.method === "initialize") {
    reply(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "extension-fixture", version: "1" } });
  } else if (message.method === "tools/list") {
    reply(message.id, { tools: [
      { name: "lookup", description: "Look up a fixture fact", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false }, ...(mode==="app"?{_meta:{ui:{resourceUri:"ui://fixture/view.html"}}}:{}) },
      { name: "credential_status", description: "Report whether the fixture token reached this process", inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true, destructiveHint: false } },
      ...(mode==="app"?[{name:"model_only",inputSchema:{type:"object"},annotations:{readOnlyHint:true,destructiveHint:false},_meta:{ui:{visibility:["model"]}}}]:[]),
      { name: "delete_note", description: "Pretend to delete a note", inputSchema: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false } },
    ] });
  } else if (message.method === "tools/call") {
    const name = message.params.name;
    if (mode==="app" && process.argv[3]) appendFileSync(process.argv[3],JSON.stringify({pid:process.pid,name,args:message.params.arguments})+"\n");
    const token = process.env.FIXTURE_API_TOKEN;
    const text = name === "lookup" ? `found:${message.params.arguments.query}:OTTER-7`
      : name === "credential_status" ? `token:${token ? "present" : "absent"} length:${token ? token.length : 0}`
      : `deleted:${message.params.arguments.id}`;
    reply(message.id, { content: [{ type: "text", text }], isError: false,
      ...(mode==="app"?{resultType:"complete",structuredContent:{pid:process.pid},_meta:{uiPrivate:"fixture-ui-data"}}:{}) });
  } else if(mode==="app" && message.method==="resources/read" && message.params.uri==="ui://fixture/view.html"){
    reply(message.id,{contents:[{uri:message.params.uri,mimeType:"text/html;profile=mcp-app",text:"<html><body>fixture app</body></html>",_meta:{ui:{csp:{resourceDomains:["https://cdn.example.com"]}}}}]});
  } else if (message.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } })}\n`);
  }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}
