import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import type { ToolResult } from "../src/agent-contracts.js";
import { requestLauncherApproval, startLauncherControl } from "../src/launcher-ipc.js";
import { parseLauncherArguments } from "../src/launcher.js";
import { canonicalJson, RemoteAdmissionStore, remotePayloadDigest, type RemoteRequest } from "../src/remote-admission-store.js";
import { APPROVAL_TOOLS, commandApprovalsMessage, commandApprovalSummary, promptCommandApproval, type CommandApprovalRequest } from "../src/remote-approval.js";
import { RemoteAuthenticator, REMOTE_APPROVAL_PURPOSE, REMOTE_CONNECT_SCOPE, REMOTE_RELAY_AUDIENCE, type RemoteAuthorization } from "../src/remote-auth.js";
import { RemoteConnector, type RemoteRequestRuntime, type RemoteTransport, type RemoteTransportMessage } from "../src/remote-connector.js";
import { RemoteDeviceStore, type RemoteDeviceSession } from "../src/remote-device-store.js";

const ACCOUNT = "account";
const CLIENT = "client-a";
const KEY = Buffer.alloc(32, 11);
const relayKey = generateKeyPairSync("ed25519");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
// A successful managed start must prove which process it started (R2b binds it to the job).
const success = (name: string): ToolResult => ({
  callId: "fixture", toolName: name, isError: false,
  content: name === "process.start" ? [{ type: "json", value: { processId: "process-fixture" } }] : [{ type: "text", text: "fixture output" }],
});
const RUNNER_NAMES: Readonly<Record<string, string>> = {
  process_start: "process.start", process_signal: "process.signal", files_read: "fs.read",
};

class FixtureTransport implements RemoteTransport {
  readonly sent: Extract<RemoteTransportMessage, { type: "response" }>[] = [];
  readonly approvals: Extract<RemoteTransportMessage, { type: "approvals" }>[] = [];
  private handler?: (message: RemoteTransportMessage) => void | Promise<void>;
  private closed?: (info?: { readonly code?: number }) => void;
  onProof?: () => void;
  onConnect?: () => void;
  async connect(): Promise<void> { this.onConnect?.(); }
  async close(): Promise<void> {}
  send(message: RemoteTransportMessage): void {
    if (message.type === "response") this.sent.push(message);
    if (message.type === "approvals") this.approvals.push(message);
    if (message.type === "proof") this.onProof?.();
  }
  onMessage(handler: (message: RemoteTransportMessage) => void | Promise<void>): void { this.handler = handler; }
  onClose(handler: (info?: { readonly code?: number }) => void): void { this.closed = handler; }
  lose(): void { this.closed?.(); }
  emit(message: RemoteTransportMessage): Promise<void> { return Promise.resolve(this.handler?.(message)); }
  response(requestId: string) { return this.sent.find((frame) => frame.response.requestId === requestId); }
}

async function harness(t: test.TestContext, approvals: boolean) {
  const root = await mkdtemp(join(tmpdir(), "aiboard-s1b2-"));
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
  const admission = new RemoteAdmissionStore(join(state, "jobs.sqlite"), KEY, clock);
  const calls: { name: string; approvalGranted: boolean }[] = [];
  const audit: string[] = [];
  const origins: string[] = [];
  const notices: string[] = [];
  const runtime: RemoteRequestRuntime = {
    latestPolicyNarrowing: () => undefined,
    invoke: async (_identity, name) => success(name),
    invokeAdmitted: async (_identity, name, _args, _signal, _raw, _jobId, beforeBroker, approvalGranted) => {
      if (beforeBroker && !beforeBroker()) return { result: success(name), brokerInvoked: false };
      calls.push({ name, approvalGranted: approvalGranted === true });
      return { result: success(name), brokerInvoked: true };
    },
    requiresCommandApproval: (_identity, name) => approvals && APPROVAL_TOOLS.has(name),
    summarizeCommandApproval: (_identity, jobId, code, name, args) => commandApprovalSummary(jobId, code, name, args, root),
  };
  const transport = new FixtureTransport();
  let requestNumber = 0;
  const connector = new RemoteConnector({
    deviceStore, authenticator: new RemoteAuthenticator(deviceStore, { now: clock }), admission, runtime, session,
    createTransport: () => transport,
    reconcile: async () => { admission.reconcileStartup(); },
    now: clock, reconnect: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 },
    maxConcurrentJobsPerDevice: 4, maxQueuedJobsPerDevice: 8, cancellationGraceMs: 20, drainTimeoutMs: 20,
    auditApproval: (_identity, jobId, decision, origin) => {
      audit.push(`${decision}:${jobId}`);
      origins.push(`${decision}:${origin ?? "unset"}`);
    },
    onDashboardApproval: (summary, approved) => { notices.push(`${summary.code}:${approved}`); },
  });
  const started = connector.start();
  await tick();
  transport.onProof = () => { void transport.emit({ type: "authenticated", epoch: "5" }); };
  const challenge = {
    audience: REMOTE_RELAY_AUDIENCE, accountId: ACCOUNT, deviceId: device.deviceId, scope: REMOTE_CONNECT_SCOPE,
    nonce: "challenge-1", epoch: "5", expiresAt: new Date(currentTime + 60_000).toISOString(),
  };
  await transport.emit({ type: "challenge", challenge, keyId: "relay",
    signature: sign(null, Buffer.from(canonicalJson(challenge)), relayKey.privateKey).toString("base64url") });
  await started;
  assert.equal(connector.isReady(), true);
  t.after(async () => {
    await connector.close().catch(() => undefined);
    admission.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const identity = { accountId: ACCOUNT, clientId: CLIENT, deviceId: device.deviceId };
  function request(patch: Partial<RemoteRequest> = {}): RemoteRequest {
    const id = ++requestNumber;
    const value: RemoteRequest = {
      protocolVersion: "1.0.0", requestId: "request-" + id, traceId: "trace-" + id,
      accountId: ACCOUNT, clientId: CLIENT, deviceId: device.deviceId, deviceEpoch: "5",
      toolId: "process_start", operationClass: "write", scopeRef: "scope",
      issuedAt: new Date(currentTime - 1000).toISOString(), expiresAt: new Date(currentTime + 300_000).toISOString(),
      nonce: "nonce-" + id, idempotencyKey: "key-" + id, payloadDigest: "",
      payload: { command: "C:\\tools\\node.exe", args: ["-e", "work()"] }, ...patch,
    };
    value.payloadDigest = remotePayloadDigest(value);
    return value;
  }
  function authorization(value: RemoteRequest): RemoteAuthorization {
    const claims = {
      audience: REMOTE_RELAY_AUDIENCE, accountId: value.accountId, clientId: value.clientId, deviceId: value.deviceId,
      deviceEpoch: value.deviceEpoch, scopeRef: value.scopeRef, toolId: value.toolId, operationClass: value.operationClass,
      requestId: value.requestId, nonce: value.nonce, payloadDigest: value.payloadDigest,
      issuedAt: value.issuedAt, expiresAt: value.expiresAt,
    };
    return { version: 1, keyId: "relay", claims, signature: sign(null, Buffer.from(canonicalJson(claims)), relayKey.privateKey).toString("base64url") };
  }
  async function frame(value: RemoteRequest) {
    await transport.emit({ type: "request", request: value, authorization: authorization(value) });
    const found = transport.response(value.requestId);
    assert.ok(found, "response must be delivered");
    return found;
  }
  async function submit(value: RemoteRequest) { return (await frame(value)).response; }
  async function jobState(jobId: string, expected?: string): Promise<string | undefined> {
    for (let attempt = 0; attempt < 500; attempt++) {
      const current = admission.getJob(identity, jobId)?.state;
      if (expected === undefined || current === expected) return current;
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
    assert.fail(`job did not reach ${expected}; last ${admission.getJob(identity, jobId)?.state}`);
  }
  /** A dashboard answer exactly as the relay signs it, with any claim overridden to prove it is refused. */
  function dashboardAnswer(jobId: string, nonce: string, approved: boolean, patch: Record<string, unknown> = {}, signer = relayKey.privateKey, keyId = "relay") {
    const claims: Record<string, unknown> = Object.fromEntries(Object.entries({
      purpose: REMOTE_APPROVAL_PURPOSE, audience: REMOTE_RELAY_AUDIENCE, accountId: ACCOUNT, deviceId: device.deviceId, deviceEpoch: "5",
      jobId, nonce, approved, issuedAt: clock().toISOString(), expiresAt: new Date(currentTime + 60_000).toISOString(), ...patch,
    }).filter(([, value]) => value !== undefined));
    return { version: 1, keyId, claims, signature: sign(null, Buffer.from(canonicalJson(claims)), signer).toString("base64url") };
  }
  /** Lose the socket and let the connector come back on a new challenge. */
  async function reconnect(): Promise<void> {
    transport.onProof = () => { void transport.emit({ type: "authenticated", epoch: "6" }); };
    const connecting = new Promise<void>((resolve) => { transport.onConnect = resolve; });
    transport.lose();
    await connecting;
    await tick();
    const next = { ...challenge, nonce: "challenge-2", epoch: "6", expiresAt: new Date(currentTime + 60_000).toISOString() };
    await transport.emit({ type: "challenge", challenge: next, keyId: "relay",
      signature: sign(null, Buffer.from(canonicalJson(next)), relayKey.privateKey).toString("base64url") });
    for (let attempt = 0; attempt < 500 && !connector.isReady(); attempt++) await new Promise<void>((resolve) => setTimeout(resolve, 2));
    assert.equal(connector.isReady(), true);
  }
  return { connector, transport, calls, audit, origins, notices, request, submit, frame, dashboardAnswer, reconnect, state: jobState, advance: (ms: number) => { currentTime += ms; } };
}

test("approvals off: process tools dispatch without a local decision", async (t) => {
  const h = await harness(t, false);
  const response = await h.submit(h.request());
  assert.equal(response.admitted, true);
  await h.state(response.jobId!, "completed");
  assert.deepEqual(h.calls, [{ name: "process.start", approvalGranted: false }]);
  assert.equal(h.connector.pendingCommandApproval(), undefined);
});

test("approvals on: a shell job waits with zero dispatch, and one approval dispatches exactly once", async (t) => {
  const h = await harness(t, true);
  const response = await h.submit(h.request());
  assert.equal(response.admitted, true);
  assert.equal(response.status, "awaiting_approval");
  await h.state(response.jobId!, "awaiting_approval");
  await tick();
  assert.equal(h.calls.length, 0);
  const pending = h.connector.pendingCommandApproval();
  assert.ok(pending);
  assert.equal(pending.summary.jobId, response.jobId);
  assert.equal(pending.summary.executable, "node.exe");
  assert.match(pending.nonce, /^[0-9a-f]{64}$/);
  assert.equal(pending.session, undefined, "a client id without a session code names no session");
  // A forged nonce or another job id is fenced and leaves the job waiting.
  assert.equal(h.connector.answerCommandApproval(response.jobId!, "0".repeat(64), true), false);
  assert.equal(h.connector.answerCommandApproval("job-other", pending.nonce, true), false);
  assert.equal(h.calls.length, 0);
  assert.equal(await h.state(response.jobId!), "awaiting_approval");
  assert.equal(h.connector.answerCommandApproval(response.jobId!, pending.nonce, true), true);
  await h.state(response.jobId!, "completed");
  assert.deepEqual(h.calls, [{ name: "process.start", approvalGranted: true }]);
  // The same answer cannot be replayed.
  assert.equal(h.connector.answerCommandApproval(response.jobId!, pending.nonce, true), false);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.audit.map((entry) => entry.split(":")[0]), ["requested", "fenced", "fenced", "approved", "fenced"]);
});

test("denial and expiry block the job as policy, never dispatch, and fence late answers", async (t) => {
  const h = await harness(t, true);
  const denied = await h.submit(h.request());
  const deniedApproval = h.connector.pendingCommandApproval()!;
  assert.equal(h.connector.answerCommandApproval(denied.jobId!, deniedApproval.nonce, false), true);
  await h.state(denied.jobId!, "blocked_policy");
  assert.equal(h.connector.answerCommandApproval(denied.jobId!, deniedApproval.nonce, true), false);

  const expired = await h.submit(h.request());
  const expiredApproval = h.connector.pendingCommandApproval()!;
  assert.equal(expiredApproval.summary.jobId, expired.jobId);
  // Someone away from the computer needs time to open the dashboard, so 2 minutes is no longer the limit.
  h.advance(121_000);
  assert.equal(h.connector.pendingCommandApproval()?.nonce, expiredApproval.nonce);
  h.advance(180_000);
  assert.equal(h.connector.pendingCommandApproval(), undefined);
  await h.state(expired.jobId!, "blocked_policy");
  assert.equal(h.connector.answerCommandApproval(expired.jobId!, expiredApproval.nonce, true), false);
  await tick();
  assert.equal(h.calls.length, 0);
  assert.ok(h.audit.includes(`denied:${denied.jobId}`));
  assert.ok(h.audit.includes(`expired:${expired.jobId}`));
});

test("cancel while awaiting approval has no effect and fences a later approval", async (t) => {
  const h = await harness(t, true);
  const response = await h.submit(h.request());
  const pending = h.connector.pendingCommandApproval()!;
  const receipt = await h.frame(h.request({ toolId: "jobs_cancel", payload: { jobId: response.jobId }, idempotencyKey: "cancel-1" }));
  assert.equal((receipt.data as { cancellation: { effect: string } }).cancellation.effect, "no_effect");
  await h.state(response.jobId!, "cancelled");
  assert.equal(h.connector.answerCommandApproval(response.jobId!, pending.nonce, true), false);
  await tick();
  assert.equal(h.calls.length, 0);
});

test("a waiting command names the conversation that asked", async (t) => {
  const h = await harness(t, true);
  const response = await h.submit(h.request({ clientId: "mcp-" + "0".repeat(32) + "-k7m2qa" }));
  assert.equal(response.status, "awaiting_approval");
  await tick();
  assert.equal(h.connector.pendingCommandApproval()?.session, "k7m2qa");
});

test("non-shell tools are unaffected when approvals are on", async (t) => {
  const h = await harness(t, true);
  const response = await h.submit(h.request({ toolId: "files_read", operationClass: "read", payload: { path: "README.md" } }));
  await h.state(response.jobId!, "completed");
  assert.deepEqual(h.calls, [{ name: "fs.read", approvalGranted: false }]);
  assert.equal(h.connector.pendingCommandApproval(), undefined);
  assert.equal(RUNNER_NAMES.files_read, "fs.read");
});

test("the waiting list goes to the relay when it changes, and never when nothing waits", async (t) => {
  const quiet = await harness(t, false);
  const direct = await quiet.submit(quiet.request());
  await quiet.state(direct.jobId!, "completed");
  assert.deepEqual(quiet.transport.approvals, [], "with approvals off the relay hears nothing");

  const h = await harness(t, true);
  const first = await h.submit(h.request());
  assert.equal(h.transport.approvals.length, 1);
  const notice = h.transport.approvals[0]!.pending[0]!;
  assert.equal(notice.jobId, first.jobId);
  assert.equal(notice.executable, "node.exe");
  assert.match(notice.nonce, /^[0-9a-f]{64}$/);
  assert.equal(notice.nonce, h.connector.pendingCommandApproval()!.nonce);
  assert.ok(Date.parse(notice.expiresAt) > Date.now() - 365 * 24 * 3_600_000);
  const second = await h.submit(h.request());
  assert.deepEqual(h.transport.approvals.at(-1)!.pending.map((item) => item.jobId), [first.jobId, second.jobId]);
  // Reading the list again changes nothing, so it sends nothing.
  const sends = h.transport.approvals.length;
  h.connector.pendingCommandApproval();
  assert.equal(h.transport.approvals.length, sends);
  // An answer from the terminal removes it from the dashboard too.
  assert.equal(h.connector.answerCommandApproval(first.jobId!, notice.nonce, false), true);
  assert.deepEqual(h.transport.approvals.at(-1)!.pending.map((item) => item.jobId), [second.jobId]);
  // A cancelled command leaves the list as well, and the list can end up empty.
  await h.frame(h.request({ toolId: "jobs_cancel", payload: { jobId: second.jobId }, idempotencyKey: "cancel-list" }));
  await h.state(second.jobId!, "cancelled");
  assert.deepEqual(h.transport.approvals.at(-1)!.pending, []);
});

test("an expired command leaves the waiting list", async (t) => {
  const h = await harness(t, true);
  await h.submit(h.request());
  assert.equal(h.transport.approvals.at(-1)!.pending.length, 1);
  h.advance(301_000);
  assert.equal(h.connector.pendingCommandApproval(), undefined);
  assert.deepEqual(h.transport.approvals.at(-1)!.pending, []);
});

test("a command still waiting after a reconnect is reported again", async (t) => {
  const h = await harness(t, true);
  const response = await h.submit(h.request());
  const before = h.transport.approvals.length;
  await h.reconnect();
  assert.equal(h.transport.approvals.length, before + 1);
  assert.deepEqual(h.transport.approvals.at(-1)!.pending.map((item) => item.jobId), [response.jobId]);
});

test("a signed dashboard answer approves once, runs once and is recorded as remote", async (t) => {
  const h = await harness(t, true);
  const response = await h.submit(h.request());
  const pending = h.connector.pendingCommandApproval()!;
  const answer = h.dashboardAnswer(response.jobId!, pending.nonce, true);
  await h.transport.emit({ type: "approval_answer", answer });
  await h.state(response.jobId!, "completed");
  assert.deepEqual(h.calls, [{ name: "process.start", approvalGranted: true }]);
  assert.deepEqual(h.notices, [`${pending.summary.code}:true`], "the person at the computer is told");
  assert.ok(h.origins.includes("approved:remote"));
  // Replaying the same signed answer does nothing.
  await h.transport.emit({ type: "approval_answer", answer });
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.notices.length, 1);
});

test("a signed dashboard denial blocks the command without running it", async (t) => {
  const h = await harness(t, true);
  const response = await h.submit(h.request());
  const pending = h.connector.pendingCommandApproval()!;
  await h.transport.emit({ type: "approval_answer", answer: h.dashboardAnswer(response.jobId!, pending.nonce, false) });
  await h.state(response.jobId!, "blocked_policy");
  await tick();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.notices, [`${pending.summary.code}:false`]);
  assert.ok(h.origins.includes("denied:remote"));
});

test("the terminal still records its answers as local", async (t) => {
  const h = await harness(t, true);
  const response = await h.submit(h.request());
  const pending = h.connector.pendingCommandApproval()!;
  assert.equal(h.connector.answerCommandApproval(response.jobId!, pending.nonce, true), true);
  await h.state(response.jobId!, "completed");
  assert.ok(h.origins.includes("approved:local"));
  assert.deepEqual(h.notices, [], "no notice is needed for an answer typed at the computer");
});

test("an answer that is not exactly right leaves the command waiting and runs nothing", async (t) => {
  const h = await harness(t, true);
  const response = await h.submit(h.request());
  const pending = h.connector.pendingCommandApproval()!;
  const jobId = response.jobId!;
  const stranger = generateKeyPairSync("ed25519").privateKey;
  const good = h.dashboardAnswer(jobId, pending.nonce, true);
  // The harness clock is fixed, so times are relative to when this answer was issued.
  const at = (offsetMs: number) => new Date(Date.parse(String(good.claims.issuedAt)) + offsetMs).toISOString();
  const refused: Record<string, unknown> = {
    "wrong signing key": h.dashboardAnswer(jobId, pending.nonce, true, {}, stranger),
    "key that is not pinned": h.dashboardAnswer(jobId, pending.nonce, true, {}, relayKey.privateKey, "other"),
    "changed after signing": { ...good, claims: { ...good.claims, approved: false } },
    "no signature": { ...good, signature: "" },
    "another account": h.dashboardAnswer(jobId, pending.nonce, true, { accountId: "account-other" }),
    "another device": h.dashboardAnswer(jobId, pending.nonce, true, { deviceId: "device-other" }),
    "an old connection": h.dashboardAnswer(jobId, pending.nonce, true, { deviceEpoch: "4" }),
    "another relay": h.dashboardAnswer(jobId, pending.nonce, true, { audience: "evil.example" }),
    "something else the relay signed": h.dashboardAnswer(jobId, pending.nonce, true, { purpose: "other" }),
    "signed properly but expired a moment ago": h.dashboardAnswer(jobId, pending.nonce, true, { issuedAt: at(-61_000), expiresAt: at(-1_000) }),
    "still in date but ending before it starts": h.dashboardAnswer(jobId, pending.nonce, true, { issuedAt: at(20_000), expiresAt: at(10_000) }),
    "issued too far in the future": h.dashboardAnswer(jobId, pending.nonce, true, { issuedAt: at(3_600_000), expiresAt: at(3_660_000) }),
    "a date that is not a date": h.dashboardAnswer(jobId, pending.nonce, true, { expiresAt: "soon" }),
    "too long a lifetime": h.dashboardAnswer(jobId, pending.nonce, true, { expiresAt: at(121_000) }),
    "approved is not a boolean": h.dashboardAnswer(jobId, pending.nonce, true, { approved: "true" }),
    "an extra claim": h.dashboardAnswer(jobId, pending.nonce, true, { extra: "x" }),
    "a missing claim": h.dashboardAnswer(jobId, pending.nonce, true, { nonce: undefined }),
    "the wrong nonce": h.dashboardAnswer(jobId, "0".repeat(64), true),
    "another job": h.dashboardAnswer("job-other", pending.nonce, true),
    "not an answer at all": "approve",
    "an extra field": { ...good, extra: true },
  };
  for (const [name, answer] of Object.entries(refused)) {
    await h.transport.emit({ type: "approval_answer", answer });
    await tick();
    assert.equal(h.calls.length, 0, name);
    assert.equal(await h.state(jobId), "awaiting_approval", name);
    assert.deepEqual(h.notices, [], name);
  }
  // The real answer still works afterwards, so none of those used it up.
  await h.transport.emit({ type: "approval_answer", answer: good });
  await h.state(jobId, "completed");
  assert.equal(h.calls.length, 1);
});

test("the Runner says where to answer, for each way it can be started", () => {
  assert.match(commandApprovalsMessage("https://mcp.aiboard.me", true), /in this terminal or at https:\/\/mcp\.aiboard\.me\/approvals\./);
  assert.match(commandApprovalsMessage("https://mcp.aiboard.me", false), /at https:\/\/mcp\.aiboard\.me\/approvals \(this terminal cannot answer\)/);
  assert.match(commandApprovalsMessage(undefined, true), /in this terminal\./);
  assert.match(commandApprovalsMessage(undefined, false), /nowhere/);
  assert.match(commandApprovalsMessage("https://mcp.aiboard.me", true), /5 minutes/);
});

test("approval summaries are bounded, escaped and carry no input data or environment", () => {
  const control = commandApprovalSummary("job-1", "ABC123", "process.start",
    { command: "/usr/bin/bash", args: ["-c", "echo \u001b[31mred\u0007\nnext\u202e", "x".repeat(400)], env: { SECRET: "do-not-show" } }, tmpdir());
  assert.equal(control.executable, "bash");
  assert.equal(control.argumentCount, 3);
  assert.ok(control.commandLine.length <= 200);
  assert.doesNotMatch(control.commandLine, /[\u0000-\u001f\u007f-\u009f\u202e]/);
  assert.match(control.commandLine, /\\u001b\[31mred\\u0007\\u000anext\\u202e/);
  assert.doesNotMatch(JSON.stringify(control), /do-not-show|SECRET/);
  // What a command is searched for afterwards does not change what is being approved.
  const searched = commandApprovalSummary("job-1b", "ABC123", "process.run", { command: "node", args: ["noisy.mjs"], search: { pattern: "NEEDLE" } }, tmpdir());
  assert.equal(searched.commandLine, "node noisy.mjs");
  // A session command is approved as the script it runs, in the shell it names, pwsh included.
  const session = commandApprovalSummary("job-1c", "ABC123", "process.run", { shell: "pwsh", script: "$x = 1", shellSession: "main" }, tmpdir());
  assert.equal(session.commandLine, "pwsh $x = 1");
  assert.throws(() => commandApprovalSummary("job-1d", "ABC123", "process.run", { command: "node", shellSession: "main" }, tmpdir()), /Invalid approval payload/u);
  const stdin = commandApprovalSummary("job-2", "ABC123", "process.write_stdin",
    { processId: "p-1", writeId: "w-1", data: "password123\n" }, tmpdir());
  assert.equal(stdin.commandLine, "");
  assert.doesNotMatch(JSON.stringify(stdin), /password123/);
  assert.equal(stdin.cwdCategory, "not applicable");
  // T1 A11: an interaction turn is summarized exactly like the write it contains.
  const turn = commandApprovalSummary("job-2b", "ABC123", "process.interact",
    { processId: "p-1", data: "password123", until: { idleMs: 1500 }, waitMs: 5000 }, tmpdir());
  assert.equal(turn.commandLine, "");
  assert.doesNotMatch(JSON.stringify(turn), /password123/);
  assert.equal(turn.cwdCategory, "not applicable");
  assert.throws(() => commandApprovalSummary("job-2c", "ABC123", "process.interact", { processId: "p-1", writeId: "model-chosen" }, tmpdir()));
  assert.throws(() => commandApprovalSummary("job-3", "ABC123", "process.start", { command: "x", injected: true }, tmpdir()));
  assert.throws(() => commandApprovalSummary("job-4", "ABC123", "fs.write", { path: "x" }, tmpdir()));
  assert.equal(commandApprovalSummary("job-5", "ABC123", "process.signal", { processId: "p-1", signal: "SIGTERM", otherSession: true }, tmpdir()).toolName, "process.signal");
  assert.throws(() => commandApprovalSummary("job-6", "ABC123", "process.signal", { processId: "p-1", signal: "SIGTERM", otherSession: "yes" }, tmpdir()));
});

test("the terminal prompt reads one key from a TTY and never answers without one", async () => {
  const request: CommandApprovalRequest = { nonce: "a".repeat(64), summary: commandApprovalSummary("job-1", "ABC123", "process.start", { command: "node" }, tmpdir()) };
  const tty = () => Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(this: { isRaw: boolean }, mode: boolean) { this.isRaw = mode; return this; } });
  const output: string[] = [];
  const yes = tty();
  const answeredYes = promptCommandApproval(request, yes, (text) => output.push(text));
  yes.write("y");
  assert.equal(await answeredYes, true);
  assert.equal(yes.isRaw, false, "raw mode is restored");
  assert.match(output.join(""), /Remote command approval ABC123/);
  assert.doesNotMatch(output.join(""), /Session:/);
  const named: string[] = [];
  const answeredNamed = promptCommandApproval({ ...request, session: "k7m2qa" }, yes, (text) => named.push(text));
  yes.write("n");
  assert.equal(await answeredNamed, false);
  assert.ok(named.join("").includes("\nSession: k7m2qa\nAllow? [y/N] "), named.join(""));
  const no = tty();
  const answeredNo = promptCommandApproval(request, no, () => undefined);
  no.write("x");
  assert.equal(await answeredNo, false, "anything but y/Y is a denial");
  const interrupted = tty();
  let interruptCalls = 0;
  const answeredInterrupt = promptCommandApproval(request, interrupted, () => undefined, undefined, () => { interruptCalls += 1; });
  interrupted.write("\u0003");
  assert.equal(await answeredInterrupt, undefined);
  assert.equal(interruptCalls, 1);
  const pipe = new PassThrough();
  assert.equal(await promptCommandApproval(request, pipe, () => undefined), undefined, "a non-TTY never answers");
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await promptCommandApproval(request, tty(), () => undefined, aborted.signal), undefined);
});

test("aiboard remote parses approval flags and refuses conflicts", () => {
  assert.ok(parseLauncherArguments(["remote", "--approve-commands"]).runnerFlags.includes("--approve-commands"));
  assert.ok(parseLauncherArguments(["remote", "--no-approve-commands"]).runnerFlags.includes("--no-approve-commands"));
  assert.throws(() => parseLauncherArguments(["remote", "--approve-commands", "--no-approve-commands"]), /invalid_arguments/);
  assert.throws(() => parseLauncherArguments(["start", "--approve-commands"]), /invalid_arguments/);
});

test("approvals travel only over the HMAC-keyed launcher control channel", async (t) => {
  const key = randomBytes(32);
  let pending: CommandApprovalRequest = { nonce: "b".repeat(64),
    summary: commandApprovalSummary("job-7", "C0FFEE", "process.start", { command: "node", args: ["-v"] }, tmpdir()) };
  const answers: string[] = [];
  const control = await startLauncherControl({
    identity: { projectPath: tmpdir(), projectKey: "p".repeat(16), owner: "test-owner" },
    instanceId: "instance-1", version: "0.0.0-test", startedAt: 1_700_000_000_000, port: 1, token: "t".repeat(43),
    controlKey: key, shutdown: () => undefined,
    nextApproval: () => pending,
    answerApproval: (jobId, nonce, approved) => { answers.push(`${jobId}:${nonce.slice(0, 4)}:${approved}`); return jobId === "job-7"; },
  });
  t.after(async () => { await control.close(); });
  const polled = await requestLauncherApproval(control.instance, key);
  assert.deepEqual(polled.approval, pending);
  // The conversation that asked travels too, so the terminal can name it.
  pending = { ...pending, session: "k7m2qa" };
  assert.deepEqual((await requestLauncherApproval(control.instance, key)).approval, pending);
  pending = { ...pending, session: "Bad code" };
  await assert.rejects(requestLauncherApproval(control.instance, key));
  pending = { nonce: pending.nonce, summary: pending.summary };
  assert.deepEqual(await requestLauncherApproval(control.instance, key, { jobId: "job-7", nonce: pending.nonce, approved: true }), { accepted: true });
  assert.deepEqual(answers, ["job-7:bbbb:true"]);
  // A caller without the per-instance key gets nothing and cannot answer.
  await assert.rejects(requestLauncherApproval(control.instance, randomBytes(32)));
  await assert.rejects(requestLauncherApproval(control.instance, randomBytes(32), { jobId: "job-7", nonce: pending.nonce, approved: true }));
  assert.deepEqual(answers, ["job-7:bbbb:true"]);
  await assert.rejects(requestLauncherApproval(control.instance, key, { jobId: "job 7", nonce: pending.nonce, approved: true }), /Invalid approval answer/);
});
