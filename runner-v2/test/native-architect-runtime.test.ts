import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { BuildRuntime } from "../src/build-runtime.js";
import { NativeArchitectRuntime } from "../src/native-architect-runtime.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import { RuntimeRouter, type AgentRuntimeCandidate } from "../src/runtime-router.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteProjectMemoryStore } from "../src/sqlite-project-memory.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";

class ScriptedModel implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  constructor(private readonly turns: Array<ModelTurn | Error>) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const turn = this.turns.shift();
    if (!turn) throw new Error("script exhausted");
    if (turn instanceof Error) throw turn;
    return turn;
  }
}

test("Architect provider failure pauses for user-selected handoff before planning", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-native-architect-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "AGENTS.md"), "Keep the API stable.\n");
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
  const sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
  const evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
  const memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
  try {
    const candidates: AgentRuntimeCandidate[] = [
      { runtimeId: "primary:architect", providerId: "primary", modelId: "architect", capabilities: ["code"], priority: 1 },
      { runtimeId: "fallback:architect", providerId: "fallback", modelId: "architect", capabilities: ["code"], priority: 2 },
    ];
    const health = new ProviderHealthRegistry();
    const fallback = new ScriptedModel([
      {
        blocks: [{
          type: "tool_call",
          callId: "plan_1",
          name: "plan_tasks",
          arguments: {
            revision: 1,
            tasks: [{
              id: "task_a",
              objective: "Implement the stable API",
              dependencies: [],
              requiredCapabilities: ["code"],
            }],
          },
        }],
        stopReason: "tool_calls",
      },
    ]);
    const architect = new NativeArchitectRuntime({
      schedulerStore: scheduler,
      router: new RuntimeRouter({ candidates, health }),
      health,
      candidates,
      models: new Map([
        ["primary:architect", new ScriptedModel([new Error("provider unavailable")])],
        ["fallback:architect", fallback],
      ]),
      initialRuntimeId: "primary:architect",
      sessions,
      artifacts,
      skillCatalog: new SkillCatalog({ projectRoot: project }),
      memoryStore: memory,
      evidenceStore: evidence,
      projectId: "project_1",
      projectRoot: project,
    });
    const runtime = new BuildRuntime({
      runId: "run_1",
      store: scheduler,
      workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
      architectDriver: architect,
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
      maxConcurrency: 1,
      workspaceFor: async () => "unused",
    });
    const first = await runtime.step();
    assert.equal(first.status, "paused");
    let projection = runtime.projection();
    assert.equal(projection.planRevision, 0);
    assert.deepEqual(projection.runtime.architect.handoff?.candidateRuntimeIds, [
      "fallback:architect",
    ]);
    assert.equal(fallback.requests.length, 0, "Architect replacement is never automatic");

    scheduler.append({
      runId: "run_1",
      type: "architect.handoff_selected",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "handoff:selected",
      payload: { runtimeId: "fallback:architect" },
    });
    const second = await runtime.step();
    assert.equal(second.status, "progressed");
    projection = runtime.projection();
    assert.equal(projection.planRevision, 1);
    assert.equal(projection.tasks.task_a.status, "planned");
    assert.equal(projection.runtime.architect.runtimeId, "fallback:architect");
    assert.match(
      fallback.requests[0].messages
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .join("\n"),
      /Keep the API stable/
    );
  } finally {
    sessions.close();
    scheduler.close();
    evidence.close();
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});
