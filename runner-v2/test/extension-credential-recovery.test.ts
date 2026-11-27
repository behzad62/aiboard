import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ExtensionCredentialStore} from "../src/extension-credentials.js";

test("credential lineage survives reopen and only exact same grant refresh preserves it",async t=>{
  const root=await mkdtemp(join(tmpdir(),"mcp-credential-lineage-"));
  t.after(async()=>rm(root,{recursive:true,force:true}));
  const path=join(root,"credentials.enc"),key=Buffer.alloc(32,7);
  let store=new ExtensionCredentialStore(path,key);
  const client={tokenEndpoint:"https://issuer.example/token",clientId:"client",resource:"https://server.example/mcp"};
  const input={extensionId:"extension",name:"oauth",kind:"oauth" as const,value:"token-one",refreshToken:"refresh-one",scope:"a b",resource:client.resource,oauthClient:client};
  const meta=store.put(input), first=store.taskCredential(meta.ref);
  assert.ok(!JSON.stringify(meta).includes(first.lineage));
  store.close();store=new ExtensionCredentialStore(path,key);t.after(()=>store.close());
  assert.equal(store.taskCredential(meta.ref).lineage,first.lineage);
  const rotated=store.rotateOAuth(meta.ref,first.revision,{value:"token-two",refreshToken:"refresh-two",scope:"b a"},client);
  assert.equal(rotated.lineage,first.lineage);
  assert.notEqual(rotated.revision,first.revision);
  assert.throws(()=>store.rotateOAuth(meta.ref,first.revision,{value:"stale"},client),/changed during refresh/);
  const narrowed=store.rotateOAuth(meta.ref,rotated.revision,{value:"token-three",scope:"a"},client);
  assert.notEqual(narrowed.lineage,rotated.lineage);
  store.put(input);
  assert.notEqual(store.taskCredential(meta.ref).lineage,narrowed.lineage);
  assert.throws(()=>store.rotateOAuth(meta.ref,narrowed.revision,{value:"stale"},client),/changed during refresh/);
  const live=store.taskCredential(meta.ref);
  store.revoke({ref:meta.ref});
  assert.throws(()=>store.rotateOAuth(meta.ref,live.revision,{value:"stale"},client),/changed during refresh/);
});

test("a caller abort during OAuth refresh cannot discard the rotated refresh token, and concurrent callers share one exchange",async t=>{
  const {ManagedMcpRuntime}=await import("../src/extension-mcp.js");
  const root=await mkdtemp(join(tmpdir(),"mcp-refresh-abort-"));
  t.after(async()=>rm(root,{recursive:true,force:true}));
  const store=new ExtensionCredentialStore(join(root,"credentials.enc"),Buffer.alloc(32,9));
  t.after(()=>store.close());
  const client={tokenEndpoint:"https://issuer.example/token",clientId:"client",resource:"https://server.example/mcp"};
  const meta=store.put({extensionId:"extension",name:"oauth",kind:"oauth",value:"expiring",refreshToken:"rt-1",
    expiresAt:new Date(Date.now()+5_000).toISOString(),scope:"notes.read",resource:client.resource,oauthClient:client});
  const before=store.taskCredential(meta.ref);
  let exchanges=0;
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  // A real fetch rejects when its signal aborts; the issuer has already rotated rt-1 by then.
  const remoteFetch=(async(_url:unknown,init?:RequestInit)=>{
    exchanges++;
    const body=new URLSearchParams(String(init?.body));
    assert.equal(body.get("refresh_token"),"rt-1");
    await Promise.race([gate,new Promise((_resolve,reject)=>init?.signal?.addEventListener("abort",()=>reject(new DOMException("aborted","AbortError")),{once:true}))]);
    return new Response(JSON.stringify({access_token:"fresh",token_type:"Bearer",expires_in:3600,refresh_token:"rt-2",scope:"notes.read"}),
      {status:200,headers:{"content-type":"application/json"}});
  }) as typeof fetch;
  const runtime=new ManagedMcpRuntime({home:join(root,"home"),stateDirectory:join(root,"state"),projectRoot:root,credentials:store,
    internal:{} as never,installer:{} as never,remoteFetch});
  const authorize=(signal?:AbortSignal)=>(runtime as unknown as {oauthAuthorization(id:string,expected?:string,signal?:AbortSignal):Promise<{header:string;binding:string}>})
    .oauthAuthorization("extension",undefined,signal);
  const controller=new AbortController();
  const aborted=authorize(controller.signal);
  const concurrent=authorize();
  await new Promise(resolve=>setTimeout(resolve,20));
  controller.abort();
  await assert.rejects(aborted);
  release();
  const shared=await concurrent;
  assert.equal(exchanges,1,"concurrent refreshes of one credential revision share a single exchange");
  assert.equal(shared.header,"Bearer fresh");
  const after=store.taskCredential(meta.ref);
  assert.equal(after.value,"fresh");
  assert.equal(after.refreshToken,"rt-2","the rotated refresh token is kept even though one caller aborted");
  assert.equal(after.lineage,before.lineage);
  // A later caller uses the stored token without another exchange.
  assert.equal((await authorize()).header,"Bearer fresh");
  assert.equal(exchanges,1);
});
