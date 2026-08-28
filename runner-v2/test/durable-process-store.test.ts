import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { InMemoryDurableProcessStore, SqliteDurableProcessStore, canonicalRequestFingerprint, parseDurableSubprocessRecord, type DurableProcessRuntimeWriter, type PreparedSubprocessRecord } from "../src/durable-process-store.js";

const authority = () => Object.freeze({});
const fingerprint = canonicalRequestFingerprint({ runId: "run-1", invocationId: "invoke-1", command: "tool", arguments: ["--token=secret-value"], workingDirectory: "C:\\host\\project", requestedCapabilities: ["verified_emptiness"], environmentDecisions: { inheritedNames: ["PATH"], removedNames: ["API_KEY"], explicitSafeNames: [], grantedNames: [] }, grantBinding: { grantId: "grant-1", access: [] } });
const prepared = (overrides: Partial<PreparedSubprocessRecord> = {}): PreparedSubprocessRecord => ({ schemaVersion: 2, revision: 0, logicalProcessId: "proc-1", invocationId: "invoke-1", runId: "run-1", requestFingerprint: fingerprint, retryKey: "a".repeat(64), outputOwnerId: "output-proc-1", state: "prepared", history: [{ state: "prepared", at: "2026-01-01T00:00:00.000Z" }], requiredCapabilities: ["verified_emptiness"], environmentAudit: { inheritedNames: ["PATH"], removedNames: ["API_KEY"], explicitSafeNames: [], grantedNames: [] }, escalation: [], cleanup: { state: "pending" }, ...overrides });
function writerFor(store: InMemoryDurableProcessStore | SqliteDurableProcessStore, key: object): DurableProcessRuntimeWriter { return store.connectRuntime(key); }

test("constructor-bound runtime authority rejects forged transition commands", () => {
  const key = authority(); const store = new InMemoryDurableProcessStore(key); const writer = writerFor(store, key);
  writer.prepare(prepared());
  assert.throws(() => store.connectRuntime(authority()), /runtime authority/i);
  assert.equal(store.readByInvocation("invoke-1")?.state, "prepared");
});

test("strict per-state parser rejects forged prepared completion and illegal state fields", () => {
  const forged = { ...prepared(), result: { outcome: "exited", finishedAt: "x" }, backendBinding: { registryId: "r", backendId: "b", attestationVersion: 1, attestationDigest: "b".repeat(64), opaqueIdentity: "o", birthFingerprint: { observedAt: "x", discriminator: "d" } } };
  assert.throws(() => parseDurableSubprocessRecord(forged), /durable process record|prepared/i);
  assert.throws(() => parseDurableSubprocessRecord({ ...prepared(), unknown: true }), /unknown field/i);
  assert.throws(() => parseDurableSubprocessRecord({ ...prepared(), cleanup: { state: "verified_empty", verifiedAt: "x" } }), /durable process record|prepared/i);
  assert.throws(() => parseDurableSubprocessRecord({ ...prepared(), state:"backend_unavailable", history:[...prepared().history,{state:"backend_unavailable",at:"x"}], result:{outcome:"exited",finishedAt:"x"} }), /cannot contain a result|unknown field/i);
  assert.throws(() => parseDurableSubprocessRecord({ ...prepared(), state:"cleaned", history:[...prepared().history,{state:"cleaned",at:"x"}] }), /illegal transition|requires/i);
  assert.throws(()=>parseDurableSubprocessRecord({...prepared(),state:"running",history:[...prepared().history,{state:"launching",at:"b"},{state:"running",at:"c"}],backendBinding:{registryId:"registry",backendId:"fake",attestationVersion:1,attestationDigest:"b".repeat(64),opaqueIdentity:"",birthFingerprint:{observedAt:"c",discriminator:"birth"},rootPid:42,startedAt:"c"}}),/opaqueIdentity|invalid/i);
});

test("canonical request fingerprint is stable, secret-free, and changes for divergent requests", () => {
  assert.match(fingerprint, /^[a-f0-9]{64}$/); assert.equal(fingerprint.includes("secret-value"), false);
  const changed = canonicalRequestFingerprint({ runId: "run-1", invocationId: "invoke-1", command: "other", arguments: ["--token=secret-value"], workingDirectory: "C:\\host\\project", requestedCapabilities: ["verified_emptiness"], environmentDecisions: { inheritedNames: ["PATH"], removedNames: ["API_KEY"], explicitSafeNames: [], grantedNames: [] }, grantBinding: { grantId: "grant-1", access: [] } });
  assert.notEqual(changed, fingerprint);
});

test("exact prepare retries converge while divergent retries and stale CAS commands conflict", () => {
  const key = authority(); const store = new InMemoryDurableProcessStore(key); const writer = writerFor(store, key);
  assert.equal(writer.prepare(prepared()).revision, 0);
  assert.equal(writer.prepare(prepared({ logicalProcessId: "proc-retry" })).logicalProcessId, "proc-1");
  assert.throws(() => writer.prepare(prepared({ requestFingerprint: "c".repeat(64) })), /idempotency conflict/i);
  const launching = writer.apply({ type: "mark_launching", invocationId: "invoke-1", expectedRevision: 0, at: "2026-01-01T00:00:01.000Z" });
  assert.equal(launching.revision, 1);
  assert.throws(() => writer.apply({ type: "fail_launch", invocationId: "invoke-1", expectedRevision: 0, at: "x", detail: "stale" }), /revision conflict/i);
});

test("SQLite prepare is atomic across concurrent store instances and divergent requests conflict", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-process-store-")); t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "process.sqlite"); const key = authority();
  const first = new SqliteDurableProcessStore(path, { runtimeAuthority: key }); const second = new SqliteDurableProcessStore(path, { runtimeAuthority: key });
  const [left, right] = await Promise.all([Promise.resolve(writerFor(first, key).prepare(prepared())), Promise.resolve(writerFor(second, key).prepare(prepared({ logicalProcessId: "other-attempt" })))]);
  assert.equal(left.logicalProcessId, right.logicalProcessId);
  assert.throws(() => writerFor(second, key).prepare(prepared({ requestFingerprint: "d".repeat(64) })), /idempotency conflict/i);
  first.close(); second.close();
});

test("SQLite corruption fails closed on reopen instead of returning a forged cached result", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-process-store-")); t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "process.sqlite"); const key = authority(); const store = new SqliteDurableProcessStore(path, { runtimeAuthority: key });
  writerFor(store, key).prepare(prepared()); store.close();
  const raw = new DatabaseSync(path); raw.prepare("UPDATE durable_processes SET record_json = ? WHERE invocation_id = ?").run(JSON.stringify({ ...prepared(), state: "cleaned", result: { outcome: "exited", finishedAt: "x" } }), "invoke-1"); raw.close();
  const reopened = new SqliteDurableProcessStore(path, { readOnly: true });
  assert.throws(() => reopened.readByInvocation("invoke-1"), /stored durable process record|durable process record/i); reopened.close();
});

test("actual persisted row contains no command, argument, cwd, secret, native handle, or spill path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-process-store-")); t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "process.sqlite"); const key = authority(); const store = new SqliteDurableProcessStore(path, { runtimeAuthority: key }); writerFor(store, key).prepare(prepared()); store.close();
  const bytes = await readFile(path);
  for (const forbidden of ["secret-value", "--token", "C:\\host\\project", "nativeHandle", "spill.tmp"]) assert.equal(bytes.includes(Buffer.from(forbidden)), false, forbidden);
});
