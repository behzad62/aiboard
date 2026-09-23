import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DatabaseSync } from "node:sqlite";

import { ArtifactStore } from "../src/artifact-store.js";
import { ContextAssembler } from "../src/context-assembler.js";
import {
  CONTEXT_MANIFEST_RECORD_BACKOFF_MS,
  CONTEXT_MANIFEST_RECORD_MAX_ATTEMPTS,
  ContextManifestParseError,
  ContextManifestRecordingError,
  clearContextRecordingSuspension,
  contextManifestId,
  isContextRecordingSuspended,
  recordContextPack,
  suspendContextRecording,
  toContextManifest,
  type ContextManifestInput,
  type ContextManifestStore,
} from "../src/context-manifest-store.js";
import { SqliteContextManifestStore } from "../src/sqlite-context-manifest-store.js";

function manifestInput(overrides: Partial<ContextManifestInput> = {}): ContextManifestInput {
  const pack = new ContextAssembler({ maxBytes: 4_096, maxEstimatedTokens: 1_024 }).assemble([
    { id: "kernel-invariants", kind: "system", required: true, priority: 1000, content: "Use native tools." },
    { id: "instruction:AGENTS.md", kind: "instructions", required: false, priority: 900, content: "Keep it small.", sourceDigest: "d".repeat(64) },
    { id: "evidence:e1", kind: "evidence", required: false, priority: 500, content: "npm test exited 0", artifactHash: "e".repeat(64) },
  ]);
  return {
    runId: "run_manifest",
    sessionId: "worker:T1:1",
    actor: { role: "worker", id: "worker:T1:1" },
    role: "worker",
    purpose: "worker:task",
    taskId: "T1",
    attempt: 1,
    repositoryRevision: "a".repeat(40),
    limits: { maxBytes: 4_096, maxEstimatedTokens: 1_024 },
    pack,
    recordedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function differentPack(): ContextManifestInput["pack"] {
  return new ContextAssembler({ maxBytes: 4_096, maxEstimatedTokens: 1_024 }).assemble([
    { id: "kernel-invariants", kind: "system", required: true, priority: 1000, content: "Use native tools." },
    { id: "instruction:AGENTS.md", kind: "instructions", required: false, priority: 900, content: "Keep it distinct.", sourceDigest: "d".repeat(64) },
    { id: "evidence:e1", kind: "evidence", required: false, priority: 500, content: "npm test exited 0", artifactHash: "e".repeat(64) },
  ]);
}

function assertTwoDurableRows(
  store: SqliteContextManifestStore,
  first: { manifestId: string },
  second: { manifestId: string },
  runId: string,
  label: string,
): void {
  assert.notEqual(second.manifestId, first.manifestId, `${label} must mint a different manifestId`);
  const listed = store.listRun(runId);
  assert.equal(listed.length, 2, `${label} must persist two rows`);
  const ids = new Set(listed.map((manifest) => manifest.manifestId));
  assert.equal(ids.size, 2, `${label} must persist two distinct manifestId values`);
  assert.equal(ids.has(first.manifestId), true, `${label} must keep the first row`);
  assert.equal(ids.has(second.manifestId), true, `${label} must keep the second row`);
}

test("changing one identity component writes a second durable row", () => {
  const cases: Array<{ label: string; first?: Partial<ContextManifestInput>; second: Partial<ContextManifestInput> }> = [
    { label: "pack digest", second: { pack: differentPack() } },
    { label: "attempt", second: { attempt: 2 } },
    { label: "repositoryRevision", second: { repositoryRevision: "b".repeat(40) } },
    { label: "taskId", second: { taskId: "T2" } },
    { label: "purpose", first: { purpose: "verifier:inspection" }, second: { purpose: "verifier:verdict" } },
    { label: "sessionId", second: { sessionId: "worker:T1:2" } },
  ];
  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), `aiboard-context-manifest-distinct-${item.label.replace(/\s+/g, "-")}-`));
    const store = new SqliteContextManifestStore(join(root, "context-manifests.sqlite"));
    try {
      const first = store.record(manifestInput(item.first));
      const second = store.record(manifestInput({
        recordedAt: "2026-09-02T00:00:01.000Z",
        ...item.first,
        ...item.second,
      }));
      assertTwoDurableRows(store, first, second, "run_manifest", item.label);
    } finally {
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("changing runId writes a second durable row under the other run", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-context-manifest-distinct-runId-"));
  const store = new SqliteContextManifestStore(join(root, "context-manifests.sqlite"));
  try {
    const first = store.record(manifestInput());
    const second = store.record(manifestInput({
      runId: "run_other_identity",
      recordedAt: "2026-09-02T00:00:01.000Z",
    }));
    assert.notEqual(second.manifestId, first.manifestId);
    assert.equal(store.listRun("run_manifest").length, 1);
    assert.equal(store.listRun("run_manifest")[0]?.manifestId, first.manifestId);
    assert.equal(store.listRun("run_other_identity").length, 1);
    assert.equal(store.listRun("run_other_identity")[0]?.manifestId, second.manifestId);
    assert.equal(store.get(second.manifestId)?.runId, "run_other_identity");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("manifests are recorded once per identity, listed per run, and readable read-only", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-context-manifest-"));
  const path = join(root, "context-manifests.sqlite");
  const store = new SqliteContextManifestStore(path);
  try {
    const first = store.record(manifestInput());
    const again = store.record(manifestInput({ recordedAt: "2026-09-02T00:00:09.000Z" }));
    assert.equal(again.manifestId, first.manifestId);
    assert.equal(again.recordedAt, first.recordedAt, "a duplicate identity keeps the first record");
    assert.equal(first.manifestId, contextManifestId(manifestInput()));
    assert.equal(first.packDigest, manifestInput().pack.digest);
    assert.deepEqual(first.sections.map((section) => section.id), [
      "kernel-invariants", "instruction:AGENTS.md", "evidence:e1",
    ]);
    assert.equal(first.sections[1]?.sourceDigest, "d".repeat(64));
    assert.equal(first.sections[2]?.artifactHash, "e".repeat(64));
    assert.deepEqual(first.omissions, []);
    store.record(manifestInput({ runId: "run_other", sessionId: "architect:run_other" }));
    assert.equal(store.listRun("run_manifest").length, 1);
    assert.equal(store.get(first.manifestId)?.taskId, "T1");
  } finally {
    store.close();
  }
  const readOnly = new SqliteContextManifestStore(path, { readOnly: true });
  try {
    assert.equal(readOnly.listRun("run_manifest").length, 1);
    assert.throws(() => readOnly.record(manifestInput({ sessionId: "worker:T2:1" })), /read-only/);
  } finally {
    readOnly.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("architect and verifier roles persist as distinct identities from worker", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-context-manifest-roles-"));
  const store = new SqliteContextManifestStore(join(root, "context-manifests.sqlite"));
  try {
    store.record(manifestInput());
    store.record(manifestInput({
      sessionId: "architect:run_manifest",
      actor: { role: "architect", id: "architect:run_manifest" },
      role: "architect",
      purpose: "architect:review_required",
      taskId: "T1",
      attempt: undefined,
    }));
    store.record(manifestInput({
      sessionId: "verifier:run_manifest",
      actor: { role: "verifier", id: "verifier:run_manifest" },
      role: "verifier",
      purpose: "verifier:inspection",
      taskId: undefined,
      attempt: undefined,
    }));
    const listed = store.listRun("run_manifest");
    assert.equal(listed.length, 3);
    assert.deepEqual(
      listed.map((manifest) => manifest.role).sort(),
      ["architect", "verifier", "worker"],
    );
    assert.equal(listed.find((manifest) => manifest.role === "architect")?.purpose, "architect:review_required");
    assert.equal(listed.find((manifest) => manifest.role === "verifier")?.purpose, "verifier:inspection");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("overflow omissions are persisted on the recorded manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-context-manifest-omit-"));
  const store = new SqliteContextManifestStore(join(root, "context-manifests.sqlite"));
  try {
    const limits = { maxBytes: 180, maxEstimatedTokens: 1_024 };
    const pack = new ContextAssembler(limits).assemble([
      { id: "kernel-invariants", kind: "system", required: true, priority: 1000, content: "Use native tools." },
      { id: "history-old", kind: "history", required: false, priority: 1, content: "old ".repeat(80) },
    ]);
    assert.equal(pack.omissions.length > 0, true);
    const recorded = store.record(manifestInput({ limits, pack }));
    assert.deepEqual(recorded.omissions.map((omission) => omission.id), ["history-old"]);
    assert.equal(recorded.omissions[0]?.reason, "byte_budget");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("listRun throws a typed parse error instead of returning a partial list", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-context-manifest-parse-"));
  const path = join(root, "context-manifests.sqlite");
  const store = new SqliteContextManifestStore(path);
  let firstId = "";
  try {
    firstId = store.record(manifestInput()).manifestId;
    store.record(manifestInput({ sessionId: "worker:T2:1", actor: { role: "worker", id: "worker:T2:1" } }));
  } finally {
    store.close();
  }
  const database = new DatabaseSync(path);
  try {
    database.prepare("UPDATE context_manifests SET payload_json = ? WHERE manifest_id = ?")
      .run("{not-json", firstId);
  } finally {
    database.close();
  }
  const reopened = new SqliteContextManifestStore(path, { readOnly: true });
  try {
    assert.throws(
      () => reopened.listRun("run_manifest"),
      (error: unknown) =>
        error instanceof ContextManifestParseError &&
        error.manifestId === firstId &&
        error.message.includes("invalid payload JSON"),
    );
  } finally {
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("payload JSON that is not a manifest object fails closed per shape", () => {
  const cases: Array<{ label: string; payload: string }> = [
    { label: "null", payload: "null" },
    { label: "array", payload: "[]" },
    { label: "string", payload: "\"hello\"" },
  ];
  for (const item of cases) {
    const root = mkdtempSync(join(tmpdir(), `aiboard-context-manifest-${item.label}-`));
    const path = join(root, "context-manifests.sqlite");
    const store = new SqliteContextManifestStore(path);
    let manifestId = "";
    try {
      manifestId = store.record(manifestInput()).manifestId;
    } finally {
      store.close();
    }
    const database = new DatabaseSync(path);
    try {
      database.prepare("UPDATE context_manifests SET payload_json = ? WHERE manifest_id = ?")
        .run(item.payload, manifestId);
    } finally {
      database.close();
    }
    const reopened = new SqliteContextManifestStore(path, { readOnly: true });
    try {
      assert.throws(
        () => reopened.listRun("run_manifest"),
        (error: unknown) =>
          error instanceof ContextManifestParseError && error.manifestId === manifestId,
        item.label,
      );
    } finally {
      reopened.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("recordContextPack is a no-op without a store and records full text only when asked with artifacts", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-context-manifest-record-"));
  const store = new SqliteContextManifestStore(join(root, "context-manifests.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  try {
    assert.equal(await recordContextPack({ ...manifestInput(), store: undefined }), undefined);
    const digestOnly = await recordContextPack({ ...manifestInput(), store, artifacts });
    assert.equal(digestOnly?.packArtifactHash, undefined);
    const withoutArtifacts = await recordContextPack({
      ...manifestInput({ sessionId: "worker:T1:full-no-art" }),
      store,
      recordPackText: true,
    });
    assert.equal(withoutArtifacts?.packArtifactHash, undefined);
    const full = await recordContextPack({
      ...manifestInput({ sessionId: "worker:T1:full" }),
      store,
      artifacts,
      recordPackText: true,
    });
    assert.match(full?.packArtifactHash ?? "", /^[a-f0-9]{64}$/);
    const bytes = await artifacts.get(full!.packArtifactHash!);
    assert.equal(bytes.toString("utf8"), manifestInput().pack.text);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function sleepSpy(): { sleep: (milliseconds: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    async sleep(milliseconds: number) {
      delays.push(milliseconds);
    },
  };
}

function stubManifestStore(
  record: (input: ContextManifestInput, call: number) => ReturnType<ContextManifestStore["record"]>,
): { store: ContextManifestStore; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    store: {
      record(input) {
        calls += 1;
        return record(input, calls);
      },
      get: () => undefined,
      listRun: () => [],
      close() {},
    },
  };
}

test("stub store failing N-1 times then succeeding records exactly once", async () => {
  const input = manifestInput({ runId: "run_b1_retry_success", sessionId: "worker:retry:1" });
  let recorded = 0;
  const stub = stubManifestStore((manifestInputRecorded, call) => {
    if (call < CONTEXT_MANIFEST_RECORD_MAX_ATTEMPTS) {
      throw new Error(`sqlite locked ${call}`);
    }
    recorded += 1;
    return toContextManifest(manifestInputRecorded);
  });
  const spy = sleepSpy();
  const result = await recordContextPack({ ...input, store: stub.store, sleep: spy.sleep });
  assert.equal(recorded, 1);
  assert.equal(stub.calls(), CONTEXT_MANIFEST_RECORD_MAX_ATTEMPTS);
  assert.equal(result?.manifestId, contextManifestId(input));
  assert.equal(result?.runId, input.runId);
  assert.equal(result?.purpose, input.purpose);
  assert.equal(spy.delays.length, CONTEXT_MANIFEST_RECORD_MAX_ATTEMPTS - 1);
  assert.deepEqual(spy.delays, [...CONTEXT_MANIFEST_RECORD_BACKOFF_MS]);
});

test("permanently failing store throws ContextManifestRecordingError after exactly the bound", async () => {
  const failuresBeforeSuccess = 10;
  assert.ok(
    CONTEXT_MANIFEST_RECORD_MAX_ATTEMPTS < failuresBeforeSuccess,
    "the finite stub must still be failing when the bound is reached",
  );
  const input = manifestInput({ runId: "run_b1_retry_exhausted", sessionId: "worker:exhausted:1" });
  const causes: Error[] = [];
  const stub = stubManifestStore((manifestInputRecorded, call) => {
    const cause = new Error(`sqlite locked ${call}`);
    causes.push(cause);
    if (call <= failuresBeforeSuccess) throw cause;
    return toContextManifest(manifestInputRecorded);
  });
  const spy = sleepSpy();
  await assert.rejects(
    () => recordContextPack({ ...input, store: stub.store, sleep: spy.sleep }),
    (error: unknown) => {
      assert.ok(error instanceof ContextManifestRecordingError);
      assert.equal(error.name, "ContextManifestRecordingError");
      assert.equal(error.runId, input.runId);
      assert.equal(error.sessionId, input.sessionId);
      assert.equal(error.purpose, input.purpose);
      assert.equal(error.attempts, CONTEXT_MANIFEST_RECORD_MAX_ATTEMPTS);
      assert.equal(error.cause, causes[CONTEXT_MANIFEST_RECORD_MAX_ATTEMPTS - 1]);
      assert.notEqual(error.cause, causes[0]);
      assert.equal(stub.calls(), CONTEXT_MANIFEST_RECORD_MAX_ATTEMPTS);
      assert.equal(spy.delays.length, CONTEXT_MANIFEST_RECORD_MAX_ATTEMPTS - 1);
      assert.deepEqual(spy.delays, [...CONTEXT_MANIFEST_RECORD_BACKOFF_MS]);
      return true;
    },
  );
});

test("permanently failing artifacts.put throws ContextManifestRecordingError", async () => {
  const input = manifestInput({ runId: "run_b1_artifact_exhausted", sessionId: "worker:artifact:1" });
  let storeCalls = 0;
  const store = stubManifestStore(() => {
    storeCalls += 1;
    throw new Error("store should not be called");
  }).store;
  const causes: Error[] = [];
  let putCalls = 0;
  const artifacts = {
    async put() {
      putCalls += 1;
      const cause = new Error(`antivirus handle ${putCalls}`);
      causes.push(cause);
      throw cause;
    },
  } as unknown as ArtifactStore;
  const spy = sleepSpy();
  await assert.rejects(
    () => recordContextPack({
      ...input,
      store,
      artifacts,
      recordPackText: true,
      sleep: spy.sleep,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ContextManifestRecordingError);
      assert.equal(error.runId, input.runId);
      assert.equal(error.sessionId, input.sessionId);
      assert.equal(error.purpose, input.purpose);
      assert.equal(error.attempts, CONTEXT_MANIFEST_RECORD_MAX_ATTEMPTS);
      assert.equal(error.cause, causes[CONTEXT_MANIFEST_RECORD_MAX_ATTEMPTS - 1]);
      assert.equal(putCalls, CONTEXT_MANIFEST_RECORD_MAX_ATTEMPTS);
      assert.equal(storeCalls, 0);
      assert.deepEqual(spy.delays, [...CONTEXT_MANIFEST_RECORD_BACKOFF_MS]);
      return true;
    },
  );
});

test("suspended run returns undefined, zero store calls, zero artifact calls, and clearing resumes recording", async () => {
  const suspendedRunId = "run_b1_suspended";
  const otherRunId = "run_b1_not_suspended";
  clearContextRecordingSuspension(suspendedRunId);
  clearContextRecordingSuspension(otherRunId);
  let storeCalls = 0;
  let artifactCalls = 0;
  const stub = stubManifestStore((input) => {
    storeCalls += 1;
    return toContextManifest(input);
  });
  const artifacts = {
    async put() {
      artifactCalls += 1;
      return { hash: "a".repeat(64) };
    },
  } as unknown as ArtifactStore;
  try {
    suspendContextRecording(suspendedRunId, "proceed_without_manifest");
    assert.equal(isContextRecordingSuspended(suspendedRunId), true);
    assert.equal(isContextRecordingSuspended(otherRunId), false);
    const suspended = await recordContextPack({
      ...manifestInput({ runId: suspendedRunId, sessionId: "worker:suspended:1" }),
      store: stub.store,
      artifacts,
      recordPackText: true,
    });
    assert.equal(suspended, undefined);
    assert.equal(storeCalls, 0);
    assert.equal(artifactCalls, 0);
    const other = await recordContextPack({
      ...manifestInput({ runId: otherRunId, sessionId: "worker:other:1" }),
      store: stub.store,
      artifacts,
      recordPackText: true,
    });
    assert.equal(other?.runId, otherRunId);
    assert.equal(storeCalls, 1);
    assert.equal(artifactCalls, 1);
    clearContextRecordingSuspension(suspendedRunId);
    assert.equal(isContextRecordingSuspended(suspendedRunId), false);
    const resumed = await recordContextPack({
      ...manifestInput({ runId: suspendedRunId, sessionId: "worker:resumed:1" }),
      store: stub.store,
      artifacts,
      recordPackText: true,
    });
    assert.equal(resumed?.runId, suspendedRunId);
    assert.equal(storeCalls, 2);
    assert.equal(artifactCalls, 2);
  } finally {
    clearContextRecordingSuspension(suspendedRunId);
    clearContextRecordingSuspension(otherRunId);
  }
});
