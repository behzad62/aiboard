import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {evaluatePublic} from '../benchmarks/recoverable-job-service/private/public-evaluator.mjs';
const reference=await readFile('benchmarks/recoverable-job-service/private/reference.js','utf8');
const anchor="await update(jk(j.jobId),old=>({...old,state:'running'})";
assert.ok(reference.includes(anchor));
const eager=reference.replace(anchor,"j=await ensureSource(j,await effect(j,'reader','driver.attach',{privateReader:true},req),req);"+anchor);
for(const [name,base] of [['late',reference],['eager',eager]])for(const transient of [false,true]){
 let source=base;if(transient){source=source.replace('const call=(m,a={})','let surfaceFirstSourceBusy=true; const call=(m,a={})').replace("if(error?.result?.blockers?.[0]?.code!=='busy')throw error;","if(error?.result?.blockers?.[0]?.code!=='busy'||surfaceFirstSourceBusy){surfaceFirstSourceBusy=false;throw error;}");}
 const r=await evaluatePublic(source,{families:['B17/source-changed-ack'],wallMs:5000});assert.ok(r.families[0].passed,name+' '+(transient?'explicit busy reconciliation':'same-request retry')+': '+r.families[0].reason);
 console.log(name,transient?'explicit busy reconciliation':'same-request retry','passed');
}
