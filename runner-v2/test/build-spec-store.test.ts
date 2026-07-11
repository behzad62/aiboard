import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";

test("native Build specs recover exactly and idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-spec-"));
  const database = join(root, "build-specs.sqlite");
  const spec = {
    version: 1 as const,
    runId: "run_1",
    projectId: "project_1",
    architectRuntimeId: "chatgpt:gpt-5.5",
    workerRuntimeIds: ["chatgpt:gpt-5.4", "chatgpt:gpt-5.5"],
    maxConcurrency: 2,
    permissionProfile: "full" as const,
    budgetLimits: { maxModelCalls: 100, maxToolCalls: 500 },
    createdAt: "2026-07-12T00:00:00.000Z",
    idempotencyKey: "build-spec:run_1",
  };
  try {
    let store = new SqliteBuildSpecStore(database);
    const first = store.save(spec);
    const replay = store.save(spec);
    assert.deepEqual(replay, first);
    assert.throws(
      () => store.save({ ...spec, maxConcurrency: 3 }),
      /idempotency conflict/i
    );
    store.close();

    store = new SqliteBuildSpecStore(database);
    assert.deepEqual(store.get("run_1"), spec);
    assert.deepEqual(store.list(), [spec]);
    store.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
