import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { WebSocketServer, type WebSocket as ServerSocket } from "ws";

import type { ToolResult } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { canonicalJson, RemoteAdmissionStore, remotePayloadDigest, type RemoteRequest } from "../src/remote-admission-store.js";
import { RemoteAuthenticator, REMOTE_CONNECT_SCOPE, REMOTE_RELAY_AUDIENCE, verifyDeviceProof, type RemoteAuthorization } from "../src/remote-auth.js";
import { RemoteConnector, type RemoteRequestRuntime, type RemoteTransportMessage } from "../src/remote-connector.js";
import { RemoteDeviceStore, type RemoteDeviceSession } from "../src/remote-device-store.js";
import { REMOTE_FRAME_MIN_BYTES } from "../src/remote-frame-codec.js";
import { RemoteRelayUrlError, validateRelayUrl, WebSocketRemoteTransport } from "../src/remote-websocket-transport.js";
import { parseArguments } from "../src/runner-start.js";

const ACCOUNT = "account";
const CLIENT = "client-a";
const relayKey = generateKeyPairSync("ed25519");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function until(condition: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail("condition not reached");
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

test("relay URLs: TLS off loopback, never credentials, query tokens or fragments", () => {
  for (const ok of ["wss://mcp.aiboard.me/connect", "ws://127.0.0.1:8788/connect", "ws://localhost:1/connect", "ws://[::1]:2/connect"]) {
    assert.doesNotThrow(() => validateRelayUrl(ok), ok);
  }
  for (const bad of ["ws://mcp.aiboard.me/connect", "ws://10.0.0.5/connect", "https://mcp.aiboard.me/connect",
    "wss://mcp.aiboard.me/connect?token=abc", "wss://mcp.aiboard.me/connect?", "wss://mcp.aiboard.me/connect#x",
    "wss://user:pass@mcp.aiboard.me/connect", "wss://user@mcp.aiboard.me/connect", "not a url", "ws://127.0.0.1.evil.example/connect"]) {
    assert.throws(() => validateRelayUrl(bad), RemoteRelayUrlError, bad);
  }
  assert.throws(() => new WebSocketRemoteTransport({ url: "ws://example.com/connect" }), RemoteRelayUrlError);
  for (const deviceId of ["", "a/b", "../x", "d?x", "d#x", "x".repeat(257)]) {
    assert.throws(() => new WebSocketRemoteTransport({ url: "wss://mcp.aiboard.me/connect", deviceId }), RemoteRelayUrlError, deviceId);
  }
});

test("--relay-url is validated and requires --remote", () => {
  const base = ["--project", join(tmpdir(), "p"), "--state-dir", join(tmpdir(), "s")];
  const remote = [...base, "--remote", "--remote-device-dir", join(tmpdir(), "d")];
  assert.equal(parseArguments([...remote, "--relay-url", "wss://mcp.aiboard.me/connect"]).remoteRelayUrl, "wss://mcp.aiboard.me/connect");
  assert.equal(parseArguments(remote).remoteRelayUrl, undefined);
  assert.throws(() => parseArguments([...base, "--relay-url", "wss://mcp.aiboard.me/connect"]), /requires --remote/);
  assert.throws(() => parseArguments([...remote, "--relay-url", "wss://mcp.aiboard.me/connect?token=x"]), /invalid_arguments: Relay URL must not carry a query/);
  assert.throws(() => parseArguments([...remote, "--relay-url", "ws://mcp.aiboard.me/connect"]), /invalid_arguments/);
});

test("sends wait while the socket send buffer is over its bound", async () => {
  const listeners = new Map<string, (event: unknown) => void>();
  const socket = {
    readyState: 1, bufferedAmount: 0, sent: [] as string[],
    send(data: string) { this.sent.push(data); this.bufferedAmount += 10_000_000; },
    close() { listeners.get("close")?.({}); },
    addEventListener(type: string, listener: (event: unknown) => void) { listeners.set(type, listener); },
  };
  const transport = new WebSocketRemoteTransport({ url: "ws://127.0.0.1:1/connect", maxBufferedBytes: 1_000, createSocket: () => socket as unknown as WebSocket });
  const connected = transport.connect();
  listeners.get("open")?.({});
  await connected;
  let finished = false;
  const sending = transport.send({ type: "heartbeat", at: "x" }).then(() => { finished = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(finished, false, "the send is held while the buffer is over its bound");
  socket.bufferedAmount = 0;
  await sending;
  assert.equal(finished, true);
});

/** A minimal relay: challenge → verify the device proof → authenticated with limits; records every frame. */
async function fakeRelay(t: test.TestContext, deviceKey: () => string, deviceId: () => string, limits: unknown) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const received: Record<string, unknown>[] = [];
  const paths: string[] = [];
  let socket: ServerSocket | undefined;
  let proofs = 0;
  const challenge = () => ({
    audience: REMOTE_RELAY_AUDIENCE, accountId: ACCOUNT, deviceId: deviceId(), scope: REMOTE_CONNECT_SCOPE,
    nonce: "challenge-" + randomBytes(4).toString("hex"), epoch: "5", expiresAt: new Date(Date.parse("2026-10-27T12:01:00Z")).toISOString(),
  });
  server.on("connection", (connection, request) => {
    paths.push(request.url ?? "");
    socket = connection;
    const issued = challenge();
    connection.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      received.push(frame);
      if (frame.type === "proof") {
        proofs += 1;
        const ok = verifyDeviceProof(deviceKey(), issued, String(frame.signature));
        connection.send(JSON.stringify(ok ? { type: "authenticated", epoch: "5", limits } : { type: "auth_error", code: "unauthorized" }));
      }
      if (frame.type === "chunk") connection.send(JSON.stringify({ type: "chunk_ack", transferId: frame.transferId, seq: frame.seq }));
    });
    connection.send(JSON.stringify({ type: "challenge", challenge: issued }));
  });
  t.after(async () => { for (const client of server.clients) client.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return {
    url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}/connect`,
    received, paths, get proofs() { return proofs; },
    send(frame: unknown) { socket!.send(typeof frame === "string" ? frame : JSON.stringify(frame)); },
    drop() { socket!.terminate(); },
    response(requestId: string) {
      return received.find((frame) => frame.type === "response" && (frame.response as { requestId: string }).requestId === requestId) as
        Extract<RemoteTransportMessage, { type: "response" }> | undefined;
    },
  };
}

test("the connector runs end to end over a real WebSocket: handshake, limits, request, artifact stream, frame refusal, socket loss", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-r4d-"));
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
  deviceStore.saveSession(session);
  const admission = new RemoteAdmissionStore(join(state, "jobs.sqlite"), Buffer.alloc(32, 3), clock);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const blob = randomBytes(300 * 1024);
  const hash = (await artifacts.put(blob, "application/octet-stream")).hash;
  const runtime: RemoteRequestRuntime = {
    invoke: async (_identity, name): Promise<ToolResult> => ({ callId: "c", toolName: name, isError: false,
      content: [{ type: "artifact", hash, mediaType: "application/octet-stream" }] }),
  };
  const relay = await fakeRelay(t, () => deviceStore.load()!.publicKey, () => device.deviceId, { maxFrameBytes: REMOTE_FRAME_MIN_BYTES, window: 2 });
  const connector = new RemoteConnector({
    deviceStore, authenticator: new RemoteAuthenticator(deviceStore, { now: clock }), admission, runtime, session,
    createTransport: ({ deviceId }) => new WebSocketRemoteTransport({ url: relay.url, deviceId }),
    reconcile: async () => { admission.reconcileStartup(); },
    now: clock, reconnect: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 0 }, drainTimeoutMs: 20, artifacts,
  });
  t.after(async () => {
    await connector.close().catch(() => undefined);
    admission.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await connector.start();
  assert.equal(connector.isReady(), true);
  assert.equal(relay.proofs, 1);
  assert.deepEqual(relay.paths, [`/connect/${device.deviceId}`], "the device route is addressed by path, never by query");
  const proof = relay.received.find((frame) => frame.type === "proof")!;
  assert.equal(JSON.stringify(proof).includes("token"), false);

  let counter = 0;
  const signed = (patch: Partial<RemoteRequest>) => {
    counter += 1;
    const request: RemoteRequest = {
      protocolVersion: "1.0.0", requestId: "request-" + counter, traceId: "trace-" + counter, accountId: ACCOUNT, clientId: CLIENT,
      deviceId: device.deviceId, deviceEpoch: "5", toolId: "files_read", operationClass: "read", scopeRef: "scope",
      issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60_000).toISOString(),
      nonce: "nonce-" + counter, idempotencyKey: "key-" + counter, payloadDigest: "", payload: { path: "a" }, ...patch,
    };
    request.payloadDigest = remotePayloadDigest(request);
    const claims = {
      audience: REMOTE_RELAY_AUDIENCE, accountId: request.accountId, clientId: request.clientId, deviceId: request.deviceId,
      deviceEpoch: request.deviceEpoch, scopeRef: request.scopeRef, toolId: request.toolId, operationClass: request.operationClass,
      requestId: request.requestId, nonce: request.nonce, payloadDigest: request.payloadDigest, issuedAt: request.issuedAt, expiresAt: request.expiresAt,
    };
    const authorization: RemoteAuthorization = { version: 1, keyId: "relay", claims, signature: sign(null, Buffer.from(canonicalJson(claims)), relayKey.privateKey).toString("base64url") };
    relay.send({ type: "request", request, authorization });
    return request;
  };

  const read = signed({});
  await until(() => relay.response(read.requestId) !== undefined);
  const jobId = relay.response(read.requestId)!.response.jobId!;
  await until(() => admission.getJob({ accountId: ACCOUNT, clientId: CLIENT, deviceId: device.deviceId }, jobId)?.state === "completed");

  const transfer = signed({ toolId: "artifacts_read", payload: { jobId, hash } });
  await until(() => relay.received.some((frame) => frame.type === "artifact_end" && frame.transferId === transfer.requestId));
  const chunks = relay.received.filter((frame) => frame.type === "chunk" && frame.transferId === transfer.requestId);
  const bytes = Buffer.concat(chunks.map((frame) => Buffer.from(String(frame.data), "base64")));
  assert.ok(bytes.equals(blob), "artifact arrives byte-exact over the socket");
  assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
  assert.ok(chunks.length > 4, "64 KiB frames force several chunks");

  // A frame over the negotiated maximum is refused by length and the session keeps serving.
  relay.send(JSON.stringify({ type: "heartbeat", at: "x".repeat(REMOTE_FRAME_MIN_BYTES) }));
  relay.send("{not json");
  await until(() => relay.received.filter((frame) => frame.type === "frame_error").length === 2);
  assert.deepEqual(relay.received.filter((frame) => frame.type === "frame_error").map((frame) => frame.code), ["frame_too_large", "malformed_frame"]);
  const status = signed({ toolId: "jobs_status", payload: { jobId } });
  await until(() => relay.response(status.requestId) !== undefined);
  assert.equal(relay.response(status.requestId)!.response.admitted, true);

  // Socket loss is observed as a disconnect, never as readiness.
  relay.drop();
  await until(() => connector.state().state === "disconnected");
  assert.equal(connector.isReady(), false);
  await tick();
});
