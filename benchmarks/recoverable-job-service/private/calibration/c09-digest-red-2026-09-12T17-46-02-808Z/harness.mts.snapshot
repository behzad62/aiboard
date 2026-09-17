import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {evaluateBounded, replayInputFromRecord} from '../benchmarks/recoverable-job-service/private/runtime.mjs';
import {controls} from '../benchmarks/recoverable-job-service/private/controls.mjs';
import {variants} from '../benchmarks/recoverable-job-service/private/variants.mjs';
import {matchesMaterialFailure} from '../benchmarks/recoverable-job-service/private/material-failure.mjs';
import {scoreInputHashes} from '../benchmarks/recoverable-job-service/private/identity.mjs';
import {canonical, jsonDigest} from '../benchmarks/recoverable-job-service/private/broker.mjs';
import {actualPredicate} from '../benchmarks/recoverable-job-service/private/calibration/probe-runtime.mjs';

// Narrow CAL-C09-NONFINAL-DIGEST regression. Source remains inert QuickJS data.
const base = 'benchmarks/recoverable-job-service/private';
const red = process.argv.includes('--red');
const output = join(base, 'calibration/c09-digest-' + (red ? 'red-' : 'green-') + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, {recursive: true});
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const save = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n');
const reference = await readFile(join(base, 'reference.js'), 'utf8');
assert.equal(sha(reference), '6a5b142037c60fb9ab480ccd64f307f556685be755878df0aa1ec39d3ceb1cf0');
const from = 'evidence:c.evidence,checkpointEverCreated:c.checkpointEverCreated';
const to = 'evidence:c.evidence&&!c.evidence.final?await sealEvidence({...copy(c.evidence),revision:Math.min(Number.MAX_SAFE_INTEGER,c.evidence.revision+1)}):c.evidence,checkpointEverCreated:c.checkpointEverCreated';
assert.equal(reference.split(from).length, 2, 'reviewed real restore publication anchor is unique');
const revision = reference.replace(from, to);
assert.equal(sha(revision), '5934b229e3122ff738a059c0828ae3f42c346f014f85b4894e682dd53f415e87');
const envelope = await readFile(join(base, 'calibration/representation-counterexample-2026-09-12T16-30-39-776Z/record-envelope.js'), 'utf8');
assert.equal(sha(envelope), 'a6d8411c20f253e4982cbc3ab35db4536b29941b7f6cdef05c4086efef3f3d7b');
const sources: Record<string, string> = {reference, 'record-envelope': envelope, 'nonfinal-revision': revision};
for (const [name, source] of Object.entries(sources)) await writeFile(join(output, name + '.js'), source);
const identity = await scoreInputHashes();
const scorer = await readFile(join(base, 'variants.mjs'));
await writeFile(join(output, 'variants.mjs.snapshot'), scorer);
await writeFile(join(output, 'harness.mts.snapshot'), await readFile('scripts/test-recoverable-job-service-calibration-c09-digest.mts'));
const replayPath = join(base, 'calibration/correction-proof-2026-09-12T17-06-54-031Z/replay-input.private.json');
const replayBytes = await readFile(replayPath);
const replayInput = JSON.parse(replayBytes.toString('utf8'));
await writeFile(join(output, 'replay-input.private.json'), replayBytes); // Before every execution.
const ids = ['C09/restore-store.commit.before', 'C09/restore-store.commit.after'];
const expected = JSON.parse(await readFile(join(base, 'control-expectations.json'), 'utf8'));
const rows = (result: any) => result.families.flatMap((family: any) => family.variants);
const checks: {label: string, passed: boolean}[] = [], runs: any[] = [], probes: any[] = [];
const check = (value: unknown, label: string) => checks.push({label, passed: !!value});
async function bounded(name: string, source: string, expectation: 'positive' | 'red' | 'material') {
  let tape: any;
  const result = await evaluateBounded(source, {variantIds: ids, replayInput, onReplayRecord(value: any) {tape = value;}});
  assert.deepEqual(replayInputFromRecord(tape), replayInput);
  await save(name + '.result.json', result);
  await save(name + '.replay.private.json', tape);
  check(result.status === 'valid' && rows(result).length === 2 && rows(result).every((row: any) => row.safetyChecked), name + ': both actual bounded predicates executed');
  for (const row of rows(result)) {
    if (expectation === 'positive') check(row.passed, name + ': ' + row.id + ' passes');
    if (expectation === 'red') check(!row.passed && row.safetyFailures.length === 0 && row.assertions.filter((a: any) => !a.passed).length === 1 && row.assertions.some((a: any) => !a.passed && a.label === 'restored evidence preserves exact public finality and manifest'), name + ': ' + row.id + ' fails solely reviewed nonfinal constraint');
    if (expectation === 'material') check(matchesMaterialFailure(variants.find((v: any) => v.id === row.id), row, expected[row.id]) && row.assertions.some((a: any) => a.label.startsWith('candidate reached lawful store.commit.') && a.passed) && row.safetyFailures.some((f: any) => f.code === 'evidence-before-acceptance'), name + ': ' + row.id + ' actual restore/evidence failure after reached hold');
  }
  const summary = {name, sourceHash: sha(source), expectation, selected: rows(result).length,
    passed: rows(result).filter((row: any) => row.passed).length, skipped: rows(result).filter((row: any) => !row.safetyChecked).length,
    rows: rows(result).map((row: any) => ({id: row.id, passed: row.passed, reason: row.reason, operations: row.operations, promiseJobs: row.promiseJobs}))};
  runs.push(summary); console.log(JSON.stringify(summary));
}
if (red) await bounded('nonfinal-revision-red', revision, 'red');
else {
  for (const [name, source] of Object.entries(sources)) {
    await bounded(name + '-positive', source, 'positive');
    const missing = controls['omit-evidence-write'].mutate(source);
    await writeFile(join(output, name + '-material.js'), missing);
    await bounded(name + '-material', missing, 'material');
    await bounded(name + '-restored', source, 'positive');
    for (const id of ids) {
      const facts: any = {};
      const probe = await actualPredicate(source, id, {replayInput, afterExercise: async ({s, publicCalls}: any) => {
        const old = publicCalls.find((c: any) => c.method === 'exportCapsule').result.value;
        const current = await s.ok('exportCapsule', {jobId: s.jobId});
        const previousEvidence = old.evidence, currentEvidence = current.evidence;
        s.check(canonical(currentEvidence.totals) === canonical(previousEvidence.totals), 'probe retains both streams accounting');
        s.check(currentEvidence.final === previousEvidence.final, 'probe retains public finality');
        s.check(jsonDigest({...currentEvidence, manifestDigest: ''}) === currentEvidence.manifestDigest, 'probe manifest independently verifies');
        if (name === 'nonfinal-revision') {
          s.check(currentEvidence.revision === previousEvidence.revision + 1, 'probe real nonfinal revision advances once');
          const omitPublication = (e: any) => {const {revision, manifestDigest, ...rest} = e; return rest;};
          s.check(canonical(omitPublication(currentEvidence)) === canonical(omitPublication(previousEvidence)), 'probe publication changes only revision and digest');
          await s.reopen();
          const retained = await s.evidence([11, 29, 47]);
          s.check(canonical(retained.manifest) === canonical(currentEvidence), 'probe revised manifest survives fresh reopen');
          const stale = await s.run('restore', {capsule: old});
          s.check(stale.kind === 'blocked' && stale.blockers.some((b: any) => b.code === 'busy'), 'probe refuses older same-epoch evidence head');
          facts.staleResult = stale;
        }
        facts.previousEvidence = previousEvidence; facts.currentEvidence = currentEvidence;
        facts.acceptedAudits = s.b.audit.filter((a: any) => a.type === 'accepted' && a.jobId === s.jobId).length;
        s.check(facts.acceptedAudits === 1, 'probe one accepted audit after publication and reopen');
      }});
      const label = name + '-' + id.replaceAll('/', '-');
      await save(label + '.probe.json', {...probe.summary, facts});
      await save(label + '.trace.private.json', probe.privateTrace);
      check(probe.summary.failure === null && probe.summary.safety.length === 0 && probe.summary.faults.some((f: any) => f.during.includes('restore')) && probe.summary.allGuestsDisposed && probe.summary.remainingTrackedCalls === 0, label + ': actual crash/restore/read/publication and complete disposal');
      probes.push({name: label, ...probe.summary, facts});
    }
  }
}
assert.deepEqual(await scoreInputHashes(), identity, 'scored bytes unchanged throughout focused run');
const summary = {schemaVersion: 1, purpose: 'same C09 correction history; narrow nonfinal digest red/green evidence, not full qualification',
  output, red, node: process.versions.node, identity, variantsSha256: sha(scorer), replayInput: {path: replayPath, sha256: sha(replayBytes), commitment: replayInput.commitment},
  sourceHashes: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, sha(source)])), runs, probes,
  checks, passed: checks.every(c => c.passed)};
await save('summary.json', summary);
console.log(JSON.stringify({output, red, passed: summary.passed, checks: checks.length, failedChecks: checks.filter(c => !c.passed)}, null, 2));
assert(summary.passed, 'narrow C09 expected observations must all hold');
