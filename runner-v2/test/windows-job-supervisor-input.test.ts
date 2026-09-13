import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";

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
