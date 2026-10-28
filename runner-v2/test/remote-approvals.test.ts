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
import { APPROVAL_TOOLS, commandApprovalSummary, promptCommandApproval, type CommandApprovalRequest } from "../src/remote-approval.js";
import { RemoteAuthenticator, REMOTE_CONNECT_SCOPE, REMOTE_RELAY_AUDIENCE, type RemoteAuthorization } from "../src/remote-auth.js";
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
  private handler?: (message: RemoteTransportMessage) => void | Promise<void>;
  onProof?: () => void;
  async connect(): Promise<void> {}
  async close(): Promise<void> {}
  send(message: RemoteTransportMessage): void {
    if (message.type === "response") this.sent.push(message);
    if (message.type === "proof") this.onProof?.();
  }
  onMessage(handler: (message: RemoteTransportMessage) => void | Promise<void>): void { this.handler = handler; }
  onClose(): void {}
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
    now: clock, reconnect: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 0 },
    maxConcurrentJobsPerDevice: 4, maxQueuedJobsPerDevice: 8, cancellationGraceMs: 20, drainTimeoutMs: 20,
    auditApproval: (_identity, jobId, decision) => { audit.push(`${decision}:${jobId}`); },
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
  return { connector, calls, audit, request, submit, frame, state: jobState, advance: (ms: number) => { currentTime += ms; } };
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
  h.advance(121_000);
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

test("non-shell tools are unaffected when approvals are on", async (t) => {
  const h = await harness(t, true);
  const response = await h.submit(h.request({ toolId: "files_read", operationClass: "read", payload: { path: "README.md" } }));
  await h.state(response.jobId!, "completed");
  assert.deepEqual(h.calls, [{ name: "fs.read", approvalGranted: false }]);
  assert.equal(h.connector.pendingCommandApproval(), undefined);
  assert.equal(RUNNER_NAMES.files_read, "fs.read");
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
  const stdin = commandApprovalSummary("job-2", "ABC123", "process.write_stdin",
    { processId: "p-1", writeId: "w-1", data: "password123\n" }, tmpdir());
  assert.equal(stdin.commandLine, "");
  assert.doesNotMatch(JSON.stringify(stdin), /password123/);
  assert.equal(stdin.cwdCategory, "not applicable");
  assert.throws(() => commandApprovalSummary("job-3", "ABC123", "process.start", { command: "x", injected: true }, tmpdir()));
  assert.throws(() => commandApprovalSummary("job-4", "ABC123", "fs.write", { path: "x" }, tmpdir()));
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
  const pending: CommandApprovalRequest = { nonce: "b".repeat(64),
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
  assert.deepEqual(await requestLauncherApproval(control.instance, key, { jobId: "job-7", nonce: pending.nonce, approved: true }), { accepted: true });
  assert.deepEqual(answers, ["job-7:bbbb:true"]);
  // A caller without the per-instance key gets nothing and cannot answer.
  await assert.rejects(requestLauncherApproval(control.instance, randomBytes(32)));
  await assert.rejects(requestLauncherApproval(control.instance, randomBytes(32), { jobId: "job-7", nonce: pending.nonce, approved: true }));
  assert.deepEqual(answers, ["job-7:bbbb:true"]);
  await assert.rejects(requestLauncherApproval(control.instance, key, { jobId: "job 7", nonce: pending.nonce, approved: true }), /Invalid approval answer/);
});
