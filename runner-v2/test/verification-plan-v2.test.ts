/**
 * VF3 process tests: checks run in a fresh verification checkout with real processes (about
 * 30 s in all). They are not in required PR CI; the in-memory contract tests are in
 * verification-plan-v2-contract.test.ts.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import type { CheckToolLookup } from "../src/check-tool-lookup.js";
import { createExecutionHost } from "../src/execution-host.js";
import { withResolvedVerificationPlan } from "../src/final-verification-profile.js";
import { submitFinalVerificationV2 } from "../src/final-verification-submission.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { buildCompletionReadiness, rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import {
  assertVerificationCheckV2Semantics,
  completeVerificationPlanV2,
  type VerificationPlanV2,
} from "../src/verification-plan-v2.js";
import { minimalWindowsSemanticProbeEnvironment } from "../src/windows-process-semantic-probes.js";
import { acceptFinalVerificationProfile, emptyFinalVerificationProfile } from "./support/final-verification-profile.js";
import {
  captureGitBaseline,
  FinalVerificationRuntime,
  IntegrationManager,
  VerificationWorkspaceManager,
} from "./support/git-fixture.js";
import { createTestOneShotCommandExecutor } from "./support/one-shot-command-executor.js";
import {
  FINAL_TASK_ID,
  GENERATION_ID,
  WHEN,
  appendCheck,
  approveV2,
  seedV2Run,
} from "./support/verification-plan-v2-fixtures.js";

test("an Architect-added check runs in the fresh verification checkout, and the run records its facts", async (t) => {
  const fixture = await createGitFixture("architect check");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const workspace = workspaceFor(fixture);
  const store = schedulerStore(fixture, evidence, artifacts);
  try {
    const revision = fixture.integration.revision;
    const script = "const fs=require('node:fs');if(!fs.existsSync('README.md'))process.exit(3);fs.writeFileSync('report.txt','checked '+process.cwd());console.log('readme present');";
    const completed = completeVerificationPlanV2({
      checks: [{ id: "readme", label: "README ships in the checkout", kind: "other", run: { executable: "node", args: ["-e", script] }, outputs: ["report.txt"] }],
      skipped: [],
    }, []);
    assert.equal(completed.ok, true, completed.ok ? "" : completed.issues.join(" "));
    const plan = (completed as { plan: VerificationPlanV2 }).plan;
    assert.deepEqual([plan.checks[0]!.origin, plan.checks[0]!.mandatory], ["architect", false]);
    const profile = withResolvedVerificationPlan(emptyFinalVerificationProfile(revision), plan);
    assert.equal(profile.verification?.checks[0]?.commands[0]?.executable, process.execPath, "node is the Runner's own Node");

    seedV2Run(store, fixture.runId, revision, plan, profile);
    const runtime = new FinalVerificationRuntime({
      execution: createTestOneShotCommandExecutor(t),
      workspaceManager: workspace,
      artifacts,
      evidenceStore: evidence,
      runId: fixture.runId,
      taskId: FINAL_TASK_ID,
      attempt: 1,
      generationId: GENERATION_ID,
      integrationRevision: () => revision,
    });
    const run = await runtime.runCheckV2({ executionProfile: profile, checkId: "readme" });
    assert.equal(run.check.outcome, "passed", run.check.issues.join("\n"));
    assert.notEqual(run.workspacePath, fixture.project, "the check never runs in the user's checkout");
    const fact = run.check.facts[0] as unknown as {
      cwd: string; executable: string; args: string[]; exitCode: number;
      outputs?: { files: Array<{ path: string; artifactHash: string }> };
    };
    assert.equal(fact.cwd, run.workspacePath);
    assert.deepEqual([fact.executable, fact.args, fact.exitCode], [process.execPath, ["-e", script], 0]);
    assert.deepEqual(fact.outputs?.files.map((file) => file.path), ["report.txt"]);
    assert.match((await artifacts.get(fact.outputs!.files[0]!.artifactHash)).toString(), /^checked /);
    assert.doesNotThrow(() => assertVerificationCheckV2Semantics({
      check: run.check, resolution: profile.verification!, targetRevision: revision, workspacePath: run.workspacePath,
    }));

    // The scheduler validates the facts against the evidence and the resolved plan, then the
    // submission, the review and the completion gate all key the check by its id.
    appendCheck(store, fixture.runId, revision, run.workspacePath, run.check);
    const recorded = rebuildSchedulerProjection(store.readRun(fixture.runId)).finalVerification!.current!;
    assert.deepEqual(recorded.completedChecks?.map((check) => "checkId" in check ? [check.checkId, check.outcome] : []), [["readme", "passed"]]);
    const submission = await submitFinalVerificationV2({
      generationId: GENERATION_ID, runId: fixture.runId, taskId: FINAL_TASK_ID, attempt: 1, plan, executionProfile: profile,
      targetRevision: revision, workspacePaths: { readme: run.workspacePath }, checks: [run.check],
    }, { evidenceStore: evidence, artifacts, currentIntegrationRevision: () => revision, clock: () => WHEN });
    approveV2(store, fixture.runId, revision, submission, [{ checkId: "readme", evidenceIds: [...run.check.evidenceIds] }]);
    const readiness = buildCompletionReadiness(rebuildSchedulerProjection(store.readRun(fixture.runId)));
    assert.deepEqual(readiness.issues.filter((issue) => /final.verification/i.test(issue)), []);
  } finally {
    store.close();
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await closeGitFixture(fixture);
  }
});

test("a start check proves a CLI by its exit code", async (t) => {
  const fixture = await createGitFixture("cli exit");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const workspace = workspaceFor(fixture);
  try {
    const revision = fixture.integration.revision;
    const cli = "console.log('usage: tool <file>');process.exit(2);";
    const plan = (completeVerificationPlanV2({
      checks: [
        { id: "cli-usage", label: "tool prints usage", kind: "start", start: { executable: "node", args: ["-e", cli], ready: { exitCode: 2 } } },
        { id: "cli-wrong", label: "tool exits 0", kind: "start", start: { executable: "node", args: ["-e", cli], ready: { exitCode: 0 } } },
      ],
      skipped: [],
    }, []) as { plan: VerificationPlanV2 }).plan;
    const profile = withResolvedVerificationPlan(emptyFinalVerificationProfile(revision), plan);
    const runtime = new FinalVerificationRuntime({
      execution: createTestOneShotCommandExecutor(t), workspaceManager: workspace, artifacts, evidenceStore: evidence,
      runId: fixture.runId, taskId: FINAL_TASK_ID, attempt: 1, generationId: GENERATION_ID, integrationRevision: () => revision,
    });
    const usage = await runtime.runCheckV2({ executionProfile: profile, checkId: "cli-usage" });
    assert.equal(usage.check.outcome, "passed", usage.check.issues.join("\n"));
    assert.equal((usage.check.facts[0] as unknown as { exitCode: number }).exitCode, 2);
    assert.doesNotThrow(() => assertVerificationCheckV2Semantics({
      check: usage.check, resolution: profile.verification!, targetRevision: revision, workspacePath: usage.workspacePath,
    }));
    const wrong = await runtime.runCheckV2({ executionProfile: profile, checkId: "cli-wrong" });
    assert.equal(wrong.check.outcome, "failed", "exit 2 is not the expected exit 0");
    assert.equal(wrong.check.green, false);
  } finally {
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await closeGitFixture(fixture);
  }
});

test("a start check proves a server ready on HTTP on the leased port, then runs its steps", async (t) => {
  const fixture = await createGitFixture("server http");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const workspace = workspaceFor(fixture);
  const managed = await createManagedExecution(fixture);
  const port = await freePort();
  try {
    const revision = fixture.integration.revision;
    const server = "require('node:http').createServer((req,res)=>{res.statusCode=req.url==='/healthz'||req.url==='/pair'?200:404;res.end();}).listen(Number(process.argv[1]),'127.0.0.1',()=>console.log('listening'));";
    const pair = "fetch(process.argv[1]).then((r)=>{if(r.status!==200)throw new Error('pair answered '+r.status);console.log('paired');});";
    const plan = (completeVerificationPlanV2({
      checks: [{
        id: "relay", label: "relay server", kind: "start",
        start: {
          executable: "node", args: ["-e", server, "{port}"], ready: { http: { path: "/healthz", status: 200 } },
          steps: [{ label: "pair a connector", executable: "node", args: ["-e", pair, "http://127.0.0.1:{port}/pair"] }],
        },
      }],
      skipped: [],
    }, []) as { plan: VerificationPlanV2 }).plan;
    const lease = { version: 1 as const, runId: fixture.runId, targetRevision: revision, port, leaseId: "lease-relay" };
    const profile = withResolvedVerificationPlan(emptyFinalVerificationProfile(revision), plan, [], lease);
    const resolved = profile.verification!.checks[0]!;
    assert.equal(resolved.mode, "program");
    assert.equal(resolved.endpoint, `http://127.0.0.1:${port}/healthz`);
    assert.deepEqual(resolved.commands[0]!.args, ["-e", server, String(port)]);
    const runtime = new FinalVerificationRuntime({
      execution: createTestOneShotCommandExecutor(t), workspaceManager: workspace, artifacts, evidenceStore: evidence,
      runId: fixture.runId, taskId: FINAL_TASK_ID, attempt: 1, generationId: GENERATION_ID, integrationRevision: () => revision,
      managedProcessService: managed.service, managedProcessAuthority: managed.authority,
    });
    const run = await runtime.runCheckV2({ executionProfile: profile, checkId: "relay" });
    assert.equal(run.check.outcome, "passed", run.check.issues.join("\n"));
    assert.equal(run.check.facts.length, 2);
    const [started, step] = run.check.facts as unknown as Array<{ endpoint?: string; workflowStep?: true; label: string; exitCode: number | null }>;
    assert.equal(started!.endpoint, `http://127.0.0.1:${port}/healthz`);
    assert.deepEqual([step!.label, step!.workflowStep, step!.exitCode], ["relay server › pair a connector", true, 0]);
    assert.doesNotThrow(() => assertVerificationCheckV2Semantics({
      check: run.check, resolution: profile.verification!, targetRevision: revision, workspacePath: run.workspacePath,
    }));
    await assertPortReusable(port);
  } finally {
    await managed.close();
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await closeGitFixture(fixture);
  }
});

test("a run check's tool is looked up in the check's own folder, where it launches", async (t) => {
  const fixture = await createGitFixture("tool cwd", { "android/gradlew": "#!/bin/sh\n" });
  const slash = (path: string) => path.replaceAll("\\", "/");
  const artifacts = new ArtifactStore(join(fixture.root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
  const workspace = workspaceFor(fixture);
  try {
    const revision = fixture.integration.revision;
    const plan = (completeVerificationPlanV2({
      checks: [
        { id: "android", label: "Android unit tests", kind: "tests", run: { executable: "gradlew", args: ["test"], cwd: "android" } },
        { id: "root", label: "root build", kind: "build", run: { executable: "gradlew", args: ["build"] } },
      ],
      skipped: [],
    }, []) as { plan: VerificationPlanV2 }).plan;
    const profile = withResolvedVerificationPlan(emptyFinalVerificationProfile(revision), plan);
    // Each lookup is recorded; the tool is reported missing so nothing launches.
    const lookups: string[] = [];
    const toolLookup: CheckToolLookup = async (_executable, { cwd }) => {
      lookups.push(cwd);
      return { status: "missing" };
    };
    const runtime = new FinalVerificationRuntime({
      execution: createTestOneShotCommandExecutor(t), workspaceManager: workspace, artifacts, evidenceStore: evidence,
      runId: fixture.runId, taskId: FINAL_TASK_ID, attempt: 1, generationId: GENERATION_ID, integrationRevision: () => revision,
      toolLookup,
    });
    const android = await runtime.runCheckV2({ executionProfile: profile, checkId: "android" });
    assert.equal(android.check.outcome, "not_run");
    assert.deepEqual(lookups.map(slash), [`${slash(android.workspacePath)}/android`]);
    lookups.length = 0;
    const root = await runtime.runCheckV2({ executionProfile: profile, checkId: "root" });
    assert.equal(root.check.outcome, "not_run");
    assert.deepEqual(lookups.map(slash), [slash(root.workspacePath)], "a check with no cwd is looked up at the checkout root");
  } finally {
    evidence.close();
    await workspace.cleanup().catch(() => undefined);
    await closeGitFixture(fixture);
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface GitFixture {
  root: string;
  project: string;
  state: string;
  runId: string;
  integration: IntegrationManager;
}

async function createGitFixture(name: string, files: Record<string, string> = {}): Promise<GitFixture> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-verification-plan-v2-${name}-`));
  const project = join(root, "user checkout");
  const state = join(root, "runner state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "README.md"), "baseline\n");
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(project, path, ".."), { recursive: true });
    writeFileSync(join(project, path), content);
  }
  const runId = `run_v2_${name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const integration = new IntegrationManager({ repositoryRoot: project, stateDirectory: state, runId, baselineRevision: baseline.revision });
  await integration.initialize();
  return { root, project, state, runId, integration };
}

async function closeGitFixture(fixture: GitFixture): Promise<void> {
  await fixture.integration.cleanup().catch(() => undefined);
  rmSync(fixture.root, { recursive: true, force: true });
}

function workspaceFor(fixture: GitFixture): VerificationWorkspaceManager {
  return new VerificationWorkspaceManager({
    repositoryRoot: fixture.project, stateDirectory: fixture.state, runId: fixture.runId, targetRevision: fixture.integration.revision,
  });
}

function schedulerStore(fixture: GitFixture, evidence: SqliteEvidenceStore, artifacts: ArtifactStore): SqliteSchedulerStore {
  return new SqliteSchedulerStore(join(fixture.root, "scheduler.sqlite"), {
    evidenceStore: evidence, artifacts, validateCleanupReceipt: () => undefined, validateExecutionProfile: acceptFinalVerificationProfile,
  });
}

async function createManagedExecution(fixture: GitFixture) {
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
