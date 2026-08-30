import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WindowsProcessBackend } from "../src/windows-process-backend.js";
import { parseProcessLaunchResult, type ProcessBackendBinding } from "../src/process-backend.js";
import type { BackpressuredOutputMetadata } from "../src/interactive-process-channel.js";
import { createPortableProcessChannelProvider } from "../src/portable-process-channel.js";

test("portable provider retains a chunk until the identical sink acknowledgement settles", { timeout: 60_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-ack-order-"));
  for (const path of ["channel/output", "channel/input", "channel/ack"]) mkdirSync(join(root, path), { recursive: true });
  const bytes = Buffer.from("held");
  const metadata: BackpressuredOutputMetadata = { stream: "stdout", sequence: 1, startOffset: 0, endOffset: 4, byteLength: 4, digest: createHash("sha256").update(bytes).digest("hex") };
  writeFileSync(join(root, "channel/output/stdout-000000000001.json"), JSON.stringify({ nonce: "nonce", metadata, bytes: bytes.toString("base64") }));
  writeFileSync(join(root, "channel/client-state.json"), JSON.stringify({ nonce: "nonce", ownerId: fence.ownerId, fencingToken: fence.fencingToken, nextCommand: 1, nextWrite: 1, inputClosed: false }));
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  let entered = false;
  const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 4, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => "live" }) });
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
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string };
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
      windowsTreeRefreshCount?: number;
      windowsTreeRefreshMinimumGapMs?: number | null;
    };
    assert.ok((supervisorState.windowsTreeRefreshCount ?? 0) >= 2, "fixture must observe multiple Windows tree refreshes");
    assert.ok((supervisorState.windowsTreeRefreshMinimumGapMs ?? 0) >= 250, "Windows tree refreshes must remain cadence bounded");
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
  const identity = JSON.parse(Buffer.from(launch.opaqueIdentity, "base64url").toString("utf8")) as { directory: string };
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

test("portable retained window backpressures output and replays it after exact reattach", { timeout: 60_000 }, async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-replay-"));
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10, replayCapacityChunks: 2, replayCapacityBytes: 32 });
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
    assert.equal((await reattached.channel.waitForTerminal() as { state: string }).state, "exited");
    await waitFor(() => Buffer.concat(replayed).byteLength === 96);
    assert.equal(Buffer.concat(replayed).toString(), "x".repeat(96));
    unsubscribe();
    await reattached.channel.detach();
  } finally {
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    await backend.release(binding, fence).catch(() => undefined);
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
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    await backend.release(binding, fence).catch(() => undefined);
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
    await backend.signal(binding, "force_terminate", nextFence).catch(() => undefined);
    await backend.release(binding, nextFence).catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
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
      writeFileSync(join(root, "channel/client-state.json"), JSON.stringify({ nonce: "nonce", ownerId: fence.ownerId, fencingToken: fence.fencingToken, nextCommand: 1, nextWrite: 1, inputClosed: false }));
      writeFileSync(join(root, "channel/fence.json"), JSON.stringify({ nonce: "nonce", ownerId: fence.ownerId, fencingToken: fence.fencingToken }));
      const provider = createPortableProcessChannelProvider({ replayCapacityChunks: 1, replayCapacityBytes: 8, pollIntervalMs: 5, authority: () => ({ directory: root, nonce: "nonce", fence, reattest: () => "live" }) });
      try {
        await assert.rejects(provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }), fence), /output|corrupt|invalid|continu/i);
      } finally { rmSync(root, { recursive: true, force: true }); }
    });
  }
});

const fence = { ownerId: "portable-channel-owner", fencingToken: 7 } as const;
function request(args: string[]) {
  return {
    intent: { invocationId: "portable-channel", runId: "run", kind: "command" as const, executable: process.execPath, arguments: args, workingDirectory: process.cwd(), requestedCapabilities: ["tree_termination"] as const },
    grant: { grantId: "grant", runId: "run", invocationId: "portable-channel", issuedAt: new Date().toISOString(), access: [] },
    environment: { ...process.env } as Record<string, string>, outputOwnerId: "output", fence,
  };
}
function bindingFor(launch: ReturnType<typeof parseProcessLaunchResult>): ProcessBackendBinding {
  return { registryId: "registry", backendId: "runner-windows-supervisor-v1", implementationGeneration: "generation", implementationDigest: "1".repeat(64), attestationVersion: 1, attestationDigest: "2".repeat(64), ...launch };
}
async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("portable output did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
