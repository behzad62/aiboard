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

function steady(stdout: string, totalMs: number, sampledAtMs: number): ManagedOutputEvidence {
  return { ...evidence(stdout, ""), cpu: { totalMs, sampledAt: new Date(sampledAtMs).toISOString(), steady: true } } as ManagedOutputEvidence;
}
async function steadyTracker(start: number) {
  const clock = { now: start };
  const tracker = await createManagedWaitTracker({ until: { idleMs: 1500 }, baseOffsets: { stdout: 0, stderr: 0 }, streams: ["stdout", "stderr"], now: () => clock.now });
  return { clock, tracker };
}

test("a steady sample older than the last output doesn't charge the program's startup to the quiet window", async () => {
  const t0 = 1_000_000;
  const { clock, tracker } = await steadyTracker(t0);
  const prompt = "Proceed? [y/N] ";
  clock.now = t0 + 100; assert.equal(tracker.satisfied(steady(prompt, 100, t0 + 50)), false, "sampled before this output");
  clock.now = t0 + 1_800; assert.equal(tracker.satisfied(steady(prompt, 100, t0 + 50)), false, "no fresh sample: keep waiting, don't call it flat or idle");
  // The next sample carries 200 ms of startup CPU that ran before the prompt appeared.
  clock.now = t0 + 2_000; assert.equal(tracker.satisfied(steady(prompt, 300, t0 + 1_900)), false, "the window starts here");
  clock.now = t0 + 3_400; assert.equal(tracker.satisfied(steady(prompt, 300, t0 + 3_300)), false, "under idleMs of evidence");
  clock.now = t0 + 3_500; assert.equal(tracker.satisfied(steady(prompt, 300, t0 + 3_400)), true);
  assert.deepEqual(tracker.completion(steady(prompt, 300, t0 + 3_400)), { source: "input_wait", confidence: "likely", quietMs: 1_500, cpuDeltaMs: 0 });
  tracker.close();
});

test("steady evidence: a busy program that goes quiet never ends the wait; a quiet one labels by its tail", async () => {
  const t0 = 2_000_000;
  const busy = await steadyTracker(t0);
  let total = 500;
  busy.clock.now = t0 + 10; assert.equal(busy.tracker.satisfied(steady("progress 45% ", total, t0 + 5)), false);
  for (let at = 250; at <= 20_000; at += 250) {
    total += 240;
    busy.clock.now = t0 + at;
    assert.equal(busy.tracker.satisfied(steady("progress 45% ", total, t0 + at - 10)), false, `stopped at ${at} ms`);
  }
  assert.equal(busy.tracker.completion(steady("progress 45% ", total, t0 + 20_000)).source, "timeout");
  busy.tracker.close();

  const done = await steadyTracker(t0);
  done.clock.now = t0 + 10; assert.equal(done.tracker.satisfied(steady("done\n", 500, t0 + 5)), false);
  done.clock.now = t0 + 300; assert.equal(done.tracker.satisfied(steady("done\n", 500, t0 + 290)), false);
  done.clock.now = t0 + 1_800; assert.equal(done.tracker.satisfied(steady("done\n", 500, t0 + 1_790)), true);
  assert.equal(done.tracker.completion(steady("done\n", 500, t0 + 1_790)).source, "idle", "terminated output is never claimed as waiting for input");
  done.tracker.close();
});

for (const [kind, sample] of [
  ["Job accounting", (stdout: string, totalMs: number, atMs: number) => ({ ...evidence(stdout, ""), cpu: { totalMs, sampledAt: new Date(atMs).toISOString() } }) as ManagedOutputEvidence],
  ["steady sampling", steady],
] as const) {
  test(`${kind}: evidence lost mid-wait doesn't read a busy program as idle at its exit`, async () => {
    // Windows replay (A2): usage stops as the supervisor leaves running, just before the session does.
    const t0 = 4_000_000;
    const { clock, tracker } = await steadyTracker(t0);
    const stdout = "progress 45% ";
    let total = 100;
    clock.now = t0 + 10; assert.equal(tracker.satisfied(sample(stdout, total, t0 + 10)), false);
    for (let at = 500; at <= 4_500; at += 500) {
      total += 480;
      clock.now = t0 + at;
      assert.equal(tracker.satisfied(sample(stdout, total, t0 + at)), false, "busy");
    }
    clock.now = t0 + 4_873; assert.equal(tracker.satisfied(evidence(stdout, "")), false, "the first observation without usage is not proof of quiet");
    clock.now = t0 + 5_100; assert.equal(tracker.satisfied(evidence(stdout, "")), false);
    const exited = { ...evidence(`${stdout}\ndone\n`, ""), snapshot: { status: "exited_unknown", exitCode: 0, signal: null } } as unknown as ManagedOutputEvidence;
    clock.now = t0 + 5_300; assert.equal(tracker.satisfied(exited), true);
    assert.deepEqual(tracker.completion(exited), { source: "exited", confidence: "certain" });
    tracker.close();
  });

  test(`${kind}: evidence that stays lost ends the wait with the heuristic label; evidence that returns keeps its window`, async () => {
    const t0 = 5_000_000;
    const lost = await steadyTracker(t0);
    const prompt = "Proceed? [y/N] ";
    lost.clock.now = t0 + 10; assert.equal(lost.tracker.satisfied(sample(prompt, 100, t0 + 10)), false);
    lost.clock.now = t0 + 400; assert.equal(lost.tracker.satisfied(evidence(prompt, "")), false);
    lost.clock.now = t0 + 1_899; assert.equal(lost.tracker.satisfied(evidence(prompt, "")), false, "under idleMs since the loss");
    lost.clock.now = t0 + 1_900; assert.equal(lost.tracker.satisfied(evidence(prompt, "")), true);
    assert.deepEqual(lost.tracker.completion(evidence(prompt, "")), { source: "idle", confidence: "heuristic", quietMs: 1_500 });
    lost.tracker.close();

    const back = await steadyTracker(t0);
    back.clock.now = t0 + 10; assert.equal(back.tracker.satisfied(sample(prompt, 100, t0 + 10)), false);
    back.clock.now = t0 + 400; assert.equal(back.tracker.satisfied(evidence(prompt, "")), false);
    back.clock.now = t0 + 1_800; assert.equal(back.tracker.satisfied(sample(prompt, 1_400, t0 + 1_800)), false, "CPU grew during the gap: busy");
    back.tracker.close();
  });
}

test("lost CPU evidence keeps the heuristic label, never a claim of input_wait", async () => {
  const t0 = 3_000_000;
  const { clock, tracker } = await steadyTracker(t0);
  clock.now = t0 + 10; assert.equal(tracker.satisfied(evidence("Proceed? [y/N] ", "")), false);
  clock.now = t0 + 1_600; assert.equal(tracker.satisfied(evidence("Proceed? [y/N] ", "")), true);
  assert.deepEqual(tracker.completion(evidence("Proceed? [y/N] ", "")), { source: "idle", confidence: "heuristic", quietMs: 1_590 });
  tracker.close();
});
