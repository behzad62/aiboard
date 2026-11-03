import assert from "node:assert/strict";
import test from "node:test";
import type { ManagedOutputEvidence } from "../src/managed-process-contracts.js";
import { createManagedWaitTracker } from "../src/managed-process-wait-tracker.js";

function evidence(stdout: string, stderr: string, status = "running"): ManagedOutputEvidence {
  const stream = (name: "stdout" | "stderr", text: string) => {
    const tail = new Uint8Array(Buffer.from(text, "utf8"));
    return { stream: name, totalBytes: tail.byteLength, tail, lossyBytes: 0, lossReasons: [] };
  };
  return { snapshot: { status }, source: "live", streams: [stream("stdout", stdout), stream("stderr", stderr)] } as unknown as ManagedOutputEvidence;
}

test("a REPL prompt on stderr is found even when the stdout result spools after it", async () => {
  // Linux replay (A6): python -i wrote "2\n" to stdout before ">>> " to stderr, but the spool saw stderr first.
  let now = 0;
  const tracker = await createManagedWaitTracker({ until: { idleMs: 1500 }, baseOffsets: { stdout: 0, stderr: 0 }, streams: ["stdout", "stderr"], now: () => now });
  assert.equal(tracker.satisfied(evidence("", ">>> ")), false);
  now = 10; assert.equal(tracker.satisfied(evidence("2\n", ">>> ")), false);
  now = 800; assert.equal(tracker.satisfied(evidence("2\n", ">>> ")), true, "half the window without CPU evidence and a known prompt");
  assert.deepEqual(tracker.completion(evidence("2\n", ">>> ")), { source: "known_prompt", confidence: "heuristic", quietMs: 790, matched: ">>> " });
  tracker.close();
});

test("terminated output on every stream with new bytes stays idle, not a prompt", async () => {
  let now = 0;
  const tracker = await createManagedWaitTracker({ until: { idleMs: 1500 }, baseOffsets: { stdout: 0, stderr: 0 }, streams: ["stdout", "stderr"], now: () => now });
  assert.equal(tracker.satisfied(evidence("", "warning\n")), false);
  now = 10; assert.equal(tracker.satisfied(evidence("done\n", "warning\n")), false);
  now = 1600; assert.equal(tracker.satisfied(evidence("done\n", "warning\n")), true);
  assert.equal(tracker.completion(evidence("done\n", "warning\n")).source, "idle");
  tracker.close();
});

test("flat CPU counts as evidence only once the quiet window spans the accounting cadence", async () => {
  // Review finding: with idleMs below the Job host's 500 ms accounting poll, a busy process whose
  // newest sample predates the window looked flat and was labeled input_wait.
  let now = 0;
  const withCpu = (stdout: string, totalMs: number) => ({ ...evidence(stdout, ""), cpu: { totalMs, sampledAt: new Date(0).toISOString() } }) as ManagedOutputEvidence;
  const tracker = await createManagedWaitTracker({ until: { idleMs: 250 }, baseOffsets: { stdout: 0, stderr: 0 }, streams: ["stdout", "stderr"], now: () => now });
  assert.equal(tracker.satisfied(withCpu("progress 45% ", 100)), false);
  now = 300; assert.equal(tracker.satisfied(withCpu("progress 45% ", 100)), false, "no sample newer than the window start can exist yet");
  now = 600; assert.equal(tracker.satisfied(withCpu("progress 45% ", 400)), false, "busy");
  tracker.close();
  const quiet = await createManagedWaitTracker({ until: { idleMs: 250 }, baseOffsets: { stdout: 0, stderr: 0 }, streams: ["stdout", "stderr"], now: () => now });
  now = 0; assert.equal(quiet.satisfied(withCpu("Proceed? [y/N] ", 100)), false);
  now = 1_100; assert.equal(quiet.satisfied(withCpu("Proceed? [y/N] ", 100)), true);
  assert.deepEqual([quiet.completion(withCpu("Proceed? [y/N] ", 100)).source, quiet.completion(withCpu("Proceed? [y/N] ", 100)).confidence], ["input_wait", "likely"]);
  quiet.close();
});
