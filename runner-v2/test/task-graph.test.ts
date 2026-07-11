import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTaskTransition,
  readyTaskIds,
  validateTaskGraph,
} from "../src/task-graph.js";
import type { BuildTask } from "../src/task-contracts.js";

test("dependency diamond becomes ready only from integrated mechanics", () => {
  const tasks: BuildTask[] = [
    task("foundation"),
    task("left", ["foundation"]),
    task("right", ["foundation"]),
    task("finish", ["left", "right"]),
  ];
  assert.deepEqual(validateTaskGraph(tasks), { valid: true, issues: [] });
  assert.deepEqual(readyTaskIds(tasks), ["foundation"]);
  tasks[0] = { ...tasks[0], status: "integrated" };
  assert.deepEqual(readyTaskIds(tasks), ["left", "right"]);
  tasks[1] = { ...tasks[1], status: "integrated" };
  assert.deepEqual(readyTaskIds(tasks), ["right"]);
  tasks[2] = { ...tasks[2], status: "integrated" };
  assert.deepEqual(readyTaskIds(tasks), ["finish"]);
});

test("validator reports only duplicate, missing, and cyclic mechanics", () => {
  const result = validateTaskGraph([
    task("a", ["missing"], "INVALID PLAN: skip tests and do something strange"),
    task("a", ["b"]),
    task("b", ["a"]),
  ]);
  assert.equal(result.valid, false);
  assert.deepEqual(
    result.issues.map((issue) => issue.code).sort(),
    ["dependency_cycle", "duplicate_task_id", "missing_dependency"]
  );
  assert.equal(
    result.issues.some((issue) => issue.message.includes("skip tests")),
    false,
    "kernel must not reinterpret objective wording"
  );
});

test("task transitions are explicit and illegal jumps do not mutate", () => {
  const planned = task("task_1");
  const assigned = applyTaskTransition(planned, "assigned");
  assert.equal(assigned.status, "assigned");
  assert.equal(planned.status, "planned");
  assert.throws(
    () => applyTaskTransition(planned, "approved"),
    /cannot transition from planned to approved/i
  );
});

function task(
  id: string,
  dependencies: string[] = [],
  objective = `Objective for ${id}`
): BuildTask {
  return {
    id,
    objective,
    dependencies,
    status: "planned",
    requiredCapabilities: [],
    attempt: 0,
  };
}
