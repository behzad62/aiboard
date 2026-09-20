import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import test from "node:test";
import { observeWindowsFixtureJob, normalizeFixtureWindowsEnvironment } from "./support/windows-fixture-job.js";

test("fixture environment preserves Windows case-insensitive keys without an invalid duplicate JSON mapping", () => {
  assert.deepEqual(normalizeFixtureWindowsEnvironment({ Path: "fixture", PATH: "fixture", SystemRoot: "windows", missing: undefined }), { PATH: "fixture", SystemRoot: "windows" });
  assert.deepEqual(normalizeFixtureWindowsEnvironment({ PATH: "one", Path: "two" }), { Path: "two" });
});

function fixture() {
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null });
  const commands: string[] = []; child.stdin.on("data", (chunk) => commands.push(String(chunk)));
  const events: unknown[] = [];
  const opening = observeWindowsFixtureJob(child as unknown as ChildProcessWithoutNullStreams, { startupTimeoutMs: 100, closeTimeoutMs: 100, record: (event) => events.push(event) });
  const emit = (type: string, pid = 42, activeProcesses = 0, error: string | null = null) => child.stdout.write(JSON.stringify({ type, pid, exitCode: 0, activeProcesses, error }) + "\n");
  const finish = (code = 0) => { child.exitCode = code; child.stdout.end(); child.stderr.end(); child.emit("close", code, null); };
  return { child, opening, events, commands, emit, finish };
}

test("fixture Job owner joins its exact host close after zero-member proof and does not signal a numeric PID", async () => {
  const f = fixture(); f.emit("started", 42, 1); const owner = await f.opening;
  assert.equal(owner.pid, 42);
  let settled = false; const closing = owner.close().then(() => { settled = true; });
  const joined = owner.close();
  assert.equal(f.commands.length, 1, "concurrent cleanup sends a single owned Job command");
  assert.deepEqual(JSON.parse(f.commands[0]!), { deadlineMs: 100 });
  f.emit("stopped"); await Promise.resolve(); assert.equal(settled, false, "Job proof does not release pipe/native handles before actual host close");
  f.finish(); await closing; await joined; await owner.close();
  assert.equal(f.commands.length, 1);
});

for (const failure of ["no-proof", "nonempty", "wrong-identity", "reported-error", "nonzero-close"] as const) {
  test(`fixture Job owner rejects ${failure} instead of certifying cleanup`, async () => {
    const f = fixture(); f.emit("started", 42, 1); const owner = await f.opening;
    const closing = owner.close();
    if (failure !== "no-proof") f.emit(failure === "reported-error" ? "error" : "stopped", failure === "wrong-identity" ? 43 : 42, failure === "nonempty" ? 1 : 0, failure === "reported-error" ? "job query failed" : null);
    f.finish(failure === "nonzero-close" ? 1 : 0);
    await assert.rejects(closing, /fixture|Job|identity|empty|close|proof/i);
  });
}

test("fixture Job owner accepts natural zero-member exit only with matching identity and joined handles", async () => {
  const f = fixture(); f.emit("started", 42, 1); const owner = await f.opening;
  f.emit("natural_stopped"); f.finish(); await owner.close();
  assert.equal(f.commands.length, 0);
});

test("fixture Job owner rejects malformed and duplicate startup records without granting a capability", async () => {
  const f = fixture(); f.child.stdout.write("not-json\n"); f.finish(1);
  await assert.rejects(f.opening, /fixture|Job|record|startup|close/i);
  const g = fixture(); g.emit("started", 42, 1); const owner = await g.opening;
  g.emit("started", 43, 1); g.emit("stopped"); g.finish(); await assert.rejects(owner.close(), /fixture|Job|identity|startup/i);
});

test("fixture Job owner retains late close after a bounded cleanup wait", async () => {
  const f = fixture(); f.emit("started", 42, 1); const owner = await f.opening;
  await assert.rejects(owner.close(), /deadline|unconfirmed/i);
  assert.equal(f.commands.length, 1);
  f.emit("stopped"); f.finish(); await owner.closed;
  assert.equal(f.events.length > 0, true, "late terminal facts remain observable");
});
