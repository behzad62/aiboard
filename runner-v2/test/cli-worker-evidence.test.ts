/**
 * CW6: the Runner's re-runs of the checks a CLI worker reported (docs/plans/2026-11-14-cli-workers.md §3.6), part 1 of
 * 2: the re-runner alone, against a real Git worktree with a scripted one-shot executor: the record it makes, the
 * timeout rule, shell lines, missing tools, browser checks, refusals and the restore of files a re-run changed. Part 2
 * (cli-worker-evidence-loop.test.ts) drives the CLI loop with the fake CLI. No real CLI is started.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { describe, type TestContext } from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import type { CheckToolLookup } from "../src/check-tool-lookup.js";
import {
  CLI_CHECKS_FAILING,
  CLI_CHECKS_RERUN_FAILED,
  CLI_CHECKS_UNSUPPORTED,
  CLI_RERUN_MIN_TIMEOUT_MS,
  CLI_RERUN_TIMEOUT_CAP_MS,
  CliCheckRerunError,
  cliCheckDecision,
  cliCheckGapFailure,
  cliCheckGaps,
  cliCheckEvidenceLinks,
  cliCheckShellLine,
  cliFixRoundPrompt,
  cliRerunNothingStarted,
  createCliCheckRerunner,
  createCliOneShotSettlement,
  type CliCheckRerun,
  type CliCheckRerunnerOptions,
} from "../src/cli-worker-evidence.js";
import type { CliCheckRerunner, CliWorkerOwner } from "../src/cli-worker-runtime.js";
import type { CliWorkerCheckV1, CliWorkerResultV1 } from "../src/cli-worker-result.js";
import { captureWorkingTreeIdentity, restoreWorkingTree } from "../src/command-evidence-identity.js";
import { evidenceFactSummary, RUNNER_RERUN_OF_CLI_CLAIM, type CommandEvidenceFact } from "../src/evidence-store.js";
import type { RunGitExecutionContext } from "../src/git-run-context.js";
import type { OneShotCommandExecutor, OneShotCommandRequest } from "../src/one-shot-command-executor.js";
import { isProcessStopUnprovenError } from "../src/process-stop-proof.js";
import { SqliteBudgetLedger } from "../src/sqlite-budget-ledger.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { recordValidationEvidenceSegment } from "../src/validation-budget.js";
import { workerSubmissionContext, type WorkerSubmissionContext } from "../src/worker-runtime.js";
import type { TaskWorkspace } from "../src/workspace-manager.js";
import { policyGit } from "./support/cli-worker-fixture.js";
import { CLI_RUNTIME_TEST_CONCURRENCY } from "./support/cli-worker-runtime-harness.js";
import { asyncFixtureGitContext, runGitAsync } from "./support/git-fixture.js";
import type { RecoveryTarget } from "../src/process-recovery.js";

const OWNER: CliWorkerOwner = Object.freeze({ runId: "run_e", sessionId: "worker:run_e:task_e:1", actor: Object.freeze({ role: "worker" as const, id: "worker_e" }) });
const CRITERIA = [{ id: "value", text: "value.txt holds two." }, { id: "docs", text: "The README names the value." }];

interface Scripted {
  /** A number, or one read from the files the command runs on. */
  exitCode?: number | ((cwd: string) => number);
  timedOut?: boolean;
  stdout?: string;
  /** Runs before the result, in the command's working folder: a re-run that writes files. */
  effect?: (cwd: string) => void;
  /** The executor's cleanup report; verified empty unless set. */
  cleanup?: { state: "failed"; failedAt: string; code: string; detail: string } | { state: "pending" };
  /** The executor throws this instead of returning. */
  throws?: Error;
}

/** A one-shot executor that runs nothing: each request gets the next scripted result. */
function scriptedExecution(results: Scripted[]): OneShotCommandExecutor & { requests: OneShotCommandRequest[] } {
  const requests: OneShotCommandRequest[] = [];
  return {
    requests,
    async execute(request) {
      requests.push(request);
      const scripted = results[requests.length - 1] ?? { exitCode: 0 };
      scripted.effect?.(request.workingDirectory);
      if (scripted.throws) throw scripted.throws;
      const now = new Date().toISOString();
      const exitCode = typeof scripted.exitCode === "function" ? scripted.exitCode(request.workingDirectory) : scripted.exitCode ?? 0;
      return {
        process: {
          logicalProcessId: `scripted-${requests.length}`,
          outcome: scripted.timedOut ? "timed_out" : "exited",
          exitCode: scripted.timedOut ? null : exitCode,
          finishedAt: now,
          output: [
            { stream: "stdout", tail: scripted.stdout ?? "", totalBytes: (scripted.stdout ?? "").length, truncated: false, spillBytes: 0, lossyBytes: 0 },
            { stream: "stderr", tail: "", totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0 },
          ],
          cleanup: scripted.cleanup ?? { state: "verified_empty", verifiedAt: now },
        },
        enforcement: "unconfined_explicit_full",
        disclosure: "unconfined_explicit_full",
      } as Awaited<ReturnType<OneShotCommandExecutor["execute"]>>;
    },
  };
}

interface Repo {
  root: string;
  workspace: TaskWorkspace;
  indexRoot: string;
  evidence: SqliteEvidenceStore;
  artifacts: ArtifactStore;
  budget: SqliteBudgetLedger;
  tree(): Promise<string>;
  options(execution: OneShotCommandExecutor, overrides?: Partial<CliCheckRerunnerOptions>): CliCheckRerunnerOptions;
  submission(budgetMs?: number): WorkerSubmissionContext;
}

/** A Git worktree with one commit and the CLI's change (value.txt holds two), and the stores a re-run records in. */
async function repo(t: TestContext): Promise<Repo> {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "aiboard-cli-evidence-")));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const budget = new SqliteBudgetLedger(join(root, "budget.sqlite"), { limitsFor: () => ({}) });
  t.after(() => {
    evidence.close();
    budget.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  const path = join(root, "worktree");
  const indexRoot = join(root, "index");
  mkdirSync(path);
  mkdirSync(indexRoot);
  const git = async (...args: string[]) => {
    const result = await runGitAsync({ cwd: path, args });
    assert.equal(result.exitCode, 0, `git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  await git("init", "-q");
  writeFileSync(join(path, "value.txt"), "one\n");
  writeFileSync(join(path, "README.md"), "# Value\n");
  await git("add", "-A");
  await git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
  writeFileSync(join(path, "value.txt"), "two\n");
  const baselineRevision = await git("rev-parse", "HEAD");
  const workspace: TaskWorkspace = { runId: OWNER.runId, taskId: "task_e", workspaceId: "task_e", path, branch: "refs/heads/master", baselineRevision };
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const capture = (cwd: string) => captureWorkingTreeIdentity(cwd, indexRoot, runGitAsync);
  const r: Repo = {
    root, workspace, indexRoot, evidence, artifacts, budget,
    tree: async () => {
      const identity = await capture(path);
      assert.equal(identity.status, "known");
      return identity.status === "known" ? identity.treeId : "";
    },
    options: (execution, overrides = {}) => ({
      git: gitWithTrees(execution, indexRoot),
      evidenceStore: evidence,
      artifacts,
      execution,
      permissionProfile: "full",
      captureTree: capture,
      // The Runner Git policy: the restore uses only commands it allows.
      restoreTree: (cwd, treeId) => restoreWorkingTree(cwd, indexRoot, policyGit, treeId),
      ...overrides,
    }),
    submission: (budgetMs = 600_000) => workerSubmissionContext({
      runId: OWNER.runId, sessionId: OWNER.sessionId, taskId: "task_e", actorId: OWNER.actor.id, attempt: 1,
      acceptanceCriteria: CRITERIA, validationBudgetMs: budgetMs, workspace, workspaceManager: undefined as never,
      artifacts, ledger: undefined as never, evidenceStore: evidence, budgetLedger: budget,
    }),
  };
  return r;
}

/** The fixture's Git with a working-tree capture, so each record carries the tree it ran on. */
function gitWithTrees(execution: OneShotCommandExecutor, indexRoot: string): RunGitExecutionContext {
  return { ...asyncFixtureGitContext("full", execution), workingTreeForCall: (_context, cwd) => captureWorkingTreeIdentity(cwd, indexRoot, runGitAsync) };
}

function check(executable: string, args: string[], extra: Partial<CliWorkerCheckV1> = {}): CliWorkerCheckV1 {
  return { label: `${executable} ${args.join(" ")}`.trim(), executable, args, ...extra };
}

function result(checks: CliWorkerCheckV1[]): CliWorkerResultV1 {
  return { outcome: "done", summary: "Changed value.txt to two.", checks, notRun: [], concerns: [] };
}

async function rerun(r: Repo, rerunner: CliCheckRerunner, checks: CliWorkerCheckV1[], options: { budgetMs?: number; browserUnavailable?: boolean; treeBefore?: string } = {}) {
  return await rerunner({
    owner: OWNER, workspace: r.workspace, taskId: "task_e", attempt: 1, result: result(checks),
    browserUnavailable: options.browserUnavailable ?? false, submission: r.submission(options.budgetMs),
    ...(options.treeBefore ? { treeBefore: options.treeBefore } : {}),
  });
}

describe("CW6 re-runner", { concurrency: CLI_RUNTIME_TEST_CONCURRENCY }, () => {
  test("a reported check becomes the worker's evidence: run_evidence_command as that worker and attempt, outputs kept, source marked", async (t) => {
    const r = await repo(t);
    const execution = scriptedExecution([{ exitCode: 0, stdout: "ok", effect: (cwd) => writeFileSync(join(cwd, "report.png"), "png") }]);
    // The report is ignored, so keeping it as an output changes no tracked file.
    writeFileSync(join(r.workspace.path, ".gitignore"), "report.png\n");
    const tree = await r.tree();
    const out = await rerun(r, createCliCheckRerunner(r.options(execution)), [check("node", ["--test"], { outputs: ["report.png"], criterionIds: ["value", "unknown"] })]);
    assert.equal(execution.requests.length, 1);
    assert.equal(execution.requests[0]!.executable, "node");
    assert.deepEqual(execution.requests[0]!.arguments, ["--test"]);
    assert.equal(execution.requests[0]!.freshExecution, true, "a re-run is a run of its own, never an earlier result");
    assert.equal(execution.requests[0]!.context.actor.id, OWNER.actor.id);
    assert.equal(execution.requests[0]!.context.sessionId, OWNER.sessionId);
    const [record] = r.evidence.list({ runId: OWNER.runId, taskId: "task_e" });
    assert.ok(record);
    assert.equal(record.actor.id, OWNER.actor.id);
    assert.equal(record.attempt, 1);
    const fact = record.fact as CommandEvidenceFact;
    assert.equal(fact.source, RUNNER_RERUN_OF_CLI_CLAIM);
    assert.match(evidenceFactSummary(fact), /the Runner's re-run of a CLI worker's check$/, "the Architect's summary names who ran it");
    assert.equal(fact.outputs?.files.length, 1);
    assert.deepEqual(fact.workingTreeIdentity, { status: "known", treeId: tree });
    // Only known criteria are linked, each to its passing re-run with the record's artifacts.
    assert.deepEqual(out.criterionEvidenceLinks.map((link) => [link.criterionId, link.evidenceId]), [["value", record.id]]);
    assert.ok(out.criterionEvidenceLinks[0]!.artifactHashes.includes(fact.outputs!.files[0]!.artifactHash));
    assert.equal(out.reruns?.[0]?.status, "passed");
    assert.equal(out.reruns?.[0]?.supports, true, "it ran on the tree the CLI left");
    assert.deepEqual(out.restoredPaths, []);
    // The other criterion has no re-run: a gap, not a failure.
    const gaps = cliCheckGaps(CRITERIA, out);
    assert.deepEqual(gaps.unsupported.map((criterion) => criterion.id), ["docs"]);
    assert.equal(gaps.failing.length, 0);
  });

  test("each re-run's timeout is the remaining validation budget, one to ten minutes; a re-run the budget cut short is not run, never a failure", async (t) => {
    const r = await repo(t);
    const execution = scriptedExecution([{ exitCode: 0 }, { exitCode: 0 }, { timedOut: true }, { exitCode: 0 }]);
    const rerunner = createCliCheckRerunner(r.options(execution, { budgetLedger: r.budget }));
    await rerun(r, rerunner, [check("node", ["--test"])], { budgetMs: 24 * 60 * 60_000 });
    assert.equal(execution.requests[0]!.timeoutMs, CLI_RERUN_TIMEOUT_CAP_MS);
    // 30 s of the task's 150 s budget is used: the next re-run gets what is left, whatever its own run counts afterwards.
    recordValidationEvidenceSegment(r.budget, {
      runId: OWNER.runId, taskId: "task_e", sessionId: "earlier", callId: "call_1",
      startedAt: "2026-11-18T00:00:00.000Z", finishedAt: "2026-11-18T00:00:30.000Z",
    });
    await rerun(r, rerunner, [check("node", ["--test"])], { budgetMs: 150_000 });
    const timeout = execution.requests[1]!.timeoutMs;
    assert.ok(timeout <= 120_000 && timeout > CLI_RERUN_MIN_TIMEOUT_MS, String(timeout));
    // The budget is spent (the reviewer's P4): each re-run still gets a minute, so it leaves a record. One that times out
    // there is not run, never a failure, and never support: its criterion gets the fix round, and after it is submitted
    // as not verified, linked to the timed-out record, so the budget alone never fails the attempt.
    const spent = await rerun(r, rerunner, [
      check("node", ["slow.js"], { criterionIds: ["value"] }),
      check("node", ["--test"], { criterionIds: ["docs"] }),
    ], { budgetMs: 10_000 });
    assert.equal(execution.requests[2]!.timeoutMs, CLI_RERUN_MIN_TIMEOUT_MS);
    assert.deepEqual(spent.reruns?.map((entry) => [entry.status, entry.notRunReason ?? ""]), [["not_run", "validation_budget_spent"], ["passed", ""]]);
    assert.match(spent.reruns?.[0]?.detail ?? "", /validation budget left it 60 s.*not a failure/);
    assert.ok(spent.reruns?.[0]?.evidenceId);
    assert.deepEqual(spent.criterionEvidenceLinks.map((link) => [link.criterionId, link.evidenceId]), [["docs", spent.reruns![1]!.evidenceId]]);
    const gaps = cliCheckGaps(CRITERIA, spent);
    assert.deepEqual(gaps.unsupported.map((criterion) => [criterion.id, criterion.failing, criterion.budgetCut?.evidenceId]), [["value", false, spent.reruns![0]!.evidenceId]]);
    assert.equal(cliCheckDecision("Claude Code", CRITERIA, spent, false, { taskId: "task_e", attempt: 1 }).type, "fix_round");
    const after = cliCheckDecision("Claude Code", CRITERIA, spent, true, { taskId: "task_e", attempt: 1 });
    assert.equal(after.type, "submit");
    if (after.type === "submit") {
      assert.deepEqual(after.notVerified.map((entry) => entry.id), ["value"]);
      assert.deepEqual(after.criterionEvidenceLinks.map((link) => [link.criterionId, link.evidenceId]),
        [["docs", spent.reruns![1]!.evidenceId], ["value", spent.reruns![0]!.evidenceId]]);
    }
    assert.ok(spent.notRun.some((entry) => /validation budget/.test(entry.why)), "the Architect is told");
  });

  test("a shell line is not run and asks for single commands; a missing tool is not_run, never a failure", async (t) => {
    const r = await repo(t);
    const execution = scriptedExecution([{ exitCode: 0 }]);
    const lookups: string[] = [];
    const toolLookup: CheckToolLookup = async (executable) => {
      lookups.push(executable);
      return executable === "dotnet" ? { status: "missing" } : { status: "found", path: `/bin/${executable}` };
    };
    const out = await rerun(r, createCliCheckRerunner(r.options(execution, { toolLookup })), [
      check("npm", ["test", "&&", "npm", "run", "lint"], { criterionIds: ["value"] }),
      check("dotnet", ["test"], { criterionIds: ["value"] }),
      check("node", ["--test"], { criterionIds: ["docs"] }),
    ]);
    assert.equal(execution.requests.length, 1, "only the plain command runs");
    assert.deepEqual(lookups, ["dotnet", "node"], "a shell line is refused before any lookup");
    assert.deepEqual(out.reruns?.map((entry) => [entry.status, entry.notRunReason ?? ""]), [["not_run", "shell_line"], ["not_run", "tool_missing"], ["passed", ""]]);
    assert.match(out.notRun[0]!.why, /shell line/);
    assert.match(out.notRun[1]!.why, /tool_missing.*not a failure/);
    const gaps = cliCheckGaps(CRITERIA, out);
    assert.equal(gaps.failing.length, 0, "neither is a failure");
    assert.deepEqual(gaps.unsupported.map((criterion) => criterion.id), ["value"], "they support nothing");
    assert.match(cliCheckGapFailure("Claude Code", gaps), new RegExp(`^${CLI_CHECKS_UNSUPPORTED}:`));
  });

  test("shell lines: an operator argument, a command line in the executable, or a shell given a command string", () => {
    for (const [executable, args] of [
      ["npm", ["test", "|", "tee", "log"]], ["npm", ["test", ">", "out.txt"]], ["npm", ["test", "2>&1"]], ["npm", ["test", ";", "ls"]],
      ["npm test", []], ["npm", ["test", "2>/dev/null"]], ["bash", ["-c", "npm test"]], ["bash", ["-lc", "npm test"]], ["sh", ["-c", "x"]],
      ["fish", ["--command", "npm test"]], ["fish", ["--command=npm test"]],
      ["cmd.exe", ["/c", "npm test"]], ["C:\\Windows\\System32\\cmd.exe", ["/C", "x"]],
      ["pwsh", ["-Command", "npm test"]], ["pwsh", ["-co", "npm test"]], ["pwsh", ["-NoProfile", "-c", "x"]], ["pwsh", ["-CommandWithArgs", "x"]],
      ["powershell", ["-enc", "ZQBjAGgAbwA="]], ["powershell.exe", ["-EncodedCommand", "ZQBjAGgAbwA="]], ["pwsh", ["-ec", "ZQBjAGgAbwA="]],
      // Windows PowerShell's first positional argument is a command string.
      ["powershell", ["npm test"]], ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "npm test"]],
      // The re-check's misses: -i is Interactive (no value), a value parameter before -c, wrappers and other shells.
      ["pwsh", ["-i", "-c", "x"]], ["pwsh", ["-ConfigurationFile", "f.pssc", "-c", "x"]], ["csh", ["-c", "x"]], ["tcsh", ["-fc", "x"]],
      ["env", ["bash", "-c", "x"]], ["env", ["-i", "FOO=1", "sh", "-c", "x"]], ["env", ["-S", "npm test"]], ["/usr/bin/env", ["zsh", "-c", "x"]],
      ["busybox", ["sh", "-c", "x"]], ["wsl", ["npm", "test"]], ["wsl.exe", ["-e", "npm", "test"]],
      // The second re-check's misses: option values before the program, more wrappers, package runners' shell options.
      ["env", ["-u", "NAME", "sh", "-c", "x"]], ["env", ["-C", "dir", "bash", "-c", "x"]], ["env", ["--unset=NAME", "sh", "-c", "x"]],
      ["timeout", ["60", "bash", "-c", "x"]], ["timeout", ["-s", "KILL", "60", "sh", "-c", "x"]], ["nohup", ["sh", "-c", "x"]],
      ["sudo", ["sh", "-c", "x"]], ["sudo", ["-u", "build", "bash", "-c", "x"]], ["xargs", ["sh", "-c", "x"]], ["xargs", ["-n", "1", "sh", "-c", "x"]],
      ["nice", ["-n", "10", "bash", "-c", "x"]], ["env", ["timeout", "60", "sh", "-c", "x"]],
      ["npx", ["-c", "a && b"]], ["npx", ["--call=a && b"]], ["npm", ["exec", "--call", "a && b"]], ["npm", ["x", "-c", "a"]], ["pnpm", ["--shell-mode", "exec", "a"]],
    ] as Array<[string, string[]]>) {
      assert.ok(cliCheckShellLine({ executable, args }), `${executable} ${JSON.stringify(args)}`);
    }
    for (const [executable, args] of [
      ["npm", ["test"]], ["node", ["-e", "process.exit(a && b ? 0 : 1)"]], ["grep", ["-E", "a|b", "file"]], ["grep", ["-e", "<div", "index.html"]],
      ["bash", ["scripts/check.sh"]], ["npx", ["semver", "-r", ">=1.2.3", "1.2.4"]], ["npm", [">out.txt"]], ["grep", ["|tee", "file"]],
      ["pwsh", ["-NoProfile", "-File", "check.ps1"]], ["powershell", ["-ExecutionPolicy", "Bypass", "-File", "check.ps1"]],
      // pwsh's first positional argument is a script file, not a command string.
      ["pwsh", ["check.ps1"]], ["env", ["FOO=1", "node", "--test"]], ["busybox", ["ls", "-la"]],
      ["npx", ["tsx", "--test", "test/a.test.ts"]], ["git", ["diff", "--stat"]],
      ["timeout", ["60", "node", "--test"]], ["env", ["-u", "NAME", "node", "--test"]], ["sudo", ["-u", "build", "npm", "test"]],
      ["npm", ["exec", "tsx", "--", "--test"]], ["npm", ["run", "lint"]], ["xargs", ["-n", "1", "node"]],
      [process.platform === "win32" ? "C:\\Program Files (x86)\\nodejs\\node.exe" : "/opt/my tools/node", ["--test"]],
    ] as Array<[string, string[]]>) {
      assert.equal(cliCheckShellLine({ executable, args }), undefined, `${executable} ${JSON.stringify(args)}`);
    }
  });

  test("browser checks are not run when the CLI ran without a browser; a refused command is not run, never a pass", async (t) => {
    const r = await repo(t);
    const execution = scriptedExecution([{ exitCode: 0 }]);
    // The re-check's B1: a failure before any execution is a refusal once the owner's commands are proven settled.
    const rerunner = createCliCheckRerunner(r.options(execution, { oneShotCommands: async () => undefined }));
    const out = await rerun(r, rerunner, [
      check("playwright-cli", ["screenshot"], { criterionIds: ["value"] }),
      check("node", ["--test"], { cwd: "../outside", criterionIds: ["docs"] }),
    ], { browserUnavailable: true });
    assert.equal(execution.requests.length, 0);
    assert.deepEqual(out.reruns?.map((entry) => entry.notRunReason), ["browser_unavailable", "refused"]);
    assert.match(out.reruns?.[1]?.detail ?? "", /outside workspace/);
    assert.deepEqual(out.criterionEvidenceLinks, []);
    // With a browser, the same check runs.
    await rerun(r, rerunner, [check("playwright-cli", ["screenshot"])]);
    assert.equal(execution.requests.length, 1);
  });

  test("a failed or timed-out re-run is a failing gap with its output tail; after the fix round it fails the attempt as cli_checks_failing", async (t) => {
    const r = await repo(t);
    const execution = scriptedExecution([{ exitCode: 1, stdout: "expected two, got one" }, { timedOut: true }]);
    const out = await rerun(r, createCliCheckRerunner(r.options(execution)), [
      check("node", ["--test"], { criterionIds: ["value"] }),
      check("node", ["slow.js"], { criterionIds: ["docs"] }),
    ]);
    assert.deepEqual(out.reruns?.map((entry) => [entry.status, entry.detail]), [["failed", "exit 1"], ["failed", "timed out after 600 s"]]);
    assert.match(out.reruns?.[0]?.outputTail ?? "", /expected two, got one/);
    const gaps = cliCheckGaps(CRITERIA, out);
    assert.equal(gaps.failing.length, 2);
    assert.deepEqual(gaps.unsupported.map((criterion) => criterion.id), ["value", "docs"], "a failed re-run supports nothing");
    assert.match(cliCheckGapFailure("Claude Code", gaps), new RegExp(`^${CLI_CHECKS_FAILING}:.*exit 1.*timed out`));
  });

  test("files a re-run changed are restored, so the tree submitted is the one the CLI left", async (t) => {
    const r = await repo(t);
    mkdirSync(join(r.workspace.path, "src"));
    writeFileSync(join(r.workspace.path, "src", "kept.txt"), "the CLI's new file\n");
    const tree = await r.tree();
    const execution = scriptedExecution([{
      exitCode: 0,
      effect: (cwd) => {
        writeFileSync(join(cwd, "value.txt"), "rewritten by a formatter\n");
        writeFileSync(join(cwd, "README.md"), "# Changed\n");
        rmSync(join(cwd, "src", "kept.txt"));
        mkdirSync(join(cwd, "out"), { recursive: true });
        writeFileSync(join(cwd, "out", "report.txt"), "a report\n");
      },
    }]);
    const out = await rerun(r, createCliCheckRerunner(r.options(execution)), [check("npm", ["run", "format"], { criterionIds: ["value"] })]);
    assert.deepEqual(out.restoredPaths, ["README.md", "out/report.txt", "src/kept.txt", "value.txt"]);
    assert.deepEqual(out.reruns?.[0]?.changedFiles, ["README.md", "out/report.txt", "src/kept.txt", "value.txt"]);
    // A pass that changed files supports nothing: the criterion it named is not linked.
    assert.equal(out.reruns?.[0]?.status, "passed");
    assert.equal(out.reruns?.[0]?.supports, false);
    assert.match(out.reruns?.[0]?.detail ?? "", /changed 4 file\(s\), so it supports nothing/);
    assert.deepEqual(out.criterionEvidenceLinks, []);
    assert.deepEqual(cliCheckGaps(CRITERIA, out).unsupported.map((criterion) => criterion.id), ["value", "docs"]);
    assert.equal(await r.tree(), tree);
    assert.equal(readFileSync(join(r.workspace.path, "value.txt"), "utf8"), "two\n");
    assert.equal(readFileSync(join(r.workspace.path, "src", "kept.txt"), "utf8"), "the CLI's new file\n");
    assert.equal(existsSync(join(r.workspace.path, "out", "report.txt")), false);
    // The record says what the re-run saw: it began on the tree the CLI left.
    const fact = r.evidence.list({ runId: OWNER.runId, taskId: "task_e" })[0]!.fact as CommandEvidenceFact;
    assert.equal(fact.workingTreeIdentity?.status, "unknown");
    assert.equal(fact.workingTreeIdentity?.status === "unknown" ? fact.workingTreeIdentity.capturedTreeId : undefined, tree);
    // The owner's own index is never touched by the restore.
    assert.equal((await runGitAsync({ cwd: r.workspace.path, args: ["diff", "--cached", "--name-only"] })).stdout.trim(), "");
  });

  test("a worktree whose files cannot be read is a coded re-run failure, never a submission", async (t) => {
    const r = await repo(t);
    const rerunner = createCliCheckRerunner(r.options(scriptedExecution([]), { captureTree: async () => ({ status: "unknown", reason: "capture_failed" }) }));
    await assert.rejects(rerun(r, rerunner, [check("node", ["--test"])]), (error: unknown) => error instanceof CliCheckRerunError && error.code === CLI_CHECKS_RERUN_FAILED);
  });

  test("with no criteria, one passing re-run is enough; none, or only failing ones, is a gap", () => {
    const passed: CliCheckRerun = { label: "a", command: "a", criterionIds: [], status: "passed", detail: "exit 0", supports: true };
    const failed: CliCheckRerun = { ...passed, status: "failed", detail: "exit 1", supports: false };
    assert.equal(cliCheckGaps(undefined, { criterionEvidenceLinks: [], reruns: [passed] }).unsupported.length, 0);
    assert.equal(cliCheckGaps(undefined, { criterionEvidenceLinks: [], reruns: [{ ...passed, supports: false }] }).unsupported.length, 1, "a pass on another tree is not enough");
    assert.equal(cliCheckGaps(undefined, { criterionEvidenceLinks: [], reruns: [failed] }).unsupported.length, 1);
    assert.equal(cliCheckGaps(undefined, { criterionEvidenceLinks: [], reruns: [] }).unsupported.length, 1);
  });

  test("every check runs on the tree the CLI left: a check that changed files is restored before the next, which cannot pass on its changes", async (t) => {
    const r = await repo(t);
    // The reviewer's P1: the CLI left value.txt wrong; its first check rewrites it (a formatter, a code generator), and
    // its second, linked to the criterion, checks it.
    writeFileSync(join(r.workspace.path, "value.txt"), "three\n");
    const tree = await r.tree();
    const execution = scriptedExecution([
      { effect: (cwd) => writeFileSync(join(cwd, "value.txt"), "two\n") },
      { exitCode: (cwd) => readFileSync(join(cwd, "value.txt"), "utf8") === "two\n" ? 0 : 1, stdout: "value.txt is not two" },
    ]);
    const out = await rerun(r, createCliCheckRerunner(r.options(execution)), [
      check("node", ["fix.js"]),
      check("node", ["check.js"], { criterionIds: ["value"] }),
    ]);
    assert.deepEqual(out.reruns?.map((entry) => [entry.status, entry.changedFiles ?? []]), [["passed", ["value.txt"]], ["failed", []]]);
    assert.deepEqual(out.criterionEvidenceLinks, [], "nothing passed on the tree the CLI left");
    const gaps = cliCheckGaps(CRITERIA, out);
    assert.deepEqual(gaps.unsupported.map((criterion) => [criterion.id, criterion.failing]), [["value", true], ["docs", false]]);
    assert.equal(readFileSync(join(r.workspace.path, "value.txt"), "utf8"), "three\n");
    assert.equal(await r.tree(), tree);
    const prompt = cliFixRoundPrompt({ name: "Claude Code", gaps, reruns: out.reruns ?? [] });
    assert.match(prompt, /It changed files, which the Runner put back as you left them: value\.txt/);
    assert.match(prompt, /A check that changes files \(a formatter, a code generator, an install\) supports nothing/);
  });

  test("a re-run whose processes are not proven gone throws a classified stop error, never a result or a pass", async (t) => {
    const r = await repo(t);
    const failedAt = new Date().toISOString();
    const cases: Array<[string, Scripted]> = [
      // The reviewer's P2 and P3.
      ["a returned cleanup failure with exit 0", { exitCode: 0, cleanup: { state: "failed", failedAt, code: "verified_empty_failed", detail: "a descendant is still running" } }],
      ["a cleanup still pending", { exitCode: 0, cleanup: { state: "pending" } }],
      ["a thrown process_cleanup_unverified", { throws: Object.assign(new Error("Shared managed cleanup did not prove release."), { code: "process_cleanup_unverified" }) }],
      ["a thrown cleanup_blocked", { throws: Object.assign(new Error("The cleanup is blocked."), { code: "cleanup_blocked" }) }],
    ];
    for (const [what, scripted] of cases) {
      const rerunner = createCliCheckRerunner(r.options(scriptedExecution([scripted])));
      await assert.rejects(rerun(r, rerunner, [check("node", ["--test"], { criterionIds: ["value"] })]),
        (error: unknown) => isProcessStopUnprovenError(error) && !(error instanceof CliCheckRerunError), what);
    }
    // The re-check's B1: a tool error that does not mean "nothing started" holds the attempt, unless the owner's one-shot
    // commands are proven settled. backend_unavailable (the runtime could not observe or stop it) and identity_mismatch
    // (it could not signal it) may leave the process running.
    for (const code of ["backend_unavailable", "identity_mismatch"]) {
      const scripted = (): Scripted => ({ throws: Object.assign(new Error(`${code} while stopping`), { code }) });
      const value = [check("node", ["--test"], { criterionIds: ["value"] })];
      await assert.rejects(rerun(r, createCliCheckRerunner(r.options(scriptedExecution([scripted()]))), value),
        (error: unknown) => isProcessStopUnprovenError(error) && new RegExp(code).test((error as Error).message), `${code}, no settlement check`);
      await assert.rejects(rerun(r, createCliCheckRerunner(r.options(scriptedExecution([scripted()]), { oneShotCommands: async () => "1 command(s) are not proven stopped" })), value),
        (error: unknown) => isProcessStopUnprovenError(error) && /not proven stopped/.test((error as Error).message), `${code}, unsettled`);
      const settled = await rerun(r, createCliCheckRerunner(r.options(scriptedExecution([scripted()]), { oneShotCommands: async () => undefined })), value);
      assert.deepEqual(settled.reruns?.map((entry) => [entry.notRunReason, entry.supports]), [["refused", undefined]], `${code}, settled`);
      assert.deepEqual(settled.criterionEvidenceLinks, []);
    }
    // A settlement check that fails proves nothing.
    await assert.rejects(rerun(r, createCliCheckRerunner(r.options(scriptedExecution([{ throws: Object.assign(new Error("no backend"), { code: "backend_unavailable" }) }]),
      { oneShotCommands: async () => { throw new Error("the store is closed"); } })), [check("node", ["--test"])]),
    (error: unknown) => isProcessStopUnprovenError(error) && /could not be checked: the store is closed/.test((error as Error).message));
  });

  test("only the codes that mean nothing started are refusals; every other code, an unknown one included, holds", () => {
    for (const code of ["approval_required", "permission_denied", "path_denied", "outside_only_here", "invalid_arguments", "invalid_arguments_json",
      "workspace_required", "benchmark_command_denied", "process_runtime_unavailable", "execution_grant_unavailable",
      "isolation_capability_unavailable", "budget_exhausted"]) {
      assert.equal(cliRerunNothingStarted(code), true, code);
    }
    // The broker's tool_timeout stopped waiting for a command that may still run; tool_execution_failed and
    // evidence_command_failed threw around it; a tool_cancelled may come mid-run.
    for (const code of [undefined, "tool_timeout", "tool_execution_failed", "tool_cancelled", "evidence_command_failed", "backend_unavailable",
      "identity_mismatch", "outcome_unknown", "cleanup_blocked", "launch_not_proven", "reconciliation_required", "idempotency_conflict", "a_code_added_later"]) {
      assert.equal(cliRerunNothingStarted(code), false, String(code));
    }
  });

  test("the stop proof's one-shot check: an owner's re-run that is not cleaned with its cleanup verified, or never launched, is unsettled", async () => {
    const target = (invocationId: string, state: string, cleanup: string, extra: Partial<{ sessionId: string; runId: string; backend: boolean; pendingEffects: boolean; kind: "subprocess" | "streaming" }> = {}) => ({
      scope: { kind: extra.kind ?? "subprocess", runId: extra.runId ?? OWNER.runId, invocationId, logicalProcessId: invocationId, sessionId: extra.sessionId ?? OWNER.sessionId,
        revision: 1, ownerId: "o", fencingToken: 1, state, backendIdentity: "", birthFingerprint: "" },
      owned: false, pendingEffects: extra.pendingEffects ?? false,
      capabilities: { tree_termination: "verified", crash_cleanup: "verified", verified_emptiness: "verified", write_confinement: "unverified" },
      cleanup: { state: cleanup },
      ...(extra.backend === false ? {} : { backend: { backendId: "b", implementationDigest: "d" } }),
    }) as unknown as RecoveryTarget;
    let listed: RecoveryTarget[] = [];
    let scans = 0;
    const check = createCliOneShotSettlement({ listGradually: async () => { scans += 1; return listed; } });
    listed = [
      target("inv-cleaned", "cleaned", "verified_empty"),
      target("inv-never", "launch_not_proven", "not_required", { backend: false }),
      target("inv-other-session", "cleanup_blocked", "failed", { sessionId: "worker:other" }),
      target("inv-other-run", "running", "pending", { runId: "run_other" }),
      target("inv-streaming", "running", "pending", { kind: "streaming" }),
    ];
    assert.equal(await check(OWNER), undefined);
    assert.equal(scans, 2, "a scan already in flight is let finish, and a fresh one is read");
    for (const open of [
      target("inv-blocked", "cleanup_blocked", "failed"),
      target("inv-running", "running", "pending"),
      target("inv-backend", "backend_unavailable", "pending"),
      target("inv-effect", "cleaned", "verified_empty", { pendingEffects: true }),
      target("inv-cleaned-failed", "cleaned", "failed"),
    ]) {
      listed = [target("inv-cleaned", "cleaned", "verified_empty"), open];
      assert.match(await check(OWNER) ?? "", new RegExp(`1 command\\(s\\) the Runner ran for this attempt are not proven stopped: ${open.scope.invocationId}`), open.scope.invocationId);
    }
    assert.match(await createCliOneShotSettlement({}).call(undefined, OWNER) ?? "", /cannot list/);
  });

  test("re-runs start only on the tree the loop persisted for them", async (t) => {
    const r = await repo(t);
    const execution = scriptedExecution([]);
    await assert.rejects(rerun(r, createCliCheckRerunner(r.options(execution)), [check("node", ["--test"])], { treeBefore: "0".repeat(40) }),
      (error: unknown) => error instanceof CliCheckRerunError && /not the ones the CLI left/.test(error.message));
    assert.equal(execution.requests.length, 0);
  });

  test("the decision: one fix round for any gap; after it an unsupported criterion fails, and a failure every criterion outlives is a known defect", () => {
    const hash = "a".repeat(64);
    const make = (status: CliCheckRerun["status"], criterionIds: string[], extra: Partial<CliCheckRerun> = {}): CliCheckRerun => ({
      label: `check ${criterionIds.join("+") || "unlinked"}`, command: "node x", criterionIds, status, detail: status === "failed" ? "exit 1" : "exit 0",
      ...(status === "passed" ? { supports: true, evidenceId: `ev-${criterionIds.join("-")}`, artifactHashes: [hash] } : {}), ...extra,
    });
    const decide = (reruns: CliCheckRerun[], fixRoundUsed: boolean) =>
      cliCheckDecision("Claude Code", CRITERIA, { criterionEvidenceLinks: cliCheckEvidenceLinks(CRITERIA, reruns, "task_e", 1), reruns }, fixRoundUsed, { taskId: "task_e", attempt: 1 });
    const value = make("passed", ["value"]), docs = make("passed", ["docs"]);
    const links = (...reruns: CliCheckRerun[]) => cliCheckEvidenceLinks(CRITERIA, reruns, "task_e", 1);
    assert.deepEqual(decide([value, docs], false), { type: "submit", criterionEvidenceLinks: links(value, docs), knownDefects: [], notVerified: [] });
    // The coordinator's call: a failed re-run linked to no criterion, or to a supported one, gets the fix round; after
    // it, with every criterion supported, the work is submitted with the failure as a known defect.
    for (const failing of [make("failed", []), make("failed", ["value"])]) {
      assert.equal(decide([value, failing, docs], false).type, "fix_round");
      assert.deepEqual(decide([value, failing, docs], true), { type: "submit", criterionEvidenceLinks: links(value, docs), knownDefects: [failing], notVerified: [] });
    }
    const failedValue = decide([make("failed", ["value"]), docs], true);
    assert.equal(failedValue.type, "fail");
    assert.match(failedValue.type === "fail" ? failedValue.reason : "", new RegExp(`^${CLI_CHECKS_FAILING}: .*value: value.txt holds two.*exit 1`));
    const unsupported = decide([docs], true);
    assert.match(unsupported.type === "fail" ? unsupported.reason : "", new RegExp(`^${CLI_CHECKS_UNSUPPORTED}: .*value`));
    // The re-check's A: a criterion whose linked re-run the budget cut short is a gap until the fix round, and after it
    // is submitted as not verified, linked to the timed-out record; with a failed re-run linked to it, it fails.
    const budget = make("not_run", ["value"], { notRunReason: "validation_budget_spent", evidenceId: "ev-budget", artifactHashes: [hash] });
    assert.equal(decide([budget, docs], false).type, "fix_round");
    const cut = decide([budget, docs], true);
    assert.equal(cut.type, "submit");
    if (cut.type === "submit") {
      assert.deepEqual(cut.notVerified.map((entry) => [entry.id, entry.rerun.evidenceId]), [["value", "ev-budget"]]);
      assert.deepEqual(cut.criterionEvidenceLinks.map((link) => [link.criterionId, link.evidenceId]), [["docs", "ev-docs"], ["value", "ev-budget"]]);
    }
    assert.equal(decide([budget, make("failed", ["value"]), docs], true).type, "fail");
    // With no criteria, a budget-cut re-run alone is the task's gap until the fix round, then not verified.
    const task = (fixRoundUsed: boolean) => cliCheckDecision("Claude Code", undefined, { criterionEvidenceLinks: [], reruns: [{ ...budget, criterionIds: [] }] }, fixRoundUsed, { taskId: "task_e", attempt: 1 });
    assert.equal(task(false).type, "fix_round");
    assert.deepEqual((task(true) as { notVerified?: Array<{ id: string }> }).notVerified?.map((entry) => entry.id), ["task"]);
  });

  test("a pass whose record cannot prove the tree it ran on supports nothing", async (t) => {
    // The re-check's item 1: without a working-tree capture for the call, the record's identity is unknown.
    const r = await repo(t);
    const execution = scriptedExecution([{ exitCode: 0 }]);
    const out = await rerun(r, createCliCheckRerunner(r.options(execution, { git: asyncFixtureGitContext("full", execution) })),
      [check("node", ["--test"], { criterionIds: ["value"] })]);
    const fact = r.evidence.list({ runId: OWNER.runId, taskId: "task_e" })[0]!.fact as CommandEvidenceFact;
    assert.equal(fact.workingTreeIdentity?.status, "unknown");
    assert.deepEqual(out.reruns?.map((entry) => [entry.status, entry.supports]), [["passed", false]]);
    assert.match(out.reruns?.[0]?.detail ?? "", /could not prove it ran on the files the CLI left/);
    assert.deepEqual(out.criterionEvidenceLinks, []);
    assert.deepEqual(cliCheckGaps(CRITERIA, out).unsupported.map((criterion) => criterion.id), ["value", "docs"]);
  });

  test("a hang the CLI introduced, cut short by the budget's default, gets the fix round and is never a pass", async (t) => {
    // The re-check's probe: the default budget (600 s, the cap), 2 s of it already recorded, then a test that hangs.
    const r = await repo(t);
    recordValidationEvidenceSegment(r.budget, {
      runId: OWNER.runId, taskId: "task_e", sessionId: "earlier", callId: "call_1",
      startedAt: "2026-11-18T00:00:00.000Z", finishedAt: "2026-11-18T00:00:02.000Z",
    });
    const execution = scriptedExecution([{ timedOut: true }, { exitCode: 0 }]);
    const out = await rerun(r, createCliCheckRerunner(r.options(execution, { budgetLedger: r.budget })), [
      check("node", ["--test", "hangs.test.js"], { criterionIds: ["value"] }),
      check("node", ["--test", "docs.test.js"], { criterionIds: ["docs"] }),
    ]);
    assert.ok(execution.requests[0]!.timeoutMs < CLI_RERUN_TIMEOUT_CAP_MS);
    assert.equal(out.reruns?.[0]?.notRunReason, "validation_budget_spent");
    assert.deepEqual(out.criterionEvidenceLinks.map((link) => link.criterionId), ["docs"], "a timeout is never a criterion's support");
    const first = cliCheckDecision("Claude Code", CRITERIA, out, false, { taskId: "task_e", attempt: 1 });
    assert.equal(first.type, "fix_round");
    assert.match(first.type === "fix_round" ? cliFixRoundPrompt({ name: "Claude Code", gaps: first.gaps, reruns: out.reruns ?? [] }) : "",
      /cut short supports nothing: report a narrower check/);
  });
});
