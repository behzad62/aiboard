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

// Red regression for a schedule that reads a candidate-private write value.
// Only store values change representation. Public requests/audits, CAS revisions,
// receipts, driver effects, evidence/capsule formats and behavior remain intact.
const output = join('benchmarks/recoverable-job-service/private/calibration',
  'representation-counterexample-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, {recursive: true});
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const save = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n');
const reference = await readFile('benchmarks/recoverable-job-service/private/reference.js', 'utf8');
assert.equal(hash(reference), '6a5b142037c60fb9ab480ccd64f307f556685be755878df0aa1ec39d3ceb1cf0');
const encoded = reference + `
// Reference-derived record-envelope control; never a participant submission.
{
 const referenceFactory = globalThis.createService;
 globalThis.createService = async function(storagePorts, authority) {
  const decode = row => ({...row, value: row.value === null ? null : row.value.record});
  const ports = {call: async (method, args = {}) => {
   if (method === 'store.commit') return storagePorts.call(method, {
    ...args, writes: args.writes.map(write => ({...write,
      value: write.value === null ? null : {record: write.value}}))});
   const result = await storagePorts.call(method, args);
   if (method === 'store.read') return decode(result);
   if (method === 'store.scan') return {...result, rows: result.rows.map(decode)};
   return result;
  }};
  return referenceFactory(ports, authority);
 };
}
`;
await writeFile(join(output, 'record-envelope.js'), encoded);
const variantIds = ['C01/primary', 'C09/primary', 'C09/restore-store.commit.before', 'C09/restore-store.commit.after'];
const replayInput = createReplayInput();
await save('replay-input.private.json', replayInput);
const results: Record<string, any> = {};
for (const [name, source] of [['reference', reference], ['record-envelope', encoded]]) {
  let record: any;
  const result = await evaluateBounded(source, {variantIds, replayInput, onReplayRecord(value: any) {record = value;}});
  assert.deepEqual(replayInputFromRecord(record), replayInput);
  await save(name + '.replay.private.json', record);
  await save(name + '.result.json', result);
  results[name] = result;
}
const provenance = effectiveProvenance({variantIds});
const probe = schedulePlan(provenance.seed, variants.filter((v: any) => v.id === 'C09/restore-store.commit.after'))[0];
for (const [name, source] of [['reference', reference], ['record-envelope', encoded]]) {
  const definition = {contractVersion: CONTRACT_VERSION, suiteVersion: SUITE_VERSION, profile: PROFILE,
    variant: {id: probe.id, family: probe.family, kind: probe.kind, args: probe.args}, seed: provenance.seed,
    schedule: probe.schedule, largeCount: provenance.largeCount, limits: {...LIMITS, wallMs: provenance.familyWallMs}};
  const s = new Scenario(source, probe.family, {replayInput, variantId: probe.id, caseDefinition: definition,
    seed: provenance.seed, schedule: probe.schedule, largeCount: provenance.largeCount, wallMs: provenance.familyWallMs});
  const publicCalls: any[] = [];
  const run = s.run.bind(s);
  s.run = async (method: string, args: any = {}) => {
    const result = await run(method, args);
    publicCalls.push({method, args, result: structuredClone(result)});
    return result;
  };
  let failure: string | null = null;
  try {await s.open(); await exerciseVariant(s, probe);}
  catch (error) {
    if (!(error instanceof AssertionFailure || error instanceof CandidateError)) throw error;
    failure = error.message;
  } finally {await s.dispose();}
  const summary = {variantId: probe.id, failure, safety: inspectSafety(s.b), assertions: s.assertions,
    operations: s.b.operations, promiseJobs: s.guests.reduce((n: number, g: any) => n + g.jobs, 0),
    publicCalls: publicCalls.map(c => ({method: c.method, kind: c.result.kind})),
    successfulRestore: publicCalls.some(c => c.method === 'restore' && c.result.kind === 'ok'),
    physicalWrites: s.count('artifact.write'), acceptedAudits: s.b.audit.filter((a: any) => a.type === 'accepted').length,
    commitCalls: s.b.trace.filter((t: any) => t.type === 'boundary' && t.method === 'store.commit.before').length,
    candidateRecordsEnveloped: [...s.b.docs.values()].every((v: any) => v.value === null || Object.hasOwn(v.value, 'record')),
    allGuestsDisposed: s.guests.every((g: any) => !g.live), remainingTrackedCalls: s.calls.size};
  await save(name + '.trace.private.json', {publicCalls, trace: s.b.trace, audit: s.b.audit});
  await save(name + '.probe.json', summary);
}
const rows = (r: any) => r.families.flatMap((f: any) => f.variants);
const summary = {schemaVersion: 1, purpose: 'opaque-record scheduling counterexample; not full calibration',
  referenceHash: hash(reference), recordEnvelopeHash: hash(encoded), contractVersion: CONTRACT_VERSION,
  suiteVersion: SUITE_VERSION, replayCommitment: replayInput.commitment, node: process.versions.node,
  results: Object.fromEntries(Object.entries(results).map(([name, result]) => [name, {
    status: result.status, selected: rows(result).length, pass: rows(result).filter((v: any) => v.passed).length,
    fail: rows(result).filter((v: any) => !v.passed).map((v: any) => ({id: v.id, reason: v.reason})),
    safetyFailures: result.safetyFailures.length,
  }]))};
await save('summary.json', summary);
console.log(JSON.stringify({output, ...summary}, null, 2));
assert.equal(rows(results.reference).every((v: any) => v.passed), true);
assert.equal(rows(results['record-envelope']).every((v: any) => v.passed), true,
  'restore acceptance must not depend on private record field names');
