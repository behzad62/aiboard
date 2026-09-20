import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join, normalize } from 'node:path';
const base = '.superpowers/sdd/2026-09-11-p6-completion/task10-filesystem-fence';
const source = 'runner-v2/src/filesystem-mutation-fence.ts';
const accepted = fs.readFileSync(source), original = accepted.toString('utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const acceptedSha256 = hash(accepted);
const start = original.indexOf('function revalidate('), end = original.indexOf('function current(', start);
assert.ok(start >= 0 && end > start);
const exclusive = '      try { fs.linkSync(temporary, path); }\n      catch (error) { throw linkPublicationFailure(error, path); }';
assert.equal(original.split(exclusive).length, 2, 'Unique create-only publication guard required');
const faults = [
  { id: 'canonicalization', pattern: 'a new-file parent retarget',
    source: original.slice(0, start) + 'function revalidate(record: Captured, path: string, links = 1n): void {\n  void record; void links; resolve(path); // DELIBERATE lexical-only regression\n}\n' + original.slice(end),
    violationPath: ['outside', 'new.txt'], violationBytes: 'confined' },
  { id: 'overwrite', pattern: 'publication is create-if-absent',
    source: original.replace(exclusive, '      try { fs.linkSync(temporary, path); } catch (error) {\n        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;\n        fs.renameSync(temporary, path); // DELIBERATE create-overwrite regression\n      }'),
    violationPath: ['workspace', 'value.txt'], violationBytes: 'replacement' },
];
const json = path => JSON.parse(fs.readFileSync(path, 'utf8'));
const save = (path, value) => fs.writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
function run(id, pattern) {
  const spec = join(base, id + '.spec.json');
  save(spec, { id, pattern, tests: ['runner-v2/test/filesystem-mutation-fence.test.ts'], inputPaths: [base + '/reverse-fault.mjs'] });
  const child = spawnSync(process.execPath, [join(base, 'gate.mjs'), spec], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  process.stdout.write(child.stdout ?? ''); process.stderr.write(child.stderr ?? '');
  if (child.error) throw child.error;
  const terminal = json(join(base, id, 'terminal.json'));
  assert.equal(terminal.inputsUnchanged, true); assert.equal(child.status, terminal.exitCode);
  return terminal;
}
function green(terminal) {
  assert.equal(terminal.exitCode, 0); assert.deepEqual(terminal.retainedRoots, []);
  assert.equal(hash(fs.readFileSync(source)), acceptedSha256);
}
const receipt = { acceptedSha256, startedAt: new Date().toISOString(), faults: [], verified: false };
fs.writeFileSync(join(base, 'reverse-fault-accepted-source.snapshot'), accepted, { flag: 'wx' });
try {
  green(run('fault-final-controls-green', faults.map(f => f.pattern).join('|')));
  for (const fault of faults) {
    assert.equal(hash(fs.readFileSync(source)), acceptedSha256);
    const faulty = Buffer.from(fault.source), faultySha256 = hash(faulty);
    const entry = { id: fault.id, acceptedSha256, faultySha256 }; receipt.faults.push(entry);
    fs.writeFileSync(join(base, `fault-${fault.id}-source.snapshot`), faulty, { flag: 'wx' });
    fs.writeFileSync(source, faulty);
    try {
      const red = run('fault-' + fault.id + '-red', fault.pattern);
      assert.equal(red.exitCode, 1); assert.equal(red.retainedRoots.length, 1);
      const log = fs.readFileSync(join(base, red.id, 'stdout.log'), 'utf8');
      assert.match(log, /^# tests 1$/m); assert.match(log, /^# fail 1$/m);
      const violation = join(normalize(red.retainedRoots[0]), ...fault.violationPath);
      const bytes = fs.readFileSync(violation);
      assert.equal(bytes.toString('utf8'), fault.violationBytes, 'Actual forbidden bytes must prove causality, not merely a test error');
      Object.assign(entry, { redRun: red.id, retainedDiagnosticRoot: normalize(red.retainedRoots[0]), violation, violationSha256: hash(bytes), violationBytesConfirmed: true });
    } finally {
      assert.ok([acceptedSha256, faultySha256].includes(hash(fs.readFileSync(source))), 'Concurrent source drift: do not overwrite it');
      fs.writeFileSync(source, accepted);
      assert.equal(hash(fs.readFileSync(source)), acceptedSha256);
    }
    const restored = run('fault-' + fault.id + '-restored-green', fault.pattern); green(restored);
    Object.assign(entry, { restoredGreenRun: restored.id, restoredSha256: hash(fs.readFileSync(source)) });
  }
  receipt.verified = true;
} catch (error) { receipt.failure = String(error); process.exitCode = 1; }
finally { receipt.finishedAt = new Date().toISOString(); receipt.finalSourceSha256 = hash(fs.readFileSync(source)); save(join(base, 'causal-reverse-fault.json'), receipt); }
console.log(JSON.stringify(receipt, null, 2));
