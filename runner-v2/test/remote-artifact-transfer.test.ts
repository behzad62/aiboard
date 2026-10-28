import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolResult } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { canonicalJson, RemoteAdmissionStore, remotePayloadDigest, type RemoteRequest } from "../src/remote-admission-store.js";
import { ArtifactTransferError, ArtifactTransferManager, type ArtifactTransferFrame } from "../src/remote-artifact-transfer.js";
import { RemoteAuthenticator, REMOTE_CONNECT_SCOPE, REMOTE_RELAY_AUDIENCE, type RemoteAuthorization } from "../src/remote-auth.js";
import { RemoteConnector, type RemoteRequestRuntime, type RemoteTransport, type RemoteTransportMessage } from "../src/remote-connector.js";
import { RemoteDeviceStore, type RemoteDeviceSession } from "../src/remote-device-store.js";
import {
  chunkBytesFor, decodeFrame, DEFAULT_REMOTE_FRAME_LIMITS, encodeFrame, frameByteLength, negotiateFrameLimits,
  RemoteFrameError, REMOTE_FRAME_MAX_BYTES, REMOTE_FRAME_MIN_BYTES, type RemoteFrameLimits,
} from "../src/remote-frame-codec.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function temporary(t: test.TestContext, cleanup = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aiboard-r3a-"));
  if (cleanup) t.after(async () => { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  return root;
}

/** Write `size` pseudo-random bytes in 4 MiB slices (never one 100 MiB buffer) and return the digest. */
async function bigFile(path: string, size: number): Promise<string> {
  const hash = createHash("sha256");
  const handle = await open(path, "w");
  try {
    for (let written = 0; written < size;) {
      const slice = randomBytes(Math.min(4 * 1024 * 1024, size - written));
      await handle.write(slice);
      hash.update(slice);
      written += slice.byteLength;
    }
  } finally { await handle.close(); }
  return hash.digest("hex");
}

/**
 * A receiver that verifies every chunk, requires contiguous offsets, hashes the
 * stream incrementally (it never holds the artifact) and acknowledges slowly.
 */
class Receiver {
  readonly frames: ArtifactTransferFrame[] = [];
  readonly hash = createHash("sha256");
  next = 0;
  ackedEnd = 0;
  bad = 0;
  ended = false;
  error: string | undefined;
  maxFrameBytes = 0;
  /** Wired after the sender exists. */
  ack: (seq: number) => void = () => undefined;
  constructor(private readonly delay = () => tick(), start = 0) { this.next = start; this.ackedEnd = start; }
  async receive(frame: ArtifactTransferFrame): Promise<void> {
    this.frames.push(frame);
    this.maxFrameBytes = Math.max(this.maxFrameBytes, frameByteLength(frame));
    if (frame.type === "chunk") {
      const data = Buffer.from(frame.data, "base64");
      if (data.byteLength !== frame.length || sha256(data) !== frame.sha256 || frame.offset !== this.next) { this.bad += 1; return; }
      this.hash.update(data);
      this.next += data.byteLength;
      void this.delay().then(() => { this.ackedEnd = frame.offset + frame.length; this.ack(frame.seq); });
    } else if (frame.type === "artifact_end") this.ended = true;
    else this.error = frame.code;
  }
}

async function until(condition: () => boolean, ms = 60_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail("condition not reached");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

// ---------------------------------------------------------------- frame codec

test("frame limits negotiate to the minimum and fail closed on malformed offers", () => {
  assert.deepEqual(negotiateFrameLimits(DEFAULT_REMOTE_FRAME_LIMITS, undefined), DEFAULT_REMOTE_FRAME_LIMITS);
  const lowered = negotiateFrameLimits(DEFAULT_REMOTE_FRAME_LIMITS, { maxFrameBytes: 128 * 1024, window: 2 });
  assert.equal(lowered.maxFrameBytes, 128 * 1024);
  assert.equal(lowered.window, 2);
  assert.equal(lowered.chunkBytes, chunkBytesFor(128 * 1024));
  // A peer can never raise the local offer.
  const local: RemoteFrameLimits = { maxFrameBytes: 256 * 1024, chunkBytes: chunkBytesFor(256 * 1024), window: 4 };
  assert.deepEqual(negotiateFrameLimits(local, { maxFrameBytes: REMOTE_FRAME_MAX_BYTES, chunkBytes: REMOTE_FRAME_MAX_BYTES, window: 16 }), local);
  for (const bad of [null, [], "1048576", { maxFrameBytes: 1 }, { maxFrameBytes: REMOTE_FRAME_MAX_BYTES + 1 },
    { maxFrameBytes: REMOTE_FRAME_MIN_BYTES + 0.5 }, { maxFrameBytes: REMOTE_FRAME_MIN_BYTES, window: 0 },
    { maxFrameBytes: REMOTE_FRAME_MIN_BYTES, window: 17 }, { maxFrameBytes: REMOTE_FRAME_MIN_BYTES, extra: 1 }]) {
    assert.throws(() => negotiateFrameLimits(local, bad), (error: unknown) => error instanceof RemoteFrameError && error.code === "unsupported_limits");
  }
});

test("a full chunk frame always fits under the negotiated maximum", () => {
  for (const max of [REMOTE_FRAME_MIN_BYTES, 100_000, 512 * 1024, REMOTE_FRAME_MAX_BYTES]) {
    const chunk = chunkBytesFor(max);
    assert.equal(chunk % 4096, 0);
    const frame: ArtifactTransferFrame = {
      type: "chunk", transferId: "x".repeat(128), seq: Number.MAX_SAFE_INTEGER, offset: Number.MAX_SAFE_INTEGER,
      length: chunk, sha256: "f".repeat(64), data: Buffer.alloc(chunk, 0xff).toString("base64"),
    };
    assert.ok(frameByteLength(frame) <= max, `chunk frame for ${max}`);
  }
});

test("oversized frames are refused by length before parsing; the codec never throws on input", () => {
  const limits = negotiateFrameLimits(DEFAULT_REMOTE_FRAME_LIMITS, { maxFrameBytes: REMOTE_FRAME_MIN_BYTES });
  assert.throws(() => encodeFrame({ type: "response", data: "x".repeat(REMOTE_FRAME_MIN_BYTES) }, limits),
    (error: unknown) => error instanceof RemoteFrameError && error.code === "frame_too_large");
  // Over-limit garbage is refused on length alone (it would not even parse).
  assert.deepEqual(decodeFrame(Buffer.alloc(REMOTE_FRAME_MIN_BYTES + 1, 0x7b), limits), { ok: false, code: "frame_too_large" });
  assert.deepEqual(decodeFrame(Buffer.from("{not json"), limits), { ok: false, code: "malformed_frame" });
  assert.deepEqual(decodeFrame(Buffer.from([0xff, 0xfe]), limits), { ok: false, code: "malformed_frame" });
  assert.deepEqual(decodeFrame(Buffer.from("[1]"), limits), { ok: false, code: "malformed_frame" });
  assert.deepEqual(decodeFrame(Buffer.from('{"kind":"x"}'), limits), { ok: false, code: "malformed_frame" });
  const good = encodeFrame({ type: "chunk_ack", transferId: "t", seq: 1 }, limits);
  assert.deepEqual(decodeFrame(good, limits), { ok: true, message: { type: "chunk_ack", transferId: "t", seq: 1 } });
});

// ----------------------------------------------------------- transfer manager

test("a 100 MiB artifact streams byte-exact under a credit window, survives a disconnect and resumes", { timeout: 300_000 }, async (t) => {
  const root = await temporary(t);
  const path = join(root, "big.bin");
  const size = 100 * 1024 * 1024;
  const hash = await bigFile(path, size);
  const limits = DEFAULT_REMOTE_FRAME_LIMITS;
  const source = { path, hash, byteLength: size };

  // First connection: drop it once 40 MiB are acknowledged.
  const first = new Receiver();
  let peak = 0;
  const manager = new ArtifactTransferManager({
    limits: () => limits,
    send: async (frame) => { peak = Math.max(peak, manager.peakUnacked("t1") ?? 0); await first.receive(frame); },
  });
  first.ack = (seq) => manager.ack("t1", seq);
  manager.reserve("t1", source, 0);
  const firstRun = manager.run("t1", source, 0);
  await until(() => first.ackedEnd >= 40 * 1024 * 1024);
  manager.abortAll();
  await firstRun;
  const framesAtDrop = first.frames.length;
  await tick(); await tick();
  assert.equal(first.frames.length, framesAtDrop, "nothing is sent after the connection is gone");
  assert.equal(first.bad, 0);
  assert.equal(first.ended, false);
  assert.ok(peak <= limits.window, `unacked chunks peaked at ${peak} > window ${limits.window}`);
  assert.ok(first.maxFrameBytes <= limits.maxFrameBytes);

  // Resume on a new connection from the receiver's verified offset. The receiver
  // keeps only the bytes it verified, so hash exactly that prefix again from disk.
  const resumeAt = first.next;
  const prefix = createHash("sha256");
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(4 * 1024 * 1024);
    for (let position = 0; position < resumeAt;) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.byteLength, resumeAt - position), position);
      prefix.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally { await handle.close(); }
  const second = new Receiver(() => tick(), resumeAt);
  // Continue the same digest the receiver would have kept.
  (second as unknown as { hash: ReturnType<typeof createHash> }).hash = prefix;
  const resumed = new ArtifactTransferManager({ limits: () => limits, send: (frame) => second.receive(frame) });
  second.ack = (seq) => resumed.ack("t2", seq);
  resumed.reserve("t2", source, resumeAt);
  await resumed.run("t2", source, resumeAt);
  assert.equal(second.bad, 0);
  assert.equal(second.error, undefined);
  assert.equal(second.ended, true);
  assert.equal(second.next, size);
  assert.equal(second.hash.digest("hex"), hash, "resumed stream is byte-exact");
  assert.equal(resumed.active, 0);
});

test("a receiver that stops acknowledging stalls the transfer after one window, never more", async (t) => {
  const root = await temporary(t);
  const bytes = randomBytes(64 * 4096);
  const path = join(root, "a.bin");
  await writeFile(path, bytes);
  const limits: RemoteFrameLimits = { maxFrameBytes: REMOTE_FRAME_MIN_BYTES, chunkBytes: 4096, window: 3 };
  const frames: ArtifactTransferFrame[] = [];
  const manager = new ArtifactTransferManager({ limits: () => limits, send: (frame) => { frames.push(frame); }, stallTimeoutMs: 50 });
  const source = { path, hash: sha256(bytes), byteLength: bytes.byteLength };
  manager.reserve("t", source, 0);
  await manager.run("t", source, 0);
  assert.equal(frames.filter((frame) => frame.type === "chunk").length, 3);
  assert.deepEqual(frames.at(-1), { type: "artifact_error", transferId: "t", code: "transfer_stalled" });
  assert.equal(manager.active, 0);
});

test("content that no longer matches its address is reported corrupt, never ended", async (t) => {
  const root = await temporary(t);
  const bytes = randomBytes(10 * 4096);
  const path = join(root, "a.bin");
  await writeFile(path, bytes);
  const limits: RemoteFrameLimits = { maxFrameBytes: REMOTE_FRAME_MIN_BYTES, chunkBytes: 4096, window: 16 };
  for (const [name, mutate] of [
    ["same-size tamper", async () => { const copy = Buffer.from(bytes); copy[5] ^= 1; await writeFile(path, copy); }],
    ["size change", async () => { await writeFile(path, bytes.subarray(1)); }],
  ] as const) {
    await mutate();
    const receiver = new Receiver();
    const manager = new ArtifactTransferManager({ limits: () => limits, send: (frame) => receiver.receive(frame) });
    receiver.ack = (seq) => manager.ack("t", seq);
    const source = { path, hash: sha256(bytes), byteLength: bytes.byteLength };
    manager.reserve("t", source, 0);
    await manager.run("t", source, 0);
    assert.equal(receiver.ended, false, name);
    assert.equal(receiver.error, "artifact_corrupt", name);
  }
});

test("receiver abort stops a transfer; slots, offsets and duplicates are bounded", async (t) => {
  const root = await temporary(t);
  const bytes = randomBytes(32 * 4096);
  const path = join(root, "a.bin");
  await writeFile(path, bytes);
  const limits: RemoteFrameLimits = { maxFrameBytes: REMOTE_FRAME_MIN_BYTES, chunkBytes: 4096, window: 2 };
  const frames: ArtifactTransferFrame[] = [];
  const manager = new ArtifactTransferManager({ limits: () => limits, send: (frame) => { frames.push(frame); }, maxConcurrent: 2, stallTimeoutMs: 5_000 });
  const source = { path, hash: sha256(bytes), byteLength: bytes.byteLength };
  assert.throws(() => manager.reserve("bad", source, bytes.byteLength + 1), (error: unknown) => error instanceof ArtifactTransferError && error.code === "invalid_offset");
  assert.throws(() => manager.reserve("bad", source, -1), (error: unknown) => error instanceof ArtifactTransferError && error.code === "invalid_offset");
  manager.reserve("a", source, 0);
  assert.throws(() => manager.reserve("a", source, 0), (error: unknown) => error instanceof ArtifactTransferError && error.code === "duplicate_transfer");
  manager.reserve("b", source, 0);
  assert.throws(() => manager.reserve("c", source, 0), (error: unknown) => error instanceof ArtifactTransferError && error.code === "transfer_limit");
  const running = manager.run("a", source, 0);
  await until(() => frames.length === 2);
  manager.abort("a");
  await running;
  manager.ack("a", 0);
  await tick();
  assert.equal(frames.length, 2, "an aborted transfer sends nothing more, not even an error");
  manager.abort("b");
  assert.equal(manager.active, 0);
});

// --------------------------------------------------- connector integration

const ACCOUNT = "account";
const CLIENT = "client-a";
const relayKey = generateKeyPairSync("ed25519");

class RelayTransport implements RemoteTransport {
  readonly sent: RemoteTransportMessage[] = [];
  dropped = false;
  autoAck = true;
  authenticatedLimits: unknown;
  private handler?: (message: RemoteTransportMessage) => void | Promise<void>;
  private closed?: () => void;
  onProof?: () => void;
  async connect(): Promise<void> { this.dropped = false; }
  async close(): Promise<void> { this.dropped = true; this.closed?.(); }
  send(message: RemoteTransportMessage): void {
    if (this.dropped) throw new Error("socket lost");
    this.sent.push(message);
    if (message.type === "proof") this.onProof?.();
    if (message.type === "chunk" && this.autoAck) {
      void tick().then(() => this.emit({ type: "chunk_ack", transferId: message.transferId, seq: message.seq }));
    }
  }
  onMessage(handler: (message: RemoteTransportMessage) => void | Promise<void>): void { this.handler = handler; }
  onClose(handler: () => void): void { this.closed = handler; }
  emit(message: RemoteTransportMessage): Promise<void> { return Promise.resolve(this.handler?.(message)); }
  drop(): void { this.dropped = true; this.closed?.(); }
  response(requestId: string) {
    return this.sent.find((frame): frame is Extract<RemoteTransportMessage, { type: "response" }> => frame.type === "response" && frame.response.requestId === requestId);
  }
  transfer(transferId: string): ArtifactTransferFrame[] {
    return this.sent.filter((frame): frame is ArtifactTransferFrame =>
      (frame.type === "chunk" || frame.type === "artifact_end" || frame.type === "artifact_error") && frame.transferId === transferId);
  }
}

async function connectorHarness(t: test.TestContext, options: { results?: (name: string) => ToolResult | Promise<ToolResult>; frameLimits?: RemoteFrameLimits; artifacts?: boolean } = {}) {
  const root = await temporary(t, false);
  const state = join(root, "state");
  await mkdir(state);
  const now = Date.parse("2026-10-27T12:00:00.000Z");
  const clock = () => new Date(now);
  const deviceStore = new RemoteDeviceStore(state);
  const device = deviceStore.ensure(ACCOUNT);
  const session: RemoteDeviceSession = {
    accountId: ACCOUNT, clientId: CLIENT, scope: REMOTE_CONNECT_SCOPE, issuedAt: clock().toISOString(),
    relayKeys: [{ keyId: "relay", publicKey: relayKey.publicKey.export({ type: "spki", format: "der" }).toString("base64url") }],
    authorizedScopes: ["scope"],
  };
  const authenticator = new RemoteAuthenticator(deviceStore, { now: clock });
  const admission = new RemoteAdmissionStore(join(state, "jobs.sqlite"), Buffer.alloc(32, 9), clock);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const results = options.results ?? ((name: string): ToolResult => ({ callId: "c", toolName: name, content: [{ type: "text", text: "ok" }], isError: false }));
  const runtime: RemoteRequestRuntime = {
    invoke: async (_identity, name) => await results(name),
    invokeAdmitted: async (_identity, name) => ({ result: await results(name), brokerInvoked: true }),
  };
  const audits: [string, string, string, string][] = [];
  let transport = new RelayTransport();
  let requestNumber = 0;
  let challengeNumber = 0;
  const connector = new RemoteConnector({
    deviceStore, authenticator, admission, runtime, session,
    createTransport: () => transport,
    reconcile: async () => { admission.reconcileStartup(); },
    now: clock, reconnect: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 0 }, drainTimeoutMs: 20,
    ...(options.artifacts === false ? {} : { artifacts }),
    auditArtifactRead: (identity, jobId, decision, outcome) => { audits.push([identity.clientId, jobId, decision, outcome]); },
    ...(options.frameLimits ? { frameLimits: options.frameLimits } : {}),
  });
  t.after(async () => {
    await connector.close().catch(() => undefined);
    admission.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  async function connect(limits?: unknown): Promise<void> {
    const started = connector.start();
    await tick();
    transport.onProof = () => { void transport.emit({ type: "authenticated", epoch: "5", ...(limits !== undefined ? { limits } : {}) }); };
    await transport.emit({ type: "challenge", challenge: {
      audience: REMOTE_RELAY_AUDIENCE, accountId: ACCOUNT, deviceId: device.deviceId, scope: REMOTE_CONNECT_SCOPE,
      nonce: "challenge-" + ++challengeNumber, epoch: "5", expiresAt: new Date(now + 60_000).toISOString(),
    } });
    await started;
  }
  function request(patch: Partial<RemoteRequest> = {}): RemoteRequest {
    const id = ++requestNumber;
    const value: RemoteRequest = {
      protocolVersion: "1.0.0", requestId: "request-" + id, traceId: "trace-" + id,
      accountId: ACCOUNT, clientId: CLIENT, deviceId: device.deviceId, deviceEpoch: "5",
      toolId: "files_read", operationClass: "read", scopeRef: "scope",
      issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
      nonce: "nonce-" + id, idempotencyKey: "key-" + id, payloadDigest: "", payload: { path: "fixture" },
      ...patch,
    };
    value.payloadDigest = remotePayloadDigest(value);
    return value;
  }
  async function send(value: RemoteRequest): Promise<Extract<RemoteTransportMessage, { type: "response" }>> {
    const claims = {
      audience: REMOTE_RELAY_AUDIENCE, accountId: value.accountId, clientId: value.clientId, deviceId: value.deviceId,
      deviceEpoch: value.deviceEpoch, scopeRef: value.scopeRef, toolId: value.toolId, operationClass: value.operationClass,
      requestId: value.requestId, nonce: value.nonce, payloadDigest: value.payloadDigest, issuedAt: value.issuedAt, expiresAt: value.expiresAt,
    };
    const authorization: RemoteAuthorization = { version: 1, keyId: "relay", claims,
      signature: sign(null, Buffer.from(canonicalJson(claims)), relayKey.privateKey).toString("base64url") };
    await transport.emit({ type: "request", request: value, authorization });
    await until(() => transport.response(value.requestId) !== undefined, 30_000);
    return transport.response(value.requestId)!;
  }
  /** Run one read job to settlement and return its id. */
  async function settledJob(patch: Partial<RemoteRequest> = {}): Promise<string> {
    const answer = await send(request(patch));
    const jobId = answer.response.jobId!;
    await until(() => !["queued", "running"].includes(admission.getJob({ accountId: ACCOUNT, clientId: patch.clientId ?? CLIENT, deviceId: device.deviceId }, jobId)?.state ?? "queued"), 30_000);
    return jobId;
  }
  /** Reassemble a transfer from its chunk frames, verifying each chunk. */
  async function drain(transferId: string): Promise<{ bytes: Buffer; end?: ArtifactTransferFrame; error?: string }> {
    await until(() => transport.transfer(transferId).some((frame) => frame.type !== "chunk"), 60_000);
    const frames = transport.transfer(transferId);
    const parts: Buffer[] = [];
    for (const frame of frames) {
      if (frame.type !== "chunk") continue;
      const data = Buffer.from(frame.data, "base64");
      assert.equal(sha256(data), frame.sha256);
      parts.push(data);
    }
    const last = frames.at(-1)!;
    return { bytes: Buffer.concat(parts), ...(last.type === "artifact_end" ? { end: last } : {}), ...(last.type === "artifact_error" ? { error: last.code } : {}) };
  }
  return { audits, connector, admission, artifacts, device, connect, request, send, settledJob, drain, get transport() { return transport; },
    replaceTransport() { transport = new RelayTransport(); return transport; } };
}

test("an artifact named by a job result streams through artifacts_read byte-exact; unreachable hashes never stream", async (t) => {
  const blob: { hash: string } = { hash: "" };
  const h = await connectorHarness(t, {
    results: async (name) => ({ callId: "c", toolName: name, isError: false,
      content: [{ type: "json", value: { path: "screen.png" } }, { type: "artifact", hash: blob.hash, mediaType: "application/octet-stream" }] }),
  });
  const bytes = randomBytes(3 * 1024 * 1024 + 17);
  blob.hash = (await h.artifacts.put(bytes, "application/octet-stream")).hash;
  const unrelated = (await h.artifacts.put(randomBytes(1000), "application/octet-stream")).hash;
  await h.connect();
  const jobId = await h.settledJob();

  const read = h.request({ toolId: "artifacts_read", payload: { jobId, hash: blob.hash } });
  const answer = await h.send(read);
  assert.equal(answer.response.admitted, true);
  assert.deepEqual(answer.data, { transferId: read.requestId, hash: blob.hash, mediaType: "application/octet-stream",
    byteLength: bytes.byteLength, offset: 0, chunkBytes: DEFAULT_REMOTE_FRAME_LIMITS.chunkBytes, window: DEFAULT_REMOTE_FRAME_LIMITS.window });
  const streamed = await h.drain(read.requestId);
  assert.equal(streamed.error, undefined);
  assert.deepEqual(streamed.end, { type: "artifact_end", transferId: read.requestId, byteLength: bytes.byteLength, sha256: blob.hash });
  assert.ok(streamed.bytes.equals(bytes));

  // Resume from an offset streams only the tail and still proves the whole address.
  const resume = h.request({ toolId: "artifacts_read", payload: { jobId, hash: blob.hash, offset: 2 * 1024 * 1024 } });
  await h.send(resume);
  const tail = await h.drain(resume.requestId);
  assert.ok(tail.end);
  assert.ok(tail.bytes.equals(bytes.subarray(2 * 1024 * 1024)));

  // A real hash in the store that this job never produced is not readable.
  const stray = h.request({ toolId: "artifacts_read", payload: { jobId, hash: unrelated } });
  const refused = await h.send(stray);
  assert.equal(refused.response.admitted, false);
  assert.equal(refused.response.errorCode, "artifact_unavailable");
  // Another client of the same account cannot read this job's artifacts.
  const other = h.request({ toolId: "artifacts_read", clientId: "client-b", payload: { jobId, hash: blob.hash } });
  assert.equal((await h.send(other)).response.admitted, false);
  // Malformed arguments are refused at the boundary.
  for (const payload of [{ jobId, hash: "A".repeat(64) }, { jobId, hash: blob.hash, offset: -1 }, { jobId, hash: blob.hash, extra: 1 }]) {
    assert.equal((await h.send(h.request({ toolId: "artifacts_read", payload }))).response.errorCode, "invalid_request");
  }
  const outOfRange = await h.send(h.request({ toolId: "artifacts_read", payload: { jobId, hash: blob.hash, offset: bytes.byteLength + 1 } }));
  assert.equal(outOfRange.response.errorCode, "invalid_request");
  for (const id of [stray.requestId, other.requestId]) assert.deepEqual(h.transport.transfer(id), []);
  assert.deepEqual(h.audits.slice(0, 3), [[CLIENT, jobId, "allowed", "transfer_started"], [CLIENT, jobId, "allowed", "transfer_started"],
    [CLIENT, jobId, "denied", "artifact_unavailable"]]);
  assert.ok(!JSON.stringify(h.audits).includes(blob.hash), "audit never carries the content address");
});

test("a result over the inline cap is stored whole and returned by outputRef, never truncated", async (t) => {
  const text = "x".repeat(600 * 1024);
  const h = await connectorHarness(t, { results: (name) => ({ callId: "c", toolName: name, isError: false, content: [{ type: "text", text }] }) });
  await h.connect();
  const jobId = await h.settledJob();
  const answer = await h.send(h.request({ toolId: "jobs_result", payload: { jobId } }));
  const data = answer.data as { state: string; outputRef?: string; inline?: string };
  assert.equal(data.state, "completed");
  assert.match(data.outputRef ?? "", /^[0-9a-f]{64}$/);
  const stub = JSON.parse(Buffer.from(data.inline!, "base64").toString("utf8")) as Record<string, unknown>;
  assert.equal(stub.outputRef, data.outputRef);
  assert.equal(stub.mediaType, "application/json");
  assert.equal("truncated" in stub, false);
  const read = h.request({ toolId: "artifacts_read", payload: { jobId, hash: data.outputRef } });
  await h.send(read);
  const streamed = await h.drain(read.requestId);
  assert.ok(streamed.end);
  const result = JSON.parse(streamed.bytes.toString("utf8")) as ToolResult;
  assert.equal((result.content[0] as { text: string }).text, text);
  assert.equal(stub.byteLength, streamed.bytes.byteLength);
});

test("without an artifact store a large result says so explicitly", async (t) => {
  const h = await connectorHarness(t, { artifacts: false,
    results: (name) => ({ callId: "c", toolName: name, isError: false, content: [{ type: "text", text: "y".repeat(300 * 1024) }] }) });
  await h.connect();
  const jobId = await h.settledJob();
  const answer = await h.send(h.request({ toolId: "jobs_result", payload: { jobId } }));
  const stub = JSON.parse(Buffer.from((answer.data as { inline: string }).inline, "base64").toString("utf8")) as Record<string, unknown>;
  assert.equal(stub.resultTooLarge, true);
  assert.ok(Number(stub.byteLength) > 300 * 1024);
});

test("negotiated limits bound every frame; an oversized response is refused and the session keeps serving", async (t) => {
  const bytes = randomBytes(700 * 1024);
  let hash = "";
  const h = await connectorHarness(t, {
    results: (name) => ({ callId: "c", toolName: name, isError: false,
      content: [{ type: "text", text: "z".repeat(100 * 1024) }, { type: "artifact", hash, mediaType: "application/octet-stream" }] }),
  });
  hash = (await h.artifacts.put(bytes, "application/octet-stream")).hash;
  await h.connect({ maxFrameBytes: REMOTE_FRAME_MIN_BYTES, window: 2 });
  const proof = h.transport.sent.find((frame) => frame.type === "proof") as { limits?: RemoteFrameLimits };
  assert.deepEqual(proof.limits, DEFAULT_REMOTE_FRAME_LIMITS, "the device advertises its own limits");
  const jobId = await h.settledJob();
  // 64 KiB of inline result bytes base64-encode past a 64 KiB frame.
  const big = await h.send(h.request({ toolId: "jobs_result", payload: { jobId, maxBytes: 64 * 1024 } }));
  assert.equal(big.response.errorCode, "frame_too_large");
  assert.equal(big.data, undefined);
  const read = h.request({ toolId: "artifacts_read", payload: { jobId, hash } });
  const announced = await h.send(read);
  assert.equal((announced.data as { chunkBytes: number }).chunkBytes, chunkBytesFor(REMOTE_FRAME_MIN_BYTES));
  const streamed = await h.drain(read.requestId);
  assert.ok(streamed.bytes.equals(bytes));
  for (const frame of h.transport.sent) assert.ok(frameByteLength(frame) <= REMOTE_FRAME_MIN_BYTES, `${frame.type} frame exceeds the negotiated maximum`);
  // A transport-level codec refusal is answered and the session survives.
  await h.transport.emit({ type: "frame_rejected", code: "frame_too_large" });
  assert.deepEqual(h.transport.sent.at(-1), { type: "frame_error", code: "frame_too_large" });
  assert.equal(h.connector.isReady(), true);
  const after = await h.send(h.request({ toolId: "jobs_status", payload: { jobId } }));
  assert.equal(after.response.admitted, true);
});

test("unsupported relay limits fail the handshake closed", async (t) => {
  const h = await connectorHarness(t);
  await h.connect({ maxFrameBytes: 1 });
  assert.equal(h.connector.isReady(), false);
  assert.equal(h.connector.state().reasonCode, "authentication_failed");
});

test("a dropped connection stops a transfer mid-stream; a resume after reconnect completes byte-exact", async (t) => {
  const bytes = randomBytes(12 * 1024 * 1024);
  let hash = "";
  const h = await connectorHarness(t, {
    results: (name) => ({ callId: "c", toolName: name, isError: false, content: [{ type: "artifact", hash, mediaType: "application/octet-stream" }] }),
  });
  hash = (await h.artifacts.put(bytes, "application/octet-stream")).hash;
  await h.connect();
  const jobId = await h.settledJob();
  const first = h.transport;
  first.autoAck = false;
  const read = h.request({ toolId: "artifacts_read", payload: { jobId, hash } });
  await h.send(read);
  await until(() => first.transfer(read.requestId).length === DEFAULT_REMOTE_FRAME_LIMITS.window);
  // Acknowledge two chunks, then lose the socket.
  await first.emit({ type: "chunk_ack", transferId: read.requestId, seq: 0 });
  await first.emit({ type: "chunk_ack", transferId: read.requestId, seq: 1 });
  await until(() => first.transfer(read.requestId).length === DEFAULT_REMOTE_FRAME_LIMITS.window + 2);
  first.drop();
  await tick(); await tick();
  const sentBeforeDrop = first.transfer(read.requestId).length;
  assert.ok(first.transfer(read.requestId).every((frame) => frame.type === "chunk"), "no end or error after a drop");
  const acked = 2 * DEFAULT_REMOTE_FRAME_LIMITS.chunkBytes;

  h.replaceTransport();
  await h.connect();
  assert.equal(first.transfer(read.requestId).length, sentBeforeDrop);
  const resume = h.request({ toolId: "artifacts_read", payload: { jobId, hash, offset: acked } });
  await h.send(resume);
  const tail = await h.drain(resume.requestId);
  assert.ok(tail.end);
  assert.ok(Buffer.concat([bytes.subarray(0, acked), tail.bytes]).equals(bytes));
});
