import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { ToolResult } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { ControlServer } from "../src/control-server.js";
import { createExecutionHost } from "../src/execution-host.js";
import { parseLauncherArguments, runnerSpawnArguments } from "../src/launcher.js";
import { projectDataDirectory, remoteDeviceDirectory } from "../src/launcher-instance.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import {
  RemoteAdmissionStore,
  remotePayloadDigest,
  type RemoteRequest,
} from "../src/remote-admission-store.js";
import {
  RemoteAuthenticator,
  verifyDeviceProof,
  REMOTE_CONNECT_SCOPE,
  REMOTE_RELAY_AUDIENCE,
  type RelayChallenge,
  type RemoteSessionIssuer,
} from "../src/remote-auth.js";
import {
  RemoteConnector,
  type RemoteRequestRuntime,
  type RemoteTransport,
  type RemoteTransportMessage,
} from "../src/remote-connector.js";
import { RemoteDeviceStore, type RemoteDeviceSession } from "../src/remote-device-store.js";
import { RemoteService } from "../src/remote-service.js";
import { composeRemoteRuntime, closeRemoteComposition } from "../src/runner-composition.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { FileStorageKeyProvider } from "../src/storage-key.js";

const ACCOUNT = "account-1";
const CLIENT = "client-1";
const fixedNow = new Date("2026-10-27T12:00:00Z");
const clock = () => new Date(fixedNow);

const testSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 25)));

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function temporary(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "aiboard-r1d-"));
  return root;
}

class FakeTransport implements RemoteTransport {
  readonly sent: RemoteTransportMessage[] = [];
  closed = false;
  failClose = false;
  connectCount = 0;
  onProof: ((proof: { deviceId: string; publicKey: string; signature: string }) => void) | undefined;
  private handler: ((message: RemoteTransportMessage) => void | Promise<void>) | undefined;
  private closeHandler: (() => void) | undefined;

  async connect(): Promise<void> { this.connectCount += 1; }

  /** Simulate socket loss without a clean close. */
  drop(): void {
    this.closeHandler?.();
  }

  async close(): Promise<void> {
    if (this.failClose) throw new Error("injected transport close failure");
    this.closed = true;
    this.closeHandler?.();
  }

  send(message: RemoteTransportMessage): void {
    this.sent.push(message);
    if (message.type === "proof") this.onProof?.(message);
  }

  onMessage(handler: (message: RemoteTransportMessage) => void | Promise<void>): void {
    this.handler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  emit(message: RemoteTransportMessage): Promise<void> {
    return Promise.resolve(this.handler?.(message));
  }

  responses(): Extract<RemoteTransportMessage, { type: "response" }>[] {
    return this.sent.filter((message): message is Extract<RemoteTransportMessage, { type: "response" }> => message.type === "response");
  }
}

interface Harness {
  root: string;
  state: string;
  deviceStore: RemoteDeviceStore;
  session: RemoteDeviceSession;
  authenticator: RemoteAuthenticator;
  admission: RemoteAdmissionStore;
  transport: FakeTransport;
  challenge: RelayChallenge;
  dispatches: { count: number; results: ToolResult[] };
  runtime: RemoteRequestRuntime;
  connector: RemoteConnector;
}

function sessionFor(): RemoteDeviceSession {
  return { accountId: ACCOUNT, clientId: CLIENT, scope: REMOTE_CONNECT_SCOPE, issuedAt: fixedNow.toISOString() };
}

function challengeFor(deviceId: string, overrides: Partial<RelayChallenge> = {}): RelayChallenge {
  return {
    audience: REMOTE_RELAY_AUDIENCE,
    accountId: ACCOUNT,
    deviceId,
    scope: REMOTE_CONNECT_SCOPE,
    nonce: "nonce-1",
    epoch: "5",
    expiresAt: new Date(fixedNow.getTime() + 5 * 60_000).toISOString(),
    ...overrides,
  };
}

function stubRuntime(dispatches: Harness["dispatches"]): RemoteRequestRuntime {
  return {
    invoke: async (_identity, name) => {
      dispatches.count += 1;
      const result: ToolResult = name.startsWith("fs.write") || name.startsWith("process.")
        ? { callId: "call", toolName: name, content: [{ type: "json", value: { jobId: "job-stub", status: "completed" } }], isError: false }
        : { callId: "call", toolName: name, content: [{ type: "text", text: "ok" }], isError: false };
      dispatches.results.push(result);
      return result;
    },
  };
}

/** Device + admission + connector with a stub runtime (no ExecutionHost). */
async function stubHarness(t: test.TestContext, options: {
  reconcile?: () => Promise<void>;
  isOwnerLockHeld?: () => boolean;
  onShutdownStep?: (step: string) => void;
  drainTimeoutMs?: number;
  runtime?: RemoteRequestRuntime;
} = {}): Promise<Harness> {
  const root = await temporary();
  const state = join(root, "state");
  await mkdir(state, { recursive: true });
  const deviceStore = new RemoteDeviceStore(state);
  const identity = deviceStore.ensure(ACCOUNT);
  const session = sessionFor();
  deviceStore.saveSession(session);
  const authenticator = new RemoteAuthenticator(deviceStore, { now: clock });
  const admission = new RemoteAdmissionStore(join(state, "remote-admission.sqlite"), Buffer.alloc(32, 7), clock);
  const transport = new FakeTransport();
  const dispatches = { count: 0, results: [] as ToolResult[] };
  const runtime = options.runtime ?? stubRuntime(dispatches);
  const connector = new RemoteConnector({
    deviceStore, authenticator, admission, runtime, session,
    createTransport: () => transport,
    reconcile: options.reconcile ?? (async () => { admission.reconcileStartup(); }),
    now: clock,
    sleep: testSleep,
    handshakeTimeoutMs: 60_000,
    ...(options.isOwnerLockHeld ? { isOwnerLockHeld: options.isOwnerLockHeld } : {}),
    ...(options.onShutdownStep ? { onShutdownStep: options.onShutdownStep } : {}),
    ...(options.drainTimeoutMs !== undefined ? { drainTimeoutMs: options.drainTimeoutMs } : {}),
  });
  t.after(async () => {
    await connector.close().catch(() => undefined);
    admission.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, state, deviceStore, session, authenticator, admission, transport, challenge: challengeFor(identity.deviceId), dispatches, runtime, connector };
}

/** Drive one handshake; the fake relay verifies the Ed25519 proof first. */
async function handshake(harness: Harness, challenge: RelayChallenge = harness.challenge): Promise<void> {
  const started = harness.connector.start();
  await tick(); await tick();
  harness.transport.onProof = (proof) => {
    const ok = verifyDeviceProof(harness.deviceStore.load()!.publicKey, challenge, proof.signature);
    void harness.transport.emit(ok ? { type: "authenticated", epoch: challenge.epoch } : { type: "auth_error", code: "unauthorized" });
  };
  await harness.transport.emit({ type: "challenge", challenge });
  await started;
}

let requestCounter = 0;
function makeRequest(deviceId: string, overrides: Partial<RemoteRequest> = {}): RemoteRequest {
  requestCounter += 1;
  const request: RemoteRequest = {
    protocolVersion: "1.0.0",
    requestId: `req-${requestCounter}`,
    accountId: ACCOUNT,
    clientId: CLIENT,
    deviceId,
    deviceEpoch: "5",
    toolId: "files_read",
    operationClass: "read",
    scopeRef: "scope-project",
    issuedAt: new Date(fixedNow.getTime() - 60_000).toISOString(),
    expiresAt: new Date(fixedNow.getTime() + 4 * 60_000).toISOString(),
    nonce: `nonce-req-${requestCounter}`,
    idempotencyKey: `key-${requestCounter}`,
    payloadDigest: "",
    traceId: `trace-${requestCounter}`,
    payload: { path: "README.md" },
    ...overrides,
  };
  request.payloadDigest = remotePayloadDigest(request);
  return request;
}

test("authenticated epoch handshake fences admission and reaches tool-ready", async (t) => {
  const harness = await stubHarness(t);
  await handshake(harness);
  assert.equal(harness.connector.state().state, "tool-ready");
  assert.equal(harness.connector.state().reasonCode, "ready");
  assert.equal(harness.connector.state().deviceEpoch, "5");
  assert.equal(harness.deviceStore.load()?.epoch, "5");
  const identity = { accountId: ACCOUNT, clientId: CLIENT, deviceId: harness.deviceStore.load()!.deviceId };
  // Admission inherited the authenticated epoch: a current-epoch read is admitted.
  await harness.transport.emit({ type: "request", request: makeRequest(identity.deviceId) });
  const responses = harness.transport.responses();
  assert.equal(responses.length, 1);
  assert.equal(responses[0]!.response.admitted, true);
  assert.equal(responses[0]!.response.status, "completed");
  assert.equal(harness.dispatches.count, 1);
  const jobId = responses[0]!.response.jobId!;
  assert.equal(harness.admission.getJob(identity, jobId)?.state, "completed");
});

test("readiness requires reconciliation; heartbeat alone never grants it", async (t) => {
  let releaseReconcile!: () => void;
  const gate = new Promise<void>((resolve) => { releaseReconcile = resolve; });
  const harness = await stubHarness(t, {
    reconcile: async () => { harness.admission.reconcileStartup(); await gate; },
  });
  const started = harness.connector.start();
  await tick(); await tick();
  harness.transport.onProof = (proof) => {
    assert.equal(verifyDeviceProof(harness.deviceStore.load()!.publicKey, harness.challenge, proof.signature), true);
    void harness.transport.emit({ type: "authenticated", epoch: harness.challenge.epoch });
  };
  await harness.transport.emit({ type: "challenge", challenge: harness.challenge });
  await tick(); await tick();
  assert.equal(harness.connector.state().state, "connected-degraded");
  assert.equal(harness.connector.state().reasonCode, "reconciliation_pending");
  await harness.transport.emit({ type: "heartbeat", at: fixedNow.toISOString() });
  assert.equal(harness.connector.heartbeatObservedAt(), fixedNow.toISOString());
  assert.equal(harness.connector.state().state, "connected-degraded");
  const deviceId = harness.deviceStore.load()!.deviceId;
  await harness.transport.emit({ type: "request", request: makeRequest(deviceId) });
  assert.equal(harness.dispatches.count, 0);
  assert.equal(harness.transport.responses()[0]!.response.errorCode, "device_offline");
  releaseReconcile();
  await started;
  assert.equal(harness.connector.state().state, "tool-ready");
});

test("heartbeat without any handshake never becomes ready", async (t) => {
  const harness = await stubHarness(t);
  const started = harness.connector.start();
  await tick(); await tick();
  await harness.transport.emit({ type: "heartbeat", at: fixedNow.toISOString() });
  await started; // injected sleep makes the handshake timeout immediate
  assert.notEqual(harness.connector.state().state, "tool-ready");
  const deviceId = harness.deviceStore.load()!.deviceId;
  await harness.transport.emit({ type: "request", request: makeRequest(deviceId) });
  assert.equal(harness.dispatches.count, 0);
});

const BAD_CHALLENGES: [string, (deviceId: string) => Partial<RelayChallenge>][] = [
  ["wrong audience", () => ({ audience: "evil.example.com" })],
  ["wrong account", () => ({ accountId: "account-2" })],
  ["wrong device", () => ({ deviceId: "device-other" })],
  ["wrong scope", () => ({ scope: "aiboard.admin" })],
  ["expired challenge", () => ({ expiresAt: new Date(fixedNow.getTime() - 1_000).toISOString() })],
  ["stale epoch", () => ({ epoch: "5" })],
];

for (const [name, patch] of BAD_CHALLENGES) {
  test(`handshake rejects ${name} with no dispatch`, async (t) => {
    const harness = await stubHarness(t);
    const deviceId = harness.deviceStore.load()!.deviceId;
    // Pre-advance the fence so a lower epoch is stale, not merely invalid.
    if (name === "stale epoch") harness.deviceStore.advanceEpochTo("9");
    const challenge = challengeFor(deviceId, patch(deviceId));
    await handshake(harness, challenge);
    assert.notEqual(harness.connector.state().state, "tool-ready", name);
    assert.equal(harness.connector.state().state, "disconnected", name);
    assert.equal(harness.dispatches.count, 0, name);
  });
}

test("handshake rejects a replayed nonce with no dispatch", async (t) => {
  const harness = await stubHarness(t);
  await handshake(harness);
  assert.equal(harness.connector.state().state, "tool-ready");
  await harness.connector.close();
  // A fresh connector sharing the device store and authenticator replays it.
  const transport = new FakeTransport();
  const second = new RemoteConnector({
    deviceStore: harness.deviceStore, authenticator: harness.authenticator,
    admission: harness.admission, runtime: harness.runtime, session: harness.session,
    createTransport: () => transport,
    reconcile: async () => undefined,
    now: clock, sleep: testSleep, handshakeTimeoutMs: 60_000,
  });
  t.after(async () => { await second.close().catch(() => undefined); });
  const started = second.start();
  await tick(); await tick();
  transport.onProof = () => { void transport.emit({ type: "authenticated", epoch: "5" }); };
  await transport.emit({ type: "challenge", challenge: harness.challenge });
  await started;
  assert.equal(second.state().state, "disconnected");
  assert.equal(harness.dispatches.count, 0);
});

test("handshake rejects a bad signature with no dispatch", async (t) => {
  const harness = await stubHarness(t);
  const started = harness.connector.start();
  await tick(); await tick();
  const attacker = generateKeyPairSync("ed25519");
  const attackerPublic = attacker.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  harness.transport.onProof = (proof) => {
    // The relay pinned a different device key: the proof does not verify.
    const ok = verifyDeviceProof(attackerPublic, harness.challenge, proof.signature);
    assert.equal(ok, false);
    void harness.transport.emit({ type: "auth_error", code: "unauthorized" });
  };
  await harness.transport.emit({ type: "challenge", challenge: harness.challenge });
  await started;
  assert.equal(harness.connector.state().state, "disconnected");
  assert.equal(harness.connector.state().reasonCode, "authentication_failed");
  assert.equal(harness.dispatches.count, 0);
});

test("revoked device and stale-epoch, replayed and unknown requests never dispatch", async (t) => {
  const harness = await stubHarness(t);
  await handshake(harness);
  const deviceId = harness.deviceStore.load()!.deviceId;
  const good = makeRequest(deviceId);
  await harness.transport.emit({ type: "request", request: good });
  assert.equal(harness.dispatches.count, 1);
  // Replayed nonce (same envelope retransmitted under a new request id is still a replay).
  const replay = makeRequest(deviceId, { nonce: good.nonce });
  await harness.transport.emit({ type: "request", request: replay });
  assert.equal(harness.dispatches.count, 1);
  assert.equal(harness.transport.responses().at(-1)!.response.admitted, false);
  // Stale epoch.
  await harness.transport.emit({ type: "request", request: makeRequest(deviceId, { deviceEpoch: "4" }) });
  assert.equal(harness.dispatches.count, 1);
  assert.equal(harness.transport.responses().at(-1)!.response.errorCode, "device_epoch_mismatch");
  // Expired request.
  const expired = makeRequest(deviceId, { expiresAt: new Date(fixedNow.getTime() - 1_000).toISOString() });
  await harness.transport.emit({ type: "request", request: expired });
  assert.equal(harness.dispatches.count, 1);
  // Unsupported tools stay off the remote surface (git_commit, browser, jobs).
  for (const toolId of ["git_commit", "browser", "jobs_status", "unknown_tool"]) {
    await harness.transport.emit({ type: "request", request: makeRequest(deviceId, { toolId }) });
    assert.equal(harness.dispatches.count, 1, toolId);
    assert.equal(harness.transport.responses().at(-1)!.response.errorCode, "unsupported_tool", toolId);
  }
  // Revocation blocks immediately.
  harness.deviceStore.revoke();
  await harness.transport.emit({ type: "request", request: makeRequest(deviceId) });
  assert.equal(harness.dispatches.count, 1);
  assert.equal(harness.connector.state().state, "revoked");
  assert.equal(harness.transport.responses().at(-1)!.response.errorCode, "device_revoked");
});

test("owner-lock loss suspends admission and unverified cleanup blocks it", async (t) => {
  let held = true;
  const harness = await stubHarness(t, { isOwnerLockHeld: () => held });
  await handshake(harness);
  const deviceId = harness.deviceStore.load()!.deviceId;
  await harness.transport.emit({ type: "request", request: makeRequest(deviceId) });
  assert.equal(harness.dispatches.count, 1);
  held = false;
  await harness.transport.emit({ type: "heartbeat", at: fixedNow.toISOString() });
  assert.equal(harness.connector.state().state, "suspended");
  assert.equal(harness.connector.state().reasonCode, "owner_lock_lost");
  await harness.transport.emit({ type: "request", request: makeRequest(deviceId) });
  assert.equal(harness.dispatches.count, 1);

  const blocked = await stubHarness(t, {
    reconcile: async () => { throw new Error("injected unverified cleanup"); },
  });
  await handshake(blocked);
  assert.equal(blocked.connector.state().state, "connected-degraded");
  assert.equal(blocked.connector.state().reasonCode, "recovery_unverified");
  const blockedId = blocked.deviceStore.load()!.deviceId;
  await blocked.transport.emit({ type: "request", request: makeRequest(blockedId) });
  assert.equal(blocked.dispatches.count, 0);
});

test("reconnect after socket loss is bounded and never replays readiness", async (t) => {
  const harness = await stubHarness(t);
  await handshake(harness);
  assert.equal(harness.connector.state().state, "tool-ready");
  harness.transport.drop();
  assert.equal(harness.connector.state().state, "disconnected");
  for (let i = 0; i < 40; i += 1) await tick();
  assert.notEqual(harness.connector.state().state, "tool-ready");
  // 1 initial connect + at most 8 capped attempts (default policy).
  assert.ok(harness.transport.connectCount <= 9, `connectCount=${harness.transport.connectCount}`);
  assert.equal(harness.dispatches.count, 0);
});

test("ordered shutdown settles in-flight work as outcome_unknown", async (t) => {
  const steps: string[] = [];
  let releaseDispatch!: () => void;
  const gate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
  const slow: RemoteRequestRuntime = {
    invoke: async (_identity, name) => {
      await gate;
      return { callId: "call", toolName: name, content: [{ type: "text", text: "late" }], isError: false };
    },
  };
  const harness = await stubHarness(t, {
    runtime: slow,
    drainTimeoutMs: 1,
    onShutdownStep: (step) => steps.push(step),
  });
  await handshake(harness);
  const deviceId = harness.deviceStore.load()!.deviceId;
  const request = makeRequest(deviceId);
  const pending = harness.transport.emit({ type: "request", request });
  await tick(); await tick();
  await harness.connector.close();
  assert.deepEqual(steps, ["admission-stopped", "inflight-settled", "transport-closed"]);
  assert.equal(harness.transport.closed, true);
  const identity = { accountId: ACCOUNT, clientId: CLIENT, deviceId };
  const job = harness.admission.admit(identity, JSON.stringify(request)).job;
  assert.equal(harness.admission.getJob(identity, job.jobId)?.state, "outcome_unknown");
  releaseDispatch();
  await pending;
});

test("device key is a distinct user-only secret and never leaks into argv, env-facing status or logs", async () => {
  const root = await temporary();
  const state = join(root, "state");
  await mkdir(state, { recursive: true });
  const deviceStore = new RemoteDeviceStore(state);
  const identity = deviceStore.ensure(ACCOUNT);
  const keyText = await readFile(join(state, "remote-device-key"), "utf8");
  assert.ok(keyText.length > 40);
  const storageKey = new FileStorageKeyProvider(state).getKey({ createIfMissing: true });
  assert.notEqual(keyText, storageKey.toString("hex"));
  assert.equal(keyText.includes(storageKey.toString("base64url")), false);
  assert.equal(keyText.includes(storageKey.toString("hex")), false);
  // Spawn arguments carry the fixed entrypoint and flags only, never key material.
  const args = runnerSpawnArguments(
    { projectPath: root, projectKey: root.toLowerCase(), owner: "test" }, state, ["--remote"]);
  const argvText = args.join(" ");
  assert.equal(argvText.includes(keyText.trim()), false);
  assert.equal(argvText.includes(identity.publicKey), false);
  assert.match(argvText, /--remote/);
  assert.equal(existsSync(join(state, "storage-key")), true);
  // Status surfaces carry identity metadata only.
  const statusText = JSON.stringify({ deviceId: identity.deviceId, epoch: identity.epoch });
  assert.equal(statusText.includes(keyText.trim()), false);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("logout wipes device credentials and session state", async () => {
  const root = await temporary();
  const state = join(root, "state");
  await mkdir(state, { recursive: true });
  const deviceStore = new RemoteDeviceStore(state);
  deviceStore.ensure(ACCOUNT);
  deviceStore.saveSession(sessionFor());
  assert.equal(existsSync(join(state, "remote-device-key")), true);
  deviceStore.logout();
  assert.equal(deviceStore.load(), undefined);
  assert.equal(deviceStore.loadSession(), undefined);
  assert.equal(existsSync(join(state, "remote-device-key")), false);
  assert.equal(existsSync(join(state, "remote-device.json")), false);
  assert.equal(existsSync(join(state, "remote-device-session.json")), false);
  // Launcher parsing for the remote command family.
  assert.equal(parseLauncherArguments(["remote", "--logout"]).command, "remote");
  assert.equal(parseLauncherArguments(["remote", "--logout"]).logout, true);
  assert.deepEqual(parseLauncherArguments(["remote"]).runners, ["runner"]);
  assert.throws(() => parseLauncherArguments(["status", "--logout"]), /--logout/);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("real broker read and admitted write through the connector", { timeout: 120_000 }, async (t) => {
  const root = await temporary();
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(project); await mkdir(state);
  await writeFile(join(project, "README.md"), "isolated remote fixture\n");
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  const composition = composeRemoteRuntime({
    stateDirectory: state, deviceDirectory: state, workspacePath: project, host,
    permissionProfile: "full", capabilitiesConfig: emptyRunnerCapabilitiesConfig(), now: clock,
  });
  const deviceStore = composition.deviceStore;
  const identity = deviceStore.ensure(ACCOUNT);
  const session = sessionFor();
  deviceStore.saveSession(session);
  const transport = new FakeTransport();
  const results: ToolResult[] = [];
  const countingRuntime: RemoteRequestRuntime = {
    invoke: async (id, name, args, signal, raw) => {
      const result = await composition.runtime.invoke(id, name, args, signal, raw);
      results.push(result);
      return result;
    },
  };
  const connector = new RemoteConnector({
    deviceStore, authenticator: composition.authenticator, admission: composition.admission,
    runtime: countingRuntime, session, createTransport: () => transport,
    reconcile: async () => { composition.admission.reconcileStartup(); },
    now: clock, sleep: testSleep, handshakeTimeoutMs: 60_000,
  });
  t.after(async () => {
    await connector.close().catch(() => undefined);
    await closeRemoteComposition(composition).catch(() => undefined);
    await host.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const harnessLike = { connector, transport, deviceStore, challenge: challengeFor(identity.deviceId) } as unknown as Harness;
  await handshake(harnessLike);
  assert.equal(connector.state().state, "tool-ready");
  const deviceId = identity.deviceId;
  await transport.emit({ type: "request", request: makeRequest(deviceId) });
  assert.equal(transport.responses().at(-1)!.response.admitted, true);
  assert.equal(transport.responses().at(-1)!.response.status, "completed");
  assert.match(JSON.stringify(results.at(-1)!.content), /isolated remote fixture/);
  // Effectful write: admitted once, exactly one job, duplicate returns the same job.
  const writeRequest = makeRequest(deviceId, {
    toolId: "files_write", operationClass: "write",
    payload: { path: "notes.txt", content: "Hello\n" },
  });
  await transport.emit({ type: "request", request: writeRequest });
  const writeResponse = transport.responses().at(-1)!.response;
  assert.equal(writeResponse.admitted, true);
  assert.equal(writeResponse.status, "completed");
  assert.equal(await readFile(join(project, "notes.txt"), "utf8"), "Hello\n");
  const duplicate = { ...writeRequest, requestId: "req-duplicate", nonce: "nonce-duplicate", traceId: "trace-duplicate" };
  duplicate.payloadDigest = remotePayloadDigest(duplicate);
  await transport.emit({ type: "request", request: duplicate });
  assert.equal(transport.responses().at(-1)!.response.jobId, writeResponse.jobId);
  const db = new DatabaseSync(join(state, "remote-admission.sqlite"), { readOnly: true });
  try {
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM remote_jobs").get() as { count: number }).count, 2);
  } finally { db.close(); }
  // Wrong-scope resignation: a request for another account never dispatches.
  const before = results.length;
  const foreign = makeRequest(deviceId, { accountId: "account-2" });
  await transport.emit({ type: "request", request: foreign });
  assert.equal(results.length, before);
  assert.equal(transport.responses().at(-1)!.response.admitted, false);
});

test("service shutdown is retryable, ordered, and logout returns to logged-out", { timeout: 120_000 }, async (t) => {
  const root = await temporary();
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(project); await mkdir(state);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  const steps: string[] = [];
  const transport = new FakeTransport();
  const issuer: RemoteSessionIssuer = {
    pairingUrl: "https://mcp.aiboard.me/pair",
    requestSession: async () => sessionFor(),
    restoreSession: async () => undefined,
  };
  const service = new RemoteService({
    stateDirectory: state, deviceDirectory: state, workspacePath: project, host,
    permissionProfile: "full", capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
    createTransport: () => transport, issuer,
    now: clock, sleep: testSleep,
    onShutdownStep: (step) => steps.push(step),
  });
  t.after(async () => {
    transport.failClose = false;
    await service.close().catch(() => undefined);
    await host.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const started = service.start();
  await tick(); await tick(); await tick();
  const deviceId = service.composition.deviceStore.load()!.deviceId;
  transport.onProof = (proof) => {
    const challenge = challengeFor(deviceId);
    const ok = verifyDeviceProof(service.composition.deviceStore.load()!.publicKey, challenge, proof.signature);
    void transport.emit(ok ? { type: "authenticated", epoch: challenge.epoch } : { type: "auth_error", code: "unauthorized" });
  };
  await transport.emit({ type: "challenge", challenge: challengeFor(deviceId) });
  await started;
  assert.equal(service.status().state, "tool-ready");
  const statusFile = JSON.parse(await readFile(join(state, "remote-status.json"), "utf8")) as { state: string };
  assert.equal(statusFile.state, "tool-ready");
  // First close fails at the transport step and stays retryable.
  transport.failClose = true;
  await assert.rejects(service.close(), /transport close failure/);
  assert.deepEqual(steps, ["admission-stopped", "inflight-settled"]);
  transport.failClose = false;
  await service.close();
  assert.deepEqual(steps, ["admission-stopped", "inflight-settled", "transport-closed", "resources-released"]);
  await service.close(); // idempotent
  service.logout();
  assert.equal(service.status().state, "logged-out");
  assert.equal(service.composition.deviceStore.load(), undefined);
});

test("control server exposes remote status only, behind the runner token", async (t) => {
  const root = await temporary();
  const supervisor = new RunSupervisor(new SqliteEventStore(join(root, "events.sqlite")));
  const server = new ControlServer({
    supervisor,
    token: "test-control-token",
    bootstrapRun: async () => ({ baselineRevision: "a".repeat(40), baselineRef: "refs/aiboard/runs/test/baseline" }),
    remoteStatus: () => ({ protocolVersion: "1.0.0", deviceId: "device-1", state: "tool-ready", reasonCode: "ready", changedAt: fixedNow.toISOString(), deviceEpoch: "5" }),
  });
  t.after(async () => { await server.close().catch(() => undefined); supervisor.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const address = await server.start(0);
  const denied = await fetch(`${address.url}/v2/remote/status`);
  assert.equal(denied.status, 401);
  const allowed = await fetch(`${address.url}/v2/remote/status`, { headers: { Authorization: "Bearer test-control-token" } });
  assert.equal(allowed.status, 200);
  const body = await allowed.json() as { state: string };
  assert.equal(body.state, "tool-ready");
});




test("malformed, over-long and future-issued requests are refused at the boundary before dispatch", async (t) => {
  const harness = await stubHarness(t);
  await handshake(harness);
  const deviceId = harness.deviceStore.load()!.deviceId;
  const lastCode = () => harness.transport.responses().at(-1)!.response.errorCode;
  const cases: Array<[string, RemoteRequest]> = [
    ["unparseable expiry", makeRequest(deviceId, { expiresAt: "not-a-date" })],
    ["unknown field", { ...makeRequest(deviceId), extra: true } as unknown as RemoteRequest],
    ["lifetime over five minutes", makeRequest(deviceId, { expiresAt: new Date(fixedNow.getTime() + 10 * 60_000).toISOString() })],
    ["issued in the future", makeRequest(deviceId, {
      issuedAt: new Date(fixedNow.getTime() + 2 * 60_000).toISOString(),
      expiresAt: new Date(fixedNow.getTime() + 4 * 60_000).toISOString(),
    })],
  ];
  for (const [name, request] of cases) {
    await harness.transport.emit({ type: "request", request });
    assert.equal(harness.dispatches.count, 0, name);
    assert.equal(harness.transport.responses().at(-1)!.response.admitted, false, name);
    assert.equal(lastCode(), "invalid_request", name);
  }
  await harness.transport.emit({ type: "request", request: makeRequest(deviceId) });
  assert.equal(harness.dispatches.count, 1, "a well-formed request is still admitted");
});

test("a full cache of live nonces refuses new nonces instead of evicting them", async () => {
  const root = await temporary();
  const state = join(root, "state");
  await mkdir(state, { recursive: true });
  const deviceStore = new RemoteDeviceStore(state);
  const deviceId = deviceStore.ensure(ACCOUNT).deviceId;
  deviceStore.advanceEpochTo("5");
  const authenticator = new RemoteAuthenticator(deviceStore, { now: clock });
  const session = sessionFor();
  const first = makeRequest(deviceId);
  authenticator.verifyRequest(first, session);
  for (let index = 1; index < 4096; index += 1) authenticator.verifyRequest(makeRequest(deviceId), session);
  assert.throws(() => authenticator.verifyRequest(makeRequest(deviceId), session), /Too many live remote nonces/);
  assert.throws(() => authenticator.verifyRequest(makeRequest(deviceId, { nonce: first.nonce }), session), /already used/,
    "the oldest live nonce is still remembered");
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("a device linked to one account cannot be silently moved to another", async () => {
  const root = await temporary();
  const state = join(root, "state");
  await mkdir(state, { recursive: true });
  const unclaimed = new RemoteDeviceStore(state).ensure();
  assert.equal(unclaimed.accountId, null);
  const deviceStore = new RemoteDeviceStore(state);
  assert.equal(deviceStore.ensure(ACCOUNT).accountId, ACCOUNT, "an unclaimed device is claimed once");
  assert.equal(deviceStore.ensure(ACCOUNT).deviceId, unclaimed.deviceId);
  assert.throws(() => deviceStore.ensure("account-2"), /remote --logout/);
  assert.equal(deviceStore.load()!.accountId, ACCOUNT);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("one per-user device serves every project and admits a single remote owner at a time", async () => {
  const location = { platform: process.platform, environment: { LOCALAPPDATA: join(tmpdir(), "aib-local"), XDG_DATA_HOME: join(tmpdir(), "aib-xdg") }, home: tmpdir() };
  assert.equal(remoteDeviceDirectory(location), remoteDeviceDirectory(location));
  assert.notEqual(projectDataDirectory("project-a", location), projectDataDirectory("project-b", location));
  assert.ok(!remoteDeviceDirectory(location).includes(projectDataDirectory("project-a", location)), "device custody is not under project state");
  const root = await temporary();
  const devices = join(root, "remote");
  await mkdir(devices, { recursive: true });
  const fromA = new RemoteDeviceStore(devices);
  const fromB = new RemoteDeviceStore(devices);
  const shared = fromA.ensure(ACCOUNT);
  assert.equal(fromB.load()!.deviceId, shared.deviceId, "both projects see the same device");
  const releaseA = fromA.acquireOwnerLock("D:/projects/a");
  assert.ok(releaseA);
  assert.equal(fromB.acquireOwnerLock("D:/projects/b"), null, "a second remote owner is refused");
  assert.equal(fromB.activeOwnerProject(), "D:/projects/a");
  assert.throws(() => fromB.logout(), /remote_active: .*D:\/projects\/a/, "logout never wipes a device in use");
  assert.equal(fromB.load()!.deviceId, shared.deviceId);
  releaseA!();
  assert.equal(fromB.activeOwnerProject(), undefined);
  fromB.logout();
  assert.equal(fromA.load(), undefined, "logout from either project wipes the shared device");
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
