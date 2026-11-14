// The Windows self-birth preparation of owned-fence-lock.mjs, which no claim uses since FL2 (FL4 removes it): the whole
// module runs in a vm with a fake clock and a fake cold powershell.exe, so these run on every platform in about a
// second, with real SQLite under a temporary folder. Plus the Windows Job host's wiring.
import assert from "node:assert/strict";
import * as childProcess from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import * as sqlite from "node:sqlite";
import test from "node:test";
import vm from "node:vm";

import * as hostTiming from "../src/host-timing.mjs";
import { currentProcessBirthPreparation, prepareCurrentProcessBirthFingerprint } from "../src/owned-fence-lock.mjs";
import { createWindowsJobProcessHost } from "../src/windows-job-process-host.js";
import * as windowsPathLimits from "../src/windows-path-limits.mjs";

const SOURCE = readFileSync(new URL("../src/owned-fence-lock.mjs", import.meta.url), "utf8");
const PRESENT_BIRTH = "PRESENT:2026-10-31T00:43:01.1234567Z\r\n";
const BIRTH = "2026-10-31T00:43:01.123456Z";
const T0 = 1_000_000;

interface FakeTimer { at: number; seq: number; callback: () => void; refed: boolean; cleared: boolean }
interface FakeChild { startedAt: number; killed: boolean; killedAt?: number; unrefed: Set<string>; done: boolean }

// One module instance: a fake clock and timers, a fake execFile whose powershell.exe starts take `coldStartMs`
// (Infinity: never), honouring its own `timeout` option as node does, and a sync execFileSync probe. By default the sync
// probe never answers: it spends its whole `timeout` on the fake clock and fails, as a timed-out cold start does; a
// test that needs it to answer passes `syncProbe` (how long call `call` takes, and what it prints, or an error).
// `completionLagMs`: how much later than the probe's exit its caller gets to run (a busy event loop).
type SyncProbe = (call: number) => { ms: number; output?: string; fails?: boolean };
function loadModule(options: { coldStartMs: number | ((call: number) => number); output?: (call: number) => string; platform?: string; completionLagMs?: number; syncProbe?: SyncProbe }) {
  const clock = { now: T0 };
  const timers = new Set<FakeTimer>();
  let seq = 0;
  const fakeSetTimeout = (callback: () => void, ms = 0) => {
    const timer: FakeTimer & { unref(): FakeTimer; ref(): FakeTimer; hasRef(): boolean } = {
      at: clock.now + Math.max(0, ms), seq: seq++, callback, refed: true, cleared: false,
      unref() { timer.refed = false; return timer; }, ref() { timer.refed = true; return timer; }, hasRef() { return timer.refed; },
    };
    timers.add(timer);
    return timer;
  };
  const fakeClearTimeout = (timer?: FakeTimer) => { if (timer) { timer.cleared = true; timers.delete(timer); } };
  const children: FakeChild[] = [];
  const syncCalls: number[] = [];
  const exitListeners = new Set<() => void>();
  const execFile = (_file: string, _args: string[], execOptions: { timeout?: number }, callback: (error: Error | null, stdout: string) => void) => {
    const call = children.length;
    const child: FakeChild = { startedAt: clock.now, killed: false, unrefed: new Set(), done: false };
    children.push(child);
    const exit = (error: Error | null, stdout = "") => {
      if (child.done) return;
      child.done = true;
      fakeClearTimeout(started);
      fakeClearTimeout(timedOut);
      Promise.resolve().then(() => callback(error, stdout));
    };
    const coldStartMs = typeof options.coldStartMs === "function" ? options.coldStartMs(call) : options.coldStartMs;
    const started = Number.isFinite(coldStartMs) ? fakeSetTimeout(() => { clock.now += options.completionLagMs ?? 0; exit(null, options.output?.(call) ?? PRESENT_BIRTH); }, coldStartMs) : undefined;
    const kill = () => { if (child.done) return; child.killed = true; child.killedAt = clock.now; exit(Object.assign(new Error("Command failed: powershell.exe"), { killed: true, signal: "SIGTERM" })); };
    const timedOut = execOptions.timeout ? fakeSetTimeout(kill, execOptions.timeout) : undefined;
    const pipe = (name: string) => ({ unref: () => { child.unrefed.add(name); } });
    return { unref: () => { child.unrefed.add("child"); }, kill, stdin: pipe("stdin"), stdout: pipe("stdout"), stderr: pipe("stderr") };
  };
  const execFileSync = (_file: string, _args: string[], execOptions: { timeout: number }) => {
    const call = syncCalls.length;
    syncCalls.push(execOptions.timeout);
    const probe = options.syncProbe?.(call) ?? { ms: Number.POSITIVE_INFINITY };
    if (probe.ms >= execOptions.timeout) {
      clock.now += execOptions.timeout;
      throw Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
    }
    clock.now += probe.ms;
    if (probe.fails) throw new Error("Command failed: powershell.exe");
    return probe.output ?? PRESENT_BIRTH;
  };
  const fakeProcess = {
    pid: process.pid, platform: options.platform ?? "win32",
    once: (event: string, listener: () => void) => { if (event === "exit") exitListeners.add(listener); },
    off: (event: string, listener: () => void) => { if (event === "exit") exitListeners.delete(listener); },
  };
  const context = vm.createContext({
    ...childProcess, execFile, execFileSync, ...crypto, ...fs, ...path, ...sqlite, ...windowsPathLimits, ...hostTiming, Buffer,
    process: fakeProcess, Date: { now: () => clock.now }, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
  });
  const body = SOURCE
    .replace(/^import \{[^}]*\} from "[^"]+";$/gm, "")
    .replace(/^export (?=(?:async )?function |class |const |let )/gm, "");
  assert.doesNotMatch(body, /^(?:import|export)\b/m, "the whole module loads");
  vm.runInContext(`${body}\nglobalThis.__module = { withOwnedFenceLock, withOwnedFenceLockSync, prepareCurrentProcessBirthFingerprint, currentProcessBirthPreparation, parseWindowsBirthProbe, currentProcessBirthFingerprint };`, context);
  const lockModule = context.__module as {
    currentProcessBirthFingerprint(remainingMs?: number): string;
    withOwnedFenceLock<T>(path: string, effect: () => T, options?: Record<string, unknown>): Promise<T>;
    withOwnedFenceLockSync<T>(path: string, effect: () => T, options?: Record<string, unknown>): T;
    prepareCurrentProcessBirthFingerprint(waitUntil?: number): Promise<string | undefined>;
    currentProcessBirthPreparation(): string;
    parseWindowsBirthProbe(output: string): { state: string; fingerprint?: string };
  };

  const settle = () => new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  const pending = () => [...timers].filter((timer) => !timer.cleared).sort((a, b) => a.at - b.at || a.seq - b.seq);
  /** Runs the fake clock, timer by timer, until `promise` settles (or no timer is left before `limitMs` from now). */
  async function drive<T>(promise: Promise<T>, limitMs = 60_000): Promise<{ ok: true; value: T; at: number } | { ok: false; error: Error; at: number }> {
    let outcome: { ok: true; value: T } | { ok: false; error: Error } | undefined;
    promise.then((value) => { outcome = { ok: true, value }; }, (error: Error) => { outcome = { ok: false, error }; });
    const limit = clock.now + limitMs;
    for (let fired = 0; ; fired += 1) {
      if (fired > 10_000) throw new Error(`no progress: 10 000 timers fired by ${clock.now - T0} ms`);
      await settle();
      if (outcome) return { ...outcome, at: clock.now - T0 };
      const next = pending()[0];
      if (!next || next.at > limit) throw new Error(`nothing settled by ${clock.now - T0} ms`);
      clock.now = Math.max(clock.now, next.at);
      timers.delete(next);
      next.callback();
    }
  }
  /** Runs every timer due up to `ms` from now. */
  async function advance(ms: number): Promise<void> {
    const until = clock.now + ms;
    for (let fired = 0; ; fired += 1) {
      if (fired > 10_000) throw new Error(`no progress: 10 000 timers fired by ${clock.now - T0} ms`);
      await settle();
      const next = pending()[0];
      if (!next || next.at > until) break;
      clock.now = Math.max(clock.now, next.at);
      timers.delete(next);
      next.callback();
    }
    clock.now = until;
    await settle();
  }
  return { module: lockModule, clock, children, syncCalls, exitListeners, pending, drive, advance };
}

function withLockFolder<T>(body: (lockPath: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-self-birth-"));
  return body(join(root, "effect.sqlite")).finally(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
}

// FL2: a claim is SQLite's own file lock (owned-fence-lock.mjs). It neither records nor probes a holder, so it never
// starts, waits for or reads this process's self-birth, on Windows either; FL4 removes the probe itself.
test("a claim never starts, waits for or reads a self-birth probe, on Windows too", async () => {
  await withLockFolder(async (lockPath) => {
    const harness = loadModule({ coldStartMs: Number.POSITIVE_INFINITY });
    for (let index = 0; index < 3; index += 1) {
      const result = await harness.drive(harness.module.withOwnedFenceLock(lockPath, () => "effect ran", { deadlineMs: 10_000 }));
      assert.ok(result.ok, `the claim succeeded: ${result.ok ? "" : result.error.message}`);
      assert.equal(result.value, "effect ran");
      assert.equal(result.at, 0, "at once: no wait for a cold powershell.exe start");
    }
    assert.equal(harness.module.withOwnedFenceLockSync(lockPath, () => "sync effect ran"), "sync effect ran");
    assert.equal(harness.children.length, 0, "no background probe started");
    assert.deepEqual(harness.syncCalls, [], "no sync probe");
    assert.equal(harness.module.currentProcessBirthPreparation(), "idle");
  });
});

test("with no claim waiting, one background probe lasts its 30 s cap and never caches an unknown identity", async () => {
  const harness = loadModule({ coldStartMs: Number.POSITIVE_INFINITY });
  const result = await harness.drive(harness.module.prepareCurrentProcessBirthFingerprint(), 120_000);
  assert.ok(result.ok);
  assert.equal(result.value, undefined, "it resolves to undefined, never rejects");
  assert.equal(harness.children.length, 1, "one probe, never restarted cold while it might still answer");
  assert.equal(harness.children[0]!.killedAt! - T0, 30_000);
  assert.equal(result.at, 30_000);
  assert.equal(harness.module.currentProcessBirthPreparation(), "idle");

  // Garbled output of a run that exited 0 (review N6) is unknown too: not cached, and the probe runs again.
  const outputs = ["PRESENT:garbage\r\n", PRESENT_BIRTH];
  const garbled = loadModule({ coldStartMs: 100, output: (call) => outputs[call]! });
  const learned = await garbled.drive(garbled.module.prepareCurrentProcessBirthFingerprint());
  assert.ok(learned.ok);
  assert.equal(learned.value, BIRTH);
  assert.equal(garbled.children.length, 2);
  assert.equal(garbled.children[1]!.startedAt - T0, 125, "after the 25 ms retry delay");
});

// The sync probe (currentProcessBirthFingerprint): one probe gets all of the caller's time.
test("the sync self-birth probe gets the caller's whole time and returns the moment it answers", () => {
  const slow = loadModule({ coldStartMs: Number.POSITIVE_INFINITY, syncProbe: () => ({ ms: 6_000 }) });
  assert.equal(slow.module.currentProcessBirthFingerprint(10_000), BIRTH);
  assert.deepEqual(slow.syncCalls, [10_000], "one probe bounded by the caller's 10 s, never a 2 s slice");
  assert.equal(slow.clock.now - T0, 6_000);

  const never = loadModule({ coldStartMs: Number.POSITIVE_INFINITY });
  assert.throws(() => never.module.currentProcessBirthFingerprint(10_000), /Current owned fence holder birth identity is unavailable/);
  assert.deepEqual(never.syncCalls, [10_000], "a probe that never answers is not restarted");
  assert.equal(never.clock.now - T0, 10_000, "and fails closed at the caller's deadline, never later");

  const defaulted = loadModule({ coldStartMs: Number.POSITIVE_INFINITY });
  assert.throws(() => defaulted.module.currentProcessBirthFingerprint(), /birth identity is unavailable/);
  assert.deepEqual(defaulted.syncCalls, [15_000], "the default is the lock's measured claim deadline");
});

test("the sync self-birth probe retries a probe that failed early, and never caches an unknown identity", () => {
  const flaky = loadModule({ coldStartMs: Number.POSITIVE_INFINITY, syncProbe: (call) => call < 2 ? { ms: 100, fails: true } : { ms: 100 } });
  assert.equal(flaky.module.currentProcessBirthFingerprint(1_000), BIRTH);
  assert.deepEqual(flaky.syncCalls, [1_000, 900, 800], "each retry gets the time still left");

  let answers = false;
  const recovering = loadModule({ coldStartMs: Number.POSITIVE_INFINITY, syncProbe: () => answers ? { ms: 10 } : { ms: Number.POSITIVE_INFINITY } });
  assert.throws(() => recovering.module.currentProcessBirthFingerprint(60), /birth identity is unavailable/);
  answers = true;
  assert.equal(recovering.module.currentProcessBirthFingerprint(), BIRTH, "an unknown result was not cached; the next call probes again");
  assert.equal(recovering.syncCalls.length, 2);
});

test("the Windows birth probe output is accepted only in the round-trip format", () => {
  const { module: lockModule } = loadModule({ coldStartMs: 0 });
  assert.deepEqual({ ...lockModule.parseWindowsBirthProbe("PRESENT:2026-10-31T00:43:01.1234567Z") }, { state: "same", fingerprint: BIRTH });
  assert.deepEqual({ ...lockModule.parseWindowsBirthProbe("PRESENT:2026-10-31T00:43:01Z") }, { state: "same", fingerprint: "2026-10-31T00:43:01Z" });
  assert.deepEqual({ ...lockModule.parseWindowsBirthProbe("ABSENT") }, { state: "absent" });
  for (const garbled of ["PRESENT:garbage", "PRESENT:2026-10-31", "PRESENT:2026-10-31T00:43:01.12345678Z", "PRESENT:2026-10-31T00:43:01.1234567", "PRESENT:2026-10-31 00:43:01Z", "PRESENT: 2026-10-31T00:43:01Z", "present:2026-10-31T00:43:01Z"])
    assert.deepEqual({ ...lockModule.parseWindowsBirthProbe(garbled) }, { state: "unknown" }, garbled);
});

// Review N5: what a claim refuses, it refuses with its own error, and without starting a probe.
test("invalid bounds and a spent deadline get the claim's own errors without a probe", async () => {
  await withLockFolder(async (lockPath) => {
    const harness = loadModule({ coldStartMs: Number.POSITIVE_INFINITY });
    for (const options of [{ retryDelayMs: 0 }, { retryDelayMs: 1.5 }, { deadlineMs: 0 }, { deadlineAt: Number.NaN }]) {
      const refused = await harness.drive(harness.module.withOwnedFenceLock(lockPath, () => "effect ran", options));
      assert.ok(!refused.ok, JSON.stringify(options));
      assert.match(refused.error.message, /bounds are invalid|absolute deadline is invalid/, JSON.stringify(options));
    }
    const spent = await harness.drive(harness.module.withOwnedFenceLock(lockPath, () => "effect ran", { deadlineAt: T0 - 1 }));
    assert.ok(!spent.ok);
    assert.equal(spent.error.name, "OwnedFenceContentionError");
    assert.match(spent.error.message, /deadline is exhausted/);
    assert.equal(harness.children.length, 0, "no probe started");
    assert.equal(harness.module.currentProcessBirthPreparation(), "idle");
  });
});

test("the self-birth preparation starts no probe off Windows", async () => {
  const posix = loadModule({ coldStartMs: Number.POSITIVE_INFINITY, platform: "linux" });
  const prepared = await posix.drive(posix.module.prepareCurrentProcessBirthFingerprint());
  assert.ok(prepared.ok);
  assert.equal(prepared.value, undefined);
  assert.equal(posix.children.length, 0, "no probe starts off Windows");
});

// Review N1: the preparation alone never keeps the process alive, and its probe never outlives the process.
test("the background probe, its pipes and its timers are unref'd, and the probe is killed when the process exits", async () => {
  const harness = loadModule({ coldStartMs: Number.POSITIVE_INFINITY });
  void harness.module.prepareCurrentProcessBirthFingerprint();
  await harness.advance(100);
  const child = harness.children[0]!;
  assert.deepEqual([...child.unrefed].sort(), ["child", "stderr", "stdin", "stdout"]);
  assert.ok(harness.pending().every((timer) => !timer.refed), "no ref'd timer while nothing waits");
  assert.equal(harness.exitListeners.size, 1, "the running probe is killed on exit");

  // A caller that waits keeps the loop alive itself, until its own deadline.
  void harness.module.prepareCurrentProcessBirthFingerprint(T0 + 5_000);
  await harness.advance(1);
  assert.equal(harness.pending().filter((timer) => timer.refed).length, 1, "only the waiting caller's own deadline timer is ref'd");
  await harness.advance(5_000);
  assert.ok(harness.pending().every((timer) => !timer.refed), "the waiter left no ref'd timer behind");

  for (const listener of [...harness.exitListeners]) listener();
  assert.equal(harness.children.at(-1)!.killed, true, "process exit kills the running probe");

  const finished = loadModule({ coldStartMs: 100 });
  await finished.drive(finished.module.prepareCurrentProcessBirthFingerprint());
  assert.equal(finished.exitListeners.size, 0, "a finished probe removes its exit hook");
  assert.equal(finished.pending().length, 0);
});

// Review S2: the Windows Job host starts the preparation when it is created; nothing here awaits it first.
test("creating a Windows Job host starts this process's self-birth preparation", { skip: process.platform !== "win32" }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-self-birth-host-"));
  try {
    assert.equal(currentProcessBirthPreparation(), "idle", "nothing in this process prepared it before the host");
    createWindowsJobProcessHost({ stateDirectory: root, platform: "win32" });
    assert.equal(currentProcessBirthPreparation(), "preparing");
    assert.ok(await prepareCurrentProcessBirthFingerprint(Date.now() + 30_000), "and it learns the identity");
    assert.equal(currentProcessBirthPreparation(), "known");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});
