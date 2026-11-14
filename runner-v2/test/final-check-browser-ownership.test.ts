// VF4b (docs/plans/2026-11-13-build-verification.md §4.5): a final check's Playwright CLI browser session, in memory.
// A `start` check whose program is `playwright-cli-session` and whose steps run `playwright-cli`. No process, no
// browser: the managed runtime and the one-shot executor are fakes, the git checkout is a temporary fixture. The
// real-browser run of the same check is final-check-browser-session.test.ts, outside PR CI.
//
// What it pins:
//   1. every process of the check runs for one owner: the program (managed, through the final-verification adapter)
//      and its steps (one-shot) have the same session id and actor, so the same CLI session name and state folder;
//   2. the program's launch and stop pass the run's managed stop observer, which records it as the owner's session;
//   3. the check's tool lookup searches the owner's PATH folders (the CLI shims), and without them the program reads
//      as `not_run: tool_missing` (the blocker before VF4b);
//   4. the run's browsing is configured before its inventory, so the pre-planning lookup sees the same PATH.
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { BuildRuntime } from "../src/build-runtime.js";
import { checkToolLookupFor, createCheckToolLookup, lookUpCheckTool, type CheckToolLookup } from "../src/check-tool-lookup.js";
import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import { observeManagedStops } from "../src/execution-host.js";
import { withResolvedVerificationPlan } from "../src/final-verification-profile.js";
import { ManagedProcessService } from "../src/managed-process.js";
import type { ManagedProcessRunRuntime } from "../src/managed-process-transport.js";
import type { OneShotCommandExecutor, OneShotCommandRequest } from "../src/one-shot-command-executor.js";
import {
  PLAYWRIGHT_CLI_COMMAND,
  PLAYWRIGHT_CLI_OUTPUT_FOLDER,
  PLAYWRIGHT_CLI_READY_PATTERN,
  PLAYWRIGHT_CLI_SESSION_COMMAND,
  playwrightCliSessionName,
  PlaywrightCliSessions,
} from "../src/playwright-cli.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { completeVerificationPlanV2, type VerificationPlanV2 } from "../src/verification-plan-v2.js";
import type { EnvironmentInventory } from "../src/verification-inventory.js";
import { emptyFinalVerificationProfile } from "./support/final-verification-profile.js";
import { captureGitBaseline, FinalVerificationRuntime, IntegrationManager, VerificationWorkspaceManager } from "./support/git-fixture.js";

const WINDOWS = process.platform === "win32";
const TASK_ID = "final-verification-0123456789ab";
const GENERATION_ID = "final-verification-generation-0123456789ab";
const at = "2026-11-14T00:00:00.000Z";

/** The check the design names: the session as the program, ready on its line, playwright-cli steps with outputs. */
function browserPlan(timeoutMs?: number): VerificationPlanV2 {
  const completed = completeVerificationPlanV2({
    checks: [{
      id: "home-page", label: "home page renders", kind: "start",
      start: {
        executable: PLAYWRIGHT_CLI_SESSION_COMMAND, args: [], ready: { outputLine: PLAYWRIGHT_CLI_READY_PATTERN },
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        steps: [
          { label: "open the page", executable: PLAYWRIGHT_CLI_COMMAND, args: ["--json", "goto", "http://127.0.0.1:9/"] },
          { label: "screenshot", executable: PLAYWRIGHT_CLI_COMMAND, args: ["--json", "screenshot", `--filename=${PLAYWRIGHT_CLI_OUTPUT_FOLDER}/home.png`],
            outputs: [`${PLAYWRIGHT_CLI_OUTPUT_FOLDER}/home.png`] },
        ],
      },
    }],
    skipped: [],
  }, []);
  assert.equal(completed.ok, true, completed.ok ? "" : completed.issues.join(" "));
  return (completed as { plan: VerificationPlanV2 }).plan;
}

/** Stand-ins for the two shims, where installPlaywrightCliShims puts them: only the lookup reads them here. */
function fakeShims(root: string): string {
  const bin = join(root, "pw", "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of [PLAYWRIGHT_CLI_SESSION_COMMAND, PLAYWRIGHT_CLI_COMMAND]) {
    const path = join(bin, WINDOWS ? `${name}.cmd` : name);
    writeFileSync(path, WINDOWS ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
    if (!WINDOWS) chmodSync(path, 0o755);
  }
  return bin;
}

/** The Runner's own PATH with none of the shims on it (an empty folder), as filteredEnvironmentSource gives it. */
function ambientWithoutShims(root: string): Record<string, string> {
  const empty = join(root, "empty-path");
  mkdirSync(empty, { recursive: true });
  return WINDOWS ? { Path: empty, PATHEXT: ".COM;.EXE;.BAT;.CMD" } : { PATH: empty };
}

interface Fixture { root: string; project: string; state: string; runId: string; integration: IntegrationManager }

/**
 * A temporary folder by its real path. The Runner compares paths with what git reports (`rev-parse --show-toplevel`
 * in IntegrationManager), and git reports real paths: macOS's tmpdir is under the /var -> /private/var link, and a
 * Windows CI runner's is an 8.3 short name (C:\Users\RUNNER~1). The same canonical roots the Runner's own state uses.
 */
function realTemporaryFolder(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
}

async function createFixture(name: string): Promise<Fixture> {
  const root = realTemporaryFolder(`aiboard-vf4b-${name}-`);
  const project = join(root, "user checkout");
  const state = join(root, "runner state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "README.md"), "baseline\n");
  const runId = `run_vf4b_${name.replace(/[^a-z0-9]+/gi, "_")}`;
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const integration = new IntegrationManager({ repositoryRoot: project, stateDirectory: state, runId, baselineRevision: baseline.revision });
  await integration.initialize();
  return { root, project, state, runId, integration };
}

interface Seen { kind: "program" | "step"; sessionId: string; actor: string; command: string; cliSession?: string; state?: string }

/** One final check through the real FinalVerificationRuntime and its managed adapter, with fake processes. */
async function runBrowserCheck(fixture: Fixture, lookup: CheckToolLookup, sessions: PlaywrightCliSessions,
  options: { silent?: boolean; timeoutMs?: number } = {}) {
  // The plan first: a plan the Runner refuses throws before anything is opened.
  const revision = fixture.integration.revision;
  const profile = withResolvedVerificationPlan(emptyFinalVerificationProfile(revision), browserPlan(options.timeoutMs));
  const seen: Seen[] = [];
  const stops: string[] = [];
  const envOf = (sessionId: string) => sessions.environmentFor({ runId: fixture.runId, sessionId })?.values;
  // silent: a daemon that never prints its ready line (a slow start on a loaded host).
  const stdout = options.silent ? "" : `${PLAYWRIGHT_CLI_READY_PATTERN} \\\\.\\pipe\\fixture`;
  const snapshot = (processId: string, status: "running" | "stopped") => ({ processId, pid: 4242, status, exitCode: status === "stopped" ? 0 : null,
    signal: null, startedAt: at, updatedAt: at, stdout, stderr: "" } as const);
  const managedRuntime: ManagedProcessRunRuntime = {
    runId: fixture.runId,
    async start(request) {
      assert.equal(request.context.sessionId, request.identity.sessionId, "the launch's context is its owner");
      const values = envOf(request.identity.sessionId);
      seen.push({ kind: "program", sessionId: request.identity.sessionId, actor: `${request.identity.actor.role}:${request.identity.actor.id}`,
        command: request.command, ...(values ? { cliSession: values.PLAYWRIGHT_CLI_SESSION, state: values.AIBOARD_PLAYWRIGHT_STATE } : {}) });
      return snapshot(request.identity.processId, "running");
    },
    // A stopped program stays stopped, so the service's own close finds nothing left to stop.
    async observe(target) { return snapshot(target.processId, stops.includes(target.processId) ? "stopped" : "running"); },
    async stop(target) { stops.push(target.processId); return snapshot(target.processId, "stopped"); },
  };
  let processSequence = 0;
  const service = new ManagedProcessService({
    stateDirectory: join(fixture.state, "managed"),
    // The run binding's own wrapping (execution-host.ts createRunBinding): the observer sees the launch and the stop.
    runtime: observeManagedStops(managedRuntime, sessions.stopObserver()),
    idFactory: () => `vf4b-${++processSequence}`,
  });
  const execution: OneShotCommandExecutor = {
    async execute(request: OneShotCommandRequest) {
      const values = envOf(request.context.sessionId);
      seen.push({ kind: "step", sessionId: request.context.sessionId, actor: `${request.context.actor.role}:${request.context.actor.id}`,
        command: request.executable, ...(values ? { cliSession: values.PLAYWRIGHT_CLI_SESSION, state: values.AIBOARD_PLAYWRIGHT_STATE } : {}) });
      if (request.arguments.includes("screenshot")) {
        mkdirSync(join(request.workingDirectory, PLAYWRIGHT_CLI_OUTPUT_FOLDER), { recursive: true });
        writeFileSync(join(request.workingDirectory, PLAYWRIGHT_CLI_OUTPUT_FOLDER, ".gitignore"), "*\n");
        writeFileSync(join(request.workingDirectory, PLAYWRIGHT_CLI_OUTPUT_FOLDER, "home.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      }
      return {
        process: {
          logicalProcessId: `vf4b-step-${seen.length}`, outcome: "exited", exitCode: 0, finishedAt: new Date().toISOString(),
          output: [
            { stream: "stdout", tail: "{\"isError\":false}", totalBytes: 17, truncated: false, spillBytes: 0, lossyBytes: 0 },
            { stream: "stderr", tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 },
          ],
          cleanup: { state: "verified_empty", verifiedAt: new Date().toISOString() },
        },
        enforcement: "unconfined_explicit_full",
        disclosure: "unconfined_explicit_full",
      };
    },
  };
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, `evidence-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`));
  const workspace = new VerificationWorkspaceManager({
    repositoryRoot: fixture.project, stateDirectory: fixture.state, runId: fixture.runId, targetRevision: fixture.integration.revision,
  });
  const runtime = new FinalVerificationRuntime({
    execution,
    managedProcessService: service,
    managedProcessAuthority: { executionGrants: createExecutionGrantAuthority(), permissionProfile: "full" },
    workspaceManager: workspace,
    artifacts,
    evidenceStore: evidence,
    runId: fixture.runId,
    taskId: TASK_ID,
    attempt: 1,
    generationId: GENERATION_ID,
    integrationRevision: () => revision,
    toolLookup: lookup,
  });
  try {
    const run = await runtime.runCheckV2({ executionProfile: profile, checkId: "home-page" });
    return { run, seen, stops, artifacts };
  } finally {
    await service.close().catch(() => undefined);
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
  }
}

test("VF4b every process of a final browser check runs for one owner: one CLI session, one state folder, the managed stop observer", async () => {
  const fixture = await createFixture("owner");
  try {
    const sessions = new PlaywrightCliSessions({ stateRoot: join(fixture.state, "pw"), binDirectory: fakeShims(fixture.state) });
    sessions.configureRun(fixture.runId, { browser: "chrome" });
    const lookup = createCheckToolLookup({ environment: () => ambientWithoutShims(fixture.root), processEnvironment: sessions.environmentFor });
    const { run, seen, artifacts } = await runBrowserCheck(fixture, lookup, sessions);
    assert.equal(run.check.outcome, "passed", run.check.issues.join("\n"));

    assert.deepEqual(seen.map((entry) => [entry.kind, entry.command]), [
      ["program", PLAYWRIGHT_CLI_SESSION_COMMAND],
      ["step", PLAYWRIGHT_CLI_COMMAND],
      ["step", PLAYWRIGHT_CLI_COMMAND],
    ], "the program, then its steps; the session command is launched by its bare name, as the observer recognizes it");
    // One owner: the session the one-shot commands always ran for (the task id), with the same actor.
    assert.deepEqual([...new Set(seen.map((entry) => entry.sessionId))], [TASK_ID]);
    assert.equal(new Set(seen.map((entry) => entry.actor)).size, 1, JSON.stringify(seen));
    // So one CLI session and one state folder, which before VF4b differed between the program and its steps.
    assert.deepEqual([...new Set(seen.map((entry) => entry.cliSession))], [playwrightCliSessionName(fixture.runId, TASK_ID)]);
    assert.deepEqual([...new Set(seen.map((entry) => entry.state))], [sessions.ownerFolder({ runId: fixture.runId, sessionId: TASK_ID })]);
    assert.notEqual(playwrightCliSessionName(fixture.runId, TASK_ID), playwrightCliSessionName(fixture.runId, `final-verification:${TASK_ID}`),
      "the pre-VF4b program owner named another session");

    // The program's stop went through the managed stop observer and proved the program stopped.
    const program = run.check.facts[0] as unknown as { cleanupRequested?: boolean; cleanupSucceeded?: boolean; readinessSatisfied?: boolean };
    assert.deepEqual([program.readinessSatisfied, program.cleanupRequested, program.cleanupSucceeded], [true, true, true]);
    if (!WINDOWS) {
      // POSIX: the observer ran the browser check for this owner's session process (Windows' Job proves the tree).
      const records = sessions.cleanupRecords().filter((record) => record.sessionId === TASK_ID);
      assert.equal(records.length, 1, JSON.stringify(sessions.cleanupRecords()));
      assert.equal(records[0]!.status, "none");
    }
    // The step's outputs are kept as evidence.
    const screenshot = run.check.facts[2] as unknown as { outputs?: { files: Array<{ path: string; artifactHash: string }> } };
    assert.deepEqual(screenshot.outputs?.files.map((file) => file.path), [`${PLAYWRIGHT_CLI_OUTPUT_FOLDER}/home.png`]);
    assert.equal((await artifacts.get(screenshot.outputs!.files[0]!.artifactHash)).subarray(1, 4).toString("latin1"), "PNG");
  } finally {
    await fixture.integration.cleanup().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("VF4b the check's lookup searches the owner's PATH folders; without them the session command is not_run: tool_missing and nothing starts", async () => {
  const fixture = await createFixture("lookup");
  try {
    const sessions = new PlaywrightCliSessions({ stateRoot: join(fixture.state, "pw"), binDirectory: fakeShims(fixture.state) });
    sessions.configureRun(fixture.runId, { browser: null });
    // VF2's lookup before VF4b: the Runner's filtered environment only.
    const before = createCheckToolLookup({ environment: () => ambientWithoutShims(fixture.root) });
    const { run, seen } = await runBrowserCheck(fixture, before, sessions);
    assert.equal(run.check.outcome, "not_run");
    assert.equal(run.check.notRun?.reason, "tool_missing");
    assert.equal(run.check.notRun?.tool, PLAYWRIGHT_CLI_SESSION_COMMAND);
    assert.deepEqual(seen, [], "a check with a missing tool launches nothing");
  } finally {
    await fixture.integration.cleanup().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("VF4b a session that never prints its ready line fails the check at the check's own readiness bound; no step runs and the program is stopped through the observer", async () => {
  const fixture = await createFixture("slow");
  try {
    const sessions = new PlaywrightCliSessions({ stateRoot: join(fixture.state, "pw"), binDirectory: fakeShims(fixture.state) });
    sessions.configureRun(fixture.runId, { browser: "chrome" });
    const lookup = createCheckToolLookup({ environment: () => ambientWithoutShims(fixture.root), processEnvironment: sessions.environmentFor });
    // The check's own start.timeoutMs bounds readiness (default 120 s); 1 s, the smallest a check accepts, keeps it fast.
    const { run, seen, stops } = await runBrowserCheck(fixture, lookup, sessions, { silent: true, timeoutMs: 1_000 });
    assert.equal(run.check.outcome, "failed", "a slow start is a failed check, never not_run");
    assert.equal(run.check.notRun, undefined);
    assert.ok(run.check.issues.some((issue) => /timed out before readiness/.test(issue)), run.check.issues.join("\n"));
    assert.deepEqual(seen.map((entry) => entry.kind), ["program"], "no step runs against a session that never became ready");
    assert.equal(stops.length, 1, "the program is stopped");
    const program = run.check.facts[0] as unknown as { readinessSatisfied?: boolean; timedOut?: boolean; cleanupRequested?: boolean; cleanupSucceeded?: boolean };
    assert.deepEqual([program.readinessSatisfied, program.timedOut, program.cleanupRequested, program.cleanupSucceeded], [false, true, true, true]);
    if (!WINDOWS) {
      // The stop went through the managed stop observer, which ran the browser check for this owner's session.
      assert.equal(sessions.cleanupRecords().filter((record) => record.sessionId === TASK_ID).length, 1, JSON.stringify(sessions.cleanupRecords()));
    }
  } finally {
    await fixture.integration.cleanup().catch(() => undefined);
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("VF4b lookUpCheckTool puts the owner's folders first, the way the launch does, and decides nothing from them alone", async () => {
  const root = realTemporaryFolder("aiboard-vf4b-lookup-");
  try {
    const bin = fakeShims(root);
    const ambient = ambientWithoutShims(root);
    const cwd = join(root, "checkout");
    mkdirSync(cwd);
    assert.equal((await lookUpCheckTool(PLAYWRIGHT_CLI_SESSION_COMMAND, { cwd, environment: ambient })).status, "missing");
    const found = await lookUpCheckTool(PLAYWRIGHT_CLI_SESSION_COMMAND, { cwd, environment: ambient, pathPrepend: [bin] });
    assert.equal(found.status, "found");
    assert.equal((found as { path: string }).path.toLowerCase().startsWith(bin.toLowerCase()), true, JSON.stringify(found));
    // The Runner's own PATH is still searched after the owner's folders.
    assert.equal((await lookUpCheckTool("not-a-real-tool-vf4b", { cwd, environment: ambient, pathPrepend: [bin] })).status, "missing");
    // With no PATH of the Runner's own, the owner's folders can find a tool but never prove one missing.
    const noPath = WINDOWS ? { PATHEXT: ".COM;.EXE;.BAT;.CMD" } : {};
    assert.equal((await lookUpCheckTool(PLAYWRIGHT_CLI_SESSION_COMMAND, { cwd, environment: noPath, pathPrepend: [bin] })).status, "found");
    assert.equal((await lookUpCheckTool("not-a-real-tool-vf4b", { cwd, environment: noPath, pathPrepend: [bin] })).status, "unknown");
    assert.equal((await lookUpCheckTool(PLAYWRIGHT_CLI_SESSION_COMMAND, { cwd, environment: noPath })).status, "unknown");

    // createCheckToolLookup reads the owner's folders from the Runner's resolver, only for an owner it is given,
    // and only while the run browses; checkToolLookupFor binds the owner.
    const runId = "run_vf4b_resolver";
    const sessions = new PlaywrightCliSessions({ stateRoot: join(root, "pw"), binDirectory: bin });
    const lookup = createCheckToolLookup({ environment: () => ambient, processEnvironment: sessions.environmentFor });
    const owner = { runId, sessionId: TASK_ID };
    assert.equal((await lookup(PLAYWRIGHT_CLI_SESSION_COMMAND, { cwd, owner })).status, "missing", "a run that does not browse gets no shims");
    sessions.configureRun(runId, { browser: null });
    assert.equal((await lookup(PLAYWRIGHT_CLI_SESSION_COMMAND, { cwd })).status, "missing", "no owner, no owner folders");
    assert.equal((await lookup(PLAYWRIGHT_CLI_SESSION_COMMAND, { cwd, owner })).status, "found");
    assert.equal((await checkToolLookupFor(lookup, owner)(PLAYWRIGHT_CLI_SESSION_COMMAND, { cwd })).status, "found");
    // The PATH folders are the same for every owner of the run, so the inventory's owner sees the check's PATH.
    assert.deepEqual(sessions.environmentFor({ runId, sessionId: "environment-inventory" })?.pathPrepend, sessions.environmentFor(owner)?.pathPrepend);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("VF4b a run's browsing is configured before its inventory, so the pre-planning lookup searches the run's PATH", async () => {
  const root = realTemporaryFolder("aiboard-vf4b-configure-");
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    const runId = "run_vf4b_configure";
    store.append({ runId, type: "run.initialized", occurredAt: at, actor: { role: "runner", id: "runner" }, idempotencyKey: "init", payload: { verificationContractVersion: 2 } });
    const order: string[] = [];
    const inventory: EnvironmentInventory = {
      version: 1, trigger: "planning", platform: process.platform, arch: process.arch, runnerNode: process.version,
      tools: [], toolsOmitted: 0, browsers: [], playwrightBrowser: "chrome", notes: [],
    };
    const runtime = new BuildRuntime({
      runId,
      store,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: { run: async () => { order.push("architect"); } },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
      clock: () => at,
      browsing: { configure: ({ cli, browser }) => { order.push(`configure:${String(cli)}:${String(browser)}`); } },
      environmentInventory: async ({ trigger }) => { order.push("inventory"); return { ...inventory, trigger }; },
    });
    await assert.rejects(() => runtime.step(), /without a typed action/i);
    assert.deepEqual(order.slice(0, 3), ["configure:true:null", "inventory", "configure:true:chrome"],
      "the run browses before its inventory looks a tool up, and takes the inventory's browser after it");
    assert.ok(order.includes("architect"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
