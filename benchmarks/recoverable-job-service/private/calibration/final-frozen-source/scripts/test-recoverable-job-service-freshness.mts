import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {contractPaths,suitePaths,scoreInputHashes} from '../benchmarks/recoverable-job-service/private/identity.mjs';
import {RECOVERABLE_JOB_SERVICE_INPUT_HASHES,RECOVERABLE_JOB_SERVICE_PRODUCTION_PROVENANCE} from '../lib/benchmark/workbench/recoverable-job-service/assets.generated';
import {effectiveProvenance} from '../benchmarks/recoverable-job-service/private/provenance.mjs';
const root=new URL('../',import.meta.url),base=new URL('benchmarks/recoverable-job-service/',root);
assert.deepEqual(await scoreInputHashes(),RECOVERABLE_JOB_SERVICE_INPUT_HASHES);
assert.deepEqual(effectiveProvenance(),RECOVERABLE_JOB_SERVICE_PRODUCTION_PROVENANCE);
for(const name of ['problem.md','acceptance-contract.md','runtime-contract.md'])assert.equal(await readFile(new URL('public/'+name,base),'utf8'),await readFile(new URL('docs/benchmarks/recoverable-job-service/'+name,root),'utf8'));
const lock=JSON.parse(await readFile(new URL('package-lock.json',root),'utf8')),pinned=JSON.parse(await readFile(new URL('private/dependency-provenance.json',base),'utf8'));
assert.equal(process.versions.node,pinned.node);for(const [path,entry] of Object.entries(pinned.packages)){assert.deepEqual(lock.packages[path],entry,path+' lock integrity');assert.equal(JSON.parse(await readFile(new URL(path+'/package.json',root),'utf8')).version,(entry as {version:string}).version);}
const allowed=new Set([...contractPaths,...suitePaths]);for(const path of suitePaths.filter((p:string)=>p.endsWith('.mjs'))){const source=await readFile(new URL(path,base),'utf8');for(const match of source.matchAll(/from ['"]([^'"]+)['"]/g)){const spec=match[1];if(!spec.startsWith('.'))continue;const relative=new URL(spec,new URL(path,base)).href.slice(base.href.length);assert(allowed.has(relative),path+' imports unshipped '+relative);}assert(!/independent-control|reference\.js|[\/\'"]controls\.mjs|source-controls\.mjs|qualification-map/.test(source),path+' excludes candidate/control sources');}
console.log('Pinned installed dependency closure, mirrored public docs, generated hashes/provenance and complete trusted runtime import allowlist: pass.');
