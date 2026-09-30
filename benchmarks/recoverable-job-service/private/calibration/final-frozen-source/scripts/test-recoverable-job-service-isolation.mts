import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {Broker} from '../benchmarks/recoverable-job-service/private/broker.mjs';
import {Guest} from '../benchmarks/recoverable-job-service/private/guest.mjs';
import {evaluateBounded} from '../benchmarks/recoverable-job-service/private/runtime.mjs';
import {parseRecoverableJobServiceDiagnostics} from '../lib/benchmark/workbench/recoverable-job-service/diagnostics';
const source=await readFile(new URL('../benchmarks/recoverable-job-service/private/reference.js',import.meta.url),'utf8');
const unhandled:unknown[]=[];const listener=(reason:unknown)=>unhandled.push(reason);process.on('unhandledRejection',listener);
const broker=new Broker('isolation-proof');const guest=await Guest.open(source,broker);
try{
 assert.deepEqual(await guest.code('return [typeof process,typeof require,typeof fetch,typeof Buffer,typeof Worker,typeof WebAssembly]'),['undefined','undefined','undefined','undefined','undefined','undefined']);
 broker.fault('store.read.before','hold');await guest.code('globalThis.observed=0;globalThis.pendingRead=ports.call("store.read",{key:"probe"}).then(v=>{observed=7;return v;});return "armed";');
 assert.equal(broker.held.size,1,'real host promise is held, not a synchronous fake');assert.equal(await guest.code('return observed'),0);broker.resume([...broker.held.keys()][0]);assert.deepEqual(await guest.code('return await pendingRead'),{revision:0,value:null});assert.equal(await guest.code('return observed'),7,'pending QuickJS promise jobs must execute after bridge resolution');
 const receipt=broker.receipt('consumer.consume',broker.id(),broker.id(),{frame:{},deliveryId:broker.id(),consumerId:broker.id()},{grant:broker.grant});const forged=structuredClone(receipt);delete forged.token;const token=await broker.call('capsule.seal',{capsule:forged});forged.token=token;assert.equal(await broker.call('verify',{receipt:forged}),false,'capsule signer must not mint effect receipts');
 await assert.rejects(()=>guest.code('return ports.call("node.fs.readFile",{path:"outside"})'),/unknown port/);
 await assert.rejects(()=>broker.call('artifact.create',{path:'../escape',owner:broker.id(),retained:false,operationId:broker.id(),fence:{grant:broker.grant,deadline:1000}}),/invalid path/);
 broker.fault('store.read.before','hold');const pending=guest.code('return ports.call("store.read",{key:"owned"})');pending.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));guest.dispose();await broker.shutdown();await pending.catch(()=>{});assert.equal(broker.active.size,0);assert.equal(broker.held.size,0);assert.equal(broker.timers.length,0);
}finally{guest.dispose();if(!broker.closed)await broker.shutdown();}
const defects=[
 ['synchronous loop','while(true){}'],
 ['unsettled promise','globalThis.createService=async()=>({run:()=>new Promise(()=>{}),subscribe(){return {id:"x",unsubscribe(){}}}});'],
 ['throwing service','globalThis.createService=async()=>{throw false};'],
 ['oversized result','globalThis.createService=async()=>({run:async()=>({kind:"ok",value:"x".repeat(9*1024*1024)}),subscribe(){}});'],
 ['missing export','globalThis.createService=undefined;'],
 ['malformed response','globalThis.createService=async()=>({run:async()=>({kind:"ok",value:null}),subscribe(){}});'],
] as const;
for(const [name,candidate] of defects){const start=performance.now(),result=await evaluateBounded(candidate,{families:['C01'],wallMs:250});assert.equal(result.status,'valid',name+' must be a candidate defect');assert.equal(result.resolved,false);assert(result.families.some((f:{passed:boolean})=>!f.passed));assert(performance.now()-start<5000,name+' must be bounded');console.log(name+': bounded candidate failure');}
const invalid=await evaluateBounded(source,{families:['A01','A01'],wallMs:1000});assert.equal(invalid.status,'invalid_harness');assert.equal(parseRecoverableJobServiceDiagnostics(invalid).ok,true,'infrastructure failure remains serializable and excluded from score');
const abort=new AbortController();abort.abort();await assert.rejects(()=>evaluateBounded(source,{signal:abort.signal}),{name:'AbortError'});
await new Promise(resolve=>setImmediate(resolve));process.off('unhandledRejection',listener);assert.deepEqual(unhandled,[],'no unobserved host promises survive shutdown');
console.log('Async bridge, authority separation, path validation, shutdown joining, watchdog, malformed results, invalid-harness classification and cancellation: pass.');

const entry=new URL('../benchmarks/recoverable-job-service/private/runtime.mjs',import.meta.url).href;const script='import {evaluateBounded} from '+JSON.stringify(entry)+';const r=await evaluateBounded("globalThis.createService=undefined;",{families:["C01"],wallMs:250});if(r.status!=="valid")throw Error(JSON.stringify(r.error));console.log("normalized-input-type-entry");';const child=await promisify(execFile)(process.execPath,['--input-type=module','--eval',script],{timeout:5000});assert.match(child.stdout,/normalized-input-type-entry/);console.log('Supported --input-type parent entry is normalized for the file worker: pass.');
