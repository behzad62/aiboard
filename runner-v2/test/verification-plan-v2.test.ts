import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallBlock } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createArchitectTools } from "../src/architect-tools.js";
import { BuildRuntime, type FinalVerificationCheckDriverInput } from "../src/build-runtime.js";
import { createExecutionHost } from "../src/execution-host.js";
import type { FinalVerificationPlan } from "../src/final-verification-contracts.js";
import {
  cloneFinalVerificationExecutionProfile,
  verificationSuggestionsForProfile,
  withResolvedVerificationPlan,
  type FinalVerificationExecutionProfile,
} from "../src/final-verification-profile.js";
import { submitFinalVerificationV2 } from "../src/final-verification-submission.js";
import { ensurePlanningProvisioningPrefix } from "../src/native-planning-provisioner.js";
import { failingTestIdsByCategory, withFailingIds } from "../src/repair-budget-contracts.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import {
  buildCompletionReadiness,
  deriveFinalVerificationFailure,
  rebuildSchedulerProjection,
} from "../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { ToolRegistry } from "../src/tool-registry.js";
import {
  assertVerificationCheckV2Semantics,
  completeVerificationPlanV2,
  detectedVerificationSuggestions,
  skippedVerificationResults,
  validateVerificationPlanV2,
  type VerificationCheckV2,
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

const FINAL_TASK_ID = "final-verification-v2";
const GENERATION_ID = "final-verification-v2-generation";
const SUBMISSION_ID = `final-verification-submission:${GENERATION_ID}`;
const REVIEW_ID = `final-verification-review:${GENERATION_ID}`;
const WHEN = "2026-11-13T00:00:00.000Z";

function detectedSuggestions(): VerificationCheckV2[] {
  return detectedVerificationSuggestions({
    build: [{ label: "npm run build", executable: "npm", args: ["run", "build"] }],
    tests: [{ label: "npm test", executable: "npm", args: ["test"] }],
  }).map((suggestion) => suggestion.check);
}

test("a detected check is skipped with a reason; one left out without a reason is refused", () => {
  const suggestions = detectedSuggestions();
  assert.deepEqual(suggestions.map((check) => [check.id, check.kind, check.origin, check.mandatory]), [
    ["build", "build", "detected", false],
    ["tests", "tests", "detected", false],
  ]);
  const tests = suggestions.find((check) => check.id === "tests")!;
  const skipped = completeVerificationPlanV2({
    checks: [{ id: tests.id, label: tests.label, kind: tests.kind, run: tests.run }],
    skipped: [{ checkId: "build", reason: "The package has no build step; tsx runs the TypeScript directly." }],
  }, suggestions);
  assert.equal(skipped.ok, true, skipped.ok ? "" : skipped.issues.join(" "));
  const plan = (skipped as { plan: VerificationPlanV2 }).plan;
  assert.deepEqual(plan.checks.map((check) => [check.id, check.origin, check.mandatory]), [["tests", "detected", false]]);
  assert.deepEqual(skippedVerificationResults(plan, suggestions), [{
    checkId: "build", kind: "build", label: "npm run build", origin: "detected", mandatory: false,
    outcome: "not_run", green: false, evidenceIds: [], facts: [], issues: [],
    notRun: { reason: "skipped", detail: "The package has no build step; tsx runs the TypeScript directly." },
  }]);

  const omitted = completeVerificationPlanV2({ checks: [{ id: tests.id, label: tests.label, kind: tests.kind, run: tests.run }] }, suggestions);
  assert.equal(omitted.ok, false);
  assert.match((omitted as { issues: string[] }).issues.join(" "), /Suggested check build must be kept, changed, or listed in skipped/);
  const noReason = completeVerificationPlanV2({
    checks: [{ id: tests.id, label: tests.label, kind: tests.kind, run: tests.run }],
    skipped: [{ checkId: "build", reason: " " }],
  }, suggestions);
  assert.equal(noReason.ok, false);
  const unknownSkip = completeVerificationPlanV2({
    checks: suggestions.map((check) => ({ id: check.id, label: check.label, kind: check.kind, run: check.run })),
    skipped: [{ checkId: "lint", reason: "Not suggested." }],
  }, suggestions);
  assert.equal(unknownSkip.ok, false);
  assert.match((unknownSkip as { issues: string[] }).issues.join(" "), /lint is not one the Runner suggested/);
});

test("a mandatory check can be neither skipped nor changed, and only the Runner sets mandatory", () => {
  // VF4 will read mandatory from aiboard-validation.json; until then the contract alone refuses it.
  const suggestions = detectedSuggestions().map((check) => check.id === "build" ? { ...check, mandatory: true } : check);
  const build = suggestions.find((check) => check.id === "build")!;
  const tests = suggestions.find((check) => check.id === "tests")!;
  const keep = (check: VerificationCheckV2) => ({ id: check.id, label: check.label, kind: check.kind, run: check.run });

  const kept = completeVerificationPlanV2({ checks: [keep(build), keep(tests)], skipped: [] }, suggestions);
  assert.equal(kept.ok, true, kept.ok ? "" : kept.issues.join(" "));
  assert.equal((kept as { plan: VerificationPlanV2 }).plan.checks[0]!.mandatory, true, "the Runner fills mandatory in");

  const skipped = completeVerificationPlanV2({ checks: [keep(tests)], skipped: [{ checkId: "build", reason: "Too slow." }] }, suggestions);
  assert.equal(skipped.ok, false);
  assert.match((skipped as { issues: string[] }).issues.join(" "), /build is mandatory and cannot be skipped/);

  const changed = completeVerificationPlanV2({
    checks: [{ ...keep(build), run: { executable: "npm", args: ["run", "build:fast"] } }, keep(tests)],
    skipped: [],
  }, suggestions);
  assert.equal(changed.ok, false);
  assert.match((changed as { issues: string[] }).issues.join(" "), /build is mandatory and cannot be changed/);

  const relabeled = completeVerificationPlanV2({ checks: [{ ...keep(build), label: "Build it" }, keep(tests)], skipped: [] }, suggestions);
  assert.equal(relabeled.ok, false, "a label change is a change too");

  const unflagged = completeVerificationPlanV2({ checks: [{ ...keep(build), mandatory: false }, keep(tests)], skipped: [] }, suggestions);
  assert.equal(unflagged.ok, false);
  assert.match((unflagged as { issues: string[] }).issues.join(" "), /mandatory is set only by the Runner/);

  const ownMandatory = completeVerificationPlanV2({
    checks: [keep(build), keep(tests), { id: "smoke", label: "Smoke", kind: "other", mandatory: true, run: { executable: "node", args: ["smoke.js"] } }],
    skipped: [],
  }, suggestions);
  assert.equal(ownMandatory.ok, false);

  // The durable boundary holds the same rules for a plan that arrives already complete.
  const forged: VerificationPlanV2 = { version: 2, checks: [{ ...tests }], skipped: [{ checkId: "build", reason: "Forged." }] };
  const validation = validateVerificationPlanV2(forged, { suggestions });
  assert.equal(validation.valid, false);
  assert.match(validation.issues.join(" "), /build is mandatory and cannot be skipped/);
});

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

    seedV2Run(store, revision, plan, profile);
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
    appendCheck(store, revision, run.workspacePath, run.check);
    const recorded = rebuildSchedulerProjection(store.readRun(fixture.runId)).finalVerification!.current!;
    assert.deepEqual(recorded.completedChecks?.map((check) => "checkId" in check ? [check.checkId, check.outcome] : []), [["readme", "passed"]]);
    const submission = await submitFinalVerificationV2({
      generationId: GENERATION_ID, runId: fixture.runId, taskId: FINAL_TASK_ID, attempt: 1, plan, executionProfile: profile,
      targetRevision: revision, workspacePaths: { readme: run.workspacePath }, checks: [run.check],
    }, { evidenceStore: evidence, artifacts, currentIntegrationRevision: () => revision, clock: () => WHEN });
    approveV2(store, revision, submission, [{ checkId: "readme", evidenceIds: [...run.check.evidenceIds] }]);
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

test("repairs are keyed by check id, from the failure through the repair tasks", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 verification plan v2 repairs "));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    evidenceStore: evidence, validateCleanupReceipt: () => undefined, validateExecutionProfile: acceptFinalVerificationProfile,
  });
  const runId = "run-verification-plan-v2-repairs";
  const revision = "a".repeat(40);
  try {
    const base: FinalVerificationExecutionProfile = {
      ...emptyFinalVerificationProfile(revision),
      detectedSignals: [{ category: "build", source: "fixture", detail: "build" }, { category: "tests", source: "fixture", detail: "tests" }],
      commands: { build: [{ label: "build", executable: "fixture", args: [] }], tests: [{ label: "tests", executable: "fixture", args: [] }] },
    };
    const suggestions = verificationSuggestionsForProfile(base).map((suggestion) => suggestion.check);
    const plan = (completeVerificationPlanV2({
      checks: [
        { id: "build", label: "build", kind: "build", run: { executable: "fixture", args: [] } },
        { id: "smoke-cli", label: "CLI prints its version", kind: "start", start: { executable: "node", args: ["cli.js", "--version"], ready: { exitCode: 0 } } },
      ],
      skipped: [{ checkId: "tests", reason: "The fixture's tests need a database this machine does not have." }],
    }, suggestions) as { plan: VerificationPlanV2 }).plan;
    const profile = withResolvedVerificationPlan(base, plan);
    seedV2Run(store, revision, plan, profile, runId);
    for (const checkId of ["build", "smoke-cli"]) {
      const planned = plan.checks.find((check) => check.id === checkId)!;
      appendCheck(store, revision, "C:/verify", {
        checkId, kind: planned.kind, label: planned.label, origin: planned.origin, mandatory: false,
        outcome: "failed", green: false, evidenceIds: [], facts: [], issues: [`${checkId} exited 1`],
      }, runId);
    }
    const generation = rebuildSchedulerProjection(store.readRun(runId)).finalVerification!.current!;
    const failure = deriveFinalVerificationFailure(generation, 1);
    assert.deepEqual([failure.failedCategories, failure.failedCheckIds], [[], ["build", "smoke-cli"]]);
    assert.deepEqual(
      [...failingTestIdsByCategory(generation.completedChecks ?? []).keys()],
      ["build", "smoke-cli"],
      "failing test ids are keyed by check id",
    );
    assert.equal(withFailingIds("smoke-cli", new Map()), "final-verification:smoke-cli");
    store.append({ runId, type: "final_verification.failure_reported", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "failure", payload: { ...failure } });
    store.append({ runId, type: "final_verification.cleanup_started", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "cleanup-start", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, attempt: 1 } });
    store.append({ runId, type: "final_verification.cleanup_succeeded", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "cleanup-success", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, attempt: 1, diagnosticsPath: "C:/diagnostics/failure.json" } });

    const tools = new ToolRegistry();
    for (const tool of createArchitectTools({ store, evidenceStore: evidence, finalVerificationRepairPlanAvailable: true, verificationContractVersion: 2 })) tools.register(tool);
    const source = { type: "mechanical_failure", failureId: failure.failureId, issueIds: failure.issueIds, factIds: failure.factIds };
    const task = (id: string, keys: Record<string, string[]>) => ({
      id, objective: `Repair ${id}`, ...keys, evidenceIds: [], dependencies: ["implementation-one"], requiredCapabilities: ["code"],
      acceptanceCriteria: [{ id: "fixed", text: `${id} passes.` }],
    });
    const invoke = async (tasks: unknown[]) => await tools.invoke(
      { type: "tool_call", callId: `repairs-${tasks.length}-${Math.random()}`, name: "plan_verification_repairs", arguments: { finalVerificationTaskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, source, tasks } } as ToolCallBlock,
      { runId, sessionId: "architect:v2-repairs", actor: { role: "architect", id: "architect" } },
    );
    const byCategory = await invoke([task("repair-build", { categories: ["build"] }), task("repair-cli", { categories: ["build"] })]);
    assert.equal(byCategory.isError, true, "a v2 repair names checks, not categories");
    const partial = await invoke([task("repair-build", { checkIds: ["build"] })]);
    assert.equal(partial.isError, true, "every failed check is covered exactly once");
    const planned = await invoke([task("repair-build", { checkIds: ["build"] }), task("repair-cli", { checkIds: ["smoke-cli"] })]);
    assert.equal(planned.isError, false, JSON.stringify(planned.content));
    const repairs = Object.values(rebuildSchedulerProjection(store.readRun(runId)).tasks)
      .filter((candidate) => candidate.kind === "verification_repair")
      .map((candidate) => [candidate.id, candidate.verificationRepair?.categories, candidate.verificationRepair?.checkIds]);
    assert.deepEqual(repairs, [["repair-build", [], ["build"]], ["repair-cli", [], ["smoke-cli"]]]);
  } finally {
    store.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("build-runtime plans, runs and repairs a v2 final verification by check id", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 verification plan v2 runtime "));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    evidenceStore: evidence, validateCleanupReceipt: () => undefined, validateExecutionProfile: acceptFinalVerificationProfile,
  });
  const runId = "run-verification-plan-v2-runtime";
  const revision = "c".repeat(40);
  const profileFor = async (targetRevision: string): Promise<FinalVerificationExecutionProfile> => ({
    ...emptyFinalVerificationProfile(targetRevision),
    detectedSignals: [{ category: "build", source: "fixture", detail: "build" }],
    commands: { build: [{ label: "build", executable: "fixture", args: [] }] },
  });
  const reasons: string[] = [];
  const driverInputs: FinalVerificationCheckDriverInput[] = [];
  let repairsPlanned = false;
  try {
    store.append({ runId, type: "run.initialized", occurredAt: WHEN, actor: { role: "runner", id: "runner" }, idempotencyKey: "init", payload: { verificationContractVersion: 2 } });
    seedTasks(store, runId, revision);
    const runtime = new BuildRuntime({
      runId,
      store,
      evidenceStore: evidence,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: revision }) },
      maxConcurrency: 1,
      workspaceFor: async (task) => `C:/repair/${task.id}`,
      finalVerificationProfileFor: profileFor,
      finalVerificationWithPlan: async (profile, plan) => withResolvedVerificationPlan(profile, plan),
      finalVerificationArchitectCommands: false,
      finalVerificationDriver: {
        executeCheck: async (input) => {
          driverInputs.push(input);
          return {
            workspacePath: "C:/verify", startedAt: WHEN, finishedAt: WHEN,
            check: { checkId: "build", kind: "build", label: "build", origin: "detected", mandatory: false, outcome: "failed", green: false, evidenceIds: [], facts: [], issues: ["build exited 1"] },
          };
        },
      },
      finalVerificationCleanupDriver: { cleanup: async () => ({ diagnosticsPath: "C:/diagnostics/v2.json" }) },
      architectDriver: {
        run: async (request) => {
          reasons.push(request.reason.type);
          const call = async (name: string, args: Record<string, unknown>) => await request.tools.invoke(
            { type: "tool_call", callId: `${name}-${reasons.length}-${Math.random()}`, name, arguments: args }, request.context);
          if (request.reason.type === "final_verification_plan_required") {
            const prefill = request.reason.planPrefill as { version?: number; suggestedChecks?: VerificationCheckV2[] } | undefined;
            assert.equal(prefill?.version, 2, "a v2 run is offered suggested checks");
            assert.deepEqual(prefill?.suggestedChecks?.map((check) => check.id), ["build"]);
            const own = await call("plan_final_verification", { plan: { version: 2, checks: [
              { id: "build", label: "build", kind: "build", run: { executable: "fixture", args: [] } },
              { id: "smoke", label: "CLI smoke", kind: "start", start: { executable: "node", args: ["cli.js"], ready: { exitCode: 0 } } },
            ], skipped: [] } });
            assert.equal(own.isError, true);
            assert.equal(own.error?.code, "final_verification_commands_need_full_access");
            const v1 = await call("plan_final_verification", { plan: { checks: [{ category: "build", status: "required" }] } });
            assert.equal(v1.isError, true, "a v2 run refuses the four categories");
            const kept = await call("plan_final_verification", { plan: { version: 2, checks: [
              { id: "build", label: "build", kind: "build", run: { executable: "fixture", args: [] } },
            ], skipped: [] } });
            assert.equal(kept.isError, false, kept.error?.message ?? "");
            return;
          }
          if (request.reason.type === "final_verification_repair_plan_required") {
            assert.deepEqual(request.reason.failedCategories, []);
            assert.deepEqual(request.reason.failedCheckIds, ["build"]);
            const source = request.reason.source;
            const planned = await call("plan_verification_repairs", {
              finalVerificationTaskId: request.reason.finalVerificationTaskId, generationId: request.reason.generationId,
              targetRevision: request.reason.targetRevision, source,
              tasks: [{ id: "repair-build", objective: "Repair the build", checkIds: ["build"], evidenceIds: [], dependencies: ["implementation-one"], requiredCapabilities: ["code"], acceptanceCriteria: [{ id: "green", text: "The build check passes." }] }],
            });
            assert.equal(planned.isError, false, planned.error?.message ?? "");
            repairsPlanned = true;
            return;
          }
          throw new Error(`Unexpected Architect reason ${request.reason.type}`);
        },
      },
    });
    for (let step = 0; step < 10 && !repairsPlanned; step += 1) await runtime.step();
    assert.equal(repairsPlanned, true, reasons.join(", "));
    assert.deepEqual(driverInputs.map((input) => [input.checkId, input.category]), [["build", "build"]]);
    const current = rebuildSchedulerProjection(store.readRun(runId)).finalVerification!.current!;
    assert.deepEqual([current.failure?.failedCategories, current.failure?.failedCheckIds], [[], ["build"]]);
    const repair = rebuildSchedulerProjection(store.readRun(runId)).tasks["repair-build"];
    assert.deepEqual([repair?.verificationRepair?.categories, repair?.verificationRepair?.checkIds], [[], ["build"]]);
  } finally {
    store.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a v1 run started before VF3 replays and finishes on the four categories unchanged", () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 verification plan v1 replay "));
  const database = join(root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const options = { evidenceStore: evidence, validateCleanupReceipt: () => undefined, validateExecutionProfile: acceptFinalVerificationProfile };
  let store = new SqliteSchedulerStore(database, options);
  const runId = "run-verification-plan-v1-replay";
  const revision = "b".repeat(40);
  try {
    const v1Plan: FinalVerificationPlan = { checks: (["build", "tests", "runtime_smoke", "browser"] as const).map((category) => ({
      category, status: "not_applicable" as const, rationale: `No ${category} fixture.`,
      repositoryInspection: { paths: ["package.json"], summary: `No ${category} fixture.` },
    })) };
    const profile = emptyFinalVerificationProfile(revision);
    store.append({ runId, type: "run.initialized", occurredAt: WHEN, actor: { role: "runner", id: "runner" }, idempotencyKey: "init", payload: {} });
    seedTasks(store, runId, revision);
    // A v2 plan on a run started before VF3 is refused: the run keeps its contract to the end.
    const v2Plan: VerificationPlanV2 = { version: 2, checks: [], skipped: [] };
    assert.throws(() => store.append({ runId, type: "final_verification.generation_created", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "generation-v2", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, planVersion: 1, plan: v2Plan, executionProfile: withResolvedVerificationPlan(profile, v2Plan, []) } }), /keeps the four fixed categories/);
    store.append({ runId, type: "final_verification.generation_created", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "generation", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, planVersion: 1, plan: v1Plan, executionProfile: profile } });
    for (const check of v1Plan.checks) {
      store.append({ runId, type: "final_verification.check_completed", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: `check:${check.category}`, payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, attempt: 1, workspacePath: "C:/verify", startedAt: WHEN, finishedAt: WHEN, result: { ...check, green: true, evidenceIds: [], facts: [], issues: [] } } });
    }
    store.append({ runId, type: "final_verification.submitted", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "submission", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, submissionId: SUBMISSION_ID, attempt: 1, submissionResult: { kind: "final_verification_submission", generationId: GENERATION_ID, runId, taskId: FINAL_TASK_ID, attempt: 1, targetRevision: revision, plan: v1Plan, executionProfile: profile, checks: v1Plan.checks.map((check) => ({ ...check, green: true, evidenceIds: [], facts: [] })), evidenceIds: [], submittedAt: WHEN, green: true } } });
    cleanupAndRequestReview(store, runId, revision);
    store.append({ runId, type: "final_verification.review_decided", occurredAt: WHEN, actor: { role: "architect", id: "architect" }, idempotencyKey: "review-decision", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, submissionId: SUBMISSION_ID, reviewId: REVIEW_ID, attempt: 1, decision: "approved", summary: "Every category is not applicable to this fixture.", architectRisk: "low", architectRiskRationale: "Nothing to verify.", categoryReviews: v1Plan.checks.map((check) => ({ category: check.category, verdict: "approved", rationale: `No ${check.category} surface.`, evidenceIds: [] })) } });

    const first = rebuildSchedulerProjection(store.readRun(runId));
    assert.equal(first.verificationContractVersion, undefined, "a pre-VF3 run records no contract version");
    assert.deepEqual(first.finalVerification?.current?.review?.decision?.failedCategories, []);
    assert.equal(first.finalVerification?.current?.review?.decision?.checkReviews, undefined);
    assert.deepEqual(buildCompletionReadiness(first).issues.filter((issue) => /final.verification/i.test(issue)), []);
    // Its events replay to the same projection after a reopen.
    store.close();
    store = new SqliteSchedulerStore(database, options);
    assert.deepEqual(rebuildSchedulerProjection(store.readRun(runId)), first);
  } finally {
    store.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a new run records the v2 contract at provisioning, and recovery never switches contracts", () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 verification contract provisioning "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  try {
    ensurePlanningProvisioningPrefix(store, { runId: "run-v2", objective: "Build it.", planningPolicy: { version: 1 }, verificationContractVersion: 2 });
    assert.equal(rebuildSchedulerProjection(store.readRun("run-v2")).verificationContractVersion, 2);
    assert.throws(
      () => ensurePlanningProvisioningPrefix(store, { runId: "run-v2", objective: "Build it.", planningPolicy: { version: 1 } }),
      /different final-verification contract/,
    );
    ensurePlanningProvisioningPrefix(store, { runId: "run-v1", objective: "Build it.", planningPolicy: { version: 1 } });
    assert.equal(rebuildSchedulerProjection(store.readRun("run-v1")).verificationContractVersion, undefined);
    assert.throws(
      () => ensurePlanningProvisioningPrefix(store, { runId: "run-v1", objective: "Build it.", planningPolicy: { version: 1 }, verificationContractVersion: 2 }),
      /different final-verification contract/,
    );
    // Only the Runner may record the contract version.
    assert.throws(() => store.append({ runId: "run-forged", type: "run.initialized", occurredAt: WHEN, actor: { role: "architect", id: "architect" }, idempotencyKey: "init", payload: { verificationContractVersion: 2 } }));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function seedTasks(store: SqliteSchedulerStore, runId: string, revision: string): void {
  store.append({ runId, type: "plan.created", occurredAt: WHEN, actor: { role: "architect", id: "architect" }, idempotencyKey: "plan", payload: { revision: 1, tasks: [{ id: "implementation-one", objective: "Implement feature", dependencies: [], status: "integrated", requiredCapabilities: ["code"], acceptanceCriteria: [{ id: "done", text: "Feature implemented." }], acceptanceCriteriaVersion: 1, attempt: 1 }] } });
  store.append({ runId, type: "integration.revision_advanced", occurredAt: WHEN, actor: { role: "runner", id: "integration" }, idempotencyKey: "rev-one", payload: { integrationRevision: revision } });
}

function seedV2Run(
  store: SqliteSchedulerStore,
  revision: string,
  plan: VerificationPlanV2,
  profile: FinalVerificationExecutionProfile,
  runId = currentRunId,
): void {
  store.append({ runId, type: "run.initialized", occurredAt: WHEN, actor: { role: "runner", id: "runner" }, idempotencyKey: "init", payload: { verificationContractVersion: 2 } });
  seedTasks(store, runId, revision);
  // A v1 plan on a v2 run is refused.
  const v1Plan: FinalVerificationPlan = { checks: (["build", "tests", "runtime_smoke", "browser"] as const).map((category) => ({
    category, status: "not_applicable" as const, rationale: "None.", repositoryInspection: { paths: ["package.json"], summary: "None." },
  })) };
  assert.throws(() => store.append({ runId, type: "final_verification.generation_created", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "generation-v1", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, planVersion: 1, plan: v1Plan, executionProfile: emptyFinalVerificationProfile(revision) } }), /must be a list of checks/);
  store.append({ runId, type: "final_verification.generation_created", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "generation", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, planVersion: 1, plan, executionProfile: cloneFinalVerificationExecutionProfile(profile) } });
}

let currentRunId = "";

function appendCheck(store: SqliteSchedulerStore, revision: string, workspacePath: string, result: unknown, runId = currentRunId): void {
  const checkId = (result as { checkId: string }).checkId;
  store.append({ runId, type: "final_verification.check_completed", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: `check:${checkId}`, payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, attempt: 1, workspacePath, startedAt: WHEN, finishedAt: WHEN, result } });
}

function cleanupAndRequestReview(store: SqliteSchedulerStore, runId: string, revision: string): void {
  store.append({ runId, type: "final_verification.cleanup_started", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "cleanup-start", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, attempt: 1 } });
  store.append({ runId, type: "final_verification.cleanup_succeeded", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "cleanup-success", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, attempt: 1 } });
  store.append({ runId, type: "final_verification.review_requested", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "review-request", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, submissionId: SUBMISSION_ID, reviewId: REVIEW_ID, attempt: 1 } });
}

function approveV2(
  store: SqliteSchedulerStore,
  revision: string,
  submission: unknown,
  reviews: Array<{ checkId: string; evidenceIds: string[] }>,
): void {
  const runId = currentRunId;
  store.append({ runId, type: "final_verification.submitted", occurredAt: WHEN, actor: { role: "runner", id: "runtime" }, idempotencyKey: "submission", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, submissionId: SUBMISSION_ID, attempt: 1, submissionResult: submission } });
  cleanupAndRequestReview(store, runId, revision);
  store.append({ runId, type: "final_verification.review_decided", occurredAt: WHEN, actor: { role: "architect", id: "architect" }, idempotencyKey: "review-decision", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, submissionId: SUBMISSION_ID, reviewId: REVIEW_ID, attempt: 1, decision: "approved", summary: "Every executed check supports approval.", architectRisk: "low", architectRiskRationale: "The checks cover what a user does.", checkReviews: reviews.map((review) => ({ ...review, verdict: "approved", rationale: `Check ${review.checkId} passed with its evidence.` })) } });
}

interface GitFixture {
  root: string;
  project: string;
  state: string;
  runId: string;
  integration: IntegrationManager;
}

async function createGitFixture(name: string): Promise<GitFixture> {
  const root = mkdtempSync(join(tmpdir(), `aiboard-verification-plan-v2-${name}-`));
  const project = join(root, "user checkout");
  const state = join(root, "runner state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "README.md"), "baseline\n");
  const runId = `run_v2_${name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}`;
  currentRunId = runId;
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
