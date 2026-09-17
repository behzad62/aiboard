import {validateResponse} from './response-schema.mjs';
import {audit as validAudit} from './wire-schema.mjs';
import {canonical,digest,jsonDigest} from './broker.mjs';
/** Trusted causal oracle. It never calls candidate helpers or reads candidate private keys. */
export function inspectSafety(broker) {
 const errors=[],setups=new Map(),intents=new Set(),accepted=new Map(),consumeIntents=new Set(),consumed=new Map(),ackIntent=new Set(),acked=new Set(),facts=new Map(),finals=new Map(),released=new Set(),writes=[],inventories=new Map(),channels=new Map(),barriers=new Map(),acquiredJobs=new Set(),acquiredChannels=new Set(),ownership=new Map(),effects=new Map(),readers=new Map(),acquiredResources=new Set(),workloads=new Map(),lossPermission=new Map(),observedBytes=new Map(),sourceInputs=new Map(),sourceAdoptions=new Map(),sourceComparisons=new Map();
 const key=f=>canonical(f),factSet=id=>{if(!facts.has(id))facts.set(id,new Set());return facts.get(id);};
 const error=(code,jobId,detail)=>errors.push({code,jobId:jobId??null,detail});
 for(const event of broker.trace){
  if(event.type==='source-initialization')sourceInputs.set(event.jobId,event);
  if(event.type==='source-guard')sourceComparisons.set(event.revision,event);

  if(event.type==='workload-state')workloads.set(event.jobId,event.state);
  if(event.type==='fault'&&event.boundary==='artifact.write.before'&&event.action==='not-applied'&&['privacy','backend'].includes(event.code))lossPermission.set(event.args.root.owner,event.code==='backend'?'diagnostic-io':'privacy');
  if(event.type==='return'&&event.method==='driver.readChannel'&&event.value.frame)observedBytes.set(key(event.value.frame.key),event.value.frame.bytes);

  if(event.type==='return'&&event.method==='driver.inspect')inventories.set(event.args.jobId,event.value);
  if(event.type==='return'&&event.method==='driver.readChannel')channels.set(event.args.jobId,event.value);
  if(event.type==='effect'){
   const r=event.receipt,id=r.resourceId,p=r.payload;effects.set(r.id,r);if(event.method==='driver.acquire'){acquiredResources.add(id+'/'+p.resource);if(p.resource==='process')workloads.set(id,'not-started');if(!ownership.has(id))ownership.set(id,new Map());ownership.get(id).set(p.resource,r);}if(event.method==='driver.start')workloads.set(id,'running');if(event.method==='driver.attach')readers.set(id,r);if(event.method==='driver.detach')readers.delete(id);if(event.method==='driver.release')ownership.get(id)?.delete(p.resource);
   if(event.method==='artifact.write')writes.push(r);
   if(event.method==='driver.acquire'){acquiredJobs.add(id);if(p.resource==='channel')acquiredChannels.add(id);if(!setups.has(id))error('setup-before-effect',id,'Acquisition has no durable setup intent.');if(!intents.has(r.operationId))error('intent-before-effect',id,'Acquisition lacks exact durable operation intent.');}
   if(event.method==='driver.control'&&p.target.kind!=='workload')error('workload-only-control',id,'Destructive control targeted the witness.');
   if(event.method==='consumer.consume'){
    if(!accepted.has(key(p.frame)))error('accept-before-consume',id,'Consumer effect precedes durable acceptance.');
    if(!consumeIntents.has(r.operationId))error('intent-before-consume',id,'Consumer effect lacks exact delivery intent.');
   }
   if(event.method==='driver.privateRetain'&&!accepted.has(key(p.frame)))error('accept-before-private-retain',id,'Private retention precedes durable acceptance.');
   if(event.method==='driver.publishAck'){
    if(!consumed.has(key(p.frame))||canonical(consumed.get(key(p.frame)))!==canonical(p.consumed))error('consume-before-ack',id,'ACK has no exact committed consumption receipt.');
    if(!ackIntent.has(key(p.frame)))error('intent-before-ack',id,'ACK publication has no committed intent.');
   }
   if(event.method==='driver.retireAck'){if(!accepted.has(key(p.frame))||!consumed.has(key(p.frame)))error('retire-owned-frame',id,'Retirement lacks accepted/consumed identity.');}
   if(event.method==='driver.barrier')barriers.set(id,r);
   if(event.method==='driver.detach'&& !['quiescent','output','evidence'].every(f=>factSet(id).has(f)))error('detach-predecessors',id,'Reader detached before terminal output/evidence facts.');
   if(event.method==='driver.release'){const predecessor=p.resource==='process'?'channel':'process';if(!factSet(id).has(predecessor))error('release-predecessor',id,p.resource+' released before '+predecessor+' fact.');}
  }
  if(event.type!=='audit')continue;
  const id=event.jobId;
  if(event.type==='audit'&&event.at>=broker.grant.expiresAt)error('expired-publication',id,'Durable publication exceeds lease.');
  // Audit subtype is preserved separately by the broker; never trust an asserted release by itself.
  const kind=event.auditType??event.assertionType;if(!validAudit({...event,type:kind})){error('audit-schema',id,'Required audit fields are malformed.');continue;}
  if(kind==='setup-intent')setups.set(id,event.batchId);
  if(kind==='resource-intent')intents.add(event.operationId);
  if(kind==='source-bootstrap'){
   const r=event.receipt,source=r?.payload?.source,input=sourceInputs.get(id),comparison=sourceComparisons.get(event.revision);
   if(!input||!broker.verify(r)||!['driver.attach','driver.observeSource'].includes(r.effect)||r.resourceId!==id||canonical(effects.get(r.id))!==canonical(r)||source.scopeId!==broker.scopeId||source.pendingAcks.length||event.at>=r.payload.observationDeadline||event.ownerId!==r.ownerId||event.epoch!==r.epoch||sourceAdoptions.has(id)||!comparison?.observations.some(g=>canonical(g.observation)===canonical(r)))error('source-bootstrap-proof',id,'First source adoption lacks exact current authenticated raw source guard/provenance.');
   if(input&&source)for(const stream of ['stdout','stderr']){const bytes=input.streams[stream].flat(),seq=input.streams[stream].length,t=source.streams[stream],u=t?.unavailablePrefix;if(t?.advanced.offset!==bytes.length||t?.advanced.seq!==seq||(bytes.length?u?.offset!==bytes.length||u?.seq!==seq||u?.reason!=='source-prefix-unavailable':u!==null)||t?.produced!==t.advanced.offset+t.retainedBytes+t.bufferedBytes)error('source-bootstrap-proof',id,'Source adoption differs from actual supplied source bytes and positions.');}
   if([...accepted.values()].some(f=>f.jobId===id)||[...consumed.keys()].some(k=>accepted.get(k)?.jobId===id))error('source-bootstrap-history',id,'Source loss replaces existing accepted/consumer/ACK history.');
   sourceAdoptions.set(id,r);
  }
  if(kind==='accepted'){

   const f=event.frame,k=key(f);if(accepted.has(k))error('duplicate-acceptance',id,'An exact frame was accepted twice.');
   const valid=f&&['stdout','stderr'].includes(f.stream)&&Number.isSafeInteger(f.seq)&&f.seq>=0&&Number.isSafeInteger(f.offset)&&f.offset>=0&&f.length>0&&f.length<=4096;
   if(!valid){error('frame-schema',id,'Accepted frame has invalid positions.');continue;}
   if(!event.data?.loss&&!writes.some(w=>w.payload.digest===f.digest&&w.payload.length===f.length&&broker.roots.get(w.resourceId)?.handle.owner===id))error('evidence-before-acceptance',id,'Acceptance has no matching persisted payload.');
   if(observedBytes.has(k)&&digest(observedBytes.get(k))!==f.digest)error('accepted-byte-integrity',id,'Accepted frame disagrees with actual observed bytes.');if(['privacy','diagnostic-io'].includes(event.data?.loss)&&lossPermission.get(id)!==event.data.loss)error('loss-permission',id,'Categorical loss lacks exact diagnostic refusal.');accepted.set(k,f);
  }
  if(kind==='consume-intent')consumeIntents.add(event.operationId);
  if(kind==='consumed'){if(!accepted.has(key(event.frame))||!broker.verify(event.receipt)||canonical(event.receipt.payload.frame)!==canonical(event.frame))error('consumption-proof',id,'Committed consumption lacks authenticated exact accepted frame.');consumed.set(key(event.frame),event.receipt);}
  if(kind==='ack-intent')ackIntent.add(key(event.frame));
  if(kind==='acked'){if(!broker.verify(event.receipt)||event.receipt.effect!=='driver.retireAck'||canonical(event.receipt.payload.frame)!==canonical(event.frame))error('ack-proof',id,'ACK commit lacks authenticated retirement.');acked.add(key(event.frame));}
  if(kind==='evidence-final'){
   try{validateResponse('readEvidence',{kind:'ok',value:{manifest:event.manifest,pieces:[]}});const e=event.manifest;if(!e.final||e.jobId!==id||e.manifestDigest!==jsonDigest({...e,manifestDigest:''}))error('final-manifest-integrity',id,'Final manifest identity/digest is invalid.');for(const stream of ['stdout','stderr']){const frames=[...accepted.values()].filter(f=>f.jobId===id&&f.stream===stream),total=frames.reduce((n,f)=>n+f.length,0),t=e.totals[stream];const input=sourceInputs.get(id),prefix=input?.streams[stream].flat().length??0,proof=sourceAdoptions.get(id);if(t.sourcePrefix!==prefix||t.produced!==total+prefix||t.accepted!==total+prefix||t.consumed!==total||t.acked!==total||frames.some(f=>!consumed.has(key(f))||!acked.has(key(f))))error('final-output-accounting',id,'Final manifest does not conserve actual accepted/consumed/retired bytes.');if(prefix&&(!proof||canonical(e.sourceProof)!==canonical(proof)))error('source-bootstrap-proof',id,'Final evidence lost exact adopted source proof.');const gaps=e.spans.filter(s=>s.stream===stream&&s.reason==='source-prefix-unavailable');if(prefix?gaps.length!==1||gaps[0].start!==0||gaps[0].end!==prefix:gaps.length!==0)error('source-prefix-loss',id,'Unavailable prefix loss range/reason differs from actual source.');let end=0;for(const span of e.spans.filter(s=>s.stream===stream)){if(span.start!==end)error('final-range-gap',id,'Final evidence coverage is not contiguous.');end=span.end;if(span.kind==='bytes'&&!writes.some(r=>r.resourceId===span.root.id&&r.payload.name===span.name&&r.payload.digest===span.digest&&r.payload.length===span.end-span.start))error('final-artifact-proof',id,'Final span lacks exact persisted artifact.');}if(end!==total+prefix)error('final-range-gap',id,'Final evidence omits accepted output.');}}
   catch{error('final-manifest-schema',id,'Final manifest has invalid required fields.');}
   if(finals.has(id)&&canonical(finals.get(id))!==canonical(event.manifest))error('immutable-final',id,'Final manifest changed.');finals.set(id,event.manifest);}
  if(kind==='cleanup-fact'){
   if(['channel','process','isolation'].includes(event.fact)){
    const resource=event.fact,rs=event.data.receipts,had=resource==='channel'?acquiredChannels.has(id):acquiredResources.has(id+'/'+resource);
    const expected=resource==='channel'?'driver.detach':'driver.release';
    const valid=rs.some(r=>broker.verify(r)&&r.effect===expected&&r.resourceId===id&&canonical(effects.get(r.id))===canonical(r)&&(resource==='channel'?r.payload.reader.effect==='driver.attach':r.payload.resource===resource&&r.payload.acquired.payload.resource===resource));
    if(had&&!valid||!had&&rs.length||resource==='channel'&&readers.has(id)||resource!=='channel'&&ownership.get(id)?.has(resource))error('resource-release-proof',id,resource+' fact lacks actual exact retirement.');
   }
   const acquired=acquiredJobs.has(id),raw=inventories.get(id);
   if(event.fact==='quiescent'&&acquiredResources.has(id+'/process')&&(!raw||!['not-started','exited'].includes(raw.workloadState)||!['not-started','exited'].includes(workloads.get(id))))error('quiescence-proof',id,'Quiescent fact conflicts with raw workload state.');
   if(event.fact==='output'){
    const pending=[...accepted.keys()].filter(k=>accepted.get(k).jobId===id&&!acked.has(k));if(pending.length)error('output-pending-ack',id,'Output settled with accepted frames not ACKed.');
    const barrier=barriers.get(id),channel=channels.get(id);if(acquiredChannels.has(id)&&!event.data.receipts.some(r=>r.effect==='driver.barrier'&&r.payload.terminalProduction&&r.payload.pipesClosed&&canonical(effects.get(r.id))===canonical(r)))error('terminal-barrier-receipt',id,'Output fact lacks an exact positive barrier receipt.');const hadChannel=acquiredChannels.has(id);if(hadChannel&&(!barrier?.payload.terminalProduction||!barrier?.payload.pipesClosed||!channel?.pipesDrained))error('terminal-output-proof',id,'Output fact lacks positive barrier and fully drained channel.');
   }
   if(event.fact==='evidence'&&!finals.has(id))error('evidence-final-proof',id,'Evidence fact lacks immutable final manifest.');
   factSet(id).add(event.fact);
  }
  if(kind==='released'){if(readers.has(id)||ownership.get(id)?.has('process')||ownership.get(id)?.has('isolation'))error('resource-still-owned',id,'Released publication retains actual ownership.');if(!['quiescent','output','evidence','channel','process','isolation'].every(f=>factSet(id).has(f)))error('terminal-conjunction',id,'Released assertion omits required cleanup facts.');released.add(id);}
  if(kind==='closed'&&[...setups].some(([job,batch])=>batch===event.batchId&&!released.has(job)))error('close-owned-records',null,'Close omits an owned unfinished setup/job.');
 }
 return errors;
}
