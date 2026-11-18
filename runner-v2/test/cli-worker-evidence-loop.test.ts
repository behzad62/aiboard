/**
 * CW6: the Runner's re-runs of the checks a CLI worker reported (docs/plans/2026-11-14-cli-workers.md §3.6), part 2 of
 * 2: the CLI loop with the fake CLI (support/fake-cli.mjs) and the production one-shot executor: Runner evidence that
 * satisfies the submission rule on the submitted tree, the one fix round that resumes the CLI's session, and the
 * attempt's failure after it. No real CLI is started and no prompt is sent. Part 1 is cli-worker-evidence.test.ts.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { describe, type TestContext } from "node:test";

import { createCheckToolLookup } from "../src/check-tool-lookup.js";
import { CLI_CHECKS_FAILING, CLI_CHECKS_RERUN_FAILED, CLI_CHECKS_UNSUPPORTED, createCliCheckRerunner } from "../src/cli-worker-evidence.js";
import { CLI_RERUNS_PENDING_PREFIX, cliWorkerStateFolder, runCliWorkerAttempt, type CliCheckRerunner, type CliProcessLauncher, type CliWorkerOwner } from "../src/cli-worker-runtime.js";
import { captureWorkingTreeIdentity, restoreWorkingTree } from "../src/command-evidence-identity.js";
import { RUNNER_RERUN_OF_CLI_CLAIM, type CommandEvidenceFact } from "../src/evidence-store.js";
import type { RunGitExecutionContext } from "../src/git-run-context.js";
import type { OneShotCommandExecutor } from "../src/one-shot-command-executor.js";
import { ChildCliLauncher, policyGit } from "./support/cli-worker-fixture.js";
import { CLI_RUNTIME_TEST_CONCURRENCY, harness, claudeStream, records, CLAUDE_SESSION, RUN, SESSION, TASK, WORKER, type Harness } from "./support/cli-worker-runtime-harness.js";
import { asyncFixtureGitContext, runGitAsync } from "./support/git-fixture.js";
import { createTestOneShotCommandExecutor } from "./support/one-shot-command-executor.js";

/** The fixture's Git with a working-tree capture, so each record carries the tree it ran on. */
function gitWithTrees(execution: OneShotCommandExecutor, indexRoot: string): RunGitExecutionContext {
  return { ...asyncFixtureGitContext("full", execution), workingTreeForCall: (_context, cwd) => captureWorkingTreeIdentity(cwd, indexRoot, runGitAsync) };
}

/** One fake CLI per launch, in order: the first run, then the fix round. */
class SequenceLauncher implements CliProcessLauncher {
  private next = 0;
  constructor(readonly launchers: ChildCliLauncher[]) {}
  get starts() { return this.launchers.flatMap((launcher) => launcher.starts); }
  async start(input: Parameters<CliProcessLauncher["start"]>[0]) {
    const launcher = this.launchers[this.next++];
    if (!launcher) throw new Error("The fake CLI was launched more often than the test expects.");
    return await launcher.start(input);
  }
  async stopOwner(owner: CliWorkerOwner) {
    for (const launcher of this.launchers) await (launcher as CliProcessLauncher).stopOwner(owner);
  }
}

/** A check that passes when value.txt holds `expected`, run by the Runner's real one-shot executor. */
function valueCheck(expected: string, criterionIds: string[] | null = ["value"]): Record<string, unknown> {
  return {
    label: "value check", executable: process.execPath,
    args: ["-e", `const v=require('node:fs').readFileSync('value.txt','utf8').trim();if(v!==${JSON.stringify(expected)}){console.log('value is '+v);process.exit(1)}`],
    cwd: null, outputs: null, criterionIds,
  };
}

function doneWith(checks: Record<string, unknown>[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { outcome: "done", summary: "Changed value.txt to two.", question: null, replanReason: null, checks, notRun: [], concerns: [], ...extra };
}

/**
 * The fix-round tests run each check in-process: the value check's result, from value.txt in the folder the Runner
 * would run it in, without a process. The first test runs it through the production one-shot executor.
 */
function inProcessValueChecks(): OneShotCommandExecutor {
  return {
    async execute(request) {
      const value = readFileSync(join(request.workingDirectory, "value.txt"), "utf8").trim();
      const expected = /v!==("[^"]*")/.exec(request.arguments.join(" "))?.[1];
      const passed = expected !== undefined && value === JSON.parse(expected);
      const stdout = passed ? "" : `value is ${value}\n`;
      const now = new Date().toISOString();
      return {
        process: {
          logicalProcessId: "in-process-value-check", outcome: "exited", exitCode: passed ? 0 : 1, finishedAt: now,
          output: [
            { stream: "stdout", tail: stdout, totalBytes: stdout.length, truncated: false, spillBytes: 0, lossyBytes: 0 },
            { stream: "stderr", tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 },
          ],
          cleanup: { state: "verified_empty", verifiedAt: now },
        },
        enforcement: "unconfined_explicit_full",
        disclosure: "unconfined_explicit_full",
      } as Awaited<ReturnType<OneShotCommandExecutor["execute"]>>;
    },
  };
}

function realRerunner(t: TestContext, h: Harness, inProcess = false): CliCheckRerunner {
  const execution = inProcess ? inProcessValueChecks() : createTestOneShotCommandExecutor(t, { artifacts: h.artifacts });
  const indexRoot = join(h.state, "tree-index");
  return createCliCheckRerunner({
    git: gitWithTrees(execution, indexRoot),
    evidenceStore: h.evidence,
    artifacts: h.artifacts,
    execution,
    ledger: h.ledger,
    permissionProfile: "full",
    toolLookup: createCheckToolLookup({ environment: () => process.env }),
    captureTree: (cwd) => captureWorkingTreeIdentity(cwd, indexRoot, runGitAsync),
    restoreTree: (cwd, treeId) => restoreWorkingTree(cwd, indexRoot, policyGit, treeId),
  });
}

/** Claude Code's stream with no session id: a run whose session cannot be resumed. */
let noSessionStreams = 0;
function claudeStreamWithoutSession(h: Harness, structured: Record<string, unknown>): string {
  const path = join(h.root, "fake", `claude-no-session-${++noSessionStreams}.jsonl`);
  const lines = [
    { type: "system", subtype: "init", model: "claude-sonnet-test" },
    { type: "result", subtype: "success", is_error: false, structured_output: structured, result: "", usage: { input_tokens: 10, output_tokens: 5 } },
  ];
  writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");
  return path;
}

function stdinOf(path: string): string {
  return (JSON.parse(readFileSync(path, "utf8")) as { stdin: string }).stdin;
}

function argvOf(path: string): string[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { argv: string[] }).argv;
}

describe("CW6 loop: re-runs, the fix round and its failures", { concurrency: CLI_RUNTIME_TEST_CONCURRENCY }, () => {
  test("a CLI's done is submitted on the Runner's re-runs: evidence on the submitted tree, the CLI's report marked, a missing tool not run", async (t) => {
    const h = await harness(t, "evidence-submit");
    const launcher = h.launcher({
      cli: "claude-code",
      stdout: claudeStream(h, doneWith([
        valueCheck("two"),
        { label: "dotnet tests", executable: "aiboard-cw6-missing-tool", args: ["test"], cwd: null, outputs: null, criterionIds: ["value"] },
      ], { notRun: [{ what: "the UI", why: "no browser" }], concerns: ["the parser is slow"] })),
      actions: [{ write: "value.txt", content: "two\n" }],
    });
    const result = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: realRerunner(t, h) }), h.input());
    assert.equal(result.type, "submitted", JSON.stringify(result));
    if (result.type !== "submitted") return;
    const [link] = result.changeSet.criterionEvidenceLinks ?? [];
    assert.ok(link);
    const record = h.evidence.getByIds({ runId: RUN, taskId: TASK, ids: [link.evidenceId] })[0]!;
    assert.equal(record.actor.id, WORKER);
    assert.equal((record.fact as CommandEvidenceFact).source, RUNNER_RERUN_OF_CLI_CLAIM);
    assert.equal((record.fact as CommandEvidenceFact).exitCode, 0);
    // The tree the evidence was recorded on is the tree submitted.
    const submittedTree = (await runGitAsync({ cwd: h.workspace.path, args: ["rev-parse", `${result.changeSet.taskRevision}^{tree}`] })).stdout.trim();
    assert.equal(link.freshness?.status, "current", JSON.stringify(link.freshness));
    assert.equal(link.freshness?.evidenceTreeId, submittedTree);
    assert.equal(link.freshness?.submittedTreeId, submittedTree);
    // The CLI's summary, notRun and concerns are its report; the missing tool is the Runner's not-run line, not a failure.
    const message = (await runGitAsync({ cwd: h.workspace.path, args: ["log", "-1", "--format=%s", result.changeSet.taskRevision] })).stdout.trim();
    assert.match(message, /^Claude Code worker reports: /);
    assert.ok(result.changeSet.unresolvedConcerns.includes("Claude Code reported: the parser is slow"));
    assert.equal(h.evidence.list({ runId: RUN, taskId: TASK }).length, 1, "the missing tool ran nothing");
    assert.equal(launcher.starts.length, 1, "no fix round");
  });

  test("a criterion no re-run supports gets one fix round that resumes the CLI's session; a gap after it fails as cli_checks_unsupported", async (t) => {
    const h = await harness(t, "evidence-unsupported");
    const first = join(h.root, "fake", "first.json"), second = join(h.root, "fake", "second.json");
    const unlinked = doneWith([valueCheck("two", null), { label: "both", executable: "npm", args: ["test", "&&", "npm", "run", "lint"], cwd: null, outputs: null, criterionIds: ["value"] }]);
    const launcher = new SequenceLauncher([
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, unlinked), record: first, actions: [{ write: "value.txt", content: "two\n" }] }),
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, unlinked), record: second }),
    ]);
    const result = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: realRerunner(t, h, true) }), h.input());
    assert.equal(result.type, "settled", JSON.stringify(result));
    assert.equal(result.type === "settled" && result.outcome.type, "failed");
    assert.match(JSON.stringify(result), new RegExp(`${CLI_CHECKS_UNSUPPORTED}: after its fix round.*value: value\\.txt holds two`));
    assert.equal(launcher.starts.length, 2, "exactly one fix round");
    // The fix round resumes the session with the re-run results, the missing criterion and the shell-line rule.
    assert.ok(argvOf(second).includes("--resume") && argvOf(second).includes(CLAUDE_SESSION), JSON.stringify(argvOf(second)));
    const prompt = stdinOf(second);
    assert.match(prompt, /Fix round: the Runner's re-runs of your checks/);
    assert.match(prompt, /value check .*passed \[no criteria\]/);
    assert.match(prompt, /- value: value\.txt holds two\./);
    assert.match(prompt, /one program and its arguments/);
    assert.doesNotMatch(prompt, /Change value\.txt to two\./, "the resumed session already has the task");
    assert.doesNotMatch(stdinOf(first), /Fix round/);
    assert.deepEqual(records(h).map((record) => [record.outcome, record.collected]), [["done", true], ["done", true]]);
    assert.notEqual((await h.sessions.load(h.input().sessionId)).status, "submitted");
  });

  test("a failing re-run gets the fix round, with the failing output, and the CLI's fix is submitted", async (t) => {
    const h = await harness(t, "evidence-fixed");
    const second = join(h.root, "fake", "fixed.json");
    const launcher = new SequenceLauncher([
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([valueCheck("two")])), actions: [{ write: "value.txt", content: "three\n" }, { commit: "cli commit" }] }),
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([valueCheck("two")])), record: second, actions: [{ write: "value.txt", content: "two\n" }] }),
    ]);
    const result = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: realRerunner(t, h, true) }), h.input());
    assert.equal(result.type, "submitted", JSON.stringify(result));
    assert.match(stdinOf(second), /value check .*failed, exit 1/);
    assert.match(stdinOf(second), /value is three/, "the failing output's tail");
    if (result.type !== "submitted") return;
    assert.deepEqual([...result.changeSet.changedPaths], ["value.txt"]);
    // The first run's commit was undone before its re-runs; the submission after the fix round still says so.
    assert.ok(result.changeSet.unresolvedConcerns.some((concern) => /made 1 commit\(s\) of its own/.test(concern)), JSON.stringify(result.changeSet.unresolvedConcerns));
  });

  test("a re-run still failing after the fix round fails the attempt as cli_checks_failing, starting no third run", async (t) => {
    const h = await harness(t, "evidence-failing");
    const launcher = new SequenceLauncher([
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([valueCheck("two")])), actions: [{ write: "value.txt", content: "three\n" }] }),
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([valueCheck("two")])) }),
    ]);
    const result = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: realRerunner(t, h, true) }), h.input());
    // A failed attempt: the scheduler records it as the task's failure, and the Architect's attempt rules requeue it.
    assert.equal(result.type === "settled" && result.outcome.type, "failed", JSON.stringify(result));
    assert.match(JSON.stringify(result), new RegExp(`${CLI_CHECKS_FAILING}: after its fix round.*value check .*exit 1`));
    assert.equal(launcher.starts.length, 2);
  });

  test("a re-run whose stop is not proven holds the attempt with the CLI's tree; the next entry restores it and re-runs, starting no CLI", async (t) => {
    const h = await harness(t, "evidence-restart");
    const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([valueCheck("two")])), actions: [{ write: "value.txt", content: "two\n" }] });
    // The first entry's re-run changes a file, and its processes are not proven gone (a Runner restart leaves the same).
    const unproven: CliCheckRerunner = async (input) => {
      writeFileSync(join(input.workspace.path, "value.txt"), "changed by a re-run\n");
      throw Object.assign(new Error("Shared managed cleanup did not prove release."), { code: "process_cleanup_unverified" });
    };
    const restoreTree = (cwd: string, treeId: string) => restoreWorkingTree(cwd, join(h.state, "tree-index"), policyGit, treeId);
    const held = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: unproven, restoreTree }), h.input());
    assert.equal(held.type, "stop_unproven", JSON.stringify(held));
    assert.deepEqual((held as { outcome: unknown }).outcome, { type: "paused", reason: `${CLI_RERUNS_PENDING_PREFIX}${TASK}` });
    assert.match((held as { reason: string }).reason, /did not prove its processes stopped: Shared managed cleanup did not prove release/);
    const pending = join(cliWorkerStateFolder(h.state, RUN, SESSION), "reruns-pending.json");
    assert.ok(existsSync(pending), "the tree the CLI left stays persisted");
    const result = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: realRerunner(t, h, true), restoreTree }), h.input());
    assert.equal(result.type, "submitted", JSON.stringify(result));
    assert.equal(launcher.starts.length, 1, "no CLI is started again");
    assert.equal(readFileSync(join(h.workspace.path, "value.txt"), "utf8"), "two\n", "the re-run's change was restored before the re-runs");
    assert.equal(existsSync(pending), false);
    if (result.type === "submitted") assert.deepEqual([...result.changeSet.changedPaths], ["value.txt"]);
  });

  test("any other re-runner failure proves the owner's stop, puts the CLI's tree back and fails the attempt as cli_checks_rerun_failed", async (t) => {
    const h = await harness(t, "evidence-rerun-failed");
    const restoreTree = (cwd: string, treeId: string) => restoreWorkingTree(cwd, join(h.state, "tree-index"), policyGit, treeId);
    const pending = join(cliWorkerStateFolder(h.state, RUN, SESSION), "reruns-pending.json");
    // A re-run cut short by an error the classifier does not know: what it changed is put back once the stop is proven.
    const launcher = h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([valueCheck("two")])), actions: [{ write: "value.txt", content: "two\n" }] });
    const throwing: CliCheckRerunner = async (input) => {
      writeFileSync(join(input.workspace.path, "value.txt"), "changed by a re-run\n");
      throw new Error("the tree index could not be written");
    };
    const stopsBefore = launcher.stops;
    const result = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: throwing, restoreTree }), h.input());
    assert.equal(result.type === "settled" && result.outcome.type, "failed", JSON.stringify(result));
    assert.match(JSON.stringify(result), new RegExp(`${CLI_CHECKS_RERUN_FAILED}: the tree index could not be written`));
    assert.ok(launcher.stops > stopsBefore, "the owner's stop ran before the failure");
    assert.equal(readFileSync(join(h.workspace.path, "value.txt"), "utf8"), "two\n", "the re-run's change was put back");
    assert.equal(existsSync(pending), false);
    assert.notEqual((await h.sessions.load(SESSION)).status, "submitted");

    // The owner's stop not proven on that path: the attempt is held with the CLI's tree, like a re-run's own unproven stop.
    const h2 = await harness(t, "evidence-rerun-failed-unproven");
    const launcher2 = h2.launcher({ cli: "claude-code", stdout: claudeStream(h2, doneWith([valueCheck("two")])), actions: [{ write: "value.txt", content: "two\n" }] });
    const throwing2: CliCheckRerunner = async () => { launcher2.stopFailures = 1; throw new Error("the tree index could not be written"); };
    const restoreTree2 = (cwd: string, treeId: string) => restoreWorkingTree(cwd, join(h2.state, "tree-index"), policyGit, treeId);
    const held = await runCliWorkerAttempt(h2.deps(launcher2, { rerunChecks: throwing2, restoreTree: restoreTree2 }), h2.input());
    assert.equal(held.type, "stop_unproven", JSON.stringify(held));
    assert.deepEqual((held as { outcome: unknown }).outcome, { type: "paused", reason: `${CLI_RERUNS_PENDING_PREFIX}${TASK}` });
    assert.match((held as { reason: string }).reason, /the tree index could not be written.*the stop of the owner's processes is not proven/);
    assert.ok(existsSync(join(cliWorkerStateFolder(h2.state, RUN, SESSION), "reruns-pending.json")), "the CLI's tree stays persisted");
  });

  test("a fix round whose run ends in a provider failure stays pending: the next entry gets it, inside a time limit of its own", async (t) => {
    const h = await harness(t, "evidence-fix-provider");
    const third = join(h.root, "fake", "after-provider.json");
    const launcher = new SequenceLauncher([
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([valueCheck("two")])), actions: [{ write: "value.txt", content: "three\n" }] }),
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, null, { isError: true, result: "API Error: 529 overloaded" }), exitCode: 1 }),
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([valueCheck("two")])), record: third, actions: [{ write: "value.txt", content: "two\n" }] }),
    ]);
    const deps = h.deps(launcher, { rerunChecks: realRerunner(t, h, true) });
    const failure = await runCliWorkerAttempt(deps, h.input());
    assert.equal(failure.type, "provider_failure", JSON.stringify(failure));
    const result = await runCliWorkerAttempt(deps, h.input());
    assert.equal(result.type, "submitted", JSON.stringify(result));
    assert.equal(launcher.starts.length, 3);
    // The fix round was sent once already, so this launch gets the task again before it.
    assert.match(stdinOf(third), /Change value\.txt to two\.[\s\S]*Fix round: the Runner's re-runs of your checks[\s\S]*value is three/);
    assert.deepEqual(records(h).map((record) => record.outcome), ["done", "failure", "done"]);
  });

  test("a Runner that stops before the fix round's launch runs it on its next entry, resuming the CLI's session with the fix round", async (t) => {
    const h = await harness(t, "evidence-fix-restart");
    const fixed = join(h.root, "fake", "fixed.json");
    // The first launcher has no second run: the fix round's launch throws, as a Runner that stopped there would leave it.
    const first = new SequenceLauncher([
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([valueCheck("two")])), actions: [{ write: "value.txt", content: "three\n" }] }),
    ]);
    await assert.rejects(runCliWorkerAttempt(h.deps(first, { rerunChecks: realRerunner(t, h, true) }), h.input()), /launched more often/);
    const second = new SequenceLauncher([
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([valueCheck("two")])), record: fixed, actions: [{ write: "value.txt", content: "two\n" }] }),
    ]);
    const result = await runCliWorkerAttempt(h.deps(second, { rerunChecks: realRerunner(t, h, true) }), h.input());
    assert.equal(result.type, "submitted", JSON.stringify(result));
    assert.ok(argvOf(fixed).includes("--resume"), JSON.stringify(argvOf(fixed)));
    assert.match(stdinOf(fixed), /Fix round: the Runner's re-runs of your checks[\s\S]*value is three/);
    assert.doesNotMatch(stdinOf(fixed), /Change value\.txt to two\./, "the resumed session already has the task");
  });

  test("a CLI session that cannot be resumed gets the task again before its fix round", async (t) => {
    const h = await harness(t, "evidence-no-resume");
    const second = join(h.root, "fake", "no-resume.json");
    const launcher = new SequenceLauncher([
      h.launcher({ cli: "claude-code", stdout: claudeStreamWithoutSession(h, doneWith([valueCheck("two")])), actions: [{ write: "value.txt", content: "three\n" }] }),
      h.launcher({ cli: "claude-code", stdout: claudeStreamWithoutSession(h, doneWith([valueCheck("two")])), record: second, actions: [{ write: "value.txt", content: "two\n" }] }),
    ]);
    const result = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: realRerunner(t, h, true) }), h.input());
    assert.equal(result.type, "submitted", JSON.stringify(result));
    assert.equal(argvOf(second).includes("--resume"), false, JSON.stringify(argvOf(second)));
    assert.match(stdinOf(second), /Change value\.txt to two\.[\s\S]*Fix round: the Runner's re-runs of your checks/);
  });

  test("a fix round stays pending through a question: the run after the answer gets it, and its done has no fix round left", async (t) => {
    const h = await harness(t, "evidence-fix-question");
    const third = join(h.root, "fake", "after-answer.json");
    const launcher = new SequenceLauncher([
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([valueCheck("two")])), actions: [{ write: "value.txt", content: "three\n" }] }),
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([], { outcome: "needs_decision", question: "Should value.txt hold two or three?" })) }),
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([valueCheck("two")])), record: third }),
    ]);
    const deps = h.deps(launcher, { rerunChecks: realRerunner(t, h, true) });
    const asked = await runCliWorkerAttempt(deps, h.input());
    assert.equal(asked.type, "guidance", JSON.stringify(asked));
    // The Architect answered; the attempt goes on with the answer in its context.
    const result = await runCliWorkerAttempt(deps, h.input({ contextText: "Change value.txt to two.\n\nThe Architect answered: two." }));
    assert.equal(result.type === "settled" && result.outcome.type, "failed", JSON.stringify(result));
    assert.match(JSON.stringify(result), new RegExp(`${CLI_CHECKS_FAILING}: after its fix round`));
    assert.equal(launcher.starts.length, 3, "no second fix round");
    assert.ok(argvOf(third).includes("--resume"));
    assert.match(stdinOf(third), /The Architect answered: two\.[\s\S]*Fix round: the Runner's re-runs of your checks/);
  });

  test("the fix round runs inside the attempt's deadline: a deadline already past fails the attempt before its launch", async (t) => {
    const h = await harness(t, "evidence-fix-deadline");
    let offset = 0;
    const rerunner = realRerunner(t, h, true);
    // The re-runs take the rest of the first run's 60 s limit (the harness's attemptLimitMs).
    const slow: CliCheckRerunner = async (input) => {
      const out = await rerunner(input);
      offset += 120_000;
      return out;
    };
    const launcher = new SequenceLauncher([
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([valueCheck("two")])), actions: [{ write: "value.txt", content: "three\n" }] }),
    ]);
    const result = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: slow, now: () => Date.now() + offset }), h.input());
    assert.equal(result.type === "settled" && result.outcome.type, "failed", JSON.stringify(result));
    assert.match(JSON.stringify(result), /cli_attempt_deadline: Claude Code reached its time limit for one attempt before its fix round/);
    assert.equal(launcher.starts.length, 1);
  });

  test("a re-run that still fails after the fix round while every criterion is supported is submitted as a known defect", async (t) => {
    const h = await harness(t, "evidence-known-defect");
    const checks = [valueCheck("two"), { ...valueCheck("four", null), label: "an unlinked check" }];
    const launcher = new SequenceLauncher([
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith(checks)), actions: [{ write: "value.txt", content: "two\n" }] }),
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith(checks)) }),
    ]);
    const result = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: realRerunner(t, h, true) }), h.input());
    assert.equal(result.type, "submitted", JSON.stringify(result));
    assert.equal(launcher.starts.length, 2, "the failure got its fix round first");
    if (result.type !== "submitted") return;
    assert.ok(result.changeSet.unresolvedConcerns.some((concern) => /^Known defect: the Runner's re-run of an unlinked check .* still fails after Claude Code's fix round \(exit 1/.test(concern)),
      JSON.stringify(result.changeSet.unresolvedConcerns));
  });
});
