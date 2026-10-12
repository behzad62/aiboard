// Fixed Worker runtime proposal. Source is bundled from pinned in-memory bytes by its owner.
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { parentPort, workerData, isMainThread } from 'node:worker_threads';
import { BirthRequestQueue } from './queue.mjs';
import { FrameReader, errorFacts } from './protocol.mjs';
if(isMainThread)throw Error('Private birth runtime requires an owned Worker');
const cfg=workerData;
if(!cfg||Object.keys(cfg).sort().join(',')!=='challenge,generation,generationState,pipeName,secret,source,timeOrigin'||typeof cfg.pipeName!=='string'||!/^aiboard-birth-[0-9a-f]{32}$/.test(cfg.pipeName)||!Number.isFinite(cfg.timeOrigin))throw Error('Private runtime configuration');
let socket,timer,failed=false,retired=false,readyPublished=false;
const now=()=>performance.timeOrigin+performance.now()-cfg.timeOrigin;
const queue=new BirthRequestQueue({challenge:cfg.challenge,generation:cfg.generation,generationState:cfg.generationState,secret:cfg.secret,source:cfg.source},{now,send:bytes=>socket.write(bytes),failed:error=>fail(error)});
function fail(error) {
  if(failed||retired)return;failed=true;process.exitCode=1;clearTimeout(timer);
  // Queue poison already closes every registered slot before this main-loop notification.
  if(!queue.failure)try{queue.poison(error);}catch{/* Original failure remains in queue.failure. */}
  try{parentPort.postMessage({type:'failure',generation:cfg.generation,facts:errorFacts(queue.failure??error)});}finally{socket?.destroy();parentPort.close();}
}
function arm() {
  clearTimeout(timer);if(failed||retired)return;
  const deadline=queue.nextDeadline();
  if(Number.isFinite(deadline))timer=setTimeout(()=>{try{queue.tick();arm();}catch(error){fail(error);}},Math.max(1,deadline-now()));
}
const reader=new FrameReader(raw=>{
  queue.accept(raw);
  if(queue.ready&&!readyPublished){readyPublished=true;parentPort.postMessage({type:'ready',generation:cfg.generation,counters:{wireQueries:0}});}
  arm();
});
socket=net.connect({path:'\\\\.\\pipe\\'+cfg.pipeName});
socket.once('connect',()=>{try{socket.write(queue.startFrame());}catch(error){fail(error);}});
socket.on('data',chunk=>{try{reader.push(chunk);}catch(error){fail(error);}});
socket.on('error',fail);
socket.on('end',()=>{try{reader.finish();}catch(error){fail(error);return;}if(!retired)fail(Error('Unexpected private transport EOF'));});
socket.on('close',()=>{if(!retired&&!failed)fail(Error('Unexpected private transport close'));});
parentPort.on('message',message=>{
  try {
    if(!message||message.generation!==cfg.generation)throw Error('Foreign Worker command generation');
    if(message.type==='request'){queue.enqueue(message);arm();return;}
    if(message.type==='cancel'&&Object.keys(message).sort().join(',')==='generation,requestId,type'&&Number.isSafeInteger(message.requestId)&&message.requestId>0){queue.tick();arm();return;}
    if(message.type==='close'&&Object.keys(message).sort().join(',')==='generation,type'){
      retired=true;clearTimeout(timer);queue.close();socket.destroy();parentPort.close();return;
    }
    throw Error('Unknown private Worker command');
  }catch(error){fail(error);}
});
