import {createHash} from 'node:crypto';
import {controls as materialControls} from '../controls.mjs';

export const referenceSha256='6a5b142037c60fb9ab480ccd64f307f556685be755878df0aa1ec39d3ceb1cf0';
export const controlDefinitions=Object.freeze([
 {id:'representation',label:'Reference-derived representation calibration control',choices:['different private key namespaces','opaque stored record envelopes','different physical retained/scratch root layout','different actual artifact names represented in public evidence']},
 {id:'algorithm',label:'Reference-derived algorithm calibration control',choices:['atomic durable intent/issuance marker with receipt-based nonapplication reconciliation','maintained paged ownership index and coherent head-version reads','setup reader and eager lawful source-prefix adoption','deterministic descending-ID reclamation order']},
 {id:'truthful-outcome',label:'Reference-derived truthful-outcome calibration control',choices:['integrity at actual range-validation branches','deadline-first admission only when the actual request is expired','pending source ACK with its stored exact obligation','unknown client delivery with its durable exact ID','truthful aggregate recovery views when every remaining job has an unresolved source/client obligation']},
]);
const hash=s=>createHash('sha256').update(s).digest('hex');
function once(source,old,next){if(source.split(old).length!==2)throw Error('calibration seam must occur exactly once: '+old.slice(0,100));return source.replace(old,next);}

const representationPorts=String.raw`
// Calibration representation: public root handles and evidence names stay actual.
{
 const originalFactory=globalThis.createService;
 globalThis.createService=async function(storage,grant){
  const names={job:'records/task',effect:'records/effect',frame:'records/output',request:'records/request',batch:'records/batch',start:'records/start',adopted:'records/scratch',failure:'records/failure',service:'records/service'};
  const keyOut=key=>{const at=key.indexOf('/'),first=at<0?key:key.slice(0,at);return (names[first]??'records/'+first)+(at<0?'':key.slice(at));};
  const keyIn=key=>{for(const [from,to] of Object.entries(names))if(key===to||key.startsWith(to+'/'))return from+key.slice(to.length);return key.slice('records/'.length);};
  const decode=row=>({...row,...(row.key===undefined?{}:{key:keyIn(row.key)}),value:row.value===null?null:row.value.record});
  const ports={call:async(method,args={})=>{
   if(method==='store.commit')return storage.call(method,{...args,writes:args.writes.map(w=>({...w,key:keyOut(w.key),value:w.value===null?null:{record:w.value}}))});
   if(method==='store.read')return decode(await storage.call(method,{...args,key:keyOut(args.key)}));
   if(method==='store.scan'){const result=await storage.call(method,{...args,prefix:keyOut(args.prefix)});return {...result,rows:result.rows.map(decode)};}
   if(method==='artifact.create')return storage.call(method,{...args,path:'layout/'+args.path});
   return storage.call(method,args);
  }};
  return originalFactory(ports,grant);
 };
}
`;

const indexedPorts=String.raw`
// A private maintained index is published in the SAME atomic job transaction.
// Raw store.scan and its 64-row immutable snapshot protocol are untouched.
{
 const originalFactory=globalThis.createService;
 globalThis.createService=async function(storage,grant){
  const pending=new Map();
  const ports={call:async(method,args={})=>{
   if(method!=='store.commit'||!args.writes.some(w=>w.key.startsWith('job/')))return storage.call(method,args);
   let transaction=pending.get(args.operationId);
   if(!transaction){
    const old=await storage.call('store.read',{key:'membership/head'});
    const head=old.value===null?{count:0,batches:{},running:[]}:JSON.parse(JSON.stringify(old.value));
    const pages=new Map(),extra=[];
    for(const w of args.writes.filter(w=>w.key.startsWith('job/'))){
     const id=w.key.slice(4),j=w.value;
     if(w.expected===0&&j!==null){
      const page=Math.floor(head.count/64),key='membership/page/'+page;
      if(!pages.has(key)){const prior=await storage.call('store.read',{key});pages.set(key,{key,expected:prior.revision,value:prior.value===null?[]:[...prior.value]});}
      pages.get(key).value.push(id);head.count++;head.batches[j.batchId]=(head.batches[j.batchId]??0)+1;
     }
     head.running=head.running.filter(x=>x!==id);if(j?.state==='running')head.running.push(id);
    }
    extra.push(...pages.values(),{key:'membership/head',expected:old.revision,value:head});
    transaction={...args,writes:[...args.writes,...extra]};pending.set(args.operationId,transaction);
   }
   try{const result=await storage.call(method,transaction);if(result.kind!=='busy')pending.delete(args.operationId);return result;}
   catch(error){pending.delete(args.operationId);throw error;}
  }};
  return originalFactory(ports,grant);
 };
}
`;

const indexedReaders=String.raw`
 const ownedCapacity=async batchId=>{const h=(await read('membership/head')).value;return {batch:h?.batches[batchId]??0,running:h?.running.length??0};};
 const indexedJobs=async()=>{
  for(let attempt=0;attempt<8;attempt++){
   const head=await read('membership/head');if(head.value===null)return [];
   const rows=[];
   for(let page=0;page<Math.ceil(head.value.count/64);page++){
    const ids=(await read('membership/page/'+page)).value;if(!Array.isArray(ids))fail('integrity');
    for(const id of ids){const row=await read('job/'+id);if(row.value!==null)rows.push({key:'job/'+id,...row});}
   }
   if((await read('membership/head')).revision===head.revision)return rows;
  }
  fail('busy');
 };
`;

function representation(source){
 // The fault generator runs before this transformation, so an omitted payload
 // write remains omitted. Every surviving write and span uses the actual name.
 const occurrences=source.split('name:k.artifactId').length-1;
 if(occurrences<1||occurrences>2)throw Error('unexpected representation artifact seams');
 return source.replaceAll('name:k.artifactId',"name:'chunk-'+k.artifactId")+representationPorts;
}
function algorithm(source,{materialSelector}={}){
 source=once(source," const all=async prefix=>{",indexedReaders+" const all=async prefix=>{if(prefix==='job/')return indexedJobs();");
 source=once(source,"const jobs=await all('job/');if(jobs.filter(r=>r.value.batchId===req.batchId).length>=1100||jobs.filter(r=>r.value.state==='running').length>=16)fail('capacity');","const capacity=await ownedCapacity(req.batchId);if(capacity.batch>=1100||capacity.running>=16)fail('capacity');");
 source=once(source,"r={operationId:await call('newId'),state:'intent',method,deadline:op.deadline,args}","r={operationId:await call('newId'),state:'issued',method,deadline:op.deadline,args}");
 source=once(source,"   await update(key,old=>({...old,state:'issued'}),[],op);","   if(r.state==='intent')await update(key,old=>({...old,state:'issued'}),[],op);");
 source=once(source,"const setupEffects=await all('effect/'+id+'/');",`const setupEffects=await all('effect/'+id+'/');
  // An atomically staged marker is not proof that an acquisition occurred.
  for(const row of setupEffects)if(row.value.method==='driver.acquire'&&['issued','unknown'].includes(row.value.state)&&!j.acquired[row.value.args.resource]){
   const resolved=await call('driver.receipt',{operationId:row.value.operationId});
   if(resolved==='not-applied'){await update(row.key,old=>({...old,state:'intent'}),[],op);row.value={...row.value,state:'intent'};}
  }
 `);
 source=once(source,"await update(jk(j.jobId),old=>({...old,state:'running'})","const setupReader=await effect(j,'reader','driver.attach',{privateReader:true},req);await ensureSource(j,setupReader,req);await update(jk(j.jobId),old=>({...old,state:'running'})");
 source=once(source,".values()],removed=[];for(let i=0;i<roots.length;i++)",".values()].sort((a,b)=>b.id.localeCompare(a.id)),removed=[];for(let i=0;i<roots.length;i++)");
 if(materialSelector==='truncate-scan')source=once(source,'page<Math.ceil(head.value.count/64)','page<Math.min(1,Math.ceil(head.value.count/64))');
 return source+indexedPorts;
}
function truthful(source){
 // Choose integrity at the original concrete continuity validators. This does
 // not replace an arbitrary returned category or obscure the supporting facts.
 source=source.replaceAll("fail('gap'","fail('integrity'");
 source=once(source,"const guard=async op=>{const a=await call('authority',{grant});","const guard=async op=>{const entryTime=await call('now');if(op&&safe(op.deadline)&&ids.test(op.requestId)&&entryTime>=op.deadline)fail('deadline');const a=await call('authority',{grant});");
 source=once(source,";fail('dependency',{jobId:j.jobId,operationId:a.operationId});",";throw {rjs:true,result:{kind:'pending',operationId:a.operationId,blockers:[{code:'dependency',jobId:j.jobId,operationId:a.operationId}]}};");
 source=once(source,"if(prior==='unknown')fail('consumer-unknown',{jobId:req.jobId,operationId:f.deliveryId});","if(prior==='unknown')throw {rjs:true,result:{kind:'unknown',operationId:f.deliveryId,blockers:[{code:'consumer-unknown',jobId:req.jobId,operationId:f.deliveryId}]}};");
 source=once(source,"if(q==='unknown'||q==='not-applied')fail('consumer-unknown',{jobId:j.jobId,operationId:f.deliveryId});","if(q==='unknown')throw {rjs:true,result:{kind:'unknown',operationId:f.deliveryId,blockers:[{code:'consumer-unknown',jobId:j.jobId,operationId:f.deliveryId}]}};if(q==='not-applied')fail('consumer-unknown',{jobId:j.jobId,operationId:f.deliveryId});");
 source=once(source,"case 'recover':return settleBatch(req.batchId,req,false);",`case 'recover':try{return await settleBatch(req.batchId,req,false);}catch(error){
   const current=await decorate(await batchView(req.batchId));
   const remaining=current.jobs.filter(j=>j.state!=='released');
   if(remaining.length&&remaining.every(j=>j.obligations.some(o=>['source.ack','consumer.consume'].includes(o.resource)&&ids.test(o.attemptId))))return current;
   throw error;
  }`);
 return source;
}
export function createCalibrationControl(id,reference,{materialSelector}={}){
 if(hash(reference)!==referenceSha256)throw Error('calibration requires the exact frozen reference input');
 if(!controlDefinitions.some(c=>c.id===id))throw Error('unknown calibration control');
 if(materialSelector&&!materialControls[materialSelector])throw Error('unknown material selector');
 let source=materialSelector&&!(id==='algorithm'&&materialSelector==='truncate-scan')?materialControls[materialSelector].mutate(reference):reference;
 source=({representation,algorithm,'truthful-outcome':truthful}[id])(source,{materialSelector});
 return {id,label:controlDefinitions.find(c=>c.id===id).label,materialSelector:materialSelector??null,source,sha256:hash(source),bytes:Buffer.byteLength(source)};
}
