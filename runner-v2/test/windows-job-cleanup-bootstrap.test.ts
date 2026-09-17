import assert from "node:assert/strict";
import test from "node:test";
import { createWindowsJobProcessChannelProvider, type WindowsJobChannelAuthority } from "../src/windows-job-process-channel.js";
import type { ProcessBackendBinding } from "../src/process-backend.js";

for (const stream of ["empty", "stdout", "stderr"] as const) {
  test(`Job cleanup bootstrap preserves authenticated ${stream} consumption without new output effects`, async () => {
    const fixture = makeFixture(stream);
    const result = await fixture.provider.reattach(fixture.binding, fixture.fence);
    try {
      assert.deepEqual(result.cleanupBootstrap, {
        version: 1,
        consumed: {
          stdout: { sequence: stream === "stdout" ? 2 : 0, endOffset: stream === "stdout" ? 12 : 0 },
          stderr: { sequence: stream === "stderr" ? 3 : 0, endOffset: stream === "stderr" ? 17 : 0 },
        },
        pendingAcknowledgements: 0,
      }, "never-initialized recovery needs actual fenced positions, not an empty retained-window guess");
      assert.deepEqual(fixture.calls, ["claim", "reattest", "attach"]);
      assert.equal(result.binding, fixture.binding);
      assert.equal(result.nextSequence, 5); assert.equal(result.inputClosed, true);
      assert.deepEqual(result.retainedWindow, []);
    } finally { await result.channel.detach(); }
  });
}

test("Job cleanup bootstrap waits for the authenticated attachment boundary", async () => {
  const fixture = makeFixture("empty");
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  fixture.state.beforeAttach = () => held;
  let completed = false;
  const attaching = fixture.provider.reattach(fixture.binding, fixture.fence).then((result) => { completed = true; return result; });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(completed, false);
    assert.deepEqual(fixture.calls, ["claim", "reattest", "attach"]);
  } finally { release(); }
  const result = await attaching;
  try { assert.equal(result.cleanupBootstrap.consumed.stdout.endOffset, 0); }
  finally { await result.channel.detach(); }
});

test("Job cleanup bootstrap cannot certify a rejected identity or attachment", async () => {
  for (const boundary of ["reattest", "attach"] as const) {
    const fixture = makeFixture("empty"); fixture.state.rejectAt = boundary;
    await assert.rejects(fixture.provider.reattach(fixture.binding, fixture.fence), /controlled ownership refusal/);
    assert.deepEqual(fixture.calls, boundary === "reattest" ? ["claim", "reattest"] : ["claim", "reattest", "attach"]);
  }
});

test("Job cleanup bootstrap snapshot does not expose mutable channel cursor state", async () => {
  const fixture = makeFixture("stdout");
  const result = await fixture.provider.reattach(fixture.binding, fixture.fence);
  try {
    result.cleanupBootstrap.consumed.stdout.endOffset = 999;
    result.cleanupBootstrap.consumed.stdout.sequence = 999;
    const fresh = await fixture.provider.reattach(fixture.binding, fixture.fence);
    try { assert.deepEqual(fresh.cleanupBootstrap.consumed.stdout, { sequence: 2, endOffset: 12 }); }
    finally { await fresh.channel.detach(); }
    assert.equal(fixture.calls.some((call) => call === "ack" || call === "read"), false);
  } finally { await result.channel.detach(); }
});

function makeFixture(stream: "empty" | "stdout" | "stderr") {
  const owner = { runId: "run", sessionId: "session" }; const fence = { ownerId: "recovery", fencingToken: 2 };
  const binding = { opaqueIdentity: "synthetic exact binding" } as ProcessBackendBinding;
  const calls: string[] = [];
  const state: { rejectAt?: string; beforeAttach?: () => Promise<void> } = {};
  const service = {
    claimOwnedFence: async (_id: string, observedOwner: unknown, observedFence: unknown) => {
      assert.deepEqual(observedOwner, owner); assert.deepEqual(observedFence, fence); calls.push("claim");
    },
    attachOwnedChannel: async () => {
      calls.push("attach"); await state.beforeAttach?.();
      if (state.rejectAt === "attach") throw new Error("controlled ownership refusal");
      return { nextSequence: 5, inputClosed: true,
        outputOffsets: { stdout: stream === "stdout" ? 12 : 0, stderr: stream === "stderr" ? 17 : 0 },
        outputSequences: { stdout: stream === "stdout" ? 2 : 0, stderr: stream === "stderr" ? 3 : 0 },
        snapshot: { processId: "exact", pid: 42, status: "running", ownershipReleased: false } };
    },
    readOwnedOutput: async () => { calls.push("read"); assert.fail("observation cannot initiate a read pump"); },
    acknowledgeOwnedOutput: async () => { calls.push("ack"); assert.fail("observation cannot acknowledge bytes"); },
  } as unknown as WindowsJobChannelAuthority["service"];
  const provider = createWindowsJobProcessChannelProvider({ replayCapacityBytes: 256, replayCapacityChunks: 4, pollIntervalMs: 1,
    authority: (observedBinding, observedFence) => {
      assert.equal(observedBinding, binding); assert.deepEqual(observedFence, fence);
      return { processId: "exact", owner, fence, service, control: async (effect) => await effect(),
        reattest: async () => { calls.push("reattest"); if (state.rejectAt === "reattest") throw new Error("controlled ownership refusal"); return "live"; } };
    },
  });
  return { provider, owner, fence, binding, state, calls };
}
