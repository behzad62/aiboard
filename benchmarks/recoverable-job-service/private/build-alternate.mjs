import {readFile,writeFile} from 'node:fs/promises';
const base='benchmarks/recoverable-job-service/private/';
let source=await readFile(base+'reference.js','utf8');
source=source.replace('// Snapshot-oriented correct control. Never distributed in the candidate fixture.','// Journaled correct control with a re-evaluated dependency graph and atomic final-fact publication.\n// Self-contained candidate module; no reference reducer or evaluator imports.');
const start=source.indexOf(' const stop=async('),end=source.indexOf(' const readEvidence=',start);if(start<0||end<0)throw Error('alternate source boundary');
source=source.slice(0,start)+await readFile(base+'alternate-stop.txt','utf8')+source.slice(end);
source=source.replace("const commit=async(writes,audit,op)=>primitive('store.commit',{writes,audit,operationId:await call('newId')},op);",`const commit=async(writes,audit,op)=>{const operationId=await call('newId');const events=writes.map(w=>({key:'journal/'+operationId+'/'+writes.indexOf(w),expected:0,value:{key:w.key,expected:w.expected,value:w.value}}));return primitive('store.commit',{writes:[...writes,...events],audit,operationId},op);};`);
await writeFile(base+'alternate.js',source);
