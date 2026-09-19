import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { writeFile } from "node:fs/promises";
import { NativeOwnedProcessBackend, type ProcessBirthInspection } from "../src/native-process-backend.js";

import { WindowsProcessBackend } from "../src/windows-process-backend.js";
import { parseProcessLaunchResult, parseProcessReconciliation, type ProcessBackendBinding, type ProcessEffectFence } from "../src/process-backend.js";
import type { BackpressuredOutputMetadata } from "../src/interactive-process-channel.js";
import { createPortableProcessChannelProvider, type PortableChannelAuthority } from "../src/portable-process-channel.js";
import { retirePortableOutputAcknowledgement, runPortableFenceEffectSync, runPortableFenceSnapshotSync } from "../src/portable-process-protocol.mjs";
import { OwnedFenceContentionError, OwnedFenceLockUnavailableError } from "../src/owned-fence-lock.mjs";

for (const mode of ["replacement", "removal", "detach"] as const) {
  test(`C1 cap output-error dispatch ${mode} respects registration lifetime and fresh scheduling`, async () => {
    const root = mkdtempSync(join(tmpdir(), "aiboard-c1-cap-output-"));
    console.log(JSON.stringify({ created: root }));
    for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
    writeOutputCheckpoint(root);
    writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status: "running" }));
    let failOutput = false;
    const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 1024, pollIntervalMs: 20,
      authority: () => ({ directory: root, nonce: "nonce", fence,
        reattest: () => { if (failOutput) throw new Error("synthetic output failure"); return "live"; },
        reattestObservation: async () => "live",
        effect: async (_kind, effect) => effect(), snapshot: (read) => ({ status: "applied", value: read() }),
      }),
    });
    const channel = await provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence);
    const calls: unknown[] = [];
    let beforeMicrotask = true;
    let sameDispatch = 0;
    let remove = () => {};
    let unsubscribeOutput = () => {};
    let detaching: Promise<unknown> | undefined;
    const observer = (result: unknown) => {
      calls.push(result);
      if (beforeMicrotask) sameDispatch++;
      if (calls.length !== 1) return;
      queueMicrotask(() => { beforeMicrotask = false; });
      unsubscribeOutput();
      if (mode === "replacement") { channel.observeTerminal(observer); remove(); }
      if (mode === "removal") remove();
      if (mode === "detach") detaching = channel.detach();
    };
    try {
      const removeFirst = channel.observeTerminal(observer);
      remove = mode === "replacement" ? removeFirst : channel.observeTerminal(() => calls.push("removed"));
      const waiter = channel.waitForTerminal();
      failOutput = true;
      unsubscribeOutput = channel.subscribeBackpressuredOutput(async (metadata) => metadata);
      assert.deepEqual(await round4Within(waiter), { state: "outcome_unknown" });
      if (mode === "replacement") {
        assert.deepEqual(await round4Within(channel.waitForTerminal()), { state: "outcome_unknown", detail: "synthetic output failure" });
        assert.deepEqual(calls, [{ state: "outcome_unknown" }, { state: "outcome_unknown", detail: "synthetic output failure" }]);
      } else assert.deepEqual(calls, [{ state: "outcome_unknown" }]);
      assert.equal(sameDispatch, 1);
    } finally {
      unsubscribeOutput(); await detaching; await channel.detach();
      rmSync(root, { recursive: true, force: true });
      console.log(JSON.stringify({ removed: root, absent: !existsSync(root) }));
    }
  });
}

test("C1 round5 terminal dispatch skips a subscriber removed by an earlier callback", async () => {
  const fixture = await round4ObserverFixture(async () => ({ state: "absent" }));
  const calls: string[] = [];
  let removeNext = () => {};
  try {
    fixture.state("stopped");
    fixture.channel.observeTerminal(() => { calls.push("first"); removeNext(); });
    removeNext = fixture.channel.observeTerminal(() => calls.push("removed"));
    assert.deepEqual(await round4Within(fixture.channel.waitForTerminal()), { state: "exited", exitCode: 0 });
    assert.deepEqual(calls, ["first"]);
  } finally { await fixture.close(); }
});

test("C1 round5 terminal dispatch detach skips later subscribers and settles pending waiters", async () => {
  const fixture = await round4ObserverFixture(async () => ({ state: "absent" }));
  const calls: string[] = [];
  let detaching: Promise<unknown> | undefined;
  try {
    fixture.state("stopped");
    fixture.channel.observeTerminal(() => { calls.push("first"); detaching = fixture.channel.detach(); });
    fixture.channel.observeTerminal(() => calls.push("detached"));
    const waiters = [fixture.channel.waitForTerminal(), fixture.channel.waitForTerminal()];
    assert.deepEqual(await round4Within(Promise.all(waiters)), [{ state: "outcome_unknown" }, { state: "outcome_unknown" }]);
    await detaching;
    assert.deepEqual(calls, ["first"]);
  } finally { await detaching; await fixture.close(); }
});

for (const mode of ["addition", "replacement"] as const) {
  test(`C1 round5 terminal dispatch ${mode} receives fresh observation and survives predecessor removal`, async () => {
    const fixture = await round4ObserverFixture(async () => ({ state: "absent" }));
    const results: unknown[] = [];
    const next = (result: unknown) => { results.push(result); };
    let removeNext = () => {};
    let freshWaiter: Promise<unknown> | undefined;
    try {
      fixture.state("stopped");
      fixture.channel.observeTerminal(() => {
        removeNext();
        fixture.state("outcome_unknown");
        fixture.channel.observeTerminal(next);
        // A stale unsubscribe must not remove a new registration of the same callback.
        removeNext();
        freshWaiter = fixture.channel.waitForTerminal();
      });
      if (mode === "replacement") removeNext = fixture.channel.observeTerminal(next);
      assert.deepEqual(await round4Within(fixture.channel.waitForTerminal()), { state: "exited", exitCode: 0 });
      assert.ok(freshWaiter);
      assert.deepEqual(await round4Within(freshWaiter), { state: "outcome_unknown" });
      assert.deepEqual(results, [{ state: "outcome_unknown" }], "a registration added during delivery needs its own terminal observation");
    } finally { await fixture.close(); await freshWaiter; }
  });
}

test("C1 round5 terminal dispatch delivers ordinary subscribers and waiters once each", async () => {
  const fixture = await round4ObserverFixture(async () => ({ state: "absent" }));
  const results: unknown[] = [];
  try {
    fixture.state("stopped");
    fixture.channel.observeTerminal((result) => results.push(["first", result]));
    fixture.channel.observeTerminal((result) => results.push(["second", result]));
    assert.deepEqual(await round4Within(Promise.all([fixture.channel.waitForTerminal(), fixture.channel.waitForTerminal()])), [
      { state: "exited", exitCode: 0 }, { state: "exited", exitCode: 0 },
    ]);
    assert.deepEqual(await round4Within(fixture.channel.waitForTerminal()), { state: "exited", exitCode: 0 });
    await fixture.channel.detach();
    assert.deepEqual(results, [["first", { state: "exited", exitCode: 0 }], ["second", { state: "exited", exitCode: 0 }]]);
  } finally { await fixture.close(); }
});

test("round4 native terminal observation permits async evidence intake while birth inspection is pending", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-c1-round4-observation-"));
  console.log(`C1 round4 synthetic root: ${root}`);
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeOutputCheckpoint(root);
  writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status: "running" }));
  let observing = false;
  let synchronousInspections = 0;
  let pendingInspections = 0;
  let evidenceFinished = false;
  const pendingWrites: Promise<void>[] = [];
  let finishInspection!: () => void;
  const inspectionGate = new Promise<void>((resolve) => { finishInspection = resolve; });
  const operations = {
    inspectProcessBirth: () => {
      if (observing) {
        synchronousInspections++;
        const started = performance.now();
        pendingWrites.push(writeFile(join(root, `inspection-${synchronousInspections}.evidence`), "ready").then(() => { evidenceFinished = true; }));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
        console.log(JSON.stringify({ synchronousInspections, blockedMs: performance.now() - started, evidenceFinished }));
      }
      return { state: "present" as const, fingerprint: "birth" };
    },
    inspectProcessBirthAsync: async () => { pendingInspections++; await inspectionGate; pendingInspections--; return { state: "present" as const, fingerprint: "birth" }; },
    listPosixGroup: () => [], signal: () => { throw new Error("synthetic fixture must not signal"); },
  };
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 1, operations });
  const opaque = { version: 1, backendId: "runner-windows-supervisor-v1", nonce: "nonce", directory: root, supervisorPid: 9001, supervisorBirth: "birth" };
  const binding = bindingFor({ opaqueIdentity: Buffer.from(JSON.stringify(opaque)).toString("base64url"), birthFingerprint: { observedAt: "now", discriminator: createHash("sha256").update("nonce\0birth").digest("hex") }, rootPid: 9001, startedAt: "now" });
  const channel = await backend.backpressuredChannelProvider().acquire(binding, fence);
  const bytes = Buffer.from("readiness");
  const metadata: BackpressuredOutputMetadata = { stream: "stdout", sequence: 1, startOffset: 0, endOffset: bytes.length, byteLength: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") };
  writeFileSync(join(root, "channel/output/stdout-000000000001.json"), JSON.stringify({ nonce: "nonce", metadata, bytes: bytes.toString("base64") }));
  let enterSink!: () => void;
  let releaseSink!: () => void;
  const atSink = new Promise<void>((resolve) => { enterSink = resolve; });
  const sinkGate = new Promise<void>((resolve) => { releaseSink = resolve; });
  const unsubscribeOutput = channel.subscribeBackpressuredOutput(async (actual, data) => {
    enterSink(); await sinkGate;
    await writeFile(join(root, "output.evidence"), data);
    evidenceFinished = true;
    return actual;
  });
  await atSink;
  await writeFile(join(root, "observer-disabled.evidence"), "ready");
  assert.equal(readFileSync(join(root, "observer-disabled.evidence"), "utf8"), "ready");
  assert.equal(synchronousInspections, 0, "observer-disabled control completes async evidence without inspection");
  // No further output poll may obscure which consumer owns the inspected call.
  // Its in-flight sink remains tracked through detach.
  unsubscribeOutput();
  try {
    observing = true;
    const unsubscribe = channel.observeTerminal(() => { throw new Error("running owner is not terminal"); });
    await waitFor(() => synchronousInspections > 0 || pendingInspections > 0);
    releaseSink();
    await waitFor(() => evidenceFinished);
    const activeCount = synchronousInspections;
    unsubscribe();
    await new Promise((resolve) => setTimeout(resolve, 10));
    console.log(JSON.stringify({ activeCount, afterUnsubscribe: synchronousInspections, pendingInspections, evidenceFinished }));
    assert.equal(synchronousInspections, 0, "live terminal observation must not synchronously block async evidence intake");
    assert.equal(pendingInspections, 1, "one owned inspection must stay pending without an overlapping backlog");
  } finally {
    observing = false; releaseSink(); finishInspection();
    await channel.detach(); await Promise.all(pendingWrites);
    rmSync(root, { recursive: true, force: true });
    console.log(`C1 round4 synthetic root removed: ${root}`);
  }
});

for (const fault of ["absent_running", "recycled", "unknown", "takeover", "wrong_nonce", "corrupt_state", "unknown_status", "stopped", "retained", "late_output", "late_takeover", "late_running"] as const) {
  test(`round4 native terminal authority preserves ${fault}`, async () => {
    let checks = 0;
    const fixture = await round4ObserverFixture(async () => {
      checks++;
      await writeFile(join(fixture.root, `inspection-${checks}.evidence`), "async boundary");
      if (fault === "takeover" || fault === "late_takeover" && checks === 2) fixture.takeover();
      if (fault === "late_output" && checks === 2) fixture.output();
      if (fault === "late_running" && checks === 2) fixture.state("running");
      if (fault === "absent_running" || fault === "stopped") return { state: "absent" };
      if (fault === "unknown") return { state: "unknown" };
      return { state: "present", fingerprint: fault === "recycled" ? "replacement" : "birth" };
    });
    try {
      if (["stopped", "retained", "late_output", "late_takeover", "late_running"].includes(fault)) fixture.state("stopped");
      if (fault === "retained") fixture.output();
      if (fault === "wrong_nonce") writeFileSync(join(fixture.root, "state.json"), JSON.stringify({ nonce: "foreign", status: "stopped" }));
      if (fault === "corrupt_state") writeFileSync(join(fixture.root, "state.json"), "{");
      if (fault === "unknown_status") fixture.state("corrupt");
      if (fault === "retained" || fault === "late_output") {
        const results: unknown[] = [];
        const unsubscribe = fixture.channel.observeTerminal((result) => results.push(result));
        await waitFor(() => checks >= 3 || results.length > 0);
        unsubscribe();
        assert.deepEqual(results, [], "retained output still prevents clean terminal");
        assert.equal(readdirSync(join(fixture.root, "channel/output")).length, 1);
      } else {
        assert.deepEqual(await round4Within(fixture.channel.waitForTerminal()), fault === "stopped" ? { state: "exited", exitCode: 0 } : { state: "outcome_unknown" });
      }
    } finally { await fixture.close(); }
  });
}

test("round4 terminal unsubscribe and detach cancel and join late inspection without reviving observers", async () => {
  let entered = 0;
  let complete!: (inspection: ProcessBirthInspection) => void;
  const completions: Array<(inspection: ProcessBirthInspection) => void> = [];
  let inspectionSignal!: AbortSignal;
  const fixture = await round4ObserverFixture(async (signal) => {
    entered++; inspectionSignal = signal;
    return await new Promise<ProcessBirthInspection>((resolve) => { complete = resolve; completions.push(resolve); });
  });
  const oldResults: unknown[] = [];
  const newResults: unknown[] = [];
  try {
    const remove = fixture.channel.observeTerminal((result) => oldResults.push(result));
    await waitFor(() => entered === 1);
    remove();
    assert.equal(inspectionSignal.aborted, true, "last removal must cancel inspection");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(entered, 1, "zero observers must not restart inspection");
    fixture.channel.observeTerminal((result) => newResults.push(result));
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(entered, 1, "replacement observers cannot overlap the old owned inspection");
    complete({ state: "unknown" });
    await waitFor(() => entered === 2 || newResults.length > 0);
    assert.deepEqual(oldResults, []);
    assert.deepEqual(newResults, [], "old unknown result must not notify a replacement observer");
    let detached = false;
    const detaching = fixture.channel.detach().then(() => { detached = true; });
    assert.equal(inspectionSignal.aborted, true);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(detached, false, "detach must retain pending inspection through actual completion");
    complete({ state: "absent" });
    await detaching;
    assert.deepEqual(newResults, []);
    assert.throws(() => fixture.channel.observeTerminal(() => {}), /detached/);
  } finally { for (const finish of completions) finish({ state: "unknown" }); await fixture.close(); }
});

test("round4 native observation boundary rejects ownership changed during its await", async () => {
  const fixture = await round4ObserverFixture(async () => {
    await writeFile(join(fixture.root, "inspection.evidence"), "ready");
    fixture.takeover();
    return { state: "present", fingerprint: "birth" };
  });
  try {
    // Exercise the actual injected native authority boundary separately from
    // the channel's next poll, which also rejects an already stale fence.
    const authority = Reflect.get(fixture.channel, "authority") as PortableChannelAuthority;
    await assert.rejects(authority.reattestObservation!(new AbortController().signal), /stale|fence/i);
  } finally { await fixture.close(); }
});

async function round4Within<T>(operation: Promise<T>): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("terminal proof did not settle within the synthetic bound")), 2_000); })]); }
  finally { clearTimeout(timer); }
}

test("round4 POSIX workload identity is revalidated after asynchronous birth inspection", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-c1-round4-posix-"));
  console.log(`C1 round4 synthetic root: ${root}`);
  const group = { groupId: 9002, leaderPid: 9002, leaderBirth: "group-birth" };
  const state = { protocol: "aiboard-portable-process/v2", nonce: "nonce", supervisorPid: 9001, supervisorBirth: "birth", workloadGroup: group,
    revision: 1, handledControl: 0, launchEffect: "started", status: "running", knownProcesses: [], rootProcess: null,
    exitCode: null, signal: null, error: null, updatedAt: "now", workloadGroupRetirement: { state: "active" } };
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeOutputCheckpoint(root); writeFileSync(join(root, "state.json"), JSON.stringify(state));
  const backend = new NativeOwnedProcessBackend({ stateDirectory: root, pollIntervalMs: 1, platform: "posix", backendId: "synthetic-posix",
    capabilities: { tree_termination: "unavailable", crash_cleanup: "unavailable", verified_emptiness: "unavailable", write_confinement: "unavailable" },
    operations: {
      inspectProcessBirth: () => ({ state: "present", fingerprint: "birth" }),
      inspectProcessBirthAsync: async () => {
        await writeFile(join(root, "state.json"), JSON.stringify({ ...state, workloadGroup: { ...group, leaderBirth: "replacement" } }));
        return { state: "present", fingerprint: "birth" };
      }, listPosixGroup: () => [], signal: () => { throw new Error("synthetic fixture must not signal"); },
    } });
  const opaque = { version: 2, backendId: "synthetic-posix", nonce: "nonce", directory: root, supervisorPid: 9001, supervisorBirth: "birth", workloadGroup: group };
  const binding = { ...bindingFor({ opaqueIdentity: Buffer.from(JSON.stringify(opaque)).toString("base64url"), rootPid: 9001, startedAt: "now",
    birthFingerprint: { observedAt: "now", discriminator: createHash("sha256").update(["nonce", "birth", 9002, 9002, "group-birth"].join("\0")).digest("hex") } }), backendId: "synthetic-posix" };
  const channel = await backend.backpressuredChannelProvider().acquire(binding, fence);
  try { assert.deepEqual(await round4Within(channel.waitForTerminal()), { state: "outcome_unknown" }); }
  finally { await channel.detach(); rmSync(root, { recursive: true, force: true }); console.log(`C1 round4 synthetic root removed: ${root}`); }
});

async function round4ObserverFixture(inspect: (signal: AbortSignal) => Promise<ProcessBirthInspection>) {
  const root = mkdtempSync(join(tmpdir(), "aiboard-c1-round4-authority-"));
  console.log(`C1 round4 synthetic root: ${root}`);
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeOutputCheckpoint(root);
  const state = (status: string) => writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status, exitCode: 0, signal: null }));
  state("running");
  const inspections = new Set<Promise<ProcessBirthInspection>>();
  const operations = {
    inspectProcessBirth: () => ({ state: "present" as const, fingerprint: "birth" }),
    inspectProcessBirthAsync: (_pid: number, _platform: "posix" | "windows", signal: AbortSignal) => {
      const operation = inspect(signal);
      inspections.add(operation);
      void operation.finally(() => inspections.delete(operation));
      return operation;
    },
    listPosixGroup: () => [], signal: () => { throw new Error("synthetic fixture must not signal"); },
  };
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 1, operations });
  const opaque = { version: 1, backendId: "runner-windows-supervisor-v1", nonce: "nonce", directory: root, supervisorPid: 9001, supervisorBirth: "birth" };
  const binding = bindingFor({ opaqueIdentity: Buffer.from(JSON.stringify(opaque)).toString("base64url"), birthFingerprint: { observedAt: "now", discriminator: createHash("sha256").update("nonce\0birth").digest("hex") }, rootPid: 9001, startedAt: "now" });
  const channel = await backend.backpressuredChannelProvider().acquire(binding, fence);
  return { root, channel, state,
    takeover: () => writeFileSync(join(root, "fence.json"), JSON.stringify({ nonce: "nonce", ownerId: "new-owner", fencingToken: 8 })),
    output: () => {
      const bytes = Buffer.from("retained");
      const metadata = { stream: "stdout", sequence: 1, startOffset: 0, endOffset: bytes.length, byteLength: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") };
      writeFileSync(join(root, "channel/output/stdout-000000000001.json"), JSON.stringify({ nonce: "nonce", metadata, bytes: bytes.toString("base64") }));
    },
    close: async () => { await channel.detach(); await Promise.all(inspections); rmSync(root, { recursive: true, force: true }); console.log(`C1 round4 synthetic root removed: ${root}`); },
  };
}

test("live stopped supervisor yields terminal snapshots until output retirement can finish", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-live-stopped-terminal-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeOutputCheckpoint(root);
  writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status: "stopped", exitCode: 0, signal: null }));
  let supervisorLive = true;
  let snapshotCalls = 0;
  const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 4, replayCapacityBytes: 1024, pollIntervalMs: 5,
    authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => "live",
      reattestObservation: async () => supervisorLive ? "live" : "exited",
      effect: async (_kind, effect) => effect(),
      snapshot: (read) => { snapshotCalls++; return { status: "applied", value: read() }; },
    }),
  });
  const channel = await provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence);
  let settled = false;
  const terminal = channel.waitForTerminal().then((result) => { settled = true; return result; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(settled, false, "a live stopped supervisor still owns output retirement");
    assert.equal(snapshotCalls, 0, "terminal polling must not contend for the output-retirement writer fence");
    supervisorLive = false;
    assert.deepEqual(await round4Within(terminal), { state: "exited", exitCode: 0 });
    assert.ok(snapshotCalls > 0, "terminal proof is fenced after the supervisor exits");
  } finally { await channel.detach(); rmSync(root, { recursive: true, force: true }); }
});

test("round5 portable settlement waits through sink ACK publication retirement and terminal", async () => {
  const fixture = await settlementFixture();
  let sinkCalls = 0;
  fixture.channel.subscribeBackpressuredOutput(async (metadata) => { sinkCalls++; return metadata; });
  let settled = false;
  const settlement = fixture.channel.settleBackpressuredOutput(2_000).then((result) => { settled = true; return result; });
  try {
    await fixture.atAck;
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sinkCalls, 1);
    assert.equal(settled, false, "sink success is not ACK publication");
    assert.deepEqual(readdirSync(join(fixture.root, "channel/ack")), []);
    fixture.resumeAck();
    await waitFor(() => readdirSync(join(fixture.root, "channel/ack")).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false, "published ACK is not supervisor retirement");
    retirePortableOutputAcknowledgement({ channelDirectory: join(fixture.root, "channel"), nonce: "nonce", fence,
      name: "stdout-000000000001.json", metadata: fixture.metadata });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(settled, false, "empty output without terminal proof cannot exclude a later suffix");
    fixture.stop();
    assert.deepEqual(await settlement, { status: "settled" });
    assert.deepEqual(readdirSync(join(fixture.root, "channel/output")), []);
    assert.deepEqual(readdirSync(join(fixture.root, "channel/ack")), []);
    await fixture.channel.detach();
    assert.equal(sinkCalls, 1);
  } finally { await fixture.close(); }
});

test("round5 portable settlement retries transient contention during final re-attestation", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-final-reattest-contention-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeOutputCheckpoint(root);
  writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status: "running" }));
  let contendFinalReattest = false;
  let finalReattestContentions = 0;
  const provider = createPortableProcessChannelProvider({
    replayCapacityChunks: 4, replayCapacityBytes: 16, pollIntervalMs: 500,
    authority: () => ({
      directory: root, nonce: "nonce", fence,
      reattest: () => {
        if (contendFinalReattest && finalReattestContentions++ === 0)
          throw new OwnedFenceContentionError("transient final re-attestation contention");
        return "live";
      },
      effect: async (_kind, effect) => effect(),
      snapshot: (read) => {
        const value = read();
        if (value && typeof value === "object" && "terminal" in value && value.terminal === true) contendFinalReattest = true;
        return { status: "applied", value };
      },
    }),
  });
  const channel = await provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence);
  const unsubscribe = channel.subscribeBackpressuredOutput(async (entry) => entry);
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status: "stopped", exitCode: 0 }));
    assert.deepEqual(await channel.settleBackpressuredOutput(Date.now() + 2_000), { status: "settled" });
    assert.ok(finalReattestContentions >= 2, "settlement must retry after one transient final re-attestation contention");
  } finally {
    unsubscribe();
    await channel.detach();
    rmSync(root, { recursive: true, force: true });
  }
});

test("round5 portable settlement retries transient coordination contention then settles", async () => {
  const fixture = await settlementFixture();
  fixture.channel.subscribeBackpressuredOutput(async (metadata) => metadata);
  const settlement = fixture.channel.settleBackpressuredOutput(2_000);
  try {
    await fixture.atAck;
    fixture.resumeAck();
    await waitFor(() => readdirSync(join(fixture.root, "channel/ack")).length === 1);
    retirePortableOutputAcknowledgement({ channelDirectory: join(fixture.root, "channel"), nonce: "nonce", fence,
      name: "stdout-000000000001.json", metadata: fixture.metadata });
    fixture.transientCoordination(3);
    fixture.stop();
    assert.deepEqual(await settlement, { status: "settled" });
  } finally { await fixture.close(); }
});

test("round5 portable output ACK retries transient owned-fence contention without poisoning settlement", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-ack-contention-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeOutputCheckpoint(root);
  const bytes = Buffer.from("x");
  const metadata: BackpressuredOutputMetadata = {
    stream: "stdout", sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
  writeFileSync(join(root, "channel/output/stdout-000000000001.json"), JSON.stringify({ nonce: "nonce", metadata, bytes: bytes.toString("base64") }));
  writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status: "running" }));
  let ackContention = 2;
  let sinkCalls = 0;
  const provider = createPortableProcessChannelProvider({
    replayCapacityChunks: 4, replayCapacityBytes: 16, pollIntervalMs: 5,
    authority: () => ({
      directory: root, nonce: "nonce", fence,
      reattest: () => "live",
      effect: async (kind, effect) => {
        if (kind === "output_ack" && ackContention-- > 0)
          throw new OwnedFenceContentionError("transient fence contention");
        return effect();
      },
      snapshot: (read) => ({ status: "applied", value: read() }),
    }),
  });
  const channel = await provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence);
  const unsubscribe = channel.subscribeBackpressuredOutput(async (entry) => { sinkCalls += 1; return entry; });
  const settlement = channel.settleBackpressuredOutput(Date.now() + 2_000);
  try {
    await waitFor(() => readdirSync(join(root, "channel/ack")).length === 1);
    retirePortableOutputAcknowledgement({ channelDirectory: join(root, "channel"), nonce: "nonce", fence,
      name: "stdout-000000000001.json", metadata });
    writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status: "stopped", exitCode: 0 }));
    assert.deepEqual(await settlement, { status: "settled" });
    assert.equal(sinkCalls, 1, "transient ACK contention must retry ACK publication without replaying accepted bytes");
  } finally {
    unsubscribe();
    await channel.detach();
    rmSync(root, { recursive: true, force: true });
  }
});

test("round5 a fresh channel still replays retained output even when an old exact ACK exists", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-ack-reattach-replay-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeOutputCheckpoint(root);
  const bytes = Buffer.from("x");
  const metadata: BackpressuredOutputMetadata = {
    stream: "stdout", sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
  writeFileSync(join(root, "channel/output/stdout-000000000001.json"), JSON.stringify({ nonce: "nonce", metadata, bytes: bytes.toString("base64") }));
  writeFileSync(join(root, "channel/ack/stdout-000000000001.json"), JSON.stringify({ nonce: "nonce", ...fence, metadata }));
  writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status: "running" }));
  const provider = createPortableProcessChannelProvider({
    replayCapacityChunks: 4, replayCapacityBytes: 16, pollIntervalMs: 5,
    authority: () => ({
      directory: root, nonce: "nonce", fence,
      reattest: () => "live",
      effect: async (_kind, effect) => effect(),
      snapshot: (read) => ({ status: "applied", value: read() }),
    }),
  });
  const channel = await provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence);
  let sinkCalls = 0;
  const unsubscribe = channel.subscribeBackpressuredOutput(async (entry) => { sinkCalls += 1; return entry; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(sinkCalls, 1, "reattach preserves at-least-once replay even if an old exact ACK remains durable");
  } finally {
    unsubscribe();
    await channel.detach();
    rmSync(root, { recursive: true, force: true });
  }
});

test("round5 portable output ACK recognizes an exact durable ACK after post-effect contention without replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-ack-posteffect-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeOutputCheckpoint(root);
  const bytes = Buffer.from("x");
  const metadata: BackpressuredOutputMetadata = {
    stream: "stdout", sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
  writeFileSync(join(root, "channel/output/stdout-000000000001.json"), JSON.stringify({ nonce: "nonce", metadata, bytes: bytes.toString("base64") }));
  writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status: "running" }));
  let ackEffects = 0;
  let sinkCalls = 0;
  const provider = createPortableProcessChannelProvider({
    replayCapacityChunks: 4, replayCapacityBytes: 16, pollIntervalMs: 5,
    authority: () => ({
      directory: root, nonce: "nonce", fence,
      reattest: () => "live",
      effect: async (kind, effect) => {
        if (kind !== "output_ack") return effect();
        ackEffects += 1;
        const value = effect();
        if (ackEffects === 1)
          throw new OwnedFenceContentionError("Owned fence lock remains held by an exact live holder.");
        return value;
      },
      snapshot: (read) => ({ status: "applied", value: read() }),
    }),
  });
  const channel = await provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence);
  const unsubscribe = channel.subscribeBackpressuredOutput(async (entry) => { sinkCalls += 1; return entry; });
  const settlement = channel.settleBackpressuredOutput(Date.now() + 2_000);
  try {
    await waitFor(() => readdirSync(join(root, "channel/ack")).length === 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(sinkCalls, 1, "an exact already-durable ACK must suppress sink replay");
    assert.equal(ackEffects, 1, "an exact already-durable ACK must suppress a second ACK effect");
    retirePortableOutputAcknowledgement({ channelDirectory: join(root, "channel"), nonce: "nonce", fence,
      name: "stdout-000000000001.json", metadata });
    writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status: "stopped", exitCode: 0 }));
    assert.deepEqual(await settlement, { status: "settled" });
  } finally {
    unsubscribe();
    await channel.detach();
    rmSync(root, { recursive: true, force: true });
  }
});

test("round5 portable settlement does not retry permanent coordination-classified protocol corruption", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-settlement-permanent-coordination-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeOutputCheckpoint(root);
  writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status: "running" }));
  let snapshots = 0;
  const provider = createPortableProcessChannelProvider({
    replayCapacityChunks: 4, replayCapacityBytes: 16, pollIntervalMs: 5,
    authority: () => ({
      directory: root, nonce: "nonce", fence,
      reattest: () => "live",
      effect: async (_kind, effect) => effect(),
      snapshot: (read) => {
        snapshots += 1;
        if (snapshots === 1) return { status: "applied", value: read() };
        return { status: "unavailable", cause: "coordination", error: new OwnedFenceLockUnavailableError("Owned fence protocol canonical schema is incomplete.") };
      },
    }),
  });
  const channel = await provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence);
  const unsubscribe = channel.subscribeBackpressuredOutput(async (entry) => entry);
  const snapshotsBeforeSettlement = snapshots;
  const startedAt = Date.now();
  try {
    assert.deepEqual(await channel.settleBackpressuredOutput(Date.now() + 1_000), { status: "blocked", reason: "outcome_unknown" });
    assert.ok(snapshots > snapshotsBeforeSettlement, "settlement must inspect authority before failing closed");
    assert.ok(Date.now() - startedAt < 250, "permanent corruption must fail fast rather than consume the settlement deadline");
  } finally {
    unsubscribe();
    await channel.detach();
    rmSync(root, { recursive: true, force: true });
  }
});

test("round5 portable output ACK treats permanent owned-fence protocol invalidity as terminal", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-ack-invalid-fence-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeOutputCheckpoint(root);
  const bytes = Buffer.from("x");
  const metadata: BackpressuredOutputMetadata = {
    stream: "stdout", sequence: 1, startOffset: 0, endOffset: 1, byteLength: 1,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
  writeFileSync(join(root, "channel/output/stdout-000000000001.json"), JSON.stringify({ nonce: "nonce", metadata, bytes: bytes.toString("base64") }));
  writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status: "running" }));
  let ackAttempts = 0;
  const provider = createPortableProcessChannelProvider({
    replayCapacityChunks: 4, replayCapacityBytes: 16, pollIntervalMs: 5,
    authority: () => ({
      directory: root, nonce: "nonce", fence,
      reattest: () => "live",
      effect: async (kind, effect) => {
        if (kind === "output_ack") {
          ackAttempts += 1;
          throw new OwnedFenceLockUnavailableError("Owned fence protocol canonical schema is incomplete.");
        }
        return effect();
      },
      snapshot: (read) => ({ status: "applied", value: read() }),
    }),
  });
  const channel = await provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence);
  const unsubscribe = channel.subscribeBackpressuredOutput(async (entry) => entry);
  try {
    assert.deepEqual(await channel.settleBackpressuredOutput(Date.now() + 1_000), { status: "blocked", reason: "outcome_unknown" });
    assert.equal(ackAttempts, 1, "permanent protocol invalidity must not be retried as contention");
    assert.deepEqual(readdirSync(join(root, "channel/ack")), []);
  } finally {
    unsubscribe();
    await channel.detach();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const failure of ["deadline", "deadline_final_reattest", "takeover", "takeover_final_snapshot", "coordination", "corrupt_snapshot", "retirement_intent", "suffix"] as const) {
  test(`round5 portable settlement blocks ${failure} while tracking the issued ACK`, async () => {
    const fixture = await settlementFixture();
    fixture.channel.subscribeBackpressuredOutput(async (metadata) => {
      if (metadata.sequence !== 1) throw new Error("unaccepted suffix");
      return metadata;
    });
    const settlement = fixture.channel.settleBackpressuredOutput(2_000);
    try {
      await fixture.atAck;
      if (failure === "deadline") fixture.setTime(2_000);
      if (failure === "takeover") fixture.takeover();
      fixture.resumeAck();
      if (failure !== "deadline" && failure !== "takeover") {
        await waitFor(() => readdirSync(join(fixture.root, "channel/ack")).length === 1);
        if (failure === "retirement_intent") {
          assert.throws(() => retirePortableOutputAcknowledgement({ channelDirectory: join(fixture.root, "channel"),
            nonce: "nonce", fence, name: "stdout-000000000001.json", metadata: fixture.metadata,
            afterBoundary: (boundary) => { if (boundary === "intent") throw new Error("held retirement"); } }));
          fixture.stop();
        } else {
          retirePortableOutputAcknowledgement({ channelDirectory: join(fixture.root, "channel"), nonce: "nonce", fence,
            name: "stdout-000000000001.json", metadata: fixture.metadata });
          if (failure === "coordination") fixture.blockCoordination();
          if (failure === "corrupt_snapshot") unlinkSync(join(fixture.root, "channel/output-checkpoint.json"));
          if (failure === "takeover_final_snapshot") fixture.takeoverAfterSnapshot();
          if (failure === "deadline_final_reattest") fixture.expireOnReattest();
          if (failure === "suffix") fixture.appendSuffix();
          fixture.stop();
        }
      }
      const result = await settlement;
      assert.equal(result.status, "blocked");
      if (failure === "deadline" || failure === "deadline_final_reattest") assert.deepEqual(result, { status: "blocked", reason: "deadline" });
      if (failure === "takeover" || failure === "takeover_final_snapshot") assert.deepEqual(result, { status: "blocked", reason: "stale_fence" });
      if (failure === "coordination") assert.deepEqual(result, { status: "blocked", reason: "coordination_unavailable" });
      if (failure === "deadline" || failure === "takeover") {
        await fixture.channel.detach();
        assert.deepEqual(readdirSync(join(fixture.root, "channel/ack")), [], "late or stale ACK must never publish");
        assert.equal(readdirSync(join(fixture.root, "channel/output")).length, 1);
      }
      if (failure === "suffix") assert.equal(existsSync(join(fixture.root, "channel/ack/stdout-000000000002.json")), false);
    } finally { await fixture.close(); }
  });
}

async function settlementFixture() {
  const root = mkdtempSync(join(tmpdir(), "aiboard-cleanup-settlement-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeOutputCheckpoint(root);
  const bytes = Buffer.from([0]);
  const metadata: BackpressuredOutputMetadata = { stream: "stdout", sequence: 1, startOffset: 0, endOffset: 1,
    byteLength: 1, digest: createHash("sha256").update(bytes).digest("hex") };
  writeFileSync(join(root, "channel/output/stdout-000000000001.json"), JSON.stringify({ nonce: "nonce", metadata, bytes: bytes.toString("base64") }));
  writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status: "running" }));
  let current = { ...fence } as { ownerId: string; fencingToken: number };
  let now = 1_000;
  let coordination = false;
  let coordinationBlips = 0;
  let takeoverAfterSnapshot = false;
  let expireOnReattest = false;
  let entered!: () => void;
  let resume!: () => void;
  const atAck = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { resume = resolve; });
  const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 4, replayCapacityBytes: 16, pollIntervalMs: 1,
    clock: () => now,
    authority: () => ({ directory: root, nonce: "nonce", fence,
      reattest: () => {
        if (current.ownerId !== fence.ownerId || current.fencingToken !== fence.fencingToken) throw new Error("stale fence");
        if (expireOnReattest) now = 2_000;
        return "live";
      },
      effect: async (kind, effect) => {
        if (kind === "output_ack") { entered(); await held; }
        const result = runPortableFenceEffectSync({ lockPath: join(root, "effect.lock"), expectedFence: fence,
          readCurrentFence: () => current, effect });
        if (result.status !== "applied") throw new Error("effect refused");
        return result.value;
      },
      snapshot: (read) => {
        if (coordinationBlips > 0) {
          coordinationBlips -= 1;
          return { status: "unavailable", cause: "coordination", error: new OwnedFenceContentionError("transient sidecar") };
        }
        if (coordination) return { status: "unavailable", cause: "coordination", error: new OwnedFenceContentionError("held lock") };
        const result = runPortableFenceSnapshotSync({ lockPath: join(root, "effect.lock"), expectedFence: fence,
          readCurrentFence: () => current, read });
        if (takeoverAfterSnapshot) current = { ownerId: "successor", fencingToken: 8 };
        return result;
      },
    }),
  });
  const channel = await provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence);
  return { root, metadata, channel, atAck, resumeAck: resume, setTime: (value: number) => { now = value; },
    takeover: () => { current = { ownerId: "successor", fencingToken: 8 }; },
    takeoverAfterSnapshot: () => { takeoverAfterSnapshot = true; },
    expireOnReattest: () => { expireOnReattest = true; },
    blockCoordination: () => { coordination = true; },
    transientCoordination: (count: number) => { coordinationBlips = count; },
    stop: () => writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status: "stopped", exitCode: 0 })),
    appendSuffix: () => writeFileSync(join(root, "channel/output/stdout-000000000002.json"), JSON.stringify({ nonce: "nonce",
      metadata: { ...metadata, sequence: 2, startOffset: 1, endOffset: 2 }, bytes: bytes.toString("base64") })),
    close: async () => { resume(); await channel.detach(); rmSync(root, { recursive: true, force: true }); },
  };
}

test("portable channel ignores only the exact supervisor atomic output publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-output-publication-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeOutputCheckpoint(root);
  writeFileSync(join(root, "channel/client-state.json"), JSON.stringify({
    nonce: "nonce", ownerId: fence.ownerId, fencingToken: fence.fencingToken,
    nextCommand: 1, nextWrite: 1, inputClosed: false,
  }));
  const binding = bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 321, startedAt: "now" });
  const provider = createPortableProcessChannelProvider({
    replayCapacityChunks: 1, replayCapacityBytes: 8, pollIntervalMs: 5,
    authority: () => ({
      directory: root, nonce: "nonce", fence, supervisorPid: 321,
      reattest: () => "live", effect: async (_kind, effect) => effect(), snapshot: immediateSnapshot,
    }),
  });
  const exactTemporary = join(root, "channel/output/stdout-000000000001.json.321.tmp");
  try {
    writeFileSync(exactTemporary, "partial authenticated publication");
    const channel = await provider.acquire(binding, fence);
    assert.deepEqual(channel.retainedWindow(), []);
    await channel.detach();
    writeFileSync(join(root, "channel/output/stdout-000000000001.json.999.tmp"), "foreign publication");
    await assert.rejects(provider.acquire(binding, fence), /output filename is invalid/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("portable write returns its durable acknowledged outcome when takeover wins before acknowledgement consumption", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-durable-input-ack-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeOutputCheckpoint(root);
  let current: ProcessEffectFence = { ...fence };
  const higher: ProcessEffectFence = { ownerId: "recovery-owner", fencingToken: fence.fencingToken + 1 };
  const provider = createPortableProcessChannelProvider({
    replayCapacityChunks: 1,
    replayCapacityBytes: 8,
    pollIntervalMs: 5,
    authority: () => ({
      directory: root,
      nonce: "nonce",
      fence,
      reattest: () => {
        if (current.ownerId !== fence.ownerId || current.fencingToken !== fence.fencingToken) throw new Error("stale writer fence");
        return "live";
      },
      effect: async (kind, effect) => {
        if (current.ownerId !== fence.ownerId || current.fencingToken !== fence.fencingToken) throw new Error("stale fence at effect boundary");
        const result = effect();
        if (kind === "write") {
          writeFileSync(join(root, "channel/ack/input-000000000001.json"), JSON.stringify({
            nonce: "nonce",
            ownerId: fence.ownerId,
            fencingToken: fence.fencingToken,
            sequence: 1,
            status: "acknowledged",
          }));
          current = higher;
        }
        return result;
      },
      snapshot: immediateSnapshot,
    }),
  });
  const channel = await provider.acquire(bindingFor({
    opaqueIdentity: "opaque",
    birthFingerprint: { observedAt: "now", discriminator: "birth" },
    rootPid: 1,
    startedAt: "now",
  }), fence);
  const payload = Buffer.from("delivered");
  try {
    assert.deepEqual(await channel.write({
      sequence: 1,
      byteLength: payload.byteLength,
      digest: createHash("sha256").update(payload).digest("hex"),
      timeoutMs: 1_000,
    }, payload), { acknowledged: true, sequence: 1 });
    assert.equal(existsSync(join(root, "channel/ack/input-000000000001.json")), true,
      "the durable acknowledgement must remain when its prior owner cannot consume it");
  } finally {
    await channel.detach();
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable output polling coalesces while one backpressured delivery is in flight", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-output-coalesce-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  const bytes = Buffer.from("held");
  const metadata: BackpressuredOutputMetadata = {
    stream: "stdout", sequence: 1, startOffset: 0, endOffset: bytes.length, byteLength: bytes.length,
    digest: createHash("sha256").update(bytes).digest("hex"),
  };
  writeFileSync(join(root, "channel/output/stdout-000000000001.json"), JSON.stringify({ nonce: "nonce", metadata, bytes: bytes.toString("base64") }));
  writeOutputCheckpoint(root);
  writeFileSync(join(root, "channel/client-state.json"), JSON.stringify({
    nonce: "nonce", ownerId: fence.ownerId, fencingToken: fence.fencingToken,
    nextCommand: 1, nextWrite: 1, inputClosed: false,
  }));
  let entered!: () => void;
  let release!: () => void;
  const atSink = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const provider = createPortableProcessChannelProvider({
    replayCapacityChunks: 1, replayCapacityBytes: 8, pollIntervalMs: 1,
    authority: () => ({
      directory: root, nonce: "nonce", fence,
      reattest: () => "live",
      effect: async (_kind, effect) => effect(),
      snapshot: immediateSnapshot,
    }),
  });
  const channel = await provider.acquire(bindingFor({
    opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now",
  }), fence);
  const unsubscribe = channel.subscribeBackpressuredOutput(async (actual) => {
    entered();
    await held;
    return actual;
  });
  try {
    await atSink;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const outputTasks = Reflect.get(channel, "outputTasks") as number;
    assert.equal(outputTasks, 1, "the poll timer must not queue duplicate output tasks behind one backpressured delivery");
  } finally {
    release();
    unsubscribe();
    await channel.detach();
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable provider retains a chunk until the identical sink acknowledgement settles", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-ack-order-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  const bytes = Buffer.from("held");
  const metadata: BackpressuredOutputMetadata = { stream: "stdout", sequence: 1, startOffset: 0, endOffset: 4, byteLength: 4, digest: createHash("sha256").update(bytes).digest("hex") };
  writeFileSync(join(root, "channel/output/stdout-000000000001.json"), JSON.stringify({ nonce: "nonce", metadata, bytes: bytes.toString("base64") }));
  writeOutputCheckpoint(root);
  writeFileSync(join(root, "channel/client-state.json"), JSON.stringify({ nonce: "nonce", ownerId: fence.ownerId, fencingToken: fence.fencingToken, nextCommand: 1, nextWrite: 1, inputClosed: false }));
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 4, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => "live", effect: async (_kind, effect) => effect(), snapshot: immediateSnapshot }) });
  const channel = await provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence);
  const unsubscribe = channel.subscribeBackpressuredOutput(async (actual, actualBytes) => {
    entered = true;
    assert.deepEqual(actual, metadata);
    assert.equal(Buffer.from(actualBytes).toString(), "held");
    await barrier;
    return actual;
  });
  try {
    await waitFor(() => entered);
    assert.deepEqual(readdirSync(join(root, "channel/ack")), []);
    assert.equal(readdirSync(join(root, "channel/output")).length, 1);
    release();
    await waitFor(() => readdirSync(join(root, "channel/ack")).length === 1);
  } finally {
    release(); unsubscribe(); await channel.detach(); rmSync(root, { recursive: true, force: true });
  }
});

test("real portable channel preserves ordered duplex bytes and exact acknowledgement metadata", { timeout: 60_000 }, async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-channel-"));
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10, replayCapacityChunks: 2, replayCapacityBytes: 32 });
  const launch = parseProcessLaunchResult(await backend.launch(request([
    "-e",
    "process.stdin.on('data',b=>{process.stdout.write(b);process.stderr.write(Buffer.from(b).reverse())});process.stdin.on('end',()=>process.exit(0))",
  ])));
  const binding = bindingFor(launch);
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string; supervisorPid: number };
  const provider = backend.backpressuredChannelProvider();
  const channel = await provider.acquire(binding, fence);
  const seen: Array<{ metadata: BackpressuredOutputMetadata; bytes: Buffer }> = [];
  const unsubscribe = channel.subscribeBackpressuredOutput(async (metadata, bytes) => {
    seen.push({ metadata, bytes: Buffer.from(bytes) });
    return metadata;
  });
  try {
    for (const [sequence, text] of [[1, "abc"], [2, "def"]] as const) {
      const payload = Buffer.from(text);
      assert.deepEqual(await channel.write({
        sequence,
        byteLength: payload.byteLength,
        digest: createHash("sha256").update(payload).digest("hex"),
        timeoutMs: 2_000,
      }, payload), { acknowledged: true, sequence });
    }
    await channel.closeInput();
    const terminal = await channel.waitForTerminal() as { state: string };
    assert.equal(terminal.state, "exited");
    const supervisorState = JSON.parse(readFileSync(join(identity.directory, "state.json"), "utf8")) as {
      revision?: number;
      windowsTreeRefreshCount?: number;
      windowsTreeRefreshMinimumGapMs?: number | null;
    };
    assert.ok((supervisorState.windowsTreeRefreshCount ?? 0) >= 2, "fixture must observe multiple Windows tree refreshes");
    assert.ok((supervisorState.windowsTreeRefreshMinimumGapMs ?? 0) >= 250, "Windows tree refreshes must remain cadence bounded");
    assert.ok((supervisorState.revision ?? Number.POSITIVE_INFINITY) <= (supervisorState.windowsTreeRefreshCount ?? 0) + 12,
      "unchanged polling ticks must not churn the durable state file");
    await waitFor(() => seen.some((entry) => entry.metadata.stream === "stdout") && seen.some((entry) => entry.metadata.stream === "stderr"));
    assert.equal(Buffer.concat(seen.filter((entry) => entry.metadata.stream === "stdout").map((entry) => entry.bytes)).toString(), "abcdef");
    assert.equal(Buffer.concat(seen.filter((entry) => entry.metadata.stream === "stderr").map((entry) => entry.bytes)).toString(), "cbafed");
    for (const stream of ["stdout", "stderr"] as const) {
      const entries = seen.filter((entry) => entry.metadata.stream === stream);
      assert.deepEqual(entries.map((entry) => entry.metadata.sequence), entries.map((_, index) => index + 1));
      assert.ok(entries.every(({ metadata, bytes }) => metadata.byteLength === bytes.byteLength && metadata.digest === createHash("sha256").update(bytes).digest("hex")));
    }
  } finally {
    unsubscribe();
    await channel.detach();
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    await backend.release(binding, fence).catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("portable release refuses unsettled retained output until sink acknowledgement deletion is verified", { timeout: 60_000 }, async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-release-output-"));
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10 });
  const launch = parseProcessLaunchResult(await backend.launch(request(["-e", "process.stdout.write('retained')"])));
  const binding = bindingFor(launch);
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string; supervisorPid: number; supervisorBirth: string };
  try {
    await waitFor(() => readdirSync(join(identity.directory, "channel/output")).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    assert.ok(readdirSync(join(identity.directory, "channel/output")).length > 0, "retained output must survive delayed first channel claim");
    const channel = await backend.backpressuredChannelProvider().acquire(binding, fence);
    await assert.rejects(backend.release(binding, fence), /output.*unsettled|release.*refused/i);
    channel.subscribeBackpressuredOutput(async (metadata) => metadata);
    await waitFor(() => readdirSync(join(identity.directory, "channel/output")).length === 0 && readdirSync(join(identity.directory, "channel/ack")).length === 0);
    assert.equal((await channel.waitForTerminal() as { state: string }).state, "exited");
    await channel.detach();
    assert.deepEqual(await backend.release(binding, fence), { released: true });
  } finally {
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable release retries exact retired-authority cleanup without reopening an effect", { timeout: 60_000 }, async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-retired-cleanup-"));
  let removals = 0;
  const backend = new WindowsProcessBackend({
    stateDirectory: root,
    pollIntervalMs: 10,
    removeRetiredAuthority: (directory) => {
      removals += 1;
      if (removals === 1) throw new Error("injected retired authority deletion fault");
      rmSync(directory, { recursive: true, force: true });
    },
  });
  const launch = parseProcessLaunchResult(await backend.launch(request(["-e", "process.exit(0)"])));
  const binding = bindingFor(launch);
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string };
  const channel = await backend.backpressuredChannelProvider().acquire(binding, fence);
  try {
    channel.subscribeBackpressuredOutput(async (metadata) => metadata);
    assert.equal((await channel.waitForTerminal() as { state: string }).state, "exited");
    await channel.detach();
    assert.equal(parseProcessReconciliation(await backend.reconcile(binding, fence)).state, "exited");
    const empty = await backend.verifyEmpty(binding, fence) as { empty: boolean; proofArtifactId: string };
    assert.equal(empty.empty, true);
    assert.match(empty.proofArtifactId, /^native-empty:[0-9a-f]{48}$/);
    await assert.rejects(backend.release(binding, fence), /writer fence effect boundary is unavailable/);
    assert.equal(existsSync(identity.directory), true);
    assert.deepEqual(await backend.release(binding, fence), { released: true });
    assert.equal(removals, 2);
    assert.equal(existsSync(identity.directory), false);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("portable retained window backpressures output and replays it after exact reattach", { timeout: 60_000 }, async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-replay-"));
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10, replayCapacityChunks: 2, replayCapacityBytes: 32, operations: stateBackedWindowsFixtureOperations(root) });
  const launch = parseProcessLaunchResult(await backend.launch(request([
    "-e",
    "process.stdout.write('x'.repeat(96));process.stdin.resume();process.stdin.on('end',()=>process.exit(0))",
  ])));
  const binding = bindingFor(launch);
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string };
  const provider = backend.backpressuredChannelProvider();
  const first = await provider.acquire(binding, fence);
  try {
    await waitFor(() => readdirSync(join(identity.directory, "channel", "output")).some((name) => name.endsWith(".json")));
    const retained = readdirSync(join(identity.directory, "channel", "output")).filter((name) => name.endsWith(".json"));
    const retainedBytes = retained.reduce((total, name) => total + Buffer.from(JSON.parse(readFileSync(join(identity.directory, "channel", "output", name), "utf8")).bytes, "base64").byteLength, 0);
    assert.ok(retained.length <= 2);
    assert.ok(retainedBytes <= 32);
    await first.detach();

    const reattached = await provider.reattach(binding, fence);
    assert.ok(reattached.retainedWindow.length > 0);
    const replayed: Buffer[] = [];
    const unsubscribe = reattached.channel.subscribeBackpressuredOutput(async (metadata, bytes) => {
      if (metadata.stream === "stdout") replayed.push(Buffer.from(bytes));
      return metadata;
    });
    await reattached.channel.closeInput();
    const terminal = await reattached.channel.waitForTerminal() as { state: string; detail?: string };
    assert.equal(terminal.state, "exited", JSON.stringify(terminal));
    await waitFor(() => Buffer.concat(replayed).byteLength === 96);
    assert.equal(Buffer.concat(replayed).toString(), "x".repeat(96));
    unsubscribe();
    await reattached.channel.detach();
  } finally {
    await cleanupPortableBackendFixture(backend, binding, fence);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("portable control and channel acquisition reject a stale writer fence before effects", { timeout: 60_000 }, async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-stale-fence-"));
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10 });
  const launch = parseProcessLaunchResult(await backend.launch(request(["-e", "setInterval(()=>{},1000)"])));
  const binding = bindingFor(launch);
  const staleFence = { ownerId: fence.ownerId, fencingToken: fence.fencingToken - 1 };
  try {
    await assert.rejects(backend.signal(binding, "terminate", staleFence), /fence|identity/i);
    const identity = JSON.parse(Buffer.from(binding.opaqueIdentity, "base64url").toString("utf8"));
    identity.fence = staleFence;
    const staleBinding = { ...binding, opaqueIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url") };
    await assert.rejects(backend.backpressuredChannelProvider().acquire(staleBinding, staleFence), /birth|identity|fence/i);
  } finally {
    await cleanupPortableBackendFixture(backend, binding, fence);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("a higher portable writer fence atomically takes over and immediately revokes the old writer", { timeout: 60_000 }, async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-takeover-"));
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10 });
  const launch = parseProcessLaunchResult(await backend.launch(request(["-e", "process.stdin.resume();setInterval(()=>{},1000)"])));
  const binding = bindingFor(launch);
  const provider = backend.backpressuredChannelProvider();
  const oldChannel = await provider.acquire(binding, fence);
  const nextFence = { ownerId: "recovery-owner", fencingToken: fence.fencingToken + 1 };
  const recovered = await provider.reattach(binding, nextFence);
  const payload = Buffer.from("x");
  try {
    await assert.rejects(oldChannel.write({ sequence: 1, byteLength: 1, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 1_000 }, payload), /stale|fence|writer/i);
    assert.deepEqual(await recovered.channel.write({ sequence: recovered.nextSequence, byteLength: 1, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 5_000 }, payload), { acknowledged: true, sequence: recovered.nextSequence });
  } finally {
    await oldChannel.detach(); await recovered.channel.detach();
    await cleanupPortableBackendFixture(backend, binding, nextFence);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("portable signal paused before its effect cannot publish control after higher-fence takeover", { timeout: 60_000 }, async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-signal-effect-fence-"));
  let entered!: () => void; let resume!: () => void;
  const atBoundary = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { resume = resolve; });
  let hold = true;
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10, operations: stateBackedWindowsFixtureOperations(root), beforeFenceEffect: async (kind) => { if (kind === "signal" && hold) { hold = false; entered(); await barrier; } } });
  const launch = parseProcessLaunchResult(await backend.launch(request(["-e", "setInterval(()=>{},1000)"])));
  const binding = bindingFor(launch);
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string };
  const higher = { ownerId: "portable-recovery", fencingToken: fence.fencingToken + 1 };
  try {
    const stale = backend.signal(binding, "terminate", fence);
    await atBoundary;
    await backend.reconcile(binding, higher);
    resume();
    await assert.rejects(stale, /stale|fence|identity/i);
    assert.equal(readdirSync(identity.directory).includes("control.json"), false);
  } finally {
    resume();
    await cleanupPortableBackendFixture(backend, binding, higher);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("portable write paused before its effect cannot overwrite takeover state or publish input", { timeout: 60_000 }, async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-write-effect-fence-"));
  let entered!: () => void; let resume!: () => void;
  const atBoundary = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { resume = resolve; });
  let hold = true;
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10, beforeFenceEffect: async (kind) => { if (kind === "write" && hold) { hold = false; entered(); await barrier; } } });
  const launch = parseProcessLaunchResult(await backend.launch(request(["-e", "process.stdin.resume();setInterval(()=>{},1000)"])));
  const binding = bindingFor(launch);
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string };
  const provider = backend.backpressuredChannelProvider();
  const old = await provider.acquire(binding, fence);
  const payload = Buffer.from("stale");
  const stale = old.write({ sequence: 1, byteLength: payload.byteLength, digest: createHash("sha256").update(payload).digest("hex"), timeoutMs: 2_000 }, payload);
  await atBoundary;
  const higher = { ownerId: "portable-recovery", fencingToken: fence.fencingToken + 1 };
  const recovered = await provider.acquire(binding, higher);
  const takeoverState = readFileSync(join(identity.directory, "channel", "client-state.json"), "utf8");
  resume();
  try {
    await assert.rejects(stale, /stale|fence|identity/i);
    assert.deepEqual(readdirSync(join(identity.directory, "channel", "input")), []);
    assert.equal(readFileSync(join(identity.directory, "channel", "client-state.json"), "utf8"), takeoverState);
  } finally {
    resume(); await old.detach(); await recovered.detach();
    await cleanupPortableBackendFixture(backend, binding, higher);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
    assert.equal(existsSync(root), false);
  }
});

test("portable takeover reports one truthful outcome for published input and advances to token2 command", { timeout: 60_000 }, async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-published-stale-input-"));
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 1_000 });
  const launch = parseProcessLaunchResult(await backend.launch(request(["-e", "process.stdin.on('data',b=>process.stdout.write('seen:'+b));process.stdin.on('end',()=>process.exit(0))"])));
  const binding = bindingFor(launch);
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as {
    directory: string;
    supervisorPid: number;
    supervisorBirth: string;
  };
  const provider = backend.backpressuredChannelProvider(); const old = await provider.acquire(binding, fence);
  const higher = { ownerId: "portable-recovery", fencingToken: fence.fencingToken + 1 };
  let recovered: Awaited<ReturnType<typeof provider.acquire>> | undefined;
  try {
    const staleBytes = Buffer.from("stale\n");
    const stale = old.write({ sequence: 1, byteLength: staleBytes.byteLength, digest: createHash("sha256").update(staleBytes).digest("hex"), timeoutMs: 5_000 }, staleBytes).then(
      () => ({ status: "acknowledged" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await waitFor(() => portableInputPublished(identity.directory));
    recovered = await provider.acquire(binding, higher);
    const output: Buffer[] = [];
    recovered.subscribeBackpressuredOutput(async (metadata, bytes) => { output.push(Buffer.from(bytes)); return metadata; });
    const freshBytes = Buffer.from("fresh\n");
    const staleOutcome = await stale;
    if (staleOutcome.status === "rejected") assert.match(String(staleOutcome.error), /failed|stale|fence|rejected/i);
    assert.deepEqual(await recovered.write({ sequence: 2, byteLength: freshBytes.byteLength, digest: createHash("sha256").update(freshBytes).digest("hex"), timeoutMs: 5_000 }, freshBytes), { acknowledged: true, sequence: 2 });
    await recovered.closeInput(); await recovered.waitForTerminal();
    const seen = Buffer.concat(output).toString();
    assert.equal(seen, staleOutcome.status === "acknowledged" ? "seen:stale\nseen:fresh\n" : "seen:fresh\n");
  } finally {
    await old.detach(); await recovered?.detach();
    await cleanupPortableBackendFixture(backend, binding, higher);
    await removeSettledPortableTestRoot(root, identity.supervisorPid, identity.supervisorBirth);
  }
});

test("portable output acknowledgement paused after sink success cannot delete bytes after takeover", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-output-effect-fence-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  const bytes = Buffer.from("held");
  const metadata: BackpressuredOutputMetadata = { stream: "stdout", sequence: 1, startOffset: 0, endOffset: 4, byteLength: 4, digest: createHash("sha256").update(bytes).digest("hex") };
  writeFileSync(join(root, "channel/output/stdout-000000000001.json"), JSON.stringify({ nonce: "nonce", metadata, bytes: bytes.toString("base64") }));
  writeOutputCheckpoint(root);
  writeFileSync(join(root, "channel/client-state.json"), JSON.stringify({ nonce: "nonce", ownerId: fence.ownerId, fencingToken: fence.fencingToken, nextCommand: 1, nextWrite: 1, inputClosed: false }));
  let current: { ownerId: string; fencingToken: number } = { ...fence };
  let entered!: () => void; let resume!: () => void;
  const atBoundary = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { resume = resolve; });
  const provider = createPortableProcessChannelProvider({
    replayCapacityChunks: 1, replayCapacityBytes: 4, pollIntervalMs: 5,
    authority: () => ({
      directory: root, nonce: "nonce", fence, reattest: () => "live",
      effect: async (kind, effect) => {
        if (kind === "output_ack") { entered(); await barrier; }
        if (current.ownerId !== fence.ownerId || current.fencingToken !== fence.fencingToken) throw new Error("stale fence at effect boundary");
        return effect();
      },
      snapshot: immediateSnapshot,
    }),
  });
  const channel = await provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence);
  channel.subscribeBackpressuredOutput(async (actual) => actual);
  try {
    await atBoundary;
    current = { ownerId: "recovery", fencingToken: fence.fencingToken + 1 };
    const takeoverState = JSON.stringify({ nonce: "nonce", ...current, nextCommand: 1, nextWrite: 1, inputClosed: false });
    writeFileSync(join(root, "channel/client-state.json"), takeoverState);
    resume();
    await channel.detach();
    assert.deepEqual(readdirSync(join(root, "channel/ack")), []);
    assert.equal(readdirSync(join(root, "channel/output")).length, 1);
    assert.equal(readFileSync(join(root, "channel/client-state.json"), "utf8"), takeoverState);
  } finally { resume(); await channel.detach(); rmSync(root, { recursive: true, force: true }); }
});

test("portable detach waits for a held sink and leaves its bytes unacknowledged for reattach", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-detach-held-sink-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  const bytes = Buffer.from("held");
  const metadata: BackpressuredOutputMetadata = { stream: "stdout", sequence: 1, startOffset: 0, endOffset: 4, byteLength: 4, digest: createHash("sha256").update(bytes).digest("hex") };
  writeFileSync(join(root, "channel/output/stdout-000000000001.json"), JSON.stringify({ nonce: "nonce", metadata, bytes: bytes.toString("base64") }));
  writeOutputCheckpoint(root);
  writeFileSync(join(root, "channel/client-state.json"), JSON.stringify({ nonce: "nonce", ownerId: fence.ownerId, fencingToken: fence.fencingToken, nextCommand: 1, nextWrite: 1, inputClosed: false }));
  let entered!: () => void; let resume!: () => void;
  const atSink = new Promise<void>((resolve) => { entered = resolve; }); const held = new Promise<void>((resolve) => { resume = resolve; });
  const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 8, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => "live", effect: async (_kind, effect) => effect(), snapshot: immediateSnapshot }) });
  const binding = bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" });
  const first = await provider.acquire(binding, fence);
  first.subscribeBackpressuredOutput(async (actual) => { entered(); await held; return actual; });
  await atSink; const detached = first.detach(); resume(); await detached;
  try {
    assert.deepEqual(readdirSync(join(root, "channel/ack")), []);
    const second = await provider.acquire(binding, fence);
    second.subscribeBackpressuredOutput(async (actual) => actual);
    await waitFor(() => readdirSync(join(root, "channel/ack")).length === 1);
    await second.detach();
  } finally { resume(); await first.detach(); rmSync(root, { recursive: true, force: true }); }
});

test("portable release paused before deletion preserves the complete root after takeover", { timeout: 60_000 }, async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-release-effect-fence-"));
  let entered!: () => void; let resume!: () => void;
  const atBoundary = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { resume = resolve; });
  let hold = true;
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10, beforeFenceEffect: async (kind) => { if (kind === "release" && hold) { hold = false; entered(); await barrier; } } });
  const launch = parseProcessLaunchResult(await backend.launch(request(["-e", "process.exit(0)"])));
  const binding = bindingFor(launch);
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string };
  await backend.observe(binding, async () => undefined, fence);
  const stale = backend.release(binding, fence);
  await atBoundary;
  const higher = { ownerId: "portable-recovery", fencingToken: fence.fencingToken + 1 };
  await backend.reconcile(binding, higher);
  resume();
  try {
    await assert.rejects(stale, /stale|fence|identity/i);
    assert.equal(readFileSync(join(identity.directory, "state.json"), "utf8").length > 0, true);
    assert.deepEqual(await backend.release(binding, higher), { released: true });
  } finally {
    resume();
    await backend.signal(binding, "force_terminate", higher).catch(() => undefined);
    await backend.release(binding, higher).catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

test("portable empty proof paused at its final fence cannot survive higher-fence takeover", { timeout: 60_000 }, async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-empty-effect-fence-"));
  let entered!: () => void; let resume!: () => void;
  const atBoundary = new Promise<void>((resolve) => { entered = resolve; });
  const barrier = new Promise<void>((resolve) => { resume = resolve; });
  let hold = true;
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10, beforeFenceEffect: async (kind) => { if (kind === "verify_empty" && hold) { hold = false; entered(); await barrier; } } });
  const launch = parseProcessLaunchResult(await backend.launch(request(["-e", "process.exit(0)"])));
  const binding = bindingFor(launch);
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { supervisorPid: number; supervisorBirth: string };
  await backend.observe(binding, async () => undefined, fence);
  const stale = backend.verifyEmpty(binding, fence);
  await atBoundary;
  const higher = { ownerId: "portable-recovery", fencingToken: fence.fencingToken + 1 };
  await backend.reconcile(binding, higher);
  resume();
  try {
    assert.equal((await stale as { empty: boolean }).empty, false);
    assert.equal((await backend.verifyEmpty(binding, higher) as { empty: boolean }).empty, true);
  } finally {
    resume(); await backend.release(binding, higher).catch(() => undefined);
    await removeSettledPortableTestRoot(root, identity.supervisorPid, identity.supervisorBirth);
  }
});

test("portable release refuses a live supervisor even when membership is empty", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-live-empty-release-"));
  console.log(JSON.stringify({ created: root }));
  const identityDirectory = join(root, "identity");
  for (const path of [identityDirectory, join(identityDirectory, "channel/output"), join(identityDirectory, "channel/input"), join(identityDirectory, "channel/ack")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(identityDirectory, "state.json"), JSON.stringify({ protocol: "aiboard-portable-process/v1", nonce: "fixture-nonce", supervisorPid: 9001, revision: 1, handledControl: 0, status: "running", exitCode: null, signal: null, launchEffect: "not_started", rootProcess: null, knownProcesses: [], error: null }));
  writeFileSync(join(identityDirectory, "channel/output-checkpoint.json"), JSON.stringify({ nonce: "fixture-nonce", stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 } }));
  for (const stream of ["stdout", "stderr"]) writeFileSync(join(identityDirectory, `${stream}.log`), "");
  const operations = { inspectProcessBirth: () => ({ state: "present" as const, fingerprint: "fixture-birth" }), listPosixGroup: () => undefined, signal: () => undefined };
  const backend = new WindowsProcessBackend({ stateDirectory: root, operations });
  const opaque = { version: 1, backendId: "runner-windows-supervisor-v1", nonce: "fixture-nonce", directory: identityDirectory, supervisorPid: 9001, supervisorBirth: "fixture-birth" };
  const binding = bindingFor({ opaqueIdentity: Buffer.from(JSON.stringify(opaque)).toString("base64url"), birthFingerprint: { observedAt: "now", discriminator: createHash("sha256").update("fixture-nonce\0fixture-birth").digest("hex") }, rootPid: 9001, startedAt: "now" });
  try {
    await assert.rejects(backend.release(binding, fence), /terminal|stopped/i);
    assert.equal(existsSync(identityDirectory), true);
  } finally { rmSync(root, { recursive: true, force: true }); console.log(JSON.stringify({ removed: root, absent: !existsSync(root) })); }
});

test("portable reconcile and release reject corrupt acknowledgement evidence", { timeout: 60_000 }, async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-release-corrupt-ack-"));
  const exitGate = join(root, "target-exit");
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10 });
  const launch = parseProcessLaunchResult(await backend.launch(request(["-e", `
    const fs = require("node:fs");
    const gate = process.argv[1];
    const waiter = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(gate) && Date.now() < deadline) Atomics.wait(waiter, 0, 0, 10);
    process.exit(fs.existsSync(gate) ? 0 : 1);
  `, exitGate])));
  const binding = bindingFor(launch);
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string; nonce: string; supervisorPid: number; supervisorBirth: string };
  const statePath = join(identity.directory, "state.json");
  const lockScript = "$ErrorActionPreference='Stop';$s=[IO.File]::Open($env:AIBOARD_TEST_LOCK_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite);try{[Console]::Out.WriteLine('LOCKED');[Threading.Thread]::Sleep([int]$env:AIBOARD_TEST_LOCK_MS)}finally{$s.Dispose()}";
  const holder = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", lockScript], {
    env: { ...fixtureEnvironment(), AIBOARD_TEST_LOCK_PATH: statePath, AIBOARD_TEST_LOCK_MS: "1500" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await waitForChildText(holder, "LOCKED");
    writeFileSync(exitGate, "exit");
    await waitFor(() => JSON.parse(readFileSync(statePath, "utf8")).status === "stopped", 10_000);
    await waitForChildExit(holder);
    assert.equal(readdirSync(identity.directory).some((name) => name === `state.json.${identity.supervisorPid}.tmp`), false,
      "a transient destination lock must not strand the supervisor's atomic state publication");
    writeFileSync(join(identity.directory, "channel", "ack", "corrupt.json"), "{}");
    assert.deepEqual(await backend.reconcile(binding, fence), { state: "outcome_unknown" });
    await assert.rejects(backend.release(binding, fence), /acknowledgement|evidence|output/i);
    assert.equal(existsSync(identity.directory), true);
  } finally {
    if (holder.exitCode === null) holder.kill();
    await waitForChildExit(holder).catch(() => undefined);
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    await backend.release(binding, fence).catch(() => undefined);
    await removePortableTestRootAfterExactOwnerAbsence(root, identity.directory, identity.nonce, identity.supervisorPid, identity.supervisorBirth);
  }
});

test("portable publication cleanup preserves unknown owner identity", async () => {
  if (process.platform !== "win32") return;
  const fixture = portableCleanupFixture("unknown-owner");
  try {
    await assert.rejects(removePortableTestRootAfterExactOwnerAbsence(
      fixture.root, fixture.directory, fixture.nonce, fixture.supervisorPid, fixture.supervisorBirth,
      { inspectBirth: () => ({ state: "unknown" }) },
    ), /unknown|uncertain|unavailable/i);
    assert.equal(existsSync(fixture.root), true);
  } finally { rmSync(fixture.root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("portable publication cleanup preserves unreadable durable state", async () => {
  if (process.platform !== "win32") return;
  const fixture = portableCleanupFixture("unreadable-state");
  writeFileSync(join(fixture.directory, "state.json"), "{");
  try {
    await assert.rejects(removePortableTestRootAfterExactOwnerAbsence(
      fixture.root, fixture.directory, fixture.nonce, fixture.supervisorPid, fixture.supervisorBirth,
      { inspectBirth: () => ({ state: "absent" }) },
    ), /state|unreadable|invalid|uncertain/i);
    assert.equal(existsSync(fixture.root), true);
  } finally { rmSync(fixture.root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("portable publication cleanup preserves a root that reappears after removal", async () => {
  if (process.platform !== "win32") return;
  const fixture = portableCleanupFixture("late-reappearance");
  try {
    await assert.rejects(removePortableTestRootAfterExactOwnerAbsence(
      fixture.root, fixture.directory, fixture.nonce, fixture.supervisorPid, fixture.supervisorBirth,
      { inspectBirth: () => ({ state: "absent" }), afterRemoval: () => mkdirSync(fixture.root, { recursive: true }) },
    ), /reappear|remain absent|uncertain/i);
    assert.equal(existsSync(fixture.root), true);
  } finally { rmSync(fixture.root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 }); }
});

test("portable supervisor reserves adaptive atomic replacement for durable state", () => {
  const source = readFileSync(new URL("../src/portable-process-supervisor.mjs", import.meta.url), "utf8");
  assert.match(source, /function writeAtomic[\s\S]*?replaceAtomic\(temporary, destination, ATOMIC_WRITE_MAX_RETRY_MS\);[\s\S]*?\n}/);
  assert.match(source, /function publish[\s\S]*?replaceAtomic\(temporary, statePath, STATE_PUBLICATION_MAX_RETRY_MS\);[\s\S]*?\n}/);
});

test("portable final effects fail closed when durable fence evidence disappears", { timeout: 60_000 }, async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-missing-fence-"));
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10 });
  const launch = parseProcessLaunchResult(await backend.launch(request(["-e", "process.exit(0)"])));
  const binding = bindingFor(launch);
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string; supervisorPid: number; supervisorBirth: string };
  await backend.observe(binding, async () => undefined, fence);
  unlinkSync(join(identity.directory, "fence.json"));
  try {
    await assert.rejects(backend.release(binding, fence), /fence.*invalid|identity/i);
    assert.equal(existsSync(identity.directory), true);
  } finally {
    await removeSettledPortableTestRoot(root, identity.supervisorPid, identity.supervisorBirth);
  }
});

test("portable terminal and release fail closed after owned output evidence disappears", { timeout: 60_000 }, async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-missing-terminal-output-"));
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10 });
  const launch = parseProcessLaunchResult(await backend.launch(request(["-e", "process.exit(0)"])));
  const binding = bindingFor(launch);
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string; supervisorPid: number; supervisorBirth: string };
  await waitFor(() => JSON.parse(readFileSync(join(identity.directory, "state.json"), "utf8")).status === "stopped", 15_000);
  rmSync(join(identity.directory, "channel", "output"), { recursive: true, force: true });
  try {
    assert.deepEqual(await backend.reconcile(binding, fence), { state: "outcome_unknown" });
    await assert.rejects(backend.release(binding, fence), /output|evidence|missing|unreadable/i);
    assert.equal(existsSync(identity.directory), true);
  } finally { await removeSettledPortableTestRoot(root, identity.supervisorPid, identity.supervisorBirth); }
});

test("portable acquire fails closed on a corrupt retained filename, nonce, metadata, digest, or payload", { timeout: 60_000 }, async (t) => {
  for (const fault of ["filename", "nonce", "sequence", "offset", "digest", "payload"] as const) {
    await t.test(fault, async () => {
      const root = mkdtempSync(join(tmpdir(), "aiboard-portable-corrupt-"));
      for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
      const bytes = Buffer.from("held");
      const metadata: BackpressuredOutputMetadata = { stream: "stdout", sequence: fault === "sequence" ? 2 : 1, startOffset: fault === "offset" ? 1 : 0, endOffset: 4, byteLength: 4, digest: fault === "digest" ? "0".repeat(64) : createHash("sha256").update(bytes).digest("hex") };
      const name = fault === "filename" ? "malformed.json" : "stdout-000000000001.json";
      writeFileSync(join(root, "channel/output", name), JSON.stringify({ nonce: fault === "nonce" ? "wrong" : "nonce", metadata, bytes: (fault === "payload" ? Buffer.from("evil") : bytes).toString("base64") }));
      writeOutputCheckpoint(root);
      writeFileSync(join(root, "channel/client-state.json"), JSON.stringify({ nonce: "nonce", ownerId: fence.ownerId, fencingToken: fence.fencingToken, nextCommand: 1, nextWrite: 1, inputClosed: false }));
      writeFileSync(join(root, "channel/fence.json"), JSON.stringify({ nonce: "nonce", ownerId: fence.ownerId, fencingToken: fence.fencingToken }));
      const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 8, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => "live", effect: async (_kind, effect) => effect(), snapshot: immediateSnapshot }) });
      try {
        await assert.rejects(provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence), /output|corrupt|invalid|continu/i);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});

test("portable acquire fails closed when owned output, acknowledgement, or checkpoint evidence is missing", async () => {
  for (const missing of ["output", "ack", "output-checkpoint.json"] as const) {
    const root = mkdtempSync(join(tmpdir(), `aiboard-portable-missing-${missing.replace(/\W/g, "-")}-`));
    for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
    writeFileSync(join(root, "channel/client-state.json"), JSON.stringify({ nonce: "nonce", ownerId: fence.ownerId, fencingToken: fence.fencingToken, nextCommand: 1, nextWrite: 1, inputClosed: false }));
    writeOutputCheckpoint(root);
    const target = join(root, "channel", missing);
    if (missing.endsWith(".json")) unlinkSync(target); else rmSync(target, { recursive: true, force: true });
    const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 8, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => "live", effect: async (_kind, effect) => effect(), snapshot: immediateSnapshot }) });
    try {
      await assert.rejects(provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence), /output|acknowledgement|checkpoint|missing|invalid/i);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test("portable acquire rejects malformed acknowledgement evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-malformed-ack-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  const bytes = Buffer.from("held");
  const metadata: BackpressuredOutputMetadata = { stream: "stdout", sequence: 1, startOffset: 0, endOffset: 4, byteLength: 4, digest: createHash("sha256").update(bytes).digest("hex") };
  writeFileSync(join(root, "channel/output/stdout-000000000001.json"), JSON.stringify({ nonce: "nonce", metadata, bytes: bytes.toString("base64") }));
  writeFileSync(join(root, "channel/ack/stdout-000000000001.json"), "{not-json");
  writeFileSync(join(root, "channel/client-state.json"), JSON.stringify({ nonce: "nonce", ownerId: fence.ownerId, fencingToken: fence.fencingToken, nextCommand: 1, nextWrite: 1, inputClosed: false }));
  writeOutputCheckpoint(root);
  const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 8, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => "exited", effect: async (_kind, effect) => effect(), snapshot: immediateSnapshot }) });
  try {
    await assert.rejects(provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence), /acknowledgement|invalid|malformed/i);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("portable channel terminal becomes outcome unknown when output evidence disappears after acquire", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-terminal-missing-output-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "channel/client-state.json"), JSON.stringify({ nonce: "nonce", ownerId: fence.ownerId, fencingToken: fence.fencingToken, nextCommand: 1, nextWrite: 1, inputClosed: true }));
  writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status: "stopped", exitCode: 0, signal: null }));
  writeOutputCheckpoint(root);
  const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 8, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => "exited", effect: async (_kind, effect) => effect(), snapshot: immediateSnapshot }) });
  const channel = await provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence);
  rmSync(join(root, "channel", "output"), { recursive: true, force: true });
  try {
    assert.deepEqual(await Promise.race([channel.waitForTerminal(), new Promise((_, reject) => setTimeout(() => reject(new Error("terminal evidence validation timed out")), 250))]), { state: "outcome_unknown" });
  } finally { await channel.detach(); rmSync(root, { recursive: true, force: true }); }
});

test("portable terminal validates but does not misclassify a durable input acknowledgement as unsettled output", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-terminal-input-ack-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "channel/ack/input-000000000001.json"), JSON.stringify({ nonce: "nonce", ownerId: fence.ownerId, fencingToken: fence.fencingToken, sequence: 1, status: "acknowledged" }));
  writeFileSync(join(root, "channel/client-state.json"), JSON.stringify({ nonce: "nonce", ownerId: fence.ownerId, fencingToken: fence.fencingToken, nextCommand: 2, nextWrite: 2, inputClosed: true }));
  writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status: "stopped", exitCode: 0, signal: null })); writeOutputCheckpoint(root);
  const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 8, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => "exited", effect: async (_kind, effect) => effect(), snapshot: immediateSnapshot }) });
  const channel = await provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence);
  try { assert.deepEqual(await channel.waitForTerminal(), { state: "exited", exitCode: 0 }); }
  finally { await channel.detach(); rmSync(root, { recursive: true, force: true }); }
});

test("portable terminal cannot return clean exit after ownership changes during evidence reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-terminal-takeover-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "channel/client-state.json"), JSON.stringify({ nonce: "nonce", ownerId: fence.ownerId, fencingToken: fence.fencingToken, nextCommand: 1, nextWrite: 1, inputClosed: true }));
  writeFileSync(join(root, "state.json"), JSON.stringify({ nonce: "nonce", status: "stopped", exitCode: 0, signal: null })); writeOutputCheckpoint(root);
  let checks = 0;
  const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 8, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => { checks += 1; if (checks >= 3) throw new Error("writer fence changed"); return "exited"; }, effect: async (_kind, effect) => effect(), snapshot: immediateSnapshot }) });
  const channel = await provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence);
  try { assert.deepEqual(await channel.waitForTerminal(), { state: "outcome_unknown" }); }
  finally { await channel.detach(); rmSync(root, { recursive: true, force: true }); }
});

const fence = { ownerId: "portable-channel-owner", fencingToken: 7 } as const;
function immediateSnapshot<T>(read: () => T) { return { status: "applied" as const, value: read() }; }
function request(args: string[]) {
  return {
    intent: { invocationId: "portable-channel", runId: "run", kind: "command" as const, executable: process.execPath, arguments: args, workingDirectory: process.cwd(), requestedCapabilities: ["tree_termination"] as const },
    grant: { grantId: "grant", runId: "run", invocationId: "portable-channel", issuedAt: new Date().toISOString(), access: [] },
    environment: fixtureEnvironment(), outputOwnerId: "output", fence,
  };
}
function fixtureEnvironment(): Record<string, string> {
  const allowed = new Set(["systemroot", "windir", "comspec", "path", "pathext", "temp", "tmp"]);
  return Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.has(key.toLowerCase()) && value !== undefined)) as Record<string, string>;
}
function stateBackedWindowsFixtureOperations(root: string) {
  return {
    inspectProcessBirth(pid: number) {
      for (const entry of readdirSync(root)) {
        try {
          const state = JSON.parse(readFileSync(join(root, entry, "state.json"), "utf8")) as { status: string; supervisorPid: number; knownProcesses: Array<{ pid: number; birth: string }> };
          if (state.supervisorPid === pid) return processIsAlive(pid)
            ? { state: "present" as const, fingerprint: "fixture-supervisor-birth" }
            : { state: "absent" as const };
          const known = state.knownProcesses.find((candidate) => candidate.pid === pid);
          if (known) return state.status === "stopped" || !processIsAlive(pid) ? { state: "absent" as const } : { state: "present" as const, fingerprint: known.birth };
        } catch {}
      }
      return processIsAlive(pid) ? { state: "present" as const, fingerprint: "fixture-supervisor-birth" } : { state: "absent" as const };
    },
    listPosixGroup: () => undefined,
    signal: () => undefined,
  };
}
function processIsAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
async function removeSettledPortableTestRoot(root: string, supervisorPid: number, supervisorBirth: string): Promise<void> {
  const resolvedRoot = resolve(root);
  if (dirname(resolvedRoot) !== resolve(tmpdir()) || !basename(resolvedRoot).startsWith("aiboard-portable-"))
    throw new Error("Portable test cleanup target is outside its exact temporary namespace.");
  const ownerDeadline = Date.now() + 10_000;
  for (;;) {
    const observed = inspectWindowsTestBirth(supervisorPid);
    if (observed.state === "absent" || observed.state === "present" && !sameTestBirth(observed.birth, supervisorBirth)) break;
    if (Date.now() >= ownerDeadline) throw new Error("Portable test supervisor did not become exactly absent before cleanup.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  for (const entry of existsSync(resolvedRoot) ? readdirSync(resolvedRoot, { withFileTypes: true }) : []) {
    if (!entry.isDirectory()) continue;
    const statePath = join(resolvedRoot, entry.name, "state.json");
    if (!existsSync(statePath)) continue;
    const state = JSON.parse(readFileSync(statePath, "utf8")) as { status?: unknown };
    if (state.status !== "stopped") throw new Error("Portable test cleanup requires durable stopped evidence.");
  }
  const cleanupDeadline = Date.now() + 2_000;
  let absentSince: number | undefined;
  while (Date.now() < cleanupDeadline) {
    if (existsSync(resolvedRoot)) {
      rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
      absentSince = undefined;
    } else {
      absentSince ??= Date.now();
      if (Date.now() - absentSince >= 100) return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("Portable test root did not remain absent after exact cleanup.");
}
function inspectWindowsTestBirth(pid: number): { state: "absent" } | { state: "present"; birth: string } | { state: "unknown" } {
  try {
    const script = `$ErrorActionPreference='Stop';$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue;if($null-eq$p){'ABSENT'}else{'PRESENT:'+$p.StartTime.ToUniversalTime().ToString('o')}`;
    const value = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, timeout: 5_000,
    }).trim();
    if (value === "ABSENT") return { state: "absent" };
    if (value.startsWith("PRESENT:") && value.length > "PRESENT:".length) return { state: "present", birth: value.slice("PRESENT:".length) };
  } catch {}
  return { state: "unknown" };
}
function sameTestBirth(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/(\.\d{6})\d+(Z)$/, "$1$2");
  return normalize(left) === normalize(right);
}
async function cleanupPortableBackendFixture(
  backend: WindowsProcessBackend,
  binding: ProcessBackendBinding,
  cleanupFence: ProcessEffectFence,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  let last = "cleanup not attempted";
  while (Date.now() < deadline) {
    try { await backend.signal(binding, "force_terminate", cleanupFence); } catch (error) { last = String(error); }
    const observation = parseProcessReconciliation(await backend.reconcile(binding, cleanupFence));
    last = observation.state;
    if (observation.state === "identity_mismatch") throw new Error("Portable fixture cleanup lost exact ownership.");
    if (observation.state === "exited") {
      await backend.release(binding, cleanupFence);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Portable fixture cleanup did not reach durable terminal state: ${last}`);
}
function bindingFor(launch: ReturnType<typeof parseProcessLaunchResult>): ProcessBackendBinding {
  return { registryId: "registry", backendId: "runner-windows-supervisor-v1", implementationGeneration: "generation", implementationDigest: "1".repeat(64), attestationVersion: 1, attestationDigest: "2".repeat(64), ...launch };
}
async function waitFor(predicate: () => boolean, deadlineMs = 5_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("portable output did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function portableInputPublished(directory: string): boolean {
  const input = join(directory, "channel", "input", "input-000000000001.json");
  if (existsSync(input)) return true;
  try {
    const state = JSON.parse(readFileSync(join(directory, "channel", "client-state.json"), "utf8")) as {
      nextCommand?: unknown;
      nextWrite?: unknown;
    };
    if (state.nextCommand === 2 && state.nextWrite === 2) return true;
  } catch {}
  return existsSync(join(directory, "channel", "ack", "input-000000000001.json"));
}
async function waitForChildText(child: ChildProcess, expected: string, deadlineMs = 5_000): Promise<void> {
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  await waitFor(() => stdout.includes(expected) || child.exitCode !== null, deadlineMs);
  if (!stdout.includes(expected)) throw new Error(`file-lock helper exited before readiness: ${stderr}`);
}
async function waitForChildExit(child: ChildProcess, deadlineMs = 5_000): Promise<void> {
  await waitFor(() => child.exitCode !== null, deadlineMs);
}
type PortableCleanupBirth = { state: "absent" } | { state: "present"; birth: string } | { state: "unknown" };
interface PortableCleanupOptions {
  readonly inspectBirth?: (pid: number) => PortableCleanupBirth;
  readonly afterRemoval?: () => void;
}
async function removePortableTestRootAfterExactOwnerAbsence(
  root: string,
  directory: string,
  nonce: string,
  supervisorPid: number,
  supervisorBirth: string,
  options: PortableCleanupOptions = {},
): Promise<void> {
  const resolvedRoot = resolve(root);
  if (dirname(resolvedRoot) !== resolve(tmpdir()) || !basename(resolvedRoot).startsWith("aiboard-portable-release-corrupt-ack-"))
    throw new Error("Portable publication test cleanup target is outside its exact temporary namespace.");
  const resolvedDirectory = resolve(directory);
  if (dirname(resolvedDirectory) !== resolvedRoot || !basename(resolvedDirectory).startsWith("owned-") ||
      !/^[0-9a-f]{48}$/i.test(nonce) || !Number.isSafeInteger(supervisorPid) || supervisorPid < 1 || !supervisorBirth)
    throw new Error("Portable publication test cleanup identity is invalid or unauthenticated.");
  const rootIdentity = portableCleanupDirectoryIdentity(resolvedRoot);
  const directoryIdentity = portableCleanupDirectoryIdentity(resolvedDirectory);
  const inspectBirth = options.inspectBirth ?? inspectWindowsTestBirth;
  const authenticatedIdentities = new Map<number, string>([[supervisorPid, supervisorBirth]]);
  const deadline = Date.now() + 10_000;
  let exactlyAbsentSince: number | undefined;
  for (;;) {
    assertPortableCleanupDirectoryIdentity(resolvedRoot, rootIdentity);
    assertPortableCleanupDirectoryIdentity(resolvedDirectory, directoryIdentity);
    for (const identity of authenticatedPortableCleanupIdentities(
      resolvedRoot, resolvedDirectory, nonce, supervisorPid, supervisorBirth,
    )) {
      const prior = authenticatedIdentities.get(identity.pid);
      if (prior !== undefined && !sameTestBirth(prior, identity.birth))
        throw new Error("Portable publication test cleanup observed conflicting durable process identities.");
      authenticatedIdentities.set(identity.pid, identity.birth);
    }
    let exactLive = false;
    for (const [pid, birth] of authenticatedIdentities) {
      const observed = inspectBirth(pid);
      if (observed.state === "unknown")
        throw new Error("Portable publication test cleanup process identity is unknown or unavailable.");
      if (observed.state === "present" && sameTestBirth(observed.birth, birth)) exactLive = true;
    }
    if (!exactLive) {
      exactlyAbsentSince ??= Date.now();
      if (Date.now() - exactlyAbsentSince >= 200) break;
    } else exactlyAbsentSince = undefined;
    if (Date.now() >= deadline) throw new Error("Portable publication test retained an exact owned process.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  assertPortableCleanupDirectoryIdentity(resolvedRoot, rootIdentity);
  assertPortableCleanupDirectoryIdentity(resolvedDirectory, directoryIdentity);
  rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  options.afterRemoval?.();
  const settleDeadline = Date.now() + 200;
  while (Date.now() < settleDeadline) {
    if (existsSync(resolvedRoot))
      throw new Error("Portable publication test root reappeared and did not remain absent after exact cleanup.");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
}
interface PortableCleanupDirectoryIdentity { readonly device: string; readonly inode: string; readonly birth: string }
function portableCleanupDirectoryIdentity(path: string): PortableCleanupDirectoryIdentity {
  const status = lstatSync(path, { bigint: true });
  if (!status.isDirectory() || status.isSymbolicLink())
    throw new Error("Portable publication test cleanup directory is linked, replaced, or invalid.");
  return { device: status.dev.toString(), inode: status.ino.toString(), birth: status.birthtimeNs.toString() };
}
function assertPortableCleanupDirectoryIdentity(path: string, expected: PortableCleanupDirectoryIdentity): void {
  const current = portableCleanupDirectoryIdentity(path);
  if (current.device !== expected.device || current.inode !== expected.inode || current.birth !== expected.birth)
    throw new Error("Portable publication test cleanup directory identity changed or became uncertain.");
}
function authenticatedPortableCleanupIdentities(
  root: string,
  directory: string,
  nonce: string,
  supervisorPid: number,
  supervisorBirth: string,
): Array<{ pid: number; birth: string }> {
  if (!existsSync(root) || !existsSync(directory))
    throw new Error("Portable publication test durable state is unavailable before cleanup.");
  const ownedDirectories = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  if (ownedDirectories.length !== 1 || resolve(root, ownedDirectories[0]!.name) !== directory)
    throw new Error("Portable publication test cleanup directory is unauthenticated or ambiguous.");
  if (readdirSync(directory).some((name) => /^state\.json\.\d+\.tmp$/.test(name)))
    throw new Error("Portable publication test state publication remains uncertain.");
  let state: {
    protocol?: unknown;
    nonce?: unknown;
    supervisorPid?: unknown;
    status?: unknown;
    rootProcess?: unknown;
    knownProcesses?: unknown;
  };
  try { state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8")); }
  catch (error) { throw new Error("Portable publication test durable state is unreadable or invalid.", { cause: error }); }
  if (state.protocol !== "aiboard-portable-process/v1" || state.nonce !== nonce ||
      state.supervisorPid !== supervisorPid || state.status !== "stopped" || !Array.isArray(state.knownProcesses))
    throw new Error("Portable publication test durable state is unauthenticated or incomplete.");
  const identities: Array<{ pid: number; birth: string }> = [{ pid: supervisorPid, birth: supervisorBirth }];
  if (state.rootProcess !== null && state.rootProcess !== undefined) identities.push(assertPortableCleanupIdentity(state.rootProcess));
  for (const identity of state.knownProcesses) identities.push(assertPortableCleanupIdentity(identity));
  return identities;
}
function assertPortableCleanupIdentity(value: unknown): { pid: number; birth: string } {
  const identity = value as { pid?: unknown; birth?: unknown };
  if (!identity || !Number.isSafeInteger(identity.pid) || Number(identity.pid) < 1 ||
      typeof identity.birth !== "string" || identity.birth.length === 0)
    throw new Error("Portable publication test recorded process identity is malformed or uncertain.");
  return { pid: Number(identity.pid), birth: identity.birth };
}
function portableCleanupFixture(label: string): { root: string; directory: string; nonce: string; supervisorPid: number; supervisorBirth: string } {
  const root = mkdtempSync(join(tmpdir(), `aiboard-portable-release-corrupt-ack-${label}-`));
  const directory = join(root, "owned-fixture");
  const nonce = createHash("sha256").update(root).digest("hex").slice(0, 48);
  const supervisorPid = 2_000_000_000;
  const supervisorBirth = "fixture-birth";
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "state.json"), JSON.stringify({
    protocol: "aiboard-portable-process/v1", nonce, supervisorPid, status: "stopped", rootProcess: null,
    knownProcesses: [{ pid: supervisorPid, birth: supervisorBirth }],
  }));
  return { root, directory, nonce, supervisorPid, supervisorBirth };
}
function writeOutputCheckpoint(root: string): void {
  writeFileSync(join(root, "channel", "output-checkpoint.json"), JSON.stringify({ nonce: "nonce", stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 } }));
}
