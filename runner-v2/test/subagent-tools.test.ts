import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel, AgentModelRequest } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { BudgetedAgentModel } from "../src/budgeted-model.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteBudgetLedger } from "../src/sqlite-budget-ledger.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { createSubagentTools } from "../src/subagent-tools.js";
import { ToolRegistry } from "../src/tool-registry.js";

test("read-only subagents expose no workspace mutation tools and are concurrency-safe", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-readonly-subagent-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  const ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
  const requests: AgentModelRequest[] = [];
  const model: AgentModel = {
    complete: async (request) => {
      requests.push(request);
      return {
        blocks: [{
          type: "tool_call",
          callId: "return_1",
          name: "return_to_parent",
          arguments: { summary: "Inspection complete", artifactHashes: [] },
        }],
        stopReason: "tool_calls",
      };
    },
  };
  try {
    const registry = new ToolRegistry();
    for (const tool of createSubagentTools({
      model,
      runId: "run_1",
      parentSessionId: "worker:run_1:T1:1",
      taskId: "T1",
      parentActorId: "worker_1",
      permissionProfile: "full",
      workspacePath: workspace,
      artifacts,
      ledger,
      sessions,
    })) registry.register(tool);
    const definition = registry.definitions().find((tool) => tool.name === "spawn_readonly_subagent");
    assert.equal(definition?.readOnly, true);
    assert.equal(definition?.effect, "none");
    const result = await registry.invoke({
      type: "tool_call",
      callId: "research_1",
      name: "spawn_readonly_subagent",
      arguments: { assignment: "Inspect scheduler invariants", maxTurns: 3 },
    }, {
      runId: "run_1",
      sessionId: "worker:run_1:T1:1",
      actor: { role: "worker", id: "worker_1" },
      workspacePath: workspace,
    });
    assert.equal(result.isError, false, result.error?.message ?? "read-only subagent failed");
    assert.equal(
      (await sessions.load("worker:run_1:T1:1:subagent:research_1")).status,
      "completed"
    );
    const childTools = new Set(requests[0].tools.map((tool) => tool.name));
    assert.equal(childTools.has("fs.read"), true);
    assert.equal(childTools.has("git.show"), true);
    assert.equal(childTools.has("search_session_history"), true);
    for (const forbidden of [
      "fs.patch",
      "fs.write",
      "git.commit",
      "git.push",
      "process.run",
      "run_evidence_command",
      "propose_project_memory",
      "spawn_subagent",
      "browser.click",
    ]) assert.equal(childTools.has(forbidden), false, `${forbidden} must be unavailable`);
  } finally {
    sessions.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("subagent model calls use child role and session attribution", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-attributed-subagent-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  const toolLedger = new SqliteToolLedger(join(root, "tools.sqlite"));
  const budgetLedger = new SqliteBudgetLedger(join(root, "budget.sqlite"), {
    limitsFor: () => ({}),
  });
  const parentSessionId = "worker:run_1:T1:1";
  const rawModel: AgentModel = {
    complete: async () => ({
      blocks: [{
        type: "tool_call",
        callId: "return_1",
        name: "return_to_parent",
        arguments: { summary: "Inspection complete", artifactHashes: [] },
      }],
      stopReason: "tool_calls",
      usage: { inputTokens: 3, outputTokens: 2 },
    }),
  };
  const parentModel = new BudgetedAgentModel({
    model: rawModel,
    ledger: budgetLedger,
    scopeId: "run_1",
    attribution: {
      runtimeId: "runtime_code",
      providerId: "provider_api",
      modelId: "model_code",
      role: "worker",
      sessionId: parentSessionId,
      taskId: "T1",
    },
    outputTokenReserve: 10,
  });
  try {
    const registry = new ToolRegistry();
    for (const tool of createSubagentTools({
      model: parentModel,
      subagentModelForSession: (sessionId: string) => new BudgetedAgentModel({
        model: rawModel,
        ledger: budgetLedger,
        scopeId: "run_1",
        attribution: {
          runtimeId: "runtime_code",
          providerId: "provider_api",
          modelId: "model_code",
          role: "subagent",
          sessionId,
          taskId: "T1",
        },
        outputTokenReserve: 10,
      }),
      runId: "run_1",
      parentSessionId,
      taskId: "T1",
      parentActorId: "worker_1",
      permissionProfile: "full",
      workspacePath: workspace,
      artifacts,
      ledger: toolLedger,
      sessions,
      budgetLedger,
    })) registry.register(tool);
    const callId = "research_1";
    const childSessionId = `${parentSessionId}:subagent:${callId}`;
    const result = await registry.invoke({
      type: "tool_call",
      callId,
      name: "spawn_readonly_subagent",
      arguments: { assignment: "Inspect scheduler invariants", maxTurns: 3 },
    }, {
      runId: "run_1",
      sessionId: parentSessionId,
      actor: { role: "worker", id: "worker_1" },
      workspacePath: workspace,
    });
    assert.equal(result.isError, false, result.error?.message ?? "subagent failed");
    const reservations = Object.values(budgetLedger.snapshot("run_1").reservations)
      .filter((reservation) => reservation.kind === "model");
    assert.equal(reservations.length, 1);
    assert.deepEqual(reservations[0].attribution, {
      runtimeId: "runtime_code",
      providerId: "provider_api",
      modelId: "model_code",
      role: "subagent",
      sessionId: childSessionId,
      taskId: "T1",
    });
  } finally {
    budgetLedger.close();
    sessions.close();
    toolLedger.close();
    rmSync(root, { recursive: true, force: true });
  }
});
