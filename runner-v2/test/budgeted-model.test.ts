import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel, AgentModelRequest } from "../src/agent-contracts.js";
import { BudgetedAgentModel } from "../src/budgeted-model.js";
import { SqliteBudgetLedger } from "../src/sqlite-budget-ledger.js";

test("budgeted model reserves before provider call and settles actual usage", async () => {
  const fixture = budgetFixture();
  const ledger = new SqliteBudgetLedger(fixture.database, {
    limitsFor: () => ({ maxModelCalls: 1, maxInputTokens: 100, maxOutputTokens: 20 }),
  });
  let calls = 0;
  const model: AgentModel = {
    complete: async () => {
      calls += 1;
      return {
        blocks: [{ type: "text", text: "result" }],
        stopReason: "end_turn",
        usage: { inputTokens: 12, outputTokens: 4 },
      };
    },
  };
  try {
    const budgeted = new BudgetedAgentModel({
      model,
      ledger,
      scopeId: "run_1",
      outputTokenReserve: 20,
      clock: () => "2026-07-12T00:00:00.000Z",
    });
    await budgeted.complete(request("session_1"));
    assert.equal(calls, 1);
    assert.equal(ledger.snapshot("run_1").effective.modelCalls, 1);
    assert.equal(ledger.snapshot("run_1").effective.inputTokens, 12);
    assert.equal(ledger.snapshot("run_1").effective.outputTokens, 4);
    await assert.rejects(() => budgeted.complete(request("session_1")), /modelCalls/i);
    assert.equal(calls, 1, "provider is not called after budget rejection");
  } finally {
    ledger.close();
    fixture.cleanup();
  }
});

test("provider errors settle the conservative reservation and restart advances call identity", async () => {
  const fixture = budgetFixture();
  let ledger = new SqliteBudgetLedger(fixture.database, {
    limitsFor: () => ({ maxModelCalls: 3, maxInputTokens: 100, maxOutputTokens: 30 }),
  });
  try {
    const failing = new BudgetedAgentModel({
      model: { complete: async () => { throw new Error("provider down"); } },
      ledger,
      scopeId: "run_1",
      outputTokenReserve: 10,
    });
    await assert.rejects(() => failing.complete(request("session_1")), /provider down/);
    assert.equal(ledger.snapshot("run_1").effective.modelCalls, 1);
    ledger.close();

    ledger = new SqliteBudgetLedger(fixture.database, {
      limitsFor: () => ({ maxModelCalls: 3, maxInputTokens: 100, maxOutputTokens: 30 }),
    });
    const recovered = new BudgetedAgentModel({
      model: {
        complete: async () => ({
          blocks: [],
          stopReason: "end_turn",
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
      },
      ledger,
      scopeId: "run_1",
      outputTokenReserve: 10,
    });
    await recovered.complete(request("session_1"));
    assert.equal(ledger.snapshot("run_1").effective.modelCalls, 2);
  } finally {
    ledger.close();
    fixture.cleanup();
  }
});

test("model calls record active duration and prevent new work after the time limit", async () => {
  const fixture = budgetFixture();
  const ledger = new SqliteBudgetLedger(fixture.database, {
    limitsFor: () => ({ maxModelCalls: 3, maxActiveMs: 5 }),
  });
  let calls = 0;
  let tick = 0;
  const clock = () =>
    new Date(Date.parse("2026-07-12T00:00:00.000Z") + tick++ * 10).toISOString();
  const budgeted = new BudgetedAgentModel({
    model: {
      complete: async () => {
        calls += 1;
        return { blocks: [], stopReason: "end_turn", usage: { inputTokens: 1, outputTokens: 1 } };
      },
    },
    ledger,
    scopeId: "run_1",
    outputTokenReserve: 1,
    clock,
  });
  try {
    await budgeted.complete(request("session_1"));
    assert.equal(ledger.snapshot("run_1").effective.activeMs > 5, true);
    await assert.rejects(() => budgeted.complete(request("session_1")), /activeMs/i);
    assert.equal(calls, 1, "provider is not called after active time is exhausted");
  } finally {
    ledger.close();
    fixture.cleanup();
  }
});

function request(sessionId: string): AgentModelRequest {
  return {
    sessionId,
    messages: [
      { id: "system", role: "system", content: "small context" },
      { id: "user", role: "user", content: "do work" },
    ],
    tools: [],
  };
}

function budgetFixture() {
  const root = mkdtempSync(join(tmpdir(), "aiboard-budgeted-model-"));
  return {
    database: join(root, "budget.sqlite"),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
