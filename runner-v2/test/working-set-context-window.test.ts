import assert from "node:assert/strict";
import test from "node:test";

import { inlineResultBytesForContextWindow, workingSetForContextWindow } from "../src/agent-loop.js";
import { BudgetedAgentModel } from "../src/budgeted-model.js";
import { validateProviderConfigs } from "../src/provider-config-store.js";

test("the agent working set follows the model's context window", () => {
  assert.equal(workingSetForContextWindow(undefined), undefined, "unknown windows keep the default");
  assert.equal(workingSetForContextWindow(1_000_000)!.maxBytes, 2 * 1024 * 1024, "a 1M-token model is capped at 2 MB");
  assert.equal(workingSetForContextWindow(128_000)!.maxBytes, Math.floor(128_000 * 3.5 * 0.6));
  assert.equal(workingSetForContextWindow(8_000)!.maxBytes, 128 * 1024, "tiny windows keep a usable floor");
  assert.equal(workingSetForContextWindow(200_000)!.maxMessages, 1_000);
});

test("a context window rides on the provider config and through the budgeted model", () => {
  const config = { runtimeId: "deepseek:flash", providerId: "deepseek", modelId: "flash", secret: "k", transport: "openai-compatible" as const, capabilities: ["*"], priority: 0 };
  assert.doesNotThrow(() => validateProviderConfigs([{ ...config, contextWindowTokens: 1_000_000 }]));
  assert.throws(() => validateProviderConfigs([{ ...config, contextWindowTokens: 0 }]), /invalid context window/);
  const budgeted = new BudgetedAgentModel({
    model: { complete: async () => ({ blocks: [], stopReason: "end_turn" }), contextWindowTokens: 1_000_000 },
    ledger: {} as never,
    scopeId: "run",
    attribution: { runtimeId: "deepseek:flash", providerId: "deepseek", modelId: "flash", role: "worker", sessionId: "s" } as never,
    outputTokenReserve: 0,
  } as never);
  assert.equal(budgeted.contextWindowTokens, 1_000_000);
});

test("one tool result stays inline up to ~15% of the model context window (tunnel run)", () => {
  assert.equal(inlineResultBytesForContextWindow(undefined), 32 * 1024);
  assert.equal(inlineResultBytesForContextWindow(8_000), 32 * 1024, "small local models keep a usable floor");
  assert.equal(inlineResultBytesForContextWindow(128_000), Math.floor(128_000 * 3.5 * 0.15));
  assert.equal(inlineResultBytesForContextWindow(10_000_000), 1024 * 1024);
});
