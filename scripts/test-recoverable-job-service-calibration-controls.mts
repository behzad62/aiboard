import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {controlDefinitions, createCalibrationControl, referenceSha256} from '../benchmarks/recoverable-job-service/private/calibration/controls.mjs';
import {scoreInputHashes} from '../benchmarks/recoverable-job-service/private/identity.mjs';
import {evaluateBounded, createReplayInput, replayInputFromRecord} from '../benchmarks/recoverable-job-service/private/runtime.mjs';

// Construction only. Emitted scripts remain QuickJS guest input, never imports.
const base='benchmarks/recoverable-job-service/private';
const output=join(base,'calibration/complete-controls');
await mkdir(output,{recursive:true});
const reference=await readFile(join(base,'reference.js'),'utf8');
const files=[];
for(const definition of controlDefinitions){
 const generated=createCalibrationControl(definition.id,reference);
 assert(generated.bytes<=1048576);
 await writeFile(join(output,definition.id+'.js'),generated.source);
 files.push({...definition,sha256:generated.sha256,bytes:generated.bytes,path:join(output,definition.id+'.js')});
}
const manifest={schemaVersion:1,status:'constructed complete reference-derived controls; not qualified',referenceSha256,
 scorerIdentity:await scoreInputHashes(),controls:files,scope:'Three full control sources; no substitute for the unchanged full302 runs and actual lawful/forbidden probes.'};
await writeFile(join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify(manifest,null,2));
if(process.argv.includes('--probe')){
 const evidence=join(base,'calibration/control-probe-'+new Date().toISOString().replace(/[:.]/g,'-'));
 await mkdir(evidence,{recursive:true});
 const save=(name:string,value:unknown)=>writeFile(join(evidence,name),JSON.stringify(value,null,2)+'\n');
 const replayInput=createReplayInput();await save('replay-input.private.json',replayInput);
 const variantIds=['C01/primary','C09/restore-store.commit.before','C09/restore-store.commit.after','E02/primary','B06/primary','B06/deadline-driver.attach.before','B07/acquire-intent-isolation','B07/acquire-intent-channel','B07/issued-driver.attach.before','B07/resource-intent-reader','B10/primary','B17/source-both','B17/source-pristine-early','B17/source-changed-ack','B17/source-pending-ack-stdout','B17/source-unknown-ack-stderr','B17/source-consumer-unknown','A07/invalid-stream','A07/invalid-seq','E08/primary'];
 const results=[];
 for(const control of files){
  const source=await readFile(control.path,'utf8');await writeFile(join(evidence,control.id+'.js'),source);
  let tape:any;const result=await evaluateBounded(source,{variantIds,replayInput,onReplayRecord(value:any){tape=value;}});
  assert.deepEqual(replayInputFromRecord(tape),replayInput);
  await save(control.id+'.replay.private.json',tape);await save(control.id+'.result.json',result);
  const rows=result.families.flatMap((f:any)=>f.variants);
  const summary={id:control.id,sha256:control.sha256,status:result.status,selected:rows.length,pass:rows.filter((r:any)=>r.passed).length,
   skipped:rows.filter((r:any)=>!r.safetyChecked).length,failed:rows.filter((r:any)=>!r.passed).map((r:any)=>({id:r.id,reason:r.reason})),safety:result.safetyFailures};
  results.push(summary);console.log(JSON.stringify(summary));
 }
 const summary={purpose:'Initial complete-control construction probes; not full qualification',evidence,identity:await scoreInputHashes(),variantIds,results};
 await save('summary.json',summary);console.log(JSON.stringify({evidence},null,2));
 assert(results.every(r=>r.status==='valid'&&r.pass===variantIds.length&&r.skipped===0),'complete controls reach and pass their initial real predicates');
}
