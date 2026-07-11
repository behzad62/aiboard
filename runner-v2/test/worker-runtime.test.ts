import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentMessage,
  AgentModel,
  AgentModelRequest,
  ModelTurn,
} from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { captureGitBaseline } from "../src/git-baseline.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { WorkspaceManager } from "../src/workspace-manager.js";
import { runWorkerTask } from "../src/worker-runtime.js";

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

test("worker inspects, edits, tests, diffs, restarts, and submits a typed change set", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-worker-runtime-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "value.txt"), "one\n");
  let firstSessions: SqliteAgentSessionStore | undefined;
  let firstLedger: SqliteToolLedger | undefined;
  let recoveredSessions: SqliteAgentSessionStore | undefined;
  let recoveredLedger: SqliteToolLedger | undefined;
  let evidenceStore: SqliteEvidenceStore | undefined;
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_worker",
    });
    const workspaces = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_worker",
      baselineRevision: baseline.revision,
    });
    const workspace = await workspaces.createTaskWorkspace("task_worker");
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    evidenceStore = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
    const messages: AgentMessage[] = [
      { id: "system", role: "system", content: "Use native tools and submit_task." },
      { id: "user", role: "user", content: "Change one to two and verify it." },
    ];
    const expectedHash = createHash("sha256")
      .update(readFileSync(join(workspace.path, "value.txt")))
      .digest("hex");

    firstSessions = new SqliteAgentSessionStore(
      join(state, "sessions.sqlite"),
      artifacts
    );
    firstLedger = new SqliteToolLedger(join(state, "tools.sqlite"));
    const first = await runWorkerTask({
      model: new ScriptedModel([
        toolTurn("read", "fs.read", { path: "value.txt" }),
        toolTurn("patch", "fs.patch", {
          path: "value.txt",
          expectedSha256: expectedHash,
          search: "one",
          replace: "two",
        }),
        new Error("provider temporarily unavailable"),
      ]),
      runId: "run_worker",
      sessionId: "session_worker",
      taskId: "task_worker",
      actorId: "worker_1",
      permissionProfile: "project",
      workspace,
      workspaceManager: workspaces,
      artifacts,
      ledger: firstLedger,
      sessions: firstSessions,
      evidenceStore,
      initialMessages: messages,
    });
    assert.equal(first.loop.status, "suspended");
    assert.equal(first.loop.reason, "provider_error");
    assert.equal(readFileSync(join(workspace.path, "value.txt"), "utf8").trim(), "two");
    firstSessions.close();
    firstSessions = undefined;
    firstLedger.close();
    firstLedger = undefined;

    recoveredSessions = new SqliteAgentSessionStore(
      join(state, "sessions.sqlite"),
      artifacts
    );
    recoveredLedger = new SqliteToolLedger(join(state, "tools.sqlite"));
    const checkScript =
      "const fs=require('node:fs');const ok=fs.readFileSync('value.txt','utf8').trim()==='two';if(ok)process.stdout.write('checked');process.exit(ok?0:1)";
    const recoveredModel = new ScriptedModel([
      toolTurn("test", "run_evidence_command", {
        label: "focused value check",
        command: process.execPath,
        args: ["-e", checkScript],
        cwd: ".",
      }),
      toolTurn("diff", "git.diff", {}),
      toolTurn("submit", "submit_task", { summary: "Change value to two" }),
    ]);
    const finished = await runWorkerTask({
      model: recoveredModel,
      runId: "run_worker",
      sessionId: "session_worker",
      taskId: "task_worker",
      actorId: "worker_1",
      permissionProfile: "project",
      workspace,
      workspaceManager: workspaces,
      artifacts,
      ledger: recoveredLedger,
      sessions: recoveredSessions,
      evidenceStore,
      initialMessages: messages,
    });
    assert.equal(finished.loop.status, "submitted");
    assert.ok(finished.changeSet);
    assert.equal(finished.changeSet.taskId, "task_worker");
    assert.equal(finished.changeSet.evidenceArtifactHashes.length, 2);
    assert.match(
      (await artifacts.get(finished.changeSet.diffArtifactHash)).toString(),
      /-one[\s\S]*\+two/
    );
    assert.equal(readFileSync(join(project, "value.txt"), "utf8"), "one\n");
    assert.equal(
      recoveredModel.requests[0].messages.some(
        (message) =>
          message.role === "tool" &&
          typeof message.content === "object" &&
          !Array.isArray(message.content) &&
          message.content.callId === "patch"
      ),
      true
    );
    const session = await recoveredSessions.load("session_worker");
    assert.equal(session.status, "submitted");
    recoveredSessions.close();
    recoveredSessions = undefined;
    recoveredLedger.close();
    recoveredLedger = undefined;
    evidenceStore.close();
    evidenceStore = undefined;
  } finally {
    firstSessions?.close();
    firstLedger?.close();
    recoveredSessions?.close();
    recoveredLedger?.close();
    evidenceStore?.close();
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
});

test("worker can submit an evidence-backed inspection task without fabricating a commit", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-worker-no-change-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "value.txt"), "unchanged\n");
  let sessions: SqliteAgentSessionStore | undefined;
  let ledger: SqliteToolLedger | undefined;
  let evidenceStore: SqliteEvidenceStore | undefined;
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_inspection",
    });
    const workspaces = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_inspection",
      baselineRevision: baseline.revision,
    });
    const workspace = await workspaces.createTaskWorkspace("task_inspection");
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    evidenceStore = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
    sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
    ledger = new SqliteToolLedger(join(state, "tools.sqlite"));
    const result = await runWorkerTask({
      model: new ScriptedModel([
        toolTurn("inspect", "run_evidence_command", {
          label: "confirm repository state",
          command: process.execPath,
          args: ["-e", "process.stdout.write('inspected')"],
          cwd: ".",
        }),
        toolTurn("submit", "submit_task", {
          summary: "Repository inspection found no required changes",
        }),
      ]),
      runId: "run_inspection",
      sessionId: "session_inspection",
      taskId: "task_inspection",
      actorId: "worker_1",
      permissionProfile: "project",
      workspace,
      workspaceManager: workspaces,
      artifacts,
      ledger,
      sessions,
      evidenceStore,
      initialMessages: [
        { id: "system", role: "system", content: "Inspect and submit evidence." },
        { id: "user", role: "user", content: "Report whether changes are needed." },
      ],
    });
    assert.equal(result.loop.status, "submitted");
    assert.deepEqual(result.changeSet?.commits, []);
    assert.deepEqual(result.changeSet?.changedPaths, []);
    assert.equal(result.changeSet?.taskRevision, baseline.revision);
    assert.equal(result.changeSet?.evidenceArtifactHashes.length, 2);
  } finally {
    sessions?.close();
    ledger?.close();
    evidenceStore?.close();
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
});

function toolTurn(callId: string, name: string, args: unknown): ModelTurn {
  return {
    blocks: [{ type: "tool_call", callId, name, arguments: args }],
    stopReason: "tool_calls",
  };
}
