import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createBrowserTools, type BrowserBackend } from "../src/browser-tools.js";
import { BuildRuntime } from "../src/build-runtime.js";
import {
  NativeArchitectRuntime,
  PlanOnlyInspectionRuntime,
  architectModelAttribution,
} from "../src/native-architect-runtime.js";
import { createMcpTools, type McpManager } from "../src/mcp-tools.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import { RuntimeRouter, type AgentRuntimeCandidate } from "../src/runtime-router.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteProjectMemoryStore } from "../src/sqlite-project-memory.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { ToolRegistry } from "../src/tool-registry.js";

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

test("Architect model calls carry direct durable role attribution", () => {
  assert.deepEqual(
    architectModelAttribution({
      runtimeId: "api:architect",
      providerId: "api",
      modelId: "architect-model",
      capabilities: ["code"],
      priority: 1,
    }, "architect:run_1"),
    {
      runtimeId: "api:architect",
      providerId: "api",
      modelId: "architect-model",
      role: "architect",
      sessionId: "architect:run_1",
    }
  );
});

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
      objective: "Build the requested feature.",
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
    const architectTools = new Set(fallback.requests[0].tools.map((tool) => tool.name));
    assert.equal(architectTools.has("fs.search"), true);
    assert.equal(architectTools.has("git.diff"), true);
    assert.equal(architectTools.has("research.fetch"), true);
    assert.equal(architectTools.has("fs.write"), false);
    assert.equal(architectTools.has("git.commit"), false);
    assert.match(
      fallback.requests[0].messages
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .join("\n"),
      /Keep the API stable/
    );

    const onlyCandidate = candidates[0];
    const noFallbackHealth = new ProviderHealthRegistry();
    const noFallbackArchitect = new NativeArchitectRuntime({
      schedulerStore: scheduler,
      router: new RuntimeRouter({ candidates: [onlyCandidate], health: noFallbackHealth }),
      health: noFallbackHealth,
      candidates: [onlyCandidate],
      models: new Map([
        [onlyCandidate.runtimeId, new ScriptedModel([new Error("usage limit reached")])],
      ]),
      initialRuntimeId: onlyCandidate.runtimeId,
      sessions,
      artifacts,
      skillCatalog: new SkillCatalog({ projectRoot: project }),
      memoryStore: memory,
      evidenceStore: evidence,
      projectId: "project_1",
      projectRoot: project,
      objective: "Build the requested feature.",
    });
    const noFallbackRuntime = new BuildRuntime({
      runId: "run_no_fallback",
      store: scheduler,
      workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
      architectDriver: noFallbackArchitect,
      integrationDriver: {
        integrate: async () => ({ status: "integrated", integrationRevision: "unused" }),
      },
      maxConcurrency: 1,
      workspaceFor: async () => "unused",
    });
    assert.equal((await noFallbackRuntime.step()).status, "paused");
    const noFallbackProjection = noFallbackRuntime.projection();
    assert.equal(noFallbackProjection.runtime.architect.handoff, undefined);
    assert.equal(
      scheduler.readRun("run_no_fallback").at(-1)?.payload.reason,
      "all_architect_runtimes_unavailable"
    );
  } finally {
    sessions.close();
    scheduler.close();
    evidence.close();
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Plan-only rejects forged mutating browser and MCP calls even under Full access", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-plan-only-tools-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  let browserClicks = 0;
  let mcpWrites = 0;
  const browser = {
    open: async () => ({ url: "https://example.test/", title: "Example" }),
    navigate: async () => ({ url: "https://example.test/", title: "Example" }),
    snapshot: async () => ({ url: "https://example.test/", title: "Example", text: "safe", html: "<p>safe</p>" }),
    click: async () => { browserClicks += 1; },
    fill: async () => undefined,
    screenshot: async () => Buffer.from("png"),
    events: async () => ({ console: [], network: [] }),
    close: async () => undefined,
    closeAll: async () => undefined,
  } satisfies BrowserBackend;
  const mcp = {
    toolEntries: () => [
      {
        client: {
          spec: { name: "audit", command: "unused" },
          call: async () => ({ structuredContent: { ok: true } }),
        },
        tool: {
          name: "read",
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
      },
      {
        client: {
          spec: { name: "audit", command: "unused" },
          call: async () => { mcpWrites += 1; return { structuredContent: { ok: true } }; },
        },
        tool: {
          name: "write",
          annotations: { readOnlyHint: false, destructiveHint: true },
        },
      },
    ],
  } as unknown as McpManager;
  const registry = new ToolRegistry();
  for (const tool of createBrowserTools({ backend: browser, artifacts, taskId: "architect" })) {
    registry.register(tool);
  }
  for (const tool of createMcpTools(mcp, artifacts)) registry.register(tool);
  const runtime = new PlanOnlyInspectionRuntime(registry);
  const names = runtime.definitions().map((tool) => tool.name);
  assert.equal(names.includes("browser.snapshot"), true);
  assert.equal(names.includes("mcp.audit.read"), true);
  assert.equal(names.includes("browser.click"), false);
  assert.equal(names.includes("mcp.audit.write"), false);
  const context = {
    runId: "run_plan",
    sessionId: "architect:run_plan",
    actor: { role: "architect" as const, id: "architect" },
    workspacePath: root,
  };
  const browserResult = await runtime.invoke({
    type: "tool_call", callId: "forged_browser", name: "browser.click", arguments: { selector: "#buy" },
  }, context);
  const mcpResult = await runtime.invoke({
    type: "tool_call", callId: "forged_mcp", name: "mcp.audit.write", arguments: {},
  }, context);
  assert.equal(browserResult.error?.code, "plan_only_tool_denied");
  assert.equal(mcpResult.error?.code, "plan_only_tool_denied");
  assert.equal(browserClicks, 0);
  assert.equal(mcpWrites, 0);
  rmSync(root, { recursive: true, force: true });
});

test("resumed Architect action receives a fresh mechanical reminder", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-architect-resume-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
  const sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
  const evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
  const memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
  try {
    const candidate: AgentRuntimeCandidate = {
      runtimeId: "primary:architect",
      providerId: "primary",
      modelId: "architect",
      capabilities: ["code"],
      priority: 1,
    };
    const model = new ScriptedModel([
      {
        blocks: [{ type: "text", text: "I should use a lifecycle tool." }],
        stopReason: "end_turn",
      },
      {
        blocks: [{
          type: "tool_call",
          callId: "plan_after_resume",
          name: "plan_tasks",
          arguments: {
            revision: 1,
            tasks: [{
              id: "task_a",
              objective: "Implement the feature",
              dependencies: [],
              requiredCapabilities: ["code"],
            }],
          },
        }],
        stopReason: "tool_calls",
      },
    ]);
    const health = new ProviderHealthRegistry();
    const architect = new NativeArchitectRuntime({
      schedulerStore: scheduler,
      router: new RuntimeRouter({ candidates: [candidate], health }),
      health,
      candidates: [candidate],
      models: new Map([[candidate.runtimeId, model]]),
      initialRuntimeId: candidate.runtimeId,
      sessions,
      artifacts,
      skillCatalog: new SkillCatalog({ projectRoot: project }),
      memoryStore: memory,
      evidenceStore: evidence,
      projectId: "project_1",
      projectRoot: project,
      objective: "Build the requested feature.",
    });
    const runtime = new BuildRuntime({
      runId: "run_resume",
      store: scheduler,
      workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
      architectDriver: architect,
      integrationDriver: {
        integrate: async () => ({
          status: "integrated",
          integrationRevision: "unused",
        }),
      },
      maxConcurrency: 1,
      workspaceFor: async () => "unused",
    });
    assert.equal((await runtime.step()).status, "paused");
    scheduler.append({
      runId: "run_resume",
      type: "run.resumed",
      occurredAt: "2026-07-12T00:00:00.000Z",
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "resume:1",
      payload: {},
    });
    assert.equal((await runtime.step()).status, "progressed");
    const resumedMessages = model.requests[1].messages;
    const priorProseIndex = resumedMessages.findIndex(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (block) => block.type === "text" && block.text.includes("lifecycle tool")
        )
    );
    assert.notEqual(priorProseIndex, -1);
    const reminder = resumedMessages.slice(priorProseIndex + 1).find(
      (message) =>
        message.role === "user" &&
        typeof message.content === "string" &&
        message.content.includes("Earlier mechanical tool errors may have been resolved")
    );
    assert.ok(reminder, "resume must add a fresh current-action reminder");
    assert.equal(runtime.projection().planRevision, 1);
  } finally {
    sessions.close();
    scheduler.close();
    evidence.close();
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});
