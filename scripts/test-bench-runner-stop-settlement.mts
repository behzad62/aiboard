import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

// Evaluate the actual private implementation without starting the HTTP server or any process.
const path = fileURLToPath(new URL("./bench-runner.mjs", import.meta.url));
const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "terminateChild")!;
assert.ok(declaration);
const tracker = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "trackBenchChild")!;
assert.ok(tracker);
function functionText(name: string): string {
  const node = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, name); return node.getText(source);
}

function fixture(platform = "win32", spawnFailure?: Error, groupFailure?: Error) {
  const killer = new EventEmitter();
  let now = 0;
  let deadline: (() => void) | undefined;
  let timerCleared = false;
  let controlCalls = 0;
  const signals: string[] = [];
  const reachedVerifier = new Error("verifier admitted after exact settlement");
  const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null as number | null, signalCode: null as string | null,
    killed: false, kill: (signal: string) => { signals.push(signal); child.killed = true; return true; } });
  const evaluated = runInNewContext(`(() => {
    const closedBenchChildren = new WeakSet();
    const benchChildStops = new WeakMap();
    const managedAttemptRunners = new Map([["owned", { child, attemptId: "owned" }]]);
    ${tracker.getText(source)}
    ${functionText("hasSettledBenchChild")}
    ${functionText("stopAttemptRunner")}
    ${functionText("runVerifierExclusive")}
    ${declaration.getText(source)}
    return { stop: terminateChild, trackBenchChild, stopAttemptRunner,
      verify: () => runVerifierExclusive("workspace", { attemptId: "owned" }, {}),
      operation: () => benchChildStops.get(child) };
  })()`, {
    child,
    HttpError: class extends Error { constructor(readonly status: number, message: string) { super(message); } },
    validateAttemptId: (id: string) => id,
    requiredString: (body: { attemptId: string }) => body.attemptId,
    managedRunnerResult: (_managed: unknown, running: boolean) => ({ running }),
    optionalString: () => { throw reachedVerifier; },
    process: { platform, kill: (pid: number, signal: string) => {
      assert.equal(pid, -123); signals.push(signal); if (groupFailure) throw groupFailure;
    } },
    Date: { now: () => now },
    spawn: (command: string, args: string[]) => {
      controlCalls += 1;
      assert.equal(command, "taskkill.exe");
      assert.deepEqual(Array.from(args), ["/pid", "123", "/t", "/f"]);
      if (spawnFailure) throw spawnFailure;
      return killer;
    },
    setTimeout: (callback: () => void, milliseconds: number) => {
      assert.equal(milliseconds, 5_000); deadline = callback; return { unref() {} };
    },
    clearTimeout: () => { timerCleared = true; },
  }) as { stop: (target: typeof child, group?: boolean) => Promise<void>; trackBenchChild: (target: typeof child) => typeof child;
    stopAttemptRunner: (body: { attemptId: string }) => Promise<{ running: boolean }>; verify: () => Promise<void>;
    operation: () => { control?: EventEmitter; status: string; failure?: unknown } };
  assert.equal(evaluated.trackBenchChild(child), child, "creator tracking preserves the exact child object");
  return { killer, child, stop: evaluated.stop, api: () => evaluated.stopAttemptRunner({ attemptId: "owned" }),
    verify: evaluated.verify, operation: evaluated.operation, reachedVerifier, signals, controlCalls: () => controlCalls,
    isTimerCleared: () => timerCleared, setClock: (value: number) => { now = value; },
    expire() { assert.ok(deadline); now = 5_000; deadline(); }, closeTarget() {
    child.exitCode = 1; child.emit("exit", 1, null); child.emit("close", 1, null);
  } };
}

test("bench stop waits for the actual target after the control process completes", async () => {
  const f = fixture();
  const pending = f.stop(f.child);
  let settled = false;
  void pending.then(() => { settled = true; }, () => { settled = true; });
  f.killer.emit("exit", 0, null); f.killer.emit("close", 0, null);
  await new Promise<void>((resolve) => setImmediate(resolve));
  try { assert.equal(settled, false, "control exit cannot certify target exit or stdio closure"); }
  finally { f.closeTarget(); await pending; }
});

test("bench stop refuses a failed control launch while its target remains live", async () => {
  const f = fixture();
  const original = new Error("sentinel control launch failure");
  const pending = f.stop(f.child);
  f.killer.emit("error", original);
  try { await assert.rejects(pending, (error) => error === original); }
  finally { f.closeTarget(); }
});

test("bench stop refuses a nonzero control result while its target remains live", async () => {
  const f = fixture();
  const pending = f.stop(f.child);
  f.killer.emit("exit", 5, null); f.killer.emit("close", 5, null);
  try { await assert.rejects(pending, /control|taskkill|termination/i); }
  finally { f.closeTarget(); }
});

test("bench stop waits for target stdio after its root exit", async () => {
  const f = fixture(); const pending = f.stop(f.child);
  let settled = false; void pending.then(() => { settled = true; });
  f.killer.emit("close", 0); f.child.exitCode = 1; f.child.emit("exit", 1);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  f.child.emit("close", 1); await pending;
  assert.equal(f.child.listenerCount("close"), 0);
  assert.equal(f.killer.listenerCount("close"), 0);
  assert.equal(f.killer.listenerCount("error"), 0);
  assert.equal(f.isTimerCleared(), true);
});

test("bench stop joins the control process after its target closes", async () => {
  const f = fixture(); const pending = f.stop(f.child);
  let settled = false; void pending.then(() => { settled = true; });
  f.closeTarget(); f.killer.emit("exit", 0);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  f.killer.emit("close", 0); await pending;
});

test("bench stop preserves a synchronous control-spawn failure", async () => {
  const original = new Error("sentinel spawn refusal"); const f = fixture("win32", original);
  await assert.rejects(f.stop(f.child), (error) => error === original);
  assert.equal(f.child.exitCode, null);
  assert.equal(f.child.listenerCount("close"), 1, "creator keeps terminal observation after failed control");
  assert.equal(f.isTimerCleared(), true);
});

test("bench stop returns idempotently for a creator-observed closed target", async () => {
  const f = fixture(); f.closeTarget(); await f.stop(f.child);
  assert.equal(f.controlCalls(), 0); assert.equal(f.signals.length, 0);
});

test("bench stop deadline refuses a live Windows target and preserves its owner", async () => {
  const f = fixture(); const pending = f.stop(f.child); f.killer.emit("close", 0); f.expire();
  await assert.rejects(pending, /5000ms stop budget/);
  assert.equal(f.child.exitCode, null); assert.equal(f.child.listenerCount("close"), 1);
  f.closeTarget(); await assert.rejects(f.stop(f.child), /5000ms stop budget/);
  assert.equal(f.controlCalls(), 1, "later actual settlement does not repeat destructive control");
});

test("bench stop rejects late closure even when the event loop has not delivered the timer", async () => {
  const f = fixture(); const pending = f.stop(f.child); f.killer.emit("close", 0);
  f.setClock(5_001); f.closeTarget(); await assert.rejects(pending, /exceeded.*5000ms/);
});

test("bench POSIX stop does not treat a kill request or root exit as stdio settlement", async () => {
  const f = fixture("linux"); f.child.killed = true;
  const pending = f.stop(f.child); let settled = false; void pending.then(() => { settled = true; });
  assert.deepEqual(f.signals, ["SIGTERM"]);
  f.child.exitCode = 0; f.child.emit("exit", 0);
  await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(settled, false);
  f.child.emit("close", 0); await pending;
});

test("bench POSIX force deadline cannot report successful settlement", async () => {
  const f = fixture("linux"); const pending = f.stop(f.child); f.expire();
  await assert.rejects(pending, /5000ms stop budget/);
  assert.deepEqual(f.signals, ["SIGTERM", "SIGKILL"]); assert.equal(f.child.exitCode, null);
});

test("bench group ESRCH still waits for the original target close", async () => {
  const f = fixture("linux", undefined, Object.assign(new Error("gone"), { code: "ESRCH" }));
  const pending = f.stop(f.child, true); let settled = false; void pending.then(() => { settled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(settled, false);
  f.closeTarget(); await pending; assert.deepEqual(f.signals, ["SIGKILL"]);
});

test("bench group control refuses an actual non-ESRCH error", async () => {
  const original = Object.assign(new Error("denied"), { code: "EPERM" }); const f = fixture("linux", undefined, original);
  await assert.rejects(f.stop(f.child, true), (error) => error === original);
  assert.equal(f.child.exitCode, null);
});

test("bench duplicate stop joins one exact control operation", async () => {
  const f = fixture(); const first = f.stop(f.child); const second = f.stop(f.child);
  try { assert.equal(first, second); assert.equal(f.controlCalls(), 1); }
  finally { f.closeTarget(); f.killer.emit("close", 0); await Promise.all([first, second]); }
});

test("bench closed target cannot erase a failed stop while control remains unsettled", async () => {
  const f = fixture(); const first = f.stop(f.child); f.closeTarget(); f.expire();
  await assert.rejects(first, /5000ms stop budget/);
  const second = f.stop(f.child);
  await assert.rejects(second, /5000ms stop budget/);
  assert.equal(f.controlCalls(), 1);
  f.killer.emit("close", 0);
  await assert.rejects(f.stop(f.child), /5000ms stop budget/, "late facts cannot erase the failed bound");
});

test("bench nonzero tree-control result remains failure after target close", async () => {
  const f = fixture(); const first = f.stop(f.child); f.closeTarget(); f.killer.emit("close", 5);
  await assert.rejects(first, /control|taskkill|termination/i);
  await assert.rejects(f.stop(f.child), /control|taskkill|termination/i);
});

test("bench signal-exited root waits for close without a new numeric control request", async () => {
  const f = fixture(); f.child.signalCode = "SIGTERM";
  const first = f.stop(f.child);
  try { assert.equal(f.controlCalls(), 0); }
  finally { f.child.emit("close", null, "SIGTERM"); f.killer.emit("close", 0); await first; }
});

test("bench stop API cannot publish running=false before target and control close", async () => {
  const f = fixture(); const pending = f.api(); let settled = false;
  void pending.then(() => { settled = true; });
  f.killer.emit("close", 0); f.child.exitCode = 1; f.child.emit("exit", 1);
  await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(settled, false);
  f.child.emit("close", 1); assert.deepEqual(await pending, { running: false });
});

test("bench verifier blocks failed control and retains its exact original handle", async () => {
  const f = fixture(); const stopped = f.api(); f.closeTarget(); f.killer.emit("close", 9);
  await assert.rejects(stopped, /control.*failed/);
  assert.equal(f.operation().control, f.killer); assert.equal(f.operation().status, "failed");
  await assert.rejects(f.verify(), /must stop before verifier/);
});

test("bench verifier blocks a root exit until its original stdio is closed", async () => {
  const f = fixture(); f.child.exitCode = 0; f.child.emit("exit", 0);
  await assert.rejects(f.verify(), /must stop before verifier/);
  f.child.emit("close", 0);
  await assert.rejects(f.verify(), (error) => error === f.reachedVerifier);
});

test("bench verifier accepts exact closed signal termination without pretending exitCode is numeric", async () => {
  const f = fixture(); f.child.signalCode = "SIGTERM"; f.child.emit("exit", null, "SIGTERM");
  await assert.rejects(f.verify(), /must stop before verifier/);
  f.child.emit("close", null, "SIGTERM");
  await assert.rejects(f.verify(), (error) => error === f.reachedVerifier);
  assert.equal(f.controlCalls(), 0);
});

for (const phase of ["startup", "health"] as const) {
  test(`bench ${phase} failure retains its original child and both cleanup errors before state reuse`, async () => {
    const bodyError = new Error(`${phase} sentinel`); const cleanupError = new Error("cleanup sentinel");
    const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
    const managed = new Map<string, { child: typeof child; starting: boolean }>();
    const stops = new WeakMap(); let removals = 0;
    const start = runInNewContext(`(() => { ${functionText("startAttemptRunner")}; return startAttemptRunner; })()`, {
      validateAttemptId: (id: string) => id, requiredString: (body: { attemptId: string }) => body.attemptId,
      attemptWorkspacePath: () => "workspace", readMeta: async () => ({}), runnerV2Launcher: { directory: "launcher" },
      runnerSourceDigest: async () => "a".repeat(64), process: { platform: "win32" },
      managedAttemptRunners: managed, benchChildStops: stops, hasSettledBenchChild: () => false,
      runnerStatePath: () => "state", rm: async () => { removals += 1; }, mkdir: async () => undefined,
      randomBytes: () => ({ toString: () => "opaque-test-token" }), runnerV2Invocation: () => ({ command: "fixture", args: [] }),
      spawn: () => child, trackBenchChild: (target: typeof child) => target,
      waitForRunnerV2Startup: async () => { assert.equal(managed.get("owned")?.child, child);
        if (phase === "startup") throw bodyError; return { url: "fixture" }; },
      readManagedRunnerHealth: async () => { throw bodyError; },
      terminateChild: async (target: typeof child) => { assert.equal(target, child); stops.set(child, { status: "failed" }); throw cleanupError; },
      HttpError: class extends Error { constructor(readonly status: number, message: string) { super(message); } },
    }) as (body: { attemptId: string }) => Promise<void>;
    await assert.rejects(start({ attemptId: "owned" }), (error: unknown) => {
      const combined = error as { errors: unknown[] };
      assert.equal(combined.errors[0], bodyError); assert.equal(combined.errors[1], cleanupError); return true;
    });
    assert.equal(managed.get("owned")?.child, child); assert.equal(managed.get("owned")?.starting, false);
    await assert.rejects(start({ attemptId: "owned" }), /startup or termination remains unsettled/);
    assert.equal(removals, 1, "a retry cannot remove state belonging to the unresolved child");
  });
}

test("bench command stop rejection finalizes its timer and abort subscription once", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter() });
  const original = new Error("actual stop refusal"); let timer: (() => void) | undefined;
  let cleared = 0; const abortListeners = new Set<() => void>();
  const signal = { aborted: false, addEventListener: (_name: string, callback: () => void) => abortListeners.add(callback),
    removeEventListener: (_name: string, callback: () => void) => abortListeners.delete(callback) };
  const run = runInNewContext(`(${functionText("runCommand")})`, {
    process: { platform: "win32" }, spawn: () => child, trackBenchChild: (target: typeof child) => target,
    terminateChild: async (target: typeof child) => { assert.equal(target, child); throw original; },
    setTimeout: (callback: () => void) => { timer = callback; return {}; }, clearTimeout: () => { cleared += 1; },
    MAX_OUTPUT_BYTES: 1024, Buffer,
  }) as (command: string, cwd: string, seconds: number, environment: undefined, abortSignal: typeof signal) => Promise<void>;
  const pending = run("fixture", "workspace", 30, undefined, signal); assert.equal(abortListeners.size, 1);
  assert.ok(timer); timer(); await assert.rejects(pending, (error) => error === original);
  assert.equal(abortListeners.size, 0); assert.equal(cleared, 1);
  child.emit("close", 0); assert.equal(cleared, 1, "late child close cannot complete a rejected command twice");
});

test("bench shutdown joins every initiated stop before reporting the original failures", async () => {
  const signalLoop = source.statements.find((node) => ts.isForOfStatement(node) && node.getText(source).includes('process.once(signal'));
  assert.ok(signalLoop);
  const callbacks = new Map<string, () => void>(); let closes = 0; let captured: { errors: unknown[] } | undefined;
  let rejectFirst!: (error: unknown) => void; let finishSecond!: () => void;
  const first = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
  const second = new Promise<void>((resolve) => { finishSecond = resolve; });
  const a = {}; const b = {}; const original = new Error("first stop failed");
  const processState = { exitCode: 0, once: (name: string, callback: () => void) => callbacks.set(name, callback) };
  runInNewContext(`let shuttingDown = false; ${signalLoop.getText(source)}`, {
    process: processState, managedAttemptRunners: new Map([["a", { child: a }], ["b", { child: b }]]),
    terminateChild: (target: object) => target === a ? first : second,
    server: { close: (callback: () => void) => { closes += 1; callback(); } },
    console: { error: (_message: string, error: { errors: unknown[] }) => { captured = error; } },
  });
  callbacks.get("SIGTERM")!(); rejectFirst(original);
  await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(closes, 0);
  finishSecond(); await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(closes, 1); assert.equal(processState.exitCode, 1); assert.equal(captured?.errors[0], original);
});

test("bench oracle restoration waits for healthy startup despite early ownership registration", async () => {
  let restorations = 0;
  const managed = { starting: true, child: { exitCode: null, signalCode: null }, exited: false };
  const route = runInNewContext(`(${functionText("route")})`, {
    parseCompatRoute: () => null, managedAttemptRunners: new Map([["owned", managed]]),
    withAttempt: (_body: unknown, action: (input: unknown) => unknown) => action({ attemptRoot: "workspace",
      meta: { attemptId: "owned", trustedPolicy: { kind: "recoverable-job-service" } } }),
    inspectAndRestoreRjsOracle: async () => { restorations += 1; },
    HttpError: class extends Error { constructor(readonly status: number, message: string) { super(message); } },
  }) as (path: string, body: unknown) => Promise<{ restored: boolean }>;
  await assert.rejects(route("/bench/attempt-runner/restore-oracle", {}), /must be running/);
  assert.equal(restorations, 0);
  managed.starting = false;
  assert.equal((await route("/bench/attempt-runner/restore-oracle", {})).restored, true);
  assert.equal(restorations, 1, "healthy startup still permits the original restoration");
});

for (const terminal of ["exitCode", "signalCode", "exited"] as const) {
  test(`bench existing-start cannot advertise terminal ${terminal} before stdio settlement`, async () => {
    const managed = { child: { exitCode: null as number | null, signalCode: null as string | null }, exited: false, starting: false };
    if (terminal === "exitCode") managed.child.exitCode = 0;
    if (terminal === "signalCode") managed.child.signalCode = "SIGTERM";
    if (terminal === "exited") managed.exited = true;
    const start = runInNewContext(`(${functionText("startAttemptRunner")})`, {
      validateAttemptId: (id: string) => id, requiredString: () => "owned", attemptWorkspacePath: () => "workspace",
      readMeta: async () => ({}), runnerV2Launcher: {}, managedAttemptRunners: new Map([["owned", managed]]),
      hasSettledBenchChild: () => false, benchChildStops: new WeakMap(),
      managedRunnerResult: (_managed: unknown, running: boolean) => ({ running }),
      HttpError: class extends Error { constructor(readonly status: number, message: string) { super(message); } },
    }) as (body: unknown) => Promise<{ running: boolean }>;
    await assert.rejects(start({}), /remains unsettled/);
    managed.child.exitCode = null; managed.child.signalCode = null; managed.exited = false;
    assert.equal((await start({})).running, true, "a healthy existing child remains reusable");
  });
}
