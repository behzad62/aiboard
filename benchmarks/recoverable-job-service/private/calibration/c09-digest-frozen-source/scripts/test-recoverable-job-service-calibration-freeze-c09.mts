import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {copyFile, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {scoreInputHashes} from '../benchmarks/recoverable-job-service/private/identity.mjs';

const p = '.superpowers/sdd/2026-09-08-recoverable-job-service-integration';
const c = 'benchmarks/recoverable-job-service/private/calibration';
const redDir = join(c, 'c09-digest-red-2026-09-12T17-46-02-808Z');
const greenDir = join(c, 'c09-digest-green-2026-09-12T17-46-36-443Z');
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const json = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
const file = async (path: string) => {const bytes = await readFile(path); return {path: path.replaceAll('\\', '/'), bytes: bytes.length, sha256: sha(bytes)};};
const red = await json(join(redDir, 'summary.json')), green = await json(join(greenDir, 'summary.json'));
const beforeFreeze = join(c, 'correction-source-freeze.json');
assert.equal((await file(beforeFreeze)).sha256, '5f56619ba8d8695c52aa28da7ba674a103193bb478cedb83ef4c240c6afe708e');
assert(red.passed && green.passed && red.red && !green.red);
assert.equal(red.identity.suiteHash, 'f8f1f824577efab1719a750b22df833daf62c13fb9bf29b28bf9363cf94fa7f8');
assert.deepEqual(green.identity, await scoreInputHashes());
const source = 'benchmarks/recoverable-job-service/private/variants.mjs';
const beforeSource = join(c, 'correction-frozen-source', source);
const before = await readFile(beforeSource, 'utf8'), after = await readFile(source, 'utf8');
const oldAssertion = "s.check(evidence.manifest.final===cap.evidence.final&&evidence.manifest.manifestDigest===cap.evidence.manifestDigest,'restored evidence preserves exact public finality and manifest');";
const newAssertion = "s.check(evidence.manifest.final===cap.evidence.final,'restored evidence preserves exact public finality');s.check(canonical(evidence.manifest.totals)===canonical(cap.evidence.totals),'restored evidence preserves exact public accounting');s.check(evidence.manifest.manifestDigest===jsonDigest({...evidence.manifest,manifestDigest:''}),'restored evidence verifies its own manifest digest');if(cap.evidence.final)s.check(canonical(evidence.manifest)===canonical(cap.evidence),'restored final evidence remains immutable');";
assert.equal(before.split(oldAssertion).length, 2);
assert.equal(before.replace(oldAssertion, newAssertion), after, 'only the explicitly ruled assertion bytes changed');
assert.equal(sha(before), red.variantsSha256);
assert.equal(sha(after), green.variantsSha256);
const producerPath = join(p, 'task-2-integration-assertion-source-freeze-reviewed.json');
const producer = await json(producerPath);
const previous = await json(beforeFreeze);
const producerFiles = [];
for (const entry of producer.files) {
  const current = await file(entry.path);
  if (entry.path !== source) assert.equal(current.sha256, previous.producerFiles.find((f: any) => f.path === entry.path).sha256, 'all other producer source unchanged: ' + entry.path);
  producerFiles.push({...current, originalSha256: entry.sha256, previousSha256: previous.producerFiles.find((f: any) => f.path === entry.path).sha256});
}
assert.equal(producerFiles.length, 80);
const mappingPath = join(c, 'c09-digest-fix-mapping.json');
const ledgerPath = join(c, 'predicate-dependency-ledger-corrected.json');
assert.equal((await file(ledgerPath)).sha256, '111f38f67c2f933cd35de9609544747a2a6b54175b522e8810eed6d195f38d7a');
const mapping = {schemaVersion: 1, status: 'narrow supplement to frozen 302-row ledger; scoped independent review pending',
  issue: 'CAL-C09-NONFINAL-DIGEST', history: 'Existing C09 representation-independence correction history; no new allowance. Original private-record and nonexistent artifact-read-return failures remain preserved.',
  parentLedger: await file(ledgerPath), identity: green.identity, previousIdentity: red.identity,
  variants: ['C09/restore-store.commit.before', 'C09/restore-store.commit.after'],
  publicClauses: ['runtime-contract.md:36 Evidence digest', 'runtime-contract.md:100 guarded atomic restore', 'runtime-contract.md:R5 revision and finalized evidence', 'acceptance-contract.md:C09 safer atomic restore', 'acceptance-contract.md:C10 newer same-epoch head protection'],
  sourceDelta: {path: source, line: 74, before: oldAssertion, after: newAssertion},
  dependencies: {unchanged: ['Scenario.setup', 'Scenario.accepted', 'Scenario.hold', 'Scenario.reopen', 'Scenario.evidence', 'Scenario.dispose', 'canonical', 'public response validation', 'inspectSafety'], newlyInvoked: ['existing broker.jsonDigest on the returned public Evidence']},
  requirement: 'Keep exact retained bytes, both-stream accounting, finality and one accepted audit; independently verify the returned manifest digest. For finalized input preserve exact manifest equality; a nonfinal publication may advance revision.',
  witness: {sha256: green.sourceHashes['nonfinal-revision'], source: join(greenDir, 'nonfinal-revision.js').replaceAll('\\', '/'), construction: 'One guarded restore-CAS value expression advances only nonfinal Evidence revision and reseals its digest; actual store publication, no evaluator-output substitution.'},
  red: await file(join(redDir, 'summary.json')), green: await file(join(greenDir, 'summary.json')),
  material: {selector: 'omit-evidence-write', expectedPrefix: 'restore must progress', safety: 'evidence-before-acceptance', changed: false, rows: 6},
  conditionalFinality: 'These two production fixtures export nonfinal evidence. Exact finalized equality is retained conditionally; no newly exercised final fixture is claimed.',
  unrelatedAcceptedScope: 'All other source bytes in the prior correction manifest stay fixed. Its accepted attachment, root-timing and category proofs are reused under that manifest; no new broad run is claimed.'};
await writeFile(mappingPath, JSON.stringify(mapping, null, 2) + '\n');
const sources = [source, 'scripts/test-recoverable-job-service-calibration-c09-digest.mts', 'scripts/test-recoverable-job-service-calibration-freeze-c09.mts', join(c, 'probe-runtime.mjs')];
const paths = [mappingPath, join(c, 'c09-digest-fix.diff'), join(c, 'c09-digest-red.log'), join(c, 'c09-digest-green.log')];
for (const path of sources) {const dest = join(c, 'c09-digest-frozen-source', path); await mkdir(dirname(dest), {recursive: true}); await copyFile(path, dest); paths.push(path, dest);}
for (const dir of [redDir, greenDir]) for (const entry of await readdir(dir, {withFileTypes: true})) {assert(entry.isFile()); paths.push(join(dir, entry.name));}
const manifest = {schemaVersion: 1, status: 'scoped C09 fix freeze; independent acceptance and CAL01-05 pending', frozenAt: new Date().toISOString(), identity: green.identity,
  review: await file(join(p, 'calibration-correction-review.md')), previousFreeze: await file(beforeFreeze), producer: await file(producerPath), producerFiles,
  exactScoredChange: {before: await file(beforeSource), after: await file(source), oldAssertion, newAssertion},
  accounting: {redRows: 2, greenRows: 18, lawfulPasses: 6, intendedMaterialRejections: 6, restoredPasses: 6, skipped: 0, directActualPredicateTraces: 6,
    maximumBoundedOperations: Math.max(...green.runs.flatMap((r: any) => r.rows.map((v: any) => v.operations))),
    maximumBoundedPromiseJobs: Math.max(...green.runs.flatMap((r: any) => r.rows.map((v: any) => v.promiseJobs)))},
  files: await Promise.all(paths.map(file))};
const freezePath = join(c, 'c09-digest-fix-source-freeze.json');
await writeFile(freezePath, JSON.stringify(manifest, null, 2) + '\n');
const freeze = await file(freezePath), mappingFile = await file(mappingPath);
const reportPath = join(p, 'calibration-c09-digest-fix-report.md');
const report = `# Scoped C09 nonfinal digest correction

The one ruled C09 assertion change passes targeted proof and is frozen for the same reviewer's check. CAL01–05 and whole production qualification remain pending. This is the existing C09 representation-independence history, including the original private-record coupling and the failed artifact-read-return instrumentation attempt; no issue or repair allowance is reset.

## Exact change

Only private/variants.mjs:74 changed among the 80 preserved producer files. The owned freeze checks exact equality to the previous file after replacing one assertion substring; the other 79 files match the previous correction freeze. Existing scenarios, expectations, selectors, IDs, broker/runtime, reference, public contract, limits and isolated independent candidate are untouched.

The check keeps exact retained bytes and accepted output, compares both streams' totals and finality, and recomputes the returned public manifest's own digest. It allows a nonfinal revision/layout change. For a finalized exported manifest it retains exact equality. These two C09 production fixtures export nonfinal evidence; no new final-fixture runtime claim is made. The conditional final check preserves the published final immutability rule.

- Before variants SHA256: ${red.variantsSha256}
- After variants SHA256: ${green.variantsSha256}
- Contract: ${green.identity.contractHash}
- Before suite: ${red.identity.suiteHash}
- After suite: ${green.identity.suiteHash}
- Version remains 2.0.0 for both contract and suite; final 2.0.1 release freeze remains pending.

The source diff is ${c}/c09-digest-fix.diff. Before bytes remain in both the prior correction-frozen-source tree and the red run snapshot. The previous correction freeze ${manifest.previousFreeze.sha256} is unmodified. Public clauses and exact predicate/helper/material mapping are retained in ${mappingFile.path}, SHA256 ${mappingFile.sha256}; this is a supplement to the preserved 302-row ledger, not a silently rewritten historical map.

## Actual proof

The reviewer witness was recreated by its exact unique guarded-CAS source replacement and verified as SHA256 ${green.sourceHashes['nonfinal-revision']}. It durably advances nonfinal revision and reseals Evidence; it changes no port answer or test tag. Owned red run ${redDir.replaceAll('\\', '/')} reproduced both failures solely at the former whole-manifest equality, zero safety failures. Its harness exit is 0 because those two expected failures were verified; the failed candidate rows remain failed in their actual result.

Green run ${greenDir.replaceAll('\\', '/')} executed only the two affected IDs for reference, opaque-record envelope and actual nonfinal revision publication. All 6 lawful positives and 6 restored positives pass. All 6 corresponding omit-evidence-write rows fail the unchanged intended restore must progress prefix and evidence-before-acceptance finding after the real restore store hold is reached. No compilation, setup failure or timeout counts as negative proof. Zero rows skipped. The bounded maximum is ${manifest.accounting.maximumBoundedOperations} operations and ${manifest.accounting.maximumBoundedPromiseJobs} promise jobs.

Six additional traces execute the actual production predicates, observe restore-local holds, crash/reopen/retry and actual returned Evidence. Both revision traces prove revision 1→2, independently valid new digest, otherwise identical public Evidence, exact bytes [11,29,47] after another reopen, one accepted audit, and busy refusal of the older revision-1 capsule. All six have zero safety findings, all guests disposed and zero tracked calls.

Both commands used Node ${process.versions.node}, existing QuickJS 0.32.0/default production limits and the previously persisted input commitment ${green.replayInput.commitment}; the input was copied before execution and every private callback tape round-tripped to it. Commands were node --import tsx scripts/test-recoverable-job-service-calibration-c09-digest.mts --red and the same command without --red, both exit 0. Their logs, source snapshots, inputs, result files and full traces are in the freeze. All test processes ended before this report.

## Review packet

${freeze.path}, SHA256 ${freeze.sha256}, covers the exact diff, source snapshots, narrow mapping, reports' source evidence and all red/green runtime artifacts. The accepted attachment, root-timing and category corrections reuse their previous frozen proof, justified by the exact one-substring source comparison; no unrelated broad rerun was performed. The three complete alternate controls and eight-class probes continue independently. No whole production run has started.
`;
await writeFile(reportPath, report);
console.log(JSON.stringify({report: await file(reportPath), freeze, mapping: mappingFile, variants: await file(source), identity: green.identity, accounting: manifest.accounting}, null, 2));
