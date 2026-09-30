import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {evaluateBounded, createReplayInput, replayInputFromRecord} from '../benchmarks/recoverable-job-service/private/runtime.mjs';
import {variants, exerciseVariant} from '../benchmarks/recoverable-job-service/private/variants.mjs';
import {controls} from '../benchmarks/recoverable-job-service/private/controls.mjs';
import {materialControl} from '../benchmarks/recoverable-job-service/private/qualification-map.mjs';
import {matchesMaterialFailure} from '../benchmarks/recoverable-job-service/private/material-failure.mjs';
import {Scenario, AssertionFailure} from '../benchmarks/recoverable-job-service/private/scenarios.mjs';
import {inspectSafety} from '../benchmarks/recoverable-job-service/private/oracle.mjs';
import {LIMITS, CandidateError} from '../benchmarks/recoverable-job-service/private/broker.mjs';
import {effectiveProvenance, schedulePlan} from '../benchmarks/recoverable-job-service/private/provenance.mjs';
import {PROFILE, CONTRACT_VERSION, SUITE_VERSION} from '../benchmarks/recoverable-job-service/private/evaluator.mjs';
import {scoreInputHashes} from '../benchmarks/recoverable-job-service/private/identity.mjs';

// Targeted public-predicate proof of the controller's coherent correction batch.
// Every source is guest data. No candidate source is imported or evaluated by Node.
const base = 'benchmarks/recoverable-job-service/private';
const reserveOnly = process.argv.includes('--reserve-only');
const output = join(base, 'calibration/correction-proof-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, {recursive: true});
const save = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n');
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const read = (name: string) => readFile(join(base, name), 'utf8');
const reference = await read('reference.js');
assert.equal(sha(reference), '6a5b142037c60fb9ab480ccd64f307f556685be755878df0aa1ec39d3ceb1cf0');
const sources: Record<string, string> = {
  reference,
  'setup-reader': await read('calibration/attachment-counterexample-2026-09-12T16-27-38-215Z/setup-reader.js'),
  'record-envelope': await read('calibration/representation-counterexample-2026-09-12T16-30-39-776Z/record-envelope.js'),
  'lazy-roots': await read('calibration/boundary-counterexamples-2026-09-12T16-40-10-274Z/lazy-roots.js'),
  'wrong-category': await read('calibration/boundary-counterexamples-2026-09-12T16-40-10-274Z/wrong-category.js'),
};
const wrap = (body: string) => reference + `\n{const original=createService;globalThis.createService=async(p,g)=>{const service=await original(p,g);${body};return service;};}\n`;
sources['range-integrity'] = wrap("const run=service.run.bind(service);service.run=async q=>{const r=await run(q);if(q.type==='poll'&&r.kind==='blocked')for(const b of r.blockers)if(b.code==='gap')b.code='integrity';return r;}");
for (const kind of ['expired', 'reserve']) sources['forbidden-attach-' + kind] = wrap(`const run=service.run.bind(service);service.run=async q=>{const now=await p.call('now');if(q.type==='stop'&&${kind === 'expired' ? 'now>=q.deadline' : 'now<q.deadline&&g.expiresAt<q.deadline+100'})await p.call('driver.attach',{jobId:q.jobId,privateReader:true,operationId:await p.call('newId'),fence:{grant:g,deadline:${kind === 'reserve' ? 'now+1' : 'Math.max(now+1,q.deadline)'}}});return run(q);}`);
for (const [name, source] of Object.entries(sources)) await writeFile(join(output, name + '.js'), source);
const identity = await scoreInputHashes();
const priorProofPath = join(base, 'calibration/correction-proof-2026-09-12T17-06-54-031Z/summary.json');
const priorProof = reserveOnly ? await readFile(priorProofPath, 'utf8') : null;
if (priorProof) assert.deepEqual(JSON.parse(priorProof).identity, identity, 'reused targeted proof has exactly unchanged scorer/public bytes');
const replayInput = createReplayInput();
await save('replay-input.private.json', replayInput); // Persist before the first execution.
const expected = JSON.parse(await read('control-expectations.json'));
const attachment = ['B01/recover-driver.attach.before', 'B06/deadline-driver.attach.before', 'B07/issued-driver.attach.before', 'B07/resource-intent-reader'];
const storage = ['C09/restore-store.commit.before', 'C09/restore-store.commit.after'];
const category = ['A07/invalid-stream', 'A07/invalid-digest', 'A07/invalid-artifactId', 'A07/invalid-channelId'];
const affected = [...attachment, ...storage, 'E02/primary', ...category];
const adjacent = ['A07/invalid-seq', 'A07/invalid-offset', 'A07/invalid-length', 'B06/primary', 'B10/primary', 'C01/primary', 'C09/primary', 'B13/primary', 'E03/primary', 'E08/primary', ...['isolation', 'process', 'channel', 'workload'].map(x => 'B07/acquire-intent-' + x)];
const impacted: Record<string, string[]> = {reference: affected, 'setup-reader': attachment, 'record-envelope': storage, 'lazy-roots': ['E02/primary']};
const rows = (r: any): any[] => r.families.flatMap((f: any) => f.variants);
const checks: {label: string; passed: boolean}[] = [];
const check = (condition: unknown, label: string) => checks.push({label, passed: !!condition});
const runs: any[] = [];
async function bounded(name: string, source: string, ids: string[], expectation: 'positive' | 'material' | string) {
  let tape: any;
  const started = Date.now();
  const result = await evaluateBounded(source, {variantIds: ids, replayInput, onReplayRecord(value: any) {tape = value;}});
  assert.deepEqual(replayInputFromRecord(tape), replayInput);
  await save(name + '.replay.private.json', tape);
  await save(name + '.result.json', result);
  check(result.status === 'valid', name + ': valid bounded execution');
  check(rows(result).length === ids.length && rows(result).every(v => v.safetyChecked), name + ': complete selected predicates');
  for (const row of rows(result)) {
    if (expectation === 'positive') check(row.passed, name + ': ' + row.id + ' passes');
    else if (expectation === 'material') {
      const variant = variants.find((v: any) => v.id === row.id);
      check(matchesMaterialFailure(variant, row, expected[row.id]), name + ': ' + row.id + ' intended material predicate');
      if (storage.includes(row.id)) check(row.assertions.some((a: any) => a.label.startsWith('candidate reached lawful store.commit.') && a.passed) && row.safetyFailures.some((f: any) => f.code === 'evidence-before-acceptance'), name + ': real restore boundary and missing-byte safety finding');
    } else check(!row.passed && row.assertions.some((a: any) => a.label === expectation && !a.passed), name + ': ' + row.id + ' exact forbidden predicate');
  }
  const summary = {name, sourceHash: sha(source), expectation, variantIds: ids, status: result.status,
    selected: rows(result).length, passed: rows(result).filter(v => v.passed).length,
    skipped: rows(result).filter(v => !v.safetyChecked).length, wallMs: Date.now() - started,
    operations: rows(result).reduce((n, v) => n + v.operations, 0), promiseJobs: rows(result).reduce((n, v) => n + v.promiseJobs, 0),
    failed: rows(result).filter(v => !v.passed).map(v => ({id: v.id, reason: v.reason, safety: v.safetyFailures}))};
  runs.push(summary); console.log(JSON.stringify(summary)); return result;
}
if (!reserveOnly) {
await bounded('reference-positive', reference, [...affected, ...adjacent], 'positive');
await bounded('setup-reader-positive', sources['setup-reader'], [...attachment, 'B06/primary', 'B10/primary'], 'positive');
await bounded('record-envelope-positive', sources['record-envelope'], [...storage, 'C01/primary', 'C09/primary'], 'positive');
await bounded('lazy-roots-positive', sources['lazy-roots'], ['E02/primary', 'C01/primary', 'E08/primary', 'B13/primary', 'E03/primary'], 'positive');
for (const [name, ids] of Object.entries(impacted)) {
  const groups = new Map<string, string[]>();
  for (const id of ids) {const key = materialControl(variants.find((v: any) => v.id === id)); groups.set(key, [...groups.get(key) ?? [], id]);}
  for (const [selector, selected] of groups) {
    const changed = controls[selector].mutate(sources[name]);
    await writeFile(join(output, name + '-material-' + selector + '.js'), changed);
    await bounded(name + '-material-' + selector, changed, selected, 'material');
  }
  await bounded(name + '-restored', sources[name], ids, 'positive');
}
await bounded('wrong-category', sources['wrong-category'], category, 'poll categorical blocker');
await bounded('range-gap', sources['wrong-category'], ['A07/invalid-seq', 'A07/invalid-offset'], 'positive');
await bounded('range-integrity', sources['range-integrity'], ['A07/invalid-seq', 'A07/invalid-offset'], 'positive');
await bounded('forbidden-attach-expired', sources['forbidden-attach-expired'], ['B06/primary'], 'expired entry issues no attach');
}
await bounded('forbidden-attach-reserve', sources['forbidden-attach-reserve'], ['B06/primary'], 'insufficient reserve issues no work');

// Supplementary traces run the actual unchanged predicate with the same persisted
// input and schedule. Public calls, authentic effects/audits, and cleanup are kept.
const probes: any[] = [];
async function trace(name: string, source: string, variantId: string) {
  const provenance = effectiveProvenance({variantIds: [variantId]});
  const v = schedulePlan(provenance.seed, variants.filter((row: any) => row.id === variantId))[0];
  const definition = {contractVersion: CONTRACT_VERSION, suiteVersion: SUITE_VERSION, profile: PROFILE,
    variant: {id: v.id, family: v.family, kind: v.kind, args: v.args}, seed: provenance.seed,
    schedule: v.schedule, largeCount: provenance.largeCount, limits: {...LIMITS, wallMs: provenance.familyWallMs}};
  const s = new Scenario(source, v.family, {replayInput, variantId, caseDefinition: definition,
    seed: provenance.seed, schedule: v.schedule, largeCount: provenance.largeCount, wallMs: provenance.familyWallMs});
  const publicCalls: any[] = [], run = s.run.bind(s);
  s.run = async (method: string, args: any = {}) => {
    const call: any = {method, args, traceStart: s.b.trace.length}; publicCalls.push(call);
    try {const result = await run(method, args); call.result = structuredClone(result); return result;}
    catch (error) {call.error = String(error); throw error;} finally {call.traceEnd = s.b.trace.length;}
  };
  let failure: string | null = null;
  try {await s.open(); await exerciseVariant(s, v);}
  catch (error) {if (!(error instanceof AssertionFailure || error instanceof CandidateError)) throw error; failure = error.message;}
  finally {await s.dispose();}
  const faults = s.b.trace.flatMap((e: any, index: number) => e.type === 'fault' ? [{boundary: e.boundary, index, during: publicCalls.filter(c => c.traceStart <= index && index < c.traceEnd).map(c => c.method)}] : []);
  const summary = {name, variantId, sourceHash: sha(source), failure, safety: inspectSafety(s.b), assertions: s.assertions, faults,
    operations: s.b.operations, promiseJobs: s.guests.reduce((n: number, g: any) => n + g.jobs, 0),
    publicCalls: publicCalls.map(c => ({method: c.method, kind: c.result?.kind ?? null, error: c.error ?? null,
      blockers: c.result?.blockers?.map((b: any) => b.code) ?? [], state: c.result?.value?.state ?? null})),
    effects: Object.fromEntries(['driver.acquire', 'driver.start', 'driver.attach', 'driver.detach', 'driver.release', 'artifact.create', 'artifact.write'].map(m => [m, s.count(m)])),
    transportReturns: s.b.trace.filter((e: any) => e.type === 'return' && e.method === 'driver.readChannel' && e.value?.frame).map((e: any) => ({key: e.value.frame.key, bytesLength: e.value.frame.bytes.length})),
    acceptedAudits: s.b.audit.filter((a: any) => a.type === 'accepted').length,
    allGuestsDisposed: s.guests.every((g: any) => !g.live), remainingTrackedCalls: s.calls.size};
  await save(name + '.trace.private.json', {publicCalls, trace: s.b.trace, audit: s.b.audit, input: s.b.executedInput()});
  await save(name + '.probe.json', summary);
  check(summary.allGuestsDisposed && summary.remainingTrackedCalls === 0, name + ': all direct probe resources disposed');
  probes.push(summary); return summary;
}
if (!reserveOnly) {
for (const name of ['reference', 'setup-reader']) for (const id of attachment) await trace('trace-' + name + '-' + id.replaceAll('/', '-'), sources[name], id);
for (const name of ['reference', 'record-envelope']) for (const id of storage) {
  const good = await trace('trace-' + name + '-' + id.replaceAll('/', '-'), sources[name], id);
  check(good.failure === null && good.faults.some((f: any) => f.during.includes('restore')) && good.publicCalls.some((c: any) => c.method === 'restore' && c.kind === 'ok'), name + ': restore boundary, crash, retry, evidence actually reached');
  const bad = await trace('trace-' + name + '-missing-bytes-' + id.replaceAll('/', '-'), controls['omit-evidence-write'].mutate(sources[name]), id);
  check(bad.failure?.startsWith('restore must progress') && bad.effects['artifact.write'] === 0 && bad.faults.some((f: any) => f.during.includes('restore')) && bad.publicCalls.some((c: any) => c.method === 'restore' && c.blockers.includes('integrity')), name + ': missing bytes reaches actual restored integrity refusal');
}
for (const name of ['reference', 'lazy-roots']) await trace('trace-' + name + '-E02', sources[name], 'E02/primary');
for (const id of category) {const result = await trace('trace-wrong-category-' + id.replaceAll('/', '-'), sources['wrong-category'], id); check(result.transportReturns.some((t: any) => t.key.seq === 0 && t.key.offset === 0 && t.key.length === 3 && t.bytesLength === 3), id + ': corrupted non-range field leaves range unchanged');}
}
for (const kind of reserveOnly ? ['reserve'] : ['expired', 'reserve']) {const result = await trace('trace-forbidden-' + kind, sources['forbidden-attach-' + kind], 'B06/primary'); check(result.effects['driver.attach'] === 1, kind + ': forbidden neighbor issued an actual attachment');}
assert.deepEqual(await scoreInputHashes(), identity);
const summary = {schemaVersion: 1, purpose: 'targeted correction proof; not full production qualification or calibration admission',
  output, identity, contractVersion: CONTRACT_VERSION, suiteVersion: SUITE_VERSION, node: process.versions.node,
  replayCommitment: replayInput.commitment, sourceHashes: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, sha(v)])),
  affectedVariants: reserveOnly ? ['B06/primary'] : affected,
  reusedProof: priorProof ? {path: priorProofPath, sha256: sha(priorProof), scope: 'Reuse all checks except the explicitly failed vacuous reserve neighbor; exact scorer/public identity verified.'} : null,
  runs, probes: probes.map(p => ({name: p.name, variantId: p.variantId, failure: p.failure, safety: p.safety, operations: p.operations, promiseJobs: p.promiseJobs})),
  checks, passed: checks.every(c => c.passed)};
await save('summary.json', summary);
console.log(JSON.stringify({output, runs: runs.length, probes: probes.length, passed: summary.passed, failedChecks: checks.filter(c => !c.passed)}, null, 2));
assert(summary.passed, 'all targeted public-predicate/material/restored proof checks must pass');
