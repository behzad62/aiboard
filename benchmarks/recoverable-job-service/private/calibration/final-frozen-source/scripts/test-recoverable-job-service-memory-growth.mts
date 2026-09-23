import assert from 'node:assert/strict';
import {getQuickJS} from 'quickjs-emscripten';
const q=await getQuickJS(),runtime=q.newRuntime();
if(!process.argv.includes('--unpatched')){const {installQuickJSMemoryViewRefresh}=await import('../benchmarks/recoverable-job-service/private/quickjs-memory-shim.mjs');installQuickJSMemoryViewRefresh(runtime);}
const context=runtime.newContext(),module=(runtime as any).memory.module;
function grow(){const before=module.HEAPU8.buffer,pointer=module._malloc(module.HEAPU8.byteLength+65536);assert(pointer);module._free(pointer);assert.notEqual(module.HEAPU8.buffer,before,'forced actual WASM memory growth');}
let promise:any;
try{const fn=context.newFunction('grow',()=>{grow();return context.undefined;});context.setProp(context.global,'grow',fn);fn.dispose();promise=context.unwrapResult(context.evalCode('Promise.resolve().then(grow)'));const result=runtime.executePendingJobs(1);if(result.error){const error=context.dump(result.error);if(result.error.alive)result.error.dispose();throw Error(JSON.stringify(error));}assert.equal(result.value,1);console.log('contexts after forced job growth:',(runtime as any).contextMap.size);assert.equal((runtime as any).contextMap.size,1,'WASM growth must not create an unowned context');promise.dispose();promise=undefined;
 const ffi=(context as any).ffi,original=ffi.QTS_NewPromiseCapability;let deferred:any;try{ffi.QTS_NewPromiseCapability=(...args:any[])=>{const result=original(...args);grow();return result;};deferred=context.newPromise();}finally{ffi.QTS_NewPromiseCapability=original;}deferred.resolve(context.true);const state=context.getPromiseState(deferred.handle);assert.equal(state.type,'fulfilled');if(state.type==='fulfilled'&&state.value.alive)state.value.dispose();deferred.dispose();console.log('Resolver pointers survive forced growth during newPromise: pass.');
}finally{if(promise?.alive)promise.dispose();for(const ctx of [...(runtime as any).contextMap.values()] as any[])if(ctx.alive)ctx.dispose();runtime.dispose();}
console.log('One-job growth, context ownership, resolver-array growth and runtime disposal: pass.');
