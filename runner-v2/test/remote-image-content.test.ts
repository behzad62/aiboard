import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";

import type { ToolContentBlock, ToolResult } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import type { ExecutionHost, ExecutionHostRunBinding } from "../src/execution-host.js";
import { encodePng, IMAGE_LIMITS, ImageInspectionError, prepareImageForModel } from "../src/image-inspection.js";
import { createImageTools, mcpImageContent, REMOTE_IMAGE_LIMITS, type McpImageContent } from "../src/image-tools.js";
import { canonicalJson, RemoteAdmissionStore, remotePayloadDigest, type RemoteRequest } from "../src/remote-admission-store.js";
import { RemoteAuthenticator, REMOTE_CONNECT_SCOPE, REMOTE_RELAY_AUDIENCE, type RemoteAuthorization } from "../src/remote-auth.js";
import { INLINE_RESULT_MAX_BYTES, RemoteConnector, type RemoteRequestRuntime, type RemoteTransport, type RemoteTransportMessage } from "../src/remote-connector.js";
import { RemoteDeviceStore, type RemoteDeviceSession } from "../src/remote-device-store.js";
import { DEFAULT_REMOTE_FRAME_LIMITS, frameByteLength } from "../src/remote-frame-codec.js";
import { RemotePrincipalStore } from "../src/remote-principal.js";
import { RemoteToolRuntime } from "../src/remote-tool-runtime.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { ToolBroker } from "../src/tool-broker.js";

// Everything here is in memory or in a temporary folder: no process starts, so it stays in PR CI.

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Seeded noise, which PNG cannot compress: the worst case for a byte limit. */
function noisePng(width: number, height: number, seed = 7): Buffer {
  const data = new Uint8Array(width * height * 4);
  let state = seed;
  for (let index = 0; index < data.length; index++) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    data[index] = index % 4 === 3 ? 255 : state >>> 24;
  }
  return encodePng({ width, height, data });
}
function flatPng(width: number, height: number): Buffer {
  return encodePng({ width, height, data: new Uint8Array(width * height * 4).fill(200) });
}
/** A minimal baseline JPEG header (probe only), padded to `size` bytes. */
function jpeg(width: number, height: number, size: number): Buffer {
  const u16 = (value: number) => { const buffer = Buffer.alloc(2); buffer.writeUInt16BE(value); return buffer; };
  const sof = Buffer.concat([Buffer.from([0xff, 0xc0]), u16(17), Buffer.from([8]), u16(height), u16(width), Buffer.from([3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1])]);
  const head = Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xda, 0, 2])]);
  return Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length - 2), 0x55), Buffer.from([0xff, 0xd9])]);
}
/** A minimal WebP (VP8X) whose RIFF header claims `riffBytes` in all; the file itself is 30 bytes. */
function webp(riffBytes = 30): Buffer {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "latin1"); bytes.writeUInt32LE(riffBytes - 8, 4); bytes.write("WEBP", 8, "latin1"); bytes.write("VP8X", 12, "latin1");
  bytes.writeUIntLE(63, 24, 3); bytes.writeUIntLE(47, 27, 3);
  return bytes;
}
/** The same PNG with its IHDR marked interlaced (and its CRC fixed); its pixel data is not Adam7, which no check here decodes. */
function interlaced(png: Buffer): Buffer {
  const bytes = Buffer.from(png);
  bytes[28] = 1;
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)) >>> 0, 29);
  return bytes;
}
const code = (expected: string) => (error: unknown) => error instanceof ImageInspectionError && error.code === expected;

function json(result: ToolResult): Record<string, unknown> {
  const block = result.content.find((item) => item.type === "json");
  assert.ok(block?.type === "json", JSON.stringify(result));
  return block.value as Record<string, unknown>;
}

test("a Runner-set byte limit downscales a PNG until it fits; the default limit is unchanged", () => {
  const big = noisePng(400, 300);
  assert.ok(big.byteLength > 60_000);
  const bounded = prepareImageForModel(big, { maxBytes: 60_000 });
  assert.ok(bounded.bytes.byteLength <= 60_000, `${bounded.bytes.byteLength} bytes`);
  assert.ok(bounded.width < 400 && bounded.height < 300);
  assert.deepEqual(bounded.transforms, [`resize ${bounded.width}x${bounded.height}`]);
  assert.equal(bounded.sourceDigest, sha256(big));
  // The steps start at the image's own longest side (400), not at maxDimension (1568), whose steps above 400 would
  // re-encode the same pixels: the delivered side is on 400's chain, and 1568's chain (371, 278, 208, ...) shares none of it.
  const chain = [400];
  while (chain.at(-1)! > IMAGE_LIMITS.minMaxDimension) chain.push(Math.max(IMAGE_LIMITS.minMaxDimension, Math.floor(chain.at(-1)! * 0.75)));
  assert.ok(chain.slice(1, -1).includes(bounded.width), `${bounded.width} is not on ${chain.join(", ")}`);
  // Without maxBytes the same image is within IMAGE_LIMITS and goes as it is, as before.
  const untouched = prepareImageForModel(big);
  assert.equal(untouched.digest, sha256(big));
  assert.deepEqual(untouched.transforms, []);
  // JPEG and WebP are not decoded here: over the limit they are refused, never sent anyway, and the refusal names the limit.
  assert.throws(() => prepareImageForModel(jpeg(640, 480, 70_000), { maxBytes: 60_000 }),
    (error: unknown) => code("image_too_large")(error) && /70000 bytes, over the 60000-byte limit/.test((error as Error).message));
  // An interlaced PNG over the limit is not told to inspect it whole, which is what was just done.
  assert.throws(() => prepareImageForModel(interlaced(big), { maxBytes: 60_000 }),
    (error: unknown) => code("image_transform_unsupported")(error) && /60000-byte limit/.test((error as Error).message) && !/inspect it whole/.test((error as Error).message));
  assert.equal(prepareImageForModel(jpeg(640, 480, 50_000), { maxBytes: 60_000 }).bytes.byteLength, 50_000);
  for (const maxBytes of [0, 1.5, IMAGE_LIMITS.maxDeliveredBytes + 1]) {
    assert.throws(() => prepareImageForModel(big, { maxBytes }), code("invalid_arguments"), String(maxBytes));
  }
});

/** The Remote path guard protects parts of the home folder, so a Remote runtime's workspace lives under the repository, as in remote-actor-binding. */
function workspaceFixture(base = tmpdir()) {
  const root = realpathSync.native(mkdtempSync(join(base, ".remote-image-")));
  const workspace = join(root, "workspace"), outside = join(root, "outside");
  mkdirSync(workspace); mkdirSync(outside);
  writeFileSync(join(workspace, "noise.png"), noisePng(400, 300));
  writeFileSync(join(workspace, "flat.png"), flatPng(64, 48));
  writeFileSync(join(outside, "secret.png"), flatPng(8, 8));
  // A directory link inside the workspace that leads out of it (a junction on Windows, a symlink elsewhere).
  symlinkSync(outside, join(workspace, "link"), "junction");
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const broker = (inlineDelivery?: { maxBytes: number }) => {
    const value = new ToolBroker({ permissionProfile: "full", workspacePath: workspace, artifacts });
    for (const tool of createImageTools({ artifacts, ...(inlineDelivery ? { inlineDelivery } : {}) })) value.register(tool);
    return value;
  };
  const mcp = broker({ maxBytes: REMOTE_IMAGE_LIMITS.maxBytes }), build = broker();
  let call = 0;
  const invoke = (target: ToolBroker, args: Record<string, unknown>) => target.invoke({ type: "tool_call", callId: `img-${++call}`, name: "image.inspect", arguments: args },
    { runId: "run", sessionId: "s", actor: { role: "worker", id: "w" }, workspacePath: workspace, imageInput: true });
  return { root, workspace, outside, artifacts, mcp, build, invoke, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("on an MCP surface image.inspect delivers within the surface's byte limit and says it is not attached until it is", async () => {
  const f = workspaceFixture();
  try {
    const result = await f.invoke(f.mcp, { path: "noise.png" });
    assert.equal(result.isError, false, JSON.stringify(result));
    const meta = json(result) as { shown: boolean; reason?: string; delivery?: string; delivered: { artifactHash: string; byteLength: number; width: number; height: number }; notes?: string[] };
    // Only mcpImageContent, which puts the image block in the result, may say the image is there.
    assert.equal(meta.shown, false);
    assert.equal(meta.reason, "image_not_attached");
    assert.equal(meta.delivery, undefined);
    assert.ok(meta.delivered.byteLength <= REMOTE_IMAGE_LIMITS.maxBytes, `${meta.delivered.byteLength} bytes`);
    assert.match((meta.notes ?? []).join(" "), new RegExp(`Reduced to ${meta.delivered.width}x${meta.delivered.height} to fit the ${REMOTE_IMAGE_LIMITS.maxBytes}-byte limit`));
    const visual = result.content.find((block) => block.type === "artifact");
    assert.ok(visual?.type === "artifact" && visual.visual, "the derivative stays a visual artifact until the connector inlines it");
    assert.equal(visual.hash, meta.delivered.artifactHash);
    assert.equal((await f.artifacts.get(visual.hash)).byteLength, meta.delivered.byteLength);
    // A small image goes as it is, with no note about the limit.
    const flat = json(await f.invoke(f.mcp, { path: "flat.png" })) as { notes?: string[]; delivered: { width: number } };
    assert.equal(flat.delivered.width, 64);
    assert.equal(flat.notes, undefined);
    // Build's image.inspect (no inline delivery) keeps the provider limits and its next-turn delivery.
    const built = json(await f.invoke(f.build, { path: "noise.png" })) as { delivery: string; delivered: { width: number }; notes?: string[] };
    assert.equal(built.delivery, "native image input in your next turn");
    assert.equal(built.delivered.width, 400);
    assert.equal(built.notes, undefined);
  } finally { f.cleanup(); }
});

test("on an MCP surface only a whole image is sent: a truncated PNG, JPEG or WebP is refused", async () => {
  const f = workspaceFixture();
  try {
    const whole = noisePng(150, 150);
    const files: Record<string, Buffer> = {
      // As a command that is still writing the file leaves it: the first 40 000 bytes, within every size limit.
      "cut.png": whole.subarray(0, 40_000), "whole.png": whole,
      "cut-interlaced.png": interlaced(flatPng(32, 32)).subarray(0, 60), "whole-interlaced.png": interlaced(flatPng(32, 32)),
      "cut.jpg": jpeg(64, 48, 5_000).subarray(0, 4_000), "whole.jpg": jpeg(64, 48, 5_000),
      "cut.webp": webp(1_000), "whole.webp": webp(),
    };
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(f.workspace, name), bytes);
    for (const name of Object.keys(files)) {
      const result = await f.invoke(f.mcp, { path: name });
      if (name.startsWith("whole")) { assert.equal(result.isError, false, `${name}: ${JSON.stringify(result)}`); continue; }
      assert.equal(result.error?.code, "image_corrupt", `${name}: ${JSON.stringify(result)}`);
      assert.match(result.error!.message, /truncated or corrupt, so it was not sent; if a command is still writing it/);
      assert.equal(result.content.some((block) => block.type === "artifact"), false, name);
    }
  } finally { f.cleanup(); }
});

test("image.inspect keeps its path rules on the MCP surfaces: nothing outside the workspace, by .., absolute path or link", async () => {
  const f = workspaceFixture();
  try {
    for (const path of ["../outside/secret.png", join(f.outside, "secret.png"), "link/secret.png", "link/../../outside/secret.png"]) {
      const refused = await f.invoke(f.mcp, { path });
      assert.equal(refused.isError, true, path);
      assert.equal(refused.error?.code, "image_outside_workspace", `${path}: ${JSON.stringify(refused)}`);
      assert.equal(refused.content.some((block) => block.type === "artifact"), false, path);
    }
  } finally { f.cleanup(); }
});

test("mcpImageContent converts at most the limit of verified images and keeps every other block", async () => {
  const root = mkdtempSync(join(tmpdir(), "mcp-image-"));
  try {
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    const first = flatPng(4, 4), second = flatPng(6, 6);
    const a = await artifacts.put(first, "image/png"), b = await artifacts.put(second, "image/png");
    const visual = (hash: string, mediaType = "image/png"): ToolContentBlock => ({ type: "artifact", hash, mediaType, visual: { width: 4, height: 4, sourceDigest: hash } });
    const read = async (hash: string) => await artifacts.get(hash);
    const limits = { maxBytes: 1_000, maxImages: 1 };
    const meta: ToolContentBlock = { type: "json", value: { shown: true } };
    const plain: ToolContentBlock = { type: "artifact", hash: b.hash, mediaType: "image/png" };
    const converted = await mcpImageContent([meta, visual(a.hash), visual(b.hash), plain], read, limits);
    assert.deepEqual(converted, [meta, { type: "image", data: first.toString("base64"), mimeType: "image/png" } satisfies McpImageContent, visual(b.hash), plain],
      "one image per call; a second visual artifact and a plain artifact stay references");
    assert.equal((await mcpImageContent([meta, visual(a.hash), visual(b.hash)], read, { maxBytes: 1_000, maxImages: 2 }))?.filter((block) => block.type === "image").length, 2);
    // image.inspect's "not attached" JSON says the image is in the result once it is.
    const pending: ToolContentBlock = { type: "json", value: { shown: false, reason: "image_not_attached", source: { path: "a.png" } } };
    assert.deepEqual((await mcpImageContent([pending, visual(a.hash)], read, limits))?.[0],
      { type: "json", value: { shown: true, delivery: "image content in this result", source: { path: "a.png" } } });
    assert.equal(await mcpImageContent([pending, visual(a.hash)], async () => second, limits), undefined, "not attached, so the JSON is left as it is");
    // Nothing converted is undefined: over the byte limit, bytes that no longer match the address, a wrong media type, an unreadable artifact.
    assert.equal(await mcpImageContent([visual(a.hash)], read, { maxBytes: first.byteLength - 1, maxImages: 1 }), undefined);
    assert.equal(await mcpImageContent([visual(a.hash)], async () => second, limits), undefined);
    assert.equal(await mcpImageContent([visual(a.hash, "image/jpeg")], read, limits), undefined);
    assert.equal(await mcpImageContent([visual("f".repeat(64))], read, limits), undefined);
    assert.equal(await mcpImageContent([plain, meta], read, limits), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("the Remote runtime asks image.inspect for MCP delivery within the Remote limit (stub host: nothing starts)", async () => {
  const f = workspaceFixture(join(process.cwd(), "runner-v2", "test"));
  const state = join(f.root, "state");
  mkdirSync(state);
  // createGovernedBinding's needs: a recovery that found nothing, a run folder for its ledger, the broker's own in-memory
  // grant authority and inert process services. No git context: the broker then runs the tool directly.
  const binding = {
    runRoot: state, git: undefined, executionGrants: createExecutionGrantAuthority(), commandExecution: {}, managedProcesses: { listRun: async () => [] },
    recover: async () => ({ subprocess: [], streaming: { outcomes: [], sessionOutcomes: [], lateCleanupFailures: [] }, isolation: [] }),
    close: async () => undefined,
  } as unknown as ExecutionHostRunBinding;
  const host = { artifacts: f.artifacts, bindRun: async () => binding } as unknown as ExecutionHost;
  const principals = new RemotePrincipalStore(join(state, "principals.sqlite"));
  const runtime = new RemoteToolRuntime({ host, principals, workspacePath: f.workspace, permissionProfile: "full", capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
  const alice = { accountId: "account", clientId: "client-a", deviceId: "device" };
  try {
    const result = await runtime.invoke(alice, "image.inspect", { path: "noise.png" });
    assert.equal(result.isError, false, `a Remote client is not a text-only model: ${JSON.stringify(result)}`);
    const meta = json(result) as { shown: boolean; reason?: string; delivered: { byteLength: number } };
    // Prepared for the connector, which attaches it (the connector tests below).
    assert.equal(meta.reason, "image_not_attached");
    assert.ok(result.content.some((block) => block.type === "artifact" && block.visual));
    assert.ok(meta.delivered.byteLength <= REMOTE_IMAGE_LIMITS.maxBytes, `${meta.delivered.byteLength} bytes`);
    assert.equal((await runtime.invoke(alice, "image.inspect", { path: "link/secret.png" })).error?.code, "image_outside_workspace");
    assert.equal((await runtime.invoke(alice, "image.inspect", { artifactHash: "a".repeat(64) })).error?.code, "tool_unavailable");
  } finally {
    await runtime.close();
    principals.close();
    f.cleanup();
  }
});

// ---------------------------------------------------------------- connector: the stored result and its jobs_result page

const ACCOUNT = "account";
const CLIENT = "client-a";
const relayKey = generateKeyPairSync("ed25519");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

class Transport implements RemoteTransport {
  readonly sent: RemoteTransportMessage[] = [];
  private handler?: (message: RemoteTransportMessage) => void | Promise<void>;
  onProof?: () => void;
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  send(message: RemoteTransportMessage): void {
    this.sent.push(message);
    if (message.type === "proof") this.onProof?.();
  }
  onMessage(handler: (message: RemoteTransportMessage) => void | Promise<void>): void { this.handler = handler; }
  onClose(): void {}
  emit(message: RemoteTransportMessage): Promise<void> { return Promise.resolve(this.handler?.(message)); }
  response(requestId: string) {
    return this.sent.find((frame): frame is Extract<RemoteTransportMessage, { type: "response" }> => frame.type === "response" && frame.response.requestId === requestId);
  }
}

async function connector(t: test.TestContext, results: (name: string) => ToolResult | Promise<ToolResult>) {
  const root = mkdtempSync(join(tmpdir(), "remote-image-connector-"));
  const now = Date.parse("2026-11-14T12:00:00.000Z");
  const clock = () => new Date(now);
  const deviceStore = new RemoteDeviceStore(root);
  const device = deviceStore.ensure(ACCOUNT);
  const session: RemoteDeviceSession = {
    accountId: ACCOUNT, clientId: CLIENT, scope: REMOTE_CONNECT_SCOPE, issuedAt: clock().toISOString(),
    relayKeys: [{ keyId: "relay", publicKey: relayKey.publicKey.export({ type: "spki", format: "der" }).toString("base64url") }],
    authorizedScopes: ["scope"],
  };
  const admission = new RemoteAdmissionStore(join(root, "jobs.sqlite"), Buffer.alloc(32, 9), clock);
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runtime: RemoteRequestRuntime = {
    invoke: async (_identity, name) => await results(name),
    invokeAdmitted: async (_identity, name) => ({ result: await results(name), brokerInvoked: true }),
    latestPolicyNarrowing: () => undefined,
  };
  const transport = new Transport();
  const remote = new RemoteConnector({
    deviceStore, authenticator: new RemoteAuthenticator(deviceStore, { now: clock }), admission, runtime, session, artifacts,
    createTransport: () => transport, reconcile: async () => { admission.reconcileStartup(); },
    now: clock, reconnect: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 0 }, drainTimeoutMs: 20,
  });
  t.after(async () => {
    await remote.close().catch(() => undefined);
    admission.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const started = remote.start();
  await tick();
  transport.onProof = () => { void transport.emit({ type: "authenticated", epoch: "5" }); };
  const challenge = { audience: REMOTE_RELAY_AUDIENCE, accountId: ACCOUNT, deviceId: device.deviceId, scope: REMOTE_CONNECT_SCOPE,
    nonce: "challenge-1", epoch: "5", expiresAt: new Date(now + 60_000).toISOString() };
  await transport.emit({ type: "challenge", challenge, keyId: "relay", signature: sign(null, Buffer.from(canonicalJson(challenge)), relayKey.privateKey).toString("base64url") });
  await started;
  let number = 0;
  async function send(toolId: string, payload: Record<string, unknown>) {
    const id = ++number;
    const request: RemoteRequest = { protocolVersion: "1.0.0", requestId: "request-" + id, traceId: "trace-" + id,
      accountId: ACCOUNT, clientId: CLIENT, deviceId: device.deviceId, deviceEpoch: "5", toolId, operationClass: "read", scopeRef: "scope",
      issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
      nonce: "nonce-" + id, idempotencyKey: "key-" + id, payloadDigest: "", payload };
    request.payloadDigest = remotePayloadDigest(request);
    const claims = { audience: REMOTE_RELAY_AUDIENCE, accountId: ACCOUNT, clientId: CLIENT, deviceId: device.deviceId, deviceEpoch: "5",
      scopeRef: "scope", toolId, operationClass: "read", requestId: request.requestId, nonce: request.nonce, payloadDigest: request.payloadDigest,
      issuedAt: request.issuedAt, expiresAt: request.expiresAt };
    const authorization: RemoteAuthorization = { version: 1, keyId: "relay", claims, signature: sign(null, Buffer.from(canonicalJson(claims)), relayKey.privateKey).toString("base64url") };
    await transport.emit({ type: "request", request, authorization });
    for (let attempt = 0; attempt < 5_000 && !transport.response(request.requestId); attempt++) await new Promise<void>((resolve) => setTimeout(resolve, 2));
    const response = transport.response(request.requestId);
    assert.ok(response, `no response to ${toolId}`);
    return response;
  }
  /** Runs one tool call to settlement, then reads its result as the relay does: jobs_result with only the jobId. */
  async function call(toolId: string, payload: Record<string, unknown>) {
    const jobId = (await send(toolId, payload)).response.jobId!;
    const identity = { accountId: ACCOUNT, clientId: CLIENT, deviceId: device.deviceId };
    for (let attempt = 0; attempt < 5_000 && ["queued", "running"].includes(admission.getJob(identity, jobId)?.state ?? "queued"); attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    const page = await send("jobs_result", { jobId });
    const data = page.data as { inline: string; encoding: string; nextCursor?: string };
    return { page, data, stored: Buffer.from(data.inline, "base64") };
  }
  return { artifacts, call };
}

/** What the relay does with a one-page result (mcp-gateway.ts contentBlocks): an image block goes to the client as it is. */
function clientContent(stored: Buffer): Array<Record<string, unknown>> {
  return (JSON.parse(stored.toString("utf8")) as { content: Array<Record<string, unknown>> }).content;
}

test("an image_inspect result reaches the relay as MCP image content in one jobs_result page", async (t) => {
  const f = workspaceFixture();
  t.after(() => f.cleanup());
  let produced: ToolResult | undefined;
  const h = await connector(t, async (name) => {
    // The real tool, as the Remote binding configures it, writing into the connector's artifact store.
    const broker = new ToolBroker({ permissionProfile: "full", workspacePath: f.workspace, artifacts: h.artifacts });
    for (const tool of createImageTools({ artifacts: h.artifacts, inlineDelivery: { maxBytes: REMOTE_IMAGE_LIMITS.maxBytes } })) broker.register(tool);
    produced = await broker.invoke({ type: "tool_call", callId: "c", name, arguments: { path: "noise.png" } },
      { runId: "run", sessionId: "s", actor: { role: "worker", id: "w" }, workspacePath: f.workspace, imageInput: true });
    return produced;
  });
  const { page, data, stored } = await h.call("image_inspect", { path: "noise.png" });
  assert.equal(page.response.status, "completed");
  assert.equal(data.nextCursor, undefined, "one page, which the relay decodes into MCP content");
  assert.ok(stored.byteLength <= INLINE_RESULT_MAX_BYTES);
  assert.ok(frameByteLength(page) <= DEFAULT_REMOTE_FRAME_LIMITS.maxFrameBytes);
  const content = clientContent(stored);
  const image = content.find((block) => block.type === "image") as { data: string; mimeType: string } | undefined;
  assert.ok(image, JSON.stringify(content).slice(0, 500));
  assert.equal(image.mimeType, "image/png");
  const bytes = Buffer.from(image.data, "base64");
  const delivered = (json(produced!) as { delivered: { artifactHash: string; byteLength: number } }).delivered;
  assert.equal(sha256(bytes), delivered.artifactHash, "the client gets exactly the bounded derivative");
  assert.ok(bytes.byteLength <= REMOTE_IMAGE_LIMITS.maxBytes);
  assert.equal(content.some((block) => block.type === "artifact"), false, "no second copy as a reference");
  const meta = (content.find((block) => block.type === "json") as { value: Record<string, unknown> }).value;
  assert.deepEqual([meta.shown, meta.delivery, meta.reason], [true, "image content in this result", undefined], "it says the image is there because it is");
});

test("a result the image would push over the inline limit keeps its reference and says the image is not attached", async (t) => {
  // An image of exactly REMOTE_IMAGE_LIMITS.maxBytes and 30 000 bytes of notes: with the image inline, past 256 KiB.
  const image = flatPng(4, 4);
  const padded = Buffer.concat([image, Buffer.alloc(REMOTE_IMAGE_LIMITS.maxBytes - image.byteLength, 0x42)]);
  let hash = "";
  const h = await connector(t, (name) => ({ callId: "c", toolName: name, isError: false, content: [
    { type: "json", value: { shown: false, reason: "image_not_attached", source: { path: "shot.png" }, notes: ["n".repeat(30_000)] } },
    { type: "artifact", hash, mediaType: "image/png", label: "Image shot.png", visual: { width: 4, height: 4, sourceDigest: hash } },
  ] }));
  hash = (await h.artifacts.put(padded, "image/png")).hash;
  const { page, data, stored } = await h.call("image_inspect", { path: "shot.png" });
  // Stored inline as it was: had the image gone in anyway, the admission store refuses the result and the job is outcome_unknown.
  assert.equal(page.response.status, "completed");
  assert.equal(data.nextCursor, undefined);
  const content = clientContent(stored);
  assert.equal(content.some((block) => block.type === "image"), false);
  assert.equal((content.find((block) => block.type === "artifact") as { hash?: string } | undefined)?.hash, hash, "artifacts_read still reads it");
  const meta = (content.find((block) => block.type === "json") as { value: Record<string, unknown> }).value;
  assert.deepEqual([meta.shown, meta.reason, meta.delivery], [false, "image_not_attached", undefined]);
});

test("the largest Remote image still fits one inline result and one frame", async (t) => {
  // An image of exactly REMOTE_IMAGE_LIMITS.maxBytes, with a long path in the result, the worst case for the inline limit.
  const image = flatPng(4, 4);
  const padded = Buffer.concat([image, Buffer.alloc(REMOTE_IMAGE_LIMITS.maxBytes - image.byteLength, 0x42)]);
  let hash = "";
  const h = await connector(t, (name) => ({ callId: "c", toolName: name, isError: false, content: [
    { type: "json", value: { shown: false, reason: "image_not_attached", source: { path: "a/".repeat(1_000) + "shot.png" } } },
    { type: "artifact", hash, mediaType: "image/png", label: "Image shot.png", visual: { width: 4, height: 4, sourceDigest: hash } },
  ] }));
  hash = (await h.artifacts.put(padded, "image/png")).hash;
  const { page, data, stored } = await h.call("image_inspect", { path: "shot.png" });
  assert.equal(data.nextCursor, undefined);
  assert.ok(stored.byteLength <= INLINE_RESULT_MAX_BYTES, `${stored.byteLength} bytes`);
  assert.ok(frameByteLength(page) <= DEFAULT_REMOTE_FRAME_LIMITS.maxFrameBytes);
  const inlined = clientContent(stored).find((block) => block.type === "image") as { data: string } | undefined;
  assert.ok(inlined && Buffer.from(inlined.data, "base64").equals(padded));
  assert.equal((clientContent(stored)[0] as { value: { delivery?: string } }).value.delivery, "image content in this result");
});

test("only image_inspect is inlined and paged whole; a changed artifact stays a reference", async (t) => {
  const png = flatPng(4, 4);
  let hash = "";
  const visual = (): ToolContentBlock => ({ type: "artifact", hash, mediaType: "image/png", visual: { width: 4, height: 4, sourceDigest: hash } });
  const h = await connector(t, (name) => ({ callId: "c", toolName: name, isError: false,
    content: name === "fs.read" ? [visual(), { type: "text", text: "x".repeat(100 * 1024) }] : [visual()] }));
  const stored = await h.artifacts.put(png, "image/png");
  hash = stored.hash;
  // Any other tool keeps its artifact references and its 64 KiB pages.
  const read = await h.call("files_read", { path: "big.txt" });
  assert.ok(read.data.nextCursor, "a 100 KiB text result still comes in pages");
  assert.match(read.stored.toString("utf8"), /"type":"artifact"/);
  assert.doesNotMatch(read.stored.toString("utf8"), /"type":"image"/);
  // An artifact whose bytes no longer match their address is never sent as an image.
  writeFileSync((await h.artifacts.stat(hash)).path, flatPng(5, 5));
  const changed = clientContent((await h.call("image_inspect", { path: "shot.png" })).stored);
  assert.equal(changed.some((block) => block.type === "image"), false);
  assert.equal((changed[0] as { hash?: string }).hash, hash);
});
