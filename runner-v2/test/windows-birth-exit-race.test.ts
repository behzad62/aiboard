import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { performance } from "node:perf_hooks";
const { WindowsBirthSession } = await import(new URL("../src/windows-birth/session.mjs", import.meta.url).href);
const { SLOT } = await import(new URL("../src/windows-birth/queue.mjs", import.meta.url).href);
const { WindowsBirthInspectionOwner } = await import(new URL("../src/windows-birth-inspection.mjs", import.meta.url).href);

type Request = { type: "request"; generation: string; source: string; requestId: number; nonce: string; pid: number; deadline: number; sab: SharedArrayBuffer };
type Cancel = { type: "cancel"; requestId: number };
type Options = { checks?: Array<string | undefined>; same?: boolean; malformed?: boolean; afterPublication?: (fixture: Fixture) => void; duringConfirmation?: (fixture: Fixture) => void; confirmationError?: (fixture: Fixture) => Error };
type Fixture = ReturnType<typeof fixture>;
const nativeErrorFacts = { code: "NATIVE_EXCEPTION", class: "System.ArgumentException", message: "Process with an Id of 77 is not running." };

function fixture(t: TestContext, options: Options = {}) {
  const clock = { now: 100 };
  t.mock.method(performance, "now", () => clock.now);
  const lease = Object.freeze({ generation: "a".repeat(64) });
  const session = Object.assign(Object.create(WindowsBirthSession.prototype), {
    state: "READY", lease, generation: lease.generation, generationState: new SharedArrayBuffer(4),
    config: { binary: { sha256: "b".repeat(64) } }, requestId: 0,
    pending: new Map(), consumed: new Set(), errors: [], firstFailure: null,
    failure: { resolve() {} }, counters: { queries: 0, existenceChecks: 0, maximumUnresolvedSlots: 0, helperSpawns: 0, workerStarts: 0, compilerSpawns: 0 },
  });
  const calls: Array<{ pid: number; signal: string | number | undefined }> = [];
  const requests: Request[] = [];
  const cancellations: Cancel[] = [];
  const abort = new AbortController();
  const result = { session, lease, clock, calls, requests, cancellations, abort };
  t.mock.method(process, "kill", (pid: number, signal?: string | number) => {
    assert.equal(signal, 0, "the fixture permits only read-only existence checks");
    assert.equal(pid, 77);
    calls.push({ pid, signal });
    if (calls.length % 2 === 0) options.duringConfirmation?.(result);
    const code = (options.checks ?? [undefined, "ESRCH"])[calls.length - 1];
    if (code) throw (calls.length % 2 === 0 ? options.confirmationError?.(result) : undefined) ?? Object.assign(new Error(code), { code });
    return true;
  });
  session.worker = { postMessage(record: Request | Cancel) {
    if (record.type === "cancel") { cancellations.push(record); return; }
    requests.push(record);
    const value = {
      ...(options.same ? { status: "same", fingerprint: "2026-10-11T00:00:00.123456Z", utc7: "2026-10-11T00:00:00.1234567Z" }
        : { status: "unknown", reason: "native_error", nativeErrorFacts }),
      generation: record.generation, source: record.source, requestId: record.requestId,
      nonce: record.nonce, pid: record.pid, wireSeq: 1, publishedAt: clock.now,
      ...(options.malformed ? { unexpected: true } : {}),
    };
    const bytes = Buffer.from(JSON.stringify(value));
    new Uint8Array(record.sab, 16, bytes.length).set(bytes);
    const view = new Int32Array(record.sab, 0, 4);
    Atomics.store(view, 1, bytes.length); Atomics.store(view, 2, 1); Atomics.store(view, 0, SLOT.RESULT); Atomics.notify(view, 0);
    options.afterPublication?.(result);
  } };
  return result;
}

function assertRetired(f: Fixture, requests = 1) {
  assert.equal(f.requests.length, requests);
  assert.equal(f.session.pending.size, 0);
  assert.equal(f.session.consumed.size, 0);
  assert.equal(f.session.counters.helperSpawns + f.session.counters.workerStarts + f.session.counters.compilerSpawns, 0);
}

test("sync birth error followed by fresh ESRCH proves absence and retains native facts", t => {
  const f = fixture(t); const value = f.session.querySync(f.lease, 77);
  assert.equal(value.status, "absent"); assert.equal(value.reason, "ESRCH_after_native_error");
  assert.deepEqual(value.nativeErrorFacts, nativeErrorFacts);
  assert.equal(value.absenceConfirmation.existence, "ESRCH"); assert.equal(value.absenceConfirmation.eligible, true);
  assert.equal(value.absenceConfirmation.error.code, "ESRCH");
  assert.equal(f.calls.length, 2); assert.equal(f.session.counters.existenceChecks, 2); assertRetired(f);
});
test("async birth error followed by fresh ESRCH proves absence", async t => {
  const f = fixture(t); const value = await f.session.queryAsync(f.lease, 77, f.abort.signal);
  assert.equal(value.status, "absent"); assert.deepEqual(value.nativeErrorFacts, nativeErrorFacts);
  assert.equal(f.calls.length, 2); assertRetired(f);
});
test("batch uses the same bounded absence confirmation", t => {
  const f = fixture(t); const values = f.session.batchSync(f.lease, [77]);
  assert.equal(values?.get(77)?.status, "absent"); assert.equal(f.calls.length, 2); assertRetired(f);
});
test("native no-process text alone cannot prove absence when the PID is live", t => {
  const f = fixture(t, { checks: [undefined, undefined] }); const value = f.session.querySync(f.lease, 77);
  assert.equal(value.status, "unknown"); assert.deepEqual(value.nativeErrorFacts, nativeErrorFacts);
  assert.equal(f.calls.length, 2); assertRetired(f);
});
test("EPERM during confirmation preserves the native UNKNOWN", t => {
  const f = fixture(t, { checks: [undefined, "EPERM"] }); const value = f.session.querySync(f.lease, 77);
  assert.equal(value.status, "unknown"); assert.deepEqual(value.nativeErrorFacts, nativeErrorFacts); assertRetired(f);
  assert.equal(f.calls.length, 2); assert.equal(value.absenceConfirmation.error.code, "EPERM");
});
test("other existence errors cannot become absence", t => {
  const f = fixture(t, { checks: [undefined, "EIO"] });
  const value = f.session.querySync(f.lease, 77);
  assert.equal(value.status, "unknown"); assert.equal(value.absenceConfirmation.error.code, "EIO"); assert.equal(f.calls.length, 2); assertRetired(f);
});
test("generation loss before collection prevents any confirmation", t => {
  const f = fixture(t, { afterPublication: f => { f.session.state = "FAILED"; } });
  assert.equal(f.session.querySync(f.lease, 77).status, "unknown"); assert.equal(f.calls.length, 1); assertRetired(f);
});
test("generation loss during ESRCH confirmation cannot prove absence", t => {
  const f = fixture(t, { duringConfirmation: f => { f.session.state = "FAILED"; } });
  const value = f.session.querySync(f.lease, 77);
  assert.equal(value.status, "unknown"); assert.deepEqual(value.nativeErrorFacts, nativeErrorFacts); assertRetired(f);
  assert.equal(f.calls.length, 2); assert.equal(value.absenceConfirmation.eligible, false);
});
test("expired original deadline prevents confirmation", t => {
  const f = fixture(t, { afterPublication: f => { f.clock.now = f.requests[0].deadline; } });
  assert.equal(f.session.querySync(f.lease, 77).status, "unknown"); assert.equal(f.calls.length, 1); assertRetired(f);
});
test("deadline crossing during ESRCH confirmation cannot prove absence", t => {
  const f = fixture(t, { duringConfirmation: f => { f.clock.now = f.requests[0].deadline; } });
  const value = f.session.querySync(f.lease, 77);
  assert.equal(value.status, "unknown"); assert.deepEqual(value.nativeErrorFacts, nativeErrorFacts); assertRetired(f);
  assert.equal(f.calls.length, 2); assert.equal(value.absenceConfirmation.eligible, false);
});
test("async cancellation before collection prevents confirmation", async t => {
  const f = fixture(t, { afterPublication: f => f.abort.abort() });
  const value = await f.session.queryAsync(f.lease, 77, f.abort.signal);
  assert.equal(value.status, "unknown"); assert.equal(f.calls.length, 1); assertRetired(f);
});
test("async cancellation during ESRCH confirmation cannot prove absence", async t => {
  const f = fixture(t, { duringConfirmation: f => f.abort.abort() });
  const value = await f.session.queryAsync(f.lease, 77, f.abort.signal);
  assert.equal(value.status, "unknown"); assert.deepEqual(value.nativeErrorFacts, nativeErrorFacts); assertRetired(f);
  assert.equal(f.calls.length, 2); assert.equal(value.absenceConfirmation.eligible, false);
  assert.equal(f.cancellations.length, 1);
});
test("successful native birth requires no extra existence check", t => {
  const f = fixture(t, { same: true }); const value = f.session.querySync(f.lease, 77);
  assert.equal(value.status, "same"); assert.equal(f.calls.length, 1); assertRetired(f);
});
test("initial ESRCH remains absence without native submission", t => {
  const f = fixture(t, { checks: ["ESRCH"] });
  assert.equal(f.session.querySync(f.lease, 77).status, "absent"); assert.equal(f.calls.length, 1); assertRetired(f, 0);
});
test("malformed native slot cannot trigger an absence confirmation", t => {
  const f = fixture(t, { malformed: true });
  assert.equal(f.session.querySync(f.lease, 77).status, "unknown"); assert.equal(f.calls.length, 1); assert.equal(f.session.state, "FAILED"); assertRetired(f);
});
test("stale lease rejects the query before any process observation", t => {
  const f = fixture(t);
  assert.equal(f.session.querySync({}, 77).status, "unknown"); assert.equal(f.calls.length, 0); assertRetired(f, 0);
});
test("replacement lease with identical text cannot accept the old query's confirmation", t => {
  const f = fixture(t, { duringConfirmation: f => { f.session.lease = { ...f.lease }; } });
  const value = f.session.querySync(f.lease, 77);
  assert.equal(value.status, "unknown"); assert.equal(value.absenceConfirmation.eligible, false); assert.equal(f.calls.length, 2); assertRetired(f);
});
test("shared generation retirement during confirmation remains UNKNOWN", t => {
  const f = fixture(t, { duringConfirmation: f => { Atomics.store(new Int32Array(f.session.generationState), 0, 1); } });
  const value = f.session.querySync(f.lease, 77);
  assert.equal(value.status, "unknown"); assert.equal(value.absenceConfirmation.eligible, false); assert.equal(f.calls.length, 2); assertRetired(f);
});
test("non-native queue UNKNOWN cannot trigger confirmation", t => {
  const f = fixture(t, { afterPublication: f => { Atomics.store(new Int32Array(f.requests[0].sab, 0, 4), 0, SLOT.REFUSED); } });
  const value = f.session.querySync(f.lease, 77);
  assert.equal(value.status, "unknown"); assert.equal(value.reason, "queue_full"); assert.equal(f.calls.length, 1); assertRetired(f);
});
async function ownerFixture(f: Fixture) {
  f.session.registerCleanup = (register: (cleanup: () => Promise<void>) => void) => register(async () => {});
  f.session.prepare = async () => f.lease;
  f.session.receipt = () => ({ state: f.session.state });
  class Session { constructor() { return f.session; } }
  const owner = new WindowsBirthInspectionOwner(async () => ({ Session, config: {} }));
  let cleanup = async (_deadline?: number) => {};
  owner.registerCleanup((duty: typeof cleanup) => { cleanup = duty; });
  await owner.prepareInspection(Date.now() + 1000);
  return { owner, close: () => cleanup(Date.now() + 1000) };
}
test("owner retains immutable native and confirmation facts beside the real Session absence", async t => {
  const f = fixture(t); const wrapped = await ownerFixture(f);
  try {
    assert.deepEqual(wrapped.owner.operations().inspectProcessBirth(77, "windows"), { state: "absent" });
    const record = wrapped.owner.receipt().observations.records[0];
    assert.equal(record.result.nativeErrorFacts.class.value, nativeErrorFacts.class);
    assert.equal(record.result.absenceConfirmation.existence.value, "ESRCH");
    assert.equal(record.result.absenceConfirmation.eligible, true);
    assert.equal(record.result.absenceConfirmation.error.code.value, "ESRCH");
    assert.ok(Object.isFrozen(record.result.absenceConfirmation));
    assert.equal(f.calls.length, 2); assertRetired(f);
  } finally { await wrapped.close(); }
});
test("confirmation diagnostic serialization failure cannot change an inspection result", async t => {
  const f = fixture(t); const wrapped = await ownerFixture(f);
  f.session.querySync = () => Object.defineProperty({ status: "absent" }, "absenceConfirmation", { get() { throw Error("diagnostic only"); } });
  try {
    assert.deepEqual(wrapped.owner.operations().inspectProcessBirth(77, "windows"), { state: "absent" });
    assert.equal(wrapped.owner.receipt().observations.unavailable, 1);
    assert.equal(f.calls.length, 0);
  } finally { await wrapped.close(); }
});
test("collect diagnostic serialization failure preserves independently confirmed absence", t => {
  const f = fixture(t, { confirmationError: () => Object.defineProperty(Object.assign(Error("ESRCH"), { code: "ESRCH" }), "message", { get() { throw Error("diagnostic getter"); } }) });
  const value = f.session.querySync(f.lease, 77);
  assert.equal(value.status, "absent"); assert.equal(value.absenceConfirmation.diagnosticUnavailable, true);
  assert.equal(value.absenceConfirmation.eligible, true); assert.equal(f.session.state, "READY"); assert.equal(f.session.firstFailure, null); assertRetired(f);
});
test("deadline crossing inside confirmation diagnostics is rechecked before absence", t => {
  const f = fixture(t, { confirmationError: f => Object.defineProperty(Object.assign(Error("ESRCH"), { code: "ESRCH" }), "message", { get() { f.clock.now = f.requests[0].deadline; return "ESRCH"; } }) });
  const value = f.session.querySync(f.lease, 77);
  assert.equal(value.status, "unknown"); assert.equal(value.absenceConfirmation.existence, "ESRCH"); assert.equal(value.absenceConfirmation.eligible, false);
  assert.deepEqual(value.nativeErrorFacts, nativeErrorFacts); assert.equal(f.session.state, "READY"); assertRetired(f);
});
