import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createCalibrationControl} from '../benchmarks/recoverable-job-service/private/calibration/controls.mjs';
import {actualPredicate} from '../benchmarks/recoverable-job-service/private/calibration/probe-runtime.mjs';
import {evaluateBounded,createReplayInput,replayInputFromRecord} from '../benchmarks/recoverable-job-service/private/runtime.mjs';
import {variants} from '../benchmarks/recoverable-job-service/private/variants.mjs';
import {materialControl} from '../benchmarks/recoverable-job-service/private/qualification-map.mjs';
import {matchesMaterialFailure} from '../benchmarks/recoverable-job-service/private/material-failure.mjs';
import {sourceExpectedAssertion} from '../benchmarks/recoverable-job-service/private/source-controls.mjs';
import {scoreInputHashes} from '../benchmarks/recoverable-job-service/private/identity.mjs';
import {categoryNeighborIds,authorityNeighborIds,forbiddenCategory,forbiddenAuthority} from '../benchmarks/recoverable-job-service/private/calibration/forbidden-neighbors.mjs';

const base='benchmarks/recoverable-job-service/private',cal=base+'/calibration';
const plan=JSON.parse(await readFile(cal+'/probe-plan-final.json','utf8'));
const reference=await readFile(base+'/reference.js','utf8'),expected=JSON.parse(await readFile(base+'/control-expectations.json','utf8'));
const capacityOnly=process.argv.includes('--capacity-only');
const constructOnly=process.argv.includes('--construct-only');
const option=(name:string)=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
const positiveEvidence=option('--positive-evidence'),referenceResult=option('--reference-result');
const classes=plan.classes.filter((p:any)=>capacityOnly?p.id==='P07-owned-accounting':p.id!=='P07-owned-accounting');
const output=cal+'/probes-'+new Date().toISOString().replace(/[:.]/g,'-');await mkdir(output,{recursive:true});
const save=(name:string,value:unknown)=>writeFile(join(output,name),JSON.stringify(value,null,2)+'\n');
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const replayInput=createReplayInput();await save('replay-input.private.json',replayInput);
const identity=await scoreInputHashes(),sources:Record<string,string>={reference};
for(const p of classes)if(!sources[p.control])sources[p.control]=createCalibrationControl(p.control,reference).source;
if(!capacityOnly)sources.representation=createCalibrationControl('representation',reference).source;
for(const [name,source] of Object.entries(sources))await writeFile(join(output,name+'.js'),source);
const checks:any[]=[],runs:any[]=[],traces:any[]=[];
const check=(passed:unknown,label:string)=>checks.push({label,passed:!!passed});
const selections=new Map<string,Set<string>>();
const add=(source:string,id:string)=>{if(!selections.has(source))selections.set(source,new Set());selections.get(source)!.add(id);};
for(const p of classes)for(const id of p.variants)for(const name of capacityOnly?[p.control]:['reference',p.control])add(name,id);
if(!capacityOnly)for(const id of plan.alternateMaterialScope.representationExtraVariants)add('representation',id);
if(constructOnly){
 const materialSources=[];
 for(const [name,ids] of selections){if(name==='reference')continue;for(const selector of new Set([...ids].map(id=>materialControl(variants.find((v:any)=>v.id===id))))){
  const generated=createCalibrationControl(name,reference,{materialSelector:selector});await writeFile(join(output,name+'-material-'+selector+'.js'),generated.source);materialSources.push({control:name,selector,sha256:generated.sha256,bytes:generated.bytes});
 }}
 await save('construction.json',{purpose:'Source construction only; no candidate execution',identity,classes:classes.map((p:any)=>p.id),sources:Object.fromEntries(Object.entries(sources).map(([name,s])=>[name,hash(s)])),materialSources});
 console.log(JSON.stringify({output,constructed:materialSources.length,executed:0},null,2));process.exit(0);
}
const rows=(r:any)=>r.families.flatMap((f:any)=>f.variants);
async function bounded(name:string,source:string,ids:string[],material=false){
 let tape:any;const result=await evaluateBounded(source,{variantIds:ids,replayInput,...(capacityOnly?{largeCount:1100}:{}),onReplayRecord(value:any){tape=value;}});
 assert.deepEqual(replayInputFromRecord(tape),replayInput);await save(name+'.replay.private.json',tape);await save(name+'.result.json',result);
 check(result.status==='valid'&&rows(result).length===ids.length&&rows(result).every((v:any)=>v.safetyChecked),name+': complete valid predicates');
 for(const row of rows(result)){
  const variant=variants.find((v:any)=>v.id===row.id);const exp=expected[row.id]??{expectedReasonPrefix:sourceExpectedAssertion(variant)};
  check(material?matchesMaterialFailure(variant,row,exp):row.passed,name+': '+row.id+(material?' intended material failure':' positive progress/refusal'));
 }
 const summary={name,sourceHash:hash(source),status:result.status,selected:rows(result).length,pass:rows(result).filter((v:any)=>v.passed).length,
  skip:rows(result).filter((v:any)=>!v.safetyChecked).length,material,failed:rows(result).filter((v:any)=>!v.passed).map((v:any)=>({id:v.id,reason:v.reason}))};
 runs.push(summary);console.log(JSON.stringify(summary));
}
for(const [name,ids] of selections){
 const path=name==='reference'?referenceResult:positiveEvidence?join(positiveEvidence,name+'.result.json'):null;
 if(path&&!capacityOnly){
  const bytes=await readFile(path,'utf8'),result=JSON.parse(bytes);
  assert.equal(result.candidateHash,hash(sources[name]));assert.equal(result.contractHash,identity.contractHash);assert.equal(result.suiteHash,identity.suiteHash);
  assert(result.resolved&&result.status==='valid'&&result.provenance.mode==='production'&&rows(result).length===302);
  assert([...ids].every(id=>rows(result).some((v:any)=>v.id===id&&v.passed&&v.safetyChecked)));
  runs.push({name:name+'-positive',sourceHash:hash(sources[name]),reusedFinalFullPositive:{path,sha256:hash(bytes)},selected:ids.size,pass:ids.size,skip:0,material:false});
 }else await bounded(name+'-positive',sources[name],[...ids]);
}
for(const [name,ids] of selections){
 if(name==='reference')continue;
 const groups=new Map<string,string[]>();
 for(const id of ids){const v=variants.find((v:any)=>v.id===id),key=materialControl(v);groups.set(key,[...groups.get(key)??[],id]);}
 for(const [selector,selected] of groups){const mutated=createCalibrationControl(name,reference,{materialSelector:selector});await writeFile(join(output,name+'-material-'+selector+'.js'),mutated.source);await bounded(name+'-material-'+selector,mutated.source,selected,true);}
 await bounded(name+'-restored',sources[name],[...ids]);
}
async function aggregate({s}:any){
 const before=await s.ok('inspectJob',{jobId:s.jobId});
 const owned=before.obligations.filter((o:any)=>['source.ack','consumer.consume'].includes(o.resource));
 s.check(owned.length>0&&owned.every((o:any)=>typeof o.attemptId==='string'),'aggregate recovery has actual unresolved source/client IDs');
 const result=await s.run('recover',{batchId:s.batchId});
 if(result.kind==='ok'){
  const job=result.value.jobs.find((j:any)=>j.jobId===s.jobId);
  s.check(job&&job.state!=='released'&&owned.every((o:any)=>job.obligations.some((p:any)=>p.resource===o.resource&&p.attemptId===o.attemptId)),'truthful aggregate preserves every exact per-job unresolved obligation');
 }else s.check(result.blockers?.some((b:any)=>['dependency','unknown-effect','consumer-unknown'].includes(b.code)),'refusing aggregate preserves actual unresolved category');
}
for(const p of classes)for(const id of p.variants)for(const name of capacityOnly?[p.control]:['reference',p.control]){
 if(capacityOnly){traces.push({name:p.id+'-'+name+'-'+id.replaceAll('/','-'),variantId:id,sourceHash:hash(sources[name]),boundedCapacityProof:true,evidence:['algorithm-positive.result.json','algorithm-material-truncate-scan.result.json','algorithm-restored.result.json'],failure:null,safety:[]});continue;}
 // These four exact deferred-attachment observations and four exact non-range
 // reference transports were already accepted on preserved scoped source.
 if(name==='reference'&&((p.id==='P04-setup-attachment'&&['B01/recover-driver.attach.before','B06/deadline-driver.attach.before','B07/issued-driver.attach.before','B07/resource-intent-reader'].includes(id))||(p.id==='P05-frame-category'&&id.startsWith('A07/invalid-')&&!['A07/invalid-seq','A07/invalid-offset'].includes(id)))){
  traces.push({name:p.id+'-reference-'+id.replaceAll('/','-'),variantId:id,reusedAcceptedScope:true,sourceHash:hash(reference),evidence:cal+'/correction-source-freeze.json',failure:null,safety:[]});continue;
 }
 let observedAggregate=false;
 const beforeRequest=p.id==='P03-source-obligations'?async({s,method}:any)=>{if(method==='closeBatch'&&!observedAggregate){observedAggregate=true;await aggregate({s});}}:undefined;
 const afterExercise=async({s,publicCalls}:any)=>{
  if(p.id==='P03-source-obligations'&&!observedAggregate){await aggregate({s});await s.refuse('closeBatch',{batchId:s.batchId});}
  if(p.id==='P06-authority-deadline'){
   s.b.takeover();const before=s.b.trace.filter((e:any)=>e.type==='effect').length,revision=s.b.revision;
   const result=await s.run('stop',{jobId:s.jobId,deadline:s.b.time});
   s.check(result.kind==='stale'&&result.ownerId===s.b.grant.ownerId&&result.epoch===s.b.grant.epoch||result.kind==='blocked'&&result.blockers.some((b:any)=>b.code==='deadline'),'simultaneously changed authority and expired deadline has truthful permitted precedence');
   s.check(s.b.trace.filter((e:any)=>e.type==='effect').length===before&&s.b.revision===revision,'simultaneous invalid admission publishes no effect or state');
  }
  if(p.id==='P08-reclamation'&&id==='E08/primary'){
   const before=s.b.physicalRemovals,remaining=[...s.b.roots.values()].filter((r:any)=>!r.handle.retained&&!r.absent).length;
   const prior=publicCalls.filter((c:any)=>c.method==='reclaim').at(-1).result.value;
   s.check(prior.failure.present&&prior.failure.value===false&&prior.removed.length===1,'first real removal and original falsy failure retained before retry');
   await s.ok('reclaim');s.check(s.b.physicalRemovals-before===remaining,'retry removes exact remaining present roots while accounting for already absent root');
   const complete=s.b.physicalRemovals;await s.ok('reclaim');s.check(s.b.physicalRemovals===complete,'all absent roots cause no new physical deletion');
   s.check([...s.b.roots.values()].filter((r:any)=>r.handle.retained).every((r:any)=>!r.absent),'reclamation retry preserves every retained root');
  }
 };
 const probe=await actualPredicate(sources[name],id,{replayInput,...(capacityOnly?{largeCount:1100}:{}),beforeRequest,afterExercise});
 const key=p.id+'-'+name+'-'+id.replaceAll('/','-');await save(key+'.trace.private.json',probe.privateTrace);await save(key+'.probe.json',probe.summary);
 check(probe.summary.failure===null&&probe.summary.safety.length===0,key+': actual predicate and supplemental public facts');
 check(probe.summary.allGuestsDisposed&&probe.summary.remainingTrackedCalls===0,key+': all guest/call resources disposed');
 traces.push({name:key,sourceHash:hash(sources[name]),...probe.summary});
}
if(!capacityOnly){
 const forbidden=[...['backend','input'].map(code=>({name:'forbidden-'+code,source:forbiddenCategory(reference,code),ids:categoryNeighborIds})),{name:'forbidden-cleanup-authority',source:forbiddenAuthority(reference),ids:authorityNeighborIds}];
 for(const neighbor of forbidden){
  await writeFile(join(output,neighbor.name+'.js'),neighbor.source);
  let tape:any;const result=await evaluateBounded(neighbor.source,{variantIds:neighbor.ids,replayInput,onReplayRecord(value:any){tape=value;}});
  assert.deepEqual(replayInputFromRecord(tape),replayInput);await save(neighbor.name+'.result.json',result);await save(neighbor.name+'.replay.private.json',tape);
  check(result.status==='valid'&&rows(result).length===neighbor.ids.length,neighbor.name+': actual complete selected predicates');
  for(const row of rows(result))check(!row.passed&&row.safetyChecked&&row.assertions.some((a:any)=>a.label==='public result schema'&&a.passed)&&row.assertions.some((a:any)=>!a.passed&&['restore categorical blocker','poll categorical blocker','stop categorical blocker'].includes(a.label)),neighbor.name+': '+row.id+' exact intended categorical rejection');
  runs.push({name:neighbor.name,sourceHash:hash(neighbor.source),selected:rows(result).length,pass:rows(result).filter((r:any)=>r.passed).length,skip:rows(result).filter((r:any)=>!r.safetyChecked).length,forbidden:true});
  for(const id of neighbor.ids){
   const probe=await actualPredicate(neighbor.source,id,{replayInput}),key=neighbor.name+'-'+id.replaceAll('/','-');
   await save(key+'.trace.private.json',probe.privateTrace);await save(key+'.probe.json',probe.summary);
   check(!!probe.summary.failure?.includes('categorical blocker')&&probe.summary.safety.length===0&&probe.summary.allGuestsDisposed&&probe.summary.remainingTrackedCalls===0,key+': real forbidden category, safe cleanup and disposed guests');
   traces.push({name:key,sourceHash:hash(neighbor.source),...probe.summary});
  }
 }
}
assert.deepEqual(await scoreInputHashes(),identity);
const summary={schemaVersion:1,purpose:'Real eight-class calibration probe evidence; full production acceptance remains separately gated',output,identity,
 classes:classes.map((p:any)=>p.id),capacityOnly,runs,traces:traces.map(t=>({name:t.name,variantId:t.variantId,failure:t.failure,safety:t.safety,operations:t.operations,promiseJobs:t.promiseJobs,...(t.reusedAcceptedScope?{reusedAcceptedScope:true,evidence:t.evidence}:{}),...(t.boundedCapacityProof?{boundedCapacityProof:true,evidence:t.evidence}:{})})),checks,passed:checks.every(c=>c.passed)};
await save('summary.json',summary);console.log(JSON.stringify({output,classes:summary.classes,runs:runs.length,traces:traces.length,passed:summary.passed,failed:checks.filter(c=>!c.passed)},null,2));
assert(summary.passed,'all mapped real-predicate/material/restored probes must pass');
