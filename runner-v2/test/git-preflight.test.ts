import assert from "node:assert/strict";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";
import { createRunnerInternalProcessKernel } from "../src/runner-internal-process-kernel.js";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkGit,
  createBoundedGitCommandExecutor,
  GitCommandExecutionError,
} from "../src/git-preflight.js";

const here = dirname(fileURLToPath(import.meta.url));

// Windows membership inspection may take the adaptive production ceiling on a
// busy host. Keep these process-tree assertions aligned with that semantic
// cleanup budget instead of imposing a shorter host-speed deadline.
const CLEANUP_DEADLINE_MS = 15_000;

test("bounded Git execution times out by policy and verifies that its process is gone", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-git-bounded-"));
  t.diagnostic(`exact Git fixture acquired: ${root}`);
  const kernelDirectory = join(root, "process-kernel");
  const processKernel = createRunnerInternalProcessKernel({ stateDirectory: kernelDirectory });
  let hasPrimaryFailure = false; let primaryFailure: unknown;
  const marker = join(root, "pid.txt");
  const execute = createBoundedGitCommandExecutor({
    executionDeadlineMs: 250,
    terminationDeadlineMs: CLEANUP_DEADLINE_MS,
    environment: process.env,
    processKernel,
  });
  const started = Date.now();
  try {
    await assert.rejects(
      execute(process.execPath, [join(here, "fixtures", "git-preflight-hang.mjs"), marker]),
      (error: unknown) => error instanceof GitCommandExecutionError &&
        error.code === "git_command_timeout" &&
        error.cleanupVerified === true,
    );
    const pid = Number(await readFile(marker, "utf8"));
    assert.equal(isProcessAlive(pid), false);
    assert.ok(
      Date.now() - started < 45_000,
      "portable startup plus bounded tree cleanup exceeded its total safety envelope",
    );
  } catch (error) { hasPrimaryFailure = true; primaryFailure = error; }
  finally {
    await finalizeCertifiedFixture({
      fixtureName: "bounded Git", root, hasPrimaryFailure, primaryFailure,
      cleanup: async () => { await processKernel.close(); },
      certify: async () => {
        assert.equal(processKernel.activeCount(), 0, "the exact kernel must have no remaining owned process");
        assert.deepEqual(await readdir(kernelDirectory), [], "an unresolved backend identity must retain its evidence");
      },
      removeRoot: async () => { await rm(root, { recursive: true }); t.diagnostic(`certified Git root removed: ${root}`); },
    });
  }
});

test("bounded Git execution verifies the complete process tree, including detached descendants", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "runner-git-tree-bounded-"));
  t.diagnostic(`exact Git fixture acquired: ${root}`);
  const kernelDirectory = join(root, "process-kernel");
  const processKernel = createRunnerInternalProcessKernel({ stateDirectory: kernelDirectory });
  let hasPrimaryFailure = false; let primaryFailure: unknown;
  const marker = join(root, "tree.json");
  const execute = createBoundedGitCommandExecutor({
    executionDeadlineMs: 500,
    terminationDeadlineMs: CLEANUP_DEADLINE_MS,
    environment: process.env,
    processKernel,
  });
  try {
    await assert.rejects(
      execute(process.execPath, [join(here, "fixtures", "git-preflight-tree-hang.mjs"), marker]),
      (error: unknown) => error instanceof GitCommandExecutionError &&
        error.code === "git_command_timeout" && error.cleanupVerified === true,
    );
    const recorded = JSON.parse(await readFile(marker, "utf8")) as {
      rootPid: number;
      descendantPid: number;
    };
    assert.equal(isProcessAlive(recorded.rootPid), false);
    assert.equal(isProcessAlive(recorded.descendantPid), false,
      "cleanupVerified must cover a detached descendant, not only the launcher");
  } catch (error) { hasPrimaryFailure = true; primaryFailure = error; }
  finally {
    await finalizeCertifiedFixture({
      fixtureName: "bounded Git", root, hasPrimaryFailure, primaryFailure,
      cleanup: async () => { await processKernel.close(); },
      certify: async () => {
        assert.equal(processKernel.activeCount(), 0, "the exact kernel must have no remaining owned process");
        assert.deepEqual(await readdir(kernelDirectory), [], "an unresolved backend identity must retain its evidence");
      },
      removeRoot: async () => { await rm(root, { recursive: true }); t.diagnostic(`certified Git root removed: ${root}`); },
    });
  }
});

test("bounded internal execution retains output from a child that exits before sink registration", async () => {
  const execute = createBoundedGitCommandExecutor({
    executionDeadlineMs: 5_000,
    terminationDeadlineMs: 5_000,
    environment: process.env,
  });
  const result = await execute(process.execPath, [
    "-e",
    "process.stdout.write('fast-child-output')",
  ]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "fast-child-output");
  assert.equal(result.stderr, "");
});

test("Git preflight reports missing Git without trying to install it", async () => {
  assert.deepEqual(
    await checkGit(async () => ({
      exitCode: 127,
      stdout: "",
      stderr: "not found",
    })),
    {
      available: false,
      version: null,
      code: "git_missing",
      reason: "Git is required for Build V2.",
    }
  );
});

test("Git preflight parses Windows versions and enforces the minimum", async () => {
  assert.deepEqual(
    await checkGit(async () => ({
      exitCode: 0,
      stdout: "git version 2.45.1.windows.1\n",
      stderr: "",
    })),
    {
      available: true,
      version: "2.45.1.windows.1",
      code: "git_ready",
      reason: null,
    }
  );

  assert.deepEqual(
    await checkGit(
      async () => ({
        exitCode: 0,
        stdout: "git version 2.38.4",
        stderr: "",
      }),
      { minimumVersion: "2.39.0" }
    ),
    {
      available: false,
      version: "2.38.4",
      code: "git_too_old",
      reason: "Git 2.39.0 or newer is required for Build V2.",
    }
  );
});

test("Git preflight treats malformed successful output as unavailable", async () => {
  const result = await checkGit(async () => ({
    exitCode: 0,
    stdout: "unexpected",
    stderr: "",
  }));
  assert.equal(result.available, false);
  assert.equal(result.code, "git_missing");
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
