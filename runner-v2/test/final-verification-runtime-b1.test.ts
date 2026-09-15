import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { captureGitBaseline } from "./support/git-fixture.js";
import { IntegrationManager } from "./support/git-fixture.js";
import { createExecutionHost } from "../src/execution-host.js";
import { minimalWindowsSemanticProbeEnvironment } from "../src/windows-process-semantic-probes.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { type FinalVerificationPlan, type FinalVerificationRuntimeSmokeInput } from "../src/final-verification-runtime.js";
import { FinalVerificationRuntime } from "./support/git-fixture.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { VerificationWorkspaceManager } from "./support/git-fixture.js";
import { createTestOneShotCommandExecutor } from "./support/one-shot-command-executor.js";

test("runtime smoke waits for health, records endpoint/output facts, and releases its port", async (t) => {
  const fixture = await createFixture("smoke success");
  const port = await freePort();
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const managedOwner = await createManagedExecution(fixture);
  const managed = managedOwner.service;
  const workspace = workspaceFor(fixture);
  const runtime = new FinalVerificationRuntime({
    execution: createTestOneShotCommandExecutor(t),
    workspaceManager: workspace,
    artifacts,
    evidenceStore: evidence,
    runId: fixture.runId,
    integrationRevision: () => fixture.integration.revision,
    managedProcessService: managed,
    managedProcessAuthority: managedOwner.authority,
  });
  try {
    const endpoint = `http://127.0.0.1:${port}/health`;
    const smoke = smokeInput(port, {
      endpoint,
      readiness: {
        timeoutMs: 5_000,
        pollIntervalMs: 25,
        healthCheck: async ({ endpoint: healthEndpoint }) => await healthy(healthEndpoint),
      },
    });
    const run = await runtime.run({
      plan: smokePlan(),
      executionProfile: smokeProfile(fixture.integration.revision, smoke),
      runtimeSmoke: smoke,
    });
    const check = runtimeCheck(run);
    const fact = check.facts[0] as typeof check.facts[number] & {
      executable: string;
      category: "runtime_smoke";
      endpoint: string;
      targetRevision: string;
      cwd: string;
      stdoutArtifactHash: string;
      cleanupSucceeded: boolean;
    };
    assert.equal(run.green, true);
    assert.equal(check.green, true);
    assert.equal(fact.kind, "command");
    assert.equal(fact.category, "runtime_smoke");
    assert.equal(fact.executable, process.execPath);
    assert.equal(fact.endpoint, endpoint);
    assert.equal(fact.targetRevision, fixture.integration.revision);
    assert.equal(fact.cwd, run.workspacePath);
    assert.equal(fact.cleanupSucceeded, true);
    assert.match((await artifacts.get(fact.stdoutArtifactHash)).toString(), /server ready/);
    assert.equal((await managed.listRun(fixture.runId))[0]?.status, "stopped");
    await assertPortReusable(port);
  } finally {
    await managedOwner.close();
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("runtime smoke timeout is non-green and cleans up the owned process", async (t) => {
  const fixture = await createFixture("smoke timeout");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const managedOwner = await createManagedExecution(fixture);
  const managed = managedOwner.service;
  const workspace = workspaceFor(fixture);
  const runtime = new FinalVerificationRuntime({
    execution: createTestOneShotCommandExecutor(t),
    workspaceManager: workspace,
    artifacts,
    evidenceStore: evidence,
    runId: fixture.runId,
    integrationRevision: () => fixture.integration.revision,
    managedProcessService: managed,
    managedProcessAuthority: managedOwner.authority,
  });
  try {
    const smoke = smokeInput(0, {
      readiness: { timeoutMs: 150, pollIntervalMs: 25, healthCheck: async () => false },
    });
    const run = await runtime.run({
      plan: smokePlan(),
      executionProfile: smokeProfile(fixture.integration.revision, smoke),
      runtimeSmoke: smoke,
    });
    const check = runtimeCheck(run);
    const fact = check.facts[0] as typeof check.facts[number] & { timedOut: boolean; cancelled: boolean };
    assert.equal(run.green, false);
    assert.equal(check.green, false);
    assert.equal(fact.timedOut, true);
    assert.equal(fact.cancelled, false);
    assert.equal((await managed.listRun(fixture.runId))[0]?.status, "stopped");
  } finally {
    await managedOwner.close();
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("runtime smoke marks an unhealthy process exit non-green and still stops it", async (t) => {
  const fixture = await createFixture("smoke unhealthy exit");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const managedOwner = await createManagedExecution(fixture);
  const managed = managedOwner.service;
  const workspace = workspaceFor(fixture);
  const runtime = new FinalVerificationRuntime({
    execution: createTestOneShotCommandExecutor(t),
    workspaceManager: workspace,
    artifacts,
    evidenceStore: evidence,
    runId: fixture.runId,
    integrationRevision: () => fixture.integration.revision,
    managedProcessService: managed,
    managedProcessAuthority: managedOwner.authority,
  });
  try {
    const smoke = smokeInput(0, {
      args: ["-e", "process.stderr.write('unhealthy'); process.exit(7)"],
      readiness: { timeoutMs: 2_000, pollIntervalMs: 25, healthCheck: async () => false },
    });
    const run = await runtime.run({
      plan: smokePlan(),
      executionProfile: smokeProfile(fixture.integration.revision, smoke),
      runtimeSmoke: smoke,
    });
    const check = runtimeCheck(run);
    const fact = check.facts[0] as typeof check.facts[number] & { exitCode: number | null; timedOut: boolean; cleanupSucceeded: boolean };
    assert.equal(run.green, false);
    assert.equal(check.green, false);
    assert.equal(fact.exitCode, 7);
    assert.equal(fact.timedOut, false);
    assert.match(check.issues.join(" "), /unhealthy|exit|readiness/i);
    assert.equal(fact.cleanupSucceeded, true, JSON.stringify(check.issues));
    assert.equal((await managed.listRun(fixture.runId))[0]?.status, "stopped");
  } finally {
    await managedOwner.close();
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

test("runtime smoke cancellation stops the process tree and releases the port", async (t) => {
  const fixture = await createFixture("smoke cancellation");
  const port = await freePort();
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const managedOwner = await createManagedExecution(fixture);
  const managed = managedOwner.service;
  const workspace = workspaceFor(fixture);
  const runtime = new FinalVerificationRuntime({
    execution: createTestOneShotCommandExecutor(t),
    workspaceManager: workspace,
    artifacts,
    evidenceStore: evidence,
    runId: fixture.runId,
    integrationRevision: () => fixture.integration.revision,
    managedProcessService: managed,
    managedProcessAuthority: managedOwner.authority,
  });
  try {
    const controller = new AbortController();
    const smoke = smokeInput(port, {
      endpoint: `http://127.0.0.1:${port}/health`,
      readiness: { timeoutMs: 5_000, pollIntervalMs: 25, healthCheck: async () => false },
    });
    const promise = runtime.run({
      plan: smokePlan(),
      executionProfile: smokeProfile(fixture.integration.revision, smoke),
      signal: controller.signal,
      runtimeSmoke: smoke,
    });
    await waitFor(async () => (await managed.listRun(fixture.runId)).length === 1, 5_000);
    controller.abort();
    const run = await promise;
    const check = runtimeCheck(run);
    const fact = check.facts[0] as typeof check.facts[number] & { timedOut: boolean; cancelled: boolean };
    assert.equal(run.green, false);
    assert.equal(check.green, false);
    assert.equal(fact.cancelled, true);
    assert.equal(fact.timedOut, false);
    assert.equal((await managed.listRun(fixture.runId))[0]?.status, "stopped");
    await assertPortReusable(port);
  } finally {
    await managedOwner.close();
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await closeFixture(fixture);
  }
});

function smokePlan(): FinalVerificationPlan {
  return {
    checks: [
      notApplicable("build", "No build command is configured for this fixture."),
      notApplicable("tests", "No test command is configured for this fixture."),
      { category: "runtime_smoke", status: "required" },
      notApplicable("browser", "No browser surface is configured for this fixture."),
    ],
  };
}

function notApplicable(category: "build" | "tests" | "runtime_smoke" | "browser", rationale: string) {
  return {
    category,
    status: "not_applicable" as const,
    rationale,
    repositoryInspection: { paths: ["package.json"], summary: rationale },
  };
}

function smokeInput(port: number, overrides: Partial<FinalVerificationRuntimeSmokeInput> = {}) {
  const script = [
    "const http=require('node:http');",
    "const server=http.createServer((req,res)=>{res.statusCode=200; res.end('ready');});",
    "server.listen(Number(process.argv[1]), '127.0.0.1', ()=>console.log('server ready'));",
    "setInterval(()=>{},1000);",
  ].join(" ");
  return {
    label: "runtime smoke",
    executable: process.execPath,
    args: ["-e", script, String(port)],
    endpoint: `http://127.0.0.1:${port}/health`,
    readiness: {
      timeoutMs: 5_000,
      pollIntervalMs: 25,
      healthCheck: async ({ endpoint }: { endpoint?: string }) => await healthy(endpoint),
    },
    ...overrides,
  } satisfies FinalVerificationRuntimeSmokeInput;
}

function smokeProfile(targetRevision: string, smoke: FinalVerificationRuntimeSmokeInput) {
  return {
    version: 1 as const,
    targetRevision,
    inspectedPaths: ["package.json"],
    detectedSignals: [{ category: "runtime_smoke" as const, source: "fixture", detail: "runtime" }],
    commands: {},
    runtimeSmoke: {
      label: smoke.label,
      executable: smoke.executable,
      args: [...smoke.args],
      ...(smoke.endpoint ? { endpoint: smoke.endpoint } : {}),
      ...(smoke.timeoutMs ? { timeoutMs: smoke.timeoutMs } : {}),
      readiness: {
        ...(smoke.readiness.timeoutMs ? { timeoutMs: smoke.readiness.timeoutMs } : {}),
        ...(smoke.readiness.pollIntervalMs ? { pollIntervalMs: smoke.readiness.pollIntervalMs } : {}),
        ...(smoke.readiness.expectedStatus ? { expectedStatus: smoke.readiness.expectedStatus } : {}),
      },
    },
  };
}

function runtimeCheck(run: Awaited<ReturnType<FinalVerificationRuntime["run"]>>) {
  const check = run.checks.find((candidate) => candidate.category === "runtime_smoke");
  assert.ok(check);
  return check;
}

async function healthy(endpoint: string | undefined): Promise<boolean> {
  if (!endpoint) return false;
  try {
    const response = await fetch(endpoint);
    return response.status === 200 && (await response.text()) === "ready";
  } catch {
    return false;
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port.");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function assertPortReusable(port: number): Promise<void> {
  const server = createServer((_request, response) => response.end("reused"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

interface Fixture {
  root: string;
  project: string;
  state: string;
  runId: string;
  integration: IntegrationManager;
}

async function createFixture(name: string): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-final-verification-b1-${name}-`));
  const project = join(root, "user checkout");
  const state = join(root, "runner state & data");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "README.md"), "baseline\n");
  const runId = `run_${name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const integration = new IntegrationManager({ repositoryRoot: project, stateDirectory: state, runId, baselineRevision: baseline.revision });
  await integration.initialize();
  return { root, project, state, runId, integration };
}

async function createManagedExecution(fixture: Fixture) {
  const host = createExecutionHost({
    projectRoot: fixture.project,
    stateDirectory: join(fixture.state, "managed-execution-host"),
    artifacts: new ArtifactStore(join(fixture.root, "managed-artifacts")),
    ambientEnvironment: process.platform === "win32" ? minimalWindowsSemanticProbeEnvironment(process.env) : {},
  });
  const run = await host.bindRun({
    runId: fixture.runId,
    permissionProfile: "full",
    capabilityContract: { digest: "f".repeat(64) } as RunnerCapabilityContract,
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
  });
  return {
    service: run.managedProcesses,
    authority: { executionGrants: run.executionGrants, permissionProfile: "full" as const },
    async close() { await run.close(); await host.close(); },
  };
}

function workspaceFor(fixture: Fixture): VerificationWorkspaceManager {
  return new VerificationWorkspaceManager({
    repositoryRoot: fixture.project,
    stateDirectory: fixture.state,
    runId: fixture.runId,
    targetRevision: fixture.integration.revision,
  });
}

async function closeFixture(fixture: Fixture): Promise<void> {
  await fixture.integration.cleanup().catch(() => undefined);
  rmSync(fixture.root, { recursive: true, force: true });
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Condition was not met within ${timeoutMs} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
