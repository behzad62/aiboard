import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const base = '.superpowers/sdd/2026-09-11-p6-completion/task10-filesystem-fence';
const json = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const sha = p => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const frozen = json(base + '/final-source-freeze.json');
for (const input of frozen.sourceHashes) assert.equal(sha(input.path), input.sha256, input.path);
const accepted = ['acceptance-main','acceptance-bootstrap','acceptance-typescript','acceptance-eslint','acceptance-diff',
  'final-causal/fault-final-controls-green','final-causal/fault-canonicalization-restored-green','final-causal/fault-overwrite-restored-green'];
const runs = accepted.map(id => {
  const dir = base + '/' + id, terminal = json(dir + '/terminal.json');
  assert.equal(terminal.exitCode, 0, id); assert.equal(terminal.inputsUnchanged, true, id);
  assert.deepEqual(terminal.retainedRoots, [], id);
  const before = json(dir + '/inputs-before.json'), after = json(dir + '/inputs-after.json');
  assert.deepEqual(before, after, id);
  for (const input of frozen.sourceHashes) assert.equal(before.find(x => x.path === input.path)?.sha256, input.sha256, id + ':' + input.path);
  const roots = json(dir + '/roots.json').roots.map(root => ({path:path.normalize(root.path), exists:fs.existsSync(root.path)}));
  assert.ok(roots.every(root => !root.exists), id + ': retained owned root');
  const text = fs.readFileSync(dir + '/stdout.log', 'utf8');
  const totals = Object.fromEntries(['tests','pass','fail','cancelled','skipped'].map(key => [key, text.match(new RegExp('^# ' + key + ' (\\d+)$','m'))?.[1]]).filter(([,value]) => value !== undefined).map(([key,value]) => [key, Number(value)]));
  if (totals.tests !== undefined) { assert.equal(totals.tests, totals.pass, id); assert.equal(totals.fail,0,id); assert.equal(totals.cancelled,0,id); assert.equal(totals.skipped,0,id); }
  return {id, ...totals, rootCount:roots.length, receiptSha256:sha(dir+'/terminal.json'), inputManifestSha256:sha(dir+'/inputs-before.json'), roots};
});
const causal = json(base + '/final-causal/causal-reverse-fault.json');
assert.equal(causal.verified, true); assert.equal(causal.finalSourceSha256, sha('runner-v2/src/filesystem-mutation-fence.ts'));
for (const fault of causal.faults) {
  assert.equal(fault.restoredSha256, causal.acceptedSha256); assert.equal(fault.violationBytesConfirmed,true);
  assert.equal(sha(fault.violation), fault.violationSha256, 'Preserved causal violation');
}
const review = json(base + '/review-4/terminal.json');
assert.equal(review.exitCode,0); assert.equal(review.inputsUnchanged,true); assert.deepEqual(review.tools,[]);
for (const input of json(base + '/review-4/inputs.json')) assert.equal(sha(input.path),input.sha256,input.path);
const walk = p => fs.readdirSync(p,{withFileTypes:true}).flatMap(e => e.isDirectory() ? walk(p+'/'+e.name) : [p+'/'+e.name]);
const history = walk(base).filter(p => p.endsWith('/terminal.json')).map(p => {
  const terminal=json(p); if(!Array.isArray(terminal.retainedRoots))return null;
  const id=path.relative(base,path.dirname(p)).replaceAll('\\','/');
  const isAccepted=accepted.includes(id);
  return {id,exitCode:terminal.exitCode,inputsUnchanged:terminal.inputsUnchanged,
    classification:isAccepted?'ACCEPTED_GREEN':terminal.exitCode!==0?'RED_FAILED_DIAGNOSTIC':terminal.retainedRoots.length?'PASSING_ASSERTIONS_WITH_RETAINED_DIAGNOSTIC':'HISTORICAL_GREEN',
    retainedAtReceipt:terminal.retainedRoots.map(p => ({path:path.normalize(p),existsNow:fs.existsSync(p)})),
    wrapperPid:terminal.wrapperPid,childPid:terminal.testPid,startedAt:terminal.startedAt,finishedAt:terminal.finishedAt};
}).filter(Boolean);
const result={time:new Date().toISOString(),verified:true,sourceInputs:frozen.sourceHashes,
  affectedTests:runs.filter(r=>r.id==='acceptance-main'||r.id==='acceptance-bootstrap').reduce((sum,r)=>sum+r.tests,0),
  acceptedRoots:runs.reduce((sum,r)=>sum+r.rootCount,0),runs,causalSha256:sha(base+'/final-causal/causal-reverse-fault.json'),
  finalReviewSha256:sha(base+'/review-4/stdout.json'),history,
  note:'Accepted GREEN is separate from preserved RED/failed/intentional diagnostic cohorts. Absence observations supplement, not replace, fixture-owned closure assertions. Process audit is a separate receipt.'};
fs.writeFileSync(base+'/acceptance-audit.json',JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({...result,sourceInputs:result.sourceInputs.length,runs:runs.map(({roots,...run})=>run),history:history.length},null,2));
