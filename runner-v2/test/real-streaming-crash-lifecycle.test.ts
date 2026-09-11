import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  recoverAndCloseRealStreamingOwner, runRealStreamingCrashFixture,
  UnclosedCrashLauncherError, type CrashChild, type CrashClock,
  verifyCrashReconcileReplay,
} from "./support/real-streaming-crash-lifecycle.js";

class SyntheticChild extends EventEmitter implements CrashChild {
  exitCode: number | null = null;
  signalCode: string | null = null;
  signalResult = true;
  signalFailure: unknown;
  hasSignalFailure = false;
  constructor(readonly events: string[]) { super(); }
  kill(signal: "SIGKILL") {
    this.events.push(`signal:${signal}`);
    if (this.hasSignalFailure) throw this.signalFailure;
    return this.signalResult;
  }
  finish(code: number | null) {
    this.events.push("close");
    this.exitCode = code;
    this.emit("close", code, null);
  }
}

class SyntheticClock {
  private readonly pending = new Map<number, () => void>();
  readonly schedule: CrashClock = (callback, milliseconds) => {
    assert.equal(this.pending.has(milliseconds), false);
    this.pending.set(milliseconds, callback);
    return () => { this.pending.delete(milliseconds); };
  };
  fire(milliseconds: number) {
    const callback = this.pending.get(milliseconds);
    assert.ok(callback, `expected owned ${milliseconds}ms timer`);
    this.pending.delete(milliseconds);
    callback();
  }
  get size() { return this.pending.size; }
}

type Outcome = { ok: true } | { ok: false; error: unknown };
const settle = (promise: Promise<void>): Promise<Outcome> => promise.then(
  () => ({ ok: true }), (error: unknown) => ({ ok: false, error }),
);
function failure(outcome: Outcome): unknown {
  assert.equal(outcome.ok, false);
  if (outcome.ok) throw new Error("expected fixture failure");
  return outcome.error;
}
function leaves(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(leaves) : [error];
}
// Drain only deterministic promise continuations; no wall-clock sleeps or child process.
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }

async function withRoot(body: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "c5r6-"));
  console.log(JSON.stringify({ c5r6: "acquired", root }));
  try {
    await writeFile(join(root, "evidence.txt"), "exact synthetic evidence", { flag: "wx" });
    await body(root);
  } finally {
    const retained = existsSync(root);
    console.log(JSON.stringify({ c5r6: retained ? "retained-by-fixture" : "removed-by-fixture", root }));
    // This outer synthetic owner acquired this exact root; no process or store exists here.
    if (retained) await rm(root, { recursive: true, force: true });
    assert.equal(existsSync(root), false);
    console.log(JSON.stringify({ c5r6: "disposed", root }));
  }
}

function start(root: string, options: {
  spawnFailure?: { value: unknown };
  ownerFailure?: { value: unknown };
  inspectFailure?: { value: unknown };
  recoveryFailure?: { value: unknown };
  closeFailure?: { value: unknown };
  recoveryGate?: Promise<void>;
  closeGate?: Promise<void>;
} = {}) {
  const events: string[] = [];
  const child = new SyntheticChild(events);
  const clock = new SyntheticClock();
  let settled = false;
  const outcome = settle(runRealStreamingCrashFixture({
    root, clock: clock.schedule,
    spawn: () => {
      events.push("spawn");
      if (options.spawnFailure) throw options.spawnFailure.value;
      return child;
    },
    createOwner: async () => {
      events.push("owner");
      if (options.ownerFailure) throw options.ownerFailure.value;
      return {
        cleanupOutstandingForTest: () => recoverAndCloseRealStreamingOwner(async () => {
          events.push("recover");
          if (options.recoveryGate) await options.recoveryGate;
          if (options.recoveryFailure) throw options.recoveryFailure.value;
        }, async () => {
          events.push("host.close");
          if (options.closeGate) await options.closeGate;
          if (options.closeFailure) throw options.closeFailure.value;
        }),
        kernel: { store: { close: () => { events.push("inspection.close"); } } },
      };
    },
    inspect: async () => {
      events.push("inspect");
      if (options.inspectFailure) throw options.inspectFailure.value;
    },
  })).then((result) => { settled = true; return result; });
  return { events, child, clock, outcome, get settled() { return settled; } };
}

test("C5 synthetic normal86 joins close and disposes successfully cleaned root", async () => withRoot(async (root) => {
  const run = start(root);
  await flush();
  run.child.finish(86);
  assert.deepEqual(await run.outcome, { ok: true });
  assert.deepEqual(run.events, ["spawn", "close", "owner", "inspect", "recover", "host.close", "inspection.close"]);
  assert.equal(run.clock.size, 0);
  assert.equal(run.child.listenerCount("close"), 0);
  assert.equal(run.child.listenerCount("error"), 0);
  assert.equal(existsSync(root), false);
}));

test("C5 synthetic non86 still assigns owner before exit assertion and preserves evidence", async () => withRoot(async (root) => {
  const run = start(root);
  await flush();
  run.child.finish(87);
  const error = failure(await run.outcome);
  assert.ok(error instanceof assert.AssertionError);
  assert.equal(error.actual, 87);
  assert.deepEqual(run.events, ["spawn", "close", "owner", "recover", "host.close", "inspection.close"]);
  assert.equal(await readFile(join(root, "evidence.txt"), "utf8"), "exact synthetic evidence");
}));

test("C5 synthetic timeout holds recovery until joined close and preserves failure", async () => withRoot(async (root) => {
  const run = start(root);
  await flush();
  run.clock.fire(10_000);
  await flush();
  const heldEvents = [...run.events];
  const heldSettled = run.settled;
  run.child.finish(86);
  const error = failure(await run.outcome);
  assert.deepEqual(heldEvents, ["spawn", "signal:SIGKILL"]);
  assert.equal(heldSettled, false);
  assert.ok(error instanceof Error && /adoption checkpoint/.test(error.message));
  assert.deepEqual(run.events, ["spawn", "signal:SIGKILL", "close", "owner", "recover", "host.close", "inspection.close"]);
  assert.equal(run.clock.size, 0);
  assert.equal(existsSync(root), true);
}));

for (const value of [new Error("synthetic spawn throw"), undefined, null, false, 0, ""]) {
  test(`C5 synthetic spawn throw ${String(value)} preserves identity and cleans safe owner`, async () => withRoot(async (root) => {
    const run = start(root, { spawnFailure: { value } });
    assert.equal(failure(await run.outcome), value);
    assert.deepEqual(run.events, ["spawn", "owner", "recover", "host.close", "inspection.close"]);
    assert.equal(run.clock.size, 0);
    assert.equal(existsSync(root), true);
  }));
}

test("C5 synthetic emitted spawn error remains primary after close and owner cleanup", async () => withRoot(async (root) => {
  const run = start(root);
  await flush();
  const original = new Error("synthetic error event");
  // Baseline lacks a listener: avoid asking EventEmitter itself to throw.
  const observed = run.child.listenerCount("error") > 0;
  if (observed) run.child.emit("error", original);
  run.child.finish(null);
  const error = failure(await run.outcome);
  assert.equal(observed, true);
  assert.equal(error, original);
  assert.deepEqual(run.events, ["spawn", "close", "owner", "recover", "host.close", "inspection.close"]);
}));

test("C5 synthetic recovery rejection still closes host and preserves both errors", async () => withRoot(async (root) => {
  const recovery = new Error("synthetic recovery rejection");
  const close = new Error("synthetic close rejection");
  const primary = new Error("synthetic inspection rejection");
  const run = start(root, { inspectFailure: { value: primary }, recoveryFailure: { value: recovery }, closeFailure: { value: close } });
  await flush();
  run.child.finish(86);
  const error = failure(await run.outcome);
  assert.deepEqual(leaves(error), [primary, recovery, close]);
  assert.deepEqual(run.events, ["spawn", "close", "owner", "inspect", "recover", "host.close", "inspection.close"]);
  assert.equal(existsSync(root), true);
}));

for (const boundary of ["recoveryFailure", "closeFailure", "inspectFailure"] as const) {
  for (const value of [new Error("original boundary error"), undefined, null, false, 0, ""]) {
    test(`C5 synthetic ${boundary} ${String(value)} retains original failure and attempts every close`, async () => withRoot(async (root) => {
      const run = start(root, { [boundary]: { value } });
      await flush();
      run.child.finish(86);
      assert.deepEqual(leaves(failure(await run.outcome)), [value]);
      assert.deepEqual(run.events, ["spawn", "close", "owner", "inspect", "recover", "host.close", "inspection.close"]);
      assert.equal(existsSync(root), true);
    }));
  }
}

test("C5 synthetic falsey recovery and close errors both survive finalizer", async () => withRoot(async (root) => {
  const run = start(root, { inspectFailure: { value: false }, recoveryFailure: { value: undefined }, closeFailure: { value: null } });
  await flush();
  run.child.finish(86);
  assert.deepEqual(leaves(failure(await run.outcome)), [false, undefined, null]);
  assert.equal(existsSync(root), true);
}));

for (const code of [86, 87]) {
  test(`C5 synthetic owner construction rejection after exit${code} preserves primary and root`, async () => withRoot(async (root) => {
    const original = new Error("owner construction failed");
    const run = start(root, { ownerFailure: { value: original } });
    await flush();
    run.child.finish(code);
    const errors = leaves(failure(await run.outcome));
    if (code === 87) {
      assert.ok(errors[0] instanceof assert.AssertionError);
      assert.equal(errors[0].actual, 87);
    }
    assert.equal(errors[code === 87 ? 1 : 0], original);
    assert.deepEqual(run.events, ["spawn", "close", "owner"]);
    assert.equal(existsSync(root), true);
  }));
}

test("C5 synthetic falsey owner rejection keeps original spawn failure first", async () => withRoot(async (root) => {
  const original = new Error("original synchronous spawn error");
  const run = start(root, { spawnFailure: { value: original }, ownerFailure: { value: undefined } });
  const errors = leaves(failure(await run.outcome));
  assert.equal(errors[0], original);
  assert.equal(errors[1], undefined);
  assert.deepEqual(run.events, ["spawn", "owner"]);
  assert.equal(existsSync(root), true);
}));

for (const kind of ["false", "throw", "falsey-throw"] as const) {
  test(`C5 synthetic failed signal ${kind} joins close and preserves timeout plus late error`, async () => withRoot(async (root) => {
    const run = start(root);
    const signalError = kind === "falsey-throw" ? undefined : new Error("synthetic signal failed");
    run.child.signalResult = false;
    run.child.hasSignalFailure = kind !== "false";
    run.child.signalFailure = signalError;
    await flush();
    // exitCode alone is not close proof; still join the exact child.
    run.child.exitCode = 86;
    run.clock.fire(10_000);
    await flush();
    const held = [...run.events];
    const late = new Error("synthetic late launcher error");
    run.child.emit("error", late);
    run.child.finish(86);
    const errors = leaves(failure(await run.outcome));
    assert.deepEqual(held, ["spawn", "signal:SIGKILL"]);
    assert.ok(errors[0] instanceof Error && /adoption checkpoint/.test(errors[0].message));
    if (kind === "false") assert.ok(errors[1] instanceof Error && /signal was not accepted/.test(errors[1].message));
    else assert.equal(errors[1], signalError);
    assert.equal(errors[2], late);
    assert.deepEqual(run.events, ["spawn", "signal:SIGKILL", "close", "owner", "recover", "host.close", "inspection.close"]);
    assert.equal(run.clock.size, 0);
  }));
}

function unclosed(error: unknown): UnclosedCrashLauncherError | undefined {
  if (error instanceof UnclosedCrashLauncherError) return error;
  if (error instanceof AggregateError) {
    for (const entry of error.errors) { const found = unclosed(entry); if (found) return found; }
  }
  return undefined;
}

for (const trigger of ["timeout", "error"] as const) {
  test(`C5 synthetic unconfirmed close after ${trigger} refuses recovery and owns late observation`, async () => withRoot(async (root) => {
    const run = start(root);
    await flush();
    const original = new Error("spawn error without close");
    if (trigger === "timeout") run.clock.fire(10_000);
    else run.child.emit("error", original);
    await flush();
    run.clock.fire(5_000);
    let observer: UnclosedCrashLauncherError | undefined;
    try {
      observer = unclosed(failure(await run.outcome));
      assert.ok(observer);
      assert.equal(observer.launcher.close, "pending");
      assert.equal(observer.launcher.listenersAttached, true);
      assert.equal(run.child.listenerCount("error"), 1);
      assert.equal(run.child.listenerCount("close"), 1);
      assert.deepEqual(run.events, trigger === "timeout" ? ["spawn", "signal:SIGKILL"] : ["spawn"]);
      assert.equal(run.clock.size, 0);
      assert.equal(await readFile(join(root, "evidence.txt"), "utf8"), "exact synthetic evidence");
      if (trigger === "error") assert.equal(observer.errors[0], original);
      const late = new Error("late error after fixture already failed");
      run.child.emit("error", late);
      assert.equal(observer.errors.at(-1), late);
      assert.equal(observer.launcher.close, "pending");
    } finally {
      // Controlled external producer finally closes for synthetic teardown only.
      run.child.finish(86);
      if (observer) await observer.launcher.terminal;
    }
    assert.equal(observer.launcher.close, "closed");
    assert.equal(observer.launcher.listenersAttached, false);
    assert.equal(run.child.listenerCount("error"), 0);
    assert.equal(run.child.listenerCount("close"), 0);
    assert.equal(run.events.includes("owner"), false);
    assert.equal(existsSync(root), true);
  }));
}

for (const variant of ["unchanged", "outcome", "duplicate", "rewritten"] as const) {
  test(`C5 synthetic replay ${variant} enforces empty outcomes and unchanged single cleanup history`, async () => {
    const history = [{ state: "cleanup_pending", at: "first" }, { state: "released", at: "second" }];
    const operation = verifyCrashReconcileReplay({
      readLaunch: () => ({ state: "released", history }),
      reconcile: async () => {
        if (variant === "duplicate") history.push({ state: "cleanup_pending", at: "third" });
        if (variant === "rewritten") history[0]!.at = "rewritten";
        return { outcomes: variant === "outcome" ? [{ launchId: "exact-launch", disposition: "cleaned" }] : [] };
      },
    });
    if (variant === "unchanged") await operation;
    else await assert.rejects(operation, assert.AssertionError);
  });
}

test("C5 synthetic held recovery and close settle before finalizer returns", async () => withRoot(async (root) => {
  let resolveRecovery!: () => void;
  let resolveClose!: () => void;
  const recoveryGate = new Promise<void>((resolve) => { resolveRecovery = resolve; });
  const closeGate = new Promise<void>((resolve) => { resolveClose = resolve; });
  const originalRecovery = new Error("held recovery failed");
  const originalClose = new Error("held close failed");
  const run = start(root, {
    recoveryGate, closeGate,
    recoveryFailure: { value: originalRecovery }, closeFailure: { value: originalClose },
  });
  await flush();
  run.child.finish(86);
  await flush();
  const duringRecovery = { events: [...run.events], settled: run.settled, retained: existsSync(root) };
  resolveRecovery();
  await flush();
  const duringClose = { events: [...run.events], settled: run.settled, retained: existsSync(root) };
  resolveClose();
  const errors = leaves(failure(await run.outcome));
  assert.deepEqual(duringRecovery, { events: ["spawn", "close", "owner", "inspect", "recover"], settled: false, retained: true });
  assert.deepEqual(duringClose, { events: ["spawn", "close", "owner", "inspect", "recover", "host.close"], settled: false, retained: true });
  assert.deepEqual(errors, [originalRecovery, originalClose]);
  assert.deepEqual(run.events, ["spawn", "close", "owner", "inspect", "recover", "host.close", "inspection.close"]);
  assert.equal(existsSync(root), true);
}));
