import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createWindowsJobProcessChannelProvider, WINDOWS_JOB_DRAIN_REATTEST_MAX_MS, type WindowsJobChannelAuthority } from "../src/windows-job-process-channel.js";
import type { BackpressuredOutputSettlement } from "../src/interactive-process-channel.js";
import type { ProcessBackendBinding } from "../src/process-backend.js";

test("C2 round6 Job terminal barrier drains the unpolled final frame", async () => {
  const f = await fixture();
  try {
    const delivered: Buffer[] = [];
    f.channel.subscribeBackpressuredOutput(async (metadata, bytes) => { delivered.push(Buffer.from(bytes)); return metadata; });
    await new Promise((resolve) => setImmediate(resolve));
    f.state.bytes = Buffer.from("last-frame"); f.state.pipesEnded = true;
    const result = await settle(f.channel, f.state.now + 100);
    assert.equal(Buffer.concat(delivered).toString(), "last-frame", "terminal barrier must drain bytes without waiting for the normal poll timer");
    assert.deepEqual(result, { status: "settled" }); assert.equal(f.state.acknowledged, 10);
  } finally { await f.channel.detach(); }
});

for (const boundary of ["read", "sink", "control", "ack"] as const) for (const outcome of ["success", "deadline", "stale"] as const) {
  test(`C2 round6 Job held ${boundary} preserves terminal authority ${outcome}`, async () => {
    const f = await fixture(); let resume!: () => void; let entered = false; let deliveries = 0;
    const hold = new Promise<void>((resolve) => { resume = resolve; });
    try {
      f.channel.subscribeBackpressuredOutput(async (metadata) => { deliveries++; if (boundary === "sink") { entered = true; await hold; } return metadata; });
      await new Promise((resolve) => setImmediate(resolve));
      const pause = async () => { entered = true; await hold; };
      if (boundary === "read") f.state.beforeRead = pause;
      if (boundary === "control") f.state.beforeControl = pause;
      if (boundary === "ack") f.state.beforeAck = pause;
      f.state.bytes = Buffer.from("last-frame"); f.state.pipesEnded = true;
      const original = f.channel.settleBackpressuredOutput(1100);
      const duplicate = f.channel.settleBackpressuredOutput(9000);
      assert.equal(original, duplicate, "duplicate callers join the original promise and deadline");
      let complete = false; void original.then(() => { complete = true; });
      for (let turn = 0; turn < 20 && !entered; turn++) await new Promise((resolve) => setImmediate(resolve));
      assert.equal(entered, true); assert.equal(complete, false); assert.equal(f.state.acks, 0);
      if (outcome === "deadline") f.state.now = 1100;
      if (outcome === "stale") f.state.stale = true;
      resume(); const result = await original;
      assert.equal(result.status, outcome === "success" ? "settled" : "blocked");
      if (outcome === "deadline") assert.deepEqual(result, { status: "blocked", reason: "deadline" });
      assert.equal(f.state.acks, outcome === "success" || (boundary === "ack" && outcome === "deadline") ? 1 : 0,
        "unissued ACKs stop at the bound; an already issued ACK remains an unknown effect");
      assert.equal(deliveries, boundary === "read" && outcome !== "success" ? 0 : 1, "late read results cannot start a new sink effect");
      assert.equal(f.channel.settleBackpressuredOutput(9000), original);
    } finally { resume(); await f.channel.detach(); }
  });
}

test("C2 round6 Job empty process waits for pipe-end and refuses missing reader", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.channel.settleBackpressuredOutput(1100)).status, "blocked");
    f.channel.subscribeBackpressuredOutput(async (metadata) => metadata);
    const terminal = f.channel.settleBackpressuredOutput(1100);
    let complete = false; void terminal.then(() => { complete = true; });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(complete, false, "an empty read before pipe EOF cannot certify terminal output");
    f.state.pipesEnded = true;
    assert.deepEqual(await terminal, { status: "settled" });
  } finally { await f.channel.detach(); }
});

test("C2 round6 Job deadline returns while an issued ACK remains held", async () => {
  const f = await fixture(); let resume!: () => void; let entered = false;
  const hold = new Promise<void>((resolve) => { resume = resolve; });
  try {
    f.channel.subscribeBackpressuredOutput(async (metadata) => metadata);
    await new Promise((resolve) => setImmediate(resolve));
    f.state.beforeAck = async () => { entered = true; await hold; };
    f.state.bytes = Buffer.from("last-frame"); f.state.pipesEnded = true;
    const terminal = f.channel.settleBackpressuredOutput(1020);
    for (let turn = 0; turn < 20 && !entered; turn++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(entered, true);
    const observed = await Promise.race([terminal, new Promise<string>((resolve) => setTimeout(() => resolve("still-held"), 100))]);
    assert.deepEqual(observed, { status: "blocked", reason: "deadline" }, "the deadline observes the retained operation without awaiting its completion");
    assert.equal(f.state.acks, 0); assert.equal(f.channel.settleBackpressuredOutput(9000), terminal);
    resume(); await f.channel.detach();
    assert.equal(f.state.acks, 1, "the issued external effect is accounted without a retry");
    assert.deepEqual(await terminal, { status: "blocked", reason: "deadline" });
  } finally { resume(); await f.channel.detach(); }
});

test("C2 round6 Job bad acknowledgement cannot certify terminal output", async () => {
  const f = await fixture();
  try {
    f.channel.subscribeBackpressuredOutput(async (metadata) => ({ ...metadata, digest: "f".repeat(64) }));
    await new Promise((resolve) => setImmediate(resolve));
    f.state.bytes = Buffer.from("last-frame"); f.state.pipesEnded = true;
    assert.equal((await f.channel.settleBackpressuredOutput(1100)).status, "blocked");
    assert.equal(f.state.acks, 0);
  } finally { await f.channel.detach(); }
});

for (const fault of ["identity", "deadline"] as const) test(`C2 round6 Job final reattestation refuses ${fault} change`, async () => {
  const f = await fixture();
  try {
    f.channel.subscribeBackpressuredOutput(async (metadata) => metadata);
    await new Promise((resolve) => setImmediate(resolve));
    f.state.pipesEnded = true;
    let calls = 0;
    f.state.onReattest = () => { if (++calls === 2) { if (fault === "deadline") f.state.now = 1100; else return "live"; } return "exited"; };
    const result = await f.channel.settleBackpressuredOutput(1100);
    assert.equal(result.status, "blocked", "final terminal proof must remain exact through the last awaited observation");
  } finally { await f.channel.detach(); }
});

test("an idle Job channel backs off its background output polling", async () => {
  const f = await fixture();
  try {
    f.channel.subscribeBackpressuredOutput(async (metadata) => metadata);
    await new Promise((resolve) => setTimeout(resolve, 300));
    // A fixed 1 ms cadence would issue hundreds of fenced reads here; doubling from 1 ms issues about nine.
    assert.ok(f.state.reads >= 3 && f.state.reads <= 15, `idle reads: ${f.state.reads}`);
  } finally { await f.channel.detach(); }
});

test("a slow fenced read never queues further background polls behind it", async () => {
  const f = await fixture(); let resume!: () => void; let entered = false;
  const hold = new Promise<void>((resolve) => { resume = resolve; });
  try {
    f.state.beforeRead = async () => { if (!entered) { entered = true; await hold; } };
    f.channel.subscribeBackpressuredOutput(async (metadata) => metadata);
    for (let turn = 0; turn < 20 && !entered; turn++) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(entered, true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const whileHeld = f.state.reads;
    resume();
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(whileHeld, 1, "no poll may start while one is still reading");
    assert.ok(f.state.reads <= 3, `reads after release: ${f.state.reads}`);
  } finally { resume(); await f.channel.detach(); }
});

test("input returns an idle Job channel to the fast poll cadence", async () => {
  const f = await fixture();
  try {
    const delivered: string[] = [];
    f.channel.subscribeBackpressuredOutput(async (metadata, bytes) => { delivered.push(Buffer.from(bytes).toString()); return metadata; });
    // Idle long enough that the next background poll is up to the 500 ms cap away.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const payload = Buffer.from("1+1\n");
    await f.channel.write({ sequence: 1, byteLength: payload.byteLength, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 1000 }, payload);
    f.state.bytes = Buffer.from("2\n>>> ");
    const started = Date.now();
    while (!delivered.length && Date.now() - started < 1000) await new Promise((resolve) => setTimeout(resolve, 2));
    assert.deepEqual(delivered, ["2\n>>> "]);
    assert.ok(Date.now() - started < 150, `output after input took ${Date.now() - started} ms`);
  } finally { await f.channel.detach(); }
});

test("a Job terminal wait drains full output windows without re-attesting between them", async () => {
  const f = await drainFixture({ windows: 8 });
  try {
    const delivered: Buffer[] = [];
    f.channel.subscribeBackpressuredOutput(async (metadata, bytes) => { delivered.push(Buffer.from(bytes)); return metadata; });
    assert.deepEqual(await f.channel.waitForTerminal(), { state: "exited", exitCode: 0 });
    assert.equal(Buffer.concat(delivered).equals(f.bytes), true, "every window is delivered and acknowledged in order");
    // Re-attesting after every poll cost one fenced reconcile per window the wait drains: 7 here.
    assert.equal(f.state.reattests, 1, "only the short read after the last full window re-attests");
  } finally { await f.channel.detach(); }
});

test("a Job terminal wait still re-attests at least once a second while output fills every window", async () => {
  const f = await drainFixture({ windows: 9, clockStepMs: WINDOWS_JOB_DRAIN_REATTEST_MAX_MS * 0.6 });
  try {
    f.channel.subscribeBackpressuredOutput(async (metadata) => metadata);
    assert.deepEqual(await f.channel.waitForTerminal(), { state: "exited", exitCode: 0 });
    // The wait drains 8 full windows, each read moving the clock 0.6 s: 4.8 s of sustained output.
    assert.ok(f.state.reattests >= 4, `a full-window drain must still re-attest at least once a second: ${f.state.reattests}`);
    assert.ok(f.state.reattests < 8, `full windows must not each re-attest: ${f.state.reattests}`);
  } finally { await f.channel.detach(); }
});

test("a Job terminal wait re-attests after every full window while the clock steps back", async () => {
  const f = await drainFixture({ windows: 8, clockStepMs: -WINDOWS_JOB_DRAIN_REATTEST_MAX_MS });
  try {
    f.channel.subscribeBackpressuredOutput(async (metadata) => metadata);
    assert.deepEqual(await f.channel.waitForTerminal(), { state: "exited", exitCode: 0 });
    // The wait's first pass joins the background read of window 1 instead of queuing its own, so
    // every one of the 8 full windows, the first included, is followed by a re-attestation.
    assert.equal(f.state.reattests, 8, "a negative interval since the last re-attestation cannot extend the drain");
  } finally { await f.channel.detach(); }
});

test("a Job terminal wait that drains without re-attesting still refuses a stale fence", async () => {
  const f = await drainFixture({ windows: 8 });
  try {
    let windows = 0;
    f.channel.subscribeBackpressuredOutput(async (metadata) => { if (++windows === 3) f.state.stale = true; return metadata; });
    await assert.rejects(f.channel.waitForTerminal(), /stale fence/);
    assert.equal(f.state.reattests, 0, "the next fenced ACK refuses the stale fence; no re-attestation was needed to catch it");
    assert.equal(f.state.acknowledged, 2 * f.window, "the window delivered under the stale fence is never acknowledged");
  } finally { await f.channel.detach(); }
});

async function settle(channel: unknown, deadlineAt: number): Promise<BackpressuredOutputSettlement> {
  const candidate = channel as { settleBackpressuredOutput?: (deadlineAt: number) => Promise<BackpressuredOutputSettlement> };
  return candidate.settleBackpressuredOutput ? await candidate.settleBackpressuredOutput(deadlineAt) : { status: "blocked", reason: "outcome_unknown" };
}

async function fixture() {
  const state = { now: 1000, bytes: Buffer.alloc(0), acknowledged: 0, pipesEnded: false, stale: false, reads: 0, acks: 0,
    beforeRead: undefined as (() => Promise<void>) | undefined, beforeControl: undefined as (() => Promise<void>) | undefined,
    beforeAck: undefined as (() => Promise<void>) | undefined, onReattest: undefined as (() => "live" | "exited") | undefined };
  const owner = { runId: "job-run", sessionId: "job-session" }; const fence = { ownerId: "job-owner", fencingToken: 1 };
  const exact = () => { if (state.stale) throw new Error("synthetic stale fence"); };
  const service: WindowsJobChannelAuthority["service"] = {
    launchOwned: async () => { throw new Error("No fixture workloads"); }, signalOwned: async () => { throw new Error("No fixture workloads"); },
    reconcileOwned: async () => { throw new Error("unused fixture service method"); }, releaseOwned: async () => { throw new Error("unused fixture service method"); },
    probeActiveJobCreateClose: async () => false,
    claimOwnedFence: async (_id, requestedOwner, requestedFence) => { assert.deepEqual(requestedOwner, owner); assert.deepEqual(requestedFence, fence); exact(); },
    attachOwnedChannel: async () => ({ nextSequence: 1, inputClosed: false, outputOffsets: { stdout: state.acknowledged, stderr: 0 }, outputSequences: { stdout: state.acks, stderr: 0 },
      snapshot: { processId: "job", pid: 42, status: "running", exitCode: null, signal: null, startedAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z", stdout: "", stderr: "", ownershipReleased: false } }),
    writeOwnedInput: async (_id, _owner, _fence, sequence) => ({ acknowledged: true, sequence }), closeOwnedInput: async () => undefined,
    readOwnedOutput: async (_id, requestedOwner, offsets, requestedFence) => { state.reads++; await state.beforeRead?.(); exact(); assert.deepEqual(requestedOwner, owner); assert.deepEqual(requestedFence, fence);
      return { stdout: state.bytes.subarray(offsets.stdout), stderr: new Uint8Array(), next: { stdout: state.bytes.length, stderr: 0 } }; },
    acknowledgeOwnedOutput: async (_id, requestedOwner, requestedFence, _stream, offset) => { await state.beforeAck?.(); exact(); assert.deepEqual(requestedOwner, owner); assert.deepEqual(requestedFence, fence); state.acks++; state.acknowledged = offset; },
  };
  const options = { replayCapacityChunks: 4, replayCapacityBytes: 16, pollIntervalMs: 1, clock: () => state.now,
    authority: (): WindowsJobChannelAuthority => ({ processId: "job", owner, fence, service,
      control: async (effect) => { await state.beforeControl?.(); exact(); return await effect(); },
      // Mirrors native tryMarkStopped: empty Job alone is insufficient; both
      // pipes must end and every retained byte must be acknowledged.
      reattest: async () => { exact(); return state.onReattest?.() ?? (state.pipesEnded && state.acknowledged === state.bytes.length ? "exited" : "live"); },
    }) };
  const channel = await createWindowsJobProcessChannelProvider(options).acquire({} as ProcessBackendBinding, fence);
  return { channel, state };
}

/** A finished workload with `windows` full replay windows of stdout still retained. */
async function drainFixture(options: { windows: number; clockStepMs?: number }) {
  const window = 16; const bytes = Buffer.alloc(window * options.windows, 0x61);
  const state = { now: 1000, acknowledged: 0, reattests: 0, stale: false };
  const owner = { runId: "drain-run", sessionId: "drain-session" }; const fence = { ownerId: "drain-owner", fencingToken: 1 };
  const startedAt = "2026-11-08T00:00:00.000Z";
  const exact = () => { if (state.stale) throw new Error("synthetic stale fence"); };
  // Mirrors native tryMarkStopped: the job reports stopped only once every retained byte is acknowledged.
  const settled = () => state.acknowledged === bytes.length;
  const snapshot = () => ({ processId: "job", pid: 42, status: settled() ? "stopped" as const : "running" as const, exitCode: settled() ? 0 : null,
    signal: null, startedAt, updatedAt: startedAt, stdout: "", stderr: "", ownershipReleased: settled() });
  const service = {
    claimOwnedFence: async () => { exact(); },
    attachOwnedChannel: async () => ({ nextSequence: 1, inputClosed: false, outputOffsets: { stdout: 0, stderr: 0 }, outputSequences: { stdout: 0, stderr: 0 }, snapshot: snapshot() }),
    readOwnedOutput: async (_id: string, _owner: unknown, offsets: { stdout: number }, _fence: unknown, maximumBytes: number) => {
      exact(); state.now += options.clockStepMs ?? 0;
      const stdout = bytes.subarray(offsets.stdout, offsets.stdout + maximumBytes);
      return { stdout, stderr: new Uint8Array(), next: { stdout: offsets.stdout + stdout.byteLength, stderr: 0 } };
    },
    acknowledgeOwnedOutput: async (_id: string, _owner: unknown, _fence: unknown, _stream: string, endOffset: number) => { exact(); state.acknowledged = endOffset; },
    reconcileOwned: async () => { exact(); return snapshot(); },
    waitOwnedStatusChange: async () => undefined,
  } as unknown as WindowsJobChannelAuthority["service"];
  const channel = await createWindowsJobProcessChannelProvider({ replayCapacityChunks: 4, replayCapacityBytes: window,
    // A long interval leaves the background loop at its first read, so the terminal wait drains the rest.
    pollIntervalMs: 60_000, clock: () => state.now,
    authority: (): WindowsJobChannelAuthority => ({ processId: "job", owner, fence, service,
      control: async (effect) => { exact(); return await effect(); },
      reattest: async () => { exact(); state.reattests++; return settled() ? "exited" : "live"; } }),
  }).acquire({ startedAt } as unknown as ProcessBackendBinding, fence);
  state.reattests = 0; // acquire's own re-attestation precedes the terminal wait
  return { channel, state, bytes, window };
}
