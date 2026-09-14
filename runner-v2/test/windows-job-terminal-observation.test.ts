import assert from "node:assert/strict";
import test from "node:test";
import { createWindowsJobProcessChannelProvider, type WindowsJobChannelAuthority } from "../src/windows-job-process-channel.js";
import type { ProcessBackendBinding } from "../src/process-backend.js";

async function fixture() {
  const owner = { runId: "exact-run", sessionId: "exact-agent" }, fence = { ownerId: "owner", fencingToken: 1 };
  let exited = false, stale = false, reconciles = 0, signals = 0;
  const check = () => { if (stale) throw new Error("Exact fence changed"); };
  const snapshot = () => ({ processId: "job", pid: 42, status: "stopped" as const, exitCode: 7, signal: null,
    startedAt: "2026-09-14T00:00:00Z", updatedAt: "2026-09-14T00:00:00Z", stdout: "", stderr: "", ownershipReleased: true });
  const service = {
    claimOwnedFence: async () => { check(); },
    attachOwnedChannel: async () => ({ nextSequence: 1, inputClosed: false, outputOffsets: { stdout: 0, stderr: 0 }, outputSequences: { stdout: 0, stderr: 0 }, snapshot: snapshot() }),
    readOwnedOutput: async () => ({ stdout: new Uint8Array(), stderr: new Uint8Array(), next: { stdout: 0, stderr: 0 } }),
    reconcileOwned: async (id: string, actualOwner: unknown, actualFence: unknown) => {
      check(); assert.equal(id, "job"); assert.deepEqual(actualOwner, owner); assert.deepEqual(actualFence, fence); reconciles++; return snapshot();
    },
    signalOwned: async () => { signals++; throw new Error("Observation cannot signal a workload"); },
  } as unknown as WindowsJobChannelAuthority["service"];
  const channel = await createWindowsJobProcessChannelProvider({ replayCapacityChunks: 4, replayCapacityBytes: 16, pollIntervalMs: 1,
    authority: () => ({ processId: "job", owner, fence, service, control: async effect => { check(); return await effect(); },
      reattest: async () => { check(); return exited ? "exited" : "live"; } }),
  }).acquire({} as ProcessBackendBinding, fence);
  return { channel, exit: () => { exited = true; }, revoke: () => { stale = true; }, get signals() { return signals; }, get reconciles() { return reconciles; } };
}

test("Windows Job terminal wait preserves the exact authenticated exit code after output settles", async () => {
  const f = await fixture();
  try { f.exit(); assert.deepEqual(await f.channel.waitForTerminal(), { state: "exited", exitCode: 7 }); assert.equal(f.reconciles, 1); assert.equal(f.signals, 0); }
  finally { await f.channel.detach(); }
});

test("Windows Job terminal wait stops observing after detach without waiting for or signalling a live workload", async () => {
  const f = await fixture(); const terminal = f.channel.waitForTerminal(); void terminal.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>(resolve => setImmediate(resolve)); await f.channel.detach();
    const outcome = await Promise.race([terminal.then(() => "unexpected terminal", error => String(error)), new Promise<string>(resolve => { timer = setTimeout(() => resolve("still waiting after detach"), 100); })]);
    assert.match(outcome, /detached/i); assert.equal(f.signals, 0); assert.equal(f.reconciles, 0);
  } finally { if (timer) clearTimeout(timer); f.revoke(); await terminal.catch(() => undefined); await f.channel.detach(); }
});

test("Windows Job terminal observation rejects authority loss before publishing an exit result", async () => {
  const f = await fixture();
  try { f.exit(); f.revoke(); await assert.rejects(f.channel.waitForTerminal(), /fence/i); assert.equal(f.signals, 0); }
  finally { await f.channel.detach(); }
});
