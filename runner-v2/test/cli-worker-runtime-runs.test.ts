/**
 * CW5: the CLI worker loop (docs/plans/2026-11-14-cli-workers.md §3.5, §3.7, §3.11), part 3 of 3: runs over time (a
 * resumed CLI session, the Codex branch, a restart, the recorded tip, a relaunch's budget entry) and the production
 * launcher, ManagedProcessService, which runs the fake as the worker's owner. No real CLI is started and no prompt is
 * sent; host facts are injected.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import {
  cliAttemptRecords,
  cliWorkerStateFolder,
  createManagedCliProcessLauncher,
  runCliWorkerAttempt,
  type CliProcessLauncher,
  type CliWorkerHostFacts,
  type CliWorkerOwner,
  type CliWorkerRuntimeConfig,
} from "../src/cli-worker-runtime.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { workerSubmissionContext } from "../src/worker-runtime.js";
import { FAKE_CLI_SCENARIO_ENV, cliFixture, fakeGrandchildAlive, type FakeCliRecord } from "./support/fake-cli.js";
import { fixtureGitContext, runGit } from "./support/git-fixture.js";
import { RUN, TASK, WORKER, SESSION, CLAUDE_SESSION, OWNER, WINDOWS, harness, claudeStream, records, done, CLI_RUNTIME_TEST_CONCURRENCY } from "./support/cli-worker-runtime-harness.js";

// Each test has its own project, worktree, stores and owner, so a file's tests run side by side: most of their
// time is Git and the fake CLI, which overlap. A test that reads process-wide state runs alone, outside the group.
describe("CW5 loop: runs over time and the managed launcher", { concurrency: CLI_RUNTIME_TEST_CONCURRENCY }, () => {
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

  test("§3.7: the recorded tip is the Runner's own last commit, never HEAD, so a CLI commit an earlier run left is undone by the next collect", async (t) => {
    const h = await harness(t, "runner-tip");
    // The Runner's guarded commit is the tip a later run is measured against.
    writeFileSync(join(h.workspace.path, "runner.txt"), "runner\n");
    await h.workspaces.commitWorkspace(h.workspace, "runner commit");
    const runnerCommit = await h.head();
    assert.equal(await h.workspaces.runnerTip(h.workspace), runnerCommit);
    // An earlier session's CLI ran and exited without its run being collected: its commit stays on the branch.
    writeFileSync(join(h.workspace.path, "value.txt"), "left by an earlier CLI\n");
    await runGit({ cwd: h.workspace.path, args: ["-c", "user.name=Fake CLI", "-c", "user.email=fake-cli@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-am", "left behind"] });
    assert.equal(await h.workspaces.runnerTip(h.workspace), runnerCommit, "a commit the Runner did not make never moves the tip");
    // The next session's CLI commits too; its collect undoes both and sends the content through the guarded commit.
    const session = `${SESSION}:next`;
    const owner: CliWorkerOwner = { ...OWNER, sessionId: session };
    const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()), actions: [{ write: "value.txt", content: "two\n" }, { commit: "cli" }] });
    const input = h.input({
      sessionId: session, owner,
      submission: workerSubmissionContext({
        git: fixtureGitContext(), runId: RUN, sessionId: session, taskId: TASK, actorId: WORKER, attempt: 1,
        workspace: h.workspace, workspaceManager: h.workspaces, artifacts: h.artifacts, ledger: h.ledger, schedulerStore: h.scheduler, evidenceStore: h.evidence,
      }),
    });
    const result = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: h.rerun }), input);
    assert.equal(result.type, "submitted", JSON.stringify(result));
    const [recorded] = cliAttemptRecords(h.scheduler, { runId: RUN, taskId: TASK, attempt: 1, sessionId: session });
    assert.equal(recorded?.replacedCliCommits, 2);
    assert.equal((await runGit({ cwd: h.workspace.path, args: ["rev-parse", "HEAD~1"] })).stdout.trim(), runnerCommit);
    assert.equal(readFileSync(join(h.workspace.path, "value.txt"), "utf8"), "two\n");
    const author = (await runGit({ cwd: h.workspace.path, args: ["log", "-1", "--format=%an"] })).stdout.trim();
    assert.notEqual(author, "Fake CLI");
    // The guarded commit is now the Runner's tip.
    assert.equal(await h.workspaces.runnerTip(h.workspace), await h.head());
  });

  test("a run launched again under the same run number keeps its own budget entry, never an idempotency conflict", async (t) => {
    const h = await harness(t, "budget-relaunch");
    // The first launch's wait fails after a proven stop: its reservation settles at zero and nothing is recorded.
    const failing: CliProcessLauncher = {
      async start() {
        return { processId: "proc", async write() {}, async read(): Promise<never> { throw new Error("The CLI's output could not be read."); } };
      },
      async stopOwner() {},
    };
    await assert.rejects(runCliWorkerAttempt(h.deps(failing, { budgetLedger: h.budget }), h.input()), /output could not be read/);
    // The same run number, launched again (as after a restart), settles its own reported usage.
    const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()), actions: [{ write: "value.txt", content: "two\n" }] });
    const result = await runCliWorkerAttempt(h.deps(launcher, { budgetLedger: h.budget, rerunChecks: h.rerun }), h.input());
    assert.equal(result.type, "submitted", JSON.stringify(result));
    assert.equal(records(h).length, 1);
    const usage = h.budget.snapshot(RUN);
    assert.equal(usage.lifetime.outputTokens, 5);
    assert.equal(usage.lifetime.modelCalls, 2);
  });

  test("the managed launcher runs the fake as the worker's owner at AIBOARD_MCP_DEPTH 2, and on Windows its stop proves the detached grandchild stopped", async (t) => {
    const h = await harness(t, "managed");
    const record = join(h.root, "fake", "managed.json");
    // A detached grandchild leaves a POSIX group (CW0), so only Windows' Job, which holds it, runs one here.
    const windows = process.platform === "win32";
    const scenarioPath = h.scenario({
      cli: "claude-code", stdout: claudeStream(h, done()), record, recordMcpDepth: true,
      ...(windows ? { grandchildMs: 60_000, grandchildDetached: true } : {}),
      actions: [{ write: "value.txt", content: "two\n" }],
    });
    const ambient = { ...snapshotNativeBuildAmbientEnvironment(), [FAKE_CLI_SCENARIO_ENV]: scenarioPath };
    // The host's process facts are injected, as cli-worker-processes.test.ts does (their probe alone is about 9 s on
    // Windows). They name the Job as the only backend, with no portable fallback, so a Job that does not hold the
    // grandchild fails this test instead of passing on a fallback. GitHub's Windows image verifies Job containment.
    const managedHost = createExecutionHost({ projectRoot: h.project, stateDirectory: h.state, artifacts: h.artifacts, ambientEnvironment: ambient,
      ...(windows ? { processHostFacts: { portableDuplex: "unavailable", windowsBatchArgv: "unavailable", exactTreeBirth: "verified", jobContainment: "verified" } as const } : {}) });
    const run = await managedHost.bindRun({
      runId: RUN, permissionProfile: "full", capabilityContract: { digest: "d".repeat(64) } as RunnerCapabilityContract,
      capabilitiesConfig: emptyRunnerCapabilitiesConfig(), processEnvironment: h.owners.environmentFor,
    });
    try {
    const launcher = createManagedCliProcessLauncher({ managedProcesses: run.managedProcesses, executionGrants: run.executionGrants, permissionProfile: "full" });
    const facts = windows ? await managedHost.windowsProcessFacts?.() : undefined;
    const host: CliWorkerHostFacts = windows ? { ...WINDOWS, jobContainment: facts?.jobContainment ?? "unavailable" } : { platform: process.platform, isRoot: false };
    assert.equal(facts?.jobContainment, windows ? "verified" : undefined, "the injected facts reach the launch");
    // Off Windows a CLI worker is refused for now (CLI_WORKER_PLATFORM_REFUSALS); the depth wiring through the run
    // binding is the same there, so this run lifts that one refusal.
    const result = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: h.rerun, host, ...(windows ? {} : { platformRefusal: () => undefined }) }), h.input());
    assert.equal(result.type, "submitted", JSON.stringify(result));
    const ran = JSON.parse(readFileSync(record, "utf8")) as FakeCliRecord;
    // The owner's depth registration reaches the CLI through the run binding's per-owner environment (§3.11).
    assert.equal(ran.mcpDepth, "2");
    if (windows) assert.equal(fakeGrandchildAlive(ran), false, "the owner's stop proved the detached grandchild stopped");
    } finally {
      // The host too, not only the run's binding: its Job host and fact probe keep pipes open, and on GitHub's Windows
      // image an unclosed host kept this file's process alive after its last test (CI run 44307474932).
      try {
        await run.close();
      } finally {
        await managedHost.close();
      }
    }
  });
});
