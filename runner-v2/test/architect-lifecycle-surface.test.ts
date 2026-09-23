import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { NativeTool } from "../src/agent-contracts.js";
import {
  ARCHITECT_LIFECYCLE_SURFACE,
  architectLifecycleUniverseNames,
  BuildRuntime,
  type ArchitectActionRequest,
  type ArchitectRuntimeDriver,
} from "../src/build-runtime.js";
import { ARCHITECT_LIFECYCLE_TOOLS } from "../src/role-capabilities.js";
import type { SchedulerStore } from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";

const CLOCK = () => "2026-09-23T00:00:00.000Z";

test("architect lifecycle surface is the exact sorted tool list", () => {
  const derived = [...architectLifecycleUniverseNames({} as SchedulerStore, CLOCK)];
  assert.deepEqual([...ARCHITECT_LIFECYCLE_SURFACE], derived);
  assert.deepEqual(derived, [...derived].sort((left, right) => left.localeCompare(right)));
  assert.equal(new Set(derived).size, derived.length);
  for (const name of ARCHITECT_LIFECYCLE_TOOLS) {
    assert.equal(derived.includes(name), true, name);
  }
  assert.equal(derived.includes("resolve_context_recording"), true);
});

test("finish-policy architect registration stays inside the lifecycle surface", async () => {
  const names = await finishPlanNames();
  assert.deepEqual(names, [
    "answer_guidance",
    "ask_user",
    "complete_run",
    "plan_tasks",
    "reconcile_plan",
    "request_integration",
    "review_task",
    "revise_task",
    "upgrade_acceptance_contract",
  ]);
  for (const name of names) {
    assert.equal(ARCHITECT_LIFECYCLE_SURFACE.includes(name), true, name);
  }
  for (const name of ARCHITECT_LIFECYCLE_TOOLS) {
    assert.equal(names.includes(name), true, name);
  }
});

for (const name of ["review_task", "request_integration", "complete_run"] as const) {
  test(`removing ${name} from architect lifecycle registration throws`, async () => {
    await assert.rejects(
      () => finishPlanNames((tools) => tools.filter((tool) => tool.definition.name !== name)),
      new RegExp(`Architect lifecycle required tool ${name} is missing\\.`),
    );
  });
}

test("an extra unlisted architect lifecycle tool throws at registration", async () => {
  await assert.rejects(
    () => finishPlanNames((tools) => [...tools, probeTool("probe.unlisted")]),
    /Architect lifecycle registered tool probe\.unlisted is not on the allow-list\./,
  );
});

async function finishPlanNames(
  probe?: (tools: readonly NativeTool<unknown>[]) => readonly NativeTool<unknown>[],
): Promise<string[]> {
  const root = mkdtempSync(join(tmpdir(), "a1b-lifecycle-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const names: string[] = [];
  const architect: ArchitectRuntimeDriver = {
    run: async (request) => {
      names.push(...request.tools.definitions().map((tool) => tool.name));
      await plan(request);
    },
  };
  try {
    const runtime = new BuildRuntime({
      runId: "run_a1b",
      store,
      workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
      architectDriver: architect,
      integrationDriver: {
        integrate: async () => ({ status: "integrated", integrationRevision: "unused" }),
      },
      maxConcurrency: 1,
      workspaceFor: async () => "unused",
      clock: CLOCK,
      ...(probe ? { architectLifecycleProbe: probe } : {}),
    });
    const step = await runtime.step();
    assert.equal(step.action, "plan_required");
    return names;
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function plan(request: ArchitectActionRequest): Promise<void> {
  const result = await request.tools.invoke({
    type: "tool_call",
    callId: "a1b_plan",
    name: "plan_tasks",
    arguments: {
      revision: 1,
      tasks: [{
        id: "task_a",
        objective: "Draft the public API",
        dependencies: [],
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "api", text: "The public API is drafted." }],
      }],
    },
  }, request.context);
  assert.equal(result.isError, false, result.error?.message ?? "plan_tasks failed");
}

function probeTool(name: string): NativeTool<unknown> {
  return {
    definition: {
      name,
      description: "Unlisted lifecycle registration probe",
      inputSchema: { type: "object", additionalProperties: false },
      readOnly: true,
      effect: "none",
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => ({ content: [], isError: false }),
  };
}
