import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";

test("native Build specs recover exactly and idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-spec-"));
  const database = join(root, "build-specs.sqlite");
  const spec = {
    version: 1 as const,
    runId: "run_1",
    projectId: "project_1",
    objective: "Build a reliable application.",
    architectRuntimeId: "chatgpt:gpt-5.5",
    workerRuntimeIds: ["chatgpt:gpt-5.4", "chatgpt:gpt-5.5"],
    maxConcurrency: 2,
    permissionProfile: "full" as const,
    runPolicy: "budgeted" as const,
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

test("legacy native Build specs recover with their existing ceilings preserved", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-spec-legacy-"));
  const database = join(root, "build-specs.sqlite");
  const legacySpec = {
    version: 1 as const,
    runId: "run_legacy",
    projectId: "project_legacy",
    objective: "Recover a durable run.",
    architectRuntimeId: "chatgpt:gpt-5.5",
    workerRuntimeIds: ["chatgpt:gpt-5.4"],
    maxConcurrency: 1,
    permissionProfile: "full" as const,
    budgetLimits: { maxModelCalls: 100, maxToolCalls: 1_500 },
    createdAt: "2026-07-12T00:00:00.000Z",
    idempotencyKey: "build-spec:run_legacy",
  };
  try {
    const legacyDatabase = new DatabaseSync(database);
    legacyDatabase.exec(`
      CREATE TABLE build_specs (
        run_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        spec_json TEXT NOT NULL
      );
    `);
    legacyDatabase
      .prepare(
        "INSERT INTO build_specs (run_id, idempotency_key, spec_json) VALUES (?, ?, ?)"
      )
      .run(
        legacySpec.runId,
        legacySpec.idempotencyKey,
        JSON.stringify(legacySpec)
      );
    legacyDatabase.close();

    const store = new SqliteBuildSpecStore(database);
    try {
      assert.deepEqual(store.get(legacySpec.runId), {
        ...legacySpec,
        runPolicy: "budgeted",
      });
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
