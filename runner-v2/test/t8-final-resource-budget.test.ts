import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BudgetedToolRuntime } from "../src/budgeted-tool-runtime.js";
import type { ExecutionTaskContract } from "../src/planning-contracts.js";
import { SqliteBudgetLedger } from "../src/sqlite-budget-ledger.js";
import { contractWriteClaim, findClaimConflict } from "../src/task-resource-claims.js";
import { ToolRegistry } from "../src/tool-registry.js";

/**
 * T8 final-qualification supplements for source-required scheduler contention
 * and budget exhaustion. These use the production admission/budget primitives,
 * not model services or duplicated policy logic.
 */

function t8ResourceTask(
  id: string,
  file: string,
  sharedResourceClaims: readonly string[],
): ExecutionTaskContract {
  return {
    id,
    lineage: [],
    accountablePhaseId: "P1",
    requirementIds: [`REQ-${id}`],
    outcome: { user: `Deliver ${id}.`, system: `Deliver ${id}.` },
    scope: { includes: [file], excludes: [] },
    writableSurfaces: [file],
    forbiddenSurfaces: ["docs/project/STATE.md"],
    sharedResourceClaims: [...sharedResourceClaims],
    dependencies: [],
    requiredBase: "accepted final qualification plan",
    inputs: ["accepted plan"],
    outputs: [file],
    steps: ["Implement.", "Validate."],
    acceptance: {
      criteria: [{ id: "done", text: `${id} is complete.` }],
      definitionOfDone: "Current evidence is accepted.",
    },
    validation: {
      targetedRationale: "Exact task behavior.",
      affectedScopeRationale: "Declared task surface.",
    },
    negativeProofApplicability: {
      applicable: false,
      rationale: "This qualification isolates resource admission.",
    },
    reviewCriteria: ["Independent review confirms the task."],
    integrationChecks: ["Shared-resource admission remains serialized."],
    cleanup: {
      cleanup: "Release the task claim.",
      recovery: "Resume from durable state.",
      rollback: "Discard the isolated worktree.",
    },
    requirementCriteriaMap: [{
      taskLocalCriterionId: "done",
      requirementId: `REQ-${id}`,
    }],
  };
}

test("T8-A2 shared-resource tasks serialize even with disjoint files and worktrees", () => {
  const first = contractWriteClaim(
    t8ResourceTask("R1", "src/r1.ts", ["database:main"]),
    "C:/t8/worktrees/r1",
  );
  const second = contractWriteClaim(
    t8ResourceTask("R2", "src/r2.ts", ["db:MAIN"]),
    "C:/t8/worktrees/r2",
  );

  assert.notDeepEqual(first.files, second.files);
  assert.notEqual(first.worktree, second.worktree);
  const conflict = findClaimConflict(second, [first]);
  assert.equal(conflict?.kind, "resource");
  assert.match(conflict?.detail ?? "", /shared resource db:main/i);

  // Once the active owner has released/integrated, the same otherwise-ready
  // task has no remaining shared-resource admission conflict.
  assert.equal(findClaimConflict(second, []), undefined);
});

test("T8-A4 budget exhaustion is durable and blocks before a second dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t8-budget-"));
  const ledger = new SqliteBudgetLedger(join(root, "budget.sqlite"), {
    limitsFor: () => ({ maxToolCalls: 1 }),
  });
  const tools = new ToolRegistry();
  let executions = 0;
  tools.register({
    definition: {
      name: "t8_qualification_tool",
      description: "T8 deterministic budget probe.",
      inputSchema: { type: "object" },
      readOnly: true,
      effect: "none",
      lifecycle: true,
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => {
      executions += 1;
      return { content: [{ type: "text", text: "executed" }], isError: false };
    },
  });
  let tick = 0;
  const runtime = new BudgetedToolRuntime({
    runtime: tools,
    ledger,
    scopeId: "run_t8_budget",
    clock: () => new Date(Date.parse("2026-10-07T00:00:00.000Z") + tick++ * 10).toISOString(),
  });
  const context = {
    runId: "run_t8_budget",
    sessionId: "session_t8_budget",
    actor: { role: "architect" as const, id: "architect_t8" },
  };

  try {
    const first = await runtime.invoke({
      type: "tool_call",
      callId: "first",
      name: "t8_qualification_tool",
      arguments: {},
    }, context);
    const blocked = await runtime.invoke({
      type: "tool_call",
      callId: "second",
      name: "t8_qualification_tool",
      arguments: {},
    }, context);

    assert.equal(first.isError, false);
    assert.equal(blocked.isError, true);
    assert.equal(blocked.error?.code, "budget_exhausted");
    assert.equal(executions, 1, "the exhausted call is rejected before dispatch");
    const snapshot = ledger.snapshot("run_t8_budget");
    assert.equal(snapshot.effective.toolCalls, 1);
    assert.ok(ledger.events("run_t8_budget").length > 0, "the SQLite ledger persisted the accepted usage");
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
