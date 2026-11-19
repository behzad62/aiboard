/**
 * CW5: the harness of the CLI worker loop's tests (cli-worker-runtime-*.test.ts): a git project, its task worktree,
 * the stores, a running task, and the fake CLI's streams. No real CLI is started and no prompt is sent.
 */
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext } from "node:test";
import { ArtifactStore } from "../../src/artifact-store.js";
import { captureWorkingTreeIdentity } from "../../src/command-evidence-identity.js";
import {
  CliWorkerOwners,
  cliAttemptRecords,
  type CliCheckRerunner,
  type CliProcessLauncher,
  type CliWorkerAttemptInput,
  type CliWorkerHostFacts,
  type CliWorkerLaunchSettings,
  type CliWorkerOwner,
  type CliWorkerRuntimeConfig,
  type CliWorkerRuntimeDeps,
} from "../../src/cli-worker-runtime.js";
import { SqliteBudgetLedger } from "../../src/sqlite-budget-ledger.js";
import { SqliteAgentSessionStore } from "../../src/sqlite-agent-session-store.js";
import { SqliteEvidenceStore } from "../../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../../src/sqlite-scheduler-store.js";
import { SqliteToolLedger } from "../../src/sqlite-tool-ledger.js";
import { workerSubmissionContext } from "../../src/worker-runtime.js";
import type { TaskWorkspace } from "../../src/workspace-manager.js";
import { FAKE_CLI_SCRIPT, writeFakeCliScenario, type FakeCliScenario } from "./fake-cli.js";
import { WorkspaceManager, asyncFixtureGitContext, captureGitBaseline, runGitAsync } from "./git-fixture.js";
import { ChildCliLauncher, FAKE_CLAUDE_SESSION, cliDoneResult, policyGit, writeClaudeStream } from "./cli-worker-fixture.js";

export const RUN = "run_1";
export const TASK = "task_a";
export const WORKER = "worker_task_a_1";
export const SESSION = "worker:run_1:task_a:1";
export const CLAUDE_SESSION = FAKE_CLAUDE_SESSION;
export const OWNER: CliWorkerOwner = Object.freeze({ runId: RUN, sessionId: SESSION, actor: Object.freeze({ role: "worker" as const, id: WORKER }) });
/** Windows with every fact verified: the loop's own gates are what each test varies. */
export const WINDOWS: CliWorkerHostFacts = Object.freeze({ platform: "win32", isRoot: false, jobContainment: "verified", windowsBatchArgv: "verified" });
export const CLAUDE: CliWorkerRuntimeConfig = Object.freeze({ runtimeId: "claude-code:default", providerId: "claude-code", model: "sonnet" });

// ---------------------------------------------------------------------------------------------------------------
// The harness: a git project, its task worktree, the stores, and a running task.

export interface Harness {
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

export async function harness(t: TestContext, label: string): Promise<Harness> {
  // Git reports the worktree by its real path (macOS /private/var, a Windows 8.3 name spelled out), as the launcher
  // gives the Runner its project and state folders: realpathSync.native expands 8.3 names, plain realpathSync does not.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), `aiboard-cli-worker-${label}-`)));
  // Registered before anything can throw (the worktree, the stores), so a failed setup still removes the folder.
  const closers: Array<() => void> = [];
  const launchers: ChildCliLauncher[] = [];
  t.after(async () => {
    // Every fake CLI this test started has exited before its folder (their working folder) is removed.
    await Promise.all(launchers.map((launcher) => launcher.settle()));
    for (const close of closers.reverse()) close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(state);
  // The project with its baseline is built once per test file and copied: the same files and baseline commit, in a
  // repository of this test's own (it has no worktree yet, so the copy holds no absolute path).
  const baseline = await baselineTemplate();
  cpSync(baseline.project, project, { recursive: true });
  const workspaces = new WorkspaceManager({ repositoryRoot: project, stateDirectory: state, runId: RUN, baselineRevision: baseline.revision, execute: policyGit });
  const workspace = await workspaces.createTaskWorkspace(TASK);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
  const ledger = new SqliteToolLedger(join(state, "tools.sqlite"));
  const scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
  const evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
  const budget = new SqliteBudgetLedger(join(state, "budget.sqlite"), { limitsFor: () => ({}) });
  closers.push(() => { sessions.close(); ledger.close(); scheduler.close(); evidence.close(); budget.close(); });
  seedRunningTask(scheduler);
  const owners = new CliWorkerOwners();
  const files = join(root, "fake");
  mkdirSync(files);
  let scenarios = 0;
  const h: Harness = {
    root, project, state, scheduler, sessions, evidence, budget, artifacts, ledger, workspaces, workspace, owners,
    scenario: (scenario) => writeFakeCliScenario(files, scenario, `scenario-${++scenarios}.json`),
    launcher: (scenario) => {
      const launcher = new ChildCliLauncher(h.scenario(scenario));
      launchers.push(launcher);
      return launcher;
    },
    deps: (launcher, overrides = {}) => ({
      schedulerStore: scheduler, sessions, workspaceManager: workspaces, launcher,
      settings: async (): Promise<CliWorkerLaunchSettings> => ({
        executable: { status: "found", path: process.execPath, source: "home", form: "exe" },
        attemptLimitMs: 60_000, argsPrefix: [FAKE_CLI_SCRIPT], version: "2.1.326",
      }),
      host: WINDOWS, stateDirectory: state, owners,
      captureTree: (cwd) => captureWorkingTreeIdentity(cwd, join(state, "tree-index"), runGitAsync),
      readWaitMs: 50,
      ...overrides,
    }),
    input: (overrides = {}) => ({
      runId: RUN, taskId: TASK, attempt: 1, workerId: WORKER, sessionId: SESSION, owner: OWNER, workspace, config: CLAUDE,
      contextText: "Change value.txt to two.",
      submission: workerSubmissionContext({
        git: asyncFixtureGitContext(), runId: RUN, sessionId: SESSION, taskId: TASK, actorId: WORKER, attempt: 1,
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
    head: async () => (await runGitAsync({ cwd: workspace.path, args: ["rev-parse", "HEAD"] })).stdout.trim(),
  };
  return h;
}

/**
 * How many of a file's tests run at once. Each harness is its own project, worktree, stores and owner; the files'
 * one shared value is the live-output buffer, which only the live tail test reads, outside the concurrent group.
 * On Windows a test's time is mostly process start latency (Git, the fake CLI), which overlaps well; elsewhere it is
 * mostly CPU, and more than two at once measured slower in a Linux container.
 */
export const CLI_RUNTIME_TEST_CONCURRENCY = process.platform === "win32" ? 4 : 2;

let template: Promise<{ project: string; revision: string }> | undefined;

/** The project every harness starts from, with the Runner's baseline captured once per test file. */
export function baselineTemplate(): Promise<{ project: string; revision: string }> {
  template ??= (async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-cli-worker-template-")));
    process.once("exit", () => { try { rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } catch { /* a temp folder */ } });
    const project = join(root, "project");
    const state = join(root, "state");
    mkdirSync(join(project, "docs", "project"), { recursive: true });
    mkdirSync(state);
    writeFileSync(join(project, "value.txt"), "one\n");
    writeFileSync(join(project, "docs", "project", "STATE.md"), "# State\n\nThe Architect's.\n");
    const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: RUN });
    return { project, revision: baseline.revision };
  })();
  return template;
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

export function claudeStream(h: Harness, structured: Record<string, unknown> | null, options: { isError?: boolean; result?: string; secretLine?: string } = {}): string {
  return writeClaudeStream(join(h.root, "fake", `claude-${++streams}.jsonl`), structured,
    { ...(options.isError ? { isError: true } : {}), ...(options.result ? { result: options.result } : {}), ...(options.secretLine ? { assistantText: options.secretLine } : {}) });
}

/** Claude Code's stream before its turn ends: the init event only. */
export function claudeWorking(h: Harness): string {
  return writeClaudeStream(join(h.root, "fake", `claude-${++streams}.jsonl`), null, { working: true });
}

let streams = 0;
export const done = cliDoneResult;

export function records(h: Harness) {
  return cliAttemptRecords(h.scheduler, { runId: RUN, taskId: TASK, attempt: 1, sessionId: SESSION });
}

export function recordFailure(h: Harness, reason: string, key: string): void {
  h.scheduler.append({
    runId: RUN, type: "task.transitioned", occurredAt: "2026-11-18T00:00:02.000Z",
    actor: { role: "runner", id: "scheduler" }, idempotencyKey: key,
    payload: { taskId: TASK, status: "failed", patch: { failureReason: reason } },
  });
}
