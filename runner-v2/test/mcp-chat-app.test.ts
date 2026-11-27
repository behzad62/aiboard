import { appResourceDomains } from "../src/mcp-app-resource-policy.js";
import { mcpAppSrcdoc } from "../../lib/client/mcp-app-sandbox.js";
import { parseMcpToolList } from "../src/mcp-rpc-peer.js";
import assert from "node:assert/strict";
import test from "node:test";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { McpChatApps, appHtml, appUri, appToolMeta, appCallRisk, appResourceDocument } from "../src/mcp-chat-app.js";
import { RemoteMcpClient } from "../src/mcp-remote.js";

const uri = "ui://test/dashboard.html";
const html = "<html><body>Example app</body></html>";
const payload = { server: "test", tool: "view", uri, html, arguments: { n: 1 }, result: { content: [{ type: "text", text: "result" }], isError: false } };

test("app discovery and resource validation refuse wrong URI, MIME, permissions and external CSP", () => {
  assert.equal(appUri(uri), uri);
  for (const invalid of ["https://example.com/x", "ui://a@b/x", "ui://test/x#h", "ui://test/ x", "ui://"]) assert.equal(appUri(invalid), undefined);
  assert.deepEqual(appToolMeta({ ui: { resourceUri: uri, visibility: ["app"] } }), { resourceUri: uri, appOnly: true });
  assert.equal(appToolMeta({ "ui/resourceUri": uri }).resourceUri, uri);
  assert.equal(appToolMeta({ ui: { visibility: ["model"] } }).modelOnly, true);
  assert.equal(appToolMeta({ ui: { visibility: ["model", "app"] } }).modelOnly, undefined);
  const entry = { uri, mimeType: "text/html;profile=mcp-app", text: html };
  assert.equal(appHtml(uri, { contents: [entry] }), html);
  for (const bad of [{ ...entry, uri: "ui://other/x" }, { ...entry, mimeType: "text/html" }, { ...entry, _meta: { ui: { permissions: { camera: {} } } } }, { ...entry, _meta: { ui: { csp: { connectDomains: ["https://external.test"] } } } }, { ...entry, text: "a".repeat(600000) }]) assert.equal(appHtml(uri, { contents: [bad] }), undefined);
  assert.equal(appHtml(uri, { contents: [entry, entry] }), undefined);
});

test("app data is session-bound, bounded, not in the summary, and dismissible", () => {
  const apps = new McpChatApps();
  apps.publish("a", payload);
  const [app] = apps.list("a");
  assert.ok(app.id);
  assert.equal("html" in app, false);
  assert.equal("result" in app, false);
  assert.equal(apps.get("b", app.id), undefined);
  assert.equal(apps.dismiss("b", app.id), false);
  const returned = apps.get("a", app.id)!;
  returned.arguments.n = 99;
  assert.equal(apps.get("a", app.id)?.arguments.n, 1);
  assert.equal(apps.dismiss("a", app.id), true);
  assert.equal(apps.get("a", app.id), undefined);
  for (let i=0;i<8;i++) apps.publish("a", payload);
  assert.equal(apps.list("a").length, 4);
  apps.publish("b", { ...payload, html: "x".repeat(600000) });
  assert.equal(apps.list("b").length, 0);
});

test("real modern SDK exposes app metadata, preserves result metadata, reads only the advertised resource", async () => {
  const handler = createMcpHandler(() => {
    const server = new Server({ name: "apps-test", version: "1" }, { capabilities: { tools: {}, resources: {}, extensions: { "io.modelcontextprotocol/ui": {} } }, supportedProtocolVersions: ["2026-07-28"] });
    server.setRequestHandler("tools/list", async () => ({ tools: [
      { name: "view", inputSchema: {type:"object"}, _meta: {ui:{resourceUri:uri}} },
      { name: "hidden", inputSchema: {type:"object"}, _meta: {ui:{visibility:["app"]}} },
    ] }));
    server.setRequestHandler("tools/call", async () => ({ content: [{ type: "text", text: "ready" }], _meta: { appData: "only for the app" } }));
    server.setRequestHandler("resources/read", async (request) => {
      assert.equal(request.params.uri, uri);
      return { contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: html }] };
    });
    return server;
  });
  const methods: string[] = [];
  const client = new RemoteMcpClient({ url: "http://127.0.0.1:18000/mcp", apps: true, fetch: async (url, init) => {
    const req = new Request(url, init); methods.push(req.headers.get("mcp-method") ?? "");
    if (methods.at(-1) === "resources/read") assert.equal(req.headers.get("mcp-name"), uri);
    return handler.fetch(req);
  } });
  try {
    await client.initialize();
    assert.deepEqual((await client.listTools()).map(t => [t.name,t.uiResourceUri]), [["view",uri]]);
    const result = await client.callTool("view", {});
    assert.equal(result._meta?.appData, "only for the app");
    assert.equal(await client.readAppResource("https://evil.test"), undefined);
    assert.equal(await client.readAppResource(uri, undefined, () => true), html);
    assert.deepEqual(methods, ["server/discover","tools/list","tools/call","resources/read"]);
  } finally { await client.close(); await handler.close(); }
});

test("app tool approval tickets bind session, tool, immutable arguments and single execution", async () => {
  const apps = new McpChatApps();
  const calls: unknown[] = [];
  apps.publish("a", payload, { tools: ["refresh"], async call(name, args, signal, allowed) {
    assert.equal(signal.aborted, false); assert.equal(allowed(), true);
    calls.push({name, args}); return { content: [{type:"text",text:"fresh"}], isError:false };
  } });
  const id = apps.list("a")[0].id;
  assert.deepEqual(apps.get("a",id)?.allowedTools, ["refresh"]);
  assert.throws(() => apps.stage("b",id,{name:"refresh",arguments:{}}), /unavailable/);
  assert.throws(() => apps.stage("a",id,{name:"write",arguments:{}}), /not available/);
  assert.throws(() => apps.stage("a",id,{name:"refresh",arguments:{},server:"other"}), /not available/);
  assert.throws(() => apps.stage("a",id,{name:"refresh",arguments:{s:"x".repeat(17000)}}), /size limit/);
  const first = apps.stage("a",id,{name:"refresh",arguments:{x:1}});
  assert.equal(calls.length,0);
  assert.throws(() => apps.stage("a",id,{name:"refresh",arguments:{}}), /pending/);
  await assert.rejects(apps.answer("b",id,first.id,true), /unavailable/);
  await assert.rejects(apps.answer("a",id,"wrong",true), /unavailable/);
  assert.equal((await apps.answer("a",id,first.id,false)).isError,true);
  assert.equal(calls.length,0);
  await assert.rejects(apps.answer("a",id,first.id,true), /unavailable/);
  const second = apps.stage("a",id,{name:"refresh",arguments:{x:2}});
  second.arguments.x=99;
  assert.equal((await apps.answer("a",id,second.id,true)).isError,false);
  assert.deepEqual(calls,[{name:"refresh",args:{x:2}}]);
  await assert.rejects(apps.answer("a",id,second.id,true), /unavailable/);
  const third = apps.stage("a",id,{name:"refresh",arguments:{}});
  apps.dismiss("a",id);
  await assert.rejects(apps.answer("a",id,third.id,true), /unavailable/);
});

test("dismissing an app aborts a running call and removes its authority", async () => {
  const apps = new McpChatApps();
  let started = false;
  apps.publish("a",payload,{tools:["refresh"],async call(_name,_args,signal,allowed) {
    started=true; await new Promise<void>(resolve => signal.addEventListener("abort",()=>resolve(),{once:true}));
    assert.equal(allowed(),false);
    return {content:[],isError:false};
  }});
  const id=apps.list("a")[0].id;
  const ticket=apps.stage("a",id,{name:"refresh",arguments:{}});
  const result=apps.answer("a",id,ticket.id,true);
  await Promise.resolve();
  assert.equal(started,true);
  assert.equal(apps.dismiss("a",id),true);
  assert.equal((await result).isError,true);
});

test("expired tickets cannot execute and prompt attempts are bounded even when denied", async t => {
  let now=1000000;
  t.mock.method(Date,"now",()=>now);
  const apps=new McpChatApps();
  let calls=0;
  apps.publish("a",payload,{tools:["refresh"],async call(){calls++;return {content:[],isError:false};}});
  const id=apps.list("a")[0].id;
  const expired=apps.stage("a",id,{name:"refresh",arguments:{}});
  now+=60001;
  await assert.rejects(apps.answer("a",id,expired.id,true), /expired/);
  for(let n=1;n<20;n++){
    const ticket=apps.stage("a",id,{name:"refresh",arguments:{}});
    await apps.answer("a",id,ticket.id,false);
  }
  assert.throws(()=>apps.stage("a",id,{name:"refresh",arguments:{}}),/limit reached/);
  assert.equal(calls,0);
});

test("stdio app metadata is retained in reviewed inventory and app-only tools are excluded",()=>{
  const tools=parseMcpToolList({tools:[
    {name:"view",inputSchema:{type:"object"},_meta:{ui:{resourceUri:uri}}},
    {name:"hidden",inputSchema:{type:"object"},_meta:{ui:{visibility:["app"]}}},
    {name:"model",inputSchema:{type:"object"},_meta:{ui:{visibility:["model"]}}},
    {name:"invalid",_meta:{ui:{resourceUri:"https://example.com/"}}},
  ]});
  assert.deepEqual(tools.map(t=>t.name),["view","model","invalid"]);
  assert.equal(tools[0].uiResourceUri,uri);
  assert.equal(tools[1].modelOnly,true);
  assert.equal(tools[2].uiResourceUri,undefined);
  assert.ok(Object.isFrozen(tools[0]));
});

test("app store shutdown revokes active calls, waits for cleanup and refuses new apps",async()=>{
  const apps=new McpChatApps();
  let finish!:()=>void, aborted=false;
  apps.publish("a",payload,{tools:["refresh"],async call(_name,_args,signal){
    await new Promise<void>(resolve=>{finish=resolve;signal.addEventListener("abort",()=>{aborted=true;},{once:true});});
    return {content:[],isError:false};
  }});
  const id=apps.list("a")[0].id;
  const ticket=apps.stage("a",id,{name:"refresh",arguments:{}});
  const result=apps.answer("a",id,ticket.id,true);
  await Promise.resolve();
  let closed=false;
  const closing=apps.close().then(()=>{closed=true;});
  assert.equal(aborted,true);
  await Promise.resolve();
  assert.equal(closed,false);
  finish(); await closing;
  assert.equal((await result).isError,true);
  apps.publish("a",payload);
  assert.deepEqual(apps.list("a"),[]);
});

test("host derives write risk from reviewed annotations, never caller input",async()=>{
  assert.equal(appCallRisk({}),"destructive");
  assert.equal(appCallRisk({annotations:{readOnlyHint:true}}),"destructive");
  assert.equal(appCallRisk({annotations:{readOnlyHint:false,destructiveHint:false}}),"write");
  assert.equal(appCallRisk({annotations:{readOnlyHint:true,destructiveHint:false}}),"read_only");
  const apps=new McpChatApps(); let calls=0;
  apps.publish("a",payload,{tools:["write"],risks:{write:"write"},async call(){calls++;return {content:[],isError:false};}});
  const id=apps.list("a")[0].id;
  assert.throws(()=>apps.stage("a",id,{name:"write",arguments:{},risk:"read_only"}),/not available/);
  const ticket=apps.stage("a",id,{name:"write",arguments:{}});
  assert.equal(ticket.risk,"write");ticket.risk="read_only";
  assert.equal(calls,0);
  await apps.answer("a",id,ticket.id,true);
  assert.equal(calls,1);
  await assert.rejects(apps.answer("a",id,ticket.id,true),/unavailable/);
});

test("external resource origins are exact bounded HTTPS hosts, never arbitrary CSP expressions",()=>{
  assert.deepEqual(appResourceDomains(["https://CDN.example.com/","https://cdn.example.com"]),["https://cdn.example.com"]);
  for(const bad of ["http://cdn.example.com","https://*.example.com","https://cdn.example.com/path","https://cdn.example.com:443","https://user@cdn.example.com","https://cdn.example.com?x","https://cdn.example.com#x","https://127.0.0.1","https://[::1]","https://localhost","https://a.local","https://a.internal","https://a.home.arpa","https://a.example.com; script-src *","https://a.example.com'","https://a.example.com\n","https://a..example.com","https://2130706433"]){
    assert.equal(appResourceDomains([bad]),undefined,bad);
  }
  assert.equal(appResourceDomains(Array.from({length:9},(_,i)=>"https://cdn"+i+".example.com")),undefined);
  assert.equal(appResourceDomains(null),undefined);
  const uri="ui://test/external.html";
  const resource={uri,mimeType:"text/html;profile=mcp-app",text:html,_meta:{ui:{csp:{resourceDomains:["https://cdn.example.com"]}}}};
  assert.deepEqual(appResourceDocument(uri,{contents:[resource]}),{html,resourceDomains:["https://cdn.example.com"]});
  assert.equal(appHtml(uri,{contents:[resource]}),undefined);
  for(const csp of [{connectDomains:["https://api.example.com"]},{frameDomains:["https://frame.example.com"]},{baseUriDomains:["https://base.example.com"]},{resourceDomains:["https://*.example.com"]}]){
    assert.equal(appResourceDocument(uri,{contents:[{...resource,_meta:{ui:{csp}}}]}),undefined);
  }
  const source=mcpAppSrcdoc(html,["https://cdn.example.com"]);
  assert.match(source,/script-src 'unsafe-inline' https:\/\/cdn\.example\.com/);
  assert.match(source,/connect-src 'none'; frame-src 'none'/);
  assert.doesNotMatch(mcpAppSrcdoc(html,["https://cdn.example.com; connect-src *"]),/cdn\.example\.com/);
});
test("resource declarations are stored only in the session-bound payload and cloned",()=>{
  const apps=new McpChatApps();
  const domains=["https://cdn.example.com"];
  apps.publish("a",{...payload,resourceDomains:domains});
  domains.push("https://evil.example.com");
  const id=apps.list("a")[0].id;
  assert.equal("resourceDomains" in apps.list("a")[0],false);
  assert.deepEqual(apps.get("a",id)?.resourceDomains,["https://cdn.example.com"]);
  assert.equal(apps.get("b",id),undefined);
  apps.publish("b",{...payload,resourceDomains:["https://*.example.com"]});
  assert.equal(apps.list("b").length,0);
});
