import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {scoreInputHashes,contractPaths,suitePaths} from '../benchmarks/recoverable-job-service/private/identity.mjs';
import {effectiveProvenance} from '../benchmarks/recoverable-job-service/private/provenance.mjs';
import {CONTRACT_VERSION,SUITE_VERSION} from '../benchmarks/recoverable-job-service/private/evaluator.mjs';
import {LIMITS} from '../benchmarks/recoverable-job-service/private/broker.mjs';

const p='.superpowers/sdd/2026-09-08-recoverable-job-service-integration',base='benchmarks/recoverable-job-service',cal=base+'/private/calibration';
const sha=(s:Buffer|string)=>createHash('sha256').update(s).digest('hex');
const file=async(path:string)=>{const bytes=await readFile(path);return {path:path.replaceAll('\\','/'),bytes:bytes.length,sha256:sha(bytes)};};
const json=async(path:string)=>JSON.parse((await readFile(path,'utf8')).replace(/^\uFEFF/,''));
const producerPath=p+'/task-2-integration-assertion-source-freeze-reviewed.json',producer=await json(producerPath);
assert.equal((await file(producerPath)).sha256,'80357ec3ab38a59738a74113fe4e2890c5ee53291f1be1868b6c96d0863c4f9e');
const c09Review=p+'/calibration-c09-digest-fix-review.md';
assert.equal((await file(c09Review)).sha256,'af207b7a7877b5cfe325f49ac51c936e2e476896bff808a9a93e58b8538a765b');
const allowed=new Set(['private/scenarios.mjs','private/variants.mjs','private/control-expectations.json','private/evaluator.mjs','private/generate-assets.mjs','public/acceptance-contract.md','public/runtime-contract.md','public/source-bootstrap.md'].map(x=>base+'/'+x).concat(['docs/benchmarks/recoverable-job-service/acceptance-contract.md','docs/benchmarks/recoverable-job-service/runtime-contract.md','docs/benchmarks/recoverable-job-service/source-bootstrap.md','lib/benchmark/workbench/recoverable-job-service/assets.generated.ts']));
const producerFiles=[];
for(const entry of producer.files){const current=await file(entry.path);if(!allowed.has(entry.path))assert.equal(current.sha256,entry.sha256,'preserve unrelated producer/UI/Runner/dependency file: '+entry.path);producerFiles.push({...current,originalSha256:entry.sha256,changed:current.sha256!==entry.sha256});}
assert.equal(producerFiles.length,80);
assert.equal((await file(base+'/private/reference.js')).sha256,'6a5b142037c60fb9ab480ccd64f307f556685be755878df0aa1ec39d3ceb1cf0');
assert.equal((await file(base+'/private/variants.mjs')).sha256,'d9fcbcc03a32b9c6ed1cb9fd46b38c8ebe814d0b5829fccb02ae16cee05c814e');
assert.equal(CONTRACT_VERSION,'rjs-contract-2.0.1');assert.equal(SUITE_VERSION,'rjs-suite-2.0.1');
const identity=await scoreInputHashes(),provenance=effectiveProvenance();
assert.equal(provenance.variantIds.length,302);assert.equal(provenance.largeCount,1025);assert.equal(LIMITS.operations,100000);assert.equal(LIMITS.promiseJobs,1000000);assert.equal(LIMITS.scan,64);
const ledger=await json(cal+'/predicate-dependency-ledger-final.json'),plan=await json(cal+'/probe-plan-final.json'),controls=await json(cal+'/complete-controls/manifest.json');
assert.equal(ledger.counts.variants,302);assert.equal(ledger.counts.families,69);assert.equal(ledger.counts.materialGroups,61);assert.equal(ledger.probeClasses.length,8);
assert.deepEqual(plan.scorerIdentity,identity);assert.deepEqual(controls.scorerIdentity,identity);assert.equal(plan.classes.length,8);assert.equal(controls.controls.length,3);
for(const control of controls.controls)assert.equal((await file(control.path)).sha256,control.sha256);
const metadata=await json(cal+'/qualification-metadata.json');assert.equal(metadata.method,'rjs-simplification-audit-1');assert.equal(metadata.status,'pending');assert.equal(metadata.admission,'pending');
const paths=new Set<string>(producer.files.map((f:any)=>f.path));
for(const name of await readdir('scripts'))if(name.startsWith('test-recoverable-job-service-calibration')&&name.endsWith('.mts'))paths.add('scripts/'+name);
for(const name of ['controls.mjs','probe-runtime.mjs','forbidden-neighbors.mjs','qualification-metadata.json','predicate-dependency-ledger-final.json','probe-plan-final.json','source-helper-evidence.json','complete-controls/manifest.json','complete-controls/representation.js','complete-controls/algorithm.js','complete-controls/truthful-outcome.js'])paths.add(cal+'/'+name);
// A raw helper is new producer support outside the original 80-file manifest.
paths.add('scripts/test-recoverable-job-service-delayed-source-ack.mts');
const sources=await Promise.all([...paths].sort().map(file));
const snapshots=[];
for(const entry of sources){const path=join(cal,'final-frozen-source',entry.path);await mkdir(dirname(path),{recursive:true});await copyFile(entry.path,path);snapshots.push(await file(path));}
const manifest={schemaVersion:1,status:'Final source/public/probe freeze; mandatory runtime qualification and independent CAL01-05 acceptance pending',frozenAt:new Date().toISOString(),
 identity,versions:{contract:CONTRACT_VERSION,suite:SUITE_VERSION},method:metadata.method,metadata,
 node:process.versions.node,quickjs:'0.32.0',configured:{limits:LIMITS,production:provenance,separateSelectedCapacity:1100},
 producer:await file(producerPath),producerFiles,changedProducerFiles:producerFiles.filter(f=>f.changed),
 acceptedScopedReviews:[await file(p+'/calibration-correction-review.md'),await file(c09Review)],
 preservedScopedFreezes:[await file(cal+'/audit-source-freeze.json'),await file(cal+'/correction-source-freeze.json'),await file(cal+'/c09-digest-fix-source-freeze.json')],
 versionRefresh:await file(cal+'/before-final-version/manifest.json'),ledger:await file(cal+'/predicate-dependency-ledger-final.json'),probePlan:await file(cal+'/probe-plan-final.json'),controlManifest:await file(cal+'/complete-controls/manifest.json'),helperEvidence:await file(cal+'/source-helper-evidence.json'),
 exactPublicAllowlist:await Promise.all(contractPaths.map((path:string)=>file(base+'/'+path))),trustedSuitePaths:suitePaths,
 sources,snapshots};
assert.equal(manifest.exactPublicAllowlist.length,11);
const output=cal+'/final-source-freeze.json';await writeFile(output,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({freeze:await file(output),identity,versions:manifest.versions,sourceCount:sources.length,changedProducerFiles:manifest.changedProducerFiles.map(f=>f.path),controls:controls.controls.map((c:any)=>({id:c.id,sha256:c.sha256})),ledger:manifest.ledger,probePlan:manifest.probePlan,publicFiles:manifest.exactPublicAllowlist.length},null,2));
