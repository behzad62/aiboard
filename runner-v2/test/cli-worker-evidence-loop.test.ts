/**
 * CW6: the Runner's re-runs of the checks a CLI worker reported (docs/plans/2026-11-14-cli-workers.md §3.6), part 2 of
 * 2: the CLI loop with the fake CLI (support/fake-cli.mjs) and the production one-shot executor: Runner evidence that
 * satisfies the submission rule on the submitted tree, the one fix round that resumes the CLI's session, and the
 * attempt's failure after it. No real CLI is started and no prompt is sent. Part 1 is cli-worker-evidence.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test, { type TestContext } from "node:test";

import { createCheckToolLookup } from "../src/check-tool-lookup.js";
import { CLI_CHECKS_FAILING, CLI_CHECKS_UNSUPPORTED, createCliCheckRerunner } from "../src/cli-worker-evidence.js";
import { runCliWorkerAttempt, type CliCheckRerunner, type CliProcessLauncher, type CliWorkerOwner } from "../src/cli-worker-runtime.js";
import { captureWorkingTreeIdentity, restoreWorkingTree } from "../src/command-evidence-identity.js";
import { RUNNER_RERUN_OF_CLI_CLAIM, type CommandEvidenceFact } from "../src/evidence-store.js";
import type { RunGitExecutionContext } from "../src/git-run-context.js";
import type { OneShotCommandExecutor } from "../src/one-shot-command-executor.js";
import { ChildCliLauncher, policyGit } from "./support/cli-worker-fixture.js";
import { harness, claudeStream, records, CLAUDE_SESSION, RUN, TASK, WORKER, type Harness } from "./support/cli-worker-runtime-harness.js";
import { fixtureGitContext, runGit } from "./support/git-fixture.js";
import { createTestOneShotCommandExecutor } from "./support/one-shot-command-executor.js";

/** The fixture's Git with a working-tree capture, so each record carries the tree it ran on. */
function gitWithTrees(execution: OneShotCommandExecutor, indexRoot: string): RunGitExecutionContext {
  return { ...fixtureGitContext("full", execution), workingTreeForCall: (_context, cwd) => captureWorkingTreeIdentity(cwd, indexRoot, runGit) };
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

function realRerunner(t: TestContext, h: Harness): CliCheckRerunner {
  const execution = createTestOneShotCommandExecutor(t, { artifacts: h.artifacts });
  const indexRoot = join(h.state, "tree-index");
  return createCliCheckRerunner({
    git: gitWithTrees(execution, indexRoot),
    evidenceStore: h.evidence,
    artifacts: h.artifacts,
    execution,
    ledger: h.ledger,
    permissionProfile: "full",
    toolLookup: createCheckToolLookup({ environment: () => process.env }),
    captureTree: (cwd) => captureWorkingTreeIdentity(cwd, indexRoot, runGit),
    restoreTree: (cwd, treeId) => restoreWorkingTree(cwd, indexRoot, policyGit, treeId),
  });
}

function stdinOf(path: string): string {
  return (JSON.parse(readFileSync(path, "utf8")) as { stdin: string }).stdin;
}

function argvOf(path: string): string[] {
  return (JSON.parse(readFileSync(path, "utf8")) as { argv: string[] }).argv;
}

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
  const submittedTree = (await runGit({ cwd: h.workspace.path, args: ["rev-parse", `${result.changeSet.taskRevision}^{tree}`] })).stdout.trim();
  assert.equal(link.freshness?.status, "current", JSON.stringify(link.freshness));
  assert.equal(link.freshness?.evidenceTreeId, submittedTree);
  assert.equal(link.freshness?.submittedTreeId, submittedTree);
  // The CLI's summary, notRun and concerns are its report; the missing tool is the Runner's not-run line, not a failure.
  const message = (await runGit({ cwd: h.workspace.path, args: ["log", "-1", "--format=%s", result.changeSet.taskRevision] })).stdout.trim();
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
  const result = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: realRerunner(t, h) }), h.input());
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

test("a failing re-run gets the fix round; the CLI's fix is submitted, and a fix that still fails fails the attempt as cli_checks_failing", async (t) => {
  await t.test("fixed in the fix round", async (t) => {
    const h = await harness(t, "evidence-fixed");
    const second = join(h.root, "fake", "fixed.json");
    const launcher = new SequenceLauncher([
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([valueCheck("two")])), actions: [{ write: "value.txt", content: "three\n" }] }),
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([valueCheck("two")])), record: second, actions: [{ write: "value.txt", content: "two\n" }] }),
    ]);
    const result = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: realRerunner(t, h) }), h.input());
    assert.equal(result.type, "submitted", JSON.stringify(result));
    assert.match(stdinOf(second), /value check .*failed, exit 1/);
    assert.match(stdinOf(second), /value is three/, "the failing output's tail");
    if (result.type === "submitted") assert.deepEqual([...result.changeSet.changedPaths], ["value.txt"]);
  });
  await t.test("still failing after it", async (t) => {
    const h = await harness(t, "evidence-failing");
    const launcher = new SequenceLauncher([
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([valueCheck("two")])), actions: [{ write: "value.txt", content: "three\n" }] }),
      h.launcher({ cli: "claude-code", stdout: claudeStream(h, doneWith([valueCheck("two")])) }),
    ]);
    const result = await runCliWorkerAttempt(h.deps(launcher, { rerunChecks: realRerunner(t, h) }), h.input());
    // A failed attempt: the scheduler records it as the task's failure, and the Architect's attempt rules requeue it.
    assert.equal(result.type === "settled" && result.outcome.type, "failed", JSON.stringify(result));
    assert.match(JSON.stringify(result), new RegExp(`${CLI_CHECKS_FAILING}: after its fix round.*value check .*exit 1`));
    assert.equal(launcher.starts.length, 2);
  });
});
