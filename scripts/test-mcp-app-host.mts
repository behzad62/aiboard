import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { chromium } from "@playwright/test";

const bundle = await build({ stdin: { contents: [
  'import React from "react";',
  'import { createRoot } from "react-dom/client";',
  'import { McpAppCard } from "./components/extensions/McpAppCard";',
  'const app = { id:"app1", server:"fixture", tool:"view", uri:"ui://fixture/view.html", expiresAt:Date.now()+60000 };',
  'createRoot(document.getElementById("root")).render(<McpAppCard app={app} sessionId="test" connection={{url:location.origin,token:"HOST_ONLY_TOKEN"}} onChanged={()=>{}}/>);'
].join("\n"), resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, platform: "browser", jsx: "automatic", format: "iife", logLevel: "silent" });
const appHtml = [
  '<html><head><script src="https://cdn.example.com/app.js"></script><script src="https://other.example.com/denied.js"></script></head><body><div id="external">waiting</div><div id="result">waiting</div><button id="increment">Add one</button><div id="count">0</div><div id="security">checking</div><button id="refresh">Refresh</button><div id="refresh-result">waiting</div>',
  '<script>',
  'let n=0, gotInput=false, gotResult=false, toolDenied=false, hostDenied=false, isolated=false, fetchBlocked=false;',
  'const post=(m)=>parent.postMessage({jsonrpc:"2.0",...m},"*");',
  'const status=()=>document.getElementById("security").textContent=[isolated,fetchBlocked,toolDenied,hostDenied].join(",");',
  'try { void parent.document.body; } catch { isolated=true; }',
  'fetch("https://cdn.example.com/api").catch(()=>{fetchBlocked=true;status()});',
  'document.getElementById("external").textContent=String(window.externalLoaded===true);',
  'const bad=document.createElement("iframe");bad.src="https://cdn.example.com/frame";document.body.appendChild(bad);',
  'document.getElementById("increment").onclick=()=>document.getElementById("count").textContent=String(++n);',
  'let requestId=10;document.getElementById("refresh").onclick=()=>{document.getElementById("refresh-result").textContent="waiting";post({id:++requestId,method:"tools/call",params:{name:"refresh",arguments:{filter:"active"}}});};',
  'window.addEventListener("message",e=>{if(e.source!==parent)return;const m=e.data;',
  'if(m.id===1&&m.result){post({method:"ui/notifications/initialized"});post({id:2,method:"tools/call",params:{name:"danger",arguments:{}}});post({id:3,method:"ui/open-link",params:{url:"https://example.com"}});}',
  'if(m.method==="ui/notifications/tool-input")gotInput=m.params.arguments.n===7;',
  'if(m.method==="ui/notifications/tool-result"){gotResult=m.params.content[0].text==="browser-result"&&m.params._meta?.privateAppData==="metadata";document.getElementById("result").textContent=String(gotInput&&gotResult);post({method:"ui/notifications/size-changed",params:{height:420}});}',
  'if(m.id===2){toolDenied=!!m.error||m.result?.isError===true;status();}',
  'if(typeof m.id==="number"&&m.id>10)document.getElementById("refresh-result").textContent=m.error||m.result?.isError?"denied":m.result?.content?.[0]?.text??"invalid";',
  'if(m.id===3){hostDenied=!!m.error||m.result?.isError===true;status();}',
  'if(m.method==="ui/resource-teardown")post({id:m.id,result:{}});});',
  'post({id:1,method:"ui/initialize",params:{appInfo:{name:"fixture",version:"1"},appCapabilities:{},protocolVersion:"2026-01-26"}});',
  '</script></body></html>'
].join("");
let reads = 0, unexpected = 0, staged = 0, approved = 0, denied = 0;
const server = createServer(async (req,res)=>{
  if (req.url === "/") {res.setHeader("Content-Type","text/html");res.end('<!doctype html><div id="root"></div><script src="/bundle.js"></script>');}
  else if(req.url === "/bundle.js"){res.setHeader("Content-Type","text/javascript");res.end(bundle.outputFiles[0].text);}
  else if(req.url === "/v2/chat-sessions/test/mcp-app/app1" && req.method === "GET"){
    reads++; assert.equal(req.headers.authorization,"Bearer HOST_ONLY_TOKEN");
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify({id:"app1",server:"fixture",tool:"view",uri:"ui://fixture/view.html",expiresAt:Date.now()+60000,html:appHtml,resourceDomains:["https://cdn.example.com"],allowedTools:["refresh"],arguments:{n:7},result:{content:[{type:"text",text:"browser-result"}],isError:false,_meta:{privateAppData:"metadata"}}}));
  } else if(req.url?.startsWith("/v2/chat-sessions/test/mcp-app/app1/calls") && req.method==="POST"){
    assert.equal(req.headers.authorization,"Bearer HOST_ONLY_TOKEN");
    const chunks:Buffer[]=[]; for await(const chunk of req)chunks.push(Buffer.from(chunk)); const body=JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("Content-Type","application/json");
    if(req.url.endsWith("/calls")){
      assert.deepEqual(body,{name:"refresh",arguments:{filter:"active"}});staged++;
      res.end(JSON.stringify({id:"ticket"+staged,name:"refresh",risk:"read_only",arguments:{filter:"active"},expiresAt:Date.now()+60000}));
    }else{
      assert.equal(req.url.endsWith("/ticket"+staged),true);
      assert.deepEqual(Object.keys(body),["approve"]);
      if(body.approve){approved++;res.end(JSON.stringify({content:[{type:"text",text:"refreshed"}],isError:false}));}
      else {denied++;res.end(JSON.stringify({content:[{type:"text",text:"declined"}],isError:true}));}
    }
  } else if(req.url === "/favicon.ico"){res.statusCode=204;res.end();}
  else {unexpected++;res.statusCode=404;res.end();}
});
await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
let browser;
try {
  browser = await chromium.launch({headless:true});
  const page = await browser.newPage();
  const errors:string[]=[]; page.on("pageerror",e=>errors.push(e.message));
  const external:string[]=[];
  await page.route("https://**/*",async route=>{
    const url=route.request().url();external.push(url);
    if(url==="https://cdn.example.com/app.js")await route.fulfill({status:200,contentType:"text/javascript",body:"window.externalLoaded=true;"});
    else await route.abort();
  });
  await page.goto("http://127.0.0.1:"+(server.address() as AddressInfo).port);
  await page.getByRole("button",{name:"Open app"}).waitFor();
  assert.equal(reads,0,"no app payload is fetched before user opens it");
  await page.getByRole("button",{name:"Open app"}).click();
  const consent=page.getByRole("alertdialog",{name:"Allow external app resources"});
  await consent.waitFor();
  assert.match(await consent.innerText(),/https:\/\/cdn\.example\.com/);
  assert.equal(await page.locator("iframe").count(),0);
  assert.deepEqual(external,[]);
  await consent.getByRole("button",{name:"Open offline"}).click();
  await page.frameLocator("iframe").locator("#result").filter({hasText:"true"}).waitFor({timeout:10000});
  assert.equal(await page.frameLocator("iframe").locator("#external").textContent(),"false");
  assert.deepEqual(external,[]);
  await page.getByRole("button",{name:"Close",exact:true}).click();
  await page.locator("iframe").waitFor({state:"detached"});
  await page.getByRole("button",{name:"Open app"}).click();
  await consent.waitFor();
  assert.deepEqual(external,[]);
  await consent.getByRole("button",{name:"Allow external resources once"}).click();
  const iframe = page.locator("iframe");
  await iframe.waitFor();
  assert.equal(await iframe.getAttribute("sandbox"),"allow-scripts");
  const app = page.frameLocator("iframe");
  await app.locator("#result").filter({hasText:"true"}).waitFor({timeout:10000});
  await app.locator("#external").filter({hasText:"true"}).waitFor();
  await app.locator("#security").filter({hasText:"true,true,true,true"}).waitFor({timeout:10000});
  await app.getByRole("button",{name:"Add one"}).click();
  assert.equal(await app.locator("#count").textContent(),"1");
  await app.getByRole("button",{name:"Refresh"}).click();
  const approval = page.getByRole("alertdialog",{name:"Confirm app tool call"});
  await approval.waitFor();assert.equal(staged,1);assert.equal(approved,0);
  assert.match(await approval.innerText(), /"filter": "active"/);
  await approval.getByRole("button",{name:"Deny"}).click();
  await app.locator("#refresh-result").filter({hasText:"denied"}).waitFor();
  assert.equal(denied,1);assert.equal(approved,0);
  await app.getByRole("button",{name:"Refresh"}).click();
  await approval.waitFor();assert.equal(staged,2);assert.equal(approved,0);
  // A click that lands as the app-timed dialog appears must not approve.
  const allow = approval.getByRole("button",{name:"Allow this call"});
  assert.equal(await allow.isDisabled(),true,"approval is not armed the instant the app request appears");
  await allow.click({force:true});
  await page.waitForTimeout(100);
  assert.equal(approved,0,"an immediate click does not approve");
  assert.equal(await approval.isVisible(),true);
  await allow.click();
  await app.locator("#refresh-result").filter({hasText:"refreshed"}).waitFor();
  assert.equal(approved,1);
  await page.getByRole("button",{name:"Expand"}).click();
  await page.getByRole("button",{name:"Minimize"}).waitFor();
  await page.getByRole("button",{name:"Close",exact:true}).click();
  await iframe.waitFor({state:"detached"});
  assert.equal(reads,2);assert.deepEqual(external,["https://cdn.example.com/app.js"]);assert.equal(unexpected,0);assert.deepEqual(errors,[]);
  console.log("PASS: external origin consent, offline fallback, approved static script, blocked undeclared origins/API/frames; real Chromium app handshake, data, local interaction, CSP, opaque origin, denied unauthorized calls, explicit approval/denial, approval arming delay, expand and close.");
} finally {
  await browser?.close();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
}
