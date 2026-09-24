import {createReplayInput} from '../benchmarks/recoverable-job-service/private/replay.mjs';
import {compareExecutedInputs} from '../benchmarks/recoverable-job-service/private/replay-comparison.mjs';
import {matchesMaterialFailure} from '../benchmarks/recoverable-job-service/private/material-failure.mjs';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {evaluate} from '../benchmarks/recoverable-job-service/private/evaluator.mjs';
import {evaluateBounded,toVerifierResult} from '../benchmarks/recoverable-job-service/private/runtime.mjs';
import {controls,familyControl} from '../benchmarks/recoverable-job-service/private/controls.mjs';
import {scenarios} from '../benchmarks/recoverable-job-service/private/scenarios.mjs';
import {variants} from '../benchmarks/recoverable-job-service/private/variants.mjs';
import {materialControl} from '../benchmarks/recoverable-job-service/private/qualification-map.mjs';
import {comparisonIdentity} from '../benchmarks/recoverable-job-service/private/qualification-provenance.mjs';
import {SCORING_PROFILE} from '../benchmarks/recoverable-job-service/private/provenance.mjs';
import {parseRecoverableJobServiceDiagnostics} from '../lib/benchmark/workbench/recoverable-job-service/diagnostics';
import {createRecoverableJobServiceFixture,RECOVERABLE_JOB_SERVICE_INPUT_HASHES} from '../lib/benchmark/workbench/recoverable-job-service/fixture';
import {contractPaths,suitePaths,scoreInputHashes} from '../benchmarks/recoverable-job-service/private/identity.mjs';

const repository=new URL('../',import.meta.url),root=new URL('benchmarks/recoverable-job-service/',repository);
const attempt='task2-'+new Date().toISOString().replace(/[:.]/g,'-'),evidence=new URL('private/'+attempt+'/',root);
await mkdir(evidence);
const privateEvidence=new URL('private/'+attempt+'-replay/',root);await mkdir(privateEvidence);const replayInput=createReplayInput();await writeFile(new URL('input.json',privateEvidence),JSON.stringify(replayInput));const privateSizes:any[]=[];
const savePrivate=async(name:string,record:any)=>{const compact=JSON.stringify(record),pretty=JSON.stringify(record,null,2)+'\n';privateSizes.push({name,compact:Buffer.byteLength(compact),prettyFile:Buffer.byteLength(pretty)});await writeFile(new URL(name,privateEvidence),pretty);};
const save=(name:string,value:unknown)=>writeFile(new URL(name,evidence),JSON.stringify(value,null,2)+'\n');
const measure=(result:any)=>{const outer=toVerifierResult(result);return {diagnosticsCompact:Buffer.byteLength(JSON.stringify(result)),diagnosticsPretty:Buffer.byteLength(JSON.stringify(result,null,2)),diagnosticsFile:Buffer.byteLength(JSON.stringify(result,null,2)+'\n'),verifierCompact:Buffer.byteLength(JSON.stringify(outer)),verifierPretty:Buffer.byteLength(JSON.stringify(outer,null,2)),verifierFile:Buffer.byteLength(JSON.stringify(outer,null,2)+'\n')};};
const sourcePaths=[...contractPaths,...suitePaths,'private/reference.js','private/controls.mjs','private/qualification-map.mjs','private/control-expectations.json','private/qualification-provenance.mjs','private/source-controls.mjs','private/replay-comparison.mjs','private/material-failure.mjs','private/generate-assets.mjs','private/reference-source-bootstrap.txt'].map((p:string)=>'benchmarks/recoverable-job-service/'+p).concat(['scripts/test-recoverable-job-service-reader-attachment.mts','scripts/test-recoverable-job-service.mts','scripts/test-recoverable-job-service-wave4-scan.mts','scripts/test-recoverable-job-service-wave4-b14.mts','scripts/test-recoverable-job-service-replay-process.mts','scripts/test-recoverable-job-service-wave3-domains.mts','scripts/test-recoverable-job-service-wave3-lifecycle.mts','scripts/test-recoverable-job-service-wave3-d02.mts','scripts/test-recoverable-job-service-wave3-affected.mts','scripts/test-recoverable-job-service-raw-source-identity.mts','scripts/test-recoverable-job-service-raw-source-a07.mts','scripts/test-recoverable-job-service-replay-tape.mts','scripts/test-recoverable-job-service-source-material.mts','scripts/test-recoverable-job-service-source-adoption-timing.mts','scripts/test-recoverable-job-service-bootstrap-schema.mts','scripts/test-recoverable-job-service-capacity.mts','scripts/test-recoverable-job-service-fix5.mts','scripts/test-recoverable-job-service-fix3.mts','scripts/test-recoverable-job-service-freshness.mts','lib/benchmark/workbench/recoverable-job-service/assets.generated.ts','lib/benchmark/workbench/recoverable-job-service/diagnostics.ts','lib/benchmark/workbench/recoverable-job-service/fixture.ts','package.json','package-lock.json']).sort();
const manifest=async()=>Promise.all(sourcePaths.map(async path=>({path,sha256:createHash('sha256').update(await readFile(new URL(path,repository))).digest('hex')})));
const before=await manifest();await save('source-before.json',before);
console.log('Qualification evidence: '+evidence.pathname);
try{
 const [reference,starter,catalogue]=await Promise.all([readFile(new URL('private/reference.js',root),'utf8'),readFile(new URL('public/service.js',root),'utf8'),readFile(new URL('public/families.json',root),'utf8').then(JSON.parse)]);
 const referenceHash=createHash('sha256').update(reference).digest('hex');
 const ids=catalogue.map((f:{id:string})=>f.id).sort();
 assert.equal(ids.length,69);assert.equal(new Set(ids).size,69);assert.deepEqual(Object.keys(scenarios).sort(),ids);assert.deepEqual(Object.keys(familyControl).sort(),ids);
 assert.deepEqual(await scoreInputHashes(),RECOVERABLE_JOB_SERVICE_INPUT_HASHES);
 const expectations=JSON.parse(await readFile(new URL('private/control-expectations.json',root),'utf8'));
 assert.deepEqual(Object.keys(expectations).sort(),variants.map((v:{id:string})=>v.id).sort());
 const groups=new Map<string,any[]>();for(const v of variants){const name=materialControl(v);assert(controls[name],v.id+' control exists');if(Object.hasOwn(expectations[v.id],'control'))assert.equal(expectations[v.id].control,name,v.id+' recorded frozen control identity');assert.equal(typeof expectations[v.id].expectedReasonPrefix,'string');assert(expectations[v.id].expectedReasonPrefix.length>0);if(!groups.has(name))groups.set(name,[]);groups.get(name)!.push(v);}
 const unimplemented=await evaluateBounded(starter,{families:['C01'],wallMs:1000});assert.equal(unimplemented.status,'valid');assert.equal(unimplemented.resolved,false);assert.equal(unimplemented.families[0].passed,false);
 const began=performance.now();let lastFamilyAt=began;const measuredFamilyMs:Record<string,number>={},positiveInputs:any[]=[];
 let positiveRecord:any;const result=await evaluateBounded(reference,{replayInput,onReplayRecord:(r:any)=>positiveRecord=r,onVariantStart:(v:any)=>positiveInputs.push(v),onFamily:(f:{id:string;passed:boolean;reason:string})=>{const now=performance.now();measuredFamilyMs[f.id]=Math.round(now-lastFamilyAt);lastFamilyAt=now;if(!f.passed)console.error(f.id,f.reason);}});
 const referenceMs=Math.round(performance.now()-began);
 await savePrivate('reference.json',positiveRecord);
 await save('reference.json',{diagnostics:result,actualInputs:positiveInputs,measuredFamilyMs,referenceMs});
 await save('reference-diagnostics.json',result);await save('reference-verifier-result.json',toVerifierResult(result));await save('byte-sizes.json',{...measure(result),privateReplay:privateSizes});
 assert.equal(result.status,'valid',JSON.stringify(result.error));assert.equal(result.families.length,69);assert.equal(result.resolved,true,JSON.stringify(result.families.flatMap((f:any)=>f.variants).filter((v:any)=>!v.passed).map((v:any)=>({id:v.id,reason:v.reason}))));assert.equal(result.safetyFailures.length,0);assert.equal(result.candidateHash,referenceHash);
 assert.equal(parseRecoverableJobServiceDiagnostics(result).ok,true);
 assert.equal(positiveInputs.length,variants.length);assert.equal(new Set(positiveInputs.map(v=>v.variantId)).size,variants.length);
 const positiveComparisons=new Map(positiveInputs.map(v=>[v.variantId,comparisonIdentity(result,v)]));
 console.log('Reference: all 69 families / '+variants.length+' mandatory variants pass, including 1025-record B14; '+referenceMs+' ms.');

 const mutations:any[]=[],executions:any[]=[];let groupIndex=0;
 for(const [name,selected]of groups){
  groupIndex++;const control=controls[name],mutantSource=control.mutate(reference),negativeInputs:any[]=[],restoredInputs:any[]=[];let negativeRecord:any,restoredRecord:any;
  assert.notEqual(mutantSource,reference,name+' changes the candidate core');
  const options={mode:'development',seed:SCORING_PROFILE.seed,families:[...new Set(selected.map(v=>v.family))].sort(),variantIds:selected.map(v=>v.id),wallMs:SCORING_PROFILE.familyWallMs,totalWallMs:SCORING_PROFILE.totalWallMs,largeCount:SCORING_PROFILE.largeCount};
  const negative=await evaluateBounded(mutantSource,{...options,replayInput,onReplayRecord:(r:any)=>negativeRecord=r,onVariantStart:(v:any)=>negativeInputs.push(v)});
  await save(String(groupIndex).padStart(2,'0')+'-negative.json',{control:name,options,diagnostics:negative,actualInputs:negativeInputs});
  await savePrivate(String(groupIndex).padStart(2,'0')+'-negative.json',negativeRecord);
  const restored=await evaluateBounded(reference,{...options,replayInput,onReplayRecord:(r:any)=>restoredRecord=r,onVariantStart:(v:any)=>restoredInputs.push(v)});
  await save(String(groupIndex).padStart(2,'0')+'-restored.json',{control:name,options,diagnostics:restored,actualInputs:restoredInputs});
  await savePrivate(String(groupIndex).padStart(2,'0')+'-restored.json',restoredRecord);await save('byte-sizes.json',{...measure(result),privateReplay:privateSizes});
  assert.equal(negative.status,'valid',name+' negative is a candidate result');assert.equal(restored.status,'valid',name+' restored is a candidate result');
  assert.equal(restored.candidateHash,referenceHash);assert.equal(negative.candidateHash,createHash('sha256').update(mutantSource).digest('hex'));
  assert.equal(negative.resolved,false);assert.equal(restored.resolved,false,'selected development pass is not production resolution');
  assert.deepEqual(negative.provenance,restored.provenance,name+' negative/restored actual selected-run identity');
  assert.equal(negative.provenance.mode,'development');assert.notEqual(negative.provenance.configurationHash,result.provenance.configurationHash);
  assert.deepEqual(negativeInputs.map(v=>v.variantId).sort(),options.variantIds.slice().sort());assert.deepEqual(restoredInputs.map(v=>v.variantId).sort(),options.variantIds.slice().sort());
  const execution={control:name,options,negative:{candidateHash:negative.candidateHash,provenance:negative.provenance},restored:{candidateHash:restored.candidateHash,provenance:restored.provenance}};executions.push(execution);
  for(const v of selected){
   const negativeVariant=negative.families.find((f:any)=>f.id===v.family).variants.find((r:any)=>r.id===v.id),restoredVariant=restored.families.find((f:any)=>f.id===v.family).variants.find((r:any)=>r.id===v.id),positiveVariant=result.families.find((f:any)=>f.id===v.family).variants.find((r:any)=>r.id===v.id);
   const negativeObservation=negativeInputs.find(r=>r.variantId===v.id),restoredObservation=restoredInputs.find(r=>r.variantId===v.id);
   const positiveComparison=positiveComparisons.get(v.id),negativeComparison=comparisonIdentity(negative,negativeObservation),restoredComparison=comparisonIdentity(restored,restoredObservation);
   assert.deepEqual(negativeComparison,positiveComparison,v.id+' actual negative environment equals full positive variant');assert.deepEqual(restoredComparison,positiveComparison,v.id+' actual restored environment equals full positive variant');
   const reason=negativeVariant.reason,expected=expectations[v.id].expectedReasonPrefix,expectedAssertionPrefix=expectations[v.id].expectedAssertionPrefix;
   const negativeConcrete=compareExecutedInputs(positiveRecord,negativeRecord,v.id),restoredConcrete=compareExecutedInputs(positiveRecord,restoredRecord,v.id,{exact:true});
   const passed=matchesMaterialFailure(v,negativeVariant,expectations[v.id])&&restoredVariant.passed&&restoredVariant.safetyChecked&&restoredVariant.assertions.every((a:any)=>a.passed)&&restored.safetyFailures.length===0;
   mutations.push({variantId:v.id,familyId:v.family,clause:v.clause,kind:v.kind,args:v.args,schedule:negativeObservation.execution.schedule,control:name,description:control.description,expectedReasonPrefix:expected,expectedAssertionPrefix,causalAlternatives:expectations[v.id].causalAlternatives,actualReason:reason,assertions:negativeVariant.assertions,safetyFailures:negativeVariant.safetyFailures,provenance:negative.provenance,positive:positiveVariant,negative:negativeVariant,restored:restoredVariant,executionIndex:groupIndex,positiveComparison,negativeComparison,restoredComparison,negativeConcrete,restoredConcrete,passed});
   if(!passed)console.error('CONTROL FAILURE',v.id,reason,'expected',expected,'restored',restoredVariant.passed,restoredVariant.reason);
  }
  await save('variant-progress.json',{executions,rows:mutations});
  console.log('Checked mutation group '+groupIndex+'/'+groups.size+': '+name+'; '+selected.length+' variant comparisons.');
 }
 assert.equal(mutations.length,variants.length);assert.deepEqual(mutations.map(r=>r.variantId).sort(),variants.map((v:any)=>v.id).sort());
 assert(mutations.every(r=>r.passed),'All material controls fail at the declared intended assertion and restore under matched environments');
 console.log('Material qualification: '+groups.size+' bounded negative/restored execution pairs; all '+mutations.length+' variant comparisons match the full positive, fail as intended, and restore.');

 const repeat=await evaluate(reference,{replayInput,families:['A01','C01','C08','D01','E08']});const repeatAgain=await evaluate(reference,{replayInput,families:['A01','C01','C08','D01','E08']});assert.deepEqual(repeat,repeatAgain,'unchanged candidate/seed diagnostics must repeat');
 const unchecked=structuredClone(result);unchecked.families[0].safetyChecked=false;assert.equal(parseRecoverableJobServiceDiagnostics(unchecked).ok,false);const missingVariant=structuredClone(result);missingVariant.families[0].variants.pop();assert.equal(parseRecoverableJobServiceDiagnostics(missingVariant).ok,false);const changedProfile=structuredClone(result);changedProfile.provenance.largeCount=65;assert.equal(parseRecoverableJobServiceDiagnostics(changedProfile).ok,false);const invalid=structuredClone(result);invalid.resolved=false;assert.equal(parseRecoverableJobServiceDiagnostics(invalid).ok,false);const duplicate=structuredClone(result);duplicate.families[1]=duplicate.families[0];assert.equal(parseRecoverableJobServiceDiagnostics(duplicate).ok,false);const group=structuredClone(result);group.groups.A.coverage=0;assert.equal(parseRecoverableJobServiceDiagnostics(group).ok,false);
 assert.deepEqual(await scoreInputHashes(),RECOVERABLE_JOB_SERVICE_INPUT_HASHES);
 const fixture=createRecoverableJobServiceFixture(new URL('private/runtime.mjs',root).href);assert.equal(fixture['service.js'],starter);assert(!Object.keys(fixture).some(p=>/reference|alternate|controls|scenarios|broker|oracle/.test(p)));assert(!fixture['public-test.mjs'].includes('__RJS_'));assert(!fixture['verify.mjs'].includes('__RJS_'));
 const verifierResult=toVerifierResult(result),sizes=measure(result);
 await save('reference-diagnostics.json',result);await save('reference-verifier-result.json',verifierResult);await save('byte-sizes.json',{...sizes,privateReplay:privateSizes});assert(sizes.verifierFile<8*1024*1024,'full outer verifier file fits 8 MiB');
 const qualification={qualifiedAt:new Date().toISOString(),evidenceDirectory:attempt,reference:result,referenceMs,measuredFamilyMs,executionPairs:executions,variantComparisonCount:mutations.length,mutationResults:mutations,independentCorrectControl:'controller-owned opaque gate; not evaluated here',repeatFamilies:repeat.families.map((f:{id:string})=>f.id),byteSizes:sizes,privateReplayByteSizes:privateSizes};
 const ledger={suiteHash:result.suiteHash,contractHash:result.contractHash,candidateHash:result.candidateHash,provenance:result.provenance,executionPairs:executions,rows:mutations};
 await save('qualification-results.json',qualification);await save('variant-ledger.json',ledger);
 assert.deepEqual(await manifest(),before,'Qualification source remained immutable before canonical publication');
 await writeFile(new URL('private/qualification-results.json',root),JSON.stringify(qualification,null,2)+'\n');await writeFile(new URL('private/variant-ledger.json',root),JSON.stringify(ledger,null,2)+'\n');
 console.log('Diagnostics, repeatability, submission boundary and generated assets: pass. Full diagnostic byte sizes: '+JSON.stringify(sizes));
}catch(error){await save('failure.json',{message:error instanceof Error?error.message:String(error),privateRecordCount:privateSizes.length});throw error;}
finally{const after=await manifest();await save('source-after.json',after);assert.deepEqual(after,before,'Qualification source remained immutable for the complete command');}

