import { cliRootCaptureArgs, forwardCliRootRecords } from "./support/cli-root-capture.js";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runGit } from "./support/git-fixture.js";
import { reconcileRunnerStartup, RunnerCleanupBlockedError } from "../src/runner-resource-cleanup.js";

interface Readiness {
  protocolVersion: number;
  url: string;
  token: string;
  pid: number;
  projectPath: string;
  stateDirectory: string;
}

// Outer readiness guard only: this file runs concurrently in the portable contract.
// Product process and cleanup deadlines are unchanged.
const CLI_STARTUP_FIXTURE_BUDGET_MS = 30_000;
const token = "recovery-test-token";
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsxPath = fileURLToPath(
  new URL("../../node_modules/tsx/dist/cli.mjs", import.meta.url)
);


test("startup recovery blocks readiness when an owned resource class cannot be reconciled", async () => {
  let acceptedWork = false;
  await assert.rejects(
    (async () => {
      await reconcileRunnerStartup([{
        resource: "nativeBuildRuntime",
        covers: ["processes", "backends", "isolation", "grants", "spills", "tempRoots"],
        reconcile: async () => {
          throw new Error("retained OCI lease is not proven empty");
        },
      }]);
      acceptedWork = true;
    })(),
    (error: unknown) => {
      assert.ok(error instanceof RunnerCleanupBlockedError);
      assert.equal(error.code, "runner_startup_reconciliation_blocked");
      assert.equal(error.blockers[0]?.resource, "nativeBuildRuntime");
      return true;
    },
  );
  assert.equal(acceptedWork, false);
});
test("CLI recovers a paused run and preserves event continuity after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-runner-recovery-"));
  const projectPath = join(directory, "project");
  const stateDirectory = join(directory, "state");
  mkdirSync(projectPath);
  let first: ChildProcessWithoutNullStreams | undefined;
  let second: ChildProcessWithoutNullStreams | undefined;

  try {
    const firstStart = await startRunner(projectPath, stateDirectory);
    first = firstStart.child;
    assert.equal(firstStart.readiness.protocolVersion, 2);
    assert.equal(firstStart.readiness.projectPath, projectPath);
    assert.equal(firstStart.readiness.stateDirectory, stateDirectory);

    const refused = await fetch(`${firstStart.readiness.url}/v2/runs`, {
      method: "POST", headers: headers(), body: JSON.stringify({ runId: "strict-no-provider", projectPath,
        permissionProfile: "project", idempotencyKey: "strict-no-provider" }),
    });
    assert.equal(refused.status, 412, await refused.clone().text());
    assert.equal((await refused.json() as { code: string }).code, "isolation_capability_unavailable");
    assert.equal(existsSync(join(projectPath, ".git")), false, "strict bootstrap must not fall back to host Git");
    const created = await createRun(firstStart.readiness.url, projectPath);
    assert.match(String(created.baselineRevision), /^[a-f0-9]{40,64}$/);
    assert.equal(
      (
        await runGit({
          cwd: projectPath,
          args: ["rev-parse", String(created.baselineRef)],
        })
      ).stdout.trim(),
      created.baselineRevision
    );
    await command(firstStart.readiness.url, "start", "start:run_1");
    const paused = await command(
      firstStart.readiness.url,
      "pause",
      "pause:run_1"
    );
    assert.equal(paused.state, "paused");
    await stopProcess(first);
    first = undefined;

    const secondStart = await startRunner(projectPath, stateDirectory);
    second = secondStart.child;
    const recovered = await api(secondStart.readiness.url, "/v2/runs/run_1");
    assert.equal(recovered.state, "paused");
    assert.equal(recovered.lastSequence, 4);
    const before = (await api(
      secondStart.readiness.url,
      "/v2/runs/run_1/events?after=0"
    )) as unknown as Array<{ sequence: number; idempotencyKey: string }>;
    assert.deepEqual(
      before.map((event) => event.sequence),
      [1, 2, 3, 4]
    );

    await command(secondStart.readiness.url, "resume", "resume:run_1");
    await command(secondStart.readiness.url, "resume", "resume:run_1");
    const stopping = await command(
      secondStart.readiness.url,
      "stop",
      "stop:run_1"
    );
    assert.equal(stopping.state, "stopping");
    const after = (await api(
      secondStart.readiness.url,
      "/v2/runs/run_1/events?after=0"
    )) as unknown as Array<{ sequence: number; idempotencyKey: string }>;
    assert.deepEqual(
      after.map((event) => event.sequence),
      [1, 2, 3, 4, 5, 6]
    );
    assert.equal(
      new Set(after.map((event) => event.idempotencyKey)).size,
      after.length
    );
  } finally {
    if (first) await stopProcess(first);
    if (second) await stopProcess(second);
    rmSync(directory, { recursive: true, force: true, maxRetries: 30, retryDelay: 50 });
  }
});

async function startRunner(
  projectPath: string,
  stateDirectory: string
): Promise<{
  child: ChildProcessWithoutNullStreams;
  readiness: Readiness;
}> {
  const child = spawn(
    process.execPath,
    cliRootCaptureArgs([
      tsxPath,
      cliPath,
      "--project",
      projectPath,
      "--state-dir",
      stateDirectory,
      "--port",
      "0",
      "--token",
      token,
    ], undefined, "tsx"),
    { stdio: ["pipe", "pipe", "pipe"], windowsHide: true }
  );
  forwardCliRootRecords(child.stderr);
  const diagnostics: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => diagnostics.push(chunk));
  const lines = createInterface({ input: child.stdout });
  let timeout: NodeJS.Timeout | undefined;
  let readiness: Readiness;
  try {
    readiness = await Promise.race([
      once(lines, "line").then(
        ([line]) => JSON.parse(String(line)) as Readiness
      ),
      once(child, "exit").then(([code]) => {
        throw new Error(
          `Runner exited before readiness (${String(code)}): ${diagnostics.join("")}`
        );
      }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Runner readiness timed out.")),
          CLI_STARTUP_FIXTURE_BUDGET_MS
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
  lines.close();
  assert.equal(readiness.token, token);
  return { child, readiness };
}

async function createRun(
  url: string,
  projectPath: string
): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}/v2/runs`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      runId: "run_1",
      projectPath,
      permissionProfile: "full",
      idempotencyKey: "create:run_1",
    }),
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text) as Record<string, unknown>;
}

async function command(
  url: string,
  commandName: string,
  idempotencyKey: string
): Promise<Record<string, unknown>> {
  return await api(url, "/v2/runs/run_1/commands", {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ command: commandName, idempotencyKey }),
  });
}

async function api(
  url: string,
  path: string,
  init: RequestInit = { headers: headers() }
): Promise<Record<string, unknown>> {
  const response = await fetch(`${url}${path}`, init);
  const text = await response.text();
  assert.equal(response.ok, true, text);
  return JSON.parse(text) as Record<string, unknown>;
}

function headers(): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}
