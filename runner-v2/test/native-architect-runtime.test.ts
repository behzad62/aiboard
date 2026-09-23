import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel, AgentModelRequest, ModelTurn, ToolResult } from "../src/agent-contracts.js";
import { ProviderTransportError } from "../src/account-runner-model.js";
import { buildArchitectContext } from "../src/agent-prompts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createBrowserTools, type BrowserBackend } from "../src/browser-tools.js";
import { CapabilityRegistry } from "../src/capability-registry.js";
import { createArchitectTools, resolvePlanCritiqueTool } from "../src/architect-tools.js";
import { BuildRuntime } from "../src/build-runtime.js";
import { assessPlanRisk } from "../src/plan-critique-contracts.js";
import { LanguageProviderRouter } from "../src/language-provider-router.js";
import type { LanguageIntelligenceProvider } from "../src/language-intelligence.js";
import { PlanOnlyInspectionRuntime, architectInspectionWorkspace, architectModelAttribution, loadArchitectReviewSubmission, prioritizedArchitectCapabilities, type ArchitectCommandWorkspaceProvider } from "../src/native-architect-runtime.js";
import { roleToolSurface } from "../src/role-capabilities.js";
import { NativeArchitectRuntime, fixtureGitContext } from "./support/git-fixture.js";
import type { SchedulerProjection } from "../src/scheduler-store.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { createMcpTools, type McpManager } from "../src/mcp-tools.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import { RuntimeRouter, type AgentRuntimeCandidate } from "../src/runtime-router.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import type { SkillMetadata } from "../src/skill-catalog.js";
import { rankSkillsForTask } from "../src/skill-routing.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteContextManifestStore } from "../src/sqlite-context-manifest-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteProjectMemoryStore } from "../src/sqlite-project-memory.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import type { OneShotCommandExecutor } from "../src/one-shot-command-executor.js";
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

test("Architect review loads the revised worker session instead of the legacy same-attempt session", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-architect-reassigned-review-"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  const legacySessionId = "worker:run-review:task-a:1";
  const revisedSessionId = "worker:run-review:task-a:1:worker_task-a_1_plan_2";
  try {
    for (const [sessionId, changeSetId, changedPath] of [
      [legacySessionId, "legacy-change", "legacy.txt"],
      [revisedSessionId, "revised-change", "revised.txt"],
    ] as const) {
      await sessions.create({
        sessionId,
        runId: "run-review",
        actor: { role: "worker", id: sessionId === revisedSessionId ? "worker_task-a_1_plan_2" : "worker_task-a_1" },
        occurredAt: "2026-08-27T00:00:00.000Z",
      });
      await sessions.submit(sessionId, {
        id: changeSetId,
        runId: "run-review",
        taskId: "task-a",
        baselineRevision: "a".repeat(40),
        taskRevision: "b".repeat(40),
        commits: [],
        changedPaths: [changedPath],
        diffArtifactHash: "c".repeat(64),
        evidenceArtifactHashes: [],
        externalEffects: [],
        guidanceIds: [],
        memoryIds: [],
        unresolvedConcerns: [],
      }, "2026-08-27T00:00:01.000Z");
    }
    const projection = {
      runId: "run-review",
      status: "running",
      planRevision: 2,
      tasks: {
        "task-a": {
          id: "task-a",
          objective: "Implement revised intent.",
          dependencies: [],
          requiredCapabilities: ["code"],
          status: "architect_review",
          attempt: 1,
          assignedWorkerId: "worker_task-a_1_plan_2",
          changeSetId: "revised-change",
        },
      },
      guidance: {},
      userGuidance: {},
      userGuidanceVersion: 1,
      architectQuestions: {},
      architectQuestionVersion: 0,
      reviews: {},
      runtime: {
        providerHealth: {},
        workerAssignments: {
          "task-a:1": {
            taskId: "task-a",
            attempt: 1,
            runtimeId: "runtime-revised",
            sessionId: revisedSessionId,
          },
        },
        architect: {},
      },
      lastSequence: 1,
    } as SchedulerProjection;
    const submission = await loadArchitectReviewSubmission(
      sessions,
      "run-review",
      { type: "review_required", taskId: "task-a", changeSetId: "revised-change" },
      projection
    );
    assert.equal(submission?.changeSetId, "revised-change");
    assert.deepEqual(submission?.changedPaths, ["revised.txt"]);
  } finally {
    sessions.close();
    rmSync(root, { recursive: true, force: true });
  }
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
  assert.equal(
    architectInspectionWorkspace(
      {
        type: "plan_critique_resolution_required",
        critiqueId: "critique-1",
        planRevision: 1,
        blockingFindingIds: ["F-1"],
      },
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
      payload: {
        guidanceId: "guidance-1",
        text: "Keep the public API stable.",
        version: 1,
        interruptionProtocolVersion: 1,
      },
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
    assert.match(steeringContext, /immutable initial objective/i);
    assert.match(steeringContext, /evidence-proven semantic equivalence/i);
    assert.match(steeringContext, /acknowledge_user_guidance/);
    assert.match(steeringContext, /ask_user/);

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
  let language: LanguageProviderRouter | undefined;
  try {
    const capabilityRegistry = new CapabilityRegistry([{
      manifest: {
        apiVersion: 1,
        id: "fixture.architect",
        name: "Architect fixture",
        version: "1.0.0",
        entry: "index.mjs",
        capabilities: ["tools", "context"],
      },
      instance: {
        capabilities: () => ({
          tools: [{
            definition: {
              name: "fixture.architect.inspect",
              description: "Inspect fixture architecture",
              inputSchema: { type: "object" },
              readOnly: true,
              effect: "none",
            },
            validate: () => ({ ok: true as const, value: {} }),
            execute: async () => ({ content: [], isError: false }),
          }],
          contextContributors: [{
            id: "architect-context",
            kind: "fixture",
            priority: 850,
            maxBytes: 1_024,
            contribute: async () => ({ content: "EXTENSION_ARCHITECT_CONTEXT" }),
          }],
          languageProviders: [],
        }),
        start: async () => undefined,
        close: async () => undefined,
      },
    }]);
    const candidates: AgentRuntimeCandidate[] = [
      { runtimeId: "primary:architect", providerId: "primary", modelId: "architect", capabilities: ["code"], priority: 1 },
      { runtimeId: "fallback:architect", providerId: "fallback", modelId: "architect", capabilities: ["code"], priority: 2 },
    ];
    const health = new ProviderHealthRegistry();
    language = new LanguageProviderRouter({
      builtInProvider: fixtureLanguageProvider(),
      extensionProviders: [],
      configuredServers: [],
    });
    const fallback = new ScriptedModel([
      {
        blocks: [{
          type: "tool_call",
          callId: "fixture_definition",
          name: "code.definition",
          arguments: { path: "AGENTS.md", line: 1, column: 1 },
        }],
        stopReason: "tool_calls",
      },
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
      capabilityRegistry,
      language,
      providerRetryRuntime: {
        now: () => 0,
        random: () => 0.5,
        sleep: async () => undefined,
      },
    } as ConstructorParameters<typeof NativeArchitectRuntime>[0]);
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
    assert.equal(architectTools.has("fixture.architect.inspect"), true);
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
    assert.match(
      fallback.requests[0].messages
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .join("\n"),
      /EXTENSION_ARCHITECT_CONTEXT/,
    );
    assert.deepEqual(language.auditRecords().map((record) => record.providerId), [
      "fixture.language",
    ]);

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
    await language?.close();
    sessions.close();
    scheduler.close();
    evidence.close();
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("Architect excludes mutating extension tools under Project and Full access", async () => {
  for (const permissionProfile of ["project", "full"] as const) {
    const root = mkdtempSync(join(tmpdir(), `aiboard-architect-extension-${permissionProfile}-`));
    const project = join(root, "project");
    const state = join(root, "state");
    mkdirSync(project);
    mkdirSync(state);
    writeFileSync(join(project, "source.txt"), "original\n");
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    const scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
    const sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
    const evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
    const memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
    try {
      const model = new ScriptedModel([
        {
          blocks: [{
            type: "tool_call",
            callId: "mutate_source",
            name: "fixture.architect.mutate",
            arguments: {},
          }],
          stopReason: "tool_calls",
        },
        {
          blocks: [{
            type: "tool_call",
            callId: "plan_tasks",
            name: "plan_tasks",
            arguments: {
              revision: 1,
              tasks: [{
                id: "task_a",
                objective: "Inspect the extension boundary.",
                dependencies: [],
                requiredCapabilities: ["code"],
                acceptanceCriteria: [{ id: "boundary", text: "The boundary is preserved." }],
              }],
            },
          }],
          stopReason: "tool_calls",
        },
      ]);
      const candidate: AgentRuntimeCandidate = {
        runtimeId: "fixture:architect",
        providerId: "fixture",
        modelId: "architect",
        capabilities: ["code"],
        priority: 1,
      };
      const registry = new CapabilityRegistry([{
        manifest: {
          apiVersion: 1,
          id: "fixture.architect-boundary",
          name: "Architect boundary fixture",
          version: "1.0.0",
          entry: "index.mjs",
          capabilities: ["tools"],
        },
        instance: {
          capabilities: () => ({
            tools: [
              {
                definition: {
                  name: "fixture.architect.inspect",
                  description: "Inspect the source boundary.",
                  inputSchema: { type: "object", additionalProperties: false },
                  readOnly: true,
                  effect: "none",
                },
                validate: () => ({ ok: true as const, value: {} }),
                execute: async () => ({ content: [], isError: false }),
              },
              {
                definition: {
                  name: "fixture.architect.mutate",
                  description: "Mutate the source boundary.",
                  inputSchema: { type: "object", additionalProperties: false },
                  readOnly: false,
                  effect: "workspace",
                },
                validate: () => ({ ok: true as const, value: {} }),
                execute: async (_input, context) => {
                  assert.ok(context.workspacePath);
                  writeFileSync(join(context.workspacePath, "source.txt"), "mutated\n");
                  return { content: [], isError: false };
                },
              },
            ],
            contextContributors: [],
            languageProviders: [],
          }),
          start: async () => undefined,
          close: async () => undefined,
        },
      }]);
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
        objective: "Protect the project source.",
        permissionProfile,
        capabilityRegistry: registry,
      });
      const runtime = new BuildRuntime({
        runId: `run_${permissionProfile}`,
        store: scheduler,
        workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
        architectDriver: architect,
        integrationDriver: {
          integrate: async () => ({ status: "integrated", integrationRevision: "unused" }),
        },
        maxConcurrency: 1,
        workspaceFor: async () => "unused",
      });

      assert.equal((await runtime.step()).status, "progressed");
      const advertised = new Set(model.requests[0]!.tools.map((tool) => tool.name));
      assert.equal(advertised.has("fixture.architect.inspect"), true);
      assert.equal(advertised.has("fixture.architect.mutate"), false);
      assert.equal(readFileSync(join(project, "source.txt"), "utf8"), "original\n");
      assert.equal(runtime.projection().planRevision, 1);
    } finally {
      sessions.close();
      scheduler.close();
      evidence.close();
      memory.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

function planOnlyListedTool(name: string) {
  return {
    definition: {
      name,
      description: name,
      inputSchema: { type: "object", additionalProperties: false },
      readOnly: true as const,
      effect: "none" as const,
    },
    validate: () => ({ ok: true as const, value: {} }),
    execute: async () => ({ content: [], isError: false as const }),
  };
}

function fixtureLanguageProvider(): LanguageIntelligenceProvider {
  return {
    descriptor: {
      id: "fixture.language",
      displayName: "Fixture language",
      extensions: [".fixture", ".md"],
      rootMarkers: [],
      priority: 1,
    },
    workspaceSymbols: async () => ({ status: "ok", results: [], truncated: false }),
    definition: async () => ({
      status: "ok",
      results: [{ path: "fixture", line: 1, column: 1, preview: "fixture" }],
      truncated: false,
    }),
    references: async () => ({ status: "ok", results: [], truncated: false }),
    diagnostics: async () => ({ status: "ok", results: [], truncated: false }),
    close: async () => undefined,
  };
}

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
  for (const name of roleToolSurface("architect", "planOnly").tools) {
    registry.register(planOnlyListedTool(name));
  }
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
    const reminderText = typeof reminder?.content === "string" ? reminder.content : "";
    assert.match(reminderText, /End each action with exactly one decision tool/);
    assert.match(reminderText, /write_project_doc does not end the action/);
    assert.doesNotMatch(reminderText, /one native lifecycle tool/);
    assert.doesNotMatch(reminderText, /exactly one semantically appropriate lifecycle tool/);
    assert.equal(runtime.projection().planRevision, 1);
  } finally {
    sessions.close();
    scheduler.close();
    evidence.close();
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("every Architect action records one context manifest for the reason, including taskId when present", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-native-architect-manifest-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
  const sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
  const evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
  const memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
  const contextManifests = new SqliteContextManifestStore(join(state, "context-manifests.sqlite"));
  const objective = "Build the requested application.";
  try {
    scheduler.append({
      runId: "run_manifest",
      type: "run.initialized",
      occurredAt: "2026-08-27T00:00:00.000Z",
      actor: { role: "runner", id: "test" },
      idempotencyKey: "init",
      payload: { objective },
    });
    scheduler.append({
      runId: "run_manifest",
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
    const candidate: AgentRuntimeCandidate = {
      runtimeId: "test:architect",
      providerId: "test",
      modelId: "architect",
      capabilities: ["code"],
      priority: 1,
    };
    const health = new ProviderHealthRegistry();
    const architect = new NativeArchitectRuntime({
      schedulerStore: scheduler,
      router: new RuntimeRouter({ candidates: [candidate], health }),
      health,
      candidates: [candidate],
      models: new Map([[candidate.runtimeId, new ScriptedModel([
        { blocks: [], stopReason: "cancelled" },
        { blocks: [], stopReason: "cancelled" },
      ])]]),
      initialRuntimeId: candidate.runtimeId,
      sessions,
      artifacts,
      skillCatalog: new SkillCatalog({ projectRoot: project }),
      memoryStore: memory,
      evidenceStore: evidence,
      projectId: "project-manifest",
      projectRoot: project,
      objective,
      contextManifests,
      clock: () => "2026-08-27T00:00:00.000Z",
    });
    const projection = rebuildSchedulerProjection(scheduler.readRun("run_manifest"));
    await architect.run({
      runId: "run_manifest",
      reason: { type: "plan_required" },
      projection,
      tools: new ToolRegistry(),
      context: {
        runId: "run_manifest",
        sessionId: "architect:run_manifest",
        actor: { role: "architect", id: "architect" },
      },
    });
    const planned = contextManifests.listRun("run_manifest");
    assert.equal(planned.length, 1);
    assert.equal(planned[0]?.role, "architect");
    assert.equal(planned[0]?.purpose, "architect:plan_required");
    assert.equal(planned[0]?.sessionId, "architect:run_manifest");
    assert.equal(planned[0]?.taskId, undefined);
    assert.equal(planned[0]?.packArtifactHash, undefined);

    await architect.run({
      runId: "run_manifest",
      reason: {
        type: "task_failure_resolution_required",
        taskId: "task-a",
        attempt: 1,
        failureReason: "tests failed",
      },
      projection: rebuildSchedulerProjection(scheduler.readRun("run_manifest")),
      tools: new ToolRegistry(),
      context: {
        runId: "run_manifest",
        sessionId: "architect:run_manifest",
        actor: { role: "architect", id: "architect" },
      },
    });
    const listed = contextManifests.listRun("run_manifest");
    assert.equal(listed.length, 2);
    const failed = listed.find((manifest) => manifest.purpose === "architect:task_failure_resolution_required");
    assert.equal(failed?.role, "architect");
    assert.equal(failed?.taskId, "task-a");
    assert.equal(failed?.sessionId, "architect:run_manifest");
  } finally {
    contextManifests.close();
    sessions.close();
    scheduler.close();
    evidence.close();
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolve_plan_critique is option-gated, appends plan_critique.resolved, and rejects stale ids", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-architect-resolve-critique-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const clock = () => "2026-09-02T00:00:00.000Z";
  const runId = "run-resolve-critique";
  const architect = { role: "architect" as const, id: "architect-test" };
  try {
    seedSubmittedCritique(store, runId);
    const absent = createArchitectTools({ store, clock });
    assert.equal(absent.some((tool) => tool.definition.name === "resolve_plan_critique"), false);
    const tool = resolvePlanCritiqueTool(store, clock);
    assert.equal(tool.definition.name, "resolve_plan_critique");
    const tools = createArchitectTools({ store, clock, planCritiqueResolutionAvailable: true });
    const resolve = tools.find((candidate) => candidate.definition.name === "resolve_plan_critique");
    assert.ok(resolve);
    const stale = await resolve.execute({
      critiqueId: "critique-stale",
      planRevision: 1,
      resolutions: [{ findingId: "F-1", resolution: "rejected", rationale: "The files are distinct." }],
    }, {
      runId,
      sessionId: "architect:test",
      actor: architect,
    });
    assert.equal(stale.isError, true);
    assert.equal(stale.error?.code, "stale_plan_critique");
    const staleRevision = await resolve.execute({
      critiqueId: "critique-1",
      planRevision: 2,
      resolutions: [{ findingId: "F-1", resolution: "rejected", rationale: "The files are distinct." }],
    }, {
      runId,
      sessionId: "architect:test",
      actor: architect,
    });
    assert.equal(staleRevision.isError, true);
    assert.equal(staleRevision.error?.code, "stale_plan_critique");
    const differentFindings = await resolve.execute({
      critiqueId: "critique-1",
      planRevision: 1,
      resolutions: [{ findingId: "F-other", resolution: "rejected", rationale: "The files are distinct." }],
    }, {
      runId,
      sessionId: "architect:test",
      actor: architect,
    });
    assert.equal(differentFindings.isError, true);
    assert.equal(differentFindings.error?.code, "stale_plan_critique");
    const workerDenied = await resolve.execute({
      critiqueId: "critique-1",
      planRevision: 1,
      resolutions: [{ findingId: "F-1", resolution: "rejected", rationale: "The files are distinct." }],
    }, {
      runId,
      sessionId: "architect:test",
      actor: { role: "worker", id: "worker-1" },
    });
    assert.equal(workerDenied.isError, true);
    assert.equal(workerDenied.error?.code, "architect_only");
    const ok = await resolve.execute({
      critiqueId: "critique-1",
      planRevision: 1,
      resolutions: [{ findingId: "F-1", resolution: "rejected", rationale: "The files are distinct." }],
    }, {
      runId,
      sessionId: "architect:test",
      actor: architect,
    });
    assert.equal(ok.isError, false, ok.error?.message ?? "resolve_plan_critique failed");
    assert.deepEqual(ok.lifecycle, {
      type: "architect_action",
      action: "plan_critique_resolved",
      referenceId: "critique-1",
    });
    const projection = rebuildSchedulerProjection(store.readRun(runId));
    assert.equal(projection.planCritique?.current?.status, "resolved");
    assert.equal(projection.lastArchitectActionEvent?.type, "plan_critique.resolved");
    const resolved = store.readRun(runId).find((event) => event.type === "plan_critique.resolved");
    assert.equal(resolved?.actor.role, "architect");
    assert.equal(resolved?.payload.critiqueId, "critique-1");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("plan_tasks description requires a riskDeclaration", () => {
  const store = new SqliteSchedulerStore(":memory:");
  try {
    const planTasks = createArchitectTools({ store, clock: () => "2026-09-02T00:00:00.000Z" })
      .find((tool) => tool.definition.name === "plan_tasks");
    assert.ok(planTasks);
    assert.match(planTasks.definition.description, /declare riskDeclaration low or high with a rationale/);
  } finally {
    store.close();
  }
});

function seedSubmittedCritique(store: SqliteSchedulerStore, runId: string): void {
  const at = "2026-09-02T00:00:00.000Z";
  const runner = { role: "runner" as const, id: "test" };
  const architect = { role: "architect" as const, id: "architect-test" };
  const tasks = ["A", "B"].map((id) => ({
    id,
    objective: `Do ${id}`,
    dependencies: [],
    status: "planned" as const,
    requiredCapabilities: ["code"],
    attempt: 0,
    acceptanceCriteria: [{ id: "AC-1", text: `${id} works.` }],
    acceptanceCriteriaVersion: 1,
  }));
  store.append({
    runId, type: "run.initialized", occurredAt: at, actor: runner,
    idempotencyKey: "init", payload: { objective: "Build the requested application." },
  });
  store.append({
    runId, type: "plan.created", occurredAt: at, actor: architect,
    idempotencyKey: "plan:1",
    payload: { revision: 1, tasks, riskDeclaration: { risk: "low", rationale: "routine" } },
  });
  store.append({
    runId, type: "plan_critique.policy_configured", occurredAt: at, actor: runner,
    idempotencyKey: "critique-policy:always", payload: { mode: "always" },
  });
  const projection = rebuildSchedulerProjection(store.readRun(runId));
  store.append({
    runId, type: "plan_critique.risk_assessed", occurredAt: at, actor: runner,
    idempotencyKey: "critique-risk",
    payload: {
      planRevision: 1,
      architectDeclaration: "low",
      stricterQualification: false,
      assessment: assessPlanRisk({
        architectDeclaration: "low",
        stricterQualification: false,
        tasks: Object.values(projection.tasks),
      }),
    },
  });
  store.append({
    runId, type: "plan_critique.requested", occurredAt: at, actor: runner,
    idempotencyKey: "critique:critique-1",
    payload: {
      critiqueId: "critique-1",
      planRevision: 1,
      runtime: {
        runtimeId: "google:verifier",
        providerId: "google",
        modelId: "verifier",
        modelIdentity: "verifier",
        sessionId: "plan-critic:s1",
      },
      excludedModels: [{ source: "architect", runtimeId: "openai:architect", modelIdentity: "architect" }],
    },
  });
  store.append({
    runId, type: "plan_critique.submitted", occurredAt: at,
    actor: { role: "verifier", id: "google:verifier" },
    idempotencyKey: "critique:critique-1:submitted",
    payload: {
      critiqueId: "critique-1",
      planRevision: 1,
      sessionId: "plan-critic:s1",
      findings: [{
        findingId: "F-1",
        severity: "blocking",
        category: "overlapping_scope",
        taskIds: ["A", "B"],
        claim: "A and B both own src/cache.ts.",
        evidence: ["A objective mentions src/cache.ts", "B objective mentions src/cache.ts"],
      }],
    },
  });
}

const LAZY_COMMAND_REVISION = "a".repeat(40);

test("an Architect turn with no command creates no disposable copy", async () => {
  const seen = { creates: 0, cleanups: 0 };
  await driveArchitectCommandTurn({
    label: "lazy-none",
    turns: [{ blocks: [], stopReason: "cancelled" }],
    workspace: countingWorkspace(seen, async () => ({ path: "unused-copy" })),
    assertTurn: (model) => {
      assert.equal(
        model.requests[0]?.tools.some((tool) => tool.name === "run_evidence_command"),
        true,
      );
      assert.equal(seen.creates, 0);
      assert.equal(seen.cleanups, 0);
    },
  });
});

test("an Architect turn with two commands creates one disposable copy and cleans it once", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-architect-lazy-two-"));
  const copy = join(root, "copy");
  const seen = { creates: 0, cleanups: 0 };
  const directories: string[] = [];
  const execution = recordingExecutor(directories);
  try {
    await driveArchitectCommandTurn({
      label: "lazy-two",
      root,
      turns: [{
        blocks: [architectCommandCall("cmd-1"), architectCommandCall("cmd-2")],
        stopReason: "tool_calls",
      }, {
        blocks: [],
        stopReason: "cancelled",
      }],
      permissionProfile: "full",
      execution,
      workspace: countingWorkspace(seen, async (revision) => {
        assert.equal(revision, LAZY_COMMAND_REVISION);
        mkdirSync(copy);
        return { path: copy };
      }),
      assertTurn: (model) => {
        assert.equal(seen.creates, 1);
        assert.equal(seen.cleanups, 1);
        assert.equal(directories.length, 2);
        assert.equal(realpathSync(directories[0]!), realpathSync(copy));
        assert.equal(realpathSync(directories[1]!), realpathSync(copy));
        assert.equal(existsSync(join(copy, "cmd-1.txt")), true);
        assert.equal(existsSync(join(copy, "cmd-2.txt")), true);
        assert.equal(existsSync(join(root, "project", "cmd-1.txt")), false);
        assert.equal(existsSync(join(root, "project", "cmd-2.txt")), false);
        const results = toolResults(model, 1);
        assert.equal(results.length, 2);
        for (const result of results) assert.equal(result.isError, false, JSON.stringify(result));
      },
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed Architect command copy is returned to the Architect and is not the project", async () => {
  const seen = { creates: 0, cleanups: 0 };
  const directories: string[] = [];
  await driveArchitectCommandTurn({
    label: "lazy-fail",
    turns: [{
      blocks: [architectCommandCall("cmd-1"), architectCommandCall("cmd-2")],
      stopReason: "tool_calls",
    }, {
      blocks: [],
      stopReason: "cancelled",
    }],
    permissionProfile: "full",
    execution: recordingExecutor(directories),
    workspace: countingWorkspace(seen, async () => {
      throw new Error("worktree failed");
    }),
    assertTurn: (model) => {
      assert.equal(seen.creates, 1);
      assert.equal(seen.cleanups, 0);
      assert.deepEqual(directories, []);
      const results = toolResults(model, 1);
      assert.equal(results.length, 2);
      for (const result of results) {
        assert.equal(result.isError, true, JSON.stringify(result));
        assert.equal(result.error?.code, "command_workspace_unavailable");
        assert.match(result.error?.message ?? "", /worktree failed/);
      }
    },
  });
});

const WORKER_TASK_REVISION = "b".repeat(40);

test("review_required commands see the worker change and other turns see the integration revision", async () => {
  const reviewRoot = mkdtempSync(join(tmpdir(), "aiboard-architect-review-copy-"));
  const otherRoot = mkdtempSync(join(tmpdir(), "aiboard-architect-integration-copy-"));
  const seen: string[] = [];
  const revisions: string[] = [];
  const workspaceFor = (root: string): ArchitectCommandWorkspaceProvider => ({
    workspaceKind: "independent-verifier",
    create: async (revision) => {
      revisions.push(revision);
      const copy = join(root, "copy");
      mkdirSync(copy, { recursive: true });
      writeFileSync(
        join(copy, "marker.txt"),
        revision === WORKER_TASK_REVISION ? "worker-change" : "integration-tree",
      );
      return { path: copy };
    },
    cleanup: async () => undefined,
  });
  const execution = markerExecutor(seen);
  try {
    await driveArchitectCommandTurn({
      label: "review-copy",
      root: reviewRoot,
      turns: [{
        blocks: [architectCommandCall("review-cmd")],
        stopReason: "tool_calls",
      }, {
        blocks: [],
        stopReason: "cancelled",
      }],
      permissionProfile: "full",
      execution,
      review: { changeSetId: "worker-change", taskRevision: WORKER_TASK_REVISION },
      workspace: workspaceFor(reviewRoot),
      assertTurn: (model) => {
        assert.deepEqual(revisions, [WORKER_TASK_REVISION]);
        assert.deepEqual(seen, ["worker-change"]);
        const system = model.requests[0]?.messages.find((message) => message.role === "system");
        assert.match(String(system?.content), /submission's taskRevision/);
        assert.match(String(system?.content), /integration revision/);
        assert.match(String(system?.content), /End each action with exactly one decision tool/);
        assert.match(String(system?.content), /write_project_doc does not end the action/);
        assert.doesNotMatch(String(system?.content), /one native lifecycle tool/);
        assert.doesNotMatch(String(system?.content), /exactly one semantically appropriate lifecycle tool/);
        const results = toolResults(model, 1);
        assert.equal(results.length, 1);
        assert.equal(results[0]?.isError, false, JSON.stringify(results[0]));
      },
    });
    revisions.length = 0;
    seen.length = 0;
    await driveArchitectCommandTurn({
      label: "integration-copy",
      root: otherRoot,
      turns: [{
        blocks: [architectCommandCall("other-cmd")],
        stopReason: "tool_calls",
      }, {
        blocks: [],
        stopReason: "cancelled",
      }],
      permissionProfile: "full",
      execution,
      workspace: workspaceFor(otherRoot),
      assertTurn: () => {
        assert.deepEqual(revisions, [LAZY_COMMAND_REVISION]);
        assert.deepEqual(seen, ["integration-tree"]);
      },
    });
  } finally {
    rmSync(reviewRoot, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

test("a review command checkout failure is returned and does not fall back to integration", async () => {
  const revisions: string[] = [];
  await driveArchitectCommandTurn({
    label: "review-checkout-fail",
    turns: [{
      blocks: [architectCommandCall("review-fail")],
      stopReason: "tool_calls",
    }, {
      blocks: [],
      stopReason: "cancelled",
    }],
    permissionProfile: "full",
    execution: markerExecutor([]),
    review: { changeSetId: "worker-change", taskRevision: WORKER_TASK_REVISION },
    workspace: {
      workspaceKind: "independent-verifier",
      create: async (revision) => {
        revisions.push(revision);
        throw new Error("task revision unavailable");
      },
      cleanup: async () => undefined,
    },
    assertTurn: (model) => {
      assert.deepEqual(revisions, [WORKER_TASK_REVISION]);
      const results = toolResults(model, 1);
      assert.equal(results.length, 1);
      assert.equal(results[0]?.isError, true);
      assert.equal(results[0]?.error?.code, "command_workspace_unavailable");
      assert.match(results[0]?.error?.message ?? "", /task revision unavailable/);
    },
  });
});

function markerExecutor(seen: string[]): OneShotCommandExecutor {
  return {
    async execute(request) {
      seen.push(readFileSync(join(request.workingDirectory, "marker.txt"), "utf8"));
      return {
        process: {
          logicalProcessId: request.context.callId,
          outcome: "exited",
          exitCode: 0,
          finishedAt: "2026-09-23T00:00:00.000Z",
          output: [
            { stream: "stdout", tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 },
            { stream: "stderr", tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 },
          ],
          cleanup: { state: "not_required" },
        },
        enforcement: "unconfined_explicit_full",
        disclosure: "unconfined_explicit_full",
      };
    },
  };
}

function architectCommandCall(callId: string): ModelTurn["blocks"][number] {
  return {
    type: "tool_call",
    callId,
    name: "run_evidence_command",
    arguments: {
      label: callId,
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: ".",
    },
  };
}

test("the next Architect context contains the committed STATE.md text and stateCurrent", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-architect-committed-state-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
  const sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
  const evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
  const memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
  const runId = "run-committed-state";
  const objective = "Build the feature.";
  const stateText = "PF1_COMMITTED_STATE_MARKER\nWhere things stand.\n";
  try {
    const record = await artifacts.put(Buffer.from(stateText), "text/markdown", "docs/project/STATE.md");
    scheduler.append({
      runId,
      type: "run.initialized",
      occurredAt: "2026-09-23T00:00:00.000Z",
      actor: { role: "runner", id: "test" },
      idempotencyKey: "init",
      payload: { objective },
    });
    scheduler.append({
      runId,
      type: "project_doc.requested",
      occurredAt: "2026-09-23T00:00:01.000Z",
      actor: { role: "architect", id: "architect" },
      idempotencyKey: "state-request",
      payload: {
        requestId: "state-request",
        path: "docs/project/STATE.md",
        contentArtifactHash: record.hash,
        contentBytes: Buffer.byteLength(stateText),
        summary: "Record the current state",
      },
    });
    scheduler.append({
      runId,
      type: "project_doc.committed",
      occurredAt: "2026-09-23T00:00:02.000Z",
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "state-commit",
      payload: {
        requestId: "state-request",
        path: "docs/project/STATE.md",
        commit: "c".repeat(40),
        parent: "p".repeat(40),
        head: "c".repeat(40),
        readme: true,
        agentsMarkedSection: true,
        claudePointer: false,
      },
    });
    const candidate: AgentRuntimeCandidate = {
      runtimeId: "test:architect",
      providerId: "test",
      modelId: "architect",
      capabilities: ["code"],
      priority: 1,
    };
    const health = new ProviderHealthRegistry();
    const model = new ScriptedModel([{ blocks: [], stopReason: "cancelled" }]);
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
      projectId: "project-committed-state",
      projectRoot: project,
      objective,
    });
    await architect.run({
      runId,
      reason: { type: "plan_required" },
      projection: rebuildSchedulerProjection(scheduler.readRun(runId)),
      tools: new ToolRegistry(),
      context: {
        runId,
        sessionId: `architect:${runId}`,
        actor: { role: "architect", id: "architect" },
      },
    });
    const context = model.requests[0]?.messages.find((message) => message.role === "user");
    const text = String(context?.content);
    assert.match(text, /PF1_COMMITTED_STATE_MARKER/);
    assert.match(text, /stateCurrent: true/);
    assert.match(text, /entryPoint: readme=true agentsMarkedSection=true claudePointer=false/);
    assert.match(text, /docs\/project\/STATE.md sequence=\d+/);
  } finally {
    sessions.close();
    scheduler.close();
    evidence.close();
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function recordingExecutor(directories: string[]): OneShotCommandExecutor {
  return {
    async execute(request) {
      directories.push(request.workingDirectory);
      writeFileSync(join(request.workingDirectory, `${request.context.callId}.txt`), "ran\n");
      return {
        process: {
          logicalProcessId: request.context.callId,
          outcome: "exited",
          exitCode: 0,
          finishedAt: "2026-09-23T00:00:00.000Z",
          output: [
            { stream: "stdout", tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 },
            { stream: "stderr", tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 },
          ],
          cleanup: { state: "not_required" },
        },
        enforcement: "unconfined_explicit_full",
        disclosure: "unconfined_explicit_full",
      };
    },
  };
}

function countingWorkspace(
  seen: { creates: number; cleanups: number },
  create: ArchitectCommandWorkspaceProvider["create"],
): ArchitectCommandWorkspaceProvider {
  return {
    workspaceKind: "independent-verifier",
    create: async (revision) => {
      seen.creates += 1;
      return await create(revision);
    },
    cleanup: async () => {
      seen.cleanups += 1;
    },
  };
}

function toolResults(model: ScriptedModel, requestIndex: number): ToolResult[] {
  return (model.requests[requestIndex]?.messages ?? []).flatMap((message) =>
    message.role === "tool" && typeof message.content !== "string" && !Array.isArray(message.content)
      ? [message.content]
      : [],
  );
}

async function driveArchitectCommandTurn(input: {
  label: string;
  turns: Array<ModelTurn | Error>;
  workspace: ArchitectCommandWorkspaceProvider;
  assertTurn: (model: ScriptedModel) => void;
  root?: string;
  permissionProfile?: "full";
  execution?: OneShotCommandExecutor;
  review?: { changeSetId: string; taskRevision: string };
}): Promise<void> {
  const root = input.root ?? mkdtempSync(join(tmpdir(), `aiboard-architect-${input.label}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
  const sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
  const evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
  const memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
  const runId = `run-${input.label}`;
  const objective = "Build the feature.";
  const ownsRoot = input.root === undefined;
  try {
    scheduler.append({
      runId,
      type: "run.initialized",
      occurredAt: "2026-09-23T00:00:00.000Z",
      actor: { role: "runner", id: "test" },
      idempotencyKey: "init",
      payload: { objective },
    });
    scheduler.append({
      runId,
      type: "plan.created",
      occurredAt: "2026-09-23T00:00:01.000Z",
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
      runId,
      type: "user.guidance_submitted",
      occurredAt: "2026-09-23T00:00:02.000Z",
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "guidance",
      payload: {
        guidanceId: "guidance-1",
        text: "Keep the public API stable.",
        version: 1,
        interruptionProtocolVersion: 1,
      },
    });
    scheduler.append({
      runId,
      type: "integration.revision_advanced",
      occurredAt: "2026-09-23T00:00:03.000Z",
      actor: { role: "runner", id: "test" },
      idempotencyKey: "integration",
      payload: { integrationRevision: LAZY_COMMAND_REVISION },
    });
    const candidate: AgentRuntimeCandidate = {
      runtimeId: "test:architect",
      providerId: "test",
      modelId: "architect",
      capabilities: ["code"],
      priority: 1,
    };
    const health = new ProviderHealthRegistry();
    const model = new ScriptedModel(input.turns);
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
      projectId: `project-${input.label}`,
      projectRoot: project,
      objective,
      commandWorkspace: input.workspace,
      ...(input.permissionProfile ? { permissionProfile: input.permissionProfile } : {}),
      ...(input.execution
        ? { execution: input.execution, git: fixtureGitContext(input.permissionProfile ?? "full", input.execution) }
        : {}),
    });
    if (input.review) {
      const sessionId = `worker:${runId}:task-a:0`;
      await sessions.create({
        sessionId,
        runId,
        actor: { role: "worker", id: "worker_task-a_0" },
        occurredAt: "2026-09-23T00:00:04.000Z",
      });
      await sessions.submit(sessionId, {
        id: input.review.changeSetId,
        runId,
        taskId: "task-a",
        baselineRevision: "c".repeat(40),
        taskRevision: input.review.taskRevision,
        commits: [],
        changedPaths: ["worker-change.txt"],
        diffArtifactHash: "d".repeat(64),
        evidenceArtifactHashes: [],
        externalEffects: [],
        guidanceIds: [],
        memoryIds: [],
        unresolvedConcerns: [],
      }, "2026-09-23T00:00:05.000Z");
    }
    await architect.run({
      runId,
      reason: input.review
        ? { type: "review_required", taskId: "task-a", changeSetId: input.review.changeSetId }
        : { type: "user_guidance_required", guidanceId: "guidance-1", version: 1 },
      projection: rebuildSchedulerProjection(scheduler.readRun(runId)),
      tools: new ToolRegistry(),
      context: {
        runId,
        sessionId: `architect:${runId}`,
        actor: { role: "architect", id: "architect" },
      },
    });
    input.assertTurn(model);
  } finally {
    sessions.close();
    scheduler.close();
    evidence.close();
    memory.close();
    if (ownsRoot) rmSync(root, { recursive: true, force: true });
  }
}

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
