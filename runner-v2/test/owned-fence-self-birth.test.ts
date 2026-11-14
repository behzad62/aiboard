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

import { currentProcessBirthPreparation, prepareCurrentProcessBirthFingerprint } from "../src/owned-fence-lock.mjs";
import { createWindowsJobProcessHost } from "../src/windows-job-process-host.js";
import * as windowsPathLimits from "../src/windows-path-limits.mjs";

const SOURCE = readFileSync(new URL("../src/owned-fence-lock.mjs", import.meta.url), "utf8");
const PRESENT_BIRTH = "PRESENT:2026-10-31T00:43:01.1234567Z\r\n";
const BIRTH = "2026-10-31T00:43:01.123456Z";
const T0 = 1_000_000;

interface FakeTimer { at: number; seq: number; callback: () => void; refed: boolean; cleared: boolean }
interface FakeChild { startedAt: number; killed: boolean; unrefed: Set<string>; done: boolean }

// One module instance: a fake clock and timers, a fake execFile whose powershell.exe starts take `coldStartMs`
// (Infinity: never), honouring its own `timeout` option as node does, and an execFileSync that throws (the sync
// probe would be a cold start too; a test that needs it to run has to say so).
function loadModule(options: { coldStartMs: number | ((call: number) => number); output?: (call: number) => string; platform?: string }) {
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
    const started = Number.isFinite(coldStartMs) ? fakeSetTimeout(() => exit(null, options.output?.(call) ?? PRESENT_BIRTH), coldStartMs) : undefined;
    const kill = () => { child.killed = true; exit(Object.assign(new Error("Command failed: powershell.exe"), { killed: true, signal: "SIGTERM" })); };
    const timedOut = execOptions.timeout ? fakeSetTimeout(kill, execOptions.timeout) : undefined;
    const pipe = (name: string) => ({ unref: () => { child.unrefed.add(name); } });
    return { unref: () => { child.unrefed.add("child"); }, kill, stdin: pipe("stdin"), stdout: pipe("stdout"), stderr: pipe("stderr") };
  };
  const execFileSync = (_file: string, _args: string[], execOptions: { timeout: number }) => {
    syncCalls.push(execOptions.timeout);
    throw Object.assign(new Error("spawnSync powershell.exe ETIMEDOUT"), { code: "ETIMEDOUT" });
  };
  const fakeProcess = {
    pid: process.pid, platform: options.platform ?? "win32",
    once: (event: string, listener: () => void) => { if (event === "exit") exitListeners.add(listener); },
    off: (event: string, listener: () => void) => { if (event === "exit") exitListeners.delete(listener); },
  };
  const context = vm.createContext({
    ...childProcess, execFile, execFileSync, ...crypto, ...fs, ...path, ...sqlite, ...windowsPathLimits,
    process: fakeProcess, Date: { now: () => clock.now }, setTimeout: fakeSetTimeout, clearTimeout: fakeClearTimeout,
  });
  const body = SOURCE
    .replace(/^import \{[^}]*\} from "[^"]+";$/gm, "")
    .replace(/^export (?=(?:async )?function |class |const |let )/gm, "");
  assert.doesNotMatch(body, /^(?:import|export)\b/m, "the whole module loads");
  vm.runInContext(`${body}\nglobalThis.__module = { withOwnedFenceLock, prepareCurrentProcessBirthFingerprint, currentProcessBirthPreparation, parseWindowsBirthProbe };`, context);
  const module = context.__module as {
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
  return { module, clock, children, syncCalls, exitListeners, pending, drive, advance };
}

function withLockFolder<T>(body: (lockPath: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-owned-fence-self-birth-"));
  return body(join(root, "effect.sqlite")).finally(() => rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
}

// Review S1: a 10 s caller used to lose to a 6 s cold start, because the background attempts kept fixed 2/4/8 s
// bounds and each new attempt started cold again. An attempt now lasts while a waiting claim still has time.
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

test("a claim whose deadline passes before the cold start fails closed at that deadline, and the preparation goes on", async () => {
  await withLockFolder(async (lockPath) => {
    const never = loadModule({ coldStartMs: Number.POSITIVE_INFINITY });
    const failed = await never.drive(never.module.withOwnedFenceLock(lockPath, () => "effect ran", { deadlineMs: 10_000 }));
    assert.ok(!failed.ok);
    assert.match(failed.error.message, /Current owned fence holder birth identity is unavailable/);
    assert.equal(failed.at, 10_000, "exactly at the caller's own deadline, never later");
    assert.equal(never.children[0]!.killed, true, "the attempt the claim waited on ended with the claim's deadline");
    assert.deepEqual(never.syncCalls, []);

    // The 2 s default: the first attempt (bound 2 s) ends with the claim, the next one (4 s) starts at once.
    const slow = loadModule({ coldStartMs: 3_000 });
    const first = await slow.drive(slow.module.withOwnedFenceLock(lockPath, () => "effect ran"));
    assert.ok(!first.ok);
    assert.match(first.error.message, /birth identity is unavailable/);
    assert.equal(first.at, 2_000);
    assert.equal(slow.module.currentProcessBirthPreparation(), "preparing", "the failed claim leaves the preparation running");
    await slow.advance(3_100);
    assert.equal(slow.module.currentProcessBirthPreparation(), "known");
    assert.equal(slow.children.length, 2);
    const second = await slow.drive(slow.module.withOwnedFenceLock(lockPath, () => "effect ran"));
    assert.ok(second.ok, "the next claim needs no cold start");
    assert.equal(slow.children.length, 2);
    assert.deepEqual(slow.syncCalls, []);
  });
});

test("with no claim waiting, the background attempts keep their 2, 4, 8 and 16 s bounds and never cache an unknown identity", async () => {
  const harness = loadModule({ coldStartMs: Number.POSITIVE_INFINITY });
  const preparing = harness.drive(harness.module.prepareCurrentProcessBirthFingerprint(), 120_000);
  const result = await preparing;
  assert.ok(result.ok);
  assert.equal(result.value, undefined, "it resolves to undefined, never rejects");
  const durations = harness.children.map((child, index) => (harness.children[index + 1]?.startedAt ?? T0 + result.at) - child.startedAt);
  assert.deepEqual(durations, [2_025, 4_025, 8_025, 16_000], "each bound, then the 25 ms retry delay before the next");
  assert.ok(harness.children.every((child) => child.killed));
  assert.equal(harness.module.currentProcessBirthPreparation(), "idle");

  // Garbled output of a run that exited 0 (review N6) is unknown too: not cached, and the next call probes again.
  const outputs = ["PRESENT:garbage\r\n", PRESENT_BIRTH];
  const garbled = loadModule({ coldStartMs: 100, output: (call) => outputs[call]! });
  const learned = await garbled.drive(garbled.module.prepareCurrentProcessBirthFingerprint());
  assert.ok(learned.ok);
  assert.equal(learned.value, BIRTH);
  assert.equal(garbled.children.length, 2);
});

test("the Windows birth probe output is accepted only in the round-trip format", () => {
  const { module } = loadModule({ coldStartMs: 0 });
  assert.deepEqual({ ...module.parseWindowsBirthProbe("PRESENT:2026-10-31T00:43:01.1234567Z") }, { state: "same", fingerprint: BIRTH });
  assert.deepEqual({ ...module.parseWindowsBirthProbe("PRESENT:2026-10-31T00:43:01Z") }, { state: "same", fingerprint: "2026-10-31T00:43:01Z" });
  assert.deepEqual({ ...module.parseWindowsBirthProbe("ABSENT") }, { state: "absent" });
  for (const garbled of ["PRESENT:garbage", "PRESENT:2026-10-31", "PRESENT:2026-10-31T00:43:01.12345678Z", "PRESENT:2026-10-31T00:43:01.1234567", "PRESENT:2026-10-31 00:43:01Z", "PRESENT: 2026-10-31T00:43:01Z", "present:2026-10-31T00:43:01Z"])
    assert.deepEqual({ ...module.parseWindowsBirthProbe(garbled) }, { state: "unknown" }, garbled);
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
