import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BuildRuntime } from "../src/build-runtime.js";
import type { NativeBuildSpec } from "../src/build-spec.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";

const spec: NativeBuildSpec = {
  version: 1,
  runId: "run_1",
  projectId: "project_1",
  objective: "Build a reliable application.",
  architectRuntimeId: "chatgpt:gpt-5.5",
  workerRuntimeIds: ["chatgpt:gpt-5.4"],
  maxConcurrency: 1,
  permissionProfile: "full",
  budgetLimits: { maxModelCalls: 20, maxToolCalls: 100 },
  createdAt: "2026-07-12T00:00:00.000Z",
  idempotencyKey: "build-spec:run_1",
};

test("native Build manager recreates persisted runtimes and closes resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-build-manager-"));
  const database = join(root, "builds.sqlite");
  const created: string[] = [];
  const closed: string[] = [];
  try {
    let specs = new SqliteBuildSpecStore(database);
    specs.save(spec);
    specs.close();

    specs = new SqliteBuildSpecStore(database);
    const manager = new NativeBuildManager({
      specs,
      createRuntime: async (input) => {
        created.push(input.runId);
        return {
          runtime: fakeRuntime(input.runId),
          close: () => {
            closed.push(input.runId);
          },
        };
      },
    });
    await manager.recover();
    assert.deepEqual(created, ["run_1"]);
    assert.equal(manager.projection("run_1").runId, "run_1");

    await manager.create(spec);
    assert.deepEqual(created, ["run_1"]);
    await manager.close();
    assert.deepEqual(closed, ["run_1"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeRuntime(runId: string): BuildRuntime {
  return {
    id: runId,
    projection: () => ({
      runId,
      status: "running",
      planRevision: 0,
      tasks: {},
      guidance: {},
      reviews: {},
      runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
      lastSequence: 0,
    }),
    events: () => [],
    step: async () => ({ status: "idle" }),
    runUntilBlocked: async () => ({ status: "idle" }),
    selectArchitectHandoff: () => {
      throw new Error("unused");
    },
  } as unknown as BuildRuntime;
}
