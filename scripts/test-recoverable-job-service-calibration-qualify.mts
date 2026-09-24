import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {evaluateBounded, createReplayInput, replayInputFromRecord, toVerifierResult} from '../benchmarks/recoverable-job-service/private/runtime.mjs';
import {scoreInputHashes} from '../benchmarks/recoverable-job-service/private/identity.mjs';

// Full unchanged production positives for the three complete private controls.
// Every source is read as QuickJS data; no candidate module is imported by Node.
const cal = 'benchmarks/recoverable-job-service/private/calibration';
const freezePath = cal + '/final-source-freeze.json';
const freeze = JSON.parse(await readFile(freezePath, 'utf8'));
const identity = await scoreInputHashes(); assert.deepEqual(identity, freeze.identity);
const sha = (s: Buffer | string) => createHash('sha256').update(s).digest('hex');
async function verifyFreeze() {for (const entry of freeze.sources) assert.equal(sha(await readFile(entry.path)), entry.sha256, 'frozen qualification source: ' + entry.path);}
await verifyFreeze();
const manifest = JSON.parse(await readFile(cal + '/complete-controls/manifest.json', 'utf8'));
assert.equal(manifest.controls.length, 3); assert.deepEqual(manifest.scorerIdentity, identity);
const output = cal + '/qualification-' + new Date().toISOString().replace(/[:.]/g, '-');
await mkdir(output, {recursive: true});
const save = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n');
const replayInput = createReplayInput(); await save('replay-input.private.json', replayInput);
const rows = (r: any) => r.families.flatMap((f: any) => f.variants);
const controls: any[] = [];
console.log('Complete-control qualification evidence: ' + output);
for (const control of manifest.controls) {
 const source = await readFile(control.path, 'utf8'); assert.equal(sha(source), control.sha256); await writeFile(join(output, control.id + '.js'), source);
 let tape: any; const startedAt = new Date().toISOString(), started = Date.now();
 const result = await evaluateBounded(source, {replayInput, onReplayRecord(value: any) {tape = value;}, onFamily(family: any) {console.log(control.id + ' ' + family.id + ' ' + (family.passed ? 'pass' : 'FAIL ' + family.reason));}});
 assert.deepEqual(replayInputFromRecord(tape), replayInput);
 await save(control.id + '.replay.private.json', tape); await save(control.id + '.result.json', result); await save(control.id + '.verifier-result.json', toVerifierResult(result));
 assert.equal(result.candidateHash, control.sha256); assert.equal(result.contractHash, identity.contractHash); assert.equal(result.suiteHash, identity.suiteHash);
 const summary = {id: control.id, sha256: control.sha256, sourceBytes: Buffer.byteLength(source), startedAt, endedAt: new Date().toISOString(), wallMs: Date.now() - started,
  status: result.status, resolved: result.resolved, families: result.families.length, selected: rows(result).length, pass: rows(result).filter((v: any) => v.passed).length,
  skip: rows(result).filter((v: any) => !v.safetyChecked).length, safetyFailures: result.safetyFailures,
  failed: rows(result).filter((v: any) => !v.passed).map((v: any) => ({id: v.id, reason: v.reason})),
  measured: {operations: rows(result).reduce((n: number, v: any) => n + v.operations, 0), promiseJobs: rows(result).reduce((n: number, v: any) => n + v.promiseJobs, 0), maxOperations: Math.max(...rows(result).map((v: any) => v.operations)), maxPromiseJobs: Math.max(...rows(result).map((v: any) => v.promiseJobs)), diagnosticsBytes: Buffer.byteLength(JSON.stringify(result)), replayBytes: Buffer.byteLength(JSON.stringify(tape))},
  cleanup: 'evaluateBounded returned after worker termination and validated temporary-root cleanup'};
 controls.push(summary); await save('controls-progress.json', controls); console.log(JSON.stringify(summary));
}
let publicRecipes: any = null;
if (controls.find(c => c.id === 'algorithm')?.resolved) {
 const source = await readFile(join(output, 'algorithm.js'), 'utf8'); let tape: any;
 const result = await evaluateBounded(source, {mode: 'public', publicExamples: true, seed: 'public-example-1', replayInput, onReplayRecord(value: any) {tape = value;}});
 await save('algorithm-public.result.json', result); await save('algorithm-public.replay.private.json', tape);
 publicRecipes = {status: result.status, selected: result.families.length, pass: result.families.filter((f: any) => f.passed).length,
  failed: result.families.filter((f: any) => !f.passed), scope: 'Existing 78 published example recipes; no production pass is inferred from public mode.'};
 console.log(JSON.stringify({publicRecipes}));
}
await verifyFreeze(); assert.deepEqual(await scoreInputHashes(), identity);
const passed = controls.every(c => c.status === 'valid' && c.resolved && c.families === 69 && c.selected === 302 && c.pass === 302 && c.skip === 0 && c.safetyFailures.length === 0) && publicRecipes?.selected === 78 && publicRecipes?.pass === 78;
await save('summary.json', {schemaVersion: 1, purpose: 'Final frozen full alternate positives and selected public recipes; controller admission pending', output, identity,
 freeze: {path: freezePath, sha256: sha(await readFile(freezePath))}, node: process.versions.node, quickjs: '0.32.0', replayCommitment: replayInput.commitment,
 controls, publicRecipes, passed});
console.log(JSON.stringify({output, passed}, null, 2));
assert(passed, 'all complete controls must pass the unchanged full production suite and selected public recipes');
