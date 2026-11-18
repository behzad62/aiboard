/**
 * CW5: the CLI worker loop (docs/plans/2026-11-14-cli-workers.md §3.5, §3.7, §3.11), part 1 of 3: a run's outcomes,
 * its history and project-docs handling, the live tail, and §3.11 case 1 (the Runner's own refusals). No real CLI is
 * started and no prompt is sent: the fake (support/fake-cli.mjs) replays recorded or synthetic output. Host facts are
 * injected, never read from this PC. The harness is support/cli-worker-runtime-harness.ts.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe } from "node:test";
import { pathToFileURL } from "node:url";
import {
  CliLaunchRefusedError,
  PROCESS_LAUNCH_UNPROVEN_PREFIX,
  PROCESS_LAUNCH_UNPROVEN_REPEATED_PREFIX,
  runCliWorkerAttempt,
  runnerLaunchRefusalCode,
  stdinChunks,
  type CliWorkerHostFacts,
  type CliWorkerLaunchSettings,
  type CliWorkerRuntimeConfig,
} from "../src/cli-worker-runtime.js";
import { CLI_ATTEMPT_RECORDED_EVENT_TYPE } from "../src/cli-worker-attempt-record.js";
import { recentLiveModelOutput } from "../src/live-model-output.js";
import { OwnedFenceLockUnavailableError } from "../src/owned-fence-lock.mjs";
import { AgentCleanupUnverifiedError } from "../src/process-stop-proof.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { FAKE_CLI_SCRIPT } from "./support/fake-cli.js";
import { runGit } from "./support/git-fixture.js";
import {
  RUN,
  TASK,
  WORKER,
  SESSION,
  CLAUDE_SESSION,
  OWNER,
  WINDOWS,
  CLAUDE,
  harness,
  claudeStream,
  records,
  recordFailure,
  done,
  CLI_RUNTIME_TEST_CONCURRENCY,
} from "./support/cli-worker-runtime-harness.js";

// Each test has its own project, worktree, stores and owner, so a file's tests run side by side: most of their
// time is Git and the fake CLI, which overlap. A test that reads process-wide state runs alone, outside the group.
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

describe("CW5 loop: outcomes and case 1", { concurrency: CLI_RUNTIME_TEST_CONCURRENCY }, () => {
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
    writeFileSync(scriptPath, `import { spawnSync } from "node:child_process";\nspawnSync("git", ["reset", "-q", "--hard", "HEAD~1"], { cwd: process.cwd() });\nawait import(${JSON.stringify(pathToFileURL(FAKE_CLI_SCRIPT).href)});\n`);
    const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()) });
    const deps = h.deps(launcher, {
      rerunChecks: h.rerun,
      settings: async () => ({ executable: { status: "found", path: process.execPath, source: "home", form: "exe" }, attemptLimitMs: 60_000, argsPrefix: [scriptPath] }),
    });
    const result = await runCliWorkerAttempt(deps, h.input());
    assert.equal(result.type, "settled");
    assert.match(JSON.stringify(result), /cli_history_rewritten:rewritten: The task branch no longer contains the tip recorded before the CLI ran/);
    assert.equal(records(h)[0]?.collected, true);
  });

  test("§3.7: a worktree an earlier CLI left detached keeps its files, and no CLI starts in it: a coded failure for the Architect", async (t) => {
    const h = await harness(t, "detached");
    writeFileSync(join(h.workspace.path, "value.txt"), "left by an earlier CLI\n");
    await runGit({ cwd: h.workspace.path, args: ["checkout", "-q", "--detach"] });
    const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()) });
    const result = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: h.rerun }), h.input());
    assert.deepEqual(result, { type: "settled", outcome: { type: "failed", reason:
      "cli_history_rewritten:detached: HEAD is detached from the task branch. The task's worktree is kept as the CLI left it, and no CLI run is started in it again; replan the work as a new task." } });
    assert.equal(launcher.starts.length, 0);
    assert.equal(readFileSync(join(h.workspace.path, "value.txt"), "utf8"), "left by an earlier CLI\n");
    assert.equal(h.owners.has(OWNER), false);
  });

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

  test("a throw before the launch (here the prompt) ends the owner's depth registration, starting nothing", async (t) => {
    const h = await harness(t, "prompt-throws");
    const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, done()) });
    await assert.rejects(runCliWorkerAttempt(h.deps(launcher), h.input({ contextText: "   " })), /prompt needs the task context/);
    assert.equal(launcher.starts.length, 0);
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
});
