import assert from "node:assert/strict";
import test from "node:test";
import { createWindowsJobProcessChannelProvider, type WindowsJobChannelAuthority } from "../src/windows-job-process-channel.js";
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
