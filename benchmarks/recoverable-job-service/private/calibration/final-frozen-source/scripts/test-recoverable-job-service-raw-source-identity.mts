import assert from 'node:assert/strict';
import {Broker,HarnessError} from '../benchmarks/recoverable-job-service/private/broker.mjs';
const b=new Broker(),source=b.sourcePrelude({streams:{stdout:[[1,2]],stderr:[]}}),jobId=b.id(),fence={grant:b.grant,deadline:1000};
for(const resource of ['isolation','process','channel','workload'])await b.call('driver.acquire',{jobId,resource,operationId:b.id(),fence});const j=b.getJob(jobId);
await b.call('driver.start',{jobId,workloadId:source.workloadId,workload:j.workload,witness:j.witness,operationId:b.id(),fence});b.output(jobId,'stdout',[3,4,5]);const key=structuredClone(j.queue[0].key);
j.queue[0].key.stream='bad';j.queue[0].key.length=0;const state=b.sourceState({sourceId:source.sourceId});assert.equal(state.streams.stdout.retainedBytes,3,'raw source retains physical stream and length');assert.equal(state.streams.stdout.produced,5);assert.equal(state.streams.stderr.retainedBytes,0);
const reader=await b.call('driver.attach',{jobId,privateReader:true,operationId:b.id(),fence});assert.equal(reader.kind,'applied');assert.equal(reader.value.payload.source.streams.stdout.retainedBytes,3);assert.ok(b.verify(reader.value));
const channel=await b.call('driver.readChannel',{jobId,epoch:b.grant.epoch});assert.equal(channel.frame.key.stream,'bad','malformed transport stays candidate visible');assert.equal(channel.frame.key.length,0);assert.equal(channel.frame.bytes.length,3);
j.sourceAdvanced.stdout.offset=-1;assert.throws(()=>b.sourceState({sourceId:source.sourceId}),HarnessError);j.sourceAdvanced.stdout.offset=2;j.sourcePrefix.stdout.offset=1;assert.throws(()=>b.sourceState({sourceId:source.sourceId}),HarnessError);j.sourcePrefix.stdout.offset=2;j.queue[0].key=key;await b.shutdown();
console.log('Raw physical source identity is isolated from disclosed malformed transport; trusted physical corruption still invalidates harness.');

