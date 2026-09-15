import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const base='.superpowers/sdd/2026-09-11-p6-completion/task10-filesystem-fence';
const json=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const save=(name,value)=>fs.writeFileSync(base+'/'+name,JSON.stringify(value,null,2)+'\n',{flag:'wx'});
const frozen=json(base+'/finish-source-freeze.json');
for(const input of frozen.sourceHashes)assert.equal(sha(input.path),input.sha256,input.path);
const currentIds=['finish-main','finish-bootstrap','finish-typescript','finish-eslint','finish-diff','finish-fixture-regression'];
const causalIds=['final-causal/fault-final-controls-green','final-causal/fault-canonicalization-restored-green','final-causal/fault-overwrite-restored-green'];
const accepted=[...currentIds,...causalIds];
const runs=accepted.map(id=>{
  const dir=base+'/'+id,terminal=json(dir+'/terminal.json');
  assert.equal(terminal.exitCode,0,id);assert.equal(terminal.inputsUnchanged,true,id);assert.deepEqual(terminal.retainedRoots,[],id);
  const before=json(dir+'/inputs-before.json'),after=json(dir+'/inputs-after.json');assert.deepEqual(before,after,id);
  const scopedReuse=causalIds.includes(id);
  for(const input of before.filter(x=>x.path.startsWith('runner-v2/'))){
    // The only later change is an unrelated test file, not imported by these fence-only causal tests.
    if(scopedReuse&&input.path==='runner-v2/test/integration-manager.test.ts')continue;
    assert.equal(sha(input.path),input.sha256,id+':'+input.path);
  }
  for(const input of frozen.sourceHashes){
    if(scopedReuse&&input.path==='runner-v2/test/integration-manager.test.ts')continue;
    assert.equal(before.find(x=>x.path===input.path)?.sha256,input.sha256,id+':'+input.path);
  }
  if(scopedReuse)assert.deepEqual(terminal.command.slice(-1),['runner-v2/test/filesystem-mutation-fence.test.ts']);
  const roots=json(dir+'/roots.json').roots.map(root=>({path:path.normalize(root.path),exists:fs.existsSync(root.path)}));
  assert.ok(roots.every(root=>!root.exists),id+': retained root');
  const text=fs.readFileSync(dir+'/stdout.log','utf8');
  const totals=Object.fromEntries(['tests','pass','fail','cancelled','skipped'].map(key=>[key,text.match(new RegExp('^# '+key+' (\\d+)$','m'))?.[1]])
    .filter(([,value])=>value!==undefined).map(([key,value])=>[key,Number(value)]));
  if(totals.tests!==undefined){assert.equal(totals.tests,totals.pass,id);for(const key of ['fail','cancelled','skipped'])assert.equal(totals[key],0,id);}
  return {id,...totals,rootCount:roots.length,receiptSha256:sha(dir+'/terminal.json'),inputManifestSha256:sha(dir+'/inputs-before.json'),roots,
    ...(scopedReuse?{reuseScope:'Exact unchanged fence and dependency bytes; only integration-manager.test.ts differs, and is not imported by this causal command.'}:{})};
});
const causal=json(base+'/final-causal/causal-reverse-fault.json');
assert.equal(causal.verified,true);assert.equal(causal.finalSourceSha256,sha('runner-v2/src/filesystem-mutation-fence.ts'));
for(const fault of causal.faults){
  assert.equal(fault.restoredSha256,causal.acceptedSha256);assert.equal(fault.violationBytesConfirmed,true);
  assert.equal(sha(fault.violation),fault.violationSha256,'Retained causal violation');
  const dir=base+'/final-causal/'+fault.redRun,red=json(dir+'/terminal.json');
  assert.equal(red.exitCode,1);assert.equal(red.inputsUnchanged,true);
  assert.deepEqual(json(dir+'/inputs-before.json'),json(dir+'/inputs-after.json'));
  assert.equal(json(dir+'/inputs-before.json').find(x=>x.path==='runner-v2/src/filesystem-mutation-fence.ts').sha256,fault.faultySha256);
}
for(const id of ['review-4','review-fixture']){
  const r=json(base+'/'+id+'/terminal.json');assert.equal(r.exitCode,0);assert.equal(r.inputsUnchanged,true);assert.deepEqual(r.tools,[]);
  for(const input of json(base+'/'+id+'/inputs.json'))assert.equal(sha(input.path),input.sha256,input.path);
  assert.equal(json(base+'/'+id+'/stdout.json').is_error,false);
}
const repair=json(base+'/integration-fixture-repair.json');assert.equal(sha(repair.source),repair.repairedSha256);
const walk=p=>fs.readdirSync(p,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(p+'/'+e.name):[p+'/'+e.name]);
const history=walk(base).filter(p=>p.endsWith('/terminal.json')).map(p=>{
  const r=json(p);if(!Array.isArray(r.retainedRoots))return null;
  const id=path.relative(base,path.dirname(p)).replaceAll('\\','/');
  return {id,exitCode:r.exitCode,inputsUnchanged:r.inputsUnchanged,
    classification:accepted.includes(id)?'ACCEPTED_GREEN':r.exitCode!==0?'RED_FAILED_DIAGNOSTIC':r.retainedRoots.length?'PASSING_ASSERTIONS_WITH_RETAINED_DIAGNOSTIC':'HISTORICAL_GREEN',
    retainedAtReceipt:r.retainedRoots.map(p=>({path:path.normalize(p),existsNow:fs.existsSync(p)})),
    wrapperPid:r.wrapperPid,childPid:r.testPid,startedAt:r.startedAt,finishedAt:r.finishedAt};
}).filter(Boolean);
const result={time:new Date().toISOString(),verified:true,sourceInputs:frozen.sourceHashes,
  affectedTests:runs.filter(r=>['finish-main','finish-bootstrap'].includes(r.id)).reduce((n,r)=>n+r.tests,0),
  acceptedRoots:runs.reduce((n,r)=>n+r.rootCount,0),runs,history,
  sourceFreezeSha256:sha(base+'/finish-source-freeze.json'),causalSha256:sha(base+'/final-causal/causal-reverse-fault.json'),
  reviewHashes:['review-4','review-fixture'].map(id=>({id,sha256:sha(base+'/'+id+'/stdout.json')})),
  note:'Only named GREEN cohorts are accepted. Earlier failed, deliberately weakened and intentionally retained diagnostic runs remain separately classified; process audit is separate. No root is deleted by this audit.'};
save('finish-acceptance-audit.json',result);
console.log(JSON.stringify({...result,sourceInputs:result.sourceInputs.length,runs:runs.map(({roots,...r})=>r),history:history.length},null,2));
