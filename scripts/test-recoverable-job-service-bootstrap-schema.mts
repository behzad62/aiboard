import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {Broker,HarnessError} from '../benchmarks/recoverable-job-service/private/broker.mjs';
import {evaluateBounded} from '../benchmarks/recoverable-job-service/private/runtime.mjs';
import {parseRecoverableJobServiceDiagnostics} from '../lib/benchmark/workbench/recoverable-job-service/diagnostics';
const b=new Broker(),input=b.sourcePrelude({streams:{stdout:[[1,2]],stderr:[]}}),jobId=b.id(),fence={grant:b.grant,deadline:1000};
for(const resource of ['isolation','process','channel','workload'])await b.call('driver.acquire',{jobId,resource,operationId:b.id(),fence});const j=b.getJob(jobId);
await b.call('driver.start',{jobId,workloadId:input.workloadId,workload:j.workload,witness:j.witness,operationId:b.id(),fence});
j.sourceAdvanced.stdout.offset=-1;assert.throws(()=>b.sourceState({sourceId:input.sourceId}),HarnessError);j.sourceAdvanced.stdout.offset=2;
j.sourcePrefix.stdout.offset=1;assert.throws(()=>b.sourceState({sourceId:input.sourceId}),/immutable/);j.sourcePrefix.stdout.offset=2;await b.shutdown();
const source=await readFile('benchmarks/recoverable-job-service/public/service.js','utf8');
const result=await evaluateBounded(source);assert.equal(result.status,'valid');assert.equal(result.resolved,false);assert.equal(parseRecoverableJobServiceDiagnostics(result).ok,true,JSON.stringify(parseRecoverableJobServiceDiagnostics(result)));
for(const alter of [x=>x.inputIdentity.cases[0].rootCommitment='0'.repeat(64),x=>x.inputIdentity.cases.pop(),x=>x.inputIdentity.root='secret',x=>x.inputIdentity.cases[0].fixtureAllocations=-1,x=>x.families[0].variants[0].inputIdentity=null,x=>x.schemaVersion=1,x=>x.resolved=true]){const changed=structuredClone(result);alter(changed);assert.equal(parseRecoverableJobServiceDiagnostics(changed).ok,false);}
const bad=await evaluateBounded(source,{replayInput:null});assert.equal(bad.status,'invalid_harness');assert.equal(parseRecoverableJobServiceDiagnostics(bad).ok,true);
console.log('Trusted raw-state corruption invalidates harness; schema-2 candidate failures parse and forged/mismatched execution identities fail.');
