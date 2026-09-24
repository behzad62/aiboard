import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {evaluateBounded, createReplayInput, replayInputFromRecord} from '../benchmarks/recoverable-job-service/private/runtime.mjs';
import {Scenario, AssertionFailure} from '../benchmarks/recoverable-job-service/private/scenarios.mjs';
import {variants, exerciseVariant} from '../benchmarks/recoverable-job-service/private/variants.mjs';
import {schedulePlan, effectiveProvenance} from '../benchmarks/recoverable-job-service/private/provenance.mjs';
import {inspectSafety} from '../benchmarks/recoverable-job-service/private/oracle.mjs';
import {LIMITS, CandidateError} from '../benchmarks/recoverable-job-service/private/broker.mjs';
import {PROFILE, CONTRACT_VERSION, SUITE_VERSION} from '../benchmarks/recoverable-job-service/private/evaluator.mjs';

// Counterexample only. The complete control is QuickJS guest source data, never a Node import.
// Installing a reader in setup must not make a safe successful stop fail merely
// because a scenario schedules its hypothetical first attachment after setup.
const root = 'benchmarks/recoverable-job-service/private/calibration';
const output = join(root, 'attachment-counterexample-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, {recursive: true});
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const save = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n');
const reference = await readFile('benchmarks/recoverable-job-service/private/reference.js', 'utf8');
assert.equal(hash(reference), '6a5b142037c60fb9ab480ccd64f307f556685be755878df0aa1ec39d3ceb1cf0');
const anchor = "await update(jk(j.jobId),old=>({...old,state:'running'})";
assert.equal(reference.split(anchor).length, 2, 'one ordinary running-publication seam');
const setupReader = reference.replace(anchor,
  "await effect(j,'reader','driver.attach',{privateReader:true},req);" + anchor);
await writeFile(join(output, 'setup-reader.js'), setupReader);
const variantIds = [
  'B01/recover-driver.attach.before',
  'B06/primary',
  'B06/deadline-driver.attach.before',
  'B07/issued-driver.attach.before',
  'B07/resource-intent-reader',
  'B10/primary',
];
const replayInput = createReplayInput();
await save('replay-input.private.json', replayInput);
const results: Record<string, any> = {};
for (const [name, source] of [['reference', reference], ['setup-reader', setupReader]]) {
  let record: any;
  const result = await evaluateBounded(source, {
    variantIds,
    onReplayRecord(value: any) { record = value; },
    replayInput,
  });
  assert.deepEqual(replayInputFromRecord(record), replayInput, 'actual private tape is structurally verified');
  await save(name + '.replay.private.json', record);
  await save(name + '.result.json', result);
  results[name] = result;
}

// Capture the exact scenario's public requests/results, protected receipts and
// finalizer disposition. This supplements, and does not replace, the bounded run.
const provenance = effectiveProvenance({variantIds});
const probe = schedulePlan(provenance.seed, variants.filter((v: any) => v.id === 'B07/issued-driver.attach.before'))[0];
for (const [name, source] of [['reference', reference], ['setup-reader', setupReader]]) {
  const definition = {contractVersion: CONTRACT_VERSION, suiteVersion: SUITE_VERSION, profile: PROFILE,
    variant: {id: probe.id, family: probe.family, kind: probe.kind, args: probe.args},
    seed: provenance.seed, schedule: probe.schedule, largeCount: provenance.largeCount,
    limits: {...LIMITS, wallMs: provenance.familyWallMs}};
  const s = new Scenario(source, probe.family, {replayInput, variantId: probe.id, caseDefinition: definition,
    seed: provenance.seed, schedule: probe.schedule, largeCount: provenance.largeCount, wallMs: provenance.familyWallMs});
  const publicCalls: any[] = [];
  const original = s.run.bind(s);
  s.run = async (method: string, args: any = {}) => {
    const result = await original(method, args);
    publicCalls.push({method, args, result: structuredClone(result)});
    return result;
  };
  let failure: string | null = null;
  try { await s.open(); await exerciseVariant(s, probe); }
  catch (error) {
    if (!(error instanceof AssertionFailure || error instanceof CandidateError)) throw error;
    failure = error.message;
  } finally { await s.dispose(); }
  const safety = inspectSafety(s.b);
  const summary = {variantId: probe.id, failure, safety, assertions: s.assertions,
    operations: s.b.operations, promiseJobs: s.guests.reduce((n: number, g: any) => n + g.jobs, 0),
    attachments: s.count('driver.attach'), detachments: s.count('driver.detach'), releases: s.count('driver.release'),
    publicCalls: publicCalls.map(c => ({method: c.method, kind: c.result.kind, state: c.result.value?.state ?? null})),
    heldBoundaries: s.b.trace.filter((t: any) => t.type === 'boundary' && t.method === 'driver.attach.before').length,
    allGuestsDisposed: s.guests.every((g: any) => !g.live), remainingTrackedCalls: s.calls.size};
  await save(name + '.trace.private.json', {publicCalls, trace: s.b.trace, audit: s.b.audit});
  await save(name + '.probe.json', summary);
}
const rows = (r: any) => r.families.flatMap((f: any) => f.variants);
const summary = {schemaVersion: 1, purpose: 'setup-reader scheduling counterexample; not full calibration',
  referenceHash: hash(reference), setupReaderHash: hash(setupReader), contractVersion: CONTRACT_VERSION,
  suiteVersion: SUITE_VERSION, replayCommitment: replayInput.commitment, node: process.versions.node,
  results: Object.fromEntries(Object.entries(results).map(([name, result]) => [name, {
    status: result.status, selected: rows(result).length, pass: rows(result).filter((v: any) => v.passed).length,
    fail: rows(result).filter((v: any) => !v.passed).map((v: any) => ({id: v.id, reason: v.reason})),
    safetyFailures: result.safetyFailures.length,
  }]))};
await save('summary.json', summary);
console.log(JSON.stringify({output, ...summary}, null, 2));
assert.equal(rows(results.reference).every((v: any) => v.passed), true, 'reference reaches all selected lawful boundaries');
assert.equal(rows(results['setup-reader']).every((v: any) => v.passed), true,
  'a reader lawfully installed during setup must preserve acceptance of safe stop behavior');
