import {readFile,writeFile} from 'node:fs/promises';
const base='benchmarks/recoverable-job-service/';
let t=await readFile(base+'public/contract.d.ts','utf8');
t=t.replace("'cleanup' | 'owned-path'","'cleanup' | 'owned-path' | 'privacy'");
t=t.replace('blockers:Blocker[]; evidence?:Evidence','blockers:Blocker[]; failures:Failure[]; evidence?:Evidence');
t=t.replace('retirement:Receipt[];finalManifest?', 'retirement:Receipt[];retiredThrough:Record<Stream,{seq:number;offset:number;receipt:Receipt|null}>;finalManifest?');
t=t.replace(" | ({type:'claim';name:string} & Op);"," | ({type:'claim';name:string} & Op)\n | ({type:'ownScratch';jobId:Id;root:Root} & Op);");
t=t.replace('export interface Service {run(request:Request):Promise<Result<unknown>>;',`export interface Reclamation {removed:Id[];remaining:Id[];failure?:Failure}
export interface EvidenceRead {manifest:Evidence;pieces:{span:Span;bytes:number[]}[]}
export interface SuccessMap {createBatch:{batchId:Id};start:{jobId:Id;setupId:Id};poll:JobView;stop:JobView;inspectJob:JobView;inspectBatch:BatchView;recover:BatchView;closeBatch:BatchView;close:BatchView[];consume:Receipt;acknowledge:null;replaceRelease:Receipt;exportCapsule:Capsule;restore:JobView;handoff:JobView;readEvidence:EvidenceRead;claim:{holder:Binding;logicalOwner:Id;epoch:number};reclaim:Reclamation;ownScratch:Root}
export interface Service {run<R extends Request>(request:R):Promise<Result<SuccessMap[R['type']]>>;`);
t=t.replace("args:{fence:Fence;writes:Mutation[];audit:Audit[]}","args:{operationId:Id;fence:Fence;writes:Mutation[];audit:Audit[]}");
t=t.replace("args:{name:string;expected:number;value:","args:{operationId:Id;name:string;expected:number;value:");
await writeFile(base+'public/contract.d.ts',t);
let r=await readFile(base+'private/reference.js','utf8');
r=r.replace("const commit=async(writes,audit,op)=>primitive('store.commit',{writes,audit},op);","const commit=async(writes,audit,op)=>primitive('store.commit',{writes,audit,operationId:await call('newId')},op);");
r=r.replace("if(code==='backend')reason='diagnostic-io';else if(code==='owned-path')reason='privacy';","if(code==='backend')reason='diagnostic-io';else if(code==='privacy')reason='privacy';");
r=r.replace("row.value.method==='driver.acquire'&&!j.acquired[row.value.args.resource]","row.value.method==='driver.acquire'&&['issued','unknown','verified'].includes(row.value.state)&&!j.acquired[row.value.args.resource]");
r=r.replace("'claims.cas',{name:req.name,expected:c.revision,","'claims.cas',{operationId:await call('newId'),name:req.name,expected:c.revision,");
r=r.replace("   case 'reclaim':",`   case 'ownScratch': {const j=await job(req.jobId),root=req.root;const state=await call('artifact.inspect',{root});if(root.retained||root.owner!==j.jobId||state==='absent'||state.birth!==root.birth||state.owner!==root.owner||state.aliases||state.foreignEntries)fail('owned-path');await update('adopted/'+root.id,()=>root,[],req);return root;}
   case 'reclaim':`);
r=r.replace("const roots=jobs.map(j=>j.scratchRoot).filter(Boolean),removed=[];","const roots=[...new Map([...jobs.map(j=>j.scratchRoot).filter(Boolean),...(await all('adopted/')).map(r=>r.value)].map(r=>[r.id,r])).values()],removed=[];");
r=r.replace("blockers:copy(j.blockers??[]),","blockers:copy(j.blockers??[]),failures:copy(j.failures??[]),");
// Compact capsule retired prefixes; retain independent private protocol records for exact replay.
r=r.replace("const frames=(await all('frame/'+id+'/')).map(r=>r.value);const c=", "const frames=(await all('frame/'+id+'/')).map(r=>r.value).sort((a,b)=>a.key.stream.localeCompare(b.key.stream)||a.key.seq-b.key.seq);const retiredThrough={stdout:{seq:0,offset:0,receipt:null},stderr:{seq:0,offset:0,receipt:null}};for(const f of frames.filter(f=>f.state==='acked')){const c=retiredThrough[f.key.stream];if(f.key.seq!==c.seq||f.key.offset!==c.offset)fail('gap');Object.assign(c,{seq:f.key.seq+1,offset:f.key.offset+f.key.length,receipt:f.retired});}const c=");
r=r.replace("accepted:frames.map(f=>f.key),consumed:frames.filter(f=>f.receipt).map(f=>f.receipt),retirement:frames.filter(f=>f.retired).map(f=>f.retired),","accepted:frames.filter(f=>f.state!=='acked').map(f=>f.key),consumed:frames.filter(f=>f.receipt&&f.state!=='acked').map(f=>f.receipt),retirement:Object.values(retiredThrough).map(c=>c.receipt).filter(Boolean),retiredThrough,");
r=r.replace("const ends={stdout:0,stderr:0},seq={stdout:0,stderr:0};for(const k of c.checkpoint.accepted)","const ends={stdout:0,stderr:0},seq={stdout:0,stderr:0};for(const stream of ['stdout','stderr']){const p=c.checkpoint.retiredThrough?.[stream];if(!p||!safe(p.seq)||!safe(p.offset))fail('integrity');if(p.offset===0){if(p.seq!==0||p.receipt!==null)fail('integrity');}else if(!p.receipt||!await call('verify',{receipt:p.receipt})||p.receipt.effect!=='driver.retireAck'||p.receipt.payload.frame.stream!==stream||p.receipt.payload.frame.seq+1!==p.seq||p.receipt.payload.frame.offset+p.receipt.payload.frame.length!==p.offset||p.receipt.resourceId!==j.jobId)fail('integrity');ends[stream]=p.offset;seq[stream]=p.seq;}for(const k of c.checkpoint.accepted)");
await writeFile(base+'private/reference.js',r);
let b=await readFile(base+'private/broker.mjs','utf8');
b=b.replace('this.operations=0;','this.operations=0;this.active=new Set();this.transactionIds=new Map();');
b=b.replace(" async call(method,args={}){",` call(method,args={}){const work=this.dispatch(method,args);this.active.add(work);work.then(()=>this.active.delete(work),()=>this.active.delete(work));return work;}
 async dispatch(method,args={}){`);
b=b.replace("this.receipt('store.commit',this.scopeId,this.id(),{revision:this.revision},args.fence)","this.receipt('store.commit',this.scopeId,args.operationId,{revision:this.revision},args.fence)");
b=b.replace("this.receipt(method,this.scopeId,this.id(),{name:args.name},args.fence)","this.receipt(method,this.scopeId,args.operationId,{name:args.name},args.fence)");
b=b.replace("if(method==='store.commit'){\n", "if(method==='store.commit'){\n");
b=b.replace("else if(method==='store.commit'){\n", "else if(method==='store.commit'){\n   if(!idPattern.test(args.operationId))throw new CandidateError('invalid transaction ID');const prior=this.transactionIds.get(args.operationId),signature=jsonDigest({writes:args.writes,audit:args.audit});if(prior){if(prior.signature!==signature)return {kind:'not-applied',code:'input'};return {kind:'applied',value:clone(prior.receipt)};}\n");
b=b.replace("args.operationId,{revision:this.revision},args.fence)};", "args.operationId,{revision:this.revision},args.fence)};this.transactionIds.set(args.operationId,{signature,receipt:clone(value.value)});");
b=b.replace("if(this.scratch){const target=", "await Promise.allSettled([...this.active]);if(this.scratch){const target=");
await writeFile(base+'private/broker.mjs',b);
