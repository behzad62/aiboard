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
