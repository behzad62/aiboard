import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { captureGitBaseline } from "../src/git-baseline.js";
import {
  NativeWorkerDriver,
  recoverableWorkerSuspension,
  workerContinuationMessages,
  shouldFailoverWorkerFailure,
} from "../src/native-worker-driver.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import { RuntimeRouter, type AgentRuntimeCandidate } from "../src/runtime-router.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteProjectMemoryStore } from "../src/sqlite-project-memory.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import type { WorkerAssignment } from "../src/task-scheduler.js";
import { WorkspaceManager } from "../src/workspace-manager.js";

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
  assert.deepEqual(
    recoverableWorkerSuspension("model_ended_without_lifecycle", ""),
    { type: "paused", reason: "worker_model_ended_without_lifecycle" }
  );
  assert.deepEqual(
    recoverableWorkerSuspension("budget_exhausted", "maxToolCalls reached"),
    { type: "paused", reason: "budget_exhausted:maxToolCalls reached" }
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
  assert.doesNotMatch(String(resumed[1].content), /request_guidance/);
});

test("native worker fails over with the same session, context, tools, and evidence", async () => {
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
      toolTurn("submit", "submit_task", { summary: "Change value to two" }),
    ]);
    const candidates: AgentRuntimeCandidate[] = [
      { runtimeId: "primary:code", providerId: "primary", modelId: "code", capabilities: ["code"], priority: 1 },
      { runtimeId: "fallback:code", providerId: "fallback", modelId: "code", capabilities: ["code"], priority: 2 },
    ];
    const health = new ProviderHealthRegistry();
    const driver = new NativeWorkerDriver({
      schedulerStore: scheduler,
      router: new RuntimeRouter({ candidates, health }),
      health,
      candidates,
      models: new Map([
        ["primary:code", new ScriptedModel([new Error("provider down")])],
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
    assert.equal(fallback.requests[0].sessionId, "worker:run_1:task_a:1");
    const contextText = fallback.requests[0].messages.map((message) =>
      typeof message.content === "string" ? message.content : ""
    ).join("\n");
    assert.match(contextText, /Batch independent read-only tool calls/i);
    assert.match(contextText, /Keep command output narrow/i);
    assert.match(contextText, /Before every submit_task/i);
    assert.match(contextText, /Run focused tests first/);
    assert.match(contextText, /focused testing evidence/);
    assert.match(contextText, /newline-terminated text/);
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

function seedRunningTask(store: SqliteSchedulerStore): void {
  store.append({
    runId: "run_1", type: "plan.created", occurredAt: "2026-07-12T00:00:00.000Z",
    actor: { role: "architect", id: "architect_1" }, idempotencyKey: "plan:1",
    payload: { revision: 1, tasks: [{ id: "task_a", objective: "Change the value and create testing evidence", dependencies: [], status: "planned", requiredCapabilities: ["code"], attempt: 0 }] },
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
