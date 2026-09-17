import assert from 'node:assert/strict';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Scenario, AssertionFailure} from '../benchmarks/recoverable-job-service/private/scenarios.mjs';
import {variants, exerciseVariant} from '../benchmarks/recoverable-job-service/private/variants.mjs';
import {schedulePlan, effectiveProvenance} from '../benchmarks/recoverable-job-service/private/provenance.mjs';
import {inspectSafety} from '../benchmarks/recoverable-job-service/private/oracle.mjs';
import {LIMITS, CandidateError} from '../benchmarks/recoverable-job-service/private/broker.mjs';
import {validateReplayInput} from '../benchmarks/recoverable-job-service/private/runtime.mjs';
import {PROFILE, CONTRACT_VERSION, SUITE_VERSION} from '../benchmarks/recoverable-job-service/private/evaluator.mjs';

const output = 'benchmarks/recoverable-job-service/private/calibration/boundary-counterexamples-2026-09-12T16-40-10-274Z';
const input = validateReplayInput(JSON.parse(await readFile(join(output, 'replay-input.private.json'), 'utf8')));
const sources = [['lazy-roots', 'E02/primary'], ['wrong-category', 'A07/invalid-stream']] as const;
for (const [name, variantId] of sources) {
  const source = await readFile(join(output, name + '.js'), 'utf8');
  const provenance = effectiveProvenance({variantIds: [variantId]});
  const v = schedulePlan(provenance.seed, variants.filter((row: any) => row.id === variantId))[0];
  const definition = {contractVersion: CONTRACT_VERSION, suiteVersion: SUITE_VERSION, profile: PROFILE,
    variant: {id: v.id, family: v.family, kind: v.kind, args: v.args}, seed: provenance.seed,
    schedule: v.schedule, largeCount: provenance.largeCount, limits: {...LIMITS, wallMs: provenance.familyWallMs}};
  const s = new Scenario(source, v.family, {replayInput: input, variantId, caseDefinition: definition,
    seed: provenance.seed, schedule: v.schedule, largeCount: provenance.largeCount, wallMs: provenance.familyWallMs});
  const calls: any[] = [];
  const run = s.run.bind(s);
  s.run = async (method: string, args: any = {}) => {const result = await run(method, args); calls.push({method, args, result: structuredClone(result)}); return result;};
  let failure: string | null = null;
  try {await s.open(); await exerciseVariant(s, v);}
  catch (error) {if (!(error instanceof AssertionFailure || error instanceof CandidateError)) throw error; failure = error.message;}
  finally {await s.dispose();}
  const queuedFrame = s.jobId ? s.b.jobs.get(s.jobId)?.queue?.[0] : null;
  const summary = {variantId, failure, safety: inspectSafety(s.b), assertions: s.assertions,
    operations: s.b.operations, promiseJobs: s.guests.reduce((n: number, g: any) => n + g.jobs, 0),
    publicCalls: calls.map(c => ({method: c.method, kind: c.result.kind, blockers: c.result.blockers?.map((b: any) => b.code) ?? [], state: c.result.value?.state ?? null})),
    effects: Object.fromEntries(['driver.acquire', 'driver.start', 'artifact.create', 'artifact.write'].map(method => [method, s.count(method)])),
    acceptedAudits: s.b.audit.filter((a: any) => a.type === 'accepted').length,
    queuedFrame: queuedFrame ? {stream: queuedFrame.key.stream, seq: queuedFrame.key.seq, offset: queuedFrame.key.offset, length: queuedFrame.key.length, bytes: queuedFrame.bytes.length} : null,
    allGuestsDisposed: s.guests.every((g: any) => !g.live), remainingTrackedCalls: s.calls.size};
  await writeFile(join(output, name + '.trace.private.json'), JSON.stringify({calls, trace: s.b.trace, audit: s.b.audit}, null, 2) + '\n');
  await writeFile(join(output, name + '.probe.json'), JSON.stringify(summary, null, 2) + '\n');
  assert.equal(summary.safety.length, 0);
  assert(summary.allGuestsDisposed && summary.remainingTrackedCalls === 0);
  if (name === 'lazy-roots') {assert.equal(failure, 'start must refuse'); assert.equal(summary.effects['artifact.create'], 0); assert.equal(summary.effects['driver.start'], 1);}
  else {assert.equal(failure, null); assert.equal(summary.acceptedAudits, 0); assert(summary.publicCalls.some(c => c.method === 'poll' && c.blockers.includes('gap')));}
  console.log(JSON.stringify({name, ...summary}, null, 2));
}
