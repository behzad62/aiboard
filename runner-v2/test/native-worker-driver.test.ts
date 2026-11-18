import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { ProviderTransportError } from "../src/account-runner-model.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { CapabilityRegistry } from "../src/capability-registry.js";
import { topDefectClasses } from "../src/defect-history.js";
import { captureGitBaseline } from "./support/git-fixture.js";
import { buildWorkerSystemPrompt, recoverableWorkerSuspension, workerContinuationMessages, shouldFailoverWorkerFailure, shouldAutoContinueWorker, workerModelAttribution, guidanceOutcomeFromProjection } from "../src/native-worker-driver.js";
import { NativeWorkerDriver } from "./support/git-fixture.js";
import { rankSkillsForTask } from "../src/skill-routing.js";
import type { SkillMetadata } from "../src/skill-catalog.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import { RuntimeRouter, type AgentRuntimeCandidate } from "../src/runtime-router.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteContextManifestStore } from "../src/sqlite-context-manifest-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteProjectMemoryStore } from "../src/sqlite-project-memory.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import type { WorkerAssignment } from "../src/task-scheduler.js";
import type { ManagedProcessService } from "../src/managed-process.js";
import type { LanguageIntelligenceProvider } from "../src/language-intelligence.js";
import { WorkspaceManager } from "./support/git-fixture.js";
import {
  resolveWorkerSessionId,
  standardWorkerId,
  steeringReassignedWorkerId,
  workerSessionId,
} from "../src/worker-identity.js";
import { createTestOneShotCommandExecutor } from "./support/one-shot-command-executor.js";
import { emptyProjectionForTest } from "./support/projection-fixtures.js";
import { captureWorkingTreeIdentity } from "../src/command-evidence-identity.js";
import { CliWorkerOwners, type CliWorkerRuntimeDeps } from "../src/cli-worker-runtime.js";
import { runGit } from "./support/git-fixture.js";
import { FAKE_CLI_SCRIPT, cliFixture, writeFakeCliScenario, type FakeCliScenario } from "./support/fake-cli.js";
import { ChildCliLauncher, cliDoneResult, writeClaudeStream } from "./support/cli-worker-fixture.js";

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

test("worker system prompt keeps docs/project architect-only", () => {
  const prompt = buildWorkerSystemPrompt(["criterion_a"]);
  assert.match(prompt, /`docs\/project\/\*\*` is maintained only by the Architect/);
  assert.match(prompt, /Do not edit it; a change there makes your submission fail integration/);
  assert.match(prompt, /Put decisions or state worth recording in your submit_task summary/);
  assert.match(prompt, /criterion_a/);
  assert.doesNotMatch(prompt, /Keep specs, plans and decisions current/);
  assert.doesNotMatch(prompt, /update `STATE\.md`/);
  assert.equal(buildWorkerSystemPrompt().includes("criterionEvidenceLinks"), false);
});

test("worker model calls carry direct durable role and task attribution", () => {
  assert.deepEqual(
    workerModelAttribution({
      runtimeId: "api:worker",
      providerId: "api",
      modelId: "worker-model",
      capabilities: ["code"],
      priority: 1,
    }, "worker:run_1:task_1:1", "task_1", "worker"),
    {
      runtimeId: "api:worker",
      providerId: "api",
      modelId: "worker-model",
      role: "worker",
      sessionId: "worker:run_1:task_1:1",
      taskId: "task_1",
    }
  );
});

test("steering reassignment gets a distinct session while ordinary and recovered sessions stay compatible", () => {
  const ordinaryWorker = standardWorkerId("task_1", 2);
  const revisedWorker = steeringReassignedWorkerId("task_1", 2, 4);
  const ordinarySession = workerSessionId("run_1", "task_1", 2, ordinaryWorker);
  const revisedSession = workerSessionId("run_1", "task_1", 2, revisedWorker);
  assert.equal(ordinarySession, "worker:run_1:task_1:2");
  assert.notEqual(revisedSession, ordinarySession);
  assert.match(revisedSession, /worker_task_1_2_plan_4$/);
  assert.equal(
    resolveWorkerSessionId("run_1", "task_1", 2, revisedWorker, revisedSession),
    revisedSession
  );
  assert.equal(
    resolveWorkerSessionId("run_1", "task_1", 2, ordinaryWorker, "legacy:persisted:session"),
    "legacy:persisted:session"
  );
});

test("invalid worker requests fail once instead of cycling through runtimes", () => {
  assert.equal(
    shouldFailoverWorkerFailure({
      kind: "invalid_request",
      message: "Invalid tool schema.",
    }),
    false
  );
  assert.equal(
    shouldFailoverWorkerFailure({
      kind: "provider_unavailable",
      message: "Provider unavailable.",
    }),
    true
  );
});

test("worker lifecycle no-ops preserve the attempt and receive a fresh resume reminder", () => {
  assert.equal(shouldAutoContinueWorker("model_ended_without_lifecycle", 0, true), true);
  assert.equal(shouldAutoContinueWorker("model_ended_without_lifecycle", 4, true), true);
  assert.equal(shouldAutoContinueWorker("model_ended_without_lifecycle", 5, true), false);
  assert.equal(shouldAutoContinueWorker("model_ended_without_lifecycle", 0, false), true);
  assert.equal(shouldAutoContinueWorker("model_ended_without_lifecycle", 1, false), false);
  assert.equal(shouldAutoContinueWorker("budget_exhausted", 0, true), false);
  assert.deepEqual(
    recoverableWorkerSuspension("model_ended_without_lifecycle", ""),
    { type: "paused", reason: "worker_model_ended_without_lifecycle" }
  );
  assert.deepEqual(
    recoverableWorkerSuspension("budget_exhausted", "maxToolCalls reached"),
    { type: "paused", reason: "budget_exhausted:maxToolCalls reached" }
  );
  assert.deepEqual(
    recoverableWorkerSuspension("cancelled", "Build paused."),
    { type: "paused", reason: "worker_cancelled" }
  );
  assert.equal(recoverableWorkerSuspension("checkpoint_error", "write failed"), undefined);

  const first = workerContinuationMessages(
    { id: "context:abc", role: "user", content: "Task context" },
    false,
    "task_a",
    0
  );
  assert.equal(first.length, 1);

  const resumed = workerContinuationMessages(
    { id: "context:abc", role: "user", content: "Task context" },
    true,
    "task_a",
    4
  );
  assert.equal(resumed.length, 2);
  assert.match(String(resumed[1].content), /same durable task attempt/i);
  assert.match(String(resumed[1].content), /submit_task/);
  assert.match(String(resumed[1].content), /ask_architect/);
  assert.match(String(resumed[1].content), /request_replan/);
  assert.doesNotMatch(String(resumed[1].content), /request_guidance/);
});

test("guidanceOutcomeFromProjection maps an open replan request to a blocking guidance outcome", () => {
  const outcome = guidanceOutcomeFromProjection({
    ...emptyProjectionForTest("run_replan"),
    guidance: {
      "replan-1": {
        requestId: "replan-1", taskId: "T1", blocking: true, question: "Replan requested.",
        evidenceSequence: 3, version: 1, status: "open", kind: "replan",
        replan: { reason: "scope_exceeded", summary: "s", proposedChange: "p" },
      },
    },
  }, "replan-1");
  assert.deepEqual(outcome, {
    type: "guidance", requestId: "replan-1", blocking: true, question: "Replan requested.", evidenceSequence: 3,
  });
  assert.deepEqual(guidanceOutcomeFromProjection(emptyProjectionForTest("run_replan"), "missing"), {
    type: "failed", reason: "missing_guidance:missing",
  });
});

test("native worker maps a replan_requested loop result to a blocking guidance outcome", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-native-worker-replan-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "value.txt"), "one\n");
  let sessions: SqliteAgentSessionStore | undefined;
  let ledger: SqliteToolLedger | undefined;
  let scheduler: SqliteSchedulerStore | undefined;
  let evidence: SqliteEvidenceStore | undefined;
  let memory: SqliteProjectMemoryStore | undefined;
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_1",
    });
    const workspaces = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_1",
      baselineRevision: baseline.revision,
    });
    const workspace = await workspaces.createTaskWorkspace("task_a");
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
    ledger = new SqliteToolLedger(join(state, "tools.sqlite"));
    scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
    evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
    memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
    seedRunningTask(scheduler);
    const candidate: AgentRuntimeCandidate = {
      runtimeId: "primary:code",
      providerId: "primary",
      modelId: "code",
      capabilities: ["code"],
      priority: 1,
    };
    const health = new ProviderHealthRegistry();
    const driver = new NativeWorkerDriver({
      schedulerStore: scheduler,
      router: new RuntimeRouter({ candidates: [candidate], health }),
      health,
      candidates: [candidate],
      models: new Map([[candidate.runtimeId, new ScriptedModel([
        toolTurn("replan", "request_replan", {
          requestId: "replan-1",
          reason: "scope_exceeded",
          summary: "The cache key factory lives outside this task.",
          proposedChange: "Split the task.",
          evidenceSequence: 3,
        }),
      ])]]),
      permissionProfile: "full",
      workspaceManager: workspaces,
      artifacts,
      ledger,
      sessions,
      evidenceStore: evidence,
      skillCatalog: new SkillCatalog({ projectRoot: project }),
      memoryStore: memory,
      projectId: "project_1",
      projectRoot: project,
      execution: createTestOneShotCommandExecutor(t, { artifacts }),
    });
    const outcome = await driver.run({
      runId: "run_1",
      task: rebuildTask(scheduler),
      attempt: 1,
      workerId: "worker_task_a_1",
      workspacePath: workspace.path,
    });
    assert.deepEqual(outcome, {
      type: "guidance",
      requestId: "replan-1",
      blocking: true,
      question:
        "Replan requested (scope_exceeded): The cache key factory lives outside this task.\nProposed change: Split the task.",
      evidenceSequence: 3,
    });
  } finally {
    sessions?.close();
    ledger?.close();
    scheduler?.close();
    evidence?.close();
    memory?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("native worker proves its managed-process stop before an outcome counts, and an unproven stop keeps the outcome for a retried stop", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-native-worker-stop-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "value.txt"), "one\n");
  let sessions: SqliteAgentSessionStore | undefined;
  let ledger: SqliteToolLedger | undefined;
  let scheduler: SqliteSchedulerStore | undefined;
  let evidence: SqliteEvidenceStore | undefined;
  let memory: SqliteProjectMemoryStore | undefined;
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_1",
    });
    const workspaces = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_1",
      baselineRevision: baseline.revision,
    });
    const workspace = await workspaces.createTaskWorkspace("task_a");
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
    ledger = new SqliteToolLedger(join(state, "tools.sqlite"));
    scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
    evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
    memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
    seedRunningTask(scheduler);
    const candidate: AgentRuntimeCandidate = {
      runtimeId: "primary:code",
      providerId: "primary",
      modelId: "code",
      capabilities: ["code"],
      priority: 1,
    };
    const health = new ProviderHealthRegistry();
    const closes: unknown[] = [];
    let workerStopFailures = 2;
    const workerSession = resolveWorkerSessionId("run_1", "task_a", 1, "worker_task_a_1");
    const subagentRecord = { processId: "proc_sub", runId: "run_1", status: "running", sessionId: `${workerSession}:subagent:call_9`, actor: { role: "subagent", id: "worker_task_a_1:call_9" } };
    const otherAttemptRecord = { ...subagentRecord, processId: "proc_other", sessionId: "other-session:subagent:call_9", actor: { role: "subagent", id: "worker_task_b_1:call_9" } };
    const managedProcesses = {
      closeAgent: async (owner: { actor: { role: string } }) => {
        closes.push(owner);
        if (owner.actor.role === "worker" && workerStopFailures-- > 0) {
          throw Object.assign(new Error("Shared managed cleanup did not prove release."), { code: "process_cleanup_unverified" });
        }
      },
      listRun: async () => [subagentRecord, otherAttemptRecord],
    } as unknown as ManagedProcessService;
    const driverOptions = {
      schedulerStore: scheduler,
      router: new RuntimeRouter({ candidates: [candidate], health }),
      health,
      candidates: [candidate],
      models: new Map([[candidate.runtimeId, new ScriptedModel([
        toolTurn("replan", "request_replan", {
          requestId: "replan-1",
          reason: "scope_exceeded",
          summary: "The cache key factory lives outside this task.",
          proposedChange: "Split the task.",
          evidenceSequence: 3,
        }),
      ])]]),
      permissionProfile: "full",
      workspaceManager: workspaces,
      artifacts,
      ledger,
      sessions,
      evidenceStore: evidence,
      skillCatalog: new SkillCatalog({ projectRoot: project }),
      memoryStore: memory,
      projectId: "project_1",
      projectRoot: project,
      execution: createTestOneShotCommandExecutor(t, { artifacts }),
      managedProcesses,
    } satisfies ConstructorParameters<typeof NativeWorkerDriver>[0];
    const driver = new NativeWorkerDriver(driverOptions);
    const assignment = {
      runId: "run_1",
      task: rebuildTask(scheduler),
      attempt: 1,
      workerId: "worker_task_a_1",
      workspacePath: workspace.path,
    };
    const outcome = await driver.run(assignment);
    const owner = {
      runId: "run_1",
      sessionId: resolveWorkerSessionId("run_1", "task_a", 1, "worker_task_a_1"),
      actor: { role: "worker", id: "worker_task_a_1" },
    };
    assert.deepEqual(closes, [owner], "the attempt's own processes are stopped before its outcome counts");
    assert.deepEqual(outcome, {
      type: "stop_unproven",
      reason: "Managed process stop not proven: Shared managed cleanup did not prove release.",
      outcome: {
        type: "guidance",
        requestId: "replan-1",
        blocking: true,
        question:
          "Replan requested (scope_exceeded): The cache key factory lives outside this task.\nProposed change: Split the task.",
        evidenceSequence: 3,
      },
    }, "the outcome it had is kept, not returned, while the stop is unproven");
    const subagent = { runId: "run_1", sessionId: subagentRecord.sessionId, actor: subagentRecord.actor };
    await assert.rejects(driver.retryStop(assignment), (error: unknown) =>
      error instanceof AggregateError && /still not proven/.test(error.message));
    await driver.retryStop(assignment);
    assert.deepEqual(closes, [owner, owner, subagent, owner, subagent],
      "each retry stops the same exact owner again, and this attempt's live subagent processes, never another attempt's");
    // A fresh driver, as after a Runner restart, has nothing retained in memory: its retry still
    // repeats the owner's language-server and managed-process stops.
    const languageCloses: unknown[] = [];
    const language = { closeAgent: async (actual: unknown) => { languageCloses.push(actual); } } as unknown as LanguageIntelligenceProvider;
    await new NativeWorkerDriver({ ...driverOptions, language }).retryStop(assignment);
    assert.deepEqual(languageCloses, [owner]);
    assert.deepEqual(closes.slice(5), [owner, subagent]);
  } finally {
    sessions?.close();
    ledger?.close();
    scheduler?.close();
    evidence?.close();
    memory?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("worker requests resolve defect classes per turn from the live store", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-native-worker-defects-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "value.txt"), "one\n");
  let sessions: SqliteAgentSessionStore | undefined;
  let ledger: SqliteToolLedger | undefined;
  let scheduler: SqliteSchedulerStore | undefined;
  let evidence: SqliteEvidenceStore | undefined;
  let memory: SqliteProjectMemoryStore | undefined;
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_1",
    });
    const workspaces = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_1",
      baselineRevision: baseline.revision,
    });
    const workspace = await workspaces.createTaskWorkspace("task_a");
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
    ledger = new SqliteToolLedger(join(state, "tools.sqlite"));
    scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
    evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
    memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
    seedRunningTask(scheduler);
    const candidate: AgentRuntimeCandidate = {
      runtimeId: "primary:code",
      providerId: "primary",
      modelId: "code",
      capabilities: ["code"],
      priority: 1,
    };
    const health = new ProviderHealthRegistry();
    const model = new ScriptedModel([
      toolTurn("replan", "request_replan", {
        requestId: "replan-1",
        reason: "scope_exceeded",
        summary: "The cache key factory lives outside this task.",
        proposedChange: "Split the task.",
        evidenceSequence: 3,
      }),
    ]);
    const driver = new NativeWorkerDriver({
      schedulerStore: scheduler,
      router: new RuntimeRouter({ candidates: [candidate], health }),
      health,
      candidates: [candidate],
      models: new Map([[candidate.runtimeId, model]]),
      permissionProfile: "full",
      workspaceManager: workspaces,
      artifacts,
      ledger,
      sessions,
      evidenceStore: evidence,
      skillCatalog: new SkillCatalog({ projectRoot: project }),
      memoryStore: memory,
      projectId: "project_1",
      projectRoot: project,
      execution: createTestOneShotCommandExecutor(t, { artifacts }),
      defectClassesFor: () => topDefectClasses(memory!.defectClasses("project_1")),
    });
    // Recorded after the driver exists: a construction-time snapshot would miss it.
    memory.recordDefectFinding({ projectId: "project_1", label: "guard never exercised", taskId: "task_a", reviewId: "r1", findingId: "f1", recordedAt: "2026-07-12T00:00:01.000Z" });
    const outcome = await driver.run({
      runId: "run_1",
      task: rebuildTask(scheduler),
      attempt: 1,
      workerId: "worker_task_a_1",
      workspacePath: workspace.path,
    });
    assert.equal(outcome.type, "guidance");
    assert.equal(model.requests.length, 1);
    assert.match(JSON.stringify(model.requests[0]), /guard never exercised/);
  } finally {
    sessions?.close();
    ledger?.close();
    scheduler?.close();
    evidence?.close();
    memory?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("native worker fails over with the same session, context, tools, and evidence", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-native-worker-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "AGENTS.md"), "Run focused tests first.\n");
  writeFileSync(join(project, "value.txt"), "one\n");
  const skillDir = join(project, ".aiboard", "skills", "testing");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "# Testing\nUse focused testing evidence.\n");
  let sessions: SqliteAgentSessionStore | undefined;
  let ledger: SqliteToolLedger | undefined;
  let scheduler: SqliteSchedulerStore | undefined;
  let evidence: SqliteEvidenceStore | undefined;
  let memory: SqliteProjectMemoryStore | undefined;
  try {
    const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: "run_1" });
    const workspaces = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_1",
      baselineRevision: baseline.revision,
    });
    const workspace = await workspaces.createTaskWorkspace("task_a");
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
    ledger = new SqliteToolLedger(join(state, "tools.sqlite"));
    scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
    evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
    memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
    const proposed = memory.propose({
      projectId: "project_1",
      runId: "old_run",
      actor: { role: "worker", id: "old_worker" },
      content: "The value fixture uses newline-terminated text.",
      concepts: ["testing"],
      occurredAt: "2026-07-01T00:00:00.000Z",
      idempotencyKey: "memory:1",
    });
    memory.promote({
      projectId: "project_1",
      memoryId: proposed.id,
      actor: { role: "architect", id: "architect_1" },
      occurredAt: "2026-07-01T00:00:01.000Z",
      idempotencyKey: "promote:1",
    });
    seedRunningTask(scheduler);

    const expectedHash = createHash("sha256")
      .update(readFileSync(join(workspace.path, "value.txt")))
      .digest("hex");
    const fallback = new ScriptedModel([
      toolTurn("patch", "fs.patch", {
        path: "value.txt",
        expectedSha256: expectedHash,
        search: "one",
        replace: "two",
      }),
      toolTurn("evidence", "run_evidence_command", {
        label: "value check",
        command: process.execPath,
        args: ["-e", "const fs=require('node:fs');process.exit(fs.readFileSync('value.txt','utf8').trim()==='two'?0:1)"],
        cwd: ".",
      }),
      toolTurn("submit", "submit_task", {
        summary: "Change value to two",
        readiness: "ready_for_architect_review",
        criterionEvidenceLinks: [{
          criterionId: "value",
          evidenceId: expectedEvidenceId("run_1", "task_a", "worker:run_1:task_a:1", "evidence"),
          artifactHashes: [emptyArtifactHash()],
        }],
      }),
    ]);
    const candidates: AgentRuntimeCandidate[] = [
      { runtimeId: "primary:code", providerId: "primary", modelId: "code", capabilities: ["code"], priority: 1 },
      { runtimeId: "fallback:code", providerId: "fallback", modelId: "code", capabilities: ["code"], priority: 2 },
    ];
    const capabilityRegistry = new CapabilityRegistry([{
      manifest: {
        apiVersion: 1,
        id: "fixture.native-worker-context",
        name: "Native Worker Context Fixture",
        version: "1.0.0",
        entry: "index.mjs",
        capabilities: ["context"],
      },
      instance: {
        capabilities: () => ({
          tools: [],
          contextContributors: [{
            id: "native-worker-context",
            kind: "fixture",
            priority: 850,
            maxBytes: 1_024,
            contribute: async () => ({ content: "EXTENSION_NATIVE_WORKER_CONTEXT" }),
          }],
          languageProviders: [],
        }),
        start: async () => undefined,
        close: async () => undefined,
      },
    }]);
    const health = new ProviderHealthRegistry();
    const driver = new NativeWorkerDriver({
      schedulerStore: scheduler,
      router: new RuntimeRouter({ candidates, health }),
      health,
      candidates,
      models: new Map([
        ["primary:code", new ScriptedModel(
          Array.from(
            { length: 6 },
            () => new ProviderTransportError("provider down secret-token", 503)
          )
        )],
        ["fallback:code", fallback],
      ]),
      permissionProfile: "full",
      workspaceManager: workspaces,
      artifacts,
      ledger,
      sessions,
      evidenceStore: evidence,
      skillCatalog: new SkillCatalog({ projectRoot: project }),
      memoryStore: memory,
      projectId: "project_1",
      projectRoot: project,
      capabilityRegistry,
      execution: createTestOneShotCommandExecutor(t, { artifacts }),
      providerRetryRuntime: {
        now: () => 0,
        random: () => 0.5,
        sleep: async () => undefined,
      },
    });
    const assignment: WorkerAssignment = {
      runId: "run_1",
      task: rebuildTask(scheduler),
      attempt: 1,
      workerId: "worker_task_a_1",
      workspacePath: workspace.path,
    };
    const outcome = await driver.run(assignment);
    assert.equal(outcome.type, "submitted");
    assert.equal(readFileSync(join(workspace.path, "value.txt"), "utf8").trim(), "two");
    const projection = (await import("../src/scheduler-store.js")).rebuildSchedulerProjection(
      scheduler.readRun("run_1")
    );
    assert.equal(projection.runtime.workerAssignments["task_a:1"].runtimeId, "fallback:code");
    const retryEvents = scheduler.readRun("run_1").filter(
      (event) => event.type === "provider.retry_scheduled"
    );
    assert.equal(retryEvents.length, 5);
    assert.deepEqual(retryEvents.map((event) => event.payload.retry), [1, 2, 3, 4, 5]);
    retryEvents.forEach((event, index) => {
      const base = [2_000, 5_000, 15_000, 30_000, 60_000][index];
      assert.ok(
        Number(event.payload.delayMs) >= base * 0.8 &&
          Number(event.payload.delayMs) <= base * 1.2
      );
    });
    assert.ok(retryEvents.every(
      (event) => !String(event.payload.reason).includes("secret-token")
    ));
    assert.equal(fallback.requests[0].sessionId, "worker:run_1:task_a:1");
    const contextText = fallback.requests[0].messages.map((message) =>
      typeof message.content === "string" ? message.content : ""
    ).join("\n");
    assert.match(contextText, /`docs\/project\/\*\*` is maintained only by the Architect/);
    assert.match(contextText, /Do not edit it; a change there makes your submission fail integration/);
    assert.match(contextText, /Put decisions or state worth recording in your submit_task summary/);
    assert.doesNotMatch(contextText, /Keep specs, plans and decisions current/);
    assert.match(contextText, /Batch independent read-only tool calls/i);
    assert.match(contextText, /Keep command output narrow/i);
    assert.match(contextText, /Before every submit_task/i);
    assert.match(
      contextText,
      /do not submit while your own fresh evidence still shows a known acceptance failure/i
    );
    assert.match(contextText, /Run focused tests first/);
    assert.match(contextText, /focused testing evidence/);
    assert.match(contextText, /newline-terminated text/);
    assert.match(contextText, /EXTENSION_NATIVE_WORKER_CONTEXT/);
    assert.equal(evidence.list({ runId: "run_1", taskId: "task_a" }).length, 1);
  } finally {
    sessions?.close();
    ledger?.close();
    scheduler?.close();
    evidence?.close();
    memory?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("native worker cancellation interrupts an admitted provider retry sleep", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-native-worker-cancel-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "value.txt"), "one\n");
  let sessions: SqliteAgentSessionStore | undefined;
  let ledger: SqliteToolLedger | undefined;
  let scheduler: SqliteSchedulerStore | undefined;
  let evidence: SqliteEvidenceStore | undefined;
  let memory: SqliteProjectMemoryStore | undefined;
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_1",
    });
    const workspaces = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_1",
      baselineRevision: baseline.revision,
    });
    const workspace = await workspaces.createTaskWorkspace("task_a");
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
    ledger = new SqliteToolLedger(join(state, "tools.sqlite"));
    scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
    evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
    memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
    seedRunningTask(scheduler);
    const candidate: AgentRuntimeCandidate = {
      runtimeId: "primary:code",
      providerId: "primary",
      modelId: "code",
      capabilities: ["code"],
      priority: 1,
    };
    const model = new ScriptedModel([
      new ProviderTransportError("temporary outage", 503),
    ]);
    const health = new ProviderHealthRegistry();
    let sleepSignal: AbortSignal | undefined;
    let sleepStarted!: () => void;
    const sleeping = new Promise<void>((resolve) => {
      sleepStarted = resolve;
    });
    const driver = new NativeWorkerDriver({
      schedulerStore: scheduler,
      router: new RuntimeRouter({
        candidates: [candidate],
        health,
      }),
      health,
      candidates: [candidate],
      models: new Map([[candidate.runtimeId, model]]),
      permissionProfile: "full",
      workspaceManager: workspaces,
      artifacts,
      ledger,
      sessions,
      evidenceStore: evidence,
      skillCatalog: new SkillCatalog({ projectRoot: project }),
      memoryStore: memory,
      projectId: "project_1",
      projectRoot: project,
      providerRetryRuntime: {
        now: () => 0,
        random: () => 0.5,
        sleep: async (_ms, signal) => {
          sleepSignal = signal;
          sleepStarted();
          await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener(
              "abort",
              () => reject(signal.reason),
              { once: true }
            );
          });
        },
      },
    });
    const controller = new AbortController();
    const outcomePromise = driver.run({
      runId: "run_1",
      task: rebuildTask(scheduler),
      attempt: 1,
      workerId: "worker_task_a_1",
      workspacePath: workspace.path,
      signal: controller.signal,
      providerRetryDeadlineMs: 60_000,
    });
    await sleeping;
    assert.equal(sleepSignal, controller.signal);
    controller.abort(new DOMException("Build paused.", "AbortError"));
    const outcome = await outcomePromise;
    assert.deepEqual(outcome, { type: "paused", reason: "worker_cancelled" });
    assert.equal(model.requests.length, 1);
    assert.equal(scheduler.readRun("run_1").filter(
      (event) => event.type === "provider.retry_scheduled"
    ).length, 1);
  } finally {
    sessions?.close();
    ledger?.close();
    scheduler?.close();
    evidence?.close();
    memory?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("worker skill routing prefers required capability skills over generic description overlap", () => {
  const skill = (
    id: string,
    name: string,
    description: string,
    source: SkillMetadata["source"] = "user"
  ): SkillMetadata => ({
    id,
    name,
    description,
    relativePath: `${id}/SKILL.md`,
    digest: id.padEnd(64, "0").slice(0, 64),
    byteLength: 100,
    source,
  });
  const metadata = [
    skill("user:imagegen", "imagegen", "Create project visuals and image assets"),
    skill("user:openai-docs", "openai-docs", "Current guidance for models and projects"),
    skill("user:plugin-creator", "plugin-creator", "Create project plugins and files"),
    skill("built-in:systematic-debugging", "systematic-debugging", "Debug methodically", "built-in"),
    skill("built-in:verification", "verification", "Gather focused verification evidence", "built-in"),
  ];
  const selected = rankSkillsForTask(
    metadata,
    "Polish the visual style and verify visible projectile tracers in the project",
    ["systematic-debugging", "verification"],
    3
  );
  assert.deepEqual(
    selected.map((item) => item.name),
    ["systematic-debugging", "verification"]
  );
  const aliased = rankSkillsForTask(
    [skill("project:testing", "testing", "Use focused verification evidence", "project")],
    "Change the value safely",
    ["verification"],
    1
  );
  assert.equal(aliased[0]?.name, "testing");
  const broadCapability = rankSkillsForTask(
    [
      skill("project:testing", "testing", "Run focused checks", "project"),
      skill("user:docs", "docs", "Reference code and text documentation"),
    ],
    "Run the testing checks",
    ["code"],
    1
  );
  assert.equal(broadCapability[0]?.name, "testing");
});

test("every worker attempt records one context manifest bound to task, attempt, and revision", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-native-worker-manifest-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "value.txt"), "one\n");
  let sessions: SqliteAgentSessionStore | undefined;
  let ledger: SqliteToolLedger | undefined;
  let scheduler: SqliteSchedulerStore | undefined;
  let evidence: SqliteEvidenceStore | undefined;
  let memory: SqliteProjectMemoryStore | undefined;
  let contextManifests: SqliteContextManifestStore | undefined;
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_1",
    });
    const workspaces = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_1",
      baselineRevision: baseline.revision,
    });
    const workspace = await workspaces.createTaskWorkspace("task_a");
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
    ledger = new SqliteToolLedger(join(state, "tools.sqlite"));
    scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
    evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
    memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
    contextManifests = new SqliteContextManifestStore(join(state, "context-manifests.sqlite"));
    seedRunningTask(scheduler);
    const candidate: AgentRuntimeCandidate = {
      runtimeId: "primary:code",
      providerId: "primary",
      modelId: "code",
      capabilities: ["code"],
      priority: 1,
    };
    const health = new ProviderHealthRegistry();
    const driver = new NativeWorkerDriver({
      schedulerStore: scheduler,
      router: new RuntimeRouter({ candidates: [candidate], health }),
      health,
      candidates: [candidate],
      models: new Map([[candidate.runtimeId, new ScriptedModel([
        toolTurn("replan", "request_replan", {
          requestId: "replan-1",
          reason: "scope_exceeded",
          summary: "The cache key factory lives outside this task.",
          proposedChange: "Split the task.",
          evidenceSequence: 3,
        }),
      ])]]),
      permissionProfile: "full",
      workspaceManager: workspaces,
      artifacts,
      ledger,
      sessions,
      evidenceStore: evidence,
      skillCatalog: new SkillCatalog({ projectRoot: project }),
      memoryStore: memory,
      projectId: "project_1",
      projectRoot: project,
      contextManifests,
      execution: createTestOneShotCommandExecutor(t, { artifacts }),
    });
    const outcome = await driver.run({
      runId: "run_1",
      task: rebuildTask(scheduler),
      attempt: 1,
      workerId: "worker_task_a_1",
      workspacePath: workspace.path,
    });
    assert.equal(outcome.type, "guidance");
    const manifests = contextManifests.listRun("run_1");
    assert.equal(manifests.length, 1);
    const manifest = manifests[0]!;
    assert.equal(manifest.role, "worker");
    assert.equal(manifest.purpose, "worker:task");
    assert.equal(manifest.taskId, "task_a");
    assert.equal(manifest.attempt, 1);
    assert.equal(manifest.repositoryRevision, baseline.revision);
    assert.equal(manifest.packArtifactHash, undefined);
  } finally {
    contextManifests?.close();
    sessions?.close();
    ledger?.close();
    scheduler?.close();
    evidence?.close();
    memory?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function seedRunningTask(store: SqliteSchedulerStore): void {
  store.append({
    runId: "run_1", type: "plan.created", occurredAt: "2026-07-12T00:00:00.000Z",
    actor: { role: "architect", id: "architect_1" }, idempotencyKey: "plan:1",
    payload: { revision: 1, tasks: [{
      id: "task_a",
      objective: "Change the value and create testing evidence",
      dependencies: [],
      acceptanceCriteria: [{
        id: "value",
        text: "The value is changed to two and testing evidence is recorded.",
      }],
      acceptanceCriteriaVersion: 1,
      status: "planned",
      requiredCapabilities: ["code"],
      attempt: 0,
    }] },
  });
  store.append({
    runId: "run_1", type: "task.transitioned", occurredAt: "2026-07-12T00:00:00.000Z",
    actor: { role: "runner", id: "scheduler" }, idempotencyKey: "assign:1",
    payload: { taskId: "task_a", status: "assigned", patch: { attempt: 1, assignedWorkerId: "worker_task_a_1" } },
  });
  store.append({
    runId: "run_1", type: "task.transitioned", occurredAt: "2026-07-12T00:00:00.000Z",
    actor: { role: "runner", id: "scheduler" }, idempotencyKey: "run:1",
    payload: { taskId: "task_a", status: "running", patch: { workspacePath: "workspace" } },
  });
}

function rebuildTask(store: SqliteSchedulerStore) {
  // Static import is avoided only to keep this test's setup helpers compact.
  const events = store.readRun("run_1");
  const plan = events[0].payload.tasks as Array<Record<string, unknown>>;
  return { ...plan[0], status: "running", attempt: 1, assignedWorkerId: "worker_task_a_1" } as WorkerAssignment["task"];
}

function toolTurn(callId: string, name: string, args: unknown): ModelTurn {
  return { blocks: [{ type: "tool_call", callId, name, arguments: args }], stopReason: "tool_calls" };
}

function expectedEvidenceId(
  runId: string,
  taskId: string,
  sessionId: string,
  callId: string
): string {
  return `evidence_${createHash("sha256")
    .update(`${runId}\0${taskId}\0evidence:${sessionId}:${callId}`)
    .digest("hex")}`;
}

function emptyArtifactHash(): string {
  return createHash("sha256").update(Buffer.alloc(0)).digest("hex");
}

// ---------------------------------------------------------------------------------------------------------------
// CW5: the driver's CLI branch (docs/plans/2026-11-14-cli-workers.md §3.5, §3.11), with the fake CLI as a child.

async function cliDriverFixture(t: TestContext, label: string, scenario: Omit<FakeCliScenario, "cli" | "stdout"> & { structured?: Record<string, unknown> | null; working?: boolean; stdoutFixture?: string } = {}) {
  // Git reports the worktree by its real path (macOS /private/var, a Windows 8.3 name spelled out), as the launcher
  // gives the Runner its project and state folders: realpathSync.native expands 8.3 names, plain realpathSync does not.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `aiboard-native-worker-cli-${label}-`)));
  // Registered before anything can throw (the worktree, the stores), so a failed setup still removes the folder.
  const closers: Array<() => void> = [];
  t.after(() => {
    for (const close of closers.reverse()) close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const project = join(root, "project");
  const state = join(root, "state");
  const fake = join(root, "fake");
  mkdirSync(project);
  mkdirSync(state);
  mkdirSync(fake);
  writeFileSync(join(project, "value.txt"), "one\n");
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: "run_1" });
  const workspaces = new WorkspaceManager({ repositoryRoot: project, stateDirectory: state, runId: "run_1", baselineRevision: baseline.revision });
  const workspace = await workspaces.createTaskWorkspace("task_a");
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
  const ledger = new SqliteToolLedger(join(state, "tools.sqlite"));
  const scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
  const evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
  const memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
  closers.push(() => { sessions.close(); ledger.close(); scheduler.close(); evidence.close(); memory.close(); });
  seedRunningTask(scheduler);
  const { structured = cliDoneResult(), working, stdoutFixture, ...rest } = scenario;
  const stdout = stdoutFixture ?? writeClaudeStream(join(fake, "claude.jsonl"), structured, working ? { working: true } : {});
  const launcher = new ChildCliLauncher(writeFakeCliScenario(fake, { cli: "claude-code", stdout, ...rest }));
  const cli: AgentRuntimeCandidate = { runtimeId: "claude-code:default", providerId: "claude-code", modelId: "sonnet", capabilities: ["code"], priority: 1, workerOnly: true };
  const api: AgentRuntimeCandidate = { runtimeId: "primary:code", providerId: "primary", modelId: "code", capabilities: ["code"], priority: 2 };
  const health = new ProviderHealthRegistry();
  const apiModel = new ScriptedModel([]);
  // The owner folder's browser as the post-stop check reads it. In production the stop that really ends the owner's
  // processes is the managed service's closeAgent (retryStop runs it first), and its observer records the browser:
  // with `escapeOnStop` armed, that stop is where the escape appears.
  let browser: "exited" | "escaped" = "exited";
  let escapeOnStop = false;
  const closes: string[] = [];
  const managedProcesses = {
    closeAgent: async (owner: { sessionId: string }) => { closes.push(owner.sessionId); if (escapeOnStop) browser = "escaped"; },
    listRun: async () => [],
  } as unknown as ManagedProcessService;
  const owners = new CliWorkerOwners();
  const runtime: CliWorkerRuntimeDeps = {
    schedulerStore: scheduler, sessions, workspaceManager: workspaces, launcher,
    settings: async () => ({ executable: { status: "found", path: process.execPath, source: "home", form: "exe" }, attemptLimitMs: 60_000, argsPrefix: [FAKE_CLI_SCRIPT] }),
    host: { platform: "win32", isRoot: false, jobContainment: "verified", windowsBatchArgv: "verified" },
    stateDirectory: state, owners, readWaitMs: 50,
    captureTree: (cwd) => captureWorkingTreeIdentity(cwd, join(state, "tree-index"), runGit),
    browser: { checkAfterStop: async () => browser },
    rerunChecks: async ({ attempt }) => {
      const output = await artifacts.put(new Uint8Array(0), "text/plain", "check output");
      const record = evidence.record({
        runId: "run_1", taskId: "task_a", actor: { role: "worker", id: "worker_task_a_1" }, attempt, createdAt: "2026-11-18T00:00:01.000Z",
        idempotencyKey: `evidence:cli:${attempt}`,
        fact: {
          kind: "command", label: "node --test", command: "node", args: ["--test"], cwd: ".",
          startedAt: "2026-11-18T00:00:00.000Z", finishedAt: "2026-11-18T00:00:01.000Z", exitCode: 0, signal: null,
          timedOut: false, cancelled: false, outputTruncated: false, stdoutArtifactHash: output.hash, stderrArtifactHash: output.hash,
        },
      });
      return { criterionEvidenceLinks: [{ criterionId: "value", evidenceId: record.id, artifactHashes: [output.hash] }], notRun: [] };
    },
  };
  const driver = (runtimeOverrides: Partial<CliWorkerRuntimeDeps> = {}, cliWorkerDriver = true) => new NativeWorkerDriver({
    schedulerStore: scheduler,
    router: new RuntimeRouter({ candidates: [cli, api], health, cliWorkerDriver }),
    health,
    candidates: [cli, api],
    models: new Map([[api.runtimeId, apiModel]]),
    permissionProfile: "full",
    workspaceManager: workspaces,
    artifacts,
    ledger,
    sessions,
    evidenceStore: evidence,
    skillCatalog: new SkillCatalog({ projectRoot: project }),
    memoryStore: memory,
    projectId: "project_1",
    projectRoot: project,
    execution: createTestOneShotCommandExecutor(t, { artifacts }),
    managedProcesses,
    cliWorkers: { runtimes: new Map([[cli.runtimeId, { runtimeId: cli.runtimeId, providerId: "claude-code", model: "sonnet" }]]), runtime: { ...runtime, ...runtimeOverrides } },
  });
  const assignment = { runId: "run_1", task: rebuildTask(scheduler), attempt: 1, workerId: "worker_task_a_1", workspacePath: workspace.path };
  return { driver, assignment, launcher, health, apiModel, owners, scheduler, setBrowser: (status: "exited" | "escaped") => { browser = status; }, armEscapeOnStop: (armed: boolean) => { escapeOnStop = armed; }, closes };
}

test("CW5: a mixed crew assigns the task to the CLI worker, whose done result is submitted", async (t) => {
  const fixture = await cliDriverFixture(t, "mixed", { actions: [{ write: "value.txt", content: "two\n" }] });
  const outcome = await fixture.driver().run(fixture.assignment);
  assert.equal(outcome.type, "submitted", JSON.stringify(outcome));
  assert.equal(fixture.launcher.starts.length, 1);
  assert.equal(fixture.apiModel.requests.length, 0);
  assert.equal(fixture.health.get("claude-code").status, "healthy");
  const assignmentEvent = fixture.scheduler.readRun("run_1").find((event) => event.type === "worker.runtime_assigned");
  assert.equal((assignmentEvent?.payload as { runtimeId?: string } | undefined)?.runtimeId, "claude-code:default");
});

test("CW5 §3.7: the same attempt run again finds the worktree its CLI left detached or on another branch: a coded failure", async (t) => {
  for (const [label, leave] of [["detached", ["checkout", "-q", "--detach"]], ["other_branch", ["checkout", "-q", "-b", "cli-branch"]]] as const) {
    const fixture = await cliDriverFixture(t, `reentry-${label}`);
    fixture.launcher.stopFailures = 1;
    const driver = fixture.driver();
    const first = await driver.run(fixture.assignment);
    assert.deepEqual((first as { outcome?: unknown }).outcome, { type: "paused", reason: "cli_collect_pending:task_a" });
    // What the CLI left before its stop was proven: the worktree off its task branch.
    await runGit({ cwd: fixture.assignment.workspacePath, args: [...leave] });
    await driver.retryStop(fixture.assignment);
    // The Resume: the workspace is refused as before (createTaskWorkspace), and the CLI worker's failure is coded.
    const again = await driver.run(fixture.assignment);
    assert.equal(again.type, "failed", JSON.stringify(again));
    assert.match((again as { reason: string }).reason, new RegExp(`^cli_history_rewritten:${label}: `));
    assert.equal(fixture.launcher.starts.length, 1, "no CLI is started in it");
  }
});

test("CW5: case 1 fails the attempt and leaves the CLI's health untouched", async (t) => {
  const fixture = await cliDriverFixture(t, "case1");
  const before = fixture.health.snapshot();
  const outcome = await fixture.driver({ host: { platform: "win32", isRoot: false, jobContainment: "partial" } }).run(fixture.assignment);
  assert.deepEqual(outcome, { type: "failed", reason: "process_launch_unproven:job_containment_unverified" });
  assert.deepEqual(fixture.health.snapshot(), before, "no success or failure is recorded for the CLI");
  assert.equal(fixture.launcher.starts.length, 0);
  assert.equal(fixture.apiModel.requests.length, 0, "case 1 never fails over");
});

test("CW5: an unproven stop keeps the collect pending, and retryStop proves the owner's stop with its browser record", async (t) => {
  const fixture = await cliDriverFixture(t, "retry-stop");
  fixture.launcher.stopFailures = 1;
  const driver = fixture.driver();
  const outcome = await driver.run(fixture.assignment);
  assert.equal(outcome.type, "stop_unproven", JSON.stringify(outcome));
  assert.deepEqual((outcome as { outcome?: unknown }).outcome, { type: "paused", reason: "cli_collect_pending:task_a" });
  const owner = { runId: "run_1", sessionId: "worker:run_1:task_a:1" };
  assert.equal(fixture.owners.has(owner), true);
  // The browser escapes at the generic stop retryStop runs first: the CLI's check runs after it and must see it.
  fixture.armEscapeOnStop(true);
  const before = fixture.closes.length;
  await assert.rejects(driver.retryStop(fixture.assignment), /the browser the CLI's session ran is still running/);
  assert.ok(fixture.closes.length > before, "the managed stop ran before the browser check");
  assert.equal(fixture.owners.has(owner), true);
  // A known escape is never cleared by a later stop alone: still running, still unproven.
  fixture.armEscapeOnStop(false);
  await assert.rejects(driver.retryStop(fixture.assignment), /still running/);
  fixture.setBrowser("exited");
  await driver.retryStop(fixture.assignment);
  assert.equal(fixture.owners.has(owner), false);
  // The proven retry lets the next run collect the result without starting the CLI again.
  const collected = await driver.run(fixture.assignment);
  assert.equal(collected.type, "submitted", JSON.stringify(collected));
  assert.equal(fixture.launcher.starts.length, 1);
});

test("CW7: a CLI out of usage with no healthy worker left pauses all_worker_runtimes_unavailable, its cause recorded", async (t) => {
  const fixture = await cliDriverFixture(t, "no-healthy", { stdoutFixture: cliFixture("claude-code/usage-limit.synthetic.stdout.jsonl"), exitCode: 1 });
  // The crew's API worker is out already.
  fixture.health.recordFailure("primary", { kind: "authentication", message: "invalid key" });
  const outcome = await fixture.driver().run(fixture.assignment);
  assert.deepEqual(outcome, { type: "paused", reason: "all_worker_runtimes_unavailable" });
  assert.equal(fixture.launcher.starts.length, 1);
  assert.equal(fixture.apiModel.requests.length, 0);
  const state = fixture.health.get("claude-code");
  assert.equal(state.status, "cooldown");
  assert.equal(state.failureKind, "usage_limit");
  // The health change is durable, as an API worker's is.
  const changes = fixture.scheduler.readRun("run_1").filter((event) => event.type === "provider.health_changed");
  assert.deepEqual(changes.map((event) => (event.payload.state as { providerId: string }).providerId), ["claude-code"]);
});
