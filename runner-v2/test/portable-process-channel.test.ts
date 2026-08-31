import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";

import { WindowsProcessBackend } from "../src/windows-process-backend.js";
import { parseProcessLaunchResult, parseProcessReconciliation, type ProcessBackendBinding, type ProcessEffectFence } from "../src/process-backend.js";
import type { BackpressuredOutputMetadata } from "../src/interactive-process-channel.js";
import { createPortableProcessChannelProvider } from "../src/portable-process-channel.js";

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
      reattest: () => "live", effect: async (_kind, effect) => effect(),
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
  const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 4, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => "live", effect: async (_kind, effect) => effect() }) });
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
  const staleBytes = Buffer.from("stale\n");
  const stale = old.write({ sequence: 1, byteLength: staleBytes.byteLength, digest: createHash("sha256").update(staleBytes).digest("hex"), timeoutMs: 5_000 }, staleBytes).then(
    () => ({ status: "acknowledged" as const }),
    (error: unknown) => ({ status: "rejected" as const, error }),
  );
  await waitFor(() => existsSync(join(identity.directory, "channel", "input", "input-000000000001.json")));
  const higher = { ownerId: "portable-recovery", fencingToken: fence.fencingToken + 1 };
  const recovered = await provider.acquire(binding, higher); const output: Buffer[] = [];
  recovered.subscribeBackpressuredOutput(async (metadata, bytes) => { output.push(Buffer.from(bytes)); return metadata; });
  const freshBytes = Buffer.from("fresh\n");
  try {
    const staleOutcome = await stale;
    if (staleOutcome.status === "rejected") assert.match(String(staleOutcome.error), /failed|stale|fence|rejected/i);
    assert.deepEqual(await recovered.write({ sequence: 2, byteLength: freshBytes.byteLength, digest: createHash("sha256").update(freshBytes).digest("hex"), timeoutMs: 5_000 }, freshBytes), { acknowledged: true, sequence: 2 });
    await recovered.closeInput(); await recovered.waitForTerminal();
    const seen = Buffer.concat(output).toString();
    assert.equal(seen, staleOutcome.status === "acknowledged" ? "seen:stale\nseen:fresh\n" : "seen:fresh\n");
  } finally {
    await old.detach(); await recovered.detach();
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
  const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 8, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => "live", effect: async (_kind, effect) => effect() }) });
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
  const identityDirectory = join(root, "identity");
  for (const path of [identityDirectory, join(identityDirectory, "channel/output"), join(identityDirectory, "channel/input"), join(identityDirectory, "channel/ack")]) mkdirSync(path, { recursive: true });
  writeFileSync(join(identityDirectory, "state.json"), JSON.stringify({ protocol: "aiboard-portable-process/v1", nonce: "fixture-nonce", supervisorPid: 9001, revision: 1, handledControl: 0, status: "running", exitCode: null, signal: null, launchEffect: "not_started", rootProcess: null, knownProcesses: [], error: null }));
  writeFileSync(join(identityDirectory, "channel/output-checkpoint.json"), JSON.stringify({ nonce: "fixture-nonce", stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 } }));
  const operations = { inspectProcessBirth: () => ({ state: "present" as const, fingerprint: "fixture-birth" }), listPosixGroup: () => undefined, signal: () => undefined };
  const backend = new WindowsProcessBackend({ stateDirectory: root, operations });
  const opaque = { version: 1, backendId: "runner-windows-supervisor-v1", nonce: "fixture-nonce", directory: identityDirectory, supervisorPid: 9001, supervisorBirth: "fixture-birth" };
  const binding = bindingFor({ opaqueIdentity: Buffer.from(JSON.stringify(opaque)).toString("base64url"), birthFingerprint: { observedAt: "now", discriminator: createHash("sha256").update("fixture-nonce\0fixture-birth").digest("hex") }, rootPid: 9001, startedAt: "now" });
  try {
    await assert.rejects(backend.release(binding, fence), /terminal|stopped/i);
    assert.equal(existsSync(identityDirectory), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("portable reconcile and release reject corrupt acknowledgement evidence", { timeout: 60_000 }, async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-release-corrupt-ack-"));
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10 });
  const launch = parseProcessLaunchResult(await backend.launch(request(["-e", "process.exit(0)"])));
  const binding = bindingFor(launch);
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string; supervisorPid: number; supervisorBirth: string };
  await waitFor(() => JSON.parse(readFileSync(join(identity.directory, "state.json"), "utf8")).status === "stopped", 15_000);
  writeFileSync(join(identity.directory, "channel", "ack", "corrupt.json"), "{}");
  try {
    assert.deepEqual(await backend.reconcile(binding, fence), { state: "outcome_unknown" });
    await assert.rejects(backend.release(binding, fence), /acknowledgement|evidence|output/i);
    assert.equal(existsSync(identity.directory), true);
  } finally { await removeSettledPortableTestRoot(root, identity.supervisorPid, identity.supervisorBirth); }
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
      const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 8, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => "live", effect: async (_kind, effect) => effect() }) });
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
    const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 8, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => "live", effect: async (_kind, effect) => effect() }) });
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
  const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 8, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => "exited", effect: async (_kind, effect) => effect() }) });
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
  const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 8, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => "exited", effect: async (_kind, effect) => effect() }) });
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
  const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 8, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => "exited", effect: async (_kind, effect) => effect() }) });
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
  const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 8, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => { checks += 1; if (checks >= 3) throw new Error("writer fence changed"); return "exited"; }, effect: async (_kind, effect) => effect() }) });
  const channel = await provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence);
  try { assert.deepEqual(await channel.waitForTerminal(), { state: "outcome_unknown" }); }
  finally { await channel.detach(); rmSync(root, { recursive: true, force: true }); }
});

const fence = { ownerId: "portable-channel-owner", fencingToken: 7 } as const;
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
function writeOutputCheckpoint(root: string): void {
  writeFileSync(join(root, "channel", "output-checkpoint.json"), JSON.stringify({ nonce: "nonce", stdout: { sequence: 0, endOffset: 0 }, stderr: { sequence: 0, endOffset: 0 } }));
}
