import assert from 'node:assert/strict';
import {copyFile, mkdir, readFile, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import {createHash} from 'node:crypto';

// One authorized prose/version refresh; original producer bytes are retained.
const base = 'benchmarks/recoverable-job-service';
const beforeDir = base + '/private/calibration/before-final-version';
const changes: {path: string, before: string, after: string}[] = [];
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
async function change(path: string, from: string, to: string, count = 1) {
 const prior = changes.find(c => c.path === path);
 const old = prior?.after ?? await readFile(path, 'utf8');
 if (!old.includes(from) && from.includes('\r\n')) {from = from.replaceAll('\r\n', '\n'); to = to.replaceAll('\r\n', '\n');}
 assert.equal(old.split(from).length - 1, count, path + ': exact authorized prose/version anchors');
 const next = old.replaceAll(from, to);
 if (prior) prior.after = next; else changes.push({path, before: old, after: next});
}
await change(base + '/public/acceptance-contract.md',
 'Scoring admission remains pending producer qualification, an independent public-only\r\ncorrect implementation and end-to-end UI validation; documentation is not a pass.',
 'Scoring admission requires producer qualification, a reference-independence\r\ncalibration using the simplification audit method rjs-simplification-audit-1, and\r\nend-to-end UI validation. The evaluator\'s benchmark metadata records calibration\r\nstatus separately from this contract; documentation alone does not admit scoring.');
await change(base + '/public/runtime-contract.md', 'rjs-contract-2.0.0', 'rjs-contract-2.0.1');
await change(base + '/public/runtime-contract.md', 'rjs-suite-2.0.0', 'rjs-suite-2.0.1');
await change(base + '/public/source-bootstrap.md', 'rjs-contract-2.0.0', 'rjs-contract-2.0.1');
await change(base + '/private/evaluator.mjs', "CONTRACT_VERSION='rjs-contract-2.0.0'", "CONTRACT_VERSION='rjs-contract-2.0.1'");
await change(base + '/private/evaluator.mjs', "SUITE_VERSION='rjs-suite-2.0.0'", "SUITE_VERSION='rjs-suite-2.0.1'");
await change(base + '/private/generate-assets.mjs',
 "const metadata={schemaVersion:2,profile:PROFILE,contractVersion:CONTRACT_VERSION,suiteVersion:SUITE_VERSION,derivationVersion:'rjs-input-hmac-sha256-v1',familyCount:families.length,variantCount:productionProvenance.variantIds.length};",
 "const calibration=JSON.parse(await readFile(new URL('./calibration/qualification-metadata.json',import.meta.url),'utf8'));\nif(calibration.method!=='rjs-simplification-audit-1'||!['pending','accepted'].includes(calibration.status))throw Error('Invalid evaluator calibration metadata');\nconst metadata={schemaVersion:2,profile:PROFILE,contractVersion:CONTRACT_VERSION,suiteVersion:SUITE_VERSION,derivationVersion:'rjs-input-hmac-sha256-v1',familyCount:families.length,variantCount:productionProvenance.variantIds.length,calibration};");
for (const c of changes) {
 const snapshot = join(beforeDir, c.path); await mkdir(dirname(snapshot), {recursive: true});
 await writeFile(snapshot, c.before); await writeFile(c.path, c.after);
}
for (const name of ['acceptance-contract.md', 'runtime-contract.md', 'source-bootstrap.md']) {
 const path = 'docs/benchmarks/recoverable-job-service/' + name;
 const snapshot = join(beforeDir, path); await mkdir(dirname(snapshot), {recursive: true}); await copyFile(path, snapshot);
 const source = await readFile(base + '/public/' + name, 'utf8'); await writeFile(path, source);
}
const generated = 'lib/benchmark/workbench/recoverable-job-service/assets.generated.ts';
await mkdir(dirname(join(beforeDir, generated)), {recursive: true}); await copyFile(generated, join(beforeDir, generated));
const manifest = {schemaVersion: 1, purpose: 'Authorized qualification-method/version-only change; generator output is regenerated separately',
 changes: changes.map(c => ({path: c.path, beforeSha256: sha(c.before), afterSha256: sha(c.after)})),
 mirrors: ['acceptance-contract.md', 'runtime-contract.md', 'source-bootstrap.md'], generatedBefore: {path: generated, sha256: sha(await readFile(generated, 'utf8'))}};
await writeFile(join(beforeDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest, null, 2));
