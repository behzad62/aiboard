/** Wire validation only: no lifecycle or evidence decisions. */
export const obj=x=>x!==null&&typeof x==='object'&&!Array.isArray(x), id=x=>typeof x==='string'&&/^[a-f0-9]{32}$/.test(x), nat=x=>Number.isSafeInteger(x)&&x>=0, hex=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export const closed=(x,keys)=>obj(x)&&Object.keys(x).length===keys.length&&keys.every(k=>Object.hasOwn(x,k));
export const binding=x=>obj(x)&&id(x.id)&&id(x.birth)&&['agent','workload','witness'].includes(x.kind)&&hex(x.token);
export const root=x=>obj(x)&&id(x.id)&&id(x.birth)&&id(x.owner)&&typeof x.path==='string'&&typeof x.retained==='boolean'&&hex(x.token);
export const frame=x=>closed(x,['jobId','channelId','stream','seq','offset','length','digest','artifactId'])&&id(x.jobId)&&id(x.channelId)&&['stdout','stderr'].includes(x.stream)&&nat(x.seq)&&nat(x.offset)&&nat(x.length)&&x.length>0&&x.length<=4096&&hex(x.digest)&&id(x.artifactId);
export const facts=['quiescent','output','evidence','channel','process','isolation'];
export function receipt(x,depth=0){if(depth>8||!closed(x,['id','operationId','effect','resourceId','ownerId','epoch','appliedAt','payload','token'])||![x.id,x.operationId,x.resourceId,x.ownerId].every(id)||!nat(x.epoch)||!nat(x.appliedAt)||!hex(x.token))return false;const p=x.payload,c=(keys)=>closed(p,keys),r=y=>receipt(y,depth+1);switch(x.effect){
case 'store.commit':return c(['revision'])&&nat(p.revision);
case 'artifact.create':return c(['root'])&&root(p.root);
case 'artifact.write':return c(['name','digest','length'])&&typeof p.name==='string'&&hex(p.digest)&&nat(p.length);
case 'artifact.remove':return c(['absent'])&&p.absent===true;
case 'driver.acquire':return p?.resource==='process'?c(['resource','workload','witness'])&&binding(p.workload)&&binding(p.witness):['isolation','channel','workload'].includes(p?.resource)&&c(['resource',{isolation:'allocationId',channel:'channelId',workload:'workloadId'}[p.resource]])&&id(p[{isolation:'allocationId',channel:'channelId',workload:'workloadId'}[p.resource]]);
case 'driver.start':return c(['workload','witness','workloadId'])&&binding(p.workload)&&binding(p.witness)&&id(p.workloadId);
case 'driver.attach':case 'driver.observeSource':return attachedSource(p);
case 'source.ack':return c(['channelId','stream','through'])&&id(p.channelId)&&['stdout','stderr'].includes(p.stream)&&cursor(p.through);
case 'driver.privateRetain':return c(['frame','deliveryId'])&&frame(p.frame)&&id(p.deliveryId);
case 'consumer.consume':return c(['frame','deliveryId','consumerId'])&&frame(p.frame)&&id(p.deliveryId)&&id(p.consumerId);
case 'driver.publishAck':return c(['frame','consumed'])&&frame(p.frame)&&r(p.consumed);
case 'driver.retireAck':return c(['frame','ack'])&&frame(p.frame)&&r(p.ack);
case 'driver.barrier':return c(['terminalProduction','pipesClosed'])&&typeof p.terminalProduction==='boolean'&&typeof p.pipesClosed==='boolean';
case 'driver.publishRelease':case 'driver.releaseConsumed':return c(['requestId','ownerId','epoch','witness'])&&id(p.requestId)&&id(p.ownerId)&&nat(p.epoch)&&binding(p.witness);
case 'driver.replaceRelease':return c(['expectedRequestId','nextRequestId'])&&id(p.expectedRequestId)&&(p.nextRequestId===null||id(p.nextRequestId));
case 'driver.control':return c(['target','signal'])&&binding(p.target)&&['graceful','force'].includes(p.signal);
case 'driver.detach':return c(['reader'])&&r(p.reader);
case 'driver.release':return c(['resource','acquired'])&&['process','isolation'].includes(p.resource)&&r(p.acquired);
case 'claims.cas':return c(['name'])&&typeof p.name==='string';
case 'legacy.terminal':return c(['numericId','terminal'])&&nat(p.numericId)&&p.terminal===true;
default:return false;}}
export function audit(a){if(!obj(a))return false;const j=id(a.jobId);switch(a.type){case 'setup-intent':return j&&id(a.batchId)&&id(a.data?.setupId);case 'resource-intent':return j&&id(a.operationId)&&typeof a.data?.resource==='string';case 'effect-result':return j&&id(a.operationId)&&(a.receipt===undefined||receipt(a.receipt));case 'source-bootstrap':return j&&receipt(a.receipt)&&nat(a.data?.evidenceRevision);case 'checkpoint-created':return j&&id(a.data?.generation);case 'accepted':return j&&frame(a.frame)&&nat(a.data?.evidenceRevision);case 'consume-intent':return j&&frame(a.frame)&&id(a.operationId);case 'consumed':case 'ack-intent':case 'acked':return j&&frame(a.frame)&&receipt(a.receipt);case 'cleanup-fact':return j&&facts.includes(a.fact)&&Array.isArray(a.data?.receipts)&&a.data.receipts.every(r=>receipt(r));case 'evidence-final':case 'terminal-transfer':return j&&obj(a.manifest);case 'released':return j;case 'closed':return id(a.batchId);case 'handoff':return j&&(id(a.data?.setupId)||id(a.data?.successorJobId));default:return false;}}

export const cursor=x=>closed(x,['seq','offset'])&&nat(x.seq)&&nat(x.offset);
export function sourceObservation(x){return closed(x,['version','scopeId','channelId','attachmentOperationId','sourceRevision','streams','pendingAcks'])&&x.version===1&&[x.scopeId,x.channelId,x.attachmentOperationId].every(id)&&nat(x.sourceRevision)&&closed(x.streams,['stdout','stderr'])&&['stdout','stderr'].every(s=>{const t=x.streams[s];return closed(t,['advanced','produced','retainedBytes','bufferedBytes','unavailablePrefix'])&&cursor(t.advanced)&&[t.produced,t.retainedBytes,t.bufferedBytes].every(nat)&&(t.unavailablePrefix===null||closed(t.unavailablePrefix,['seq','offset','reason'])&&nat(t.unavailablePrefix.seq)&&nat(t.unavailablePrefix.offset)&&t.unavailablePrefix.reason==='source-prefix-unavailable');})&&Array.isArray(x.pendingAcks)&&x.pendingAcks.every(a=>closed(a,['operationId','stream','through','state'])&&id(a.operationId)&&['stdout','stderr'].includes(a.stream)&&cursor(a.through)&&['pending','unknown'].includes(a.state));}
export const attachedSource=x=>closed(x,['privateReader','observationDeadline','source'])&&typeof x.privateReader==='boolean'&&nat(x.observationDeadline)&&sourceObservation(x.source);
