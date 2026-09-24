/** Public fixture recipes only. No lifecycle implementation or private state. */
const streams={zero:{stdout:[],stderr:[]},stdout:{stdout:[[11,12,13],[21,22]],stderr:[]},stderr:{stdout:[],stderr:[[7,8]]},both:{stdout:[[11,12,13],[21,22]],stderr:[[7,8]]}};
const request=async(h,type,args={})=>h.run({type,requestId:await h.control('id'),deadline:(await h.control('now'))+1000,...args});
const expectOk=(h,r,label)=>{h.expect(r.kind==='ok',label);return r.value;};
async function initialized(h,shape,options={}){
 const input=await h.control('sourcePrelude',{streams:streams[shape],...options});
 const batch=expectOk(h,await request(h,'createBatch'),'create source batch');
 await h.control('fault',{method:'driver.start.after',action:'unknown',receiptVisibility:'available'});
 await request(h,'start',{batchId:batch.batchId,workloadId:input.workloadId});
 const state=await h.control('sourceState',{sourceId:input.sourceId});
 h.expect(state.jobId!==null&&state.channelId!==null,'actual source-initialization reached');
 return {...input,...batch,...state};
}
async function progress(h,shape,tail=false){
 const input=await initialized(h,shape);
 if(tail){await h.control('output',{jobId:input.jobId,stream:'stdout',bytes:[31,32,33]});await h.control('output',{jobId:input.jobId,stream:'stderr',bytes:[41]});}
 await h.control('reopen');
 await request(h,'recover',{batchId:input.batchId});
 const job=expectOk(h,await h.run({type:'inspectJob',jobId:input.jobId}),'source job is inspectable');
 h.expect(job.state==='released','source recovery gives exact terminal disposition');
 const evidence=expectOk(h,await h.run({type:'readEvidence',jobId:input.jobId}),'source evidence readable');
 const m=evidence.manifest;h.expect(m.version===3&&m.final,'final EvidenceV3');
 for(const stream of ['stdout','stderr']){
  const bytes=streams[shape][stream].flat(),prefix=bytes.length,suffix=tail?(stream==='stdout'?3:1):0,t=m.totals[stream];
  h.expect(t.produced===prefix+suffix&&t.accepted===prefix+suffix&&t.sourcePrefix===prefix&&t.consumed===suffix&&t.acked===suffix,stream+' exact source and real suffix accounting');
  const losses=evidence.pieces.filter(p=>p.span.stream===stream&&p.span.reason==='source-prefix-unavailable');
  h.expect(prefix?losses.length===1&&losses[0].span.start===0&&losses[0].span.end===prefix&&losses[0].bytes.length===0:losses.length===0,stream+' exact initial loss range');
 }
 if(shape!=='zero')h.expect(m.sourceProof?.resourceId===input.jobId&&m.sourceProof.payload.source.channelId===input.channelId&&m.sourceProof.payload.source.pendingAcks.length===0,'exact job/channel source provenance');
 const after=await h.control('sourceState',{sourceId:input.sourceId});
 h.expect(after.counts.sourceInitializations===1&&after.counts.clientConsumes===0,'one source initialization, no invented client delivery');
 if(!tail)h.expect(after.counts.privateRetains===0&&after.counts.ackPublications===0&&after.counts.ackRetirements===0,'prefix performs zero private/ACK effects');
}
async function pending(h,state){
 const input=await initialized(h,'both',{pendingAcks:[{stream:'stdout',state}]});
 await h.control('reopen');await request(h,'recover',{batchId:input.batchId});
 const job=expectOk(h,await h.run({type:'inspectJob',jobId:input.jobId}),'unresolved source job inspectable');
 const id=input.pendingAcks[0].operationId,code=state==='pending'?'dependency':'unknown-effect';
 h.expect(job.state!=='released'&&job.blockers.some(b=>b.code===code&&(b.operationId===id||job.obligations.some(o=>o.attemptId===id))),'exact unresolved source ACK retained');
 const close=await request(h,'closeBatch',{batchId:input.batchId});h.expect(close.kind!=='ok','unresolved source cannot close batch');
 await h.control('sourceAckOutcome',{sourceId:input.sourceId,operationId:id,outcome:'applied'});
 await request(h,'recover',{batchId:input.batchId});
 const final=expectOk(h,await h.run({type:'inspectJob',jobId:input.jobId}),'settled source inspectable');h.expect(final.state==='released','fresh settled observation permits progress');
}
async function missing(h){
 const input=await initialized(h,'both');
 await request(h,'recover',{batchId:input.batchId});
 const capsule=expectOk(h,await h.run({type:'exportCapsule',jobId:input.jobId}),'real checkpoint exported');
 h.expect(capsule.checkpointEverCreated&&capsule.checkpoint!==null,'previously-created checkpoint reached');
 capsule.checkpoint=null;capsule.seal=await h.control('seal',{capsule});
 const result=await request(h,'restore',{capsule});h.expect(result.kind==='blocked'&&result.blockers.some(b=>b.code==='missing-checkpoint'),'source proof never replaces missing prior checkpoint');
}
export const sourceExamples=[...Object.keys(streams).map(shape=>({id:'B17/source-'+shape,run:h=>progress(h,shape)})),{id:'B17/source-tail',run:h=>progress(h,'both',true)},{id:'B17/source-pending',run:h=>pending(h,'pending')},{id:'B17/source-unknown',run:h=>pending(h,'unknown')},{id:'B17/source-missing-old',run:missing}];

sourceExamples.push({id:'B17/source-changed-ack',async run(h){
 const input=await h.control('sourcePrelude',{streams:streams.both});
 const batch=expectOk(h,await request(h,'createBatch'),'source batch created');
 const hold=await h.control('hold',{method:'store.commit.before',sourceId:input.sourceId,sourceGuardOnly:true});
 // Arm the public source boundary before start can adopt, then drive either start or stop adoption.
 const lifecycle=(async()=>{const start=await request(h,'start',{batchId:batch.batchId,workloadId:input.workloadId});if(start.kind!=='ok')return start;const state=await h.control('sourceState',{sourceId:input.sourceId});return request(h,'stop',{jobId:state.jobId});})();
 lifecycle.catch(()=>{});
 const reached=await Promise.race([h.control('waitBoundary',hold),lifecycle.then(()=>null)]);
 h.expect(reached!==null,'candidate reached the required first-adoption source guard');
 const initial=await h.control('sourceState',{sourceId:input.sourceId});
 const ack=await h.control('sourceAckBegin',{sourceId:input.sourceId,stream:'stdout',state:'pending'});
 await h.control('sourceAckOutcome',{sourceId:input.sourceId,operationId:ack.operationId,outcome:'applied'});
 await h.control('release',{heldId:reached.heldId});
 const result=await lifecycle;
 if(result.kind!=='ok'){
  h.expect(result.kind==='blocked'&&result.blockers.some(b=>b.code==='busy')||result.kind==='pending'&&typeof result.operationId==='string','obsolete revision reports published busy or exact pending observation');
  // A new request asks for reconciliation; never reuse an immutable completed request as a new attempt.
  await request(h,'recover',{batchId:batch.batchId});
 }
 const job=expectOk(h,await h.run({type:'inspectJob',jobId:initial.jobId}),'source job remains inspectable');h.expect(job.state==='released','fresh reconciliation releases source job');
 const evidence=expectOk(h,await h.run({type:'readEvidence',jobId:initial.jobId}),'source evidence readable');
 h.expect(evidence.manifest.sourceProof.payload.source.sourceRevision>initial.sourceRevision&&evidence.manifest.sourceProof.payload.source.pendingAcks.length===0,'published proof uses newer empty-pending revision');
 const state=await h.control('sourceState',{sourceId:input.sourceId});h.expect(state.counts.sourceAckEffects===1&&state.counts.ackRetirements===0&&evidence.manifest.totals.stdout.acked===0,'source ACK completion never credits candidate retirement');
}});
