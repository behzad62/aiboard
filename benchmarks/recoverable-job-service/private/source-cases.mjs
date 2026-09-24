import definitions from '../public/source-variants.json' with {type:'json'};
import {canonical,clone,jsonDigest,LIMITS} from './broker.mjs';
import {scenarios} from './scenarios.mjs';
export const sourceVariants=definitions.map(row=>({...row,kind:'source-bootstrap',clause:row.contract,control:'source-bootstrap'}));
const shapes={zero:{stdout:[],stderr:[]},stdout:{stdout:[[11,12,13],[21,22]],stderr:[]},stderr:{stdout:[],stderr:[[7,8]]},both:{stdout:[[11,12,13],[21,22]],stderr:[[7,8]]}};
async function stage(s,shape='both',pendingAcks,custom){
 const input=s.b.sourcePrelude({streams:clone(custom??shapes[shape]??shapes.both),...(pendingAcks?{pendingAcks}:{})});s.batchId=(await s.ok('createBatch')).batchId;
 return input;
}
function identify(s,input){const state=s.b.sourceState({sourceId:input.sourceId});s.check(state.jobId!==null&&state.counts.sourceInitializations===1,'source-initialization reached exact public job');s.jobId=state.jobId;input.initial??=state;return state;}
async function launch(s,input,deadline){const result=await s.run('start',{batchId:s.batchId,workloadId:input.workloadId,...(deadline?{deadline}:{})});identify(s,input);input.startResult=result;return result;}
async function setup(s,shape='both',pendingAcks,custom,arrange){const input=await stage(s,shape,pendingAcks,custom);arrange?.(input);await launch(s,input);return input;}
async function heldSource(s,input,boundary,options={},deadline=s.b.time+1000){const hold=await s.hold(boundary,async()=>{const started=await launch(s,input,deadline);if(started.kind!=='ok')return started;return s.run('stop',{jobId:s.jobId,deadline});},{sourceId:input.sourceId,...options});identify(s,input);return hold;}
async function finishAfterRevision(s,result){if(result.kind!=='ok'){s.check(result.kind==='blocked'&&result.blockers.some(b=>b.code==='busy')||result.kind==='pending'&&typeof result.operationId==='string','obsolete source revision has published transient disposition');await s.ok('recover',{batchId:s.batchId});}s.check((await s.ok('inspectJob',{jobId:s.jobId})).state==='released','fresh source reconciliation reaches release');}
async function conserved(s,input,suffix={stdout:[],stderr:[]}){
 const view=await s.ok('inspectJob',{jobId:s.jobId});s.check(view.state==='released','source job reaches required released outcome');const e=await s.ok('readEvidence',{jobId:s.jobId}),m=e.manifest;s.check(m.version===3&&m.final,'final source EvidenceV3');
 for(const stream of ['stdout','stderr']){const B=input.initial.streams[stream].unavailablePrefix?.offset??0,n=suffix[stream].length,t=m.totals[stream];s.check(t.sourcePrefix===B&&t.produced===B+n&&t.accepted===B+n&&t.consumed===n&&t.acked===n,'source accounting '+stream+' preserves exact prefix and actual suffix');const gaps=e.pieces.filter(p=>p.span.stream===stream&&p.span.reason==='source-prefix-unavailable');s.check(B?gaps.length===1&&gaps[0].span.start===0&&gaps[0].span.end===B&&gaps[0].bytes.length===0:gaps.length===0,'exact source loss range '+stream);const pieces=e.pieces.filter(p=>p.span.stream===stream&&p.span.kind==='bytes');s.check(pieces.every(p=>canonical(p.bytes)===canonical(suffix[stream].slice(p.span.start-B,p.span.end-B))),'actual retained suffix bytes at exact span positions '+stream);}
 if(m.totals.stdout.sourcePrefix||m.totals.stderr.sourcePrefix)s.check(s.b.verify(m.sourceProof)&&m.sourceProof.resourceId===s.jobId&&m.sourceProof.payload.source.channelId===input.initial.channelId,'source proof remains authentic and channel-bound');
 const state=s.b.sourceState({sourceId:input.sourceId});s.check(state.counts.sourceInitializations===1,'one immutable source initialization');s.check(s.b.audit.filter(a=>a.type==='source-bootstrap'&&a.jobId===s.jobId).length===(m.totals.stdout.sourcePrefix||m.totals.stderr.sourcePrefix?1:0),'one positive source adoption, no zero-prefix audit');return e;
}
const owned=(s,id)=>s.b.audit.filter(a=>a.jobId===id&&['source-bootstrap','released'].includes(a.type));
async function refusal(s,codes,result){const r=result??await s.run('stop',{jobId:s.jobId});s.check(r.kind!=='ok'&&(r.kind==='stale'&&codes.includes('authority')||r.blockers?.some(b=>codes.includes(b.code))),'source refusal has exact permitted category');s.check(!owned(s,s.jobId).length,'invalid source proof publishes no bootstrap or released state');return r;}
export async function exerciseSourceVariant(s,v){
 const a=v.args,name=v.id.slice('B17/source-'.length);
 if(name.startsWith('legacy-')){await scenarios[a.kind==='evidence'?'C11':'D08'](s);const j=await s.ok('inspectJob',{jobId:s.jobId});s.check(!j.evidence||Object.values(j.evidence.totals).every(t=>t.sourcePrefix===0),'legacy compatibility never invents source-prefix history');return;}
 if(name==='changed-ack'){
  const input=await stage(s),h=await heldSource(s,input,'store.commit.before',{sourceGuardOnly:true});
  const ack=s.b.sourceAckBegin({sourceId:input.sourceId,stream:'stdout',state:'pending'});s.b.sourceAckOutcome({sourceId:input.sourceId,operationId:ack.operationId,outcome:'applied'});h.resume();await finishAfterRevision(s,await h.pending);
  s.check(s.count('driver.observeSource')>0,'changed source ACK revision forces a fresh observation');await conserved(s,input);s.check(s.b.sourceState({sourceId:input.sourceId}).counts.sourceAckEffects===1&&s.b.getJob(s.jobId).ackCount===0,'source ACK completion creates no candidate retirement');return;
 }
 if(name==='consumer-unknown'){
  const input=await stage(s);const h=await heldSource(s,input,'store.commit.after',{sourceGuardOnly:true});await s.reopen();h.resume();await h.pending.catch(()=>{});const k=s.output([8,9]);await s.ok('poll',{jobId:s.jobId});const consumerId=s.b.consumer(undefined,{unknown:true});s.b.fault('consumer.consume.after','throw',{value:false});await s.refuse('consume',{jobId:s.jobId,frame:k,consumerId});await s.refuse('stop',{jobId:s.jobId},['consumer-unknown']);const before=s.b.getJob(s.jobId).privateCount;s.check(s.b.consumers.get(consumerId).calls.length===1&&before===0,'source observation does not replay unknown delivery or privatize it');s.check((await s.ok('inspectJob',{jobId:s.jobId})).obligations.some(o=>o.resource==='consumer.consume'),'exact unknown client intent stays inspectable');return;
 }
 if(name.startsWith('pending-ack')||name.startsWith('unknown-ack')){
  const input=await setup(s,'both',[{stream:a.stream,state:a.state}]),operationId=input.initial.pendingAcks[0].operationId;
  const r=await s.run('stop',{jobId:s.jobId});s.check(a.state==='unknown'?r.kind==='unknown'&&r.operationId===operationId:(r.kind==='pending'&&r.operationId===operationId&&r.blockers.some(b=>b.code==='dependency')||r.kind==='blocked'&&r.blockers.some(b=>b.code==='dependency'&&b.operationId===operationId)),'source ACK obligation retains exact state and ID');
  await s.refuse('closeBatch',{batchId:s.batchId});s.check(s.b.getJob(s.jobId).ackCount===0,'source ACK never becomes candidate retirement');s.b.sourceAckOutcome({sourceId:input.sourceId,operationId,outcome:'applied'});await s.reopen();await s.finish();await conserved(s,input);return;
 }
 if(name.startsWith('proof-')&&a.claim!=='stale'){
  const input=await setup(s,'both',undefined,undefined,input=>s.b.fault('source-observation.claim','claim',{claim:a.claim,sourceId:input.sourceId}));await refusal(s,v.outcomes.map(o=>o.slice('blocked/'.length)),input.startResult.kind!=='ok'?input.startResult:undefined);s.check(s.b.trace.some(t=>t.type==='fault'&&t.boundary==='source-observation.claim'&&t.claim===a.claim),'listed observation claim boundary actually exercised');return;
 }
 if(name==='proof-stale'||name==='changed-output'){
  const input=await stage(s);const h=await heldSource(s,input,'store.commit.before',{sourceGuardOnly:true});s.output([31,32,33]);if(name==='proof-stale')s.b.fault('source-observation.claim','claim',{claim:'stale',observationMethod:'driver.observeSource'});h.resume();await finishAfterRevision(s,await h.pending);s.check(s.count('driver.observeSource')>0,'obsolete source observation is refreshed');if(name==='proof-stale')s.check(s.b.trace.some(t=>t.claim==='stale'),'older authenticated observation was returned');await conserved(s,input,{stdout:[31,32,33],stderr:[]});return;
 }
 if(name.startsWith('held-')||name.includes('-deadline-')||name.startsWith('takeover-')){
  const observe=a.method==='driver.observeSource'||a.phase==='observation',publication=a.phase==='publication',pending=observe?[{stream:'stdout',state:'pending'}]:undefined,input=await stage(s,'both',pending),phase=name.endsWith('-after')?'after':'before';
  const method=publication?'store.commit.before':'source-observation.'+phase,op={deadline:s.b.time+1000},h=await heldSource(s,input,method,publication?{sourceGuardOnly:true}:{observationMethod:observe?'driver.observeSource':'driver.attach'},op.deadline);
  s.check(!s.b.audit.some(t=>t.jobId===s.jobId&&t.type==='released'),'held source prerequisite has no released publication');
  if(observe){const other=await s.extra();await s.ok('poll',{jobId:other.jobId});s.check(s.b.jobs.has(other.jobId),'independent work progresses during source observation wait');s.b.sourceAckOutcome({sourceId:input.sourceId,operationId:input.initial.pendingAcks[0].operationId,outcome:'applied'});}
  if(name.startsWith('takeover-'))s.b.takeover();
  if(name.includes('-deadline-'))s.b.tick(op.deadline+(a.at==='before'?-1:a.at==='at'?0:1));h.resume();const r=await h.pending;
  if(name.startsWith('takeover-')){s.check(r.kind==='stale'||r.blockers?.some(b=>b.code==='authority'),'old source operation cannot publish after takeover');await s.reopen();await s.finish();}
  else if(a.at==='at'||a.at==='after'){s.check(r.kind!=='ok'&&r.blockers?.some(b=>b.code==='deadline'),'original source request does not succeed at/after deadline');await s.reopen();await s.finish();}
  else if(r.kind!=='ok'){s.check(observe&&phase==='after'&&r.blockers?.some(b=>b.code==='dependency'),'held historical pending observation remains a dependency');await s.finish();}
  await conserved(s,input);return;
 }
 if(name.startsWith('observation-effects-')){
  const input=await stage(s,a.shape),h=await heldSource(s,input,'source-observation.after',{observationMethod:'driver.attach'}),j=s.b.getJob(s.jobId),before=s.b.sourceState({sourceId:input.sourceId}).counts;
  for(let n=0;n<2;n++){const r=await s.b.call('driver.observeSource',{jobId:s.jobId,reader:clone(j.reader),operationId:s.b.id(),fence:{grant:s.b.grant,deadline:s.b.time+1000}});s.check(r.kind==='applied'&&s.b.verify(r.value),'adapter repeat source-only snapshot authentic');}
  s.check(canonical(s.b.sourceState({sourceId:input.sourceId}).counts)===canonical(before),'provided source-only adapter performs zero read/client/private/ACK effects');h.resume();s.check((await h.pending).kind==='ok','candidate lifecycle continues after pure observation');await conserved(s,input);return;
 }
 if(name.startsWith('lost-receipt-')||name.startsWith('observation-response-')){
  const observe=name.startsWith('observation-response-'),input=await stage(s,'both',observe?[{stream:'stdout',state:'pending'}]:undefined);
  if(observe){s.b.fault('source-observation.before','hook',{observationMethod:'driver.observeSource',fn:b=>b.sourceAckOutcome({sourceId:input.sourceId,operationId:b.sourceState({sourceId:input.sourceId}).pendingAcks[0].operationId,outcome:'applied'})});}
  s.b.fault(observe?'driver.observeSource.after':'driver.attach.after','unknown',{receiptVisibility:a.receiptVisibility,sourceId:input.sourceId});const started=await launch(s,input);const r=started.kind==='ok'?await s.run('stop',{jobId:s.jobId}):started;s.check(r.kind==='unknown','lost source response retains unknown operation');const count=s.count('driver.attach');await s.reopen();
  if(a.receiptVisibility==='unknown'){const again=await s.run('stop',{jobId:s.jobId});if(observe&&again.kind==='ok'){const e=await conserved(s,input);s.check(e.manifest.sourceProof.operationId!==r.operationId,'new explicit observation cannot reuse unavailable old proof');}else s.check(again.kind==='unknown'&&(!observe?again.operationId===r.operationId:true),'unavailable receipt never invents a known observation');s.check(s.count('driver.attach')===count,'unknown attachment is never duplicated');}
  else{await s.finish();await conserved(s,input);s.check(s.count('driver.attach')===1,'available lost response reconciles one installed reader');}return;
 }
 if(name==='fresh-restart'||name==='consumer-unknown'){
  const input=await stage(s),h=await heldSource(s,input,'store.commit.after',{sourceGuardOnly:true});const proof=clone(s.b.audit.find(e=>e.type==='source-bootstrap').receipt);await s.reopen();s.output([31,32,33]);h.resume();await h.pending.catch(()=>{});await s.finish();const e=await conserved(s,input,{stdout:[31,32,33],stderr:[]});s.check(canonical(proof)===canonical(e.manifest.sourceProof),'fresh guest preserves original source proof bytes');return;
 }
 if(name==='capacity'){
  const prefix={stdout:[Array(4096).fill(11),Array(4096).fill(21)],stderr:[]},input=await setup(s,'both',undefined,prefix),suffix=Array.from({length:253952},(_,i)=>i%251);s.output(suffix);await s.finish();const e=await conserved(s,input,{stdout:suffix,stderr:[]}),c=await s.ok('exportCapsule',{jobId:s.jobId});s.check(Buffer.byteLength(JSON.stringify(c))<=LIMITS.message,'full-size source capsule fits unchanged bridge');s.check(e.pieces.reduce((n,p)=>n+p.bytes.length,0)<=LIMITS.payload,'full-size source evidence keeps original payload budget');return;
 }
 const input=await setup(s,a.shape??'both');
 if(name==='tail') {s.output([31,32,33]);s.output([41],'stderr');}
 if(name==='partial-cleanup')s.b.fault('driver.detach.before','not-applied',{code:'backend'});
 if(name==='partial-cleanup'){await s.refuse('stop',{jobId:s.jobId});const before=await s.ok('readEvidence',{jobId:s.jobId});s.check(before.manifest.final&&before.manifest.sourceProof,'failed detach preserves complete source evidence');await s.reopen();await s.finish();s.check(canonical(before.manifest)===canonical((await s.ok('readEvidence',{jobId:s.jobId})).manifest),'partial cleanup never rewrites final evidence');}
 else await s.finish();
 const evidence=await conserved(s,input,name==='tail'?{stdout:[31,32,33],stderr:[41]}:undefined);
 if(name==='replay'){const request={batchId:s.batchId,requestId:s.b.id(),deadline:s.b.time+1000};const first=await s.run('recover',request);await s.reopen();s.check(canonical(await s.run('recover',request))===canonical(first),'source recovery request replays exact durable result');await s.ok('restore',{capsule:await s.ok('exportCapsule',{jobId:s.jobId})});s.check(canonical(evidence.manifest)===canonical((await s.ok('readEvidence',{jobId:s.jobId})).manifest),'source replay conserves immutable final manifest');}
 if(name==='missing-old'||name.startsWith('format-')){
  const c=await s.ok('exportCapsule',{jobId:s.jobId}),change=a.change;
  if(name==='missing-old'){c.checkpoint=null;c.checkpointEverCreated=true;}
  else if(change==='allowed-extension')c.extensions.example={harmless:true};
  else if(change==='top-extra')c.extra=true;
  else if(change==='receipt-extra')c.evidence.sourceProof.extra=true;
  else if(change==='source-prefix-total')c.evidence.totals.stdout.sourcePrefix++;
  else if(change==='source-proof-missing')c.evidence.sourceProof=null;
  else if(change==='source-proof-range')c.evidence.sourceProof.payload.source.streams.stdout.unavailablePrefix.offset++;
  else if(change==='source-proof-pending')c.evidence.sourceProof.payload.source.pendingAcks.push({operationId:s.b.id(),stream:'stdout',through:{seq:2,offset:5},state:'pending'});
  else if(change==='retired-baseline')c.checkpoint.retiredThrough.stdout.seq++;
  else if(change==='double-prefix')c.evidence.spans.push(clone(c.evidence.spans[0]));
  else if(change==='format2')c.format=2;
  if(c.evidence){c.evidence.manifestDigest=jsonDigest({...c.evidence,manifestDigest:''});if(c.checkpoint?.finalManifest)c.checkpoint.finalManifest=clone(c.evidence);}
  c.seal=await s.b.call('capsule.seal',{capsule:c});if(['valid','allowed-extension'].includes(change)){await s.ok('restore',{capsule:c});s.check(canonical(evidence.manifest)===canonical((await s.ok('readEvidence',{jobId:s.jobId})).manifest),'valid Capsule3 source proof round trip');}else await s.refuse('restore',{capsule:c},name==='missing-old'?['missing-checkpoint']:change==='format2'?['unsupported']:['integrity','gap']);
 }
}
