import assert from 'node:assert/strict';
import {Broker} from '../benchmarks/recoverable-job-service/private/broker.mjs';

const identity={kind:'not-applied',code:'identity'};
const applied=(result:any)=>{assert.equal(result.kind,'applied');return result.value;};

async function replacement(firstPrivate:boolean,secondPrivate:boolean,responseLost=false){
 const b=new Broker(`reader-attachment-${firstPrivate}-${secondPrivate}-${responseLost}`);
 try{
  const input=b.sourcePrelude({streams:{stdout:[[11,12]],stderr:[[21]]}});
  const jobId=b.id(),fence={grant:b.grant,deadline:1000};
  const acquired:Record<string,any>={};
  for(const resource of ['isolation','process','channel','workload'])acquired[resource]=applied(await b.call('driver.acquire',{jobId,resource,operationId:b.id(),fence}));
  applied(await b.call('driver.start',{jobId,workloadId:input.workloadId,workload:acquired.process.payload.workload,witness:acquired.process.payload.witness,operationId:b.id(),fence}));
  b.output(jobId,'stdout',[31,32]);
  const channelBefore=await b.call('driver.readChannel',{jobId});
  const before=b.sourceState({sourceId:input.sourceId});
  const attach1={jobId,operationId:b.id(),fence,privateReader:firstPrivate};
  const r1=applied(await b.call('driver.attach',attach1));
  assert.equal(await b.call('verify',{receipt:r1}),true);
  assert.equal(r1.payload.privateReader,firstPrivate);
  assert.equal(r1.payload.source.channelId,acquired.channel.payload.channelId);
  const observe=(reader:any)=>b.call('driver.observeSource',{jobId,reader,operationId:b.id(),fence});
  const observation1Args={jobId,reader:r1,operationId:b.id(),fence};
  const observation1=applied(await b.call('driver.observeSource',observation1Args));
  const guard=(observation:any,key:string)=>b.call('store.commit',{operationId:b.id(),fence,writes:[{key,expected:0,value:{accepted:true}}],audit:[],sourceGuards:[{observation}]});
  applied(await guard(r1,'reader/first-current'));

  const attach2={jobId,operationId:b.id(),fence,privateReader:secondPrivate};
  if(responseLost)b.fault('source-observation.after','unknown',{jobId,observationMethod:'driver.attach'});
  const result2=await b.call('driver.attach',attach2);
  if(responseLost)assert.deepEqual(result2,{kind:'unknown',operationId:attach2.operationId},'an unknown response can hide an applied replacement');
  const r2=responseLost?await b.call('driver.receipt',{operationId:attach2.operationId}):applied(result2);
  assert.equal(await b.call('verify',{receipt:r2}),true);
  assert.equal(r2.operationId,attach2.operationId);
  assert.equal(r2.payload.privateReader,secondPrivate);
  assert.equal(r2.payload.source.channelId,r1.payload.source.channelId);
  assert.equal(r2.payload.source.sourceRevision,r1.payload.source.sourceRevision,'replacement does not require a source revision change');
  assert.notEqual(r2.operationId,r1.operationId);

  assert.deepEqual(await observe(r1),identity,'superseded receipt cannot observe its successor');
  assert.deepEqual(await b.call('driver.detach',{jobId,reader:r1,operationId:b.id(),fence}),identity,'superseded receipt cannot detach its successor');
  for(const [name,proof] of [['attachment',r1],['observation',observation1]] as const){
   const key='reader/refused-'+name;
   assert.deepEqual(await guard(proof,key),identity,'superseded source guard refuses identity at the unchanged source revision');
   assert.deepEqual(await b.call('store.read',{key}),{revision:0,value:null},'identity refusal publishes no write');
  }
  const currentAfterRefusals=applied(await observe(r2));
  assert.equal(currentAfterRefusals.payload.source.attachmentOperationId,r2.operationId);

  assert.deepEqual(await b.call('driver.attach',attach1),{kind:'applied',value:r1},'exact old attach replay returns its original historical receipt');
  assert.deepEqual(await b.call('driver.receipt',{operationId:attach1.operationId}),r1,'lookup preserves exact historical receipt');
  assert.deepEqual(await b.call('driver.observeSource',observation1Args),{kind:'applied',value:observation1},'exact old observation replay also remains historical');
  assert.deepEqual(await b.call('driver.attach',{...attach1,privateReader:!firstPrivate}),{kind:'not-applied',code:'input'},'changed arguments do not reuse the old attach operation');
  assert.deepEqual(await observe(r1),identity,'historical replay does not reinstall the old attachment');
  assert.deepEqual(await b.call('driver.detach',{jobId,reader:r1,operationId:b.id(),fence}),identity);
  assert.deepEqual(await guard(r1,'reader/replayed-old'),identity,'historical replay cannot reactivate a source guard');
  const current=applied(await observe(r2));
  assert.equal(current.payload.source.attachmentOperationId,r2.operationId,'successor stays current through refusals and replay');
  applied(await guard(current,'reader/second-current'));

  const detached=applied(await b.call('driver.detach',{jobId,reader:r2,operationId:b.id(),fence}));
  assert.deepEqual(detached.payload.reader,r2,'successful detach identifies the actual current receipt');
  assert.deepEqual(await observe(r2),identity,'current detach removes the current attachment');
  assert.deepEqual(await guard(current,'reader/after-detach'),identity);
  assert.deepEqual(await b.call('driver.attach',attach1),{kind:'applied',value:r1});
  assert.deepEqual(await observe(r1),identity,'old replay cannot install a reader into the now-empty slot');

  const after=b.sourceState({sourceId:input.sourceId});
  assert.deepEqual(after.streams,before.streams,'replacement/refusal/replay/detach leaves output bytes and cursors unchanged');
  assert.deepEqual(after.pendingAcks,before.pendingAcks);
  assert.equal(after.sourceRevision,before.sourceRevision);
  assert.deepEqual(after.counts,{...before.counts,attachments:before.counts.attachments+2},'only two new attachment effects occur; no implicit output/client/private/ACK effects');
  const channelAfter=await b.call('driver.readChannel',{jobId});
  assert.deepEqual({...channelAfter,revision:channelBefore.revision},channelBefore,'the explicit final transport read sees the same retained frame and output state');
 }finally{await b.shutdown();}
}

for(const firstPrivate of [false,true])for(const secondPrivate of [false,true])await replacement(firstPrivate,secondPrivate);
await replacement(false,true,true);
await replacement(true,false,true);
console.log('Actual reader attachment replacement, current identity guards, historical replay, changed-input refusal, lost response and zero output/client/ACK side effects: pass.');
