import assert from "node:assert/strict";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createRemoteAdmissionAdapter, RemoteAdmissionError, RemoteAdmissionStore, remotePayloadDigest,
  type RemoteAdmissionStoreOptions, type RemoteJob, type RemoteJobState, type RemoteRequest } from "../src/remote-admission-store.js";

const identity = { accountId: "account-1", clientId: "client-1", deviceId: "device-1" };
const other = { ...identity, clientId: "other-client" };
const key = Buffer.alloc(32, 23);
const start = Date.parse("2026-10-27T12:00:00.000Z");
const contractRoot = join(process.cwd(), "docs", "remote", "r0", "contracts");

function isCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RemoteAdmissionError && error.code === code;
}

interface Harness {
  store: RemoteAdmissionStore;
  path: string;
  root: string;
  request: (name: string) => RemoteRequest;
  now: (milliseconds: number) => void;
}

async function withStore(work: (h: Harness) => Promise<void> | void, options: RemoteAdmissionStoreOptions = {}): Promise<void> {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".remote-job-store-"));
  const path = join(root, "jobs.sqlite");
  const base = JSON.parse(await readFile(join(contractRoot, "fixtures", "valid", "remote-request.valid.write.json"), "utf8")) as RemoteRequest;
  let time = start;
  const store = new RemoteAdmissionStore(path, key, { ...options, clock: () => new Date(time) });
  store.reconcileStartup();
  store.registerAuthenticatedEpoch(identity, "5");
  const harness: Harness = { store, path, root, request: (name) => ({ ...base, requestId: name, idempotencyKey: name }),
    now: (milliseconds) => { time = start + milliseconds; } };
  try { await work(harness); }
  finally { harness.store.close(); await rm(root, { recursive: true, force: true }); }
}

function admit(h: Harness, name: string): RemoteJob {
  return h.store.admit(identity, JSON.stringify(h.request(name))).job;
}

function inState(h: Harness, state: RemoteJobState, name: string): RemoteJob {
  const job = admit(h, name);
  switch (state) {
    case "queued": return job;
    case "awaiting_approval": return h.store.markAwaitingApproval(identity, job.jobId);
    case "running": return h.store.markDispatching(identity, job.jobId, "5");
    case "blocked_policy": return h.store.blockPolicy(identity, job.jobId);
    case "blocked_quota": return h.store.blockQuota(identity, job.jobId);
    case "cancelled":
      h.store.requestCancel(identity, job.jobId, "cancel-" + name, "trace-" + name);
      return h.store.getJob(identity, job.jobId)!;
    case "completed": case "failed": case "outcome_unknown":
      h.store.markDispatching(identity, job.jobId, "5");
      return h.store.settle(identity, job.jobId, state);
  }
}

test("the full transition graph is enforced by methods and SQLite", async () => withStore((h) => {
  const states: RemoteJobState[] = ["queued", "awaiting_approval", "running", "completed", "failed", "cancelled", "outcome_unknown", "blocked_policy", "blocked_quota"];
  const actions: { name: string; from: RemoteJobState; to: RemoteJobState; run: (id: string) => RemoteJob }[] = [
    { name: "wait", from: "queued", to: "awaiting_approval", run: (id) => h.store.markAwaitingApproval(identity, id) },
    { name: "approve", from: "awaiting_approval", to: "queued", run: (id) => h.store.approve(identity, id) },
    { name: "deny", from: "awaiting_approval", to: "blocked_policy", run: (id) => h.store.denyApproval(identity, id) },
    { name: "policy", from: "queued", to: "blocked_policy", run: (id) => h.store.blockPolicy(identity, id) },
    { name: "quota", from: "queued", to: "blocked_quota", run: (id) => h.store.blockQuota(identity, id) },
    { name: "dispatch", from: "queued", to: "running", run: (id) => h.store.markDispatching(identity, id, "5") },
    ...(["completed", "failed", "outcome_unknown"] as const).map((to) => ({ name: "settle-" + to,
      from: "running" as const, to, run: (id: string) => h.store.settle(identity, id, to) })),
    ...(["completed", "failed"] as const).map((to) => ({ name: "reconcile-" + to,
      from: "outcome_unknown" as const, to, run: (id: string) => h.store.reconcileUnknown(identity, id, to, "independent evidence") })),
  ];
  for (const state of states) for (const action of actions) {
    const job = inState(h, state, state + "-" + action.name);
    if (state === action.from) assert.equal(action.run(job.jobId).state, action.to, state + " -> " + action.name);
    else {
      assert.throws(() => action.run(job.jobId), state + " -> " + action.name);
      assert.equal(h.store.getJob(identity, job.jobId)?.state, state);
    }
  }
  const unknown = inState(h, "outcome_unknown", "missing-evidence");
  assert.throws(() => h.store.reconcileUnknown(identity, unknown.jobId, "completed", "   "), isCode("invalid_request"));
  assert.throws(() => h.store.settle(identity, unknown.jobId, "awaiting_device" as "completed"), isCode("invalid_request"));
  const running = inState(h, "running", "trigger-running");
  const completed = inState(h, "completed", "trigger-completed");
  const queued = admit(h, "trigger-relay-only");
  const db = new DatabaseSync(h.path);
  try {
    assert.throws(() => db.prepare("UPDATE remote_jobs SET state = 'queued', dispatching = 0 WHERE job_id = ?").run(running.jobId));
    assert.throws(() => db.prepare("UPDATE remote_jobs SET state = 'running', dispatching = 1 WHERE job_id = ?").run(completed.jobId));
    assert.throws(() => db.prepare("UPDATE remote_jobs SET state = 'awaiting_device' WHERE job_id = ?").run(queued.jobId));
    assert.throws(() => db.prepare("UPDATE remote_jobs SET state = 'completed' WHERE job_id = ?").run(unknown.jobId));
  } finally { db.close(); }
}));

test("queued and approval cancellation is atomic, idempotent and fences dispatch and late approval", async () => withStore((h) => {
  for (const state of ["queued", "awaiting_approval"] as const) {
    const job = inState(h, state, "cancel-" + state);
    const receipt = h.store.requestCancel(identity, job.jobId, "cancel-1", "trace-1");
    assert.deepEqual(receipt.cancellation, { requestedAt: new Date(start).toISOString(), stop: "stopped", effect: "no_effect" });
    assert.deepEqual(h.store.requestCancel(identity, job.jobId, "cancel-1", "changed-trace"), receipt);
    assert.deepEqual(h.store.requestCancel(identity, job.jobId, "different-id", "different-trace"), receipt);
    assert.equal(h.store.view(identity, job.jobId).job.state, "cancelled");
    assert.throws(() => h.store.markDispatching(identity, job.jobId, "5"));
    assert.throws(() => h.store.approve(identity, job.jobId));
    const events = h.store.events(identity, job.jobId).events;
    assert.deepEqual(events.slice(-2).map((event) => event.kind), ["cancel_requested", "state_changed"]);
    assert.equal(events.at(-1)?.cancellation?.effect, "no_effect");
  }
}));

test("running cancellation requires evidence, and completion can win the race", async () => withStore((h) => {
  const known = inState(h, "running", "cancel-known");
  const receipt = h.store.requestCancel(identity, known.jobId, "cancel-1", "trace-1");
  assert.equal(receipt.cancellation.stop, "pending");
  assert.equal(h.store.getJob(identity, known.jobId)?.state, "running");
  assert.throws(() => h.store.settleCancelled(identity, known.jobId, "known"), /verified stop/);
  h.store.recordStop(identity, known.jobId, "unverified");
  assert.throws(() => h.store.settleCancelled(identity, known.jobId, "no_effect"), /verified stop/);
  h.store.recordStop(identity, known.jobId, "verified");
  assert.throws(() => h.store.recordStop(identity, known.jobId, "unverified"), /downgraded/);
  const settled = h.store.settleCancelled(identity, known.jobId, "known", { inline: Buffer.from("result") });
  assert.equal(settled.state, "cancelled");
  assert.equal(settled.cancellation?.effect, "known");
  assert.equal(Buffer.from(h.store.result(identity, known.jobId).inline!).toString(), "result");
  assert.deepEqual(h.store.requestCancel(identity, known.jobId, "cancel-1", "trace-changed"), receipt);

  const noEffect = inState(h, "running", "cancel-no-effect");
  h.store.requestCancel(identity, noEffect.jobId, "cancel-no-effect", "trace-no-effect");
  h.store.recordStop(identity, noEffect.jobId, "verified");
  assert.equal(h.store.settleCancelled(identity, noEffect.jobId, "no_effect").state, "cancelled");

  const unknown = inState(h, "running", "cancel-unknown");
  h.store.requestCancel(identity, unknown.jobId, "cancel-2", "trace-2");
  const uncertain = h.store.settleCancelled(identity, unknown.jobId, "effect_outcome_unknown");
  assert.equal(uncertain.state, "outcome_unknown");
  assert.equal(uncertain.cancellation?.stop, "unverified");
  assert.equal(uncertain.cancellation?.effect, "effect_outcome_unknown");
  assert.ok(h.store.events(identity, unknown.jobId).events.some((event) => event.kind === "effect_outcome_unknown"));

  const stoppedUnknown = inState(h, "running", "stopped-unknown");
  h.store.requestCancel(identity, stoppedUnknown.jobId, "stopped-unknown", "trace-unknown");
  h.store.recordStop(identity, stoppedUnknown.jobId, "verified");
  assert.equal(h.store.settleCancelled(identity, stoppedUnknown.jobId, "effect_outcome_unknown").cancellation?.stop, "stopped");

  for (const state of ["completed", "failed"] as const) {
    const racing = inState(h, "running", "race-" + state);
    const original = h.store.requestCancel(identity, racing.jobId, "cancel-race", "trace-race");
    const finished = h.store.settle(identity, racing.jobId, state);
    assert.equal(finished.state, state);
    assert.equal(finished.cancellation?.effect, "known");
    assert.equal(finished.cancellation?.stop, "pending");
    assert.deepEqual(h.store.requestCancel(identity, racing.jobId, "cancel-race", "trace-race"), original);
    assert.throws(() => h.store.settleCancelled(identity, racing.jobId, "known"));
  }
}));

test("cancel on every terminal outcome preserves its proven state", async () => withStore((h) => {
  for (const state of ["completed", "failed", "cancelled", "outcome_unknown", "blocked_policy", "blocked_quota"] as const) {
    const job = inState(h, state, "terminal-cancel-" + state);
    const receipt = h.store.requestCancel(identity, job.jobId, "terminal-cancel", "terminal-trace");
    assert.equal(receipt.delivery, "recorded");
    assert.equal(h.store.view(identity, job.jobId).job.state, state);
    if (state === "outcome_unknown") {
      assert.equal(receipt.cancellation.stop, "unverified");
      assert.equal(receipt.cancellation.effect, "effect_outcome_unknown");
    }
    assert.deepEqual(h.store.requestCancel(identity, job.jobId, receipt.cancelRequestId, "other"), receipt);
  }
}));

test("restart reconciles ambiguous dispatches with and without cancellation, without replay", async () => withStore((h) => {
  const plain = inState(h, "running", "restart-plain");
  const cancelled = inState(h, "running", "restart-cancel");
  h.store.requestCancel(identity, cancelled.jobId, "restart-cancel-id", "restart-trace");
  h.store.recordStop(identity, cancelled.jobId, "verified");
  h.store.close();
  h.store = new RemoteAdmissionStore(h.path, key, () => new Date(start));
  const recovered = h.store.reconcileStartup();
  assert.deepEqual(new Set(recovered.map((job) => job.jobId)), new Set([plain.jobId, cancelled.jobId]));
  assert.deepEqual(h.store.reconcileStartup(), []);
  assert.equal(h.store.getJob(identity, plain.jobId)?.state, "outcome_unknown");
  const uncertain = h.store.view(identity, cancelled.jobId).job;
  assert.equal(uncertain.state, "outcome_unknown");
  assert.equal(uncertain.cancellation?.stop, "unverified");
  assert.equal(uncertain.cancellation?.effect, "effect_outcome_unknown");
  assert.deepEqual(h.store.events(identity, cancelled.jobId).events.slice(-3).map((event) => event.kind),
    ["stopped", "effect_outcome_unknown", "reconciled"]);
  assert.throws(() => h.store.markDispatching(identity, cancelled.jobId, "5"));
  assert.throws(() => h.store.reconcileUnknown(identity, cancelled.jobId, "completed", ""), isCode("invalid_request"));
  const resolved = h.store.reconcileUnknown(identity, cancelled.jobId, "completed", "verified tool evidence");
  assert.equal(resolved.state, "completed");
  assert.equal(resolved.cancellation?.effect, "known");
  assert.equal(resolved.cancellation?.stop, "unverified");
  assert.equal(h.store.events(identity, cancelled.jobId).events.at(-1)?.kind, "reconciled");
  assert.throws(() => h.store.reconcileUnknown(identity, cancelled.jobId, "failed", "another observation"));
}));

test("unresolved outcomes and stop evidence survive result expiry and retention pruning", async () => withStore((h) => {
  const job = inState(h, "running", "unresolved-retention");
  h.store.requestCancel(identity, job.jobId, "retain-cancel", "retain-trace");
  h.store.settleCancelled(identity, job.jobId, "effect_outcome_unknown");
  const eventCount = h.store.events(identity, job.jobId).events.length;
  h.now(2000);
  assert.equal(h.store.expireResults(), 1);
  assert.equal(h.store.pruneEvents(new Date(start + 3000)), 0);
  assert.equal(h.store.pruneJobs(new Date(start + 3000)), 0);
  assert.equal(h.store.getJob(identity, job.jobId)?.state, "outcome_unknown");
  assert.equal(h.store.events(identity, job.jobId).events.length, eventCount + 1);
}, { resultTtlMs: 1000 }));

test("results are encrypted, bounded, TTL-limited, and expiry preserves the job outcome", async () => withStore(async (h) => {
  const job = admit(h, "ttl");
  assert.deepEqual(h.store.readRequest(identity, job.jobId), h.request("ttl"));
  h.store.markDispatching(identity, job.jobId, "5");
  assert.throws(() => h.store.readRequest(identity, job.jobId), isCode("invalid_request"));
  const db = new DatabaseSync(h.path, { readOnly: true });
  try {
    assert.deepEqual({ ...db.prepare("SELECT request_iv, request_tag, request_ciphertext FROM remote_jobs WHERE job_id = ?").get(job.jobId) },
      { request_iv: null, request_tag: null, request_ciphertext: null });
  } finally { db.close(); }
  assert.throws(() => h.store.settle(identity, job.jobId, "completed", { inline: Buffer.alloc(256 * 1024 + 1) }), isCode("invalid_request"));
  assert.equal(h.store.getJob(identity, job.jobId)?.state, "running");
  const secret = Buffer.from("inline-secret-result-82d3b2");
  assert.throws(() => h.store.settle(identity, job.jobId, "completed", { outputRef: "not-an-artifact-hash" }), isCode("invalid_request"));
  const outputRef = "a".repeat(64);
  const completed = h.store.settle(identity, job.jobId, "completed", { inline: secret, outputRef });
  assert.equal(completed.resultExpiresAt, new Date(start + 1000).toISOString());
  assert.deepEqual(h.store.result(identity, job.jobId), { state: "completed", inline: secret, outputRef });
  for (const name of await readdir(h.root)) {
    assert.equal((await readFile(join(h.root, name))).includes(secret), false, name);
  }
  h.now(1000);
  assert.throws(() => h.store.result(identity, job.jobId), isCode("result_expired"));
  assert.equal(h.store.view(identity, job.jobId).job.outputRef, undefined);
  assert.equal(h.store.expireResults(identity), 1);
  assert.equal(h.store.expireResults(identity), 0);
  assert.equal(h.store.getJob(identity, job.jobId)?.state, "completed");
  assert.equal(h.store.events(identity, job.jobId).events.at(-1)?.kind, "result_expired");
  const max = inState(h, "running", "max-inline");
  h.store.settle(identity, max.jobId, "failed", { inline: Buffer.alloc(256 * 1024, 7) });
  assert.equal(h.store.result(identity, max.jobId).inline?.byteLength, 256 * 1024);
  const uncertain = inState(h, "running", "result-reconcile");
  h.store.settle(identity, uncertain.jobId, "outcome_unknown", { inline: Buffer.from("partial evidence") });
  h.store.reconcileUnknown(identity, uncertain.jobId, "failed", "tool journal proves failure");
  assert.equal(Buffer.from(h.store.result(identity, uncertain.jobId).inline!).toString(), "partial evidence");
}, { resultTtlMs: 1000 }));

test("tombstones survive pruning and reserve capacity before execution", async () => withStore(async (h) => {
  const request = h.request("permanent-key");
  const first = h.store.admit(identity, JSON.stringify(request));
  h.store.markDispatching(identity, first.job.jobId, "5");
  h.store.settle(identity, first.job.jobId, "completed", { outputRef: "b".repeat(64) });
  h.now(1001);
  assert.equal(h.store.expireResults(), 1);
  h.now(2000);
  assert.equal(h.store.pruneJobs(new Date(start + 2001)), 1);
  assert.equal(h.store.getJob(identity, first.job.jobId), undefined);
  assert.throws(() => h.store.result(identity, first.job.jobId), isCode("result_expired"));
  assert.throws(() => h.store.result(other, first.job.jobId), isCode("not_found"));
  let dispatches = 0;
  const retry = h.store.admit(identity, JSON.stringify(request));
  if (retry.created) { dispatches++; h.store.markDispatching(identity, retry.job.jobId, "5"); }
  assert.equal(retry.created, false);
  assert.equal(retry.job.jobId, first.job.jobId);
  assert.equal(retry.job.state, "completed");
  const changed = { ...request, payload: { altered: true } };
  changed.payloadDigest = remotePayloadDigest(changed);
  assert.throws(() => h.store.admit(identity, JSON.stringify(changed)), isCode("idempotency_conflict"));
  const response = await createRemoteAdmissionAdapter(h.store)({
    principal: { identity, principalId: "remote-test", runId: "remote-run", sessionId: "remote-session", revoked: false },
    callId: "call", toolName: "fs.write", workspacePath: process.cwd(), arguments: request.payload,
    rawRequest: JSON.stringify(request), authorize: () => undefined,
  }, async () => { dispatches++; return { callId: "call", toolName: "fs.write", content: [], isError: false }; });
  assert.equal(response.isError, false);
  assert.equal(response.content[0]?.type, "json");
  assert.equal(dispatches, 0);
  const reserved = admit(h, "capacity-reserved");
  assert.throws(() => admit(h, "capacity-overflow"), isCode("storage_exhausted"));
  assert.equal(h.store.admit(identity, JSON.stringify(request)).job.jobId, first.job.jobId);
  assert.equal(h.store.admit(identity, JSON.stringify(h.request("capacity-reserved"))).job.jobId, reserved.jobId);
  h.store.blockQuota(identity, reserved.jobId);
  assert.throws(() => admit(h, "capacity-still-full"), isCode("storage_exhausted"));
}, { resultTtlMs: 1000, maxTombstones: 2 }));

test("a cancellation receipt remains idempotent after its job and events are pruned", async () => withStore((h) => {
  const job = admit(h, "receipt-retention");
  const receipt = h.store.requestCancel(identity, job.jobId, "receipt-id", "receipt-trace");
  h.now(1001);
  assert.equal(h.store.expireResults(), 1);
  assert.equal(h.store.pruneJobs(new Date(start + 2000)), 1);
  assert.deepEqual(h.store.requestCancel(identity, job.jobId, "receipt-id", "ignored-trace"), receipt);
  assert.deepEqual(h.store.requestCancel(identity, job.jobId, "other-id", "other-trace"), receipt);
  assert.throws(() => h.store.requestCancel(other, job.jobId, "receipt-id", "receipt-trace"), isCode("not_found"));
}, { resultTtlMs: 1000 }));

test("event retention removes only a prefix and exposes gaps, including an empty journal", async () => withStore((h) => {
  const job = admit(h, "gap");
  const first = h.store.events(identity, job.jobId, undefined, 1);
  h.now(1000); h.store.markAwaitingApproval(identity, job.jobId);
  h.now(2000); h.store.approve(identity, job.jobId);
  assert.equal(h.store.pruneEvents(identity, new Date(start + 1500)), 2);
  const page = h.store.events(identity, job.jobId, first.nextCursor);
  assert.deepEqual(page.gap, { earliestSequence: "3" });
  assert.deepEqual(page.events.map((event) => event.sequence), ["3"]);
  h.now(3000);
  assert.equal(h.store.pruneEvents(new Date(start + 3000)), 1);
  const empty = h.store.events(identity, job.jobId, first.nextCursor);
  assert.deepEqual(empty.gap, { earliestSequence: "4" });
  assert.deepEqual(empty.events, []);
  h.store.markDispatching(identity, job.jobId, "5");
  const next = h.store.events(identity, job.jobId, empty.nextCursor);
  assert.deepEqual(next.events.map((event) => event.sequence), ["4"]);
  assert.deepEqual(next.gap, { earliestSequence: "4" });
  assert.equal(h.store.events(identity, job.jobId, next.nextCursor).gap, undefined);
  assert.throws(() => h.store.events(other, job.jobId, first.nextCursor), isCode("not_found"));
}));

test("all job operations conceal other principals and retention filters are principal-scoped", async () => withStore((h) => {
  const job = admit(h, "owner-only");
  const calls = [
    () => h.store.view(other, job.jobId), () => h.store.readRequest(other, job.jobId),
    () => h.store.events(other, job.jobId), () => h.store.result(other, job.jobId),
    () => h.store.markDispatching(other, job.jobId, "5"), () => h.store.markAwaitingApproval(other, job.jobId),
    () => h.store.approve(other, job.jobId), () => h.store.denyApproval(other, job.jobId),
    () => h.store.blockPolicy(other, job.jobId), () => h.store.blockQuota(other, job.jobId),
    () => h.store.requestCancel(other, job.jobId, "cancel", "trace"), () => h.store.recordStop(other, job.jobId, "verified"),
    () => h.store.settle(other, job.jobId, "completed"), () => h.store.settleCancelled(other, job.jobId, "known"),
    () => h.store.reconcileUnknown(other, job.jobId, "completed", "evidence"),
  ];
  assert.equal(h.store.getJob(other, job.jobId), undefined);
  for (const call of calls) assert.throws(call, isCode("not_found"));
  assert.throws(() => h.store.markDispatching({ accountId: "unregistered", clientId: "intruder", deviceId: "other-device" }, job.jobId, "5"), isCode("not_found"));
  assert.equal(h.store.pruneEvents(other, new Date(start + 1000)), 0);
  assert.equal(h.store.expireResults(other), 0);
  assert.equal(h.store.pruneJobs(other, new Date(start + 1000)), 0);
  assert.equal(h.store.events(identity, job.jobId).events.length, 1);
}));

function seedV1(path: string, base: RemoteRequest, corrupt: boolean): string {
  const db = new DatabaseSync(path);
  const queuedId = "v1-queued-job";
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE remote_device_epochs (account_id TEXT NOT NULL, device_id TEXT NOT NULL, epoch TEXT NOT NULL,
        PRIMARY KEY (account_id, device_id));
      CREATE TABLE remote_store_metadata (name TEXT PRIMARY KEY, value BLOB NOT NULL);
      CREATE TABLE remote_jobs (
        job_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, client_id TEXT NOT NULL, device_id TEXT NOT NULL,
        idempotency_key TEXT NOT NULL, payload_digest TEXT NOT NULL, protocol_version TEXT NOT NULL,
        tool_id TEXT NOT NULL, operation_class TEXT NOT NULL, scope_ref TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'outcome_unknown', 'blocked_policy')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, trace_id TEXT NOT NULL,
        dispatching INTEGER NOT NULL CHECK (dispatching IN (0, 1)), last_sequence INTEGER NOT NULL CHECK (last_sequence > 0),
        request_iv BLOB, request_tag BLOB, request_ciphertext BLOB,
        CHECK ((state = 'running' AND dispatching = 1) OR (state != 'running' AND dispatching = 0)),
        CHECK ((request_iv IS NULL AND request_tag IS NULL AND request_ciphertext IS NULL) OR
          (request_iv IS NOT NULL AND request_tag IS NOT NULL AND request_ciphertext IS NOT NULL)),
        UNIQUE (account_id, client_id, device_id, idempotency_key)
      );
      CREATE TABLE remote_job_events (job_id TEXT NOT NULL REFERENCES remote_jobs(job_id), sequence INTEGER NOT NULL,
        occurred_at TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('state_changed', 'reconciled')),
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed', 'outcome_unknown', 'blocked_policy')),
        trace_id TEXT NOT NULL, PRIMARY KEY (job_id, sequence));
    `);
    db.prepare("INSERT INTO remote_store_metadata (name, value) VALUES ('key_check', ?)")
      .run(createHmac("sha256", key).update("remote-admission-key-check-v1").digest());
    db.prepare("INSERT INTO remote_device_epochs VALUES (?, ?, ?)").run(identity.accountId, identity.deviceId, "5");
    if (corrupt) db.exec("PRAGMA ignore_check_constraints = ON");
    for (const state of ["queued", "running", "completed"] as const) {
      const jobId = "v1-" + state + "-job";
      const request = { ...base, requestId: "v1-" + state, idempotencyKey: "v1-" + state };
      const raw = JSON.stringify(request);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(JSON.stringify([identity.accountId, identity.clientId, identity.deviceId, jobId, request.payloadDigest])));
      const ciphertext = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
      db.prepare(`INSERT INTO remote_jobs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        jobId, identity.accountId, identity.clientId, identity.deviceId, request.idempotencyKey, request.payloadDigest,
        request.protocolVersion, request.toolId, request.operationClass, request.scopeRef,
        corrupt && state === "queued" ? "awaiting_device" : state, new Date(start).toISOString(), new Date(start).toISOString(),
        request.traceId, Number(state === "running"), 2, iv, cipher.getAuthTag(), ciphertext);
      const insert = db.prepare("INSERT INTO remote_job_events VALUES (?, ?, ?, 'state_changed', ?, ?)");
      insert.run(jobId, 1, new Date(start).toISOString(), "queued", request.traceId);
      insert.run(jobId, 2, new Date(start).toISOString(), state, request.traceId);
    }
    if (corrupt) db.exec("PRAGMA ignore_check_constraints = OFF");
    const cursorKey = createHmac("sha256", key).update("remote-admission-cursor-v1").digest();
    const mac = createHmac("sha256", cursorKey).update(JSON.stringify([identity.accountId, identity.clientId, identity.deviceId, queuedId, "1"])).digest("base64url");
    return "1." + mac;
  } finally { db.close(); }
}

test("v1 migration preserves rows, events, encrypted queued requests and pre-migration cursors", async () => {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".remote-job-migration-"));
  const path = join(root, "jobs.sqlite");
  const base = JSON.parse(await readFile(join(contractRoot, "fixtures", "valid", "remote-request.valid.write.json"), "utf8")) as RemoteRequest;
  let store: RemoteAdmissionStore | undefined;
  try {
    const cursor = seedV1(path, base, false);
    store = new RemoteAdmissionStore(path, key, () => new Date(start));
    assert.deepEqual(store.reconcileStartup().map((job) => job.jobId), ["v1-running-job"]);
    assert.equal(store.getJob(identity, "v1-queued-job")?.state, "queued");
    assert.equal(store.getJob(identity, "v1-completed-job")?.state, "completed");
    assert.equal(store.getJob(identity, "v1-running-job")?.state, "outcome_unknown");
    assert.equal(store.readRequest(identity, "v1-queued-job").idempotencyKey, "v1-queued");
    assert.throws(() => store!.readRequest(identity, "v1-running-job"), isCode("invalid_request"));
    const page = store.events(identity, "v1-queued-job", cursor);
    assert.deepEqual(page.events.map((event) => event.sequence), ["2"]);
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal((db.prepare("SELECT CAST(value AS TEXT) AS version FROM remote_store_metadata WHERE name = 'schema_version'").get() as { version: string }).version, "2");
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM remote_jobs").get() as { count: number }).count, 3);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM remote_job_events").get() as { count: number }).count, 7);
      assert.equal((db.prepare("SELECT COUNT(*) AS count FROM remote_job_tombstones").get() as { count: number }).count, 2);
    } finally { db.close(); }
  } finally { store?.close(); await rm(root, { recursive: true, force: true }); }
});

test("a corrupt v1 row aborts migration and leaves the entire v1 schema and data intact", async () => {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".remote-job-rollback-"));
  const path = join(root, "jobs.sqlite");
  const base = JSON.parse(await readFile(join(contractRoot, "fixtures", "valid", "remote-request.valid.write.json"), "utf8")) as RemoteRequest;
  try {
    seedV1(path, base, true);
    const before = new DatabaseSync(path, { readOnly: true });
    const snapshot = {
      tables: before.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all(),
      jobs: before.prepare("SELECT job_id, state, last_sequence FROM remote_jobs ORDER BY job_id").all(),
      events: before.prepare("SELECT * FROM remote_job_events ORDER BY job_id, sequence").all(),
    };
    before.close();
    const originalBytes = await readFile(path);
    assert.throws(() => new RemoteAdmissionStore(path, key, () => new Date(start)), isCode("schema_migration_failed"));
    const after = new DatabaseSync(path, { readOnly: true });
    try {
      assert.deepEqual(after.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name").all(), snapshot.tables);
      assert.deepEqual(after.prepare("SELECT job_id, state, last_sequence FROM remote_jobs ORDER BY job_id").all(), snapshot.jobs);
      assert.deepEqual(after.prepare("SELECT * FROM remote_job_events ORDER BY job_id, sequence").all(), snapshot.events);
      assert.equal(after.prepare("SELECT value FROM remote_store_metadata WHERE name = 'schema_version'").get(), undefined);
    } finally { after.close(); }
    assert.deepEqual(await readFile(path), originalBytes);
  } finally { await rm(root, { recursive: true, force: true }); }
});

type Schema = { required?: string[]; properties?: Record<string, Schema>; enum?: string[]; oneOf?: Schema[]; $defs?: Record<string, Schema> };

function assertFields(value: object, schema: Schema): void {
  const record = value as Record<string, unknown>;
  for (const name of schema.required ?? []) assert.ok(Object.hasOwn(record, name), "missing " + name);
  for (const name of Object.keys(record)) assert.ok(Object.hasOwn(schema.properties ?? {}, name), "unexpected " + name);
}

test("job views, cancellation receipts and event pages follow the checked-in contract field sets and enums", async () => withStore(async (h) => {
  const jobSchema = JSON.parse(await readFile(join(contractRoot, "job.v1.schema.json"), "utf8")) as Schema;
  const eventSchema = JSON.parse(await readFile(join(contractRoot, "job-event.v1.schema.json"), "utf8")) as Schema;
  const defs = jobSchema.$defs!;
  const events = eventSchema.$defs!;
  const job = inState(h, "running", "schema");
  const receipt = JSON.parse(JSON.stringify(h.store.requestCancel(identity, job.jobId, "schema-cancel", "schema-trace"))) as Record<string, unknown>;
  h.store.settleCancelled(identity, job.jobId, "effect_outcome_unknown");
  const view = JSON.parse(JSON.stringify(h.store.view(identity, job.jobId))) as { authoritative: boolean; job: Record<string, unknown> };
  const page = JSON.parse(JSON.stringify(h.store.events(identity, job.jobId))) as { jobId: string; events: Record<string, unknown>[]; nextCursor: string };
  assertFields(view, defs.jobView.oneOf![0]);
  assert.equal(view.authoritative, true);
  assertFields(view.job, jobSchema);
  assertFields(view.job.principal as object, defs.principal);
  assert.ok(defs.jobState.enum!.includes(view.job.state as string));
  assert.ok(!defs.jobState.enum!.includes("awaiting_device"));
  assert.ok(defs.remoteJobState.enum!.includes("awaiting_device"));
  const checkCancellation = (value: unknown) => {
    assert.ok(value && typeof value === "object");
    const cancellation = value as Record<string, unknown>;
    assertFields(cancellation, defs.cancellation);
    assert.ok(defs.cancellation.properties!.stop.enum!.includes(cancellation.stop as string));
    assert.ok(defs.cancellation.properties!.effect.enum!.includes(cancellation.effect as string));
  };
  checkCancellation(view.job.cancellation);
  assertFields(receipt, defs.cancelReceipt);
  assert.ok(defs.cancelReceipt.properties!.delivery.enum!.includes(receipt.delivery as string));
  assert.equal(receipt.delivery, "recorded");
  checkCancellation(receipt.cancellation);
  assertFields(page, events.page);
  let previous = 0n;
  for (const event of page.events) {
    assertFields(event, events.event);
    assert.equal(event.jobId, page.jobId);
    assert.ok(events.event.properties!.kind.enum!.includes(event.kind as string));
    assert.ok(defs.jobState.enum!.includes(event.state as string));
    assert.match(event.sequence as string, /^[1-9][0-9]*$/);
    assert.ok(BigInt(event.sequence as string) > previous);
    previous = BigInt(event.sequence as string);
    if (event.cancellation) checkCancellation(event.cancellation);
  }
  assert.ok(page.nextCursor.length > 0);
  const gapJob = admit(h, "schema-gap");
  h.now(1000);
  h.store.markAwaitingApproval(identity, gapJob.jobId);
  h.store.pruneEvents(identity, new Date(start + 500));
  const gap = h.store.events(identity, gapJob.jobId).gap;
  assert.ok(gap);
  assertFields(gap, events.page.properties!.gap);
  assert.match(gap.earliestSequence, /^[1-9][0-9]*$/);
}));
