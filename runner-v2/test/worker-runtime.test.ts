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
import type { BrowserBackend } from "../src/browser-tools.js";
import { captureGitBaseline } from "../src/git-baseline.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { ManagedProcessService } from "../src/managed-process.js";
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

const browserEvidenceBackend: BrowserBackend = {
  async open(_sessionId, input) { return { url: input.url, title: "Arena" }; },
  async navigate(_sessionId, url) { return { url, title: "Arena" }; },
  async snapshot() {
    return {
      url: "http://127.0.0.1:8000",
      title: "Arena",
      text: "Blue 0 Orange 0",
      html: "<main>Blue 0 Orange 0</main>",
    };
  },
  async click() {},
  async fill() {},
  async wheel() {},
  async drag() {},
  async screenshot() { return Buffer.from("arena-png"); },
  async events() { return { console: [], network: [] }; },
  async close() {},
  async closeAll() {},
};

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
    const staleStdout = await artifacts.put(
      Buffer.from("stale prior-attempt output"),
      "text/plain",
      "stale prior-attempt stdout"
    );
    const staleStderr = await artifacts.put(
      Buffer.from("stale prior-attempt error"),
      "text/plain",
      "stale prior-attempt stderr"
    );
    evidenceStore.record({
      runId: "run_worker",
      taskId: "task_worker",
      actor: { role: "worker", id: "worker_old_attempt" },
      fact: {
        kind: "command",
        label: "stale prior attempt",
        command: process.execPath,
        args: ["-e", "process.exit(1)"],
        cwd: workspace.path,
        startedAt: "2026-07-13T00:00:00.000Z",
        finishedAt: "2026-07-13T00:00:01.000Z",
        exitCode: 1,
        signal: null,
        timedOut: false,
        cancelled: false,
        outputTruncated: false,
        stdoutArtifactHash: staleStdout.hash,
        stderrArtifactHash: staleStderr.hash,
      },
      createdAt: "2026-07-13T00:00:01.000Z",
      idempotencyKey: "stale-prior-attempt",
    });
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
      permissionProfile: "full",
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
      toolTurn("submit", "submit_task", {
        summary: "Change value to two",
        readiness: "ready_for_architect_review",
        unresolvedConcerns: ["Windows line endings were not exercised."],
      }),
    ]);
    const finished = await runWorkerTask({
      model: recoveredModel,
      runId: "run_worker",
      sessionId: "session_worker",
      taskId: "task_worker",
      actorId: "worker_1",
      permissionProfile: "full",
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
    assert.equal(finished.changeSet.evidenceArtifactHashes.includes(staleStdout.hash), false);
    assert.equal(finished.changeSet.evidenceArtifactHashes.includes(staleStderr.hash), false);
    assert.deepEqual(finished.changeSet.unresolvedConcerns, [
      "Windows line endings were not exercised.",
    ]);
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

test("worker submits automatically recorded browser facts as durable review evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-worker-browser-evidence-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "index.html"), "<main>Arena</main>\n");
  let sessions: SqliteAgentSessionStore | undefined;
  let ledger: SqliteToolLedger | undefined;
  let evidenceStore: SqliteEvidenceStore | undefined;
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_browser_evidence",
    });
    const workspaces = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_browser_evidence",
      baselineRevision: baseline.revision,
    });
    const workspace = await workspaces.createTaskWorkspace("task_browser");
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
    ledger = new SqliteToolLedger(join(state, "tools.sqlite"));
    evidenceStore = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
    const result = await runWorkerTask({
      model: new ScriptedModel([
        toolTurn("snapshot", "browser.snapshot", {}),
        toolTurn("screenshot", "browser.screenshot", {}),
        toolTurn("events", "browser.events", {}),
        toolTurn("submit", "submit_task", {
          summary: "Record browser acceptance",
          readiness: "ready_for_architect_review",
          unresolvedConcerns: [],
        }),
      ]),
      runId: "run_browser_evidence",
      sessionId: "session_browser",
      taskId: "task_browser",
      actorId: "worker_browser",
      permissionProfile: "full",
      workspace,
      workspaceManager: workspaces,
      artifacts,
      ledger,
      sessions,
      evidenceStore,
      browserBackend: browserEvidenceBackend,
      initialMessages: [
        { id: "system", role: "system", content: "Record browser evidence." },
        { id: "user", role: "user", content: "Inspect the arena and submit." },
      ],
    });
    assert.equal(result.loop.status, "submitted");
    assert.deepEqual(
      evidenceStore.list({ runId: "run_browser_evidence", taskId: "task_browser" })
        .map((record) => record.fact.kind),
      ["browser_snapshot", "browser_screenshot", "browser_events"]
    );
    assert.equal(result.changeSet?.evidenceArtifactHashes.length, 3);
  } finally {
    sessions?.close();
    ledger?.close();
    evidenceStore?.close();
    rmSync(root, { recursive: true, force: true });
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
          readiness: "ready_for_architect_review",
        }),
      ]),
      runId: "run_inspection",
      sessionId: "session_inspection",
      taskId: "task_inspection",
      actorId: "worker_1",
      permissionProfile: "full",
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

test("worker subagent edits the shared task workspace and returns without parent lifecycle authority", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-worker-subagent-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project);
  mkdirSync(state);
  writeFileSync(join(project, "value.txt"), "one\n");
  let sessions: SqliteAgentSessionStore | undefined;
  let ledger: SqliteToolLedger | undefined;
  let evidenceStore: SqliteEvidenceStore | undefined;
  try {
    const baseline = await captureGitBaseline({
      projectPath: project,
      stateDirectory: state,
      runId: "run_subagent",
    });
    const workspaces = new WorkspaceManager({
      repositoryRoot: project,
      stateDirectory: state,
      runId: "run_subagent",
      baselineRevision: baseline.revision,
    });
    const workspace = await workspaces.createTaskWorkspace("task_subagent");
    const expectedHash = createHash("sha256")
      .update(readFileSync(join(workspace.path, "value.txt")))
      .digest("hex");
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
    ledger = new SqliteToolLedger(join(state, "tools.sqlite"));
    evidenceStore = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
    const requests: AgentModelRequest[] = [];
    const managedProcesses = new ManagedProcessService({
      stateDirectory: join(state, "managed-processes"),
    });
    let parentTurn = 0;
    let subagentTurn = 0;
    const model: AgentModel = {
      complete: async (request) => {
        requests.push(request);
        if (request.sessionId.includes(":subagent:")) {
          subagentTurn += 1;
          return subagentTurn === 1
            ? toolTurn("subagent-edit", "fs.patch", {
                path: "value.txt",
                expectedSha256: expectedHash,
                search: "one",
                replace: "two",
              })
            : toolTurn("subagent-return", "return_to_parent", {
                summary: "Changed value.txt from one to two.",
                artifactHashes: [],
              });
        }
        parentTurn += 1;
        if (parentTurn === 1) {
          return toolTurn("delegate", "spawn_subagent", {
            assignment: "Change value.txt from one to two.",
            maxTurns: 4,
          });
        }
        if (parentTurn === 2) {
          return toolTurn("verify", "run_evidence_command", {
            label: "verify delegated edit",
            command: process.execPath,
            args: ["-e", "const fs=require('node:fs');process.exit(fs.readFileSync('value.txt','utf8').trim()==='two'?0:1)"],
            cwd: ".",
          });
        }
        return toolTurn("submit", "submit_task", {
          summary: "Accept delegated value edit",
          readiness: "ready_for_architect_review",
        });
      },
    };
    const result = await runWorkerTask({
      model,
      runId: "run_subagent",
      sessionId: "session_subagent_parent",
      taskId: "task_subagent",
      actorId: "worker_1",
      permissionProfile: "full",
      workspace,
      workspaceManager: workspaces,
      artifacts,
      ledger,
      sessions,
      evidenceStore,
      managedProcesses,
      initialMessages: [
        { id: "system", role: "system", content: "Delegate, verify, and submit." },
      ],
    });
    assert.equal(result.loop.status, "submitted");
    assert.equal(readFileSync(join(workspace.path, "value.txt"), "utf8").trim(), "two");
    const childRequest = requests.find((request) => request.sessionId.includes(":subagent:"));
    assert.ok(childRequest);
    const childTools = new Set(childRequest.tools.map((tool) => tool.name));
    assert.equal(childTools.has("fs.patch"), true);
    assert.equal(childTools.has("return_to_parent"), true);
    assert.equal(childTools.has("process.start"), true);
    assert.equal(childTools.has("submit_task"), false);
    assert.equal(childTools.has("git.commit"), false);
    assert.equal(childTools.has("spawn_subagent"), false, "subagent depth is bounded to one");
    const parentSession = await sessions.load("session_subagent_parent");
    const spawnResult = parentSession.checkpoint?.messages.find((message) =>
      message.role === "tool" &&
      typeof message.content === "object" &&
      !Array.isArray(message.content) &&
      message.content.toolName === "spawn_subagent"
    );
    assert.ok(spawnResult, "structured subagent findings are durable in the parent checkpoint");
  } finally {
    sessions?.close();
    ledger?.close();
    evidenceStore?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function toolTurn(callId: string, name: string, args: unknown): ModelTurn {
  return {
    blocks: [{ type: "tool_call", callId, name, arguments: args }],
    stopReason: "tool_calls",
  };
}
