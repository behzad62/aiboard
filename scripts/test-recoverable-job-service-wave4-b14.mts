import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {evaluateBounded,replayInputFromRecord,toVerifierResult} from '../benchmarks/recoverable-job-service/private/runtime.mjs';
import {controls} from '../benchmarks/recoverable-job-service/private/controls.mjs';
import {compareExecutedInputs} from '../benchmarks/recoverable-job-service/private/replay-comparison.mjs';
import {matchesMaterialFailure} from '../benchmarks/recoverable-job-service/private/material-failure.mjs';
import {comparisonIdentity} from '../benchmarks/recoverable-job-service/private/qualification-provenance.mjs';
import {scoreInputHashes} from '../benchmarks/recoverable-job-service/private/identity.mjs';

assert.equal(process.versions.node,'24.18.0');
const packet='.superpowers/sdd/2026-09-08-recoverable-job-service-integration';
const source=await readFile('benchmarks/recoverable-job-service/private/reference.js','utf8');
const sha=(bytes:any)=>createHash('sha256').update(bytes).digest('hex');
if(process.argv[2]==='child-a02'){
 const input=replayInputFromRecord(JSON.parse(await readFile(process.argv[3],'utf8')));let record:any;
 const result=await evaluateBounded(source,{families:['A02'],variantIds:['A02/primary'],replayInput:input,onReplayRecord:(r:any)=>record=r});
 await writeFile(process.argv[4],JSON.stringify(record));await writeFile(process.argv[5],JSON.stringify(result,null,2)+'\n');
 assert.equal(result.status,'valid');assert.equal(result.families[0].passed,true);
}else{
 const stamp=new Date().toISOString().replaceAll(':','-'),evidence=packet+'/task-2-wave4-b14-'+stamp,privateDir=packet+'/task-2-wave4-private-replay-'+stamp;
 await mkdir(evidence);await mkdir(privateDir);
 const save=(name:string,data:any)=>writeFile(evidence+'/'+name,JSON.stringify(data,null,2)+'\n');
 const savePrivate=(name:string,data:any)=>writeFile(privateDir+'/'+name,JSON.stringify(data,null,2)+'\n');
 // Reuse the actual wave3 watchdog/profile root; its bytes remain only in this private channel.
 const replayInput=replayInputFromRecord(JSON.parse(await readFile(packet+'/task-2-wave3-b14-profile-private-record.json','utf8')));
 await savePrivate('input.json',replayInput);
 const before=await scoreInputHashes(),sourceIdentity={...before,referenceHash:sha(source),brokerHash:sha(await readFile('benchmarks/recoverable-job-service/private/broker.mjs')),driverHash:sha(await readFile(import.meta.filename)),node:process.versions.node};
 await save('source-before.json',sourceIdentity);
 const results:any={};const records:any={};const inputs:any={};const sizes:any[]=[];
 try{
  for(const phase of ['positive','negative','restored']){
   const candidate=phase==='negative'?controls['truncate-scan'].mutate(source):source,actualInputs:any[]=[];let record:any;
   const began=performance.now();
   const diagnostics=await evaluateBounded(candidate,{families:['B14'],variantIds:['B14/primary'],replayInput,onVariantStart:(v:any)=>actualInputs.push(v),onReplayRecord:(r:any)=>record=r});
   const elapsedMs=Math.round(performance.now()-began),row=diagnostics.families.find((f:any)=>f.id==='B14')?.variants.find((v:any)=>v.id==='B14/primary');
   results[phase]={elapsedMs,diagnostics,actualInputs};records[phase]=record;inputs[phase]=actualInputs;
   // Preserve both actual channels before any comparison/assertion can fail.
   await save(phase+'.json',results[phase]);await savePrivate(phase+'.json',record);
   sizes.push({phase,diagnosticsCompact:Buffer.byteLength(JSON.stringify(diagnostics)),outerCompact:Buffer.byteLength(JSON.stringify(toVerifierResult(diagnostics))),outerPrettyFile:Buffer.byteLength(JSON.stringify(toVerifierResult(diagnostics),null,2)+'\n'),privateCompact:Buffer.byteLength(JSON.stringify(record)),privatePrettyFile:Buffer.byteLength(JSON.stringify(record,null,2)+'\n')});
   await save('byte-sizes.json',sizes);
   console.log('B14 '+phase+': '+JSON.stringify({status:diagnostics.status,passed:row?.passed,reason:row?.reason,elapsedMs,operations:row?.operations,promiseJobs:row?.promiseJobs,completedCases:record?.cases?.length??0}));
   assert.equal(diagnostics.status,'valid',phase+' is a candidate result');
   assert.equal(diagnostics.provenance.largeCount,1025);assert.equal(diagnostics.provenance.familyWallMs,60000);assert.equal(diagnostics.provenance.operations,100000);assert.equal(diagnostics.provenance.promiseJobs,1000000);
   assert.equal(diagnostics.candidateHash,sha(candidate));
   if(phase==='negative')assert.ok(matchesMaterialFailure({id:'B14/primary'},row,{}),'unchanged truncation reaches exact complete-ownership failure or exact close refusal with close-owned-records safety witness');
   else{assert.equal(row.passed,true,phase+' full-size B14 passes');assert.equal(row.safetyChecked,true);assert.equal(diagnostics.safetyFailures.length,0);}
  }
  const positiveRow=results.positive.diagnostics.families[0].variants[0],negativeRow=results.negative.diagnostics.families[0].variants[0];
  const identity=comparisonIdentity(results.positive.diagnostics,inputs.positive[0]);
  for(const phase of ['negative','restored'])assert.deepEqual(comparisonIdentity(results[phase].diagnostics,inputs[phase][0]),identity,'actual corresponding runtime inputs match');
  const negative=compareExecutedInputs(records.positive,records.negative,'B14/primary'),restored=compareExecutedInputs(records.positive,records.restored,'B14/primary',{exact:true});
  assert.ok(negative.commonPrefixRequests>=1027,'all 1025 setup requests and traversal share the concrete causal inputs');
  await save('comparisons.json',{negative,restored,positiveOperations:positiveRow.operations,negativeReason:negativeRow.reason});
  let a02Record:any;const a02=await evaluateBounded(source,{families:['A02'],variantIds:['A02/primary'],replayInput,onReplayRecord:(r:any)=>a02Record=r});
  await savePrivate('a02-parent.json',a02Record);await save('a02-parent.json',a02);assert.equal(a02.families[0].passed,true);
  await new Promise<void>((ok,no)=>{const child=spawn(process.execPath,['--import','tsx',resolve(import.meta.filename),'child-a02',resolve(privateDir+'/a02-parent.json'),resolve(privateDir+'/a02-child.json'),resolve(evidence+'/a02-child.json')],{cwd:process.cwd(),stdio:['ignore','ignore','pipe'],windowsHide:true});let error='';child.stderr.on('data',b=>error+=b);child.on('error',no);child.on('exit',code=>code===0?ok():no(Error('Fresh-process replay child exit '+code+': '+error)));});
  const a02Comparison=compareExecutedInputs(a02Record,JSON.parse(await readFile(privateDir+'/a02-child.json','utf8')),'A02/primary',{exact:true});
  await save('a02-fresh-process-comparison.json',a02Comparison);
  console.log('B14 full positive/unchanged negative/restored actual input comparison and A02 fresh-process replay: pass. Evidence: '+evidence);
 }catch(error){await save('failure.json',{message:error instanceof Error?error.message:String(error),completedPhases:Object.keys(results)});throw error;}
 finally{const after={...await scoreInputHashes(),referenceHash:sha(await readFile('benchmarks/recoverable-job-service/private/reference.js')),brokerHash:sha(await readFile('benchmarks/recoverable-job-service/private/broker.mjs')),driverHash:sha(await readFile(import.meta.filename)),node:process.versions.node};await save('source-after.json',after);assert.deepEqual(after,sourceIdentity,'focused source remains unchanged');}
}
