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
        usage: {
          inputTokens: 12,
          cachedInputTokens: 8,
          cacheWriteInputTokens: 2,
          outputTokens: 4,
        },
      };
    },
  };
  try {
    const budgeted = new BudgetedAgentModel({
      model,
      ledger,
      scopeId: "run_1",
      attribution: modelAttribution(),
      outputTokenReserve: 20,
      clock: () => "2026-07-12T00:00:00.000Z",
    });
    await budgeted.complete(request("session_1"));
    assert.equal(calls, 1);
    assert.equal(ledger.snapshot("run_1").effective.modelCalls, 1);
    assert.equal(ledger.snapshot("run_1").effective.inputTokens, 12);
    assert.equal(ledger.snapshot("run_1").effective.outputTokens, 4);
    assert.equal(ledger.snapshot("run_1").effective.cachedInputTokens, 8);
    assert.equal(ledger.snapshot("run_1").effective.cacheWriteInputTokens, 2);
    assert.deepEqual(
      ledger.snapshot("run_1").reservations["model:session_1:1"].tokenSources,
      { inputTokens: "reported", outputTokens: "reported" },
    );
    await assert.rejects(() => budgeted.complete(request("session_1")), /modelCalls/i);
    assert.equal(calls, 1, "provider is not called after budget rejection");
  } finally {
    ledger.close();
    fixture.cleanup();
  }
});

test("budgeted model prices uncached, cached, cache-write, and output tokens separately", async () => {
  const fixture = budgetFixture();
  const ledger = new SqliteBudgetLedger(fixture.database, {
    limitsFor: () => ({ maxModelCalls: 1, maxEstimatedCostMicros: 1_000_000 }),
  });
  try {
    const budgeted = new BudgetedAgentModel({
      model: {
        complete: async () => ({
          blocks: [],
          stopReason: "end_turn",
          usage: {
            inputTokens: 100,
            cachedInputTokens: 60,
            cacheWriteInputTokens: 10,
            outputTokens: 20,
          },
        }),
      },
      ledger,
      scopeId: "run_1",
      attribution: modelAttribution(),
      outputTokenReserve: 20,
      estimateCostMicros: (input, output, cached = 0, cacheWrite = 0) =>
        (input - cached - cacheWrite) * 10 + cached * 2 + cacheWrite * 12 + output * 30,
    });
    await budgeted.complete(request("session_1"));
    assert.equal(ledger.snapshot("run_1").effective.estimatedCostMicros, 1_140);
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
      attribution: modelAttribution(),
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
      attribution: modelAttribution(),
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
    attribution: modelAttribution(),
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

test("reported input and estimated serialized output are resolved independently", async () => {
  const fixture = budgetFixture();
  const ledger = new SqliteBudgetLedger(fixture.database, {
    limitsFor: () => ({ maxModelCalls: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000 }),
  });
  const blocks = [
    { type: "text" as const, text: "small response" },
    {
      type: "tool_call" as const,
      callId: "call_1",
      name: "fs.read",
      arguments: { path: "runner-v2/src/budgeted-model.ts" },
    },
  ];
  try {
    const budgeted = new BudgetedAgentModel({
      model: {
        complete: async () => ({
          blocks,
          stopReason: "tool_calls",
          usage: { inputTokens: 7 },
        }),
      },
      ledger,
      scopeId: "run_1",
      attribution: modelAttribution(),
      outputTokenReserve: 999,
    });
    await budgeted.complete(request("session_1"));
    const reservation = ledger.snapshot("run_1").reservations["model:session_1:1"];
    assert.equal(reservation.actual?.inputTokens, 7);
    assert.equal(
      reservation.actual?.outputTokens,
      Math.ceil(Buffer.byteLength(JSON.stringify(blocks)) / 4),
    );
    assert.notEqual(reservation.actual?.outputTokens, 999);
    assert.deepEqual(reservation.tokenSources, {
      inputTokens: "reported",
      outputTokens: "estimated",
    });
  } finally {
    ledger.close();
    fixture.cleanup();
  }
});

test("transport-estimated serialized input and reported output are resolved independently", async () => {
  const fixture = budgetFixture();
  const ledger = new SqliteBudgetLedger(fixture.database, {
    limitsFor: () => ({ maxModelCalls: 1, maxInputTokens: 1_000, maxOutputTokens: 1_000 }),
  });
  try {
    const budgeted = new BudgetedAgentModel({
      model: {
        complete: async () => ({
          blocks: [{ type: "text", text: "provider counted output" }],
          stopReason: "end_turn",
          usage: {
            inputTokens: 777,
            inputTokenSource: "estimated",
            outputTokens: 9,
          },
        }),
      },
      ledger,
      scopeId: "run_1",
      attribution: modelAttribution(),
      outputTokenReserve: 999,
    });
    await budgeted.complete(request("session_1"));
    const reservation = ledger.snapshot("run_1").reservations["model:session_1:1"];
    assert.equal(
      reservation.actual?.inputTokens,
      777,
    );
    assert.equal(reservation.actual?.outputTokens, 9);
    assert.deepEqual(reservation.tokenSources, {
      inputTokens: "estimated",
      outputTokens: "reported",
    });
  } finally {
    ledger.close();
    fixture.cleanup();
  }
});

function modelAttribution() {
  return {
    runtimeId: "runtime_test",
    providerId: "provider_test",
    modelId: "model_test",
    role: "worker" as const,
    sessionId: "session_1",
    taskId: "task_test",
  };
}

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
