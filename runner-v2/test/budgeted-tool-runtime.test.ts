import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BudgetedToolRuntime } from "../src/budgeted-tool-runtime.js";
import { SqliteBudgetLedger } from "../src/sqlite-budget-ledger.js";
import { ToolRegistry } from "../src/tool-registry.js";

test("budgeted runtime counts every native tool family and blocks before dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-budgeted-tools-"));
  const ledger = new SqliteBudgetLedger(join(root, "budget.sqlite"), {
    limitsFor: () => ({ maxToolCalls: 1 }),
  });
  let executions = 0;
  const tools = new ToolRegistry();
  tools.register({
    definition: {
      name: "complete_lifecycle",
      description: "A lifecycle tool",
      inputSchema: { type: "object" },
      readOnly: true,
      effect: "none",
      lifecycle: true,
    },
    validate: () => ({ ok: true, value: {} }),
    execute: async () => {
      executions += 1;
      return { content: [], isError: false };
    },
  });
  let tick = 0;
  const runtime = new BudgetedToolRuntime({
    runtime: tools,
    ledger,
    scopeId: "run_1",
    clock: () =>
      new Date(Date.parse("2026-07-12T00:00:00.000Z") + tick++ * 10).toISOString(),
  });
  const context = {
    runId: "run_1",
    sessionId: "session_1",
    actor: { role: "architect" as const, id: "architect_1" },
  };
  try {
    const first = await runtime.invoke({
      type: "tool_call",
      callId: "first",
      name: "complete_lifecycle",
      arguments: {},
    }, context);
    const blocked = await runtime.invoke({
      type: "tool_call",
      callId: "second",
      name: "complete_lifecycle",
      arguments: {},
    }, context);
    assert.equal(first.isError, false);
    assert.equal(blocked.error?.code, "budget_exhausted");
    assert.equal(executions, 1);
    assert.equal(ledger.snapshot("run_1").effective.toolCalls, 1);
    assert.equal(ledger.snapshot("run_1").effective.activeMs > 0, true);
  } finally {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
