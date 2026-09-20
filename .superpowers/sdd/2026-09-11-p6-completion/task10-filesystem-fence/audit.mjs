import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const base = '.superpowers/sdd/2026-09-11-p6-completion/task10-filesystem-fence';
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
const baseline = read(base + '/baseline.json');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const productPaths = [
  'runner-v2/src/agent-contracts.ts', 'runner-v2/src/execution-grants.ts',
  'runner-v2/src/filesystem-tools.ts', 'runner-v2/src/git-baseline.ts',
  'runner-v2/src/git-bootstrap.ts', 'runner-v2/src/tool-broker.ts',
  'runner-v2/test/language-invocation-propagation.test.ts', 'runner-v2/test/support/git-fixture.ts',
  'runner-v2/src/filesystem-mutation-fence.ts', 'runner-v2/test/filesystem-mutation-fence.test.ts',
  'runner-v2/test/filesystem-mutation-routing.test.ts', 'runner-v2/test/filesystem-bootstrap-fence.test.ts',
  'runner-v2/test/lsp-real-host.test.ts', 'runner-v2/test/support/lsp-owned-fixture.ts',
  'runner-v2/test/final-verification-runtime-b1.test.ts',
  'runner-v2/test/integration-manager.test.ts',
];
const completionPlan = '.superpowers/sdd/2026-09-11-p6-completion/plan.md';
const allowed = new Set([...productPaths, completionPlan]);
const taskPath = p => allowed.has(p) || p.startsWith(base + '/');
const drift = [], missing = []; let checked = 0;
for (const file of baseline.files) {
  if (allowed.has(file.path)) continue;
  checked++;
  if (!fs.existsSync(file.path)) { missing.push(file.path); continue; }
  const bytes = fs.lstatSync(file.path).isSymbolicLink()
    ? Buffer.from(fs.readlinkSync(file.path)) : fs.readFileSync(file.path);
  if (sha(bytes) !== file.sha256) drift.push(file.path);
}
const status = git('status', '--porcelain=v1', '-z', '--untracked-files=all');
const old = baseline.status.split('\0').filter(Boolean).filter(x => !taskPath(x.slice(3))).sort();
const current = status.split('\0').filter(Boolean).filter(x => !taskPath(x.slice(3))).sort();
const head = git('rev-parse', 'HEAD').trim(), branch = git('branch', '--show-current').trim();
const index = git('diff', '--cached', '--name-only');
const task11 = fs.readFileSync(completionPlan, 'utf8').split('\n').find(line => line.startsWith('| 11 '));
const result = { time: new Date().toISOString(), head, branch, index, base: baseline.head,
  protectedChecked: checked, unexpectedDrift: drift, unexpectedMissing: missing,
  unrelatedStatusUnchanged: JSON.stringify(old) === JSON.stringify(current), unrelatedStatusCount: old.length,
  task11, sourceHashes: productPaths.map(path => ({ path, sha256: sha(fs.readFileSync(path)) })) };
const id = process.argv[2];
if (!/^[a-z0-9_-]+$/.test(id ?? '')) throw new Error('Unique audit ID required');
fs.writeFileSync(base + '/' + id + '.json', JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ ...result, sourceHashes: result.sourceHashes.length }, null, 2));
if (branch !== baseline.branch || index || drift.length || missing.length || !result.unrelatedStatusUnchanged
    || !task11?.includes('PENDING')) process.exitCode = 1;
