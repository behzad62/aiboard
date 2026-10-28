import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NativeTool, ToolResult } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createRemotePluginToolProvider, type ManagedMcpRuntime } from "../src/extension-mcp.js";
import { McpProtocolError, type McpRequestOutcome } from "../src/mcp-rpc-peer.js";
import { canonicalJson, createRemoteAdmissionAdapter, RemoteAdmissionStore, remotePayloadDigest, type RemoteRequest } from "../src/remote-admission-store.js";
import { RemoteAuthenticator, REMOTE_CONNECT_SCOPE, REMOTE_RELAY_AUDIENCE, type RemoteAuthorization } from "../src/remote-auth.js";
import { RemoteConnector, type RemotePluginToolProvider, type RemoteRequestRuntime, type RemoteTransport, type RemoteTransportMessage } from "../src/remote-connector.js";
import { RemoteDeviceStore, type RemoteDeviceSession } from "../src/remote-device-store.js";
import type { RemoteInvocationResult } from "../src/remote-tool-runtime.js";

const ACCOUNT = "account";
const CLIENT = "client-a";
const KEY = Buffer.alloc(32, 9);
const relayKey = generateKeyPairSync("ed25519");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
};
const success = (name: string): ToolResult => ({
  callId: "fixture", toolName: name, content: [{ type: "text", text: "fixture output" }], isError: false,
});
const cancelled = (name: string): ToolResult => ({
  callId: "fixture", toolName: name, content: [], isError: true,
  error: { code: "tool_cancelled", message: "cancelled" },
});

class FixtureTransport implements RemoteTransport {
  readonly sent: Extract<RemoteTransportMessage, { type: "response" }>[] = [];
  dropped = false;
  dropResponses = false;
  private handler?: (message: RemoteTransportMessage) => void | Promise<void>;
  private closed?: () => void;
  onProof?: () => void;
  async connect(): Promise<void> {}
  async close(): Promise<void> { this.dropped = true; this.closed?.(); }
  send(message: RemoteTransportMessage): void {
    if (this.dropped) throw new Error("socket lost");
    if (message.type === "response" && !this.dropResponses) this.sent.push(message);
    if (message.type === "proof") this.onProof?.();
  }
  onMessage(handler: (message: RemoteTransportMessage) => void | Promise<void>): void { this.handler = handler; }
  onClose(handler: () => void): void { this.closed = handler; }
  emit(message: RemoteTransportMessage): Promise<void> { return Promise.resolve(this.handler?.(message)); }
  drop(): void { this.dropped = true; this.closed?.(); }
  response(requestId: string) { return this.sent.find((frame) => frame.response.requestId === requestId); }
}

type Work = (name: string, signal: AbortSignal, clientId: string) => Promise<RemoteInvocationResult>;

async function harness(t: test.TestContext, limits: { running?: number; queued?: number; grace?: number; deadline?: number; plugin?: RemotePluginToolProvider } = {}) {
  const root = await mkdtemp(join(tmpdir(), "aiboard-r2-jobs-"));
  const state = join(root, "state");
  await mkdir(state);
  let currentTime = Date.parse("2026-10-27T12:00:00.000Z");
  const clock = () => new Date(currentTime);
  const deviceStore = new RemoteDeviceStore(state);
  const device = deviceStore.ensure(ACCOUNT);
  const session: RemoteDeviceSession = {
    accountId: ACCOUNT, clientId: CLIENT, scope: REMOTE_CONNECT_SCOPE, issuedAt: clock().toISOString(),
    relayKeys: [{ keyId: "relay", publicKey: relayKey.publicKey.export({ type: "spki", format: "der" }).toString("base64url") }],
    authorizedScopes: ["scope"],
  };
  const authenticator = new RemoteAuthenticator(deviceStore, { now: clock });
  const databasePath = join(state, "jobs.sqlite");
  const admission = new RemoteAdmissionStore(databasePath, KEY, clock);
  let admissionClosed = false;
  let work: Work = async (name) => ({ result: success(name), brokerInvoked: true });
  let stop: (clientId: string, processId: string) => Promise<boolean> = async () => false;
  const calls: string[] = [];
  const runtime: RemoteRequestRuntime = {
    invoke: async (_identity, name) => success(name),
    stopStartedProcess: async (identity, processId) => await stop(identity.clientId, processId),
    invokeAdmitted: async (identity, name, _args, signal, _raw, _jobId, beforeBroker) => {
      if (beforeBroker && !beforeBroker()) return { result: cancelled(name), brokerInvoked: false };
      calls.push(identity.clientId);
      return await work(name, signal, identity.clientId);
    },
  };
  let transport = new FixtureTransport();
  let challengeNumber = 0;
  let requestNumber = 0;
  let epoch = "5";
  const connector = new RemoteConnector({
    deviceStore, authenticator, admission, runtime, session,
    createTransport: () => transport,
    reconcile: async () => { admission.reconcileStartup(); },
    now: clock, reconnect: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 0 },
    maxConcurrentJobsPerDevice: limits.running ?? 8, maxQueuedJobsPerDevice: limits.queued ?? 64,
    cancellationGraceMs: limits.grace ?? 20, drainTimeoutMs: 20,
    ...(limits.deadline !== undefined ? { toolDeadlineMs: limits.deadline } : {}),
    ...(limits.plugin ? { pluginTools: limits.plugin } : {}),
  });
  async function connect(nextEpoch = "5"): Promise<void> {
    epoch = nextEpoch;
    const started = connector.start();
    await tick();
    const challenge = {
      audience: REMOTE_RELAY_AUDIENCE, accountId: ACCOUNT, deviceId: device.deviceId,
      scope: REMOTE_CONNECT_SCOPE, nonce: "challenge-" + ++challengeNumber, epoch,
      expiresAt: new Date(currentTime + 60_000).toISOString(),
    };
    transport.onProof = () => { void transport.emit({ type: "authenticated", epoch }); };
    await transport.emit({ type: "challenge", challenge });
    await started;
    assert.equal(connector.isReady(), true);
  }
  function request(patch: Partial<RemoteRequest> = {}): RemoteRequest {
    const id = ++requestNumber;
    const result: RemoteRequest = {
      protocolVersion: "1.0.0", requestId: "request-" + id, traceId: "trace-" + id,
      accountId: ACCOUNT, clientId: CLIENT, deviceId: device.deviceId, deviceEpoch: epoch,
      toolId: "files_read", operationClass: "read", scopeRef: "scope",
      issuedAt: new Date(currentTime - 1000).toISOString(), expiresAt: new Date(currentTime + 60_000).toISOString(),
      nonce: "nonce-" + id, idempotencyKey: "key-" + id, payloadDigest: "", payload: { path: "fixture" },
      ...patch,
    };
    result.payloadDigest = remotePayloadDigest(result);
    return result;
  }
  function authorization(value: RemoteRequest): RemoteAuthorization {
    const claims = {
      audience: REMOTE_RELAY_AUDIENCE, accountId: value.accountId, clientId: value.clientId, deviceId: value.deviceId,
      deviceEpoch: value.deviceEpoch, scopeRef: value.scopeRef, toolId: value.toolId, operationClass: value.operationClass,
      requestId: value.requestId, nonce: value.nonce, payloadDigest: value.payloadDigest,
      issuedAt: value.issuedAt, expiresAt: value.expiresAt,
    };
    return { version: 1, keyId: "relay", claims,
      signature: sign(null, Buffer.from(canonicalJson(claims)), relayKey.privateKey).toString("base64url") };
  }
  function send(value: RemoteRequest): Promise<void> {
    return transport.emit({ type: "request", request: value, authorization: authorization(value) });
  }
  async function response(value: RemoteRequest) {
    await send(value);
    const found = transport.response(value.requestId);
    assert.ok(found, "response must be delivered");
    return found;
  }
  function idFor(value: RemoteRequest): string {
    return admission.admit({ accountId: value.accountId, clientId: value.clientId, deviceId: value.deviceId },
      JSON.stringify(value)).job.jobId;
  }
  async function waitState(value: RemoteRequest, jobId: string, state: string): Promise<void> {
    for (let attempt = 0; attempt < 1000; attempt++) {
      const job = admission.getJob({ accountId: value.accountId, clientId: value.clientId, deviceId: value.deviceId }, jobId);
      if (job?.state === state) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    assert.fail("job did not reach " + state);
  }
  t.after(async () => {
    await connector.close().catch(() => undefined);
    if (!admissionClosed) admission.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return {
    root, databasePath, device, admission, connector, calls, connect, request, send, response, idFor, waitState,
    transport: () => transport,
    replaceTransport: () => { transport = new FixtureTransport(); },
    setWork: (next: Work) => { work = next; },
    setStop: (next: (clientId: string, processId: string) => Promise<boolean>) => { stop = next; },
    advance: (ms: number) => { currentTime += ms; },
    closeAdmission: () => { admission.close(); admissionClosed = true; },
  };
}

test("100 same-key requests execute once, and a conflicting key never dispatches", async (t) => {
  const h = await harness(t);
  const gate = deferred();
  h.setWork(async (name) => { await gate.promise; return { result: success(name), brokerInvoked: true }; });
  await h.connect();
  const write = { toolId: "files_write", operationClass: "write", payload: { path: "fixture", content: "once" } };
  const requests = Array.from({ length: 100 }, () => h.request({ ...write, idempotencyKey: "shared" }));
  const pending = requests.map((request) => h.send(request));
  try {
    await tick();
    assert.equal(h.calls.length, 1);
    const conflict = h.request({ ...write, idempotencyKey: "shared", payload: { path: "fixture", content: "different" } });
    const rejected = await h.response(conflict);
    assert.equal(rejected.response.errorCode, "idempotency_conflict");
    assert.equal(h.calls.length, 1);
    gate.resolve();
    await Promise.all(pending);
    const ids = requests.map((request) => h.transport().response(request.requestId)?.response.jobId);
    assert.equal(new Set(ids).size, 1);
    assert.ok(ids[0]);
    await h.waitState(requests[0]!, ids[0]!, "completed");
  } finally { gate.resolve(); await Promise.allSettled(pending); }
});

test("a scheduled effect enters the broker once without a second admission", async (t) => {
  const h = await harness(t);
  await h.connect();
  const request = h.request({ toolId: "files_write", operationClass: "write", payload: { path: "fixture", content: "once" } });
  const identity = { accountId: ACCOUNT, clientId: CLIENT, deviceId: h.device.deviceId };
  const rawRequest = JSON.stringify(request);
  const job = h.admission.admit(identity, rawRequest).job;
  h.admission.markDispatching(identity, job.jobId, request.deviceEpoch);
  const adapter = createRemoteAdmissionAdapter(h.admission);
  const effect = { principal: { identity, principalId: "principal", runId: "run", sessionId: "session", revoked: false },
    callId: "call", toolName: "fs.write", workspacePath: h.root, arguments: request.payload, rawRequest,
    admittedJobId: job.jobId, authorize: () => undefined };
  let calls = 0;
  const dispatch = async () => { calls++; return success("fs.write"); };
  assert.equal((await adapter(effect, dispatch)).isError, false);
  assert.equal(h.admission.getJob(identity, job.jobId)?.state, "running");
  assert.equal((await adapter(effect, dispatch)).error?.code, "storage_exhausted");
  assert.equal(calls, 1);
  assert.equal(h.admission.admit(identity, rawRequest).job.jobId, job.jobId);
  h.admission.settle(identity, job.jobId, "completed");
});

test("job reads and cancellation are principal-scoped and require relay authorization", async (t) => {
  const h = await harness(t);
  await h.connect();
  const original = h.request();
  const completed = await h.response(original);
  const jobId = completed.response.jobId!;
  await h.waitState(original, jobId, "completed");
  const status = await h.response(h.request({ toolId: "jobs_status", payload: { jobId } }));
  assert.equal((status.data as { authoritative: boolean }).authoritative, true);
  assert.equal((status.data as { job: { state: string } }).job.state, "completed");
  const events = await h.response(h.request({ toolId: "jobs_events", payload: { jobId, limit: 2 } }));
  assert.equal((events.data as { events: unknown[] }).events.length, 2);
  const result = await h.response(h.request({ toolId: "jobs_result", payload: { jobId, maxBytes: 10 } }));
  assert.ok((result.data as { inline?: string }).inline);
  assert.ok((result.data as { nextCursor?: string }).nextCursor);
  for (const toolId of ["jobs_status", "jobs_events", "jobs_result", "jobs_cancel"]) {
    const foreign = await h.response(h.request({ clientId: "client-b", toolId, payload: { jobId } }));
    assert.equal(foreign.response.errorCode, "not_found");
    const missing = await h.response(h.request({ clientId: "client-b", toolId, payload: { jobId: "missing" } }));
    assert.equal(missing.response.errorCode, foreign.response.errorCode);
  }
  let reads = 0;
  const view = h.admission.view.bind(h.admission);
  h.admission.view = (...args) => { reads++; return view(...args); };
  for (const toolId of ["jobs_status", "jobs_events", "jobs_result", "jobs_cancel"]) {
    const denied = h.request({ toolId, payload: { jobId } });
    await h.transport().emit({ type: "request", request: denied });
    assert.equal(h.transport().response(denied.requestId)?.response.errorCode, "unauthorized");
  }
  assert.equal(reads, 0);
});

test("queued cancellation is persisted before dispatch and has no effect", async (t) => {
  const h = await harness(t, { running: 1, queued: 2 });
  const gate = deferred();
  h.setWork(async (name) => { await gate.promise; return { result: success(name), brokerInvoked: true }; });
  await h.connect();
  const first = h.request();
  const firstPending = h.send(first);
  const queued = h.request();
  const queuedPending = h.send(queued);
  try {
    const jobId = h.idFor(queued);
    const cancel = h.request({ toolId: "jobs_cancel", payload: { jobId }, idempotencyKey: "cancel-id" });
    const receipt = await h.response(cancel);
    assert.equal((receipt.data as { cancelRequestId: string }).cancelRequestId, "cancel-id");
    assert.equal((receipt.data as { cancellation: { effect: string } }).cancellation.effect, "no_effect");
    await queuedPending;
    await h.waitState(queued, jobId, "cancelled");
    assert.equal(h.calls.length, 1);
  } finally { gate.resolve(); await Promise.allSettled([firstPending, queuedPending]); }
});

test("verified cooperative stop is distinct from an ignored abort", async (t) => {
  const h = await harness(t, { grace: 10 });
  const ignored = deferred();
  h.setWork(async (name, signal, client) => {
    if (client === "client-b") { await ignored.promise; return { result: success(name), brokerInvoked: true }; }
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { result: cancelled(name), brokerInvoked: true, stopEvidence: { effect: "no_effect" } };
  });
  await h.connect();
  const cooperative = h.request();
  const cooperativePending = h.send(cooperative);
  const ignoring = h.request({ clientId: "client-b" });
  const ignoringPending = h.send(ignoring);
  try {
    await tick();
    const jobA = h.idFor(cooperative), jobB = h.idFor(ignoring);
    await h.response(h.request({ toolId: "jobs_cancel", payload: { jobId: jobA } }));
    await cooperativePending;
    await h.waitState(cooperative, jobA, "cancelled");
    const viewA = h.admission.view({ accountId: ACCOUNT, clientId: CLIENT, deviceId: h.device.deviceId }, jobA).job;
    assert.equal(viewA.state, "cancelled");
    assert.equal(viewA.cancellation?.stop, "stopped");
    await h.response(h.request({ clientId: "client-b", toolId: "jobs_cancel", payload: { jobId: jobB } }));
    await ignoringPending;
    await h.waitState(ignoring, jobB, "outcome_unknown");
    const viewB = h.admission.view({ accountId: ACCOUNT, clientId: "client-b", deviceId: h.device.deviceId }, jobB).job;
    assert.equal(viewB.state, "outcome_unknown");
    assert.equal(viewB.cancellation?.stop, "unverified");
    assert.equal(viewB.cancellation?.effect, "effect_outcome_unknown");
  } finally { ignored.resolve(); await Promise.allSettled([cooperativePending, ignoringPending]); }
});

test("a managed-start cancellation result alone does not prove a process stopped", async (t) => {
  const h = await harness(t);
  const started = deferred();
  h.setWork(async (name, signal) => {
    started.resolve();
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    return { result: { ...cancelled(name), error: { code: "process_cancelled", message: "cancelled" } }, brokerInvoked: true };
  });
  await h.connect();
  const request = h.request({ toolId: "process_start", operationClass: "write", payload: { command: "fixture" } });
  const admitted = await h.response(request);
  await started.promise;
  const jobId = admitted.response.jobId!;
  await h.response(h.request({ toolId: "jobs_cancel", operationClass: "write", payload: { jobId } }));
  await h.waitState(request, jobId, "outcome_unknown");
  const job = h.admission.view({ accountId: ACCOUNT, clientId: CLIENT, deviceId: h.device.deviceId }, jobId).job;
  assert.equal(job.cancellation?.stop, "unverified");
  assert.equal(job.cancellation?.effect, "effect_outcome_unknown");
});

test("plugin failures preserve uncertainty after cancellation and an unknown remote outcome", async (t) => {
  const started = deferred();
  let calls = 0;
  const plugin: RemotePluginToolProvider = {
    list: async () => [{ relayToolId: "plugin_fixture", required: false, available: true }],
    invoke: async (_identity, name, args, signal) => {
      calls++;
      if ((args as { unknown?: boolean }).unknown) {
        return { callId: "plugin", toolName: name, isError: true,
          content: [{ type: "text", text: "OUTCOME UNKNOWN (not retried): transport failed" }] };
      }
      assert.ok(signal);
      started.resolve();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      return { callId: "plugin", toolName: name, isError: true, content: [],
        error: { code: "tool_execution_failed", message: "MCP request failed" } };
    },
  };
  const h = await harness(t, { plugin });
  await h.connect();
  const request = h.request({ toolId: "plugin_fixture", operationClass: "write", payload: {} });
  const admitted = await h.response(request);
  await started.promise;
  const jobId = admitted.response.jobId!;
  await h.response(h.request({ toolId: "jobs_cancel", operationClass: "write", payload: { jobId } }));
  await h.waitState(request, jobId, "outcome_unknown");
  const job = h.admission.view({ accountId: ACCOUNT, clientId: CLIENT, deviceId: h.device.deviceId }, jobId).job;
  assert.equal(job.cancellation?.stop, "unverified");
  assert.equal(job.cancellation?.effect, "effect_outcome_unknown");

  const uncertain = h.request({ toolId: "plugin_fixture", operationClass: "write", payload: { unknown: true } });
  const response = await h.response(uncertain);
  await h.waitState(uncertain, response.response.jobId!, "outcome_unknown");
  assert.equal(calls, 2);
});

test("the real plugin provider preserves only locally proved MCP not-sent evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "aiboard-r2-plugin-"));
  let started = deferred();
  let outcome: McpRequestOutcome = "not_sent";
  const tool: NativeTool<unknown> = {
    definition: { name: "plugin_fixture", description: "Fixture", inputSchema: { type: "object" }, readOnly: false, effect: "external" },
    validate: (input) => ({ ok: true, value: input }),
    execute: async (_input, context) => {
      assert.ok(context.signal);
      started.resolve();
      await new Promise<void>((resolve) => context.signal!.addEventListener("abort", () => resolve(), { once: true }));
      throw new McpProtocolError("mcp_request_cancelled", "Fixture cancellation", outcome);
    },
  };
  const runtime = { remoteAdmittedTools: async () => ({ tools: [tool], unavailable: [], close: async () => undefined }) } as unknown as ManagedMcpRuntime;
  const provider = createRemotePluginToolProvider(runtime, {
    generation: async () => 1, artifacts: new ArtifactStore(join(root, "artifacts")), workspacePath: root,
  });
  try {
    for (const expected of ["not_sent", "outcome_unknown"] as const) {
      outcome = expected;
      started = deferred();
      const controller = new AbortController();
      const pending = provider.invokeAdmitted!({ accountId: ACCOUNT, clientId: CLIENT, deviceId: "device" },
        "plugin_fixture", {}, controller.signal);
      await started.promise;
      controller.abort();
      const result = await pending;
      assert.equal(result.brokerInvoked, true);
      assert.deepEqual(result.stopEvidence, expected === "not_sent" ? { effect: "no_effect" } : undefined);
    }
  } finally { await provider.close?.(); await rm(root, { recursive: true, force: true }); }
});

test("completed managed starts retain exact process ownership after result expiry", async (t) => {
  const h = await harness(t);
  const stops: string[] = [];
  h.setWork(async (name) => ({ result: { callId: "fixture", toolName: name,
    content: [{ type: "json", value: { processId: "managed-1" } }], isError: false }, brokerInvoked: true }));
  h.setStop(async (clientId, processId) => { stops.push(clientId + ":" + processId); return true; });
  await h.connect();
  const start = h.request({ toolId: "process_start", operationClass: "write", payload: { command: "fixture" } });
  const admitted = await h.response(start);
  const jobId = admitted.response.jobId!;
  await h.waitState(start, jobId, "completed");
  h.advance(8 * 24 * 60 * 60 * 1000);
  assert.equal(h.admission.expireResults(), 1);
  const foreign = await h.response(h.request({ clientId: "client-b", toolId: "jobs_cancel", payload: { jobId } }));
  assert.equal(foreign.response.errorCode, "not_found");
  assert.deepEqual(stops, []);
  const receipt = await h.response(h.request({ toolId: "jobs_cancel", operationClass: "write", payload: { jobId } }));
  assert.equal((receipt.data as { cancellation: { stop: string } }).cancellation.stop, "pending");
  await tick();
  const view = h.admission.view({ accountId: ACCOUNT, clientId: CLIENT, deviceId: h.device.deviceId }, jobId).job;
  assert.equal(view.cancellation?.stop, "stopped");
  assert.deepEqual(stops, [CLIENT + ":managed-1"]);
});
test("queue limits and round-robin scheduling do not drop admitted work", async (t) => {
  const h = await harness(t, { running: 1, queued: 4 });
  const gate = deferred();
  let first = true;
  h.setWork(async (name) => {
    if (first) { first = false; await gate.promise; }
    return { result: success(name), brokerInvoked: true };
  });
  await h.connect();
  const jobs = [
    h.request(), h.request(), h.request(),
    h.request({ clientId: "client-b" }), h.request({ clientId: "client-b" }),
  ];
  const pending = jobs.map((job) => h.send(job));
  try {
    const overflow = await h.response(h.request());
    assert.equal(overflow.response.admitted, false);
    assert.equal(overflow.response.status, "blocked_quota");
    gate.resolve();
    await Promise.all(pending);
    await h.waitState(jobs[4]!, h.idFor(jobs[4]!), "completed");
    await h.waitState(jobs[2]!, h.idFor(jobs[2]!), "completed");
    assert.deepEqual(h.calls, [CLIENT, "client-b", CLIENT, "client-b", CLIENT]);
    assert.ok(jobs.every((job) => h.transport().response(job.requestId)?.response.admitted));
  } finally { gate.resolve(); await Promise.allSettled(pending); }
});

test("an expired queued job is blocked before dispatch", async (t) => {
  const h = await harness(t, { running: 1 });
  const gate = deferred();
  h.setWork(async (name) => { await gate.promise; return { result: success(name), brokerInvoked: true }; });
  await h.connect();
  const first = h.request();
  const pendingFirst = h.send(first);
  const queued = h.request({ expiresAt: "2026-10-27T12:00:01.000Z" });
  const pendingQueued = h.send(queued);
  try {
    h.advance(2000);
    gate.resolve();
    await Promise.all([pendingFirst, pendingQueued]);
    const queuedId = h.transport().response(queued.requestId)!.response.jobId!;
    await h.waitState(queued, queuedId, "blocked_policy");
    const result = h.admission.result({ accountId: ACCOUNT, clientId: CLIENT, deviceId: h.device.deviceId }, queuedId);
    assert.equal(JSON.parse(Buffer.from(result.inline!).toString("utf8")).reason, "expired_before_dispatch");
    assert.equal(h.calls.length, 1);
  } finally { gate.resolve(); await Promise.allSettled([pendingFirst, pendingQueued]); }
});

test("transport loss and a paused clock leave live work queryable after reconnect", async (t) => {
  const h = await harness(t);
  const gate = deferred();
  h.setWork(async (name) => { await gate.promise; return { result: success(name), brokerInvoked: true }; });
  await h.connect();
  const write = { toolId: "files_write", operationClass: "write", payload: { path: "fixture", content: "once" } };
  const first = h.request({ ...write, idempotencyKey: "resume-key" });
  h.transport().dropResponses = true;
  const pending = h.send(first);
  try {
    await tick();
    const jobId = h.idFor(first);
    assert.equal(h.transport().response(first.requestId), undefined);
    h.transport().drop();
    h.replaceTransport();
    await h.connect("6");
    const status = await h.response(h.request({ toolId: "jobs_status", payload: { jobId } }));
    assert.equal((status.data as { job: { state: string } }).job.state, "running");
    const retry = await h.response(h.request({ ...write, idempotencyKey: "resume-key" }));
    assert.equal(retry.response.jobId, jobId);
    assert.equal(h.calls.length, 1);
    gate.resolve();
    await pending;
    await h.waitState(first, jobId, "completed");
    const after = await h.response(h.request({ toolId: "jobs_status", payload: { jobId } }));
    assert.equal((after.data as { job: { state: string } }).job.state, "completed");
  } finally { gate.resolve(); await Promise.allSettled([pending]); }
});

test("fresh authorization replaces a queued job's old epoch after reconnect", async (t) => {
  const h = await harness(t, { running: 1 });
  const gate = deferred();
  let first = true;
  h.setWork(async (name) => {
    if (first) { first = false; await gate.promise; }
    return { result: success(name), brokerInvoked: true };
  });
  await h.connect();
  const running = h.request();
  await h.response(running);
  const write = { toolId: "files_write", operationClass: "write", payload: { path: "fixture", content: "once" } };
  const queued = h.request({ ...write, idempotencyKey: "queued-retry" });
  const admitted = await h.response(queued);
  const jobId = admitted.response.jobId!;
  try {
    assert.equal(admitted.response.status, "queued");
    h.transport().drop();
    h.replaceTransport();
    await h.connect("6");
    const retry = await h.response(h.request({ ...write, idempotencyKey: "queued-retry" }));
    assert.equal(retry.response.jobId, jobId);
    gate.resolve();
    await h.waitState(queued, jobId, "completed");
    assert.deepEqual(h.calls, [CLIENT, CLIENT]);
  } finally { gate.resolve(); }
});

test("a retry refreshes a plugin job while its pre-dispatch discovery is pending", async (t) => {
  const preparing = deferred();
  const gate = deferred();
  let lists = 0;
  let calls = 0;
  const plugin: RemotePluginToolProvider = {
    list: async () => {
      if (++lists === 3) { preparing.resolve(); await gate.promise; }
      return [{ relayToolId: "plugin_fixture", required: false, available: true }];
    },
    invoke: async (_identity, name, _args, _signal, beforeBroker) => {
      assert.equal(beforeBroker?.(), true);
      calls++;
      return success(name);
    },
  };
  const h = await harness(t, { plugin });
  await h.connect();
  const payload = { toolId: "plugin_fixture", operationClass: "write", payload: {}, idempotencyKey: "plugin-retry" };
  const original = h.request(payload);
  const admitted = await h.response(original);
  await preparing.promise;
  try {
    assert.equal(admitted.response.status, "queued");
    h.transport().drop();
    h.replaceTransport();
    await h.connect("6");
    const retry = await h.response(h.request(payload));
    assert.equal(retry.response.jobId, admitted.response.jobId);
    gate.resolve();
    await h.waitState(original, admitted.response.jobId!, "completed");
    assert.equal(calls, 1);
  } finally { gate.resolve(); }
});

test("a queued retry cannot extend the deadline measured from admission", async (t) => {
  const h = await harness(t, { running: 1, deadline: 1000 });
  const gate = deferred();
  h.setWork(async (name) => { await gate.promise; return { result: success(name), brokerInvoked: true }; });
  await h.connect();
  await h.response(h.request());
  const queued = h.request({ idempotencyKey: "deadline-retry" });
  const admitted = await h.response(queued);
  try {
    h.advance(900);
    const retry = await h.response(h.request({ idempotencyKey: "deadline-retry" }));
    assert.equal(retry.response.jobId, admitted.response.jobId);
    h.advance(200);
    gate.resolve();
    await h.waitState(queued, admitted.response.jobId!, "blocked_policy");
    assert.equal(h.calls.length, 1);
  } finally { gate.resolve(); }
});

test("restart after dispatch preserves unknown and cannot replay the effect", async (t) => {
  const h = await harness(t);
  const gate = deferred();
  let effects = 0;
  h.setWork(async (name) => { effects++; await gate.promise; return { result: success(name), brokerInvoked: true }; });
  await h.connect();
  const request = h.request({ toolId: "files_write", operationClass: "write",
    idempotencyKey: "restart-key", payload: { path: "fixture", content: "once" } });
  const admitted = await h.response(request);
  const jobId = admitted.response.jobId!;
  const principal = { accountId: ACCOUNT, clientId: CLIENT, deviceId: h.device.deviceId };
  assert.equal(h.admission.getJob(principal, jobId)?.state, "running");
  assert.equal(effects, 1);
  h.transport().drop();
  h.closeAdmission();
  const reopened = new RemoteAdmissionStore(h.databasePath, KEY, () => new Date("2026-10-27T12:00:00Z"));
  try {
    reopened.reconcileStartup();
    const retry = reopened.admit(principal, JSON.stringify(request));
    assert.equal(retry.created, false);
    assert.equal(retry.job.jobId, jobId);
    assert.equal(retry.job.state, "outcome_unknown");
    assert.equal(effects, 1);
  } finally {
    reopened.close();
    gate.resolve();
    await tick();
  }
});
