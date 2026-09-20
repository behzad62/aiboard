import assert from "node:assert/strict";

import { finalizeRealStreamingFixture } from "./real-streaming-fixture-finalizer.js";

export interface CrashChild {
  once(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  removeListener(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
  removeListener(event: "error", listener: (error: Error) => void): unknown;
  kill(signal: "SIGKILL"): boolean;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
}

export type CrashClock = (callback: () => void, milliseconds: number) => () => void;
const realClock: CrashClock = (callback, milliseconds) => {
  const timer = setTimeout(callback, milliseconds);
  return () => clearTimeout(timer);
};

type FixtureOwner = NonNullable<Parameters<typeof finalizeRealStreamingFixture>[0]["owner"]>;

export interface CrashLauncherObservation {
  close: "pending" | "closed";
  code: number | null;
  signal: string | null;
  listenersAttached: boolean;
  readonly failures: unknown[];
  readonly terminal: Promise<void>;
}

/** Keeps late error/close facts reachable after the bounded join expires. */
export class UnclosedCrashLauncherError extends AggregateError {
  constructor(readonly launcher: CrashLauncherObservation) {
    super(launcher.failures, "Crash launcher close is unconfirmed; recovery ownership is unavailable.");
    // AggregateError normally copies its iterable. Retain this exact live ledger.
    this.errors = launcher.failures;
  }
}

async function observeCrashLauncher(spawn: () => CrashChild, clock: CrashClock) {
  let child: CrashChild;
  try {
    child = spawn();
  } catch (error) {
    // No handle was returned. Do not invent a close event or signal a PID.
    return { canRecover: true, code: null, failures: [error] };
  }
  let resolveClose!: () => void;
  let resolveError!: () => void;
  const terminal = new Promise<void>((resolve) => { resolveClose = resolve; });
  const errorEvent = new Promise<void>((resolve) => { resolveError = resolve; });
  const observation: CrashLauncherObservation = {
    close: "pending", code: null, signal: null, listenersAttached: true, failures: [], terminal,
  };
  const onError = (error: Error) => {
    observation.failures.push(error);
    resolveError();
  };
  const onClose = (code: number | null, signal: string | null) => {
    observation.close = "closed";
    observation.code = code;
    observation.signal = signal;
    child.removeListener("error", onError);
    child.removeListener("close", onClose);
    observation.listenersAttached = false;
    resolveClose();
    resolveError(); // Settle the unused event waiter on normal close too.
  };
  child.on("error", onError);
  child.on("close", onClose);
  let cancelLaunch = () => undefined as void;
  const first = await Promise.race([
    terminal.then(() => "closed" as const),
    errorEvent.then(() => "error" as const),
    new Promise<"timeout">((resolve) => {
      cancelLaunch = clock(() => resolve("timeout"), 10_000);
    }),
  ]);
  cancelLaunch();
  if (first === "timeout") {
    observation.failures.unshift(new Error("Crash fixture did not reach the adoption checkpoint."));
    if (observation.close === "pending") {
      try {
        if (!child.kill("SIGKILL")) observation.failures.push(new Error("Owned crash launcher signal was not accepted."));
      } catch (error) {
        observation.failures.push(error);
      }
    }
  }
  if (observation.close === "pending") {
    let cancelJoin = () => undefined as void;
    await Promise.race([
      terminal,
      new Promise<void>((resolve) => { cancelJoin = clock(resolve, 5_000); }),
    ]);
    cancelJoin();
  }
  if (observation.close === "pending") {
    // Listeners and terminal promise remain owned by this observation. Only a
    // later close detaches them; it never starts recovery after this return.
    return { canRecover: false, code: null, failures: [new UnclosedCrashLauncherError(observation)] };
  }
  return { canRecover: true, code: observation.code, failures: observation.failures };
}

function combinedFailure(failures: unknown[]): unknown {
  return failures.length === 1 ? failures[0] : new AggregateError(failures, "Crash fixture failed at multiple lifecycle boundaries.");
}

/** The native fixture and synthetic boundary tests share this entire ordering. */
export async function runRealStreamingCrashFixture<Owner extends FixtureOwner>(input: {
  root: string;
  prepare?: () => Promise<void>;
  spawn: () => CrashChild;
  createOwner: () => Promise<Owner>;
  inspect: (owner: Owner) => Promise<void>;
  clock?: CrashClock;
}): Promise<void> {
  let owner: Owner | undefined;
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  try {
    await input.prepare?.();
    const launcher = await observeCrashLauncher(input.spawn, input.clock ?? realClock);
    const ownerFailures: unknown[] = [];
    if (launcher.canRecover) {
      try { owner = await input.createOwner(); } catch (error) { ownerFailures.push(error); }
    }
    const failures = [...launcher.failures];
    if (failures.length === 0) {
      try { assert.equal(launcher.code, 86, "Crash launcher must reach exit86 after terminal close."); }
      catch (error) { failures.push(error); }
    }
    failures.push(...ownerFailures);
    if (failures.length > 0) throw combinedFailure(failures);
    assert.ok(owner, "Crash fixture recovery owner is unavailable.");
    await input.inspect(owner);
  } catch (error) {
    primaryFailure = error;
    hasPrimaryFailure = true;
  } finally {
    await finalizeRealStreamingFixture({
      fixtureName: "real Runner crash-before-recovery", root: input.root, owner, primaryFailure, hasPrimaryFailure,
    });
  }
}

export async function recoverAndCloseRealStreamingOwner(
  recover: () => Promise<unknown>, close: () => Promise<void>,
): Promise<void> {
  const failures: unknown[] = [];
  try { await recover(); } catch (error) { failures.push(error); }
  try { await close(); } catch (error) { failures.push(error); }
  if (failures.length > 0) throw combinedFailure(failures);
}

export async function verifyCrashReconcileReplay(input: {
  reconcile: () => Promise<{ readonly outcomes: readonly unknown[] }>;
  readLaunch: () => { readonly state: string; readonly history: readonly { readonly state: string }[] } | undefined;
}): Promise<void> {
  const pendingBefore = structuredClone(input.readLaunch()?.history.filter((entry) => entry.state === "cleanup_pending"));
  assert.equal(pendingBefore?.length, 1);
  const replay = await input.reconcile();
  assert.deepEqual(replay.outcomes, []);
  const after = input.readLaunch();
  assert.equal(after?.state, "released");
  assert.deepEqual(after?.history.filter((entry) => entry.state === "cleanup_pending"), pendingBefore);
}
