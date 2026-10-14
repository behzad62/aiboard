import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPortableProcessChannelProvider } from '../src/portable-process-channel.js';
import { WindowsBirthInspectionOwner } from '../src/windows-birth-inspection.mjs';
import type { ProcessBackendBinding } from '../src/process-backend.js';

const fence = { ownerId: 'diagnostic-test', fencingToken: 1 };
const binding: ProcessBackendBinding = { registryId: 'test', backendId: 'test', implementationGeneration: 'test', implementationDigest: '1'.repeat(64), attestationVersion: 1, attestationDigest: '2'.repeat(64), opaqueIdentity: 'test', birthFingerprint: { observedAt: 'now', discriminator: 'test' }, startedAt: 'now' };
type TerminalDiagnostic = { reason: string; stage: string; error?: unknown };
async function channelFixture(observe: (signal: AbortSignal) => Promise<'live' | 'exited'>, status = 'running') {
  const root = mkdtempSync(join(tmpdir(), 't8-terminal-diagnostic-'));
  for (const directory of ['output', 'input', 'ack']) mkdirSync(join(root, 'channel', directory), { recursive: true });
  writeFileSync(join(root, 'channel/output-checkpoint.json'), JSON.stringify({ nonce: 'nonce', stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 } }));
  writeFileSync(join(root, 'state.json'), JSON.stringify({ nonce: 'nonce', status, exitCode: 0, signal: null }));
  const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 4, replayCapacityBytes: 1024, pollIntervalMs: 1, authority: () => ({ directory: root, nonce: 'nonce', fence, reattest: () => 'live', reattestObservation: observe, reattestFence: () => {}, effect: async (_kind, effect) => effect(), snapshot: read => ({ status: 'applied', value: read() }) }) });
  const channel = await provider.acquire(binding, fence);
  const diagnostic = () => (channel as unknown as { terminalDiagnostic?: TerminalDiagnostic }).terminalDiagnostic;
  return { channel, diagnostic, close: async () => { await channel.detach(); rmSync(root, { recursive: true, force: true }); } };
}
test('terminal diagnostics preserve the first original nested exception without changing UNKNOWN', { timeout: 2000 }, async () => {
  const native = Object.assign(Error('native sentinel'), { code: 'WIN32_TEST', nativeExit: { code: 1 } });
  const original = new AggregateError([native], 'original terminal', { cause: native }); let calls = 0;
  const fixture = await channelFixture(async () => { if (++calls === 1) throw original; throw Error('later'); });
  try {
    assert.deepEqual(await fixture.channel.waitForTerminal(), { state: 'outcome_unknown' });
    assert.equal(fixture.diagnostic()?.reason, 'caught_exception'); assert.equal(fixture.diagnostic()?.stage, 'identity'); assert.equal(fixture.diagnostic()?.error, original);
    assert.deepEqual(await fixture.channel.waitForTerminal(), { state: 'outcome_unknown' }); assert.equal(fixture.diagnostic()?.error, original);
    assert.equal(Object.isFrozen(fixture.diagnostic()), true);
  } finally { await fixture.close(); }
});
test('explicit UNKNOWN retains its branch without inventing an exception', { timeout: 2000 }, async () => {
  const fixture = await channelFixture(async () => 'live', 'outcome_unknown');
  try { assert.deepEqual(await fixture.channel.waitForTerminal(), { state: 'outcome_unknown' }); assert.equal(fixture.diagnostic()?.reason, 'supervisor_outcome_unknown'); assert.equal(fixture.diagnostic()?.error, undefined); }
  finally { await fixture.close(); }
});
test('cancelled terminal observation does not become a failure diagnostic', { timeout: 2000 }, async () => {
  let started!: () => void; const ready = new Promise<void>(resolve => { started = resolve; });
  const fixture = await channelFixture(signal => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => reject(Error('cancelled sentinel')), { once: true }); started(); }));
  try { const waiting = fixture.channel.waitForTerminal(); await ready; await fixture.channel.detach(); assert.deepEqual(await waiting, { state: 'outcome_unknown' }); assert.equal(fixture.diagnostic(), undefined); }
  finally { await fixture.close(); }
});
test('normal terminal settlement keeps its exact result without a diagnostic', { timeout: 2000 }, async () => {
  const fixture = await channelFixture(async () => 'live', 'stopped');
  try { assert.deepEqual(await fixture.channel.waitForTerminal(), { state: 'exited', exitCode: 0 }); assert.equal(fixture.diagnostic(), undefined); }
  finally { await fixture.close(); }
});

type Result = { status: string; reason?: string; fingerprint?: string; nativeErrorFacts?: { code: string; class: string; message: string } };
type TextFact = { value: string; originalLength: number; truncated: boolean };
type Observation = { sequence: number; pid: number; mode: string; generation: string; startedAt: number; completedAt: number; result: { status: TextFact; reason?: TextFact; nativeErrorFacts?: { code: TextFact; message: TextFact }; error?: { message: TextFact; cause?: { code: TextFact } } } };
type Trace = { started: number; dropped: number; unavailable: number; records: Observation[] };
class FakeSession {
  generation = 'a'.repeat(64); lease = {}; calls = { sync: 0, async: 0, batch: 0 }; cleanup?: () => Promise<void>;
  sync: (pid: number) => Result = () => ({ status: 'absent' }); async: (pid: number) => Promise<Result> = async () => ({ status: 'absent' });
  registerCleanup(register: (cleanup: () => Promise<void>) => void) { register(async () => {}); }
  async prepare() { return this.lease; } validLease(lease: unknown) { return lease === this.lease; }
  querySync(_lease: unknown, pid: number) { this.calls.sync++; return this.sync(pid); }
  async queryAsync(_lease: unknown, pid: number) { this.calls.async++; return await this.async(pid); }
  batchSync(_lease: unknown, pids: number[]) { this.calls.batch++; return new Map(pids.map(pid => [pid, { status: 'absent' }])); }
  receipt() { return { state: 'READY', calls: { ...this.calls } }; }
}
async function ownerFixture() {
  const session = new FakeSession();
  class Session { constructor() { return session; } }
  const owner = Reflect.construct(WindowsBirthInspectionOwner, [async () => ({ Session, config: {} })]) as WindowsBirthInspectionOwner;
  let cleanup!: (deadline?: number) => Promise<void>; owner.registerCleanup(duty => { cleanup = duty; }); await owner.prepareInspection(Date.now() + 1000);
  const trace = () => { const value = (owner.receipt() as unknown as { observations?: Trace }).observations; assert.ok(value, 'Owner inspection diagnostics are missing'); return value; };
  return { owner, session, trace, operations: owner.operations(), close: () => cleanup(Date.now() + 1000) };
}
test('owner observations retain native UNKNOWN facts without changing query outcomes or counts', async () => {
  const fixture = await ownerFixture(); const native = { code: 'WIN32_87', class: 'NativeError', message: 'original native' };
  fixture.session.sync = () => ({ status: 'unknown', reason: 'native_error', nativeErrorFacts: native }); fixture.session.async = async () => fixture.session.sync(1);
  try {
    assert.deepEqual(fixture.operations.inspectProcessBirth(1, 'windows'), { state: 'unknown' }); assert.deepEqual(await fixture.operations.inspectProcessBirthAsync!(2, 'windows', new AbortController().signal), { state: 'unknown' });
    const records = fixture.trace().records; assert.equal(records.length, 2); assert.deepEqual(records.map(row => row.mode), ['sync', 'async']); assert.deepEqual(records.map(row => row.pid), [1, 2]);
    assert.equal(records[1].result.nativeErrorFacts?.code.value, 'WIN32_87'); native.code = 'mutated'; assert.equal(records[1].result.nativeErrorFacts?.code.value, 'WIN32_87');
    assert.equal(Object.isFrozen(records), true); assert.equal(Object.isFrozen(records[1].result.nativeErrorFacts?.code), true); assert.equal(fixture.session.calls.sync, 1); assert.equal(fixture.session.calls.async, 1);
  } finally { await fixture.close(); }
});
test('owner observations retain a thrown original cause while public inspection stays UNKNOWN', async () => {
  const fixture = await ownerFixture(); fixture.session.sync = () => { throw new Error('outer', { cause: Object.assign(Error('native cause'), { code: 'NATIVE_TEST' }) }); };
  try { assert.deepEqual(fixture.operations.inspectProcessBirth(1, 'windows'), { state: 'unknown' }); assert.equal(fixture.trace().records[0].result.error?.cause?.code.value, 'NATIVE_TEST'); assert.equal(fixture.session.calls.sync, 1); }
  finally { await fixture.close(); }
});
test('owner records distinguish interleaved operations and bound completion history', async () => {
  const fixture = await ownerFixture(); let complete!: (result: Result) => void; fixture.session.async = () => new Promise(resolve => { complete = resolve; });
  try {
    const pending = fixture.operations.inspectProcessBirthAsync!(1, 'windows', new AbortController().signal); assert.deepEqual(fixture.operations.inspectProcessBirth(2, 'windows'), { state: 'absent' }); complete({ status: 'same', fingerprint: 'birth' }); assert.deepEqual(await pending, { state: 'present', fingerprint: 'birth' });
    assert.deepEqual(fixture.trace().records.map(row => row.sequence), [2, 1]);
    for (let pid = 3; pid <= 22; pid++) assert.deepEqual(fixture.operations.inspectProcessBirth(pid, 'windows'), { state: 'absent' });
    const trace = fixture.trace(); assert.equal(trace.records.length, 16); assert.equal(trace.started, 22); assert.equal(trace.dropped, 6); assert.equal(trace.unavailable, 0);
    assert.ok(trace.records.every(row => row.completedAt >= row.startedAt && row.generation === fixture.session.generation)); assert.equal(fixture.session.calls.sync + fixture.session.calls.async, 22);
  } finally { await fixture.close(); }
});
test('diagnostic serialization failure preserves the genuine inspection result', async () => {
  const fixture = await ownerFixture(); fixture.session.sync = () => Object.defineProperty({ status: 'absent' }, 'nativeErrorFacts', { get() { throw Error('diagnostic getter'); } });
  try { assert.deepEqual(fixture.operations.inspectProcessBirth(1, 'windows'), { state: 'absent' }); assert.equal(fixture.trace().unavailable, 1); assert.equal(fixture.trace().records.length, 0); assert.equal(fixture.session.calls.sync, 1); }
  finally { await fixture.close(); }
});
test('batch inspection keeps its original results and is explicitly excluded from individual history', async () => {
  const fixture = await ownerFixture();
  try { assert.deepEqual(fixture.operations.inspectProcessBirths!([1, 2], 'windows'), new Map([[1, { state: 'absent' }], [2, { state: 'absent' }]])); assert.equal(fixture.session.calls.batch, 1); assert.equal(fixture.trace().records.length, 0); }
  finally { await fixture.close(); }
});
