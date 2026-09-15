import fs from 'node:fs';
import {createHash} from 'node:crypto';
const b = '.superpowers/sdd/2026-09-11-p6-completion/task10-filesystem-fence';
const sha = path => createHash('sha256').update(fs.readFileSync(path)).digest('hex');
const frozen = JSON.parse(fs.readFileSync(b + '/final-source-freeze.json', 'utf8'));
for (const input of frozen.sourceHashes) if (sha(input.path) !== input.sha256) throw Error('Source drift: ' + input.path);
const old = JSON.parse(fs.readFileSync(b + '/affected-graph.json', 'utf8'));
const tests = old.tests.filter(path => path !== 'runner-v2/test/git-bootstrap.test.ts');
const manifest = {createdAt: new Date().toISOString(), productInputs: frozen.sourceHashes,
  mainTestFiles: tests, bootstrapProfiles: {path: 'runner-v2/test/git-bootstrap.test.ts', pattern: 'baseline bootstrap'},
  diagnosticOnly: {path: 'runner-v2/test/git-bootstrap.test.ts', pattern: 'historical Git query',
    reason: 'Unchanged Task 9 read-only query boundary; its deliberate callback-throw fixture retains diagnostic state by production policy. It invokes no Task 10 mutation or baseline bootstrap. Preserve its passing assertions and retained root from the prior expanded run separately, rather than deleting diagnostic evidence or labeling it resource-clean.'},
  priorExpandedRun: 'final-affected/terminal.json',
  repairScope: 'Four staging-integrity regressions; test-only Windows bootstrap environment for the directly affected LSP and smoke integrations. No integration-manager production or fixture changes.'};
fs.writeFileSync(b + '/final-affected-graph.json', JSON.stringify(manifest, null, 2) + '\n', {flag:'wx'});
const specs = [
  {id:'acceptance-main', tests, inputPaths:[b + '/final-affected-graph.json']},
  {id:'acceptance-bootstrap', tests:['runner-v2/test/git-bootstrap.test.ts'], pattern:'baseline bootstrap', inputPaths:[b + '/final-affected-graph.json']},
  {id:'acceptance-typescript', args:['node_modules/typescript/bin/tsc','-p','runner-v2/tsconfig.json','--noEmit']},
  {id:'acceptance-eslint', args:['node_modules/eslint/bin/eslint.js','runner-v2/src','runner-v2/test']},
  {id:'acceptance-diff', args:['--input-type=module','-e',"import {spawnSync} from 'node:child_process';const r=spawnSync('git',['diff','--check','--','runner-v2'],{stdio:'inherit',windowsHide:true});if(r.error)throw r.error;process.exitCode=r.status??1;"]},
];
for (const spec of specs) fs.writeFileSync(b + '/' + spec.id + '.spec.json', JSON.stringify(spec,null,2)+'\n', {flag:'wx'});
console.log(JSON.stringify({mainFiles:tests.length, bootstrapProfiles:3, frozenSourceFiles:frozen.sourceHashes.length}));
