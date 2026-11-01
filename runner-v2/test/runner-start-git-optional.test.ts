import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { assertGitForUnfinishedRuns, gitUnavailableNotice, type GitPreflightResult } from "../src/git-preflight.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { startRunner } from "../src/runner-start.js";

const missing: GitPreflightResult = { available: false, version: null, code: "git_missing", reason: "Git is required for Build V2." };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "aiboard-git-optional-"));
  const project = join(root, "project");
  const state = join(root, "state");
  await mkdir(project);
  return { root, project, state, args: ["--project", project, "--state-dir", state, "--extensions-home", join(root, "extensions")] };
}

test("the Runner starts without Git", async () => {
  const f = await fixture();
  const oldExitCode = process.exitCode;
  let failure: unknown;
  try {
    let done!: (error?: unknown) => void;
    const shutdownComplete = new Promise<unknown>((resolve) => { done = resolve; });
    const runner = await startRunner(f.args, {
      controlListener: "none", gitPreflight: async () => missing,
      onStartupError: (error) => { failure = error; }, onShutdownComplete: done,
    });
    assert.ifError(failure);
    assert.equal(runner.started, true);
    await runner.shutdown();
    assert.equal(await shutdownComplete, undefined);
  } finally {
    process.exitCode = oldExitCode;
    await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("without Git, an unfinished run still blocks startup and names the way out", async () => {
  const f = await fixture();
  const oldExitCode = process.exitCode;
  let failure: unknown;
  try {
    await mkdir(f.state, { recursive: true });
    const supervisor = new RunSupervisor(new SqliteEventStore(join(f.state, "events.sqlite")));
    supervisor.createRun({ runId: "run-1", projectPath: f.project, permissionProfile: "full", idempotencyKey: "create-1" });
    supervisor.close();
    const result = await startRunner(f.args, { controlListener: "none", gitPreflight: async () => missing, onStartupError: (error) => { failure = error; } });
    assert.equal(result.started, false);
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /^git_missing: Git is required for Build V2\. It is needed to resume 1 unfinished Build run\(s\)\. .*Or start with --set-aside-run run-1 to leave them untouched\.$/);
  } finally {
    process.exitCode = oldExitCode;
    await rm(f.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("Git notices say what still works and how to install Git on each platform", () => {
  assert.match(gitUnavailableNotice("git_missing", "win32"), /^Git was not found, so Build and ToolBench are off\. Chat and account providers still work\. Install Git for Windows from https:\/\/git-scm\.com\/download\/win/);
  assert.match(gitUnavailableNotice("git_too_old", "darwin"), /^Git is older than 2\.39\.0, .*xcode-select --install/);
  assert.match(gitUnavailableNotice("git_missing", "linux"), /package manager/);
  assert.doesNotThrow(() => assertGitForUnfinishedRuns(missing, []));
  assert.doesNotThrow(() => assertGitForUnfinishedRuns({ available: true, version: "2.45.0", code: "git_ready", reason: null }, ["run-1"]));
});
