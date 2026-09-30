import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const base='benchmarks/recoverable-job-service/public/';
const types=await readFile(base+'contract.d.ts','utf8');
assert.match(types,/interface SourceObservation/,'published source observation type');
assert.match(types,/sourceGuards\?:SourceGuard\[\]/,'published atomic source guard');
assert.match(types,/version:3/,'EvidenceV3');
assert.match(types,/format:3/,'Capsule3');
const grammar=await readFile(base+'source-bootstrap.md','utf8');
for(const word of ['sourcePrelude','sourceState','sourceAckOutcome','source-observation.claim','invalid_harness','source-prefix-unavailable'])assert.ok(grammar.includes(word),word);
const variants=JSON.parse(await readFile(base+'source-variants.json','utf8'));
assert.equal(new Set(variants.map((v:any)=>v.id)).size,variants.length);
assert.ok(variants.every((v:any)=>v.family==='B17'&&v.outcomes.length&&v.boundary));
for(const name of ['runtime-contract.md','problem.md','acceptance-contract.md']){
 const text=await readFile(base+name,'utf8');
 assert.ok(!text.includes('\uFFFD'),'readable '+name);
 assert.ok(text.includes('source-bootstrap.md'),'linked normative source rule '+name);
 assert.equal(text,await readFile('docs/benchmarks/recoverable-job-service/'+name,'utf8'),'canonical mirror '+name);
}
console.log('Published source types, closed grammar, concrete variants and mirrors verified.');
