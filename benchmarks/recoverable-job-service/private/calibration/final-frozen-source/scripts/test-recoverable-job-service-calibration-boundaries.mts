import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {evaluateBounded, createReplayInput, replayInputFromRecord} from '../benchmarks/recoverable-job-service/private/runtime.mjs';

const reference = await readFile('benchmarks/recoverable-job-service/private/reference.js', 'utf8');
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
assert.equal(hash(reference), '6a5b142037c60fb9ab480ccd64f307f556685be755878df0aa1ec39d3ceb1cf0');
const initialRootLines = reference.split('\n').filter(line => /^\s*if\(!j\.(retainedRoot|scratchRoot)\)/.test(line));
assert.equal(initialRootLines.length, 2);
let lazyRoots = reference;
for (const line of initialRootLines) lazyRoots = lazyRoots.replace(line, '');
const publication = "await primitive('artifact.write',{root:j.retainedRoot";
assert.equal(lazyRoots.split(publication).length, 2);
lazyRoots = lazyRoots.replace(publication,
  "if(!j.retainedRoot){const root=await effect(j,'root-retained','artifact.create',{path:'retained/'+j.jobId,owner:j.jobId,retained:true},op);j=await update(jk(j.jobId),old=>({...old,retainedRoot:root}),[],op);}" + publication);
const wrongCategory = reference + `
// Forbidden neighbor: wrong categorical refusal; never a correct control.
{
 const original = globalThis.createService;
 globalThis.createService = async (ports, grant) => {
  const service = await original(ports, grant), run = service.run.bind(service);
  service.run = async request => {
   const result = await run(request);
   if (request.type === 'poll' && result.kind === 'blocked')
    for (const blocker of result.blockers) if (blocker.code === 'integrity') blocker.code = 'gap';
   return result;
  };
  return service;
 };
}
`;
const output = join('benchmarks/recoverable-job-service/private/calibration',
  'boundary-counterexamples-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(output, {recursive: true});
const save = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n');
const replayInput = createReplayInput();
await save('replay-input.private.json', replayInput);
await writeFile(join(output, 'lazy-roots.js'), lazyRoots);
await writeFile(join(output, 'wrong-category.js'), wrongCategory);
const results: Record<string, any> = {};
const lazyIds = ['C01/primary', 'E02/primary', 'E08/primary'];
const categoryIds = ['A07/invalid-stream', 'A07/invalid-digest', 'A07/invalid-artifactId', 'A07/invalid-channelId'];
for (const [name, source, variantIds] of [
  ['reference-lazy', reference, lazyIds], ['lazy-roots', lazyRoots, lazyIds],
  ['reference-category', reference, categoryIds], ['wrong-category', wrongCategory, categoryIds],
] as const) {
  let tape: any;
  const result = await evaluateBounded(source, {variantIds, replayInput, onReplayRecord(value: any) {tape = value;}});
  assert.deepEqual(replayInputFromRecord(tape), replayInput);
  await save(name + '.replay.private.json', tape);
  await save(name + '.result.json', result);
  results[name] = result;
}
const rows = (r: any) => r.families.flatMap((f: any) => f.variants);
const summary = {schemaVersion: 1, purpose: 'optional artifact creation and categorical-neighbor audit',
  referenceHash: hash(reference), lazyRootsHash: hash(lazyRoots), wrongCategoryHash: hash(wrongCategory),
  node: process.versions.node, results: Object.fromEntries(Object.entries(results).map(([name, r]) => [name, {
    status: r.status, selected: rows(r).length, pass: rows(r).filter((v: any) => v.passed).length,
    failed: rows(r).filter((v: any) => !v.passed).map((v: any) => ({id: v.id, reason: v.reason})), safetyFailures: r.safetyFailures.length,
  }]))};
await save('summary.json', summary);
console.log(JSON.stringify({output, ...summary}, null, 2));
assert.equal(rows(results['reference-lazy']).every((v: any) => v.passed), true);
assert.equal(rows(results['reference-category']).every((v: any) => v.passed), true);
if (!process.argv.includes('--category-only')) assert.equal(rows(results['lazy-roots']).every((v: any) => v.passed), true,
  'artifact roots may be created when healthy payload actually needs retention');
assert.equal(rows(results['wrong-category']).every((v: any) => v.passed), false,
  'a gap refusal for an invalid stream, with no range error, is a forbidden neighbor');
