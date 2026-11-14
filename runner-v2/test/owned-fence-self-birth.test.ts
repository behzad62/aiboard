// The Windows self-birth preparation of the owned fence lock (owned-fence-lock.mjs), driven through the real
// withOwnedFenceLock: the whole module runs in a vm with a fake clock and a fake cold powershell.exe, so these run
// on every platform in about a second, with real SQLite under a temporary folder. Plus the Windows Job host's wiring.
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
    ...childProcess, execFile, execFileSync, ...crypto, ...fs, ...path, ...sqlite, ...windowsPathLimits, ...hostTiming,
    process: fakeProcess, Date: { now: () => clock.now }, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
  });
  const body = SOURCE
    .replace(/^import \{[^}]*\} from "[^"]+";$/gm, "")
    .replace(/^export (?=(?:async )?function |class |const |let )/gm, "");
  assert.doesNotMatch(body, /^(?:import|export)\b/m, "the whole module loads");
  vm.runInContext(`${body}\nglobalThis.__module = { withOwnedFenceLock, prepareCurrentProcessBirthFingerprint, currentProcessBirthPreparation, parseWindowsBirthProbe, currentProcessBirthFingerprint };`, context);
  const lockModule = context.__module as {
    currentProcessBirthFingerprint(remainingMs?: number): string;
    withOwnedFenceLock<T>(path: string, effect: () => T, options?: Record<string, unknown>): Promise<T>;
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

// Review S1: a 10 s caller used to lose to a 6 s cold start, because the background attempts kept fixed 2/4/8 s
// bounds and each new attempt started cold again. Now one probe lasts until it answers or its cap.
// Also S2: reverting withOwnedFenceLock to `acquire(path, options)` sends this claim to the sync probe and fails it.
test("a 10 s claim through withOwnedFenceLock outlasts a 6 s powershell.exe cold start with one probe", async () => {
  await withLockFolder(async (lockPath) => {
    const harness = loadModule({ coldStartMs: 6_000 });
    const result = await harness.drive(harness.module.withOwnedFenceLock(lockPath, () => "effect ran", { deadlineMs: 10_000 }));
    assert.ok(result.ok, `the claim succeeded: ${result.ok ? "" : result.error.message}`);
    assert.equal(result.value, "effect ran");
    assert.equal(result.at, 6_000, "it ran when the cold start returned, inside its own 10 s");
    assert.equal(harness.children.length, 1, "one cold start, never killed and restarted");
    assert.equal(harness.children[0]!.killed, false);
    assert.deepEqual(harness.syncCalls, [], "acquire never started its own sync probe");
    assert.equal(harness.module.currentProcessBirthPreparation(), "known");
  });
});

test("a claim whose deadline passes before the cold start fails closed at that deadline, and the probe goes on for the next one", async () => {
  await withLockFolder(async (lockPath) => {
    const never = loadModule({ coldStartMs: Number.POSITIVE_INFINITY });
    const failed = await never.drive(never.module.withOwnedFenceLock(lockPath, () => "effect ran", { deadlineMs: 10_000 }));
    assert.ok(!failed.ok);
    assert.match(failed.error.message, /Current owned fence holder birth identity is unavailable/);
    assert.equal(failed.at, 10_000, "exactly at the caller's own deadline, never later");
    assert.equal(never.children[0]!.killed, false, "the probe is not killed with the claim that gave up");
    assert.equal(never.module.currentProcessBirthPreparation(), "preparing");
    assert.deepEqual(never.syncCalls, []);

    // The default deadline (15 s, set from measured claims): a 20 s cold start outlives the first claim, which fails
    // closed at 15 s; the same probe answers at 20 s and the next claim needs no cold start.
    const slow = loadModule({ coldStartMs: 20_000 });
    const first = await slow.drive(slow.module.withOwnedFenceLock(lockPath, () => "effect ran"));
    assert.ok(!first.ok);
    assert.match(first.error.message, /birth identity is unavailable/);
    assert.equal(first.at, 15_000);
    assert.equal(slow.module.currentProcessBirthPreparation(), "preparing", "the failed claim leaves the probe running");
    await slow.advance(5_100);
    assert.equal(slow.module.currentProcessBirthPreparation(), "known");
    assert.equal(slow.children.length, 1, "one cold start, never killed and restarted");
    const second = await slow.drive(slow.module.withOwnedFenceLock(lockPath, () => "effect ran"));
    assert.ok(second.ok, "the next claim needs no cold start");
    assert.equal(slow.children.length, 1);
    assert.deepEqual(slow.syncCalls, []);

    // A 9 s cold start (2x load on 16 CPUs measured 4.9-9.1 s) fits the default claim.
    const loaded = loadModule({ coldStartMs: 9_000 });
    const ran = await loaded.drive(loaded.module.withOwnedFenceLock(lockPath, () => "effect ran"));
    assert.ok(ran.ok);
    assert.equal(ran.at, 9_000, "it ran the moment the probe answered");
  });
});

// Review B: the wait spends the claim's own time. acquire gets the original absolute deadline, never a fresh
// deadlineMs from when the wait ended (a 2 s claim that waited 1.9 s must not get up to 3.9 s in all).
test("a claim that waited for the probe reaches acquire with its original deadline, never a fresh one", async () => {
  await withLockFolder(async (lockPath) => {
    // The probe returns at 1.9 s and the claim gets to run 150 ms later, past its 2 s.
    const late = loadModule({ coldStartMs: 1_900, completionLagMs: 150 });
    const result = await late.drive(late.module.withOwnedFenceLock(lockPath, () => "effect ran", { deadlineMs: 2_000 }));
    assert.ok(!result.ok, "a fresh 2 s in acquire would have run the effect at 2.05 s");
    assert.equal(result.error.name, "OwnedFenceContentionError");
    assert.match(result.error.message, /deadline is exhausted/);
    assert.equal(late.module.currentProcessBirthPreparation(), "known", "the identity it learned stays for the next claim");

    // An earlier absolute deadline from the caller stays as well.
    const early = loadModule({ coldStartMs: 900, completionLagMs: 150 });
    const capped = await early.drive(early.module.withOwnedFenceLock(lockPath, () => "effect ran", { deadlineMs: 10_000, deadlineAt: T0 + 1_000 }));
    assert.ok(!capped.ok);
    assert.match(capped.error.message, /deadline is exhausted/);

    const onTime = loadModule({ coldStartMs: 1_900 });
    const ran = await onTime.drive(onTime.module.withOwnedFenceLock(lockPath, () => "effect ran", { deadlineMs: 2_000 }));
    assert.ok(ran.ok, "inside its deadline the same claim runs");
  });
});

// Review A: a probe lasts at most its 30 s cap from its own start, so a busy host whose claims never stop cannot keep
// a hung probe alive: it is killed at that cap and, while claims still wait, replaced after a short delay.
test("a stream of overlapping claims cannot keep a hung probe alive past its 30 s cap", async () => {
  const harness = loadModule({ coldStartMs: Number.POSITIVE_INFINITY });
  const claims: Promise<{ error?: Error; afterMs: number }>[] = [];
  for (let second = 0; second < 60; second += 1) {
    const startedAt = harness.clock.now;
    claims.push(harness.module.withOwnedFenceLock(join(tmpdir(), `aiboard-self-birth-never-${second}.sqlite`), () => "effect ran").then(
      () => ({ afterMs: harness.clock.now - startedAt }), (error: Error) => ({ error, afterMs: harness.clock.now - startedAt })));
    await harness.advance(1_000);
  }
  await harness.advance(15_000);
  for (const outcome of await Promise.all(claims)) {
    assert.match(outcome.error?.message ?? "the claim ran", /birth identity is unavailable/);
    assert.equal(outcome.afterMs, 15_000, "every claim fails closed at its own 15 s");
  }
  const [first, second, third] = harness.children;
  assert.equal(first!.killedAt! - T0, 30_000, "the probe is killed at its 30 s cap");
  assert.equal(second!.startedAt - T0, 30_025, "and replaced after the 25 ms retry delay, since claims still wait");
  assert.equal(second!.killedAt! - second!.startedAt, 30_000, "the next one gets the same cap from its own start");
  assert.equal(third!.startedAt - second!.killedAt!, 38, "the retry delay grows by half");
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

// The sync probe (acquire, when the identity is not known yet): one probe gets all of the caller's time.
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

// Review N5: what acquire refuses, it still refuses with its own error, and without starting a probe.
test("invalid bounds and a spent deadline reach acquire's own errors without a probe", async () => {
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

test("the self-birth wait is Windows-only and skipped when the caller names its holder birth", async () => {
  await withLockFolder(async (lockPath) => {
    const windows = loadModule({ coldStartMs: Number.POSITIVE_INFINITY });
    const named = await windows.drive(windows.module.withOwnedFenceLock(lockPath, () => "effect ran", { holderBirth: "named-birth" }));
    assert.ok(named.ok);
    assert.equal(windows.children.length, 0);
    const posix = loadModule({ coldStartMs: Number.POSITIVE_INFINITY, platform: "linux" });
    const prepared = await posix.drive(posix.module.prepareCurrentProcessBirthFingerprint());
    assert.ok(prepared.ok);
    assert.equal(prepared.value, undefined);
    assert.equal(posix.children.length, 0, "no probe starts off Windows");
  });
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
