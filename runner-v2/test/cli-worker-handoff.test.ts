/**
 * CW7 (docs/plans/2026-11-14-cli-workers.md §3.8, §3.9): a CLI failure fails over like an API one, and the handoff goes
 * both ways. The driver runs the fake CLI as a child and a scripted API model; no real CLI is started and no prompt is
 * sent.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import type { AgentMessage, AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { ProviderTransportError } from "../src/account-runner-model.js";
import { ArtifactStore } from "../src/artifact-store.js";
import {
  HANDOFF_LAST_TEXT_MAX,
  attemptRuntimeAssignments,
  lastAssistantText,
  previousWorker,
  renderWorkerHandoff,
  type WorkerHandoff,
} from "../src/cli-worker-handoff.js";
import { captureWorkingTreeIdentity } from "../src/command-evidence-identity.js";
import {
  CliWorkerOwners,
  type CliProcessHandle,
  type CliProcessLauncher,
  type CliWorkerOwner,
  type CliWorkerRuntimeConfig,
  type CliWorkerRuntimeDeps,
} from "../src/cli-worker-runtime.js";
import type { ManagedProcessService } from "../src/managed-process.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import { RuntimeRouter, type AgentRuntimeCandidate } from "../src/runtime-router.js";
import type { SchedulerEvent } from "../src/scheduler-store.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteProjectMemoryStore } from "../src/sqlite-project-memory.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import type { WorkerAssignment } from "../src/task-scheduler.js";
import { ChildCliLauncher, FAKE_CLAUDE_SESSION, cliDoneResult, writeClaudeStream } from "./support/cli-worker-fixture.js";
import { FAKE_CLI_SCRIPT, cliFixture, writeFakeCliScenario, type FakeCliRecord, type FakeCliScenario } from "./support/fake-cli.js";
import { NativeWorkerDriver, WorkspaceManager, captureGitBaseline, runGit } from "./support/git-fixture.js";
import { createTestOneShotCommandExecutor } from "./support/one-shot-command-executor.js";

const RUN = "run_1";
const TASK = "task_a";
const WORKER = "worker_task_a_1";
const SESSION = "worker:run_1:task_a:1";

// ---------------------------------------------------------------------------------------------------------------
// The handoff's text and the assignment history it reads.

function handoffFacts(overrides: Partial<WorkerHandoff> = {}): WorkerHandoff {
  return {
    previousWorker: "API worker primary:code (model code)",
    stopped: "it ran out of usage (usage_limit): quota exceeded",
    lastText: "I changed value.txt.",
    changes: { status: "read", changes: { numstat: ["1\t1\tvalue.txt", "-\t-\timage.png"], untracked: ["notes.txt"] } },
    evidenceIds: ["evidence_1", "evidence_2"],
    ...overrides,
  };
}

test("CW7 §3.9: the handoff labels the previous worker's text as its claim and the files and evidence as facts", () => {
  const text = renderWorkerHandoff(handoffFacts());
  assert.match(text, /^The previous worker on this task attempt was the API worker primary:code \(model code\)\. It stopped: it ran out of usage \(usage_limit\): quota exceeded\./);
  assert.match(text, /What the previous worker wrote last\. This is its own claim; AIBoard has not checked it:\n<<<\nI changed value\.txt\.\n>>>/);
  assert.match(text, /\(facts the Runner read with `git diff --numstat <baseline>`: lines added, lines removed, path\):\n1\t1\tvalue\.txt\n-\t-\timage\.png/);
  assert.match(text, /New files Git does not track yet \(facts the Runner read from Git\):\nnotes\.txt/);
  assert.match(text, /Evidence the Runner recorded for this attempt \(facts\): evidence_1, evidence_2\./);
  assert.match(text, /Do not repeat completed work/);

  // At most 2,000 characters of the claim, and a secret in it is redacted.
  const long = renderWorkerHandoff(handoffFacts({ lastText: `token sk-ant-api03-${"a".repeat(40)} ${"x".repeat(5_000)}` }));
  const claim = /<<<\n([\s\S]*)\n>>>/.exec(long)![1]!;
  assert.ok(claim.length <= HANDOFF_LAST_TEXT_MAX, `${claim.length}`);
  assert.doesNotMatch(claim, /sk-ant-api03-a{40}/);

  const empty = renderWorkerHandoff(handoffFacts({ lastText: undefined, changes: { status: "read", changes: { numstat: [], untracked: [] } }, evidenceIds: [] }));
  assert.match(empty, /The previous worker left no summary or text\./);
  assert.match(empty, /no file differs from the task's baseline/);
  assert.match(empty, /none is recorded for this attempt yet/);
  const unreadable = renderWorkerHandoff(handoffFacts({ changes: { status: "unavailable", reason: "git exited 128" } }));
  assert.match(unreadable, /could not read the worktree's changed files \(git exited 128\)/);
});

test("CW7 §3.9: the previous worker is the latest other runtime of this attempt's session, with the cause failover recorded", () => {
  const assigned = (runtimeId: string, extra: Record<string, unknown> = {}, sessionId = SESSION): SchedulerEvent => ({
    runId: RUN, sequence: 0, type: "worker.runtime_assigned", occurredAt: "2026-11-18T00:00:00.000Z",
    actor: { role: "runner", id: "runtime-router" }, idempotencyKey: `k:${runtimeId}:${Math.random()}`,
    payload: { taskId: TASK, attempt: 1, runtimeId, sessionId, ...extra },
  }) as unknown as SchedulerEvent;
  const cause = (from: string) => ({ handoff: { fromRuntimeId: from, failureKind: "usage_limit", message: "out" } });
  const key = { taskId: TASK, attempt: 1, sessionId: SESSION };
  assert.equal(previousWorker(attemptRuntimeAssignments([assigned("cli")], key)), undefined, "the first worker has nothing to hand over");
  assert.equal(previousWorker(attemptRuntimeAssignments([assigned("cli"), assigned("cli")], key)), undefined, "the same worker again resumes itself");
  // A → B → A: A gets B's work, and why B stopped.
  const aba = previousWorker(attemptRuntimeAssignments([assigned("a"), assigned("b", cause("a")), assigned("a", cause("b"))], key));
  assert.deepEqual(aba, { runtimeId: "b", cause: { fromRuntimeId: "b", failureKind: "usage_limit", message: "out" }, assignments: 3 });
  // Another session (a steering reassignment) is not this worker's history.
  assert.equal(previousWorker(attemptRuntimeAssignments([assigned("a", {}, "other"), assigned("b")], key)), undefined);
  // A malformed cause is dropped, never trusted.
  assert.deepEqual(previousWorker(attemptRuntimeAssignments([assigned("a"), assigned("b", { handoff: { fromRuntimeId: "a", failureKind: "nope", message: "x" } })], key)),
    { runtimeId: "a", assignments: 2 });

  const messages: AgentMessage[] = [
    { id: "1", role: "assistant", content: [{ type: "text", text: "first" }] },
    { id: "2", role: "assistant", content: [{ type: "text", text: "Patched value.txt." }, { type: "tool_call", callId: "c", name: "fs.read", arguments: {} }] },
    { id: "3", role: "assistant", content: [{ type: "tool_call", callId: "d", name: "fs.read", arguments: {} }] },
    { id: "4", role: "tool", content: { callId: "d", isError: false, content: [{ type: "text", text: "not the worker's words" }] } as never },
  ];
  assert.equal(lastAssistantText(messages), "Patched value.txt.");
});

// ---------------------------------------------------------------------------------------------------------------
// The driver: failover across the CLI boundary, both ways.

class ScriptedModel implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  constructor(private readonly turns: Array<ModelTurn | Error>) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push({ ...request, messages: [...request.messages] });
    const turn = this.turns.shift();
    if (!turn) throw new Error("script exhausted");
    if (turn instanceof Error) throw turn;
    return turn;
  }
}

/** One fake CLI scenario per launch, in order: the same CLI can fail first and succeed when it is picked up again. */
class SequenceLauncher implements CliProcessLauncher {
  readonly starts: Array<{ executable: string; args: readonly string[]; cwd: string }> = [];
  constructor(private readonly launchers: ChildCliLauncher[]) {}
  async start(input: { owner: CliWorkerOwner; executable: string; args: readonly string[]; cwd: string }): Promise<CliProcessHandle> {
    const launcher = this.launchers[this.starts.length];
    this.starts.push(input);
    if (!launcher) throw new Error(`No fake CLI scenario for launch ${this.starts.length}.`);
    return await launcher.start(input);
  }
  async stopOwner(): Promise<void> {
    for (const launcher of this.launchers) await launcher.stopOwner();
  }
}

const API: AgentRuntimeCandidate = { runtimeId: "primary:code", providerId: "primary", modelId: "code", capabilities: ["code"], priority: 1 };
const CLAUDE: AgentRuntimeCandidate = { runtimeId: "claude-code:default", providerId: "claude-code", modelId: "sonnet", capabilities: ["code"], priority: 1, workerOnly: true };
const CLAUDE_CONFIG: CliWorkerRuntimeConfig = { runtimeId: CLAUDE.runtimeId, providerId: "claude-code", model: "sonnet" };

interface FixtureOptions {
  candidates: AgentRuntimeCandidate[];
  cli: CliWorkerRuntimeConfig[];
  /** Each launch's scenario; `record` is set by the fixture. */
  scenarios: Array<(fake: string) => Omit<FakeCliScenario, "record">>;
  models?: Record<string, Array<ModelTurn | Error>>;
  runtime?: Partial<CliWorkerRuntimeDeps>;
}

async function handoffFixture(t: TestContext, label: string, options: FixtureOptions) {
  // Git reports the worktree by its real path (macOS /private/var, a Windows 8.3 name spelled out).
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `aiboard-cli-handoff-${label}-`)));
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
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: RUN });
  const workspaces = new WorkspaceManager({ repositoryRoot: project, stateDirectory: state, runId: RUN, baselineRevision: baseline.revision });
  const workspace = await workspaces.createTaskWorkspace(TASK);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
  const ledger = new SqliteToolLedger(join(state, "tools.sqlite"));
  const scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
  const evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
  const memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
  closers.push(() => { sessions.close(); ledger.close(); scheduler.close(); evidence.close(); memory.close(); });
  seedRunningTask(scheduler);
  const launcher = new SequenceLauncher(options.scenarios.map((scenario, index) =>
    new ChildCliLauncher(writeFakeCliScenario(fake, { ...scenario(fake), record: `run-${index + 1}.json` }, `scenario-${index + 1}.json`))));
  const health = new ProviderHealthRegistry();
  const models = new Map(Object.entries(options.models ?? {}).map(([runtimeId, turns]) => [runtimeId, new ScriptedModel(turns)]));
  const runtime: CliWorkerRuntimeDeps = {
    schedulerStore: scheduler, sessions, workspaceManager: workspaces, launcher,
    settings: async () => ({ executable: { status: "found", path: process.execPath, source: "home", form: "exe" }, attemptLimitMs: 60_000, argsPrefix: [FAKE_CLI_SCRIPT] }),
    host: { platform: "win32", isRoot: false, jobContainment: "verified", windowsBatchArgv: "verified" },
    stateDirectory: state, owners: new CliWorkerOwners(), readWaitMs: 50,
    captureTree: (cwd) => captureWorkingTreeIdentity(cwd, join(state, "tree-index"), runGit),
    rerunChecks: async ({ attempt }) => {
      const output = await artifacts.put(new Uint8Array(0), "text/plain", "check output");
      const record = evidence.record({
        runId: RUN, taskId: TASK, actor: { role: "worker", id: WORKER }, attempt, createdAt: "2026-11-18T00:00:01.000Z",
        idempotencyKey: `evidence:cli-rerun:${attempt}`,
        fact: {
          kind: "command", label: "node --test", command: "node", args: ["--test"], cwd: ".",
          startedAt: "2026-11-18T00:00:00.000Z", finishedAt: "2026-11-18T00:00:01.000Z", exitCode: 0, signal: null,
          timedOut: false, cancelled: false, outputTruncated: false, stdoutArtifactHash: output.hash, stderrArtifactHash: output.hash,
        },
      });
      return { criterionEvidenceLinks: [{ criterionId: "value", evidenceId: record.id, artifactHashes: [output.hash] }], notRun: [] };
    },
    ...options.runtime,
  };
  const driver = new NativeWorkerDriver({
    schedulerStore: scheduler,
    router: new RuntimeRouter({ candidates: options.candidates, health, cliWorkerDriver: true }),
    health,
    candidates: options.candidates,
    models,
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
    providerRetryRuntime: { now: () => 0, random: () => 0.5, sleep: async () => undefined },
    managedProcesses: { closeAgent: async () => undefined, listRun: async () => [] } as unknown as ManagedProcessService,
    cliWorkers: { runtimes: new Map(options.cli.map((config) => [config.runtimeId, config])), runtime },
  });
  const assignment: WorkerAssignment = { runId: RUN, task: rebuildTask(scheduler), attempt: 1, workerId: WORKER, workspacePath: workspace.path };
  return {
    driver, assignment, launcher, health, models, scheduler, sessions, evidence, workspace, fake,
    /** What the fake CLI saw on its `index`th launch (1-based): argv, stdin, cwd. */
    cliRun: (index: number) => JSON.parse(readFileSync(join(fake, `run-${index}.json`), "utf8")) as FakeCliRecord,
    assignments: () => scheduler.readRun(RUN).filter((event) => event.type === "worker.runtime_assigned").map((event) => event.payload),
  };
}

function seedRunningTask(store: SqliteSchedulerStore): void {
  store.append({
    runId: RUN, type: "plan.created", occurredAt: "2026-11-18T00:00:00.000Z",
    actor: { role: "architect", id: "architect_1" }, idempotencyKey: "plan:1",
    payload: { revision: 1, tasks: [{
      id: TASK, objective: "Change the value to two", dependencies: [],
      acceptanceCriteria: [{ id: "value", text: "value.txt holds two." }], acceptanceCriteriaVersion: 1,
      status: "planned", requiredCapabilities: ["code"], attempt: 0,
    }] },
  });
  store.append({
    runId: RUN, type: "task.transitioned", occurredAt: "2026-11-18T00:00:00.000Z",
    actor: { role: "runner", id: "scheduler" }, idempotencyKey: "assign:1",
    payload: { taskId: TASK, status: "assigned", patch: { attempt: 1, assignedWorkerId: WORKER } },
  });
  store.append({
    runId: RUN, type: "task.transitioned", occurredAt: "2026-11-18T00:00:00.000Z",
    actor: { role: "runner", id: "scheduler" }, idempotencyKey: "run:1",
    payload: { taskId: TASK, status: "running", patch: { workspacePath: "workspace" } },
  });
}

function rebuildTask(store: SqliteSchedulerStore): WorkerAssignment["task"] {
  const plan = store.readRun(RUN)[0]!.payload.tasks as Array<Record<string, unknown>>;
  return { ...plan[0], status: "running", attempt: 1, assignedWorkerId: WORKER } as WorkerAssignment["task"];
}

function toolTurn(callId: string, name: string, args: unknown, text?: string): ModelTurn {
  return { blocks: [...(text ? [{ type: "text" as const, text }] : []), { type: "tool_call", callId, name, arguments: args }], stopReason: "tool_calls" };
}

function evidenceId(callId: string): string {
  return `evidence_${createHash("sha256").update(`${RUN}\0${TASK}\0evidence:${SESSION}:${callId}`).digest("hex")}`;
}

const EMPTY_HASH = createHash("sha256").update(Buffer.alloc(0)).digest("hex");
const VALUE_CHECK = {
  label: "value check",
  command: process.execPath,
  args: ["-e", "const fs=require('node:fs');process.exit(fs.readFileSync('value.txt','utf8').trim()==='two'?0:1)"],
  cwd: ".",
};

/** The API worker's run: record a check, then submit with it. */
function apiCheckAndSubmit(callId: string): ModelTurn[] {
  return [
    toolTurn(callId, "run_evidence_command", VALUE_CHECK),
    toolTurn("submit", "submit_task", {
      summary: "Finished the value change the previous worker started.",
      readiness: "ready_for_architect_review",
      criterionEvidenceLinks: [{ criterionId: "value", evidenceId: evidenceId(callId), artifactHashes: [EMPTY_HASH] }],
    }),
  ];
}

function messageText(request: AgentModelRequest): string {
  return request.messages.map((message) => typeof message.content === "string" ? message.content : "").join("\n");
}

test("CW7: a CLI out of usage hands the task, in the same worktree, to an API worker that gets the summary and the file list", async (t) => {
  const fixture = await handoffFixture(t, "cli-to-api", {
    candidates: [CLAUDE, { ...API, priority: 2 }],
    cli: [CLAUDE_CONFIG],
    scenarios: [() => ({
      cli: "claude-code", stdout: cliFixture("claude-code/usage-limit.synthetic.stdout.jsonl"), exitCode: 1,
      actions: [{ write: "value.txt", content: "two\n" }, { write: "notes.txt", content: "half done\n" }],
    })],
    models: { [API.runtimeId]: apiCheckAndSubmit("check") },
  });
  const outcome = await fixture.driver.run(fixture.assignment);
  assert.equal(outcome.type, "submitted", JSON.stringify(outcome));

  // The adapter's failure went through provider_error: the session is suspended so, and Claude Code cools down.
  const suspended = fixture.sessions.events(SESSION).find((event) => event.type === "session.suspended");
  assert.equal(suspended?.payload.reason, "provider_error");
  assert.match(String(suspended?.payload.error), /usage limit/i);
  assert.equal(fixture.health.get("claude-code").status, "cooldown");
  assert.equal(fixture.health.get("claude-code").failureKind, "usage_limit");

  // The same attempt, session and worktree: the API worker takes over the CLI's half-done work.
  const assignments = fixture.assignments();
  assert.deepEqual(assignments.map((payload) => payload.runtimeId), [CLAUDE.runtimeId, API.runtimeId]);
  assert.deepEqual(assignments.map((payload) => payload.sessionId), [SESSION, SESSION]);
  assert.deepEqual((assignments[1]!.handoff as { fromRuntimeId: string; failureKind: string }).fromRuntimeId, CLAUDE.runtimeId);
  assert.equal(realpathSync.native(fixture.cliRun(1).cwd), realpathSync.native(fixture.workspace.path));
  assert.equal(readFileSync(join(fixture.workspace.path, "value.txt"), "utf8"), "two\n");

  // One continuation message, built from the CLI's latest attempt record.
  const request = fixture.models.get(API.runtimeId)!.requests[0]!;
  assert.equal(request.sessionId, SESSION);
  const handoffs = request.messages.filter((message) => message.id.startsWith("worker-handoff:"));
  assert.equal(handoffs.length, 1);
  const text = String(handoffs[0]!.content);
  assert.match(text, /AIBoard handoff: another worker worked on this task attempt before you/);
  assert.match(text, /The previous worker on this task attempt was the Claude Code worker claude-code:default\. It stopped: it ran out of usage \(usage_limit\): Claude usage limit reached/);
  assert.match(text, /The previous worker left no summary or text\./);
  assert.match(text, /lines added, lines removed, path\):\n1\t1\tvalue\.txt/);
  assert.match(text, /New files Git does not track yet \(facts the Runner read from Git\):\nnotes\.txt/);
  assert.match(text, /none is recorded for this attempt yet/);
  assert.match(text, /Do not repeat completed work/);
  // The rest of the API worker's resume path is unchanged.
  assert.match(messageText(request), /Resume the same durable task attempt/);
});

test("CW7: an API worker out of usage hands the task to a CLI that gets the summary, the file list and the evidence ids", async (t) => {
  const patch = { path: "value.txt", expectedSha256: createHash("sha256").update("one\n").digest("hex"), search: "one", replace: "two" };
  const fixture = await handoffFixture(t, "api-to-cli", {
    candidates: [API, { ...CLAUDE, priority: 2 }],
    cli: [CLAUDE_CONFIG],
    scenarios: [(fake) => ({ cli: "claude-code", stdout: writeClaudeStream(join(fake, "done.jsonl"), cliDoneResult("Checked the value.")) })],
    models: {
      [API.runtimeId]: [
        toolTurn("patch", "fs.patch", patch, "I changed value.txt to two; the check comes next."),
        toolTurn("check", "run_evidence_command", VALUE_CHECK),
        new ProviderTransportError("Quota exceeded for this key.", 429),
      ],
    },
  });
  const outcome = await fixture.driver.run(fixture.assignment);
  assert.equal(outcome.type, "submitted", JSON.stringify(outcome));
  assert.equal(fixture.health.get("primary").status, "cooldown");
  assert.equal(fixture.health.get("primary").failureKind, "usage_limit");
  assert.equal(fixture.health.get("claude-code").status, "healthy");

  const assignments = fixture.assignments();
  assert.deepEqual(assignments.map((payload) => payload.runtimeId), [API.runtimeId, CLAUDE.runtimeId]);
  assert.deepEqual(assignments[1]!.handoff, { fromRuntimeId: API.runtimeId, failureKind: "usage_limit", message: "Quota exceeded for this key." });

  // The CLI ran in the same worktree, and its prompt's "Earlier work" section is the handoff.
  const run = fixture.cliRun(1);
  assert.equal(realpathSync.native(run.cwd), realpathSync.native(fixture.workspace.path));
  const section = run.stdin.slice(run.stdin.indexOf("## Earlier work on this task"));
  assert.ok(section.startsWith("## Earlier work on this task\n"), run.stdin);
  assert.match(section, /The previous worker on this task attempt was the API worker primary:code \(model code\)\. It stopped: it ran out of usage \(usage_limit\): Quota exceeded for this key\./);
  assert.match(section, /This is its own claim; AIBoard has not checked it:\n<<<\nI changed value\.txt to two; the check comes next\.\n>>>/);
  assert.match(section, /lines added, lines removed, path\):\n1\t1\tvalue\.txt/);
  assert.match(section, new RegExp(`Evidence the Runner recorded for this attempt \\(facts\\): ${evidenceId("check")}\\.`));
  assert.match(section, /Do not repeat completed work/);
  // A new CLI session: nothing of this CLI's to resume.
  assert.ok(!fixture.launcher.starts[0]!.args.includes("--resume"));
});

test("CW7: the same CLI picked up again resumes its recorded session, with the other worker's work in its prompt", async (t) => {
  const fixture = await handoffFixture(t, "resume", {
    candidates: [CLAUDE, { ...API, priority: 2 }],
    cli: [CLAUDE_CONFIG],
    scenarios: [
      // A crash with no result: transient, and the first one does not cool Claude Code down (§3.8).
      (fake) => ({ cli: "claude-code", stdout: writeClaudeStream(join(fake, "crash.jsonl"), null, { working: true }), exitCode: 1 }),
      (fake) => ({ cli: "claude-code", stdout: writeClaudeStream(join(fake, "done.jsonl"), cliDoneResult()), actions: [{ write: "value.txt", content: "two\n" }] }),
    ],
    // The API worker's provider is down through every retry: it cools down, and the attempt goes back to Claude Code.
    models: { [API.runtimeId]: Array.from({ length: 6 }, () => new ProviderTransportError("upstream overloaded", 503)) },
  });
  const outcome = await fixture.driver.run(fixture.assignment);
  assert.equal(outcome.type, "submitted", JSON.stringify(outcome));
  assert.deepEqual(fixture.assignments().map((payload) => payload.runtimeId), [CLAUDE.runtimeId, API.runtimeId, CLAUDE.runtimeId]);
  assert.equal(fixture.health.get("primary").status, "cooldown");

  assert.equal(fixture.launcher.starts.length, 2);
  assert.ok(!fixture.launcher.starts[0]!.args.includes("--resume"));
  const resumed = fixture.launcher.starts[1]!.args;
  assert.equal(resumed[resumed.indexOf("--resume") + 1], FAKE_CLAUDE_SESSION, JSON.stringify(resumed));
  const section = fixture.cliRun(2).stdin.split("## Earlier work on this task\n")[1] ?? "";
  assert.match(section, /^The previous worker on this task attempt was the API worker primary:code \(model code\)\. It stopped: its provider was unavailable \(provider_unavailable\): upstream overloaded\./);
  // The first run's prompt had no such section: no worker before it.
  assert.doesNotMatch(fixture.cliRun(1).stdin, /## Earlier work on this task/);
});

test("CW7: every Codex worker cools down together, with the reset Codex stated", async (t) => {
  const codex = (model: string): AgentRuntimeCandidate => ({ runtimeId: `codex-cli:${model}`, providerId: "codex-cli", modelId: model, capabilities: ["code"], priority: 1, workerOnly: true });
  const config = (model: string): CliWorkerRuntimeConfig => ({ runtimeId: `codex-cli:${model}`, providerId: "codex-cli", model });
  const fixture = await handoffFixture(t, "codex", {
    candidates: [codex("gpt-a"), codex("gpt-b"), { ...API, priority: 2 }],
    cli: [config("gpt-a"), config("gpt-b")],
    scenarios: [() => ({ cli: "codex-cli", stdout: cliFixture("codex-cli/usage-limit-stated-reset.synthetic.stdout.jsonl"), exitCode: 1 })],
    models: { [API.runtimeId]: apiCheckAndSubmit("check") },
    // Codex stays refused on every OS in production (CW0b); only this test seam lifts it, to run the fake.
    runtime: { platformRefusal: () => undefined },
  });
  const outcome = await fixture.driver.run(fixture.assignment);
  assert.equal(outcome.type, "submitted", JSON.stringify(outcome));
  // One Codex launch: the other Codex model shares the provider's cooldown, so the API worker takes the task.
  assert.equal(fixture.launcher.starts.length, 1);
  assert.ok(fixture.launcher.starts[0]!.args.includes("gpt-a"));
  assert.deepEqual(fixture.assignments().map((payload) => payload.runtimeId), ["codex-cli:gpt-a", API.runtimeId]);
  const state = fixture.health.get("codex-cli");
  assert.equal(state.status, "cooldown");
  assert.equal(state.failureKind, "usage_limit");
  // "try again in 3 hours 12 minutes": the stated reset, within the second the run took.
  const stated = (3 * 60 + 12) * 60_000;
  const cooldown = state.cooldownUntil! - state.updatedAt;
  assert.ok(cooldown <= stated && cooldown > stated - 60_000, `${cooldown}`);
  const text = String(fixture.models.get(API.runtimeId)!.requests[0]!.messages.find((message) => message.id.startsWith("worker-handoff:"))?.content);
  assert.match(text, /the Codex CLI worker codex-cli:gpt-a\. It stopped: it ran out of usage \(usage_limit\): You've hit your usage limit/);
});
