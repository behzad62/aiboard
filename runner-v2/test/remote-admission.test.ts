import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { ToolResult } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { canonicalJson, createRemoteAdmissionAdapter, parseRemoteRequest, remotePayloadDigest,
  RemoteAdmissionError, RemoteAdmissionStore, type RemoteRequest } from "../src/remote-admission-store.js";
import { RemotePrincipalStore, type RemotePrincipal, type VerifiedRemoteIdentity } from "../src/remote-principal.js";
import { RemoteToolRuntime, type RemoteEffectRequest } from "../src/remote-tool-runtime.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";

const fixtures = join(process.cwd(), "docs", "remote", "r0", "contracts", "fixtures");
const contracts = join(process.cwd(), "docs", "remote", "r0", "contracts");
const identity = { accountId: "account-1", clientId: "client-1", deviceId: "device-1" };
const other = { ...identity, clientId: "client-2" };
const key = Buffer.alloc(32, 23);
const clock = () => new Date("2026-10-27T12:00:00Z");

async function fixture(name: string): Promise<RemoteRequest> {
  return JSON.parse(await readFile(join(fixtures, "valid", name), "utf8")) as RemoteRequest;
}

function principal(value: VerifiedRemoteIdentity): RemotePrincipal {
  return { identity: value, principalId: "remote-test", runId: "remote-run-test", sessionId: "remote-session-test", revoked: false };
}

function effect(request: RemoteRequest, owner = identity, rawRequest = JSON.stringify(request)): RemoteEffectRequest {
  return { principal: principal(owner), callId: "call", toolName: "fs.write", workspacePath: process.cwd(),
    arguments: request.payload, rawRequest, authorize: () => undefined };
}

function success(): ToolResult {
  return { callId: "call", toolName: "fs.write", content: [{ type: "text", text: "ok" }], isError: false };
}

function response(result: ToolResult): Record<string, unknown> {
  const first = result.content[0];
  assert.equal(first?.type, "json");
  assert.ok(first && first.type === "json" && first.value && typeof first.value === "object");
  return first.value as Record<string, unknown>;
}

function errorCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof RemoteAdmissionError && error.code === code;
}

async function temporary<T>(work: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(process.cwd(), "runner-v2", "test", ".remote-admission-"));
  try { return await work(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

function openStore(path: string): RemoteAdmissionStore {
  const store = new RemoteAdmissionStore(path, key, clock);
  store.reconcileStartup();
  return store;
}

test("fixture digests use RFC 8785 operation canonicalization and malformed JSON fails closed", async () => {
  for (const name of ["remote-request.valid.read.json", "remote-request.valid.write.json"]) {
    const request = await fixture(name);
    assert.equal(remotePayloadDigest(request), request.payloadDigest, name);
    assert.deepEqual(parseRemoteRequest(JSON.stringify(request)), request);
  }
  assert.equal(canonicalJson({ z: [1e30, -0, 0.000001], a: "\u20ac" }), '{"a":"€","z":[1e+30,0,0.000001]}');
  assert.throws(() => canonicalJson(NaN), errorCode("invalid_request"));
  assert.throws(() => canonicalJson({ value: undefined }), errorCode("invalid_request"));
  assert.throws(() => canonicalJson("\ud800"), errorCode("invalid_request"));
  assert.throws(() => parseRemoteRequest('{"payload":{"a":1,"\\u0061":2}}'), errorCode("invalid_request"));
  assert.throws(() => parseRemoteRequest('{"payload":1,"payload":2}'), errorCode("invalid_request"));
  const prerelease = { ...await fixture("remote-request.valid.write.json"), protocolVersion: "1.0.0-preview" };
  assert.throws(() => parseRemoteRequest(JSON.stringify(prerelease)), errorCode("unsupported_version"));
});

test("one hundred concurrent retries commit once before the only dispatch", async () => temporary(async (root) => {
  const request = await fixture("remote-request.valid.write.json");
  const path = join(root, "remote-admission.sqlite");
  const store = openStore(path);
  store.registerAuthenticatedEpoch(identity, "5");
  const admit = createRemoteAdmissionAdapter(store);
  let count = 0, entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    const submissions = Array.from({ length: 100 }, () => admit(effect(request), async () => {
      count++;
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const row = db.prepare("SELECT job_id, state, dispatching FROM remote_jobs").get() as { job_id: string; state: string; dispatching: number };
        assert.equal(row.state, "running");
        assert.equal(row.dispatching, 1);
        assert.deepEqual(store.events(identity, row.job_id).events.map((event) => event.state), ["queued", "running"]);
        assert.throws(() => store.readRequest(identity, row.job_id), errorCode("invalid_request"));
      } finally { db.close(); }
      entered();
      await gate;
      return success();
    }));
    await Promise.race([started, Promise.all(submissions).then(() => { throw new Error("No dispatch entered the tool."); })]);
    assert.equal(count, 1);
    release();
    const results = await Promise.all(submissions);
    const ids = new Set(results.map((result) => response(result).jobId));
    assert.equal(ids.size, 1);
    const jobId = [...ids][0];
    assert.equal(typeof jobId, "string");
    assert.equal(store.getJob(identity, jobId as string)?.state, "completed");
    assert.throws(() => store.readRequest(identity, jobId as string), errorCode("invalid_request"));
    assert.equal(count, 1);
    const db = new DatabaseSync(path, { readOnly: true });
    try { assert.equal((db.prepare("SELECT COUNT(*) AS count FROM remote_jobs").get() as { count: number }).count, 1); }
    finally { db.close(); }
    await validate("job", store.getJob(identity, jobId as string));
    for (const result of results) await validate("remote-response", response(result));
    for (const event of store.events(identity, jobId as string).events) await validate("job-event", event);
  } finally { release?.(); store.close(); }
}));

test("conflicts, invalid digests, duplicate keys and principal mismatches never dispatch", async () => temporary(async (root) => {
  const request = await fixture("remote-request.valid.write.json");
  const store = openStore(join(root, "remote.sqlite"));
  store.registerAuthenticatedEpoch(identity, "5");
  const admit = createRemoteAdmissionAdapter(store);
  let dispatches = 0;
  const dispatch = async () => { dispatches++; return success(); };
  try {
    const first = await admit(effect(request), dispatch);
    assert.equal(dispatches, 1);
    const changed = { ...request, payload: { path: "notes.txt", content: "different" } };
    changed.payloadDigest = remotePayloadDigest(changed);
    const conflict = await admit(effect(changed), dispatch);
    assert.equal(conflict.error?.code, "idempotency_conflict");
    assert.equal(dispatches, 1);
    await validate("remote-response", response(conflict));
    const conflictError = conflict.content[1];
    assert.ok(conflictError?.type === "json");
    await validate("error", conflictError.value);
    const wrongDigest = { ...request, idempotencyKey: "bad-digest", payloadDigest: "0".repeat(64) };
    assert.equal((await admit(effect(wrongDigest), dispatch)).error?.code, "invalid_request");
    const duplicate = JSON.stringify(request).replace('"payload":', '"payload":{},"payload":');
    assert.equal((await admit(effect(request, identity, duplicate), dispatch)).error?.code, "invalid_request");
    assert.equal((await admit(effect(request, other), dispatch)).error?.code, "unauthorized");
    assert.equal(dispatches, 1);
    assert.equal(store.getJob(identity, response(first).jobId as string)?.state, "completed");
  } finally { store.close(); }
}));

test("principals with the same key remain isolated, including requests and cursors", async () => temporary(async (root) => {
  const request = await fixture("remote-request.valid.write.json");
  const second = { ...request, clientId: other.clientId };
  const store = openStore(join(root, "remote.sqlite"));
  store.registerAuthenticatedEpoch(identity, "5");
  const admit = createRemoteAdmissionAdapter(store);
  let calls = 0;
  try {
    const a = response(await admit(effect(request), async () => { calls++; return success(); }));
    const b = response(await admit(effect(second, other), async () => { calls++; return success(); }));
    assert.equal(calls, 2);
    assert.notEqual(a.jobId, b.jobId);
    assert.equal(store.getJob(other, a.jobId as string), undefined);
    assert.throws(() => store.readRequest(other, a.jobId as string), errorCode("not_found"));
    assert.throws(() => store.events(other, a.jobId as string), errorCode("not_found"));
    const cursor = store.events(identity, a.jobId as string, undefined, 1).nextCursor;
    assert.throws(() => store.events(other, b.jobId as string, cursor), errorCode("invalid_request"));
    assert.throws(() => store.events(identity, a.jobId as string, cursor.slice(0, -1) + "!"), errorCode("invalid_request"));
  } finally { store.close(); }
}));

test("restart preserves an undispatched queue and marks a dispatch marker unknown without replay", async () => temporary(async (root) => {
  const queuedRequest = await fixture("remote-request.valid.write.json");
  const activeRequest = { ...queuedRequest, requestId: "second", idempotencyKey: "second-key" };
  const path = join(root, "remote.sqlite");
  let store = openStore(path);
  store.registerAuthenticatedEpoch(identity, "5");
  const queued = store.admit(identity, JSON.stringify(queuedRequest)).job;
  const active = store.admit(identity, JSON.stringify(activeRequest)).job;
  store.markDispatching(identity, active.jobId, "5");
  store.close();
  store = new RemoteAdmissionStore(path, key, clock);
  try {
    assert.throws(() => store.admit(identity, JSON.stringify(queuedRequest)), /startup reconciliation/);
    assert.deepEqual(store.reconcileStartup().map((job) => job.jobId), [active.jobId]);
    assert.deepEqual(store.reconcileStartup(), []);
    assert.equal(store.getJob(identity, queued.jobId)?.state, "queued");
    assert.equal(store.getJob(identity, active.jobId)?.state, "outcome_unknown");
    assert.throws(() => store.markDispatching(identity, active.jobId, "5"), /current state/);
    const admit = createRemoteAdmissionAdapter(store);
    let calls = 0;
    for (const request of [queuedRequest, activeRequest]) {
      await admit(effect(request), async () => { calls++; return success(); });
    }
    assert.equal(calls, 0);
    const pages = [];
    let cursor: string | undefined;
    for (let n = 0; n < 4; n++) {
      const page = store.events(identity, active.jobId, cursor, 1);
      await validate("job-event", page);
      pages.push(...page.events);
      cursor = page.nextCursor;
    }
    assert.deepEqual(pages.map((event) => event.sequence), ["1", "2", "3"]);
    assert.deepEqual(pages.map((event) => event.state), ["queued", "running", "outcome_unknown"]);
    assert.equal(pages[2].kind, "reconciled");
    for (const event of pages) await validate("job-event", event);
    await validate("job", store.getJob(identity, active.jobId));
  } finally { store.close(); }
}));

test("authenticated epochs fence both admission and the pre-dispatch boundary", async () => temporary(async (root) => {
  const request = await fixture("remote-request.valid.write.json");
  const store = openStore(join(root, "remote.sqlite"));
  try {
    assert.throws(() => store.admit(identity, JSON.stringify(request)), errorCode("device_epoch_mismatch"));
    store.registerAuthenticatedEpoch(identity, "5");
    const job = store.admit(identity, JSON.stringify(request)).job;
    store.registerAuthenticatedEpoch(identity, "6");
    assert.throws(() => store.registerAuthenticatedEpoch(identity, "5"), errorCode("device_epoch_mismatch"));
    assert.throws(() => store.markDispatching(identity, job.jobId, "5"), errorCode("device_epoch_mismatch"));
    const admit = createRemoteAdmissionAdapter(store);
    let calls = 0;
    assert.equal((await admit(effect(request), async () => { calls++; return success(); })).error?.code, "device_epoch_mismatch");
    const freshRetry = { ...request, deviceEpoch: "6" };
    assert.equal(response(await admit(effect(freshRetry), async () => { calls++; return success(); })).jobId, job.jobId);
    assert.equal(calls, 0);
    assert.equal(store.getJob(identity, job.jobId)?.state, "queued");
  } finally { store.close(); }
}));

test("expiry and local policy are rechecked after admission and before dispatch", async () => temporary(async (root) => {
  const request = await fixture("remote-request.valid.write.json");
  let now = clock();
  const store = new RemoteAdmissionStore(join(root, "remote.sqlite"), key, () => now);
  store.reconcileStartup();
  store.registerAuthenticatedEpoch(identity, "5");
  try {
    const queued = store.admit(identity, JSON.stringify(request)).job;
    now = new Date("2026-10-27T12:06:00Z");
    assert.throws(() => store.markDispatching(identity, queued.jobId, "5"), errorCode("expired_request"));
    assert.equal(store.getJob(identity, queued.jobId)?.state, "queued");
    now = clock();
    const blocked = { ...request, idempotencyKey: "policy-key" };
    const denied: RemoteEffectRequest = { ...effect(blocked), authorize: () => ({
      ...success(), isError: true, error: { code: "permission_denied", message: "Local policy denied the request." },
    }) };
    let calls = 0;
    const result = await createRemoteAdmissionAdapter(store)(denied, async () => { calls++; return success(); });
    assert.equal(calls, 0);
    assert.equal(response(result).status, "blocked_policy");
    assert.equal(store.getJob(identity, response(result).jobId as string)?.state, "blocked_policy");
    await validate("remote-response", response(result));
  } finally { store.close(); }
}));

test("dispatch timeouts and thrown calls remain outcome_unknown", async () => temporary(async (root) => {
  const request = await fixture("remote-request.valid.write.json");
  const store = openStore(join(root, "remote.sqlite"));
  store.registerAuthenticatedEpoch(identity, "5");
  const admit = createRemoteAdmissionAdapter(store);
  try {
    for (const [index, dispatch] of [
      async (): Promise<ToolResult> => ({ ...success(), isError: true, error: { code: "tool_timeout", message: "timeout" } }),
      async (): Promise<ToolResult> => ({ ...success(), isError: true, error: { code: "process_timeout", message: "timeout" } }),
      async (): Promise<ToolResult> => ({ ...success(), isError: true, error: { code: "process_cancelled", message: "cancelled" } }),
      async (): Promise<ToolResult> => { throw new Error("must not leak"); },
    ].entries()) {
      const current = { ...request, idempotencyKey: "uncertain-" + index };
      const result = await admit(effect(current), dispatch);
      assert.equal(result.error?.code, "outcome_unknown");
      assert.equal(response(result).status, "outcome_unknown");
      assert.equal(store.getJob(identity, response(result).jobId as string)?.state, "outcome_unknown");
      assert.doesNotMatch(JSON.stringify(result), /must not leak/);
    }
    const stdin = { ...request, toolId: "process_write_stdin", idempotencyKey: "uncertain-stdin",
      payload: { processId: "process-1", writeId: "write-1", data: "input" } };
    stdin.payloadDigest = remotePayloadDigest(stdin);
    const uncertainInput: RemoteEffectRequest = { ...effect(stdin), toolName: "process.write_stdin" };
    const result = await admit(uncertainInput, async () => ({ callId: "call", toolName: "process.write_stdin",
      content: [{ type: "json", value: { status: "outcome_unknown", errorCode: "custom_input_failure" } }],
      isError: true, error: { code: "custom_input_failure", message: "Input delivery is uncertain." } }));
    assert.equal(response(result).status, "outcome_unknown");
  } finally { store.close(); }
}));

test("the database and WAL contain no plaintext request payload", async () => temporary(async (root) => {
  const request = await fixture("remote-request.valid.write.json");
  request.payload = { path: "unique-fixture-path", content: "a-secret-request-string-7e9dbe" };
  request.payloadDigest = remotePayloadDigest(request);
  const store = openStore(join(root, "remote.sqlite"));
  store.registerAuthenticatedEpoch(identity, "5");
  try {
    const job = store.admit(identity, JSON.stringify(request)).job;
    assert.deepEqual(store.readRequest(identity, job.jobId), request);
    for (const name of await readdir(root)) {
      const bytes = await readFile(join(root, name));
      assert.equal(bytes.includes(Buffer.from("a-secret-request-string-7e9dbe")), false, name);
      assert.equal(bytes.includes(Buffer.from("unique-fixture-path")), false, name);
    }
  } finally { store.close(); }
  assert.throws(() => new RemoteAdmissionStore(join(root, "remote.sqlite"), Buffer.alloc(32, 24), clock), /storage key/);
}));

test("runtime sends mutations through the adapter while reads bypass admission", async () => temporary(async (root) => {
  const project = join(root, "project"), state = join(root, "state");
  await mkdir(project); await mkdir(state);
  await writeFile(join(project, "fixture.txt"), "read-only fixture");
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  const principals = new RemotePrincipalStore(join(state, "principals.sqlite"));
  const store = openStore(join(state, "remote.sqlite"));
  store.registerAuthenticatedEpoch(identity, "5");
  const adapter = createRemoteAdmissionAdapter(store);
  let admissions = 0;
  const runtime = new RemoteToolRuntime({ host, principals, workspacePath: project, permissionProfile: "full",
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(), admitEffect: async (input, dispatch) => {
      admissions++; return await adapter(input, dispatch);
    } });
  try {
    const read = await runtime.invoke(identity, "fs.read", { path: "fixture.txt" });
    assert.equal(read.isError, false);
    assert.equal(admissions, 0);
    const request = await fixture("remote-request.valid.write.json");
    const result = await runtime.invoke(identity, "fs.write", request.payload, undefined, JSON.stringify(request));
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.equal(response(result).status, "completed");
    assert.equal(await readFile(join(project, "notes.txt"), "utf8"), "Hello\n");
    assert.equal(admissions, 1);
    const duplicate = await runtime.invoke(identity, "fs.write", request.payload, undefined, JSON.stringify(request));
    assert.equal(response(duplicate).jobId, response(result).jobId);
    assert.equal(await readFile(join(project, "notes.txt"), "utf8"), "Hello\n");
  } finally { await runtime.close(); await host.close(); principals.close(); store.close(); }
}));

type Schema = { [key: string]: unknown };

/** Small structural Draft 2020-12 subset, using the checked-in schemas and their references. */
async function validate(name: string, value: unknown): Promise<void> {
  const names = ["job", "job-event", "remote-request", "remote-response", "error"];
  const registry = new Map<string, Schema>();
  for (const entry of names) {
    const schema = JSON.parse(await readFile(join(contracts, entry + ".v1.schema.json"), "utf8")) as Schema;
    registry.set(schema.$id as string, schema);
  }
  const root = [...registry.values()].find((schema) => (schema.$id as string).endsWith("/" + name + ".v1.schema.json"));
  assert.ok(root);
  assert.equal(matches(value, root, root, registry), true, name + ": " + JSON.stringify(value));
}

function matches(value: unknown, schema: Schema, root: Schema, registry: Map<string, Schema>): boolean {
  if (typeof schema.$ref === "string") {
    const [uri, fragment] = schema.$ref.split("#");
    const targetRoot = uri ? registry.get(uri) : root;
    if (!targetRoot) return false;
    let target: unknown = targetRoot;
    for (const part of (fragment ?? "").split("/").filter(Boolean)) {
      if (!target || typeof target !== "object") return false;
      target = (target as Schema)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
    }
    return !!target && typeof target === "object" && matches(value, target as Schema, targetRoot, registry);
  }
  if ("const" in schema && schema.const !== value) return false;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((entry: Schema) => matches(value, entry, root, registry)).length !== 1) return false;
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((entry: Schema) => matches(value, entry, root, registry))) return false;
  if (Array.isArray(schema.allOf) && !schema.allOf.every((entry: Schema) => matches(value, entry, root, registry))) return false;
  if (schema.not && matches(value, schema.not as Schema, root, registry)) return false;
  if (schema.type === "null" && value !== null) return false;
  if (schema.type === "boolean" && typeof value !== "boolean") return false;
  if (schema.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) return false;
  if (schema.type === "string") {
    if (typeof value !== "string") return false;
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && length > schema.maxLength) return false;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern).test(value)) return false;
    if (schema.format === "date-time" && !Number.isFinite(Date.parse(value))) return false;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (schema.items && !value.every((entry) => matches(entry, schema.items as Schema, root, registry))) return false;
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    if (Array.isArray(schema.required) && schema.required.some((property: string) => !Object.hasOwn(object, property))) return false;
    if (typeof schema.maxProperties === "number" && Object.keys(object).length > schema.maxProperties) return false;
    for (const [property, child] of Object.entries(object)) {
      if (schema.propertyNames && !matches(property, schema.propertyNames as Schema, root, registry)) return false;
      if (properties[property] && !matches(child, properties[property], root, registry)) return false;
      if (!properties[property] && schema.additionalProperties === false) return false;
      if (!properties[property] && schema.additionalProperties && typeof schema.additionalProperties === "object" &&
        !matches(child, schema.additionalProperties as Schema, root, registry)) return false;
    }
  }
  return true;
}

test("structural schema checks cover contract fixture shapes", async () => {
  // Shape examples mirror job.valid.queued, job-event.valid.state-changed,
  // remote-request.valid.write, remote-response.valid.admitted and error.valid.idempotency-conflict.
  for (const [schema, file] of [["job", "job.valid.queued.json"], ["job-event", "job-event.valid.state-changed.json"],
    ["remote-request", "remote-request.valid.write.json"], ["remote-response", "remote-response.valid.admitted.json"],
    ["error", "error.valid.idempotency-conflict.json"]]) {
    await validate(schema, JSON.parse(await readFile(join(fixtures, "valid", file), "utf8")) as unknown);
  }
  const invalidJob = { ...(JSON.parse(await readFile(join(fixtures, "valid", "job.valid.queued.json"), "utf8")) as object), state: "dispatching" };
  await assert.rejects(validate("job", invalidJob));
});
