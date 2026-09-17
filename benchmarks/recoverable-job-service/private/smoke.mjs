import {readFile} from 'node:fs/promises';
import {Broker} from './broker.mjs';
import {Guest} from './guest.mjs';
const b=new Broker(),g=await Guest.open(await readFile(new URL('./reference.js',import.meta.url),'utf8'),b);
const run=async (type,args={})=>{const r=await g.invoke({type,requestId:b.id(),deadline:b.time+1000,...args});console.log(type,JSON.stringify(r));return r.value;};
try{const {batchId}=await run('createBatch');const {jobId}=await run('start',{batchId,workloadId:b.id()});b.output(jobId,'stdout',[1,2,3]);await run('poll',{jobId});await run('stop',{jobId});await run('readEvidence',{jobId});}finally{g.dispose();await b.shutdown();}
