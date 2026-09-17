import {clone,canonical,HarnessError} from './broker.mjs';
import * as wire from './wire-schema.mjs';
const streams=['stdout','stderr'];
export function sourcePrelude(b,a){
 if(!wire.obj(a)||Object.keys(a).some(k=>!['streams','pendingAcks'].includes(k))||!wire.closed(a.streams,streams)||!streams.every(s=>Array.isArray(a.streams[s])&&a.streams[s].every(f=>Array.isArray(f)&&f.length>=1&&f.length<=4096&&f.every(n=>Number.isInteger(n)&&n>=0&&n<=255))))throw new HarnessError('Invalid sourcePrelude streams');
 const frames=streams.flatMap(s=>a.streams[s]),bytes=frames.reduce((n,f)=>n+f.length,0),pending=a.pendingAcks??[];
 if(frames.length>128||bytes>262144||!Array.isArray(pending)||pending.length>2||new Set(pending.map(x=>x.stream)).size!==pending.length||pending.some(x=>!wire.closed(x,['stream','state'])||!streams.includes(x.stream)||!['pending','unknown'].includes(x.state)||!a.streams[x.stream].length))throw new HarnessError('Invalid sourcePrelude joint bounds/pending ACKs');
 const sourceId=b.id(),workloadId=b.id();b.sources??=new Map();b.sources.set(sourceId,{sourceId,workloadId,streams:clone(a.streams),pending:clone(pending),jobId:null,initialized:0,ackFences:new Map()});b.entropy.record({type:'sourcePrelude',sourceId,workloadId,args:clone(a)});return {sourceId,workloadId};
}
export function initializeSource(b,j,workloadId,fence){
 const source=[...(b.sources?.values()??[])].find(s=>s.workloadId===workloadId);if(!source)return;
 if(source.initialized){if(source.jobId!==j.id)throw new HarnessError('Source workload initialized under multiple jobs');return;}
 if(j.queue.length||j.buffer.length||j.producer.length||j.offset.stdout||j.offset.stderr)throw new HarnessError('Source initialization after ordinary output');
 const frameCount=streams.reduce((n,s)=>n+source.streams[s].length,0),bytes=streams.reduce((n,s)=>n+source.streams[s].flat().length,0);
 if(b.frameCount+frameCount>512||b.outputBytes+bytes>8388608)throw new HarnessError('Source initialization exceeds case bounds');
 b.frameCount+=frameCount;b.outputBytes+=bytes;source.initialized++;source.jobId=j.id;j.sourceId=source.sourceId;j.sourcePrefix={};j.sourceAdvanced={};j.sourcePending=[];
 for(const stream of streams){const seq=source.streams[stream].length,offset=source.streams[stream].flat().length;j.next[stream]=seq;j.offset[stream]=offset;j.pipes[stream].produced=offset;j.sourcePrefix[stream]=offset?{seq,offset,reason:'source-prefix-unavailable'}:null;j.sourceAdvanced[stream]={seq,offset};}
 b.entropy.run('fixture',()=>{for(const pending of source.pending){const operationId=b.id();j.sourcePending.push({operationId,stream:pending.stream,through:clone(j.sourceAdvanced[pending.stream]),state:pending.state});source.ackFences.set(operationId,clone(fence));b.receipts.set(operationId,pending.state==='unknown'?'unknown':'unknown');}});
 syncSource(b,j);b.trace.push({type:'source-initialization',jobId:j.id,sourceId:source.sourceId,workloadId,sourceRevision:j.sourceRevision,streams:clone(source.streams),at:b.time});b.entropy.record({type:'source-initialization',sourceId:source.sourceId,workloadId,jobId:j.id,channelId:j.resources.channel.payload.channelId,streams:clone(source.streams),pending:clone(j.sourcePending)});
}
export function syncSource(b,j){
 const facts={streams:{},pendingAcks:clone(j.sourcePending??[])};
 for(const stream of streams)facts.streams[stream]={advanced:clone(j.sourceAdvanced?.[stream]??{seq:0,offset:0}),produced:j.pipes[stream].produced,retainedBytes:b.physicalBytes(j.queue,stream),bufferedBytes:b.physicalBytes(j.buffer,stream),unavailablePrefix:clone(j.sourcePrefix?.[stream]??null)};
  let retained=0,buffered=0,produced=0,advancedFrames=0;
 for(const stream of streams){const t=facts.streams[stream],p=t.unavailablePrefix,a=t.advanced;if(!wire.nat(a.seq)||!wire.nat(a.offset)||(a.seq===0)!==(a.offset===0)||a.seq>a.offset||a.offset>4096*a.seq||!['produced','retainedBytes','bufferedBytes'].every(k=>wire.nat(t[k]))||t.produced!==a.offset+t.retainedBytes+t.bufferedBytes)throw new HarnessError('Trusted source arithmetic guarantee violated');const initial=b.sources?.get(j.sourceId)?.streams[stream]??[],expected=initial.length?{seq:initial.length,offset:initial.flat().length,reason:'source-prefix-unavailable'}:null;if(canonical(p)!==canonical(expected)||p&&(p.seq>a.seq||p.offset>a.offset))throw new HarnessError('Trusted immutable source prefix guarantee violated');retained+=t.retainedBytes;buffered+=t.bufferedBytes;produced+=t.produced;advancedFrames+=a.seq;}
 if(retained>8192||buffered>4096||produced>262144||advancedFrames>128)throw new HarnessError('Trusted source joint bounds violated');
 const signature=canonical(facts);if(signature!==j.sourceSignature){j.sourceRevision=(j.sourceRevision??-1)+1;j.sourceSignature=signature;}return facts;
}
export function sourcePayload(b,j,args,reader){const facts=syncSource(b,j);return {privateReader:reader?reader.payload.privateReader:args.privateReader===true,observationDeadline:args.fence.deadline,source:{version:1,scopeId:b.scopeId,channelId:j.resources.channel.payload.channelId,attachmentOperationId:reader?reader.operationId:args.operationId,sourceRevision:j.sourceRevision,...facts}};}
export function sourceState(b,{sourceId}){
 const source=b.sources?.get(sourceId);if(!source)throw new HarnessError('Unknown fixture source');const j=source.jobId?b.getJob(source.jobId):null,facts=j?syncSource(b,j):null,trace=b.trace.filter(t=>(t.args?.jobId??t.receipt?.resourceId??t.jobId)===source.jobId),effects=method=>trace.filter(t=>t.type==='effect'&&t.method===method).length;
 return clone({workloadId:source.workloadId,jobId:source.jobId,channelId:j?.resources.channel?.payload.channelId??null,sourceRevision:j?.sourceRevision??null,streams:facts?.streams??null,pendingAcks:facts?.pendingAcks??[],counts:{sourceInitializations:source.initialized,outputReads:trace.filter(t=>t.type==='boundary'&&t.method==='driver.readChannel.before').length,clientConsumes:effects('consumer.consume'),privateRetains:effects('driver.privateRetain'),ackPublications:effects('driver.publishAck'),ackRetirements:effects('driver.retireAck'),sourceAckEffects:effects('source.ack'),attachments:effects('driver.attach')}});
}
export function sourceAckOutcome(b,a){
 if(!wire.closed(a,['sourceId','operationId','outcome'])||a.outcome!=='applied')throw new HarnessError('Invalid sourceAckOutcome');const source=b.sources?.get(a.sourceId);if(!source?.jobId)throw new HarnessError('Unknown initialized source');const j=b.getJob(source.jobId),index=j.sourcePending.findIndex(x=>x.operationId===a.operationId);
 if(index<0){const r=b.receipts.get(a.operationId);if(r?.effect==='source.ack'&&r.resourceId===j.id)return {receipt:clone(r)};throw new HarnessError('Unknown source ACK operation');}
 const pending=j.sourcePending.splice(index,1)[0],receipt=b.entropy.run('fixture',()=>b.receipt('source.ack',j.id,pending.operationId,{channelId:j.resources.channel.payload.channelId,stream:pending.stream,through:pending.through},source.ackFences.get(pending.operationId)));syncSource(b,j);b.entropy.record({type:'sourceAckOutcome',args:clone(a),receipt:clone(receipt)});return {receipt};
}
export function sourceAckBegin(b,a){
 if(!wire.closed(a,['sourceId','stream','state'])||!streams.includes(a.stream)||!['pending','unknown'].includes(a.state))throw new HarnessError('Invalid sourceAckBegin');
 const source=b.sources?.get(a.sourceId);if(!source?.jobId)throw new HarnessError('Source ACK requires initialized source');const j=b.getJob(source.jobId);
 if(!j.resources.channel||j.channelReleased)throw new HarnessError('Source ACK requires owned unreleased channel');
 if(!j.sourcePrefix?.[a.stream])throw new HarnessError('Source ACK requires positive immutable prefix');
 source.ackIssued??=new Set(source.pending.map(x=>x.stream));if(source.ackIssued.has(a.stream))throw new HarnessError('Source ACK permitted once per stream');source.ackIssued.add(a.stream);
 const operationId=b.entropy.run('fixture',()=>b.id());j.sourcePending.push({operationId,stream:a.stream,through:{seq:j.sourcePrefix[a.stream].seq,offset:j.sourcePrefix[a.stream].offset},state:a.state});source.ackFences.set(operationId,{grant:clone(b.grant),deadline:b.time+1000});b.receipts.set(operationId,'unknown');syncSource(b,j);b.entropy.record({type:'sourceAckBegin',args:clone(a),operationId});return {operationId};
}
export function sourceGuards(b,guards,fence){
 if(guards===undefined)return null;if(!Array.isArray(guards))return {kind:'not-applied',code:'input'};const seen=new Set();
 for(const guard of guards){const r=guard?.observation,p=r?.payload,s=p?.source;if(!wire.closed(guard,['observation'])||!b.verify(r)||!['driver.attach','driver.observeSource'].includes(r.effect)||!wire.obj(s))return {kind:'not-applied',code:'integrity'};
  if(seen.has(s.channelId))return {kind:'not-applied',code:'input'};seen.add(s.channelId);
 }
 for(const {observation:r} of guards){const p=r.payload,s=p.source,j=b.jobs.get(r.resourceId);
  if(s.scopeId!==b.scopeId||r.ownerId!==fence.grant.ownerId||r.epoch!==fence.grant.epoch)return {kind:'stale'};
  if(!wire.nat(r.appliedAt)||!wire.nat(p.observationDeadline)||r.appliedAt>=p.observationDeadline||b.time>=p.observationDeadline)return {kind:'not-applied',code:'deadline'};
  if(!j||!j.reader||j.reader.operationId!==s.attachmentOperationId||j.resources.channel?.payload.channelId!==s.channelId)return {kind:'not-applied',code:'identity'};
  syncSource(b,j);if(j.sourceRevision!==s.sourceRevision)return {kind:'not-applied',code:'busy'};
 }return null;
}
export function sourceClaim(b,j,args,value){const result=claimResponse(b,j,args,value);b.entropy.record({type:'source-observation',method:args.observationMethod,receipt:clone(result.value)});return result;}
function claimResponse(b,j,args,value){
 const previous=j.lastSourceObservation; j.lastSourceObservation=clone(value.value);
 for(const f of b.faults){if(f.done||f.boundary!=='source-observation.claim'||f.action!=='claim'||f.jobId&&f.jobId!==j.id||f.sourceId&&f.sourceId!==j.sourceId||f.observationMethod&&f.observationMethod!==args.observationMethod)continue;if(++f.seen!==f.occurrence)continue;f.done=true;
  b.trace.push({type:'fault',boundary:f.boundary,action:'claim',claim:f.claim,jobId:j.id,args:clone(args),at:b.time});if(f.claim==='missing')return {kind:'applied',value:null};const r=clone(value.value),s=r.payload.source,t=s.streams.stdout;
  switch(f.claim){case 'invalid-token':r.token='0'.repeat(64);return {kind:'applied',value:r};case 'foreign-job':r.resourceId=b.entropy.run('fixture',()=>b.id());break;case 'foreign-channel':s.channelId=b.entropy.run('fixture',()=>b.id());break;case 'foreign-reader':s.attachmentOperationId=b.entropy.run('fixture',()=>b.id());break;case 'foreign-scope':s.scopeId=b.entropy.run('fixture',()=>b.id());break;case 'foreign-owner':r.ownerId=b.entropy.run('fixture',()=>b.id());break;case 'future-epoch':r.epoch++;break;case 'negative':t.advanced.offset=-1;break;case 'fractional':t.advanced.offset=.5;break;case 'unsafe':t.advanced.offset=9007199254740992;break;case 'impossible':t.advanced.seq=t.advanced.offset+1;break;case 'false-zero':t.advanced={seq:0,offset:0};break;case 'cross-stream':[t.unavailablePrefix,s.streams.stderr.unavailablePrefix]=[s.streams.stderr.unavailablePrefix,t.unavailablePrefix];break;case 'future-time':r.appliedAt=b.time+1;break;case 'at-proof-deadline':r.appliedAt=r.payload.observationDeadline;break;case 'expired':r.payload.observationDeadline=r.appliedAt;break;case 'stale':if(!previous||previous.payload.source.sourceRevision===s.sourceRevision)throw new HarnessError('Stale claim prerequisite absent');return {kind:'applied',value:previous};case 'missing-prefix':t.unavailablePrefix=null;break;case 'wrong-range':if(!t.unavailablePrefix)throw new HarnessError('Range claim prerequisite absent');t.unavailablePrefix.offset++;break;case 'legacy-reason':if(!t.unavailablePrefix)throw new HarnessError('Reason claim prerequisite absent');t.unavailablePrefix.reason='legacy-gap';break;case 'production':t.produced++;break;case 'window':t.retainedBytes++;break;default:throw new HarnessError('Unknown disclosed source claim');}
  delete r.token;r.token=b.token(r,'receipt');return {kind:'applied',value:r};
 }return value;
}
