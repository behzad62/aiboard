/**
 * CW5: the CLI worker loop (docs/plans/2026-11-14-cli-workers.md §3.5, §3.7, §3.11) against the fake CLIs. No real CLI
 * is started and no prompt is sent: the fake (support/fake-cli.mjs) replays recorded or synthetic output.
 *
 * The launcher here runs the fake as an ordinary child process: it exercises the loop (stdin, the wait, the stop gate,
 * the collect) on every OS. The production launcher, through ManagedProcessService, has its own test at the end.
 * Host facts are injected, never read from this PC.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { captureWorkingTreeIdentity } from "../src/command-evidence-identity.js";
import {
  CLI_COLLECT_PENDING_PREFIX,
  CLI_COLLECT_WORKTREE_CHANGED,
  CliLaunchRefusedError,
  CliWorkerOwners,
  PROCESS_LAUNCH_UNPROVEN_PREFIX,
  PROCESS_LAUNCH_UNPROVEN_REPEATED_PREFIX,
  cliAttemptRecords,
  cliWorkerStateFolder,
  createManagedCliProcessLauncher,
  runCliWorkerAttempt,
  runnerLaunchRefusalCode,
  stdinChunks,
  type CliCheckRerunner,
  type CliProcessLauncher,
  type CliWorkerAttemptInput,
  type CliWorkerHostFacts,
  type CliWorkerLaunchSettings,
  type CliWorkerOwner,
  type CliWorkerRuntimeConfig,
  type CliWorkerRuntimeDeps,
} from "../src/cli-worker-runtime.js";
import { CLI_ATTEMPT_RECORDED_EVENT_TYPE } from "../src/cli-worker-attempt-record.js";
import { recentLiveModelOutput } from "../src/live-model-output.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { OwnedFenceLockUnavailableError } from "../src/owned-fence-lock.mjs";
import { AgentCleanupUnverifiedError } from "../src/process-stop-proof.js";
import { SqliteBudgetLedger } from "../src/sqlite-budget-ledger.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { workerSubmissionContext } from "../src/worker-runtime.js";
import type { TaskWorkspace } from "../src/workspace-manager.js";
import { FAKE_CLI_SCENARIO_ENV, FAKE_CLI_SCRIPT, cliFixture, writeFakeCliScenario, type FakeCliScenario } from "./support/fake-cli.js";
import { WorkspaceManager, captureGitBaseline, fixtureGitContext, runGit } from "./support/git-fixture.js";
import { ChildCliLauncher, FAKE_CLAUDE_SESSION, cliDoneResult, policyGit, writeClaudeStream } from "./support/cli-worker-fixture.js";

const RUN = "run_1";
const TASK = "task_a";
const WORKER = "worker_task_a_1";
const SESSION = "worker:run_1:task_a:1";
const CLAUDE_SESSION = FAKE_CLAUDE_SESSION;
const OWNER: CliWorkerOwner = Object.freeze({ runId: RUN, sessionId: SESSION, actor: Object.freeze({ role: "worker" as const, id: WORKER }) });
/** Windows with every fact verified: the loop's own gates are what each test varies. */
const WINDOWS: CliWorkerHostFacts = Object.freeze({ platform: "win32", isRoot: false, jobContainment: "verified", windowsBatchArgv: "verified" });
const CLAUDE: CliWorkerRuntimeConfig = Object.freeze({ runtimeId: "claude-code:default", providerId: "claude-code", model: "sonnet" });

// ---------------------------------------------------------------------------------------------------------------
// The harness: a git project, its task worktree, the stores, and a running task.

interface Harness {
  root: string;
  project: string;
  state: string;
  scheduler: SqliteSchedulerStore;
  sessions: SqliteAgentSessionStore;
  evidence: SqliteEvidenceStore;
  budget: SqliteBudgetLedger;
  artifacts: ArtifactStore;
  ledger: SqliteToolLedger;
  workspaces: WorkspaceManager;
  workspace: TaskWorkspace;
  owners: CliWorkerOwners;
  /** Writes the fake's scenario and returns its path. */
  scenario(scenario: FakeCliScenario): string;
  launcher(scenario: FakeCliScenario): ChildCliLauncher;
  deps(launcher: CliProcessLauncher, overrides?: Partial<CliWorkerRuntimeDeps>): CliWorkerRuntimeDeps;
  input(overrides?: Partial<CliWorkerAttemptInput>): CliWorkerAttemptInput;
  /** A check the Runner re-ran, recorded as this worker's evidence for the task's criterion (CW6's seam). */
  rerun: CliCheckRerunner;
  head(): Promise<string>;
}

async function harness(t: TestContext, label: string): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-cli-worker-${label}-`));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(join(project, "docs", "project"), { recursive: true });
  mkdirSync(state);
  writeFileSync(join(project, "value.txt"), "one\n");
  writeFileSync(join(project, "docs", "project", "STATE.md"), "# State\n\nThe Architect's.\n");
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: RUN });
  const workspaces = new WorkspaceManager({ repositoryRoot: project, stateDirectory: state, runId: RUN, baselineRevision: baseline.revision, execute: policyGit });
  const workspace = await workspaces.createTaskWorkspace(TASK);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
  const ledger = new SqliteToolLedger(join(state, "tools.sqlite"));
  const scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
  const evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
  const budget = new SqliteBudgetLedger(join(state, "budget.sqlite"), { limitsFor: () => ({}) });
  t.after(() => {
    sessions.close(); ledger.close(); scheduler.close(); evidence.close(); budget.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  seedRunningTask(scheduler);
  const owners = new CliWorkerOwners();
  const files = join(root, "fake");
  mkdirSync(files);
  let scenarios = 0;
  const h: Harness = {
    root, project, state, scheduler, sessions, evidence, budget, artifacts, ledger, workspaces, workspace, owners,
    scenario: (scenario) => writeFakeCliScenario(files, scenario, `scenario-${++scenarios}.json`),
    launcher: (scenario) => new ChildCliLauncher(h.scenario(scenario)),
    deps: (launcher, overrides = {}) => ({
      schedulerStore: scheduler, sessions, workspaceManager: workspaces, launcher,
      settings: async (): Promise<CliWorkerLaunchSettings> => ({
        executable: { status: "found", path: process.execPath, source: "home", form: "exe" },
        attemptLimitMs: 60_000, argsPrefix: [FAKE_CLI_SCRIPT], version: "2.1.326",
      }),
      host: WINDOWS, stateDirectory: state, owners,
      captureTree: (cwd) => captureWorkingTreeIdentity(cwd, join(state, "tree-index"), runGit),
      readWaitMs: 50,
      ...overrides,
    }),
    input: (overrides = {}) => ({
      runId: RUN, taskId: TASK, attempt: 1, workerId: WORKER, sessionId: SESSION, owner: OWNER, workspace, config: CLAUDE,
      contextText: "Change value.txt to two.",
      submission: workerSubmissionContext({
        git: fixtureGitContext(), runId: RUN, sessionId: SESSION, taskId: TASK, actorId: WORKER, attempt: 1,
        workspace, workspaceManager: workspaces, artifacts, ledger, schedulerStore: scheduler, evidenceStore: evidence,
      }),
      ...overrides,
    }),
    rerun: async ({ attempt }) => {
      const output = await artifacts.put(new Uint8Array(0), "text/plain", "check output");
      const record = evidence.record({
        runId: RUN, taskId: TASK, actor: { role: "worker", id: WORKER }, attempt, createdAt: "2026-11-18T00:00:01.000Z",
        idempotencyKey: `evidence:rerun:${attempt}`,
        fact: {
          kind: "command", label: "node --test", command: "node", args: ["--test"], cwd: ".",
          startedAt: "2026-11-18T00:00:00.000Z", finishedAt: "2026-11-18T00:00:01.000Z", exitCode: 0, signal: null,
          timedOut: false, cancelled: false, outputTruncated: false, stdoutArtifactHash: output.hash, stderrArtifactHash: output.hash,
        },
      });
      return { criterionEvidenceLinks: [{ criterionId: "value", evidenceId: record.id, artifactHashes: [output.hash] }], notRun: [] };
    },
    head: async () => (await runGit({ cwd: workspace.path, args: ["rev-parse", "HEAD"] })).stdout.trim(),
  };
  return h;
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

function claudeStream(h: Harness, structured: Record<string, unknown> | null, options: { isError?: boolean; result?: string; secretLine?: string } = {}): string {
  return writeClaudeStream(join(h.root, "fake", `claude-${++streams}.jsonl`), structured,
    { ...(options.isError ? { isError: true } : {}), ...(options.result ? { result: options.result } : {}), ...(options.secretLine ? { assistantText: options.secretLine } : {}) });
}

/** Claude Code's stream before its turn ends: the init event only. */
function claudeWorking(h: Harness): string {
  return writeClaudeStream(join(h.root, "fake", `claude-${++streams}.jsonl`), null, { working: true });
}

let streams = 0;
const done = cliDoneResult;

function records(h: Harness) {
  return cliAttemptRecords(h.scheduler, { runId: RUN, taskId: TASK, attempt: 1, sessionId: SESSION });
}

function recordFailure(h: Harness, reason: string, key: string): void {
  h.scheduler.append({
    runId: RUN, type: "task.transitioned", occurredAt: "2026-11-18T00:00:02.000Z",
    actor: { role: "runner", id: "scheduler" }, idempotencyKey: key,
    payload: { taskId: TASK, status: "failed", patch: { failureReason: reason } },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Outcomes

test("a done CLI run: prompt on stdin, its own commit undone, docs/project restored, the change submitted through the guarded commit", async (t) => {
  const h = await harness(t, "done");
  const before = await h.head();
  const record = join(h.root, "fake", "run.json");
  const launcher = h.launcher({
    cli: "claude-code", stdout: claudeStream(h, done()), record,
    actions: [{ write: "value.txt", content: "two\n" }, { write: "docs/project/STATE.md", content: "rewritten by the CLI\n" }, { commit: "cli commit" }, { write: "docs/project/new.md", content: "new\n" }],
  });
  const ledger = h.budget;
  const result = await runCliWorkerAttempt(h.deps(launcher, { budgetLedger: ledger, rerunChecks: h.rerun }), h.input());

  assert.equal(result.type, "submitted", JSON.stringify(result));
  const run = JSON.parse(readFileSync(record, "utf8")) as { argv: string[]; stdin: string; cwd: string };
  assert.match(run.stdin, /Change value\.txt to two\./);
  assert.match(run.stdin, /docs\/project\/ belong to the Architect/);
  assert.ok(run.argv.includes("--dangerously-skip-permissions"));
  assert.deepEqual(run.argv.slice(run.argv.indexOf("--model"), run.argv.indexOf("--model") + 2), ["--model", "sonnet"]);
  // The CLI's commit is gone: the guarded commit's single commit sits on the recorded tip.
  const parent = (await runGit({ cwd: h.workspace.path, args: ["rev-parse", "HEAD~1"] })).stdout.trim();
  assert.equal(parent, before);
  assert.equal(readFileSync(join(h.workspace.path, "value.txt"), "utf8"), "two\n");
  assert.equal(readFileSync(join(h.workspace.path, "docs", "project", "STATE.md"), "utf8"), "# State\n\nThe Architect's.\n");
  assert.equal(existsSync(join(h.workspace.path, "docs", "project", "new.md")), false);
  if (result.type !== "submitted") return;
  assert.deepEqual([...result.changeSet.changedPaths], ["value.txt"]);
  assert.ok(result.changeSet.unresolvedConcerns.some((concern) => /made 1 commit\(s\) of its own/.test(concern)));
  assert.ok(result.changeSet.unresolvedConcerns.some((concern) => /changed docs\/project/.test(concern)));
  const [recorded] = records(h);
  assert.equal(recorded?.collected, true);
  assert.equal(recorded?.outcome, "done");
  assert.equal(recorded?.replacedCliCommits, 1);
  assert.deepEqual(recorded?.restoredProjectDocs, ["docs/project/STATE.md", "docs/project/new.md"]);
  assert.equal(recorded?.reportedModel, "claude-sonnet-5-5");
  assert.equal(recorded?.model, "sonnet");
  assert.equal(recorded?.cliSessionId, CLAUDE_SESSION);
  assert.equal(recorded?.cliVersion, "2.1.326");
  // One usage entry: the reported tokens, cost 0 (the account is not metered).
  const usage = ledger.snapshot(RUN);
  assert.equal(usage.lifetime.outputTokens, 5);
  assert.equal(usage.lifetime.estimatedCostMicros, 0);
  assert.equal(launcher.stops, 1);
  assert.equal(h.owners.has(OWNER), false, "the owner's depth registration ends with its proven stop");
  // The session is submitted: a restart returns the same change set, starting no CLI.
  const again = await runCliWorkerAttempt(h.deps(launcher), h.input());
  assert.equal(again.type, "submitted");
  assert.equal(launcher.starts.length, 1);
});

test("without the Runner's re-runs (CW6) a done result has no evidence and is not submitted", async (t) => {
  const h = await harness(t, "no-evidence");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()), actions: [{ write: "value.txt", content: "two\n" }] });
  const result = await runCliWorkerAttempt(h.deps(launcher), h.input());
  assert.equal(result.type, "settled");
  assert.match(JSON.stringify(result), /cli_submission_refused/);
});

test("needs_decision asks the Architect and cannot_do requests a replan, both through the shared lifecycle functions", async (t) => {
  const h = await harness(t, "guidance");
  const ask = h.launcher({ cli: "claude-code", stdout: claudeStream(h, { ...done("Need a rule."), outcome: "needs_decision", question: "What should divide do for b = 0?", checks: [] }) });
  const asked = await runCliWorkerAttempt(h.deps(ask), h.input());
  assert.deepEqual(asked, { type: "guidance", requestId: "cli-task_a-1-1" });
  const projection = rebuildSchedulerProjection(h.scheduler.readRun(RUN));
  assert.equal(projection.guidance["cli-task_a-1-1"]?.status, "open");
  assert.match(projection.guidance["cli-task_a-1-1"]!.question, /What should divide do for b = 0\?/);
  const suspended = await h.sessions.load(SESSION);
  assert.equal(suspended.status, "suspended");
  assert.equal(suspended.suspensionReason, "waiting_for_architect");

  const h2 = await harness(t, "replan");
  const replan = h2.launcher({ cli: "claude-code", stdout: claudeStream(h2, { ...done("Out of scope."), outcome: "cannot_do", replanReason: "The factory lives in another task.", checks: [] }) });
  const replanned = await runCliWorkerAttempt(h2.deps(replan), h2.input());
  assert.deepEqual(replanned, { type: "guidance", requestId: "cli-task_a-1-1" });
  const request = rebuildSchedulerProjection(h2.scheduler.readRun(RUN)).guidance["cli-task_a-1-1"];
  assert.equal(request?.kind, "replan");
  assert.equal(request?.replan?.reason, "scope_exceeded");
  assert.match(request!.replan!.summary, /The factory lives in another task\./);
});

test("a run with no result is the CLI's failure, recorded collected, for the driver's failover", async (t) => {
  const h = await harness(t, "no-result");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, null, { isError: true, result: "API Error: 529 overloaded" }), exitCode: 1 });
  const result = await runCliWorkerAttempt(h.deps(launcher), h.input());
  assert.equal(result.type, "provider_failure");
  const [recorded] = records(h);
  assert.equal(recorded?.outcome, "failure");
  assert.equal(recorded?.collected, true);
  // Claude Code's result event ends the turn: its exit is not waited for (Codex's is).
  assert.equal(recorded?.exitCode, null);
  assert.ok(recorded?.failureKind);
});

test("rewritten history: the CLI reset the task branch below its recorded tip, so nothing is submitted", async (t) => {
  const h = await harness(t, "rewritten");
  // A Runner commit on the task branch is the recorded tip; the CLI resets the branch back past it.
  writeFileSync(join(h.workspace.path, "runner.txt"), "runner\n");
  await h.workspaces.commitWorkspace(h.workspace, "runner commit");
  const scriptPath = join(h.root, "fake", "reset.mjs");
  writeFileSync(scriptPath, `import { spawnSync } from "node:child_process";\nspawnSync("git", ["reset", "-q", "--hard", "HEAD~1"], { cwd: process.cwd() });\nawait import(${JSON.stringify(new URL(`file:///${FAKE_CLI_SCRIPT.replace(/\\/g, "/")}`).href)});\n`);
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()) });
  const deps = h.deps(launcher, {
    rerunChecks: h.rerun,
    settings: async () => ({ executable: { status: "found", path: process.execPath, source: "home", form: "exe" }, attemptLimitMs: 60_000, argsPrefix: [scriptPath] }),
  });
  const result = await runCliWorkerAttempt(deps, h.input());
  assert.equal(result.type, "settled");
  assert.match(JSON.stringify(result), /cli_history_rewritten: The task branch no longer contains the tip recorded before the CLI ran/);
  assert.equal(records(h)[0]?.collected, true);
});

test("the live tail shows the CLI's stdout as the worker's tool channel, redacted", async (t) => {
  const h = await harness(t, "live");
  const fakeKey = "placeholder-value-1234";
  const after = recentLiveModelOutput(RUN, 0).at(-1)?.sequence ?? 0;
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done(), { secretLine: `ANTHROPIC_API_KEY=${fakeKey}` }) });
  await runCliWorkerAttempt(h.deps(launcher), h.input());
  const events = recentLiveModelOutput(RUN, after).filter((event) => event.sessionId === SESSION);
  const deltas = events.filter((event) => event.phase === "delta");
  assert.ok(deltas.length > 0);
  assert.ok(deltas.every((event) => event.channel === "tool" && event.actor.role === "worker"));
  assert.equal(deltas.map((event) => event.text).join("").includes(fakeKey), false);
  assert.equal(events.at(-1)?.phase, "finish");
});

// ---------------------------------------------------------------------------------------------------------------
// §3.11 case 1: the Runner's own refusals

test("case 1: the Runner's refusals fail the attempt before any launch, and a second in the run pauses it", async (t) => {
  const h = await harness(t, "case1");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()) });
  const refused = async (host: CliWorkerHostFacts, config: CliWorkerRuntimeConfig = CLAUDE) =>
    await runCliWorkerAttempt(h.deps(launcher, { host }), h.input({ config }));

  assert.deepEqual(await refused({ ...WINDOWS, jobContainment: "partial" }),
    { type: "settled", outcome: { type: "failed", reason: `${PROCESS_LAUNCH_UNPROVEN_PREFIX}job_containment_unverified` } });
  assert.deepEqual(await refused({ platform: "linux", isRoot: false }),
    { type: "settled", outcome: { type: "failed", reason: `${PROCESS_LAUNCH_UNPROVEN_PREFIX}cli_worker_platform_refused` } });
  // Codex CLI stays refused on every OS (CW0b).
  for (const platform of ["win32", "linux", "darwin"] as const) {
    assert.deepEqual(await refused({ ...WINDOWS, platform }, { runtimeId: "codex-cli:default", providerId: "codex-cli", model: null }),
      { type: "settled", outcome: { type: "failed", reason: `${PROCESS_LAUNCH_UNPROVEN_PREFIX}cli_worker_platform_refused` } });
  }
  assert.equal(launcher.starts.length, 0);
  assert.equal(records(h).length, 0);

  recordFailure(h, `${PROCESS_LAUNCH_UNPROVEN_PREFIX}job_containment_unverified`, "fail:1");
  assert.deepEqual(await refused({ ...WINDOWS, jobContainment: "unavailable" }),
    { type: "settled", outcome: { type: "paused", reason: `${PROCESS_LAUNCH_UNPROVEN_REPEATED_PREFIX}job_containment_unverified` } });
});

test("case 1: a .cmd CLI on a host whose batch argv is unverified, or with an argv both launchers refuse, is refused before launch", async (t) => {
  const h = await harness(t, "cmd");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()) });
  const cmd = { status: "found" as const, path: "C:\\tools\\claude.cmd", source: "path" as const, form: "cmd" as const };
  const settings = async () => ({ executable: cmd, attemptLimitMs: 60_000 });
  // Claude Code's inline schema has quotes: a .cmd can never carry it.
  assert.deepEqual(await runCliWorkerAttempt(h.deps(launcher, { settings }), h.input()),
    { type: "settled", outcome: { type: "failed", reason: `${PROCESS_LAUNCH_UNPROVEN_PREFIX}cli_launch_argv_unsafe` } });
  recordFailure(h, `${PROCESS_LAUNCH_UNPROVEN_PREFIX}cli_launch_argv_unsafe`, "fail:cmd");
  assert.deepEqual(await runCliWorkerAttempt(h.deps(launcher, { settings, host: { ...WINDOWS, windowsBatchArgv: "unavailable" } }),
    h.input({ config: { runtimeId: "agy:default", providerId: "agy", model: null } })),
    { type: "settled", outcome: { type: "paused", reason: `${PROCESS_LAUNCH_UNPROVEN_REPEATED_PREFIX}windows_batch_argv_unverified` } });
  assert.equal(launcher.starts.length, 0);
});

test("case 1 is decided by code: a coded launch refusal after a proven cleanup, never a classified stop failure or an aggregate", async (t) => {
  assert.equal(runnerLaunchRefusalCode(Object.assign(new Error("x"), { code: "windows_batch_argv_unverified" })), "windows_batch_argv_unverified");
  assert.equal(runnerLaunchRefusalCode(new CliLaunchRefusedError("cli_launch_argv_unsafe", "x")), "cli_launch_argv_unsafe");
  assert.equal(runnerLaunchRefusalCode(new OwnedFenceLockUnavailableError("lock")), "owned_fence_unavailable");
  assert.equal(runnerLaunchRefusalCode(new Error("windows_batch_argv_unverified")), undefined, "message text never decides");
  assert.equal(runnerLaunchRefusalCode(new AggregateError([Object.assign(new Error("x"), { code: "windows_batch_argv_unverified" })])), undefined);
  assert.equal(runnerLaunchRefusalCode(new AgentCleanupUnverifiedError([new Error("x")], "stop")), undefined);

  const h = await harness(t, "start-refusal");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()) });
  launcher.startError = Object.assign(new Error("The host cannot launch .cmd files."), { code: "windows_batch_argv_unverified" });
  assert.deepEqual(await runCliWorkerAttempt(h.deps(launcher), h.input()),
    { type: "settled", outcome: { type: "failed", reason: `${PROCESS_LAUNCH_UNPROVEN_PREFIX}windows_batch_argv_unverified` } });
  assert.equal(h.owners.has(OWNER), false);
  // An uncoded start failure is not case 1: it is thrown for the scheduler to record.
  launcher.startError = new Error("spawn failed");
  await assert.rejects(runCliWorkerAttempt(h.deps(launcher), h.input()), /spawn failed/);
});

test("a missing or refused executable is the CLI's setup failure; an unknown one is case 1", async (t) => {
  const h = await harness(t, "executable");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()) });
  const run = (executable: CliWorkerLaunchSettings["executable"]) =>
    runCliWorkerAttempt(h.deps(launcher, { settings: async () => ({ executable, attemptLimitMs: 60_000 }) }), h.input());
  const missing = await run({ status: "missing", source: "path" });
  assert.equal(missing.type, "provider_failure");
  assert.equal(missing.type === "provider_failure" && missing.failure.kind, "authentication");
  const refused = await run({ status: "refused", source: "home", path: "claude", reason: "The executable path must be an absolute path." });
  assert.equal(refused.type === "provider_failure" && refused.failure.kind, "authentication");
  assert.deepEqual(await run({ status: "unknown", source: "home", reason: "could not be inspected" }),
    { type: "settled", outcome: { type: "failed", reason: `${PROCESS_LAUNCH_UNPROVEN_PREFIX}cli_executable_unknown` } });
  assert.equal(launcher.starts.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// §3.11 case 2: an unproven stop

test("case 2: a result whose stop is unproven is recorded uncollected; the proven retry collects it without a CLI", async (t) => {
  const h = await harness(t, "case2");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()), actions: [{ write: "value.txt", content: "two\n" }] });
  launcher.stopFailures = 1;
  const deps = h.deps(launcher, { rerunChecks: h.rerun });
  const first = await runCliWorkerAttempt(deps, h.input());
  assert.equal(first.type, "stop_unproven");
  if (first.type !== "stop_unproven") return;
  assert.deepEqual(first.outcome, { type: "paused", reason: `${CLI_COLLECT_PENDING_PREFIX}${TASK}` });
  assert.match(first.reason, /the stop of its processes is not proven: Shared managed cleanup did not prove release\./);
  const [pending] = records(h);
  assert.equal(pending?.collected, false);
  assert.ok(pending?.resultDigest && pending.worktree?.head && pending.worktree.tree);
  assert.equal(h.owners.has(OWNER), true, "the owner keeps its depth until its stop is proven");
  // Nothing was submitted, and the worktree still holds the CLI's change.
  assert.equal((await h.sessions.load(SESSION)).status !== "submitted", true);
  assert.equal(readFileSync(join(h.workspace.path, "value.txt"), "utf8"), "two\n");

  // The collect proves the stop itself, not only the scheduler's retried stop: still unproven, it keeps waiting.
  launcher.stopFailures = 1;
  const waiting = await runCliWorkerAttempt(deps, h.input());
  assert.deepEqual(waiting.type === "stop_unproven" && waiting.outcome, { type: "paused", reason: `${CLI_COLLECT_PENDING_PREFIX}${TASK}` });
  assert.equal(records(h).length, 1);
  const second = await runCliWorkerAttempt(deps, h.input());
  assert.equal(second.type, "submitted", JSON.stringify(second));
  assert.equal(launcher.starts.length, 1, "the collect starts no CLI");
  assert.deepEqual(records(h).map((record) => record.collected), [false, true]);
  assert.equal(h.owners.has(OWNER), false);
});

test("case 2: a worktree changed after the unproven stop is never collected", async (t) => {
  const h = await harness(t, "case2-changed");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()), actions: [{ write: "value.txt", content: "two\n" }] });
  launcher.stopFailures = 1;
  const deps = h.deps(launcher, { rerunChecks: h.rerun });
  assert.equal((await runCliWorkerAttempt(deps, h.input())).type, "stop_unproven");
  writeFileSync(join(h.workspace.path, "value.txt"), "three\n");
  const second = await runCliWorkerAttempt(deps, h.input());
  assert.equal(second.type, "settled");
  assert.match(JSON.stringify(second), new RegExp(`${CLI_COLLECT_WORKTREE_CHANGED}: the working files differ`));

  // The Runner's result file is checked against its digest too.
  const h2 = await harness(t, "case2-file");
  const launcher2 = h2.launcher({ cli: "claude-code", stdout: claudeStream(h2, done()) });
  launcher2.stopFailures = 1;
  const deps2 = h2.deps(launcher2);
  assert.equal((await runCliWorkerAttempt(deps2, h2.input())).type, "stop_unproven");
  const file = join(cliWorkerStateFolder(h2.state, RUN, SESSION), "run-1.result.json");
  writeFileSync(file, readFileSync(file, "utf8").replace("Changed value.txt", "Claimed value.txt"));
  assert.match(JSON.stringify(await runCliWorkerAttempt(deps2, h2.input())), /differs from its recorded digest/);
});

test("case 2: a CLI still running at an unproven stop keeps failed process_stop_unproven", async (t) => {
  const h = await harness(t, "case2-running");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeWorking(h), holdMs: 30_000 });
  launcher.stopFailures = 1;
  const result = await runCliWorkerAttempt(h.deps(launcher, { settings: async () => ({
    executable: { status: "found", path: process.execPath, source: "home", form: "exe" }, attemptLimitMs: 300, argsPrefix: [FAKE_CLI_SCRIPT],
  }) }), h.input());
  assert.equal(result.type, "stop_unproven");
  if (result.type !== "stop_unproven") return;
  assert.deepEqual(result.outcome, { type: "failed", reason: "process_stop_unproven" });
  assert.match(result.reason, /was stopped by the Runner's deadline without a result/);
  assert.equal(records(h).length, 0);
});

test("case 2: a browser left escaped by the stop leaves it unproven", async (t) => {
  const h = await harness(t, "case2-browser");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()) });
  let browser: "escaped" | "exited" = "escaped";
  const deps = h.deps(launcher, { rerunChecks: h.rerun, browser: { stopRecord: () => browser } });
  const first = await runCliWorkerAttempt(deps, h.input());
  assert.equal(first.type, "stop_unproven");
  assert.match(JSON.stringify(first), /the browser the CLI's session ran is still running/);
  browser = "exited";
  assert.equal((await runCliWorkerAttempt(deps, h.input())).type, "submitted");

  // Only the checks this stop recorded count: an earlier stop's escaped record never wedges a later one.
  const h2 = await harness(t, "case2-browser-since");
  const earlier = "2000-01-01T00:00:00.000Z";
  const sinces: string[] = [];
  const recorded = [{ at: earlier, status: "escaped" as const }];
  const deps2 = h2.deps(h2.launcher({ cli: "claude-code", stdout: claudeStream(h2, done()) }), {
    rerunChecks: h2.rerun,
    browser: { stopRecord: (_owner, since) => { sinces.push(since); return recorded.filter((entry) => entry.at >= since).at(-1)?.status; } },
  });
  assert.equal((await runCliWorkerAttempt(deps2, h2.input())).type, "submitted");
  assert.ok(sinces.length > 0 && sinces.every((since) => since > earlier && !Number.isNaN(Date.parse(since))));
});

test("the deadline stops a CLI that never ends its turn: the deadline outcome, not a CLI failure", async (t) => {
  const h = await harness(t, "deadline");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeWorking(h), holdMs: 30_000 });
  const result = await runCliWorkerAttempt(h.deps(launcher, { settings: async () => ({
    executable: { status: "found", path: process.execPath, source: "home", form: "exe" }, attemptLimitMs: 300, argsPrefix: [FAKE_CLI_SCRIPT],
  }) }), h.input());
  assert.equal(result.type, "settled");
  assert.match(JSON.stringify(result), /cli_attempt_deadline: Claude Code did not finish within its time limit/);
  assert.equal(records(h)[0]?.stoppedBy, "deadline");
});

test("a cancel stops the CLI and pauses the attempt", async (t) => {
  const h = await harness(t, "cancel");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeWorking(h), holdMs: 30_000 });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const result = await runCliWorkerAttempt(h.deps(launcher), h.input({ signal: controller.signal }));
  assert.deepEqual(result, { type: "settled", outcome: { type: "paused", reason: "worker_cancelled" } });
  assert.equal(records(h)[0]?.stoppedBy, "cancelled");
  assert.equal(launcher.stops, 1);
});

// ---------------------------------------------------------------------------------------------------------------
// §3.11 case 3, resume, Codex, stdin

test("a cancel that lands while the CLI is launching stops it and pauses the attempt", async (t) => {
  const h = await harness(t, "cancel-launch");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeWorking(h), holdMs: 30_000 });
  const controller = new AbortController();
  const start = launcher.start.bind(launcher);
  launcher.start = async (input) => {
    const handle = await start(input);
    controller.abort();
    return handle;
  };
  const result = await runCliWorkerAttempt(h.deps(launcher), h.input({ signal: controller.signal }));
  assert.deepEqual(result, { type: "settled", outcome: { type: "paused", reason: "worker_cancelled" } });
  assert.equal(launcher.stops, 1);
  assert.equal(h.owners.has(OWNER), false);
});

test("case 3: a browser session that does not start is recorded, and the CLI runs without a browser", async (t) => {
  const h = await harness(t, "case3");
  const record = join(h.root, "fake", "run3.json");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()), record });
  let rerunSawBrowser: boolean | undefined;
  const deps = h.deps(launcher, {
    browser: { start: async () => { throw new Error("playwright-cli is not installed"); } },
    rerunChecks: async (input) => { rerunSawBrowser = input.browserUnavailable; return await h.rerun(input); },
  });
  assert.equal((await runCliWorkerAttempt(deps, h.input())).type, "submitted");
  assert.match((JSON.parse(readFileSync(record, "utf8")) as { stdin: string }).stdin, /No browser is running for this task/);
  assert.deepEqual(records(h)[0]?.browser, { status: "start_failed", reason: "playwright-cli is not installed" });
  assert.equal(rerunSawBrowser, true);
});

test("a later run of the same attempt resumes the CLI's recorded session", async (t) => {
  const h = await harness(t, "resume");
  const first = h.launcher({ cli: "claude-code", stdout: claudeStream(h, null, { isError: true, result: "API Error: 500" }), exitCode: 1 });
  assert.equal((await runCliWorkerAttempt(h.deps(first), h.input())).type, "provider_failure");
  const record = join(h.root, "fake", "resume.json");
  const second = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()), record });
  await runCliWorkerAttempt(h.deps(second, { rerunChecks: h.rerun }), h.input());
  const argv = (JSON.parse(readFileSync(record, "utf8")) as { argv: string[] }).argv;
  assert.ok(argv.includes("--resume") || argv.includes(CLAUDE_SESSION), JSON.stringify(argv));
  assert.ok(argv.includes(CLAUDE_SESSION));
});

test("the Codex branch, run against the fake under a lifted test refusal: a stale -o file is deleted and read only after exit", async (t) => {
  const h = await harness(t, "codex");
  const folder = cliWorkerStateFolder(h.state, RUN, SESSION);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "last-message.json"), JSON.stringify(done("A stale earlier result.")));
  const launcher = h.launcher({ cli: "codex-cli", stdout: cliFixture("codex-cli/killed.windows.stdout.jsonl"), exitCode: 1 });
  const codex: CliWorkerRuntimeConfig = { runtimeId: "codex-cli:default", providerId: "codex-cli", model: null };
  const result = await runCliWorkerAttempt(h.deps(launcher, { platformRefusal: () => undefined }), h.input({ config: codex }));
  // The stale file never stands in for this run's result: the run without one is the CLI's failure.
  assert.equal(result.type, "provider_failure", JSON.stringify(result));
  assert.ok(launcher.starts[0]!.args.includes("-o"));
  assert.ok(existsSync(join(folder, "result.schema.json")));

  const h2 = await harness(t, "codex-ok");
  const okLauncher = h2.launcher({ cli: "codex-cli", stdout: cliFixture("codex-cli/success.windows.stdout.jsonl"), outputFile: cliFixture("codex-cli/success.windows.last-message.json") });
  const second = await runCliWorkerAttempt(h2.deps(okLauncher, { platformRefusal: () => undefined, rerunChecks: h2.rerun }), h2.input({ config: codex }));
  assert.notEqual(second.type, "provider_failure", JSON.stringify(second));
  assert.equal(records(h2)[0]?.outcome, "done");
});

test("restart: a run the Runner stopped during keeps its recorded tip, so the stopped CLI's commits are undone too", async (t) => {
  const h = await harness(t, "restart");
  const tip = await h.head();
  const crashed = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()) });
  crashed.startError = new Error("the Runner stopped");
  await assert.rejects(runCliWorkerAttempt(h.deps(crashed), h.input()), /the Runner stopped/);
  // What the stopped CLI left: a commit of its own, and a result file no record digested.
  writeFileSync(join(h.workspace.path, "value.txt"), "three\n");
  await runGit({ cwd: h.workspace.path, args: ["-c", "user.name=Fake CLI", "-c", "user.email=fake-cli@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-am", "stopped"] });
  writeFileSync(join(cliWorkerStateFolder(h.state, RUN, SESSION), "run-1.result.json"), "{}\n");
  const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()), actions: [{ write: "value.txt", content: "two\n" }, { commit: "cli" }] });
  const result = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: h.rerun }), h.input());
  assert.equal(result.type, "submitted", JSON.stringify(result));
  assert.equal(records(h)[0]?.replacedCliCommits, 2);
  assert.equal((await runGit({ cwd: h.workspace.path, args: ["rev-parse", "HEAD~1"] })).stdout.trim(), tip);
});

test("a run whose wait fails after the launch stands only once the owner's stop is proven", async (t) => {
  const h = await harness(t, "wait-fails");
  const failing = (stopFailures: number): CliProcessLauncher & { stops: number } => {
    const launcher = {
      stops: 0,
      async start() {
        return { processId: "proc", async write() { throw new Error("The CLI's stdin was not delivered (refused)."); }, async read() { throw new Error("unused"); } };
      },
      async stopOwner() {
        launcher.stops += 1;
        if (stopFailures-- > 0) throw Object.assign(new Error("Shared managed cleanup did not prove release."), { code: "process_cleanup_unverified" });
      },
    };
    return launcher;
  };
  const unproven = failing(1);
  const result = await runCliWorkerAttempt(h.deps(unproven), h.input());
  assert.equal(result.type, "stop_unproven");
  assert.deepEqual((result as { outcome: unknown }).outcome, { type: "failed", reason: "process_stop_unproven" });
  assert.match((result as { reason: string }).reason, /stdin was not delivered.*the stop of its processes is not proven/);
  assert.equal(h.owners.has(OWNER), true);
  const proven = failing(0);
  await assert.rejects(runCliWorkerAttempt(h.deps(proven), h.input()), /stdin was not delivered/);
  assert.equal(proven.stops, 1);
  assert.equal(h.owners.has(OWNER), false);
});

test("the prompt goes to stdin in writes under the managed limit, never splitting a surrogate pair", () => {
  const text = `${"a".repeat(16 * 1024 - 1)}😀${"b".repeat(40_000)}`;
  const chunks = stdinChunks(text);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, "utf8") <= 64 * 1024));
  assert.ok(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk)));
  assert.deepEqual(stdinChunks(""), [""]);
});

test("the CLI's records are refused unless written by the Runner's driver for a known task attempt", async (t) => {
  const h = await harness(t, "record-gate");
  const payload = {
    version: 1, taskId: TASK, attempt: 1, workerId: WORKER, sessionId: SESSION, runtimeId: CLAUDE.runtimeId, providerId: "claude-code",
    exitCode: 0, outcome: "done", collected: true,
  };
  assert.throws(() => h.scheduler.append({
    runId: RUN, type: CLI_ATTEMPT_RECORDED_EVENT_TYPE, occurredAt: "2026-11-18T00:00:03.000Z",
    actor: { role: "worker", id: WORKER }, idempotencyKey: "forged", payload,
  }));
  assert.throws(() => h.scheduler.append({
    runId: RUN, type: CLI_ATTEMPT_RECORDED_EVENT_TYPE, occurredAt: "2026-11-18T00:00:03.000Z",
    actor: { role: "runner", id: "native-worker-driver" }, idempotencyKey: "wrong-attempt", payload: { ...payload, attempt: 2 },
  }));
  assert.throws(() => h.scheduler.append({
    runId: RUN, type: CLI_ATTEMPT_RECORDED_EVENT_TYPE, occurredAt: "2026-11-18T00:00:03.000Z",
    actor: { role: "runner", id: "native-worker-driver" }, idempotencyKey: "uncollected-without-worktree", payload: { ...payload, collected: false },
  }));
});

// ---------------------------------------------------------------------------------------------------------------
// The production launcher: ManagedProcessService, its owner's Job or group, its grants.

test("the managed launcher runs the fake as the worker's owner and its stop proves the detached grandchild stopped", { skip: process.platform !== "win32" && "a detached grandchild leaves a POSIX group (CW0); Windows' Job holds it" }, async (t) => {
  const h = await harness(t, "managed");
  const record = join(h.root, "fake", "managed.json");
  const scenarioPath = h.scenario({
    cli: "claude-code", stdout: claudeStream(h, done()), record, grandchildMs: 60_000, grandchildDetached: true,
    actions: [{ write: "value.txt", content: "two\n" }],
  });
  const ambient = { ...snapshotNativeBuildAmbientEnvironment(), [FAKE_CLI_SCENARIO_ENV]: scenarioPath };
  const managedHost = createExecutionHost({ projectRoot: h.project, stateDirectory: h.state, artifacts: h.artifacts, ambientEnvironment: ambient });
  const run = await managedHost.bindRun({
    runId: RUN, permissionProfile: "full", capabilityContract: { digest: "d".repeat(64) } as RunnerCapabilityContract,
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(), processEnvironment: h.owners.environmentFor,
  });
  try {
  const launcher = createManagedCliProcessLauncher({ managedProcesses: run.managedProcesses, executionGrants: run.executionGrants, permissionProfile: "full" });
  const facts = await managedHost.windowsProcessFacts?.();
  const result = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: h.rerun, host: { ...WINDOWS, jobContainment: facts?.jobContainment ?? "unavailable" } }), h.input());
  if (facts?.jobContainment !== "verified") {
    assert.match(JSON.stringify(result), /job_containment_unverified/);
    return;
  }
  assert.equal(result.type, "submitted", JSON.stringify(result));
  const { grandchildPid } = JSON.parse(readFileSync(record, "utf8")) as { grandchildPid: number };
  assert.throws(() => process.kill(grandchildPid, 0), "the owner's stop proved the detached grandchild stopped");
  } finally {
    await run.close();
  }
});
