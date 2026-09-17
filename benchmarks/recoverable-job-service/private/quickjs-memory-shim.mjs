export class QuickJSMemoryCompatibilityError extends Error {}
// Compatibility fix for the exactly pinned quickjs-emscripten-core 0.32.0.
// Its output-pointer arrays otherwise retain detached WASM views across guest allocation.
// Preserve the library's pointer, constructor, length and Lifetime/free ownership.
const installed=new WeakSet();
export function installQuickJSMemoryViewRefresh(runtime){
 const memory=runtime?.memory;if(!memory?.module?.HEAPU8||typeof memory.newTypedArray!=='function')throw new QuickJSMemoryCompatibilityError('QuickJS0.32 memory adapter shape changed');
 let prototype=Object.getPrototypeOf(memory);while(prototype&&!Object.hasOwn(prototype,'newTypedArray'))prototype=Object.getPrototypeOf(prototype);
 if(!prototype)throw new QuickJSMemoryCompatibilityError('QuickJS0.32 ModuleMemory prototype unavailable');if(installed.has(prototype))return;
 const original=prototype.newTypedArray;
 prototype.newTypedArray=function(kind,length){const lifetime=original.call(this,kind,length);try{const value=lifetime.value,view=value.typedArray,module=this.module;if(!Number.isSafeInteger(value.ptr)||value.ptr<=0||!Number.isSafeInteger(length)||length<0||!(view instanceof kind)||view.byteOffset!==value.ptr||view.length!==length||!module?.HEAPU8)throw new QuickJSMemoryCompatibilityError('QuickJS0.32 pointer lifetime shape changed');Object.defineProperty(value,'typedArray',{enumerable:true,configurable:false,get:()=>new kind(module.HEAPU8.buffer,value.ptr,length)});return lifetime;}catch(error){lifetime.dispose();throw error;}};
 installed.add(prototype);
}
