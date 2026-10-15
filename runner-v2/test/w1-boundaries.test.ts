import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../src/artifact-store.js';
import { NativeDeliverableReviewRuntime } from '../src/native-deliverable-review.js';
import { normalizeRepairDiff, repairDiffFingerprint, repairDiffReverseFingerprint } from '../src/review-key.js';
import { loadDeliverableReviewInputs } from '../src/delivery-execution.js';

// New selected W1 regressions only; genuine Git and immutable ArtifactStore.
// The native private verifier is an isolated integrity boundary, not CD7.
function repository(t: TestContext, label: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'w1-r2-' + label));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '--initial-branch=main'); git('config', 'user.name', 'W1 Reviewer'); git('config', 'user.email', 'reviewer@example.invalid'); git('config', 'core.autocrlf', 'false');
  return { cwd, git, write: (p: string, s: string | Buffer) => writeFileSync(join(cwd, p), s) };
}
test('F2 actual Git A-B / B-A textual reverse matches', (t) => {
  const r = repository(t, 'reverse'); r.write('a.ts', 'const a = 1;\n'); r.git('add', '.'); r.git('commit', '-m', 'A'); const a = r.git('rev-parse', 'HEAD').trim();
  r.write('a.ts', 'const a = 2;\n'); r.git('add', '.'); r.git('commit', '-m', 'B'); const b = r.git('rev-parse', 'HEAD').trim();
  assert.equal(repairDiffReverseFingerprint(r.git('diff', a, b)), repairDiffFingerprint(r.git('diff', b, a)));
});
test('F2 actual pure renames retain meaningful path identity', (t) => {
  const r = repository(t, 'rename'); r.write('a.ts', 'const a = 1;\n'); r.write('c.ts', 'const c = 3;\n'); r.git('add', '.'); r.git('commit', '-m', 'base'); const base = r.git('rev-parse', 'HEAD').trim();
  r.git('mv', 'a.ts', 'b.ts'); r.git('commit', '-m', 'rename a'); const a = r.git('diff', '-M', base, 'HEAD');
  r.git('reset', '--hard', base); r.git('mv', 'c.ts', 'd.ts'); r.git('commit', '-m', 'rename c'); const b = r.git('diff', '-M', base, 'HEAD');
  writeFileSync(join(r.cwd, 'a.diff'), a); writeFileSync(join(r.cwd, 'b.diff'), b);
  assert.notEqual(normalizeRepairDiff(a), '', 'a genuine path repair is substantive');
  assert.notEqual(repairDiffFingerprint(a), repairDiffFingerprint(b));
});
test('F2 actual mode changes on paths containing spaces retain paths', (t) => {
  const r = repository(t, 'spaced-mode'); r.write('a file.sh', 'echo a\n'); r.write('b file.sh', 'echo b\n'); r.git('add', '.'); r.git('commit', '-m', 'base'); const base = r.git('rev-parse', 'HEAD').trim();
  r.git('update-index', '--chmod=+x', 'a file.sh'); r.git('commit', '-m', 'mode a'); const a = r.git('diff', base, 'HEAD');
  r.git('update-index', '--chmod=-x', 'a file.sh'); r.git('update-index', '--chmod=+x', 'b file.sh'); r.git('commit', '-m', 'mode b'); const b = r.git('diff', base, 'HEAD');
  writeFileSync(join(r.cwd, 'a.diff'), a); writeFileSync(join(r.cwd, 'b.diff'), b);
  assert.notEqual(repairDiffFingerprint(a), repairDiffFingerprint(b), 'unsupported path forms must at least preserve raw diff identity');
});
test('F2 repeated same meaningful repair with shifted Git context/index matches', (t) => {
  const r = repository(t, 'context'); r.write('a.ts', '// header\nconst a = 1;\n'); r.git('add', '.'); r.git('commit', '-m', 'base'); const base = r.git('rev-parse', 'HEAD').trim();
  r.write('a.ts', '// header\nconst a = 2;\n'); r.git('add', '.'); r.git('commit', '-m', 'repair'); const a = r.git('diff', base, 'HEAD');
  r.write('a.ts', '// unrelated header\n// header\nconst a = 1;\n'); r.git('add', '.'); r.git('commit', '-m', 'later base'); const later = r.git('rev-parse', 'HEAD').trim();
  r.write('a.ts', '// unrelated header\n// header\nconst a = 2;\n'); r.git('add', '.'); r.git('commit', '-m', 'same repair'); const b = r.git('diff', later, 'HEAD');
  writeFileSync(join(r.cwd, 'a.diff'), a); writeFileSync(join(r.cwd, 'b.diff'), b);
  assert.equal(repairDiffFingerprint(a), repairDiffFingerprint(b), 'same removed/added repair must not miss due to context/index metadata');
});
test('F6 actual verified bytes must be the captured bytes despite interleaved write', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'w1-r2-integrity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new ArtifactStore(root);
  const original = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n';
  const changed = original.replace('const a = 2;', 'const a = 3;');
  const artifact = await store.put(Buffer.from(original), 'text/x-diff', 'W1 integrity');
  const originalVerify = store.verify.bind(store);
  store.verify = async (hash) => {
    const result = await originalVerify(hash); // genuine successful verification, never faked
    writeFileSync(result.path, changed); // deterministic real filesystem interleaving AFTER verification
    return result;
  };
  const runtime = Object.create(NativeDeliverableReviewRuntime.prototype) as { options: { artifacts: ArtifactStore }; verifySubmittedDiff(input: { diffArtifactHash: string; diffText: string }): Promise<void> };
  runtime.options = { artifacts: store };
  await assert.rejects(runtime.verifySubmittedDiff({ diffArtifactHash: artifact.hash, diffText: changed }), /missing|hash|address|verified|bytes/i);
});

test('W1 addressed diff: product input loader rejects bytes changed after successful verification', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'w1-loader-integrity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = new ArtifactStore(root);
  const original = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
  const artifact = await artifacts.put(Buffer.from(original), 'text/x-diff');
  const verify = artifacts.verify.bind(artifacts);
  artifacts.verify = async (hash) => {
    const result = await verify(hash);
    writeFileSync(result.path, original.replace('+new', '+bad'));
    return result;
  };
  const input = {
    task: { id: 'T1', attempt: 1, changeSetId: 'cs1', objective: 'Repair a.ts', acceptanceCriteria: [] },
    submission: { summary: 'Repair', authorRuntimeId: 'worker', changeSet: { id: 'cs1', baselineRevision: 'base', taskRevision: 'head', diffArtifactHash: artifact.hash, changedPaths: ['a.ts'], unresolvedConcerns: [] } },
    artifacts,
  } as unknown as Parameters<typeof loadDeliverableReviewInputs>[0];
  await assert.rejects(loadDeliverableReviewInputs(input), /hash mismatch/);
});

test('W1 failed lineage: changed captured bytes confer no oscillation identity', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'w1-history-integrity-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const artifacts = new ArtifactStore(root);
  const original = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
  const artifact = await artifacts.put(Buffer.from(original), 'text/x-diff');
  const verify = artifacts.verify.bind(artifacts);
  artifacts.verify = async (hash) => {
    const result = await verify(hash);
    writeFileSync(result.path, original.replace('+new', '+bad'));
    return result;
  };
  const runtime = Object.create(NativeDeliverableReviewRuntime.prototype) as {
    options: { artifacts: ArtifactStore };
    projection(runId: string): unknown;
    failedRepairFingerprints(runId: string, taskId: string): Promise<unknown[]>;
  };
  runtime.options = { artifacts };
  runtime.projection = () => ({ delivery: { reviewHistory: { T1: [{ stage: 'completed', satisfied: false, submissionAttempt: 1, diffArtifactHash: artifact.hash }] } } });
  assert.deepEqual(await runtime.failedRepairFingerprints('run', 'T1'), [], 'unverified captured history never invents a failed-repair match');
});

test('W1 actual multiple pure renames match their independently ordered Git reverse', (t) => {
  const r = repository(t, 'multi-rename');
  r.write('z.ts', 'const z = 1;\n'); r.write('a.ts', 'const a = 2;\n');
  r.git('add', '.'); r.git('commit', '-m', 'base'); const a = r.git('rev-parse', 'HEAD').trim();
  r.git('mv', 'z.ts', 'b.ts'); r.git('mv', 'a.ts', 'y.ts'); r.git('commit', '-m', 'renamed');
  const b = r.git('rev-parse', 'HEAD').trim();
  assert.equal(repairDiffReverseFingerprint(r.git('diff', '-M', a, b)), repairDiffFingerprint(r.git('diff', '-M', b, a)));
});

test('W1 actual binary repair reverses while different binary bytes stay distinct', (t) => {
  const r = repository(t, 'binary');
  r.write('payload.bin', Buffer.from([0, 1, 2, 3, 4])); r.git('add', '.'); r.git('commit', '-m', 'base');
  const a = r.git('rev-parse', 'HEAD').trim();
  r.write('payload.bin', Buffer.from([0, 1, 2, 9, 4])); r.git('add', '.'); r.git('commit', '-m', 'binary repair');
  const b = r.git('rev-parse', 'HEAD').trim();
  const forward = r.git('diff', '--binary', a, b);
  assert.equal(repairDiffReverseFingerprint(forward), repairDiffFingerprint(r.git('diff', '--binary', b, a)));
  r.write('payload.bin', Buffer.from([0, 1, 8, 9, 4])); r.git('add', '.'); r.git('commit', '-m', 'fresh repair');
  assert.notEqual(repairDiffFingerprint(forward), repairDiffFingerprint(r.git('diff', '--binary', a, 'HEAD')));
});

test('W1 unsupported copy representation preserves complete source and destination identity', () => {
  const one = 'diff --git a/source.ts b/copy.ts\nsimilarity index 100%\ncopy from source.ts\ncopy to copy.ts\n';
  const two = 'diff --git a/other.ts b/copy.ts\nsimilarity index 100%\ncopy from other.ts\ncopy to copy.ts\n';
  assert.notEqual(repairDiffFingerprint(one), repairDiffFingerprint(two));
});
