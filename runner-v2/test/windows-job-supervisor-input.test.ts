import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test, { after } from "node:test";
import { checkNoWindowsJobProcessesLeft, retireOwnedTreeForTests } from "./support/windows-job-leftover-guard.js";
import {
  createWindowsJobProcessHost,
  type WindowsJobOwnershipKey,
  type WindowsJobWriterFence,
} from "../src/windows-job-process-host.js";

for (const interactive of [true, false]) test(`Windows Job supervisor retains exact ownership after input-pipe error (interactive=${interactive})`, async () => {
  const url = new URL("../src/managed-process-supervisor.mjs", import.meta.url);
  const source = await readFile(url, "utf8");
  const start = source.indexOf("function launchWindowsJob() {");
  const end = source.indexOf("\nfunction drainInteractiveOutput", start);
  assert.ok(start >= 0 && end > start);
  // Execute the actual launch/event wiring with inert OS handles. A stream's
  // error event is distinct from its write callback and child process exit.
  const input = Object.assign(new EventEmitter(), { write: () => true });
  const backend = Object.assign(new EventEmitter(), { stdin: input, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const status = { jobEmptyProof: false, ownershipReleased: false };
  let startupFailures = 0, settlementChecks = 0;
  const context = { spawn: () => backend, dirname, join, fileURLToPath, Buffer,
    config: { interactive }, backend: undefined, backendInput: undefined, status,
    settled: false, backendFailure: undefined, interactiveStdoutEnded: false, interactiveStderrEnded: false,
    // The host reported its workload started; no Assign-path root is pending.
    reportedStarted: true, spareUnclaimed: false, pendingRoot: null, assignIntent: null, assignEventMalformed: false, pendingRootEnd: undefined,
    persistStatus: () => undefined, endRoot: async () => false, fileTimeNow: () => "1",
    setInterval: () => 0, jobEventTimer: undefined, createInterface: () => new EventEmitter(),
    drainInteractiveOutput: () => undefined, pollInteractiveJobEvents: () => undefined,
    handleJobEvent: () => undefined, appendFileSync: () => undefined,
    startupFailed: () => { startupFailures++; }, tryMarkStopped: () => { settlementChecks++; },
    markOwnershipUncertain: () => undefined };
  runInNewContext(source.slice(start, end).replaceAll("import.meta.url", JSON.stringify(url.href)) + "\nlaunchWindowsJob();", context);
  assert.doesNotThrow(() => input.emit("error", Object.assign(new Error("pending pipe was closed by owned Job termination"), { code: "EPIPE" })),
    "an emitted input-stream error must not crash the supervisor before its retained cleanup can be certified");
  assert.equal(startupFailures, 0, "input failure cannot fabricate a no-launch or terminal result");
  assert.equal(status.jobEmptyProof, false); assert.equal(status.ownershipReleased, false);
  assert.equal(settlementChecks, 0);
  backend.emit("exit", 1);
  assert.equal(status.jobEmptyProof, true, "only the exact Job-host exit attests kill-on-close");
  assert.equal(status.ownershipReleased, false, "output still needs separate terminal settlement");
});

// An Assign-path line that fails validation names no root. If the host then dies before it reported started, with no
// valid root named, its root may still live outside the Job: the stop stays unproven, and nothing is ended by a guess.
// A valid intent is the control: the same exit then hands exactly that intent to the root ender.
for (const [name, line] of [
  ["an intent naming another host pid", { type: "assign_intent", hostPid: 9999, hostCreationTime: "134395532800331088", at: "134395532803809075" }],
  ["an intent with a malformed time", { type: "assign_intent", hostPid: 4321, hostCreationTime: "134395532800331088", at: "soon" }],
  ["a pending identity with no pid", { type: "assign_pending", pid: 0, creationTime: "134395532803809075" }],
  ["a valid intent (control)", { type: "assign_intent", hostPid: 4321, hostCreationTime: "134395532800331088", at: "134395532803809075" }],
] as const) test(`Windows Job supervisor, host exit before its started line after ${name}`, async () => {
  const url = new URL("../src/managed-process-supervisor.mjs", import.meta.url);
  const source = await readFile(url, "utf8");
  const slice = (from: string, to: string) => {
    const start = source.indexOf(from), end = source.indexOf(to, start);
    assert.ok(start >= 0 && end > start, from);
    return source.slice(start, end);
  };
  const malformedStart = source.indexOf("function malformedAssignEvent(line) {");
  const code = [
    slice("function launchWindowsJob() {", "\nfunction drainInteractiveOutput"),
    slice("function handleJobEvent(line) {", "\nfunction markRunning"),
    source.slice(malformedStart, source.indexOf("\n}", malformedStart) + 2),
  ].join("\n").replaceAll("import.meta.url", JSON.stringify(url.href));
  const input = Object.assign(new EventEmitter(), { write: () => true });
  const backend = Object.assign(new EventEmitter(), { pid: 4321, stdin: input, stdout: new EventEmitter(), stderr: new EventEmitter() });
  const status: Record<string, unknown> = { status: "starting", jobEmptyProof: false, ownershipReleased: false };
  const ended: unknown[] = [], diagnostics: string[] = [];
  const context = { spawn: () => backend, dirname, join, fileURLToPath, Buffer, JSON, Number, Promise,
    config: { interactive: true, stderrPath: "stderr.log" }, backend: undefined, backendInput: undefined, status,
    settled: false, backendFailure: undefined, interactiveStdoutEnded: false, interactiveStderrEnded: false,
    reportedStarted: false, spareUnclaimed: false, pendingRoot: null, assignIntent: null, assignEventMalformed: false, pendingRootEnd: undefined,
    persistStatus: () => undefined, endRoot: (root: unknown) => { ended.push(root); return new Promise(() => undefined); }, fileTimeNow: () => "134395532900000000",
    setInterval: () => 0, jobEventTimer: undefined, createInterface: () => new EventEmitter(),
    drainInteractiveOutput: () => undefined, pollInteractiveJobEvents: () => undefined,
    appendFileSync: (_path: string, text: string) => { diagnostics.push(text); },
    startupFailed: () => undefined, tryMarkStopped: () => undefined, markOwnershipUncertain: () => undefined };
  runInNewContext(`${code}\nlaunchWindowsJob();\nhandleJobEvent(${JSON.stringify(JSON.stringify(line))});`, context);
  backend.emit("exit", 1);
  if (name === "a valid intent (control)") {
    // The root comes from the VM's realm: compare its data.
    assert.deepEqual(JSON.parse(JSON.stringify(ended)), [{ hostPid: 4321, hostCreationTime: "134395532800331088", at: "134395532803809075", hostExitedAt: "134395532900000000" }]);
    assert.equal(status.jobEmptyProof, false, "the empty proof waits for the ender");
    return;
  }
  assert.equal(context.assignEventMalformed, true);
  assert.match(diagnostics.join(""), /Malformed Assign-path event from the Job host/);
  assert.deepEqual(ended, [], "no root is ended by a guess");
  assert.equal(status.status, "exited_unknown", JSON.stringify(status));
  assert.equal(status.jobEmptyProof, false, `the stop is unproven: ${JSON.stringify(status)}`);
  assert.match(String(status.error), /could not be named/);
});

// PX-2e repair cycle 1 (B1, N1): this file drives the supervisor source in-VM
// and starts no real supervisor of its own, so its end-check scope is a
// per-run unique marker rooted at a temp dir this run owns. The random id
// keeps a concurrent or earlier run of this file (same prefix family, no
// shared marker) out of scope, and the helper rejects the old empty-marker
// worktree-wide match outright.
const OWN_MARKER = `aiboard-px2e-sivin-${randomUUID().slice(0, 8)}-`;
const ownRoot = mkdtempSync(join(tmpdir(), OWN_MARKER));

function allowedEnv(): Record<string, string> {
  const keep = new Set(["systemroot", "windir", "comspec", "path", "pathext", "temp", "tmp"]);
  return Object.fromEntries(
    Object.entries(process.env).filter(([key, value]) => value !== undefined && keep.has(key.toLowerCase())),
  ) as Record<string, string>;
}

// PX-2e repair cycle 1 (B1) negative control: a live supervisor started
// OUTSIDE this file's markers must be neither reported nor killed by this
// file's end check. It runs first so the supervisor is alive when the check
// runs; the check must pass and the supervisor must still answer afterwards.
test("PX-2e B1 negative control: supervisor outside this file's markers stays alive", { timeout: 55_000 }, async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows Job supervisor negative control requires a Windows host.");
    return;
  }
  const outsideRoot = mkdtempSync(join(tmpdir(), "aiboard-px2e-outside-"));
  t.after(() => rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }));
  assert.ok(!outsideRoot.toLowerCase().includes(OWN_MARKER.toLowerCase()), "control supervisor must live outside this file's markers");
  const stateDirectory = join(outsideRoot, "job-host");
  const service = createWindowsJobProcessHost({ stateDirectory });
  const owner: WindowsJobOwnershipKey = { runId: "px2e-outside", sessionId: "px2e-outside" };
  const fence: WindowsJobWriterFence = { ownerId: "px2e-outside", fencingToken: 1 };
  const launched = await service.launchOwned({
    ...owner,
    command: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000);"],
    workingDirectory: outsideRoot,
    environment: allowedEnv(),
    interactive: false,
    fence: { ...fence },
  });
  try {
    const record = JSON.parse(await readFile(join(stateDirectory, `${launched.processId}.json`), "utf8")) as {
      supervisor: { supervisorPid: number };
    };
    assert.ok(Number.isSafeInteger(record.supervisor.supervisorPid) && record.supervisor.supervisorPid > 0);
    // The file's own end check, while the foreign-prefix supervisor is alive.
    await checkNoWindowsJobProcessesLeft([OWN_MARKER]);
    let alive = true;
    try {
      process.kill(record.supervisor.supervisorPid, 0);
    } catch {
      alive = false;
    }
    assert.equal(alive, true, "supervisor started outside this file's markers must stay alive; the guard must not report or kill it");
  } finally {
    await retireOwnedTreeForTests(service, {
      processId: launched.processId,
      owner,
      fence: { ...fence },
      startedAt: launched.startedAt,
    });
  }
});

// PX-2e: this file drives the supervisor source in-VM and must never leave a
// real supervisor or Job host behind. The per-run marker above scopes the
// check to this run alone; leftovers are recorded, killed, and reported here.
after(async () => {
  try {
    await checkNoWindowsJobProcessesLeft([OWN_MARKER]);
  } finally {
    rmSync(ownRoot, { recursive: true, force: true });
  }
});
