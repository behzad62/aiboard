import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import type { BuildRuntime } from "../src/build-runtime.js";
import type { NativeBuildSpec } from "../src/build-spec.js";
import { NativeBuildManager, type NativeBuildRuntimeHandle } from "../src/native-build-manager.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
const spec: NativeBuildSpec = {version:2,runId:"reader",projectId:"project",objective:"Read current facts",architectRuntimeId:"architect",workerRuntimeIds:["worker"],verifierRuntimeIds:["verifier"],alwaysRequireIndependentVerifier:false,maxConcurrency:1,permissionProfile:"full",runPolicy:"budgeted",budgetLimits:{maxActiveMs:1000},createdAt:"2026-10-13T00:00:00Z",idempotencyKey:"reader"};
async function fixture(_kind: "files" | "transcript" | "observability", failure?: Error, historical = false) {
 let release!:()=>void;let entered!:()=>void;let resourceClosed=false;
 const barrier=new Promise<void>(r=>{release=r;});const started=new Promise<void>(r=>{entered=r;});
 const read=async()=>{entered();await barrier;assert.equal(resourceClosed,false,"Reader's exact resources must remain live through settlement");if(failure)throw failure;return {sentinel:"read-result"};};
 const handle={...(historical ? {historical:true as const} : {}),runtime:{id:spec.runId,projection:()=>({runId:spec.runId,status:"running"})} as unknown as BuildRuntime,usage:()=>({}),files:read,transcript:read,observability:read,compact(){},projectHandoff:async()=>({}),cleanup(){},close(){resourceClosed=true;}} as unknown as NativeBuildRuntimeHandle;
 const manager=new NativeBuildManager({specs:new SqliteBuildSpecStore(":memory:"),createRuntime:async()=>handle});
 await manager.create(spec);return {manager,handle,release,started,closed:()=>resourceClosed};
}
for(const kind of ["files","transcript","observability"] as const)test("manager close retains exact resources while " + kind + " reader is unsettled",async()=>{
 const f=await fixture(kind);const reading=f.manager[kind](spec.runId);let closing:Promise<void>|undefined;
 try{await f.started;closing=f.manager.close();await setImmediate();assert.equal(f.closed(),false,"Close must join admitted reader before retiring its owner");f.release();await reading;await closing;assert.equal(f.closed(),true);}
 finally{f.release();await reading.catch(()=>undefined);await (closing??f.manager.close());}
});

for(const kind of ["files","transcript","observability"] as const)test("rejected " + kind + " reader keeps original error and releases its admitted activity",async()=>{
 const sentinel=new Error("reader");const f=await fixture(kind,sentinel);const reading=f.manager[kind](spec.runId);const rejected=assert.rejects(reading,e=>e===sentinel);
 try{await f.started;const closing=f.manager.close();await setImmediate();assert.equal(f.closed(),false);f.release();await rejected;await closing;assert.equal(f.closed(),true);}finally{f.release();await rejected;await f.manager.close();}
});
for(const kind of ["files","transcript","observability"] as const)test("manager refuses new " + kind + " reader after close admission",async()=>{
 const f=await fixture(kind);const closing=f.manager.close();
 try{await assert.rejects(f.manager[kind](spec.runId),/closed|closing/);await closing;}finally{f.release();await f.manager.close();}
});
for(const kind of ["files","transcript","observability"] as const)test("historical " + kind + " reader remains readable under exact resource ownership",async()=>{
 const f=await fixture(kind,undefined,true);const reading=f.manager[kind](spec.runId);
 try{await f.started;f.release();assert.deepEqual(await reading,{sentinel:"read-result"});}finally{f.release();await reading;await f.manager.close();}
});

for (const kind of ["files", "transcript", "observability"] as const) test("synchronous " + kind + " reader failure releases activity and preserves the original error", async () => {
 const sentinel = new Error("synchronous reader failure");
 const f = await fixture(kind);
 f.handle[kind] = () => { throw sentinel; };
 try {
  await assert.rejects(f.manager[kind](spec.runId), error => error === sentinel);
  await f.manager.close();
  assert.equal(f.closed(), true, "A synchronous reader exception must not retain the activity lease");
 } finally {
  f.release();
  await f.manager.close();
 }
});
