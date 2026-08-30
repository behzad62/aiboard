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

test("portable provider retains a chunk until the identical sink acknowledgement settles", async () => {
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
  const channel = await provider.acquire(bindingFor({ opaqueIdentity: "opaque", birthFingerprint: { observedAt: "now", discriminator: "birth" }, rootPid: 1, startedAt: "now" }));
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

test("real portable channel preserves ordered duplex bytes and exact acknowledgement metadata", async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "aiboard-portable-channel-"));
  const backend = new WindowsProcessBackend({ stateDirectory: root, pollIntervalMs: 10, replayCapacityChunks: 2, replayCapacityBytes: 32 });
  const launch = parseProcessLaunchResult(await backend.launch(request([
    "-e",
    "process.stdin.on('data',b=>{process.stdout.write(b);process.stderr.write(Buffer.from(b).reverse())});process.stdin.on('end',()=>process.exit(0))",
  ])));
  const binding = bindingFor(launch);
  const provider = backend.backpressuredChannelProvider();
  const channel = await provider.acquire(binding);
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

test("portable retained window backpressures output and replays it after exact reattach", async () => {
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
  const first = await provider.acquire(binding);
  try {
    await waitFor(() => readdirSync(join(identity.directory, "channel", "output")).some((name) => name.endsWith(".json")));
    const retained = readdirSync(join(identity.directory, "channel", "output")).filter((name) => name.endsWith(".json"));
    const retainedBytes = retained.reduce((total, name) => total + Buffer.from(JSON.parse(readFileSync(join(identity.directory, "channel", "output", name), "utf8")).bytes, "base64").byteLength, 0);
    assert.ok(retained.length <= 2);
    assert.ok(retainedBytes <= 32);
    await first.detach();

    const reattached = await provider.reattach(binding);
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

test("portable control and channel acquisition reject a stale writer fence before effects", async () => {
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
    await assert.rejects(backend.backpressuredChannelProvider().acquire(staleBinding), /birth|identity|fence/i);
  } finally {
    await backend.signal(binding, "force_terminate", fence).catch(() => undefined);
    await backend.release(binding, fence).catch(() => undefined);
    rmSync(root, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
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
