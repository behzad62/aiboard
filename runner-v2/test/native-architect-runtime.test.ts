import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { ProviderTransportError } from "../src/account-runner-model.js";
import { buildArchitectContext } from "../src/agent-prompts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createBrowserTools, type BrowserBackend } from "../src/browser-tools.js";
import { BuildRuntime } from "../src/build-runtime.js";
import {
  NativeArchitectRuntime,
  PlanOnlyInspectionRuntime,
  architectInspectionWorkspace,
  architectModelAttribution,
  prioritizedArchitectCapabilities,
} from "../src/native-architect-runtime.js";
import type { SchedulerProjection } from "../src/scheduler-store.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { createMcpTools, type McpManager } from "../src/mcp-tools.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import { RuntimeRouter, type AgentRuntimeCandidate } from "../src/runtime-router.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import type { SkillMetadata } from "../src/skill-catalog.js";
import { rankSkillsForTask } from "../src/skill-routing.js";
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

test("Architect review context carries the submitted criterion evidence mapping", () => {
  const context = buildArchitectContext({
    limits: { maxBytes: 64 * 1024, maxEstimatedTokens: 16 * 1024 },
    objective: "Build the requested feature.",
    reason: { type: "review_required", taskId: "task_a", changeSetId: "changeset_1" },
    projection: {
      runId: "run_1",
      status: "running",
      planRevision: 1,
      tasks: {},
      guidance: {},
      userGuidance: {},
      userGuidanceVersion: 0,
      architectQuestions: {},
      architectQuestionVersion: 0,
      reviews: {},
      runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
      lastSequence: 1,
    },
    reviewSubmission: {
      taskId: "task_a",
      attempt: 1,
      changeSetId: "changeset_1",
      baselineRevision: "a".repeat(40),
      taskRevision: "b".repeat(40),
      changedPaths: ["value.txt"],
      diffArtifactHash: "c".repeat(64),
      evidenceArtifactHashes: ["d".repeat(64)],
      acceptanceCriteria: [{ id: "behavior", text: "The behavior is implemented." }],
      acceptanceCriteriaVersion: 1,
      criterionEvidenceLinks: [{
        criterionId: "behavior",
        evidenceId: "evidence_1",
        artifactHashes: ["d".repeat(64)],
        taskId: "task_a",
        attempt: 1,
      }],
    },
    instructions: [],
    skills: [],
    memories: [],
    evidence: [],
    recentHistory: [],
  });
  assert.match(context.text, /criterionEvidenceLinks/);
  assert.match(context.text, /evidence_1/);
});

test("Architect skill routing prioritizes the task named by the current action", () => {
  const capabilities = prioritizedArchitectCapabilities(
    { type: "review_required", taskId: "task_visual", changeSetId: "change_1" },
    [
      { id: "task_setup", requiredCapabilities: ["repository-exploration"] },
      { id: "task_visual", requiredCapabilities: ["verification"] },
      { id: "task_later", requiredCapabilities: ["systematic-debugging"] },
    ]
  );
  const metadata: SkillMetadata[] = [
    skillMetadata("repository-exploration"),
    skillMetadata("verification"),
    skillMetadata("systematic-debugging"),
  ];
  const selected = rankSkillsForTask(metadata, "Review the submitted task", capabilities, 1);
  assert.equal(selected[0]?.name, "verification");
});

test("Architect reviews inspect the submitted attempt workspace instead of the project root", () => {
  const projection = {
    tasks: {
      task_visual: {
        id: "task_visual",
        objective: "Add camera controls",
        dependencies: [],
        requiredCapabilities: ["verification"],
        status: "architect_review",
        attempt: 8,
        assignedWorkerId: "worker_visual_8",
        workspacePath: "C:/runner/workspaces/task-visual-attempt-8",
        workspaceId: "task_visual:attempt:8",
        workspaceBaselineRevision: "a".repeat(40),
        changeSetId: "change_8",
      },
    },
  } as unknown as SchedulerProjection;

  assert.equal(
    architectInspectionWorkspace(
      { type: "review_required", taskId: "task_visual", changeSetId: "change_8" },
      projection,
      "C:/project"
    ),
    "C:/runner/workspaces/task-visual-attempt-8"
  );
  assert.equal(
    architectInspectionWorkspace({ type: "plan_required" }, projection, "C:/project"),
    "C:/project"
  );
  assert.equal(
    architectInspectionWorkspace(
      { type: "final_verification_plan_required", integrationRevision: "a".repeat(40) },
      projection,
      "C:/project",
      "C:/runner/integration/run",
    ),
    "C:/runner/integration/run",
  );
});

test("Native Architect steering cancellation does not create a user-decision pause", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-native-architect-steering-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
  const sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
  const evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
  const memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
  const objective = "Build\nthis exact application.  ";
  try {
    scheduler.append({
      runId: "run-steering-cancel",
      type: "run.initialized",
      occurredAt: "2026-08-27T00:00:00.000Z",
      actor: { role: "runner", id: "test" },
      idempotencyKey: "init",
      payload: { objective },
    });
    scheduler.append({
      runId: "run-steering-cancel",
      type: "plan.created",
      occurredAt: "2026-08-27T00:00:01.000Z",
      actor: { role: "architect", id: "architect" },
      idempotencyKey: "plan",
      payload: { revision: 1, tasks: [{
        id: "task-a",
        objective: "Implement A",
        dependencies: [],
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "done", text: "A is implemented." }],
        acceptanceCriteriaVersion: 1,
        status: "planned",
        attempt: 0,
      }] },
    });
    scheduler.append({
      runId: "run-steering-cancel",
      type: "user.guidance_submitted",
      occurredAt: "2026-08-27T00:00:02.000Z",
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "guidance",
      payload: { guidanceId: "guidance-1", text: "Keep the public API stable.", version: 1 },
    });
    const candidate: AgentRuntimeCandidate = {
      runtimeId: "test:architect",
      providerId: "test",
      modelId: "architect",
      capabilities: ["code"],
      priority: 1,
    };
    const health = new ProviderHealthRegistry();
    const steeringModel = new ScriptedModel([{
      blocks: [],
      stopReason: "cancelled",
    }]);
    const architect = new NativeArchitectRuntime({
      schedulerStore: scheduler,
      router: new RuntimeRouter({ candidates: [candidate], health }),
      health,
      candidates: [candidate],
      models: new Map([[candidate.runtimeId, steeringModel]]),
      initialRuntimeId: candidate.runtimeId,
      sessions,
      artifacts,
      skillCatalog: new SkillCatalog({ projectRoot: project }),
      memoryStore: memory,
      evidenceStore: evidence,
      projectId: "project-steering",
      projectRoot: project,
      objective,
    });
    const projection = rebuildSchedulerProjection(scheduler.readRun("run-steering-cancel"));
    await architect.run({
      runId: "run-steering-cancel",
      reason: { type: "user_guidance_required", guidanceId: "guidance-1", version: 1 },
      projection,
      tools: new ToolRegistry(),
      context: {
        runId: "run-steering-cancel",
        sessionId: "architect:run-steering-cancel",
        actor: { role: "architect", id: "architect" },
      },
    });
    const recovered = rebuildSchedulerProjection(scheduler.readRun("run-steering-cancel"));
    assert.equal(recovered.status, "running");
    assert.equal(recovered.pauseReason, undefined);
    assert.equal(scheduler.readRun("run-steering-cancel").some((event) => event.type === "run.paused"), false);
    assert.equal(recovered.initialObjective, objective);
    const steeringContext = steeringModel.requests[0].messages
      .map((message) => typeof message.content === "string" ? message.content : "")
      .join("\n");
    assert.match(steeringContext, /Keep the public API stable/);
    assert.match(steeringContext, /Build\\nthis exact application/);

    const mismatchHealth = new ProviderHealthRegistry();
    const mismatchedArchitect = new NativeArchitectRuntime({
      schedulerStore: scheduler,
      router: new RuntimeRouter({ candidates: [candidate], health: mismatchHealth }),
      health: mismatchHealth,
      candidates: [candidate],
      models: new Map([[candidate.runtimeId, new ScriptedModel([{
        blocks: [],
        stopReason: "cancelled",
      }])]]),
      initialRuntimeId: candidate.runtimeId,
      sessions,
      artifacts,
      skillCatalog: new SkillCatalog({ projectRoot: project }),
      memoryStore: memory,
      evidenceStore: evidence,
      projectId: "project-mismatch",
      projectRoot: project,
      objective: `${objective}changed`,
    });
    await assert.rejects(() => mismatchedArchitect.run({
      runId: "run-steering-cancel",
      reason: { type: "user_guidance_required", guidanceId: "guidance-1", version: 1 },
      projection: recovered,
      tools: new ToolRegistry(),
      context: {
        runId: "run-steering-cancel",
        sessionId: "architect:run-steering-cancel:mismatch",
        actor: { role: "architect", id: "architect" },
      },
    }), /durable initial objective.*does not match/i);

    const directObjective = "Direct native initialization\nkeeps\tthese bytes.  ";
    const directHealth = new ProviderHealthRegistry();
    const directArchitect = new NativeArchitectRuntime({
      schedulerStore: scheduler,
      router: new RuntimeRouter({ candidates: [candidate], health: directHealth }),
      health: directHealth,
      candidates: [candidate],
      models: new Map([[candidate.runtimeId, new ScriptedModel([{
        blocks: [],
        stopReason: "cancelled",
      }])]]),
      initialRuntimeId: candidate.runtimeId,
      sessions,
      artifacts,
      skillCatalog: new SkillCatalog({ projectRoot: project }),
      memoryStore: memory,
      evidenceStore: evidence,
      projectId: "project-direct-init",
      projectRoot: project,
      objective: directObjective,
    });
    await directArchitect.run({
      runId: "run-direct-native-init",
      reason: { type: "plan_required" },
      projection: {
        ...projection,
        runId: "run-direct-native-init",
        userGuidance: {},
        userGuidanceVersion: 0,
      },
      tools: new ToolRegistry(),
      context: {
        runId: "run-direct-native-init",
        sessionId: "architect:run-direct-native-init",
        actor: { role: "architect", id: "architect" },
      },
    });
    const directEvents = scheduler.readRun("run-direct-native-init");
    assert.equal(directEvents[0].type, "run.initialized");
    assert.equal(directEvents[0].payload.objective, directObjective);
  } finally {
    sessions.close();
    scheduler.close();
    evidence.close();
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
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
               acceptanceCriteria: [{ id: "api", text: "The stable API is implemented." }],
            }],
          },
        }],
        stopReason: "tool_calls",
      },
    ]);
    const primary = new ScriptedModel(Array.from(
      { length: 6 },
      () => new ProviderTransportError(
        "provider unavailable secret-token",
        503
      )
    ));
    const architect = new NativeArchitectRuntime({
      schedulerStore: scheduler,
      router: new RuntimeRouter({ candidates, health }),
      health,
      candidates,
      models: new Map([
        ["primary:architect", primary],
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
      providerRetryRuntime: {
        now: () => 0,
        random: () => 0.5,
        sleep: async () => undefined,
      },
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
      "primary:architect",
      "fallback:architect",
    ]);
    const retryEvents = scheduler.readRun("run_1").filter(
      (event) => event.type === "provider.retry_scheduled"
    );
    assert.equal(retryEvents.length, 5);
    assert.equal(primary.requests.length, 6);
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
    for (const name of [
      "repo.manifest",
      "repo.map",
      "code.workspace_symbols",
      "code.definition",
      "code.references",
      "code.diagnostics",
    ]) assert.equal(architectTools.has(name), true, `${name} must be available`);
    assert.equal(architectTools.has("fs.write"), false);
    assert.equal(architectTools.has("git.commit"), false);
    assert.match(
      fallback.requests[0].messages
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .join("\n"),
      /Keep the API stable/
    );

    const onlyCandidate = candidates[0];
    const deadlineHealth = new ProviderHealthRegistry();
    const deadlineModel = new ScriptedModel([
      new ProviderTransportError(
        "provider unavailable",
        503,
        "temporarily_unavailable",
        20_000
      ),
    ]);
    const deadlineArchitect = new NativeArchitectRuntime({
      schedulerStore: scheduler,
      router: new RuntimeRouter({
        candidates: [onlyCandidate],
        health: deadlineHealth,
      }),
      health: deadlineHealth,
      candidates: [onlyCandidate],
      models: new Map([[onlyCandidate.runtimeId, deadlineModel]]),
      initialRuntimeId: onlyCandidate.runtimeId,
      sessions,
      artifacts,
      skillCatalog: new SkillCatalog({ projectRoot: project }),
      memoryStore: memory,
      evidenceStore: evidence,
      projectId: "project_1",
      projectRoot: project,
      objective: "Build the requested feature.",
      providerRetryRuntime: {
        now: () => 0,
        random: () => 0.5,
        sleep: async () => {
          throw new Error("oversized Retry-After must not sleep");
        },
      },
    });
    const deadlineRuntime = new BuildRuntime({
      runId: "run_deadline",
      store: scheduler,
      workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
      architectDriver: deadlineArchitect,
      integrationDriver: {
        integrate: async () => ({
          status: "integrated",
          integrationRevision: "unused",
        }),
      },
      maxConcurrency: 1,
      workspaceFor: async () => "unused",
      providerRetryDeadlineMs: () => 10_000,
    });
    assert.equal((await deadlineRuntime.step()).status, "paused");
    const deadlineProjection = deadlineRuntime.projection();
    assert.equal(deadlineProjection.runtime.architect.handoff, undefined);
    assert.match(deadlineProjection.pauseReason?.reason ?? "", /budget_exhausted/);
    assert.equal(deadlineModel.requests.length, 1);
    assert.equal(scheduler.readRun("run_deadline").filter(
      (event) => event.type === "provider.retry_scheduled"
    ).length, 0);

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
    assert.deepEqual(
      noFallbackProjection.runtime.architect.handoff?.candidateRuntimeIds,
      ["primary:architect"]
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
    wheel: async () => undefined,
    drag: async () => undefined,
    screenshot: async () => Buffer.from("png"),
    events: async () => ({ console: [], network: [] }),
    close: async () => undefined,
    closeRun: async () => undefined,
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
  assert.equal(names.includes("browser.wheel"), false);
  assert.equal(names.includes("browser.drag"), false);
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
               acceptanceCriteria: [{ id: "feature", text: "The feature is implemented." }],
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

function skillMetadata(name: string): SkillMetadata {
  return {
    id: `built-in:${name}`,
    name,
    description: `${name} guidance`,
    relativePath: `built-in:${name}/SKILL.md`,
    digest: name.padEnd(64, "0").slice(0, 64),
    byteLength: 100,
    source: "built-in",
  };
}
