import * as source from './source-adapter.mjs';
import {ReplayEntropy} from './replay.mjs';
import * as wire from './wire-schema.mjs';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
export const LIMITS = Object.freeze({heap:134217728,document:65536,transaction:262144,storage:16777216,message:8388608,operations:100000,promiseJobs:1000000,wallMs:60000,scan:64,payload:65536,metadata:32768,retention:8192,pipe:4096,maxJobs:1100,maxBatches:4,maxRunning:16});
export const clone = x => x === undefined ? undefined : structuredClone(x);
export const canonical = x => x === null || typeof x !== 'object' ? JSON.stringify(x) : Array.isArray(x) ? '['+x.map(canonical).join(',')+']' : '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
export const digest = bytes => createHash('sha256').update(Buffer.from(bytes)).digest('hex');
export const jsonDigest = x => digest(Buffer.from(canonical(x)));
export class HarnessError extends Error {}
export class CandidateError extends Error {}
const idPattern = /^[a-f0-9]{32}$/;
const safe = x => Number.isSafeInteger(x) && x >= 0;
function checkBytes(bytes) {if(!Array.isArray(bytes)||bytes.length>4096||!bytes.every(x=>Number.isInteger(x)&&x>=0&&x<=255))throw new CandidateError('invalid bytes');}
const methods = new Set(['now','newId','digest','verify','authority','waitUntil','store.read','store.scan','store.commit','artifact.create','artifact.write','artifact.read','artifact.inspect','artifact.remove','driver.acquire','driver.start','driver.inspect','driver.inspectBinding','driver.readChannel','driver.receipt','driver.attach','driver.observeSource','driver.barrier','driver.privateRetain','driver.publishAck','driver.retireAck','driver.publishRelease','driver.replaceRelease','driver.control','driver.detach','driver.release','consumer.consume','consumer.query','capsule.seal','capsule.verify','claims.read','claims.cas']);

function validateArguments(method,a){
 const require=(ok,label)=>{if(!ok)throw new CandidateError('invalid '+method+' '+label);};
 if(method.startsWith('driver.')&&!['driver.receipt','driver.inspectBinding'].includes(method))require(wire.id(a.jobId),'job ID');
 const mutation=['store.commit','artifact.create','artifact.write','artifact.remove','claims.cas'].includes(method)||method.startsWith('driver.')&&!['driver.inspect','driver.inspectBinding','driver.readChannel','driver.receipt'].includes(method);
 if(mutation)require(wire.id(a.operationId),'operation ID');
 if(method==='driver.inspect')require(wire.nat(a.epoch),'epoch');
 if(method==='driver.receipt')require(wire.id(a.operationId),'operation ID');
 if(method==='driver.inspectBinding')require(wire.binding(a.binding),'binding');
 if(method==='driver.start')require(wire.id(a.workloadId)&&wire.binding(a.workload)&&wire.binding(a.witness),'bindings');
 if(method==='driver.control')require(wire.binding(a.target)&&['force','graceful'].includes(a.signal),'control');
 if(method==='driver.publishRelease')require(wire.id(a.requestId)&&wire.binding(a.witness),'release request');
 if(method==='driver.replaceRelease')require(wire.id(a.expectedRequestId)&&(a.nextRequestId===null||wire.id(a.nextRequestId)),'request CAS');
 if(method==='driver.privateRetain'||method==='driver.publishAck')require(wire.frame(a.frame)&&a.frame.jobId===a.jobId,'frame');
 if(method==='driver.publishAck')require(wire.receipt(a.consumed),'consumption receipt');
 if(method==='driver.retireAck')require(wire.receipt(a.ack),'ACK receipt');
 if(method==='driver.observeSource')require(wire.receipt(a.reader),'reader receipt');
 if(method==='driver.detach')require(wire.receipt(a.reader),'reader receipt');
 if(method==='driver.release')require(wire.receipt(a.acquired),'acquired receipt');
 if(method==='artifact.create')require(typeof a.retained==='boolean','retained flag');
 if(method.startsWith('artifact.')&&method!=='artifact.create')require(wire.root(a.root),'root');
 if(method==='consumer.consume'){require(wire.id(a.consumerId)&&wire.id(a.deliveryId)&&wire.frame(a.frame?.key),'delivery');checkBytes(a.frame.bytes);require(a.frame.bytes.length===a.frame.key.length&&digest(a.frame.bytes)===a.frame.key.digest,'actual delivery bytes');}
 if(method==='consumer.query')require(wire.id(a.consumerId)&&wire.id(a.deliveryId),'delivery query');
 if(method==='capsule.seal'||method==='capsule.verify')require(wire.obj(a.capsule),'capsule');
 if(method==='claims.cas')require(wire.nat(a.expected)&&Object.hasOwn(a,'value'),'claim CAS');
}

export class Broker {
 constructor(seed='public-example',options={}) {this.entropy=new ReplayEntropy(options.replayInput,options.variantId??seed,options.caseDefinition);this.seed=seed;this.secret=this.entropy.authenticationKey;this.serial=0;this.issuedIds=new Set();this.time=0;this.revision=0;this.storageBytes=0;this.physicalRemovals=0;this.docs=new Map();this.snapshots=new Map();this.roots=new Map();this.jobs=new Map();this.receipts=new Map();this.claims=new Map();this.bindings=new Map();this.consumers=new Map();this.trace=[];this.audit=[];this.faults=[];this.held=new Map();this.timers=[];this.operations=0;this.active=new Set();this.inspecting=new Set();this.frameOrigins=new WeakMap();this.frameCount=0;this.outputBytes=0;this.transactionIds=new Map();this.claimTransactions=new Map();this.closed=false;this.scratch=null;this.scopeId=this.id();this.grant=this.issueGrant();}
 id(){let id;do{id=this.entropy.id();}while(this.issuedIds.has(id));this.issuedIds.add(id);this.serial++;return id;}
 token(x,domain="internal"){return jsonDigest({x,domain,secret:this.secret});}
 sourcePrelude(a){return this.entropy.run('fixture',()=>source.sourcePrelude(this,a));}
 sourceState(a){return source.sourceState(this,a);}
 sourceAckBegin(a){return source.sourceAckBegin(this,a);}
 sourceAckOutcome(a){return source.sourceAckOutcome(this,a);}
 inputIdentity(){return this.entropy.identity();}
 executedInput(){return {variantId:this.entropy.variantId,events:clone(this.entropy.fixtureEvents)};}
 binding(kind){const b={id:this.id(),birth:this.id(),kind};b.token=this.token(b,"binding");this.bindings.set(b.id,{binding:clone(b),state:'alive'});if(!this.entropy.context.getStore()||this.entropy.context.getStore()==='fixture')this.entropy.record({type:'binding',binding:clone(b)});return b;}
 issueGrant(ownerId=this.id(),epoch=1){const g={scopeId:this.scopeId,ownerId,epoch,expiresAt:this.time+20000,holder:this.binding('agent')};g.token=this.token(g,"grant");this.entropy.record({type:'grant',grant:clone(g)});return g;}
 takeover(){return this.entropy.run('fixture',()=>{this.grant=this.issueGrant(this.id(),this.grant.epoch+1);return clone(this.grant);});}
 validGrant(g){return g&&canonical(g)===canonical(this.grant)&&this.time<this.grant.expiresAt;}
 fence(f){if(!f||!safe(f.deadline))throw new CandidateError('invalid fence');if(!this.validGrant(f.grant))return {kind:'stale'};if(this.time>=f.deadline)return {kind:'not-applied',code:'deadline'};if(f.grant.expiresAt<f.deadline+100)return {kind:'not-applied',code:'lease'};return null;}
 receipt(effect,resourceId,operationId,payload,fence){const r={id:this.id(),operationId,effect,resourceId,ownerId:fence.grant.ownerId,epoch:fence.grant.epoch,appliedAt:this.time,payload:clone(payload)};r.token=this.token(r,"receipt");this.receipts.set(operationId,clone(r));this.trace.push({type:'effect',method:effect,receipt:clone(r),at:this.time});if(!this.entropy.context.getStore()||this.entropy.context.getStore()==='fixture')this.entropy.record({type:'receipt',receipt:clone(r)});return r;}
 verify(r){if(!wire.closed(r,['id','operationId','effect','resourceId','ownerId','epoch','appliedAt','payload','token'])||!wire.hex(r.token))return false;const x=clone(r);delete x.token;return r.token===this.token(x,"receipt");}
 fault(boundary,action,options={}){this.faults.push({boundary,action,occurrence:options.occurrence??1,seen:0,...options});}
 async boundary(name,args){this.trace.push({type:'boundary',method:name,args:clone(args),at:this.time});for(const f of this.faults){if(f.boundary!==name||f.done||(f.jobId&&f.jobId!==args.jobId)||(f.sourceId&&![this.jobs.get(args.jobId)?.sourceId,...(Array.isArray(args.sourceGuards)?args.sourceGuards:[]).map(g=>this.jobs.get(g?.observation?.resourceId)?.sourceId)].includes(f.sourceId))||(f.observationMethod&&f.observationMethod!==args.observationMethod)||(f.sourceGuardOnly&&!args.sourceGuards?.length)||(f.predicate&&!f.predicate(args)))continue;if(++f.seen!==f.occurrence)continue;f.done=true;this.trace.push({type:'fault',boundary:name,args:clone(args),action:f.action,code:f.code,value:clone(f.value),at:this.time});if(f.action==='hook'){await this.entropy.run('fixture',()=>f.fn(this,args));continue;}if(f.action==='hold'){const heldId=this.entropy.run('fixture',()=>this.id());this.held.set(heldId,{name,args:clone(args)});if(f.onHold)this.entropy.run('fixture',()=>f.onHold(heldId));return await new Promise((resolve,reject)=>Object.assign(this.held.get(heldId),{resolve,reject}));}if(f.action==='throw')throw f.value;if(f.action==='busy')return {kind:'busy',retryAt:this.time+(f.delay??1)};if(f.action==='unknown'){if(f.hideReceipt||f.receiptVisibility==='unknown')this.receipts.set(args.operationId,'unknown');return {kind:'unknown',operationId:args.operationId};}if(f.action==='not-applied')return {kind:'not-applied',code:f.code??'backend'};}return null;}
 resume(heldId,value=null){const h=this.held.get(heldId);if(!h)throw new HarnessError('unknown held boundary');this.held.delete(heldId);this.entropy.run('fixture',()=>h.resolve(value));}
 tick(now){if(!safe(now)||now<this.time)throw new HarnessError('invalid clock');this.time=now;for(const t of [...this.timers])if(t.at<=now){this.timers.splice(this.timers.indexOf(t),1);t.resolve(null);}}
 idle(){if(this.timers.length){this.tick(Math.min(...this.timers.map(t=>t.at)));return true;}return false;}
 getJob(id){const j=this.jobs.get(id);if(!j)throw new CandidateError('unknown job');return j;}
 ensureJob(id){if(!idPattern.test(id))throw new CandidateError('invalid job ID');let j=this.jobs.get(id);if(!j){j={id,revision:0,resources:{},workload:null,witness:null,workloadState:'not-started',witnessState:'alive',exit:null,release:null,consumedRelease:null,pipes:{stdout:{closed:false,produced:0},stderr:{closed:false,produced:0}},queue:[],buffer:[],producer:[],next:{stdout:0,stderr:0},offset:{stdout:0,stderr:0},retirement:null,reader:null,barrier:false,barrierBytes:[],startCount:0,forceCount:0,gracefulCount:0,privateCount:0,ackCount:0};this.jobs.set(id,j);}return j;}
 output(jobId,stream,bytes){return this.entropy.run('fixture',()=>this.fixtureOutput(jobId,stream,bytes));}
 fixtureOutput(jobId,stream,bytes){const j=this.getJob(jobId);if(!['stdout','stderr'].includes(stream)||j.pipes[stream].closed)throw new HarnessError('illegal output');for(let at=0;at<bytes.length;at+=(this.partition??4096)){const chunk=bytes.slice(at,at+(this.partition??4096)),key={jobId,channelId:j.resources.channel?.payload.channelId??this.id(),stream,seq:j.next[stream]++,offset:j.offset[stream],length:chunk.length,digest:digest(chunk),artifactId:this.id()};if(!chunk.length)continue;if(j.next.stdout+j.next.stderr>128||++this.frameCount>512||j.offset.stdout+j.offset.stderr+chunk.length>262144||(this.outputBytes+=chunk.length)>8388608)throw new HarnessError('fixture exceeded joint output profile');j.offset[stream]+=chunk.length;const frame={key,bytes:[...chunk]};this.frameOrigins.set(frame,Object.freeze({stream,length:chunk.length}));j.producer.push(frame);}this.refill(j);j.revision++;source.syncSource(this,j);this.entropy.record({type:'output',jobId,stream,bytes:clone(bytes)});}
 frameOrigin(frame){const origin=this.frameOrigins.get(frame);if(!origin)throw new HarnessError('Missing immutable physical frame identity');return origin;}
 physicalBytes(frames,stream){return frames.reduce((n,f)=>{const origin=this.frameOrigin(f);return n+(origin.stream===stream?origin.length:0);},0);}
 refill(j){let retained=j.queue.reduce((n,f)=>n+f.bytes.length,0);while((j.buffer.length||j.producer.length)){const source=j.buffer.length?j.buffer:j.producer;if(retained+source[0].bytes.length>LIMITS.retention)break;const f=source.shift();if(source===j.producer)j.pipes[this.frameOrigin(f).stream].produced+=this.frameOrigin(f).length;j.queue.push(f);retained+=f.bytes.length;}let buffered=j.buffer.reduce((n,f)=>n+f.bytes.length,0);while(j.producer.length&&buffered+j.producer[0].bytes.length<=LIMITS.pipe){const f=j.producer.shift();j.buffer.push(f);buffered+=f.bytes.length;j.pipes[this.frameOrigin(f).stream].produced+=this.frameOrigin(f).length;}}
 exit(jobId,code=0,natural=false){const j=this.getJob(jobId);j.workloadState='exited';j.exit={code,natural};this.trace.push({type:'workload-state',jobId,state:'exited',exit:clone(j.exit),at:this.time});j.revision++;}
 closePipes(jobId){const j=this.getJob(jobId);j.pipes.stdout.closed=j.pipes.stderr.closed=true;j.revision++;}
 finish(jobId){this.exit(jobId);this.closePipes(jobId);}
 consumer(id,behavior={}){return this.entropy.run('fixture',()=>{id??=this.id();this.consumers.set(id,{calls:[],receipts:new Map(),...behavior});return id;});}
 async rootDir(){if(!this.scratch)this.scratch=await mkdtemp(join(this.baseDirectory??tmpdir(),'rjs-'));return this.scratch;}
 validRoot(root){const r=this.roots.get(root?.id);return r&&canonical(root)===canonical(r.handle)?r:null;}
 call(method,args={}){if(method==='driver.inspect')this.trace.push({type:'exclusive-attempt',method,args:clone(args),at:this.time});const key=method==='driver.inspect'?args.jobId+'/'+args.epoch:null;if(key&&this.inspecting.has(key))return Promise.reject(new CandidateError('exclusive inventory overlap'));if(key)this.inspecting.add(key);const work=this.entropy.run(method==='newId'?'candidate-id':method==='store.scan'?'candidate-snapshot':'candidate-effect',()=>this.dispatch(method,args));this.active.add(work);const done=()=>{this.active.delete(work);if(key)this.inspecting.delete(key);};work.then(done,done);return work;}
 async dispatch(method,args={}){
  if(this.closed)throw new HarnessError('broker disposed');if(!methods.has(method))throw new CandidateError('unknown port');if(++this.operations>LIMITS.operations)throw new CandidateError('broker operation limit');if(Buffer.byteLength(JSON.stringify(args))>LIMITS.message)throw new CandidateError('message limit');if(!args||typeof args!=='object'||Array.isArray(args))throw new CandidateError('port args must be object');
  if(method==='now')return this.time;if(method==='newId')return this.id();if(method==='digest'){if(!Array.isArray(args.bytes)||args.bytes.length>LIMITS.message||!args.bytes.every(x=>Number.isInteger(x)&&x>=0&&x<=255))throw new CandidateError('invalid digest bytes');return digest(args.bytes);}
  if(method==='verify')return this.verify(args.receipt);
  if(method==='authority')return {current:clone(this.grant),valid:this.validGrant(args.grant),now:this.time};
  if(method==='waitUntil'){if(!safe(args.at))throw new CandidateError('invalid timer');if(args.at<=this.time)return null;return await new Promise(resolve=>this.timers.push({at:args.at,resolve}));}
  validateArguments(method,args);const fault=await this.boundary(method+'.before',args);if(fault)return fault;
  let value;
  const mutation=['store.commit','artifact.create','artifact.write','artifact.remove','claims.cas'].includes(method)||(method.startsWith('driver.')&&!['driver.inspect','driver.inspectBinding','driver.readChannel','driver.receipt'].includes(method));
  if(mutation){const refusal=this.fence(args.fence);if(refusal)return refusal;}
  if(method==='store.read'){this.key(args.key);value=clone(this.docs.get(args.key)??{revision:0,value:null});}
  else if(method==='store.scan'){
   // Commits replace records with cloned values; pinned versions stay immutable, and the returned page is cloned below.
   this.key(args.prefix);let s;if(args.cursor){const [id,index]=args.cursor.split(':');s=this.snapshots.get(id);if(!s||s.prefix!==args.prefix||!safe(Number(index)))throw new CandidateError('invalid scan cursor');s={...s,index:Number(index),id};}else{const id=this.id();s={id,prefix:args.prefix,revision:this.revision,rows:[...this.docs].filter(([k,v])=>k.startsWith(args.prefix)&&v.value!==null).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>({key,...v})),index:0};this.snapshots.set(id,s);}value={revision:s.revision,rows:s.rows.slice(s.index,s.index+64)};if(s.index+64<s.rows.length)value.next=s.id+':'+(s.index+64);
  }
  else if(method==='store.commit'){
   if(!idPattern.test(args.operationId))throw new CandidateError('invalid transaction ID');const prior=this.transactionIds.get(args.operationId),signature=jsonDigest({writes:args.writes,audit:args.audit,...(args.sourceGuards?{sourceGuards:args.sourceGuards}:{})});if(prior){if(prior.signature!==signature)return {kind:'not-applied',code:'input'};return {kind:'applied',value:clone(prior.receipt)};}
   const sourceRefusal=source.sourceGuards(this,args.sourceGuards,args.fence);if(sourceRefusal)return sourceRefusal;if(args.sourceGuards?.length)this.trace.push({type:"source-guard",observations:clone(args.sourceGuards),operationId:args.operationId,revision:this.revision+1,at:this.time});
   if(!Array.isArray(args.writes)||!Array.isArray(args.audit)||Buffer.byteLength(JSON.stringify({writes:args.writes,audit:args.audit}))>LIMITS.transaction||!args.audit.every(wire.audit))throw new CandidateError('invalid transaction');const seen=new Set();for(const w of args.writes){if(!wire.obj(w)||!Object.hasOwn(w,'value'))throw new CandidateError('invalid mutation');this.key(w.key);if(seen.has(w.key)||!safe(w.expected))throw new CandidateError('invalid mutation');seen.add(w.key);if(Buffer.byteLength(JSON.stringify(w.value))>LIMITS.document)return {kind:'not-applied',code:'capacity'};if((this.docs.get(w.key)?.revision??0)!==w.expected)return {kind:'not-applied',code:'busy'};}let total=this.storageBytes;for(const w of args.writes){const prev=this.docs.get(w.key);if(prev)total-=Buffer.byteLength(w.key+JSON.stringify(prev));total+=Buffer.byteLength(w.key+JSON.stringify({revision:this.revision+1,value:w.value}));}if(total>LIMITS.storage)return {kind:'not-applied',code:'capacity'};this.storageBytes=total;
   this.revision++;for(const w of args.writes)this.docs.set(w.key,{revision:this.revision,value:clone(w.value)});for(const a of args.audit){if(!a||typeof a.type!=='string')throw new CandidateError('invalid audit');const row={...clone(a),revision:this.revision,ownerId:args.fence.grant.ownerId,epoch:args.fence.grant.epoch,at:this.time,traceIndex:this.trace.length};this.audit.push(row);this.trace.push({...row,type:'audit',auditType:a.type});}value={kind:'applied',value:this.receipt('store.commit',this.scopeId,args.operationId,{revision:this.revision},args.fence)};this.transactionIds.set(args.operationId,{signature,receipt:clone(value.value)});
  }
  else if(method==='artifact.create'){
   this.path(args.path);if(!idPattern.test(args.owner))throw new CandidateError('invalid root owner');const handle={id:this.id(),birth:this.id(),path:args.path,owner:args.owner,retained:args.retained===true};handle.token=this.token(handle,"root");const dir=join(await this.rootDir(),handle.id);await mkdir(dir);this.roots.set(handle.id,{handle,dir,files:new Map(),aliases:false,foreignEntries:false,absent:false});this.receipt(method,handle.id,args.operationId,{root:handle},args.fence);value={kind:'applied',value:clone(handle)};
  }
  else if(method.startsWith('artifact.')){
   const r=this.validRoot(args.root);if(method==='artifact.inspect'){value=!r||r.absent?'absent':{birth:r.handle.birth,owner:r.handle.owner,aliases:r.aliases,foreignEntries:r.foreignEntries};}
   else if(method==='artifact.read'){if(!r||r.absent||!r.files.has(args.name))value='missing';else{this.name(args.name);try{value=[...await readFile(join(r.dir,args.name))];}catch(e){if(e.code==='ENOENT')value='missing';else throw new HarnessError('artifact read failed: '+e.message);}}}
   else if(method==='artifact.write'){checkBytes(args.bytes);this.name(args.name);if(!r||r.absent)return {kind:'not-applied',code:'owned-path'};if(r.files.has(args.name)){if(digest(r.files.get(args.name))!==digest(args.bytes))return {kind:'not-applied',code:'integrity'};}else{await writeFile(join(r.dir,args.name),Buffer.from(args.bytes),{flag:'wx'});r.files.set(args.name,[...args.bytes]);}value={kind:'applied',value:this.receipt(method,r.handle.id,args.operationId,{name:args.name,digest:digest(args.bytes),length:args.bytes.length},args.fence)};}
   else {if(!r)return {kind:'not-applied',code:'owned-path'};if(!r.absent){if(r.aliases||r.foreignEntries)return {kind:'not-applied',code:'owned-path'};const st=await lstat(r.dir);if(!st.isDirectory()||st.isSymbolicLink())return {kind:'not-applied',code:'owned-path'};await rm(r.dir,{recursive:true});this.physicalRemovals++;r.absent=true;}value={kind:'applied',value:this.receipt(method,r.handle.id,args.operationId,{absent:true},args.fence)};}
  }
  else if(method==='driver.receipt')value=clone(this.receipts.get(args.operationId)??'not-applied');
  else if(method==='driver.inspectBinding'){const b=this.bindings.get(args.binding?.id);value=!b||canonical(b.binding)!==canonical(args.binding)?'foreign':b.state;}
  else if(method==='driver.acquire'){
   if(!['isolation','process','channel','workload'].includes(args.resource))throw new CandidateError('invalid resource');const j=this.ensureJob(args.jobId);let payload;if(args.resource==='process'){j.workload=this.binding('workload');j.witness=this.binding('witness');payload={workload:j.workload,witness:j.witness};}else payload={[{isolation:'allocationId',channel:'channelId',workload:'workloadId'}[args.resource]]:this.id()};const r=this.receipt(method,j.id,args.operationId,{resource:args.resource,...payload},args.fence);j.resources[args.resource]=r;value={kind:'applied',value:r};
  }
  else if(method.startsWith('driver.')){
   const j=this.getJob(args.jobId);let payload={jobId:j.id};
   if(method==='driver.attach'||method==='driver.observeSource'){
    j.observations??=new Map();const prior=j.observations.get(args.operationId),signature=jsonDigest({method,args});if(prior)return prior.signature===signature?{kind:'applied',value:clone(prior.receipt)}:{kind:'not-applied',code:'input'};
    const held=await this.boundary('source-observation.before',{...args,observationMethod:method});if(held)return held;
    const refusal=this.fence(args.fence);if(refusal)return refusal;
    if(!j.resources.channel||method==='driver.observeSource'&&(!this.verify(args.reader)||args.reader.effect!=='driver.attach'||canonical(j.reader)!==canonical(args.reader)))return {kind:'not-applied',code:'identity'};
   }
   if(method==='driver.inspect'){value={revision:j.revision,workload:clone(j.workload),witness:clone(j.witness),workloadState:j.workloadState,witnessState:j.witnessState,pipes:{stdout:{...j.pipes.stdout,bufferedBytes:this.physicalBytes(j.buffer,'stdout')},stderr:{...j.pipes.stderr,bufferedBytes:this.physicalBytes(j.buffer,'stderr')}}};if(j.exit)value.exit=clone(j.exit);if(j.consumedRelease)value.consumedRelease=clone(j.consumedRelease);}
   else if(method==='driver.readChannel'){source.syncSource(this,j);value={revision:j.revision,sourceRevision:j.sourceRevision,frame:clone(j.queue[0]??null),retainedBytes:j.queue.reduce((n,f)=>n+f.bytes.length,0),retirement:clone(j.retirement),terminalProduction:j.barrier,pipesDrained:j.pipes.stdout.closed&&j.pipes.stderr.closed&&j.queue.length===0&&j.buffer.length===0&&j.producer.length===0};}
   else if(method==='driver.start'){if(canonical(args.workload)!==canonical(j.workload)||canonical(args.witness)!==canonical(j.witness))return {kind:'not-applied',code:'identity'};j.startCount++;j.workloadState='running';source.initializeSource(this,j,args.workloadId,args.fence);payload={workload:clone(j.workload),witness:clone(j.witness),workloadId:args.workloadId};}
   else if(method==='driver.attach'||method==='driver.observeSource'){payload=source.sourcePayload(this,j,args,method==='driver.observeSource'?args.reader:null);}
   else if(method==='driver.privateRetain'){j.privateCount++;payload={frame:clone(args.frame),deliveryId:args.operationId};}
   else if(method==='driver.publishAck'){if(!this.verify(args.consumed))return {kind:'not-applied',code:'integrity'};payload={frame:clone(args.frame),consumed:clone(args.consumed)};}
   else if(method==='driver.retireAck'){
    if(!this.verify(args.ack)||args.ack.effect!=='driver.publishAck'||args.ack.resourceId!==j.id)return {kind:'not-applied',code:'integrity'};const key=args.ack.payload.frame;const at=j.queue.findIndex(f=>canonical(f.key)===canonical(key));if(at>=0){j.queue.splice(at,1);j.ackCount++;j.sourceAdvanced??={stdout:{seq:0,offset:0},stderr:{seq:0,offset:0}};j.sourceAdvanced[key.stream]={seq:key.seq+1,offset:key.offset+key.length};this.refill(j);source.syncSource(this,j);}payload={ack:clone(args.ack),frame:clone(key)};j.retirement=args.ack;
   }
   else if(method==='driver.barrier'){for(const b of j.barrierBytes.splice(0))this.output(j.id,b.stream,b.bytes);if((j.workloadState==='exited'||j.workloadState==='not-started')&&!j.barrierBlocked&&j.producer.length===0){this.closePipes(j.id);j.barrier=true;}payload={terminalProduction:j.barrier,pipesClosed:j.pipes.stdout.closed&&j.pipes.stderr.closed};}
   else if(method==='driver.publishRelease'){if(canonical(args.witness)!==canonical(j.witness))return {kind:'not-applied',code:'identity'};j.release={requestId:args.requestId,ownerId:args.fence.grant.ownerId,epoch:args.fence.grant.epoch,witness:clone(args.witness)};payload=clone(j.release);}
   else if(method==='driver.replaceRelease'){if(j.release?.requestId!==args.expectedRequestId)return {kind:'not-applied',code:'busy'};if(j.release.ownerId!==args.fence.grant.ownerId||j.release.epoch!==args.fence.grant.epoch||canonical(j.release.witness)!==canonical(j.witness))return {kind:'not-applied',code:'authority'};j.release=args.nextRequestId?{...j.release,requestId:args.nextRequestId}:null;payload={expectedRequestId:args.expectedRequestId,nextRequestId:args.nextRequestId};}
   else if(method==='driver.control'){
    const b=this.bindings.get(args.target?.id);if(![j.workload,j.witness].some(binding=>canonical(binding)===canonical(args.target))||!['graceful','force'].includes(args.signal)||!b||canonical(b.binding)!==canonical(args.target)||b.state!=='alive')return {kind:'not-applied',code:'identity'};if(args.target.kind==='witness'){j.witnessState='exited';b.state='dead';}else if(args.signal==='force'){j.forceCount++;this.exit(j.id,137,false);}else{j.gracefulCount++;if(!j.ignoreGrace)this.exit(j.id,0,false);}payload={target:clone(args.target),signal:args.signal};
   }
   else if(method==='driver.detach'){if(!this.verify(args.reader)||args.reader.effect!=='driver.attach'||args.reader.resourceId!==j.id||canonical(j.reader)!==canonical(args.reader))return {kind:'not-applied',code:'identity'};j.reader=null;j.channelReleased=true;payload={reader:clone(args.reader)};}
   else if(method==='driver.release'){if(!['process','isolation'].includes(args.resource)||!this.verify(args.acquired)||args.acquired.effect!=='driver.acquire'||args.acquired.payload.resource!==args.resource||args.acquired.resourceId!==j.id||canonical(j.resources[args.resource])!==canonical(args.acquired))return {kind:'not-applied',code:'identity'};delete j.resources[args.resource];if(args.resource==='process'&&j.witness){j.witnessState='exited';this.bindings.get(j.witness.id).state='dead';}payload={resource:args.resource,acquired:clone(args.acquired)};}
   else throw new HarnessError('unimplemented driver primitive '+method);
   if(value===undefined){j.revision++;const r=this.receipt(method,j.id,args.operationId,payload,args.fence);if(method==='driver.attach')j.reader=clone(r);value={kind:'applied',value:r};if(method==='driver.attach'||method==='driver.observeSource'){j.observations.set(args.operationId,{signature:jsonDigest({method,args}),receipt:clone(r)});const afterSource=await this.boundary('source-observation.after',{...args,observationMethod:method});if(afterSource)return clone(afterSource);value=source.sourceClaim(this,j,{...args,observationMethod:method},value);}}
  }
  else if(method==='consumer.query'){const c=this.consumers.get(args.consumerId);if(!c)throw new CandidateError('unknown consumer');value=clone(c.receipts.get(args.deliveryId)??'not-applied');}
  else if(method==='consumer.consume'){
   const c=this.consumers.get(args.consumerId);if(!c)throw new CandidateError('unknown consumer');c.calls.push(clone(args));if(c.nested)await this.entropy.run('fixture',()=>c.nested(args));const r=this.receipt(method,args.frame.key.jobId,args.deliveryId,{frame:clone(args.frame.key),deliveryId:args.deliveryId,consumerId:args.consumerId},{grant:this.grant});c.receipts.set(args.deliveryId,r);if(c.unknown)c.receipts.set(args.deliveryId,'unknown');value=r;
  }
  else if(method==='capsule.seal'){const c=clone(args.capsule);delete c.seal;value=this.token(c,'capsule');}
  else if(method==='capsule.verify'){const c=clone(args.capsule);delete c.seal;value=args.capsule.seal===this.token(c,'capsule');}
  else if(method==='claims.read'){this.key(args.name);value=clone(this.claims.get(args.name)??{revision:0,value:null});}
  else if(method==='claims.cas'){this.key(args.name);if(!idPattern.test(args.operationId)||!safe(args.expected))throw new CandidateError('invalid claim transaction');const signature=jsonDigest({name:args.name,expected:args.expected,value:args.value}),prior=this.claimTransactions.get(args.operationId);if(prior)return prior.signature===signature?{kind:'applied',value:clone(prior.receipt)}:{kind:'not-applied',code:'input'};if(args.value!==null&&(!wire.obj(args.value)||!wire.binding(args.value.holder)||canonical(args.value.holder)!==canonical(args.fence.grant.holder)||args.value.logicalOwner!==args.fence.grant.ownerId||args.value.epoch!==args.fence.grant.epoch))return {kind:'not-applied',code:'authority'};const prev=this.claims.get(args.name)??{revision:0,value:null};if(prev.revision!==args.expected)return {kind:'not-applied',code:'busy'};this.claims.set(args.name,{revision:prev.revision+1,value:clone(args.value)});value={kind:'applied',value:this.receipt(method,this.scopeId,args.operationId,{name:args.name},args.fence)};this.claimTransactions.set(args.operationId,{signature,receipt:clone(value.value)});}
  else throw new HarnessError('missing primitive '+method);
  const after=await this.boundary(method+'.after',args);if(['driver.inspect','driver.readChannel'].includes(method))this.trace.push({type:'return',method,args:clone(args),value:clone(after??value),at:this.time});return clone(after??value);
 }
 key(key){if(typeof key!=='string'||key.length>180||key.includes('..')||!/^[-a-zA-Z0-9_/:]*$/.test(key))throw new CandidateError('invalid logical key');}
 path(path){if(typeof path!=='string'||Buffer.byteLength(path)>180||path.split('/').some(p=>!p||p==='.'||p==='..'||Buffer.byteLength(p)>48)||!/^[a-zA-Z0-9_/-]+$/.test(path))throw new CandidateError('invalid path');}
 name(name){if(typeof name!=='string'||!/^[-a-zA-Z0-9_.]{1,48}$/.test(name)||name==='.'||name==='..')throw new CandidateError('invalid artifact name');}
 async shutdown(){this.closed=true;for(const h of this.held.values())h.resolve({kind:'unknown',operationId:h.args.operationId??this.id()});this.held.clear();for(const t of this.timers)t.resolve(null);this.timers=[];await Promise.allSettled([...this.active]);if(this.scratch){const target=resolve(this.scratch),base=resolve(tmpdir());if(!target.startsWith(base+sep)||!target.split(sep).at(-1).startsWith('rjs-'))throw new HarnessError('unsafe fixture root');await rm(target,{recursive:true,force:true});}}
}

