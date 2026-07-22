import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  cloneBuildSpec,
  validateBuildSpec,
  type NativeBuildSpec,
} from "../src/build-spec.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";

const validSpec: NativeBuildSpec = {
  version: 1,
  runId: "run_policy",
  projectId: "project_policy",
  objective: "Validate the native policy contract.",
  architectRuntimeId: "chatgpt:gpt-5.5",
  workerRuntimeIds: ["chatgpt:gpt-5.4"],
  maxConcurrency: 1,
  permissionProfile: "full",
  runPolicy: "budgeted",
  budgetLimits: { maxEstimatedCostMicros: 1_000_000 },
  createdAt: "2026-07-12T00:00:00.000Z",
  idempotencyKey: "build-spec:run_policy",
};

test("native Build specs enforce policy-specific limit shapes", () => {
  assert.doesNotThrow(() => validateBuildSpec(validSpec));
  assert.doesNotThrow(() =>
    validateBuildSpec({ ...validSpec, runPolicy: "finish", budgetLimits: {} })
  );
  assert.doesNotThrow(() =>
    validateBuildSpec({ ...validSpec, runPolicy: "plan_only", budgetLimits: {} })
  );
  assert.throws(
    () =>
      validateBuildSpec({
        ...validSpec,
        runPolicy: "finish",
        budgetLimits: { maxActiveMs: 60_000 },
      }),
    /finish runs require empty budgetLimits/
  );
  assert.throws(
    () =>
      validateBuildSpec({
        ...validSpec,
        runPolicy: "plan_only",
        budgetLimits: { maxEstimatedCostMicros: 1_000_000 },
      }),
    /plan_only runs require empty budgetLimits/
  );
  assert.throws(
    () => validateBuildSpec({ ...validSpec, budgetLimits: {} }),
    /Budgeted runs require a positive maxEstimatedCostMicros or maxActiveMs/
  );
  assert.throws(
    () =>
      validateBuildSpec({
        ...validSpec,
        budgetLimits: { maxModelCalls: 10, maxInputTokens: 1_000 },
      }),
    /Budgeted runs require a positive maxEstimatedCostMicros or maxActiveMs/
  );
});

test("native Build specs validate and clone benchmark command policy", () => {
  const benchmarkSpec: NativeBuildSpec = {
    ...validSpec,
    benchmark: {
      attemptId: "attempt_1",
      allowedCommands: ["npm test", "node verifier.mjs"],
      hiddenPaths: ["case-meta.json"],
      protectedPaths: ["case-meta.json", "verifier.mjs"],
    },
  };
  assert.doesNotThrow(() => validateBuildSpec(benchmarkSpec));
  assert.throws(
    () => validateBuildSpec({
      ...benchmarkSpec,
      benchmark: { ...benchmarkSpec.benchmark!, attemptId: "" },
    }),
    /benchmark attempt/i
  );
  assert.throws(
    () => validateBuildSpec({
      ...benchmarkSpec,
      benchmark: { ...benchmarkSpec.benchmark!, allowedCommands: ["npm test", "npm test"] },
    }),
    /duplicate benchmark command/i
  );
  const cloned = cloneBuildSpec(benchmarkSpec);
  cloned.benchmark!.allowedCommands.push("npm lint");
  cloned.benchmark!.hiddenPaths.push("secret.json");
  assert.deepEqual(benchmarkSpec.benchmark!.allowedCommands, ["npm test", "node verifier.mjs"]);
  assert.deepEqual(benchmarkSpec.benchmark!.hiddenPaths, ["case-meta.json"]);
});

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
    budgetLimits: {
      maxEstimatedCostMicros: 1_000_000,
      maxActiveMs: 60_000,
    },
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

test("legacy native Build specs migrate durably to Finish without hidden ceilings", () => {
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

    let store = new SqliteBuildSpecStore(database);
    try {
      assert.deepEqual(store.get(legacySpec.runId), {
        ...legacySpec,
        runPolicy: "finish",
        budgetLimits: {},
      });
    } finally {
      store.close();
    }
    store = new SqliteBuildSpecStore(database);
    try {
      assert.deepEqual(store.get(legacySpec.runId), {
        ...legacySpec,
        runPolicy: "finish",
        budgetLimits: {},
      });
      const persistedDatabase = new DatabaseSync(database);
      const persisted = persistedDatabase
        .prepare("SELECT spec_json FROM build_specs WHERE run_id = ?")
        .get(legacySpec.runId) as { spec_json: string };
      persistedDatabase.close();
      assert.deepEqual(JSON.parse(persisted.spec_json), {
        ...legacySpec,
        runPolicy: "finish",
        budgetLimits: {},
      });
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
