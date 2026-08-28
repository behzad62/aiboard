import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  SqliteDurableProcessStore,
  type DurableSubprocessRecord,
} from "../src/durable-process-store.js";

const prepared = (): DurableSubprocessRecord => ({
  schemaVersion: 1, logicalProcessId: "proc-1", invocationId: "invoke-1", runId: "run-1",
  state: "prepared", history: [{ state: "prepared", at: "2026-01-01T00:00:00.000Z" }],
  requiredCapabilities: ["tree_termination", "verified_emptiness"],
  environmentAudit: { inheritedNames: ["PATH"], removedNames: ["API_KEY"], explicitSafeNames: [], grantedNames: [] },
  output: [], cleanup: { state: "pending" },
});

test("persists legal lifecycle transitions atomically and makes exact invocation creation idempotent", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-process-store-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new SqliteDurableProcessStore(join(root, "state", "process.sqlite"));
  assert.equal(store.createPrepared(prepared()).state, "prepared");
  assert.equal(store.createPrepared(prepared()).logicalProcessId, "proc-1");
  assert.throws(() => store.createPrepared({ ...prepared(), logicalProcessId: "other" }), /idempotency conflict/i);
  store.transition("invoke-1", "launching", "2026-01-01T00:00:01.000Z");
  store.bindLaunch("invoke-1", {
    backend: { backendId: "fake", opaqueIdentity: "opaque-1" },
    birthFingerprint: { observedAt: "2026-01-01T00:00:02.000Z", discriminator: "birth-1" }, rootPid: 42,
  }, "2026-01-01T00:00:02.000Z");
  assert.equal(store.readByInvocation("invoke-1")?.state, "running");
  store.close();
  const reopened = new SqliteDurableProcessStore(join(root, "state", "process.sqlite"));
  assert.equal(reopened.readByInvocation("invoke-1")?.backend?.opaqueIdentity, "opaque-1");
  reopened.close();
});

test("illegal lifecycle transitions fail closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-process-store-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const store = new SqliteDurableProcessStore(join(root, "process.sqlite"));
  store.createPrepared(prepared());
  assert.throws(() => store.transition("invoke-1", "cleaned", "2026-01-01T00:00:01.000Z"), /illegal process transition/i);
  assert.equal(store.readByInvocation("invoke-1")?.state, "prepared");
  store.close();
});

test("historical observation is read-only and durable rows contain no secret, handle, or host path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-v2-process-store-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const path = join(root, "state", "process.sqlite");
  const writer = new SqliteDurableProcessStore(path);
  writer.createPrepared(prepared());
  writer.close();
  const before = await readFile(path);
  const reader = new SqliteDurableProcessStore(path, { readOnly: true });
  assert.equal(reader.readByInvocation("invoke-1")?.environmentAudit.removedNames[0], "API_KEY");
  assert.throws(() => reader.transition("invoke-1", "launching", "2026-01-01T00:00:01.000Z"), /read-only/i);
  reader.close();
  assert.deepEqual(await readFile(path), before);
  const durable = JSON.stringify(prepared());
  for (const forbidden of ["secret-value", "nativeHandle", "C:\\\\host\\spill.tmp"]) assert.equal(durable.includes(forbidden), false);
});
