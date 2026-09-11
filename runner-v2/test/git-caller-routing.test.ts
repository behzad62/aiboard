import { checkGit, executeGitCommand } from "../src/git-preflight.js";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runGit, runGitBytes, GitCommandError } from "../src/git-command.js";
import { createGitTools } from "../src/git-tools.js";
import { captureGitBaseline } from "../src/git-baseline.js";
import { RepositoryIntelligence } from "../src/repository-intelligence.js";
import type { GitCommandRunner } from "../src/git-runtime-runner.js";
import type { RunGitExecutionContext } from "../src/git-run-context.js";

function forbidRaw(t: TestContext) {
  let effects = 0;
  for (const name of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"] as const)
    t.mock.method(childProcess, name, () => { effects++; throw new Error("unexpected raw Git process effect"); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); assert.equal(effects, 0, "the production caller must never reach raw spawn"); });
}
const context = { runId: "run-routing", sessionId: "worker-routing", actor: { role: "worker" as const, id: "worker" },
  callId: "exact-call", toolName: "git.status", workspacePath: "C:/synthetic-routing" };

test("Git compatibility wrappers delegate only to the explicit exact runner", async (t) => {
  forbidRaw(t);
  const input = { cwd: context.workspacePath, args: ["status"], allowFailure: true };
  const binary = Buffer.from([0, 255, 13, 10]);
  const calls: string[] = [];
  const runner: GitCommandRunner = {
    run: async (options) => { assert.equal(options, input); calls.push("text"); return { exitCode: 3, stdout: "owned-text", stderr: "detail" }; },
    runBytes: async (options) => { assert.equal(options, input); calls.push("bytes"); return { exitCode: 4, stdout: binary, stderr: "detail" }; },
  };
  assert.deepEqual(await runGit(input, runner), { exitCode: 3, stdout: "owned-text", stderr: "detail" });
  assert.deepEqual(await runGitBytes(input, runner), { exitCode: 4, stdout: binary, stderr: "detail" });
  assert.deepEqual(calls, ["text", "bytes"]);
});

test("Git wrappers refuse absent injection before any operating-system effect", async (t) => {
  forbidRaw(t);
  for (const run of [runGit, runGitBytes]) {
    await assert.rejects(run({ cwd: context.workspacePath, args: ["status"] }, undefined as never),
      (error: unknown) => error instanceof GitCommandError && error.code === "git_unavailable");
  }
});

test("Git tools bind every subcommand to the actual ToolBroker call", async (t) => {
  forbidRaw(t);
  const observed: unknown[] = [];
  const run: GitCommandRunner = {
    run: async (options) => { observed.push(options); return { exitCode: 0, stdout: " M owned.txt\0", stderr: "" }; },
    runBytes: async () => assert.fail("status is a text operation"),
  };
  let bindings = 0;
  const git = { forCall: (actual: unknown) => { assert.equal(actual, context); bindings++; return run; } } as RunGitExecutionContext;
  const status = createGitTools(git).find((tool) => tool.definition.name === "git.status")!;
  const result = await status.execute({}, context);
  assert.equal(result.isError, false);
  assert.deepEqual((result.content[0] as { value: unknown }).value, { entries: [{ index: " ", worktree: "M", path: "owned.txt" }] });
  assert.equal(bindings, 1); assert.equal(observed.length, 1);
  assert.deepEqual((observed[0] as { args: string[] }).args, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
});

test("Repository intelligence uses its injected runner for every Git query", async (t) => {
  forbidRaw(t);
  const root = await mkdtemp(join(tmpdir(), "p6-git-caller-"));
  t.diagnostic(`exact caller fixture acquired: ${root}`);
  let passed = false;
  try {
    const args: readonly string[][] = [];
    const recorded = args as string[][];
    const repository = new RepositoryIntelligence(async (options) => {
      assert.equal(options.cwd, root); recorded.push([...options.args]);
      return { exitCode: 0, stdout: options.args[0] === "rev-parse" ? "true\n" : "", stderr: "" };
    });
    assert.deepEqual(await repository.snapshot(root), { root, source: "git", entries: [], truncated: false });
    assert.deepEqual(recorded.map((entry) => entry[0]), ["rev-parse", "ls-files", "ls-files"]);
    passed = true;
  } finally { if (passed) { await rm(root, { recursive: true }); t.diagnostic(`exact caller fixture removed: ${root}`); } }
});

test("Baseline refuses missing Git authority before changing a project or its index", async (t) => {
  forbidRaw(t);
  const root = await mkdtemp(join(tmpdir(), "p6-git-baseline-guard-"));
  t.diagnostic(`exact baseline guard fixture acquired: ${root}`);
  let passed = false;
  try {
    await assert.rejects(captureGitBaseline({ projectPath: root, stateDirectory: join(root, "not-created"), runId: "missing-runner", execute: undefined as never }),
      (error: unknown) => error instanceof GitCommandError && error.code === "git_unavailable");
    assert.deepEqual(await readdir(root), []);
    passed = true;
  } finally { if (passed) { await rm(root, { recursive: true }); t.diagnostic(`exact baseline guard fixture removed: ${root}`); } }
});


test("standalone preflight refuses an absent closed owner instead of constructing ambient execution", async (t) => {
  forbidRaw(t);
  const result = await checkGit(undefined as never);
  assert.equal(result.available, false); assert.equal(result.code, "git_missing");
  await assert.rejects(executeGitCommand("git", ["--version"], undefined as never), /explicit|owner|context/i);
});
