/**
 * VF3 contract tests that run in memory (no process, no checkout): the v2 plan contract, the
 * v1/v2 version gate, repairs keyed by check id, and build-runtime with fake drivers. Required
 * PR CI runs this file; the process tests are in verification-plan-v2.test.ts.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallBlock } from "../src/agent-contracts.js";
import { createArchitectTools } from "../src/architect-tools.js";
import { BuildRuntime, type FinalVerificationCheckDriverInput } from "../src/build-runtime.js";
import type { FinalVerificationPlan } from "../src/final-verification-contracts.js";
import {
  buildVerificationPlanPrefillV2,
  verificationSuggestionsForProfile,
  withResolvedVerificationPlan,
  type FinalVerificationExecutionProfile,
} from "../src/final-verification-profile.js";
import { ensurePlanningProvisioningPrefix } from "../src/native-planning-provisioner.js";
import { failingTestIdsByCategory, withFailingIds } from "../src/repair-budget-contracts.js";
import {
  buildCompletionReadiness,
  deriveFinalVerificationFailure,
  rebuildSchedulerProjection,
} from "../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { parseArchitectActionReason, parseArchitectQuestionRequest } from "../src/user-steering-contracts.js";
import {
  assertVerificationPlanResolution,
  completeVerificationPlanV2,
  skippedVerificationResults,
  validateVerificationPlanV2,
  type VerificationCheckV2,
  type VerificationPlanV2,
} from "../src/verification-plan-v2.js";
import { acceptFinalVerificationProfile, emptyFinalVerificationProfile } from "./support/final-verification-profile.js";
import {
  FINAL_TASK_ID,
  GENERATION_ID,
  REVIEW_ID,
  SUBMISSION_ID,
  WHEN,
  appendCheck,
  cleanupAndRequestReview,
  detectedSuggestions,
  seedTasks,
  seedV2Run,
} from "./support/verification-plan-v2-fixtures.js";

const keep = (check: VerificationCheckV2) => ({
  id: check.id,
  label: check.label,
  kind: check.kind,
  ...(check.run ? { run: check.run } : {}),
  ...(check.start ? { start: check.start } : {}),
});

test("a detected check is skipped with a reason; one left out without a reason is refused", () => {
  const suggestions = detectedSuggestions();
  assert.deepEqual(suggestions.map((check) => [check.id, check.kind, check.origin, check.mandatory]), [
    ["build", "build", "detected", false],
    ["tests", "tests", "detected", false],
  ]);
  const tests = suggestions.find((check) => check.id === "tests")!;
  const skipped = completeVerificationPlanV2({
    checks: [keep(tests)],
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

  const omitted = completeVerificationPlanV2({ checks: [keep(tests)] }, suggestions);
  assert.equal(omitted.ok, false);
  assert.match((omitted as { issues: string[] }).issues.join(" "), /Suggested check build must be kept, changed, or listed in skipped/);
  const noReason = completeVerificationPlanV2({ checks: [keep(tests)], skipped: [{ checkId: "build", reason: " " }] }, suggestions);
  assert.equal(noReason.ok, false);
  const unknownSkip = completeVerificationPlanV2({
    checks: suggestions.map(keep),
    skipped: [{ checkId: "lint", reason: "Not suggested." }],
  }, suggestions);
  assert.equal(unknownSkip.ok, false);
  assert.match((unknownSkip as { issues: string[] }).issues.join(" "), /lint is not one the Runner suggested/);
});

test("a mandatory check can be neither skipped nor changed, and only the Runner sets mandatory", () => {
  // Detected suggestions are never mandatory (VF4 reads mandatory from aiboard-validation.json, see
  // project-validation-checks.test.ts); flipping one here tests the contract's own rules.
  const suggestions = detectedSuggestions().map((check) => check.id === "build" ? { ...check, mandatory: true } : check);
  const build = suggestions.find((check) => check.id === "build")!;
  const tests = suggestions.find((check) => check.id === "tests")!;

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

test("a detected command a v1 run accepts is a valid suggestion; only commands the Architect writes take its tighter bounds", () => {
  const revision = "d".repeat(40);
  // aiboard-validation.json allows a release-tier command 100 args and a timeout from 1 ms.
  const caseArgs = Array.from({ length: 80 }, (_, index) => `--case=${index}`);
  const profile: FinalVerificationExecutionProfile = {
    ...emptyFinalVerificationProfile(revision),
    tiers: { release: [{ label: "release suite", executable: "npm", args: ["run", "release", "--", ...caseArgs], timeoutMs: 500 }] },
  };
  const suggestions = verificationSuggestionsForProfile(profile).map((suggestion) => suggestion.check);
  const tests = suggestions[0]!;
  assert.deepEqual([suggestions.length, tests.id, tests.run?.args.length, tests.run?.timeoutMs], [1, "tests", 83, 500]);
  // The prefill the Architect reads parses at the prompt boundary.
  assert.doesNotThrow(() => parseArchitectActionReason({
    type: "final_verification_plan_required", integrationRevision: revision, planPrefill: buildVerificationPlanPrefillV2("run-limits", profile),
  }));

  const kept = completeVerificationPlanV2({ checks: [keep(tests)], skipped: [] }, suggestions);
  assert.equal(kept.ok, true, kept.ok ? "" : kept.issues.join(" "));
  const keptProfile = withResolvedVerificationPlan(profile, (kept as { plan: VerificationPlanV2 }).plan);
  assert.doesNotThrow(() => assertVerificationPlanResolution(keptProfile.verification, undefined));
  assert.deepEqual(validateVerificationPlanV2((kept as { plan: VerificationPlanV2 }).plan).issues, [], "structure alone holds a kept suggestion");

  const skipped = completeVerificationPlanV2({ checks: [], skipped: [{ checkId: "tests", reason: "The release suite needs a staging database." }] }, suggestions);
  assert.equal(skipped.ok, true, skipped.ok ? "" : skipped.issues.join(" "));
  const skippedProfile = withResolvedVerificationPlan(profile, (skipped as { plan: VerificationPlanV2 }).plan);
  assert.doesNotThrow(() => assertVerificationPlanResolution(skippedProfile.verification, undefined), "the recorded suggestion stays valid when skipped");

  const changed = completeVerificationPlanV2({ checks: [{ ...keep(tests), run: { ...tests.run!, timeoutMs: 2_000 } }], skipped: [] }, suggestions);
  assert.equal(changed.ok, false, "a changed command is the Architect's and takes its bounds");
  assert.match((changed as { issues: string[] }).issues.join(" "), /args must be at most 64/);
  const own = completeVerificationPlanV2({
    checks: [keep(tests), { id: "release-fast", label: "release, fast", kind: "other", run: { executable: "npm", args: ["test"], timeoutMs: 500 } }],
    skipped: [],
  }, suggestions);
  assert.equal(own.ok, false);
  assert.match((own as { issues: string[] }).issues.join(" "), /run\.timeoutMs must be an integer from 1000/);
});

test("a v2 repair reason names check ids, and ask_user can checkpoint it", () => {
  const reason = {
    type: "final_verification_repair_plan_required" as const,
    finalVerificationTaskId: FINAL_TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: "a".repeat(40),
    source: { type: "mechanical_failure" as const, failureId: "failure-1", issueIds: ["issue-1"], factIds: ["fact-1"] },
    failedCategories: [] as string[],
    failedCheckIds: ["build", "smoke-cli"],
    evidenceIds: ["evidence-1"],
  };
  assert.deepEqual(parseArchitectActionReason(reason), reason);
  const question = {
    questionId: "question-1",
    question: "The CLI smoke check needs a license key; should it be skipped?",
    version: 1,
    checkpoint: { reason, sequence: 7 },
  };
  assert.deepEqual(parseArchitectQuestionRequest(question), question);
  assert.throws(() => parseArchitectActionReason({ ...reason, failedCheckIds: [] }), /failedCheckIds is required/);
  assert.throws(() => parseArchitectActionReason({ ...reason, failedCategories: ["build"] }), /failedCategories must be empty/);
  // A v1 reason keeps naming its categories.
  const { failedCheckIds: _ids, ...v1 } = reason;
  assert.deepEqual(parseArchitectActionReason({ ...v1, failedCategories: ["build"] }), { ...v1, failedCategories: ["build"] });
  assert.throws(() => parseArchitectActionReason(v1), /failedCategories is required/);
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
    seedV2Run(store, runId, revision, plan, profile);
    for (const checkId of ["build", "smoke-cli"]) {
      const planned = plan.checks.find((check) => check.id === checkId)!;
      appendCheck(store, runId, revision, "C:/verify", {
        checkId, kind: planned.kind, label: planned.label, origin: planned.origin, mandatory: false,
        outcome: "failed", green: false, evidenceIds: [], facts: [], issues: [`${checkId} exited 1`],
      });
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

test("a plan that runs no check is reviewed with an empty list, and the Build can finish", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 verification plan v2 no checks "));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    evidenceStore: evidence, validateCleanupReceipt: () => undefined, validateExecutionProfile: acceptFinalVerificationProfile,
  });
  const runId = "run-verification-plan-v2-no-checks";
  const revision = "e".repeat(40);
  // A Next static export: the only suggestion is next start, which the export does not serve.
  const profileFor = async (targetRevision: string): Promise<FinalVerificationExecutionProfile> => ({
    ...emptyFinalVerificationProfile(targetRevision),
    detectedSignals: [{ category: "build", source: "fixture", detail: "start" }],
    commands: { build: [{ label: "package start", executable: "fixture", args: ["start"] }] },
  });
  const reasons: string[] = [];
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
      finalVerificationDriver: { executeCheck: async () => { throw new Error("A plan with no checks runs nothing."); } },
      finalVerificationCleanupDriver: { cleanup: async () => ({ diagnosticsPath: "C:/diagnostics/no-checks.json" }) },
      architectDriver: {
        run: async (request) => {
          reasons.push(request.reason.type);
          const call = async (name: string, args: Record<string, unknown>) => await request.tools.invoke(
            { type: "tool_call", callId: `${name}-${reasons.length}`, name, arguments: args }, request.context);
          if (request.reason.type === "final_verification_plan_required") {
            const planned = await call("plan_final_verification", { plan: { version: 2, checks: [], skipped: [
              { checkId: "build", reason: "A static export has no server for next start to run." },
            ] } });
            assert.equal(planned.isError, false, planned.error?.message ?? "");
            return;
          }
          if (request.reason.type === "final_verification_review_required") {
            const attempt = rebuildSchedulerProjection(store.readRun(runId)).finalVerification!.current!.submission!.attempt;
            const review = {
              taskId: request.reason.taskId, generationId: request.reason.generationId, targetRevision: request.reason.targetRevision,
              submissionId: request.reason.submissionId, attempt, decision: "approved",
              summary: "Every suggestion was skipped with a reason; nothing ran, so nothing was verified.",
              architectRisk: "low", architectRiskRationale: "The static export is checked by its build in the tasks.",
            };
            const skippedReview = await call("review_final_verification", { ...review, checkReviews: [
              { checkId: "build", verdict: "approved", rationale: "Skipped.", evidenceIds: [] },
            ] });
            assert.equal(skippedReview.isError, true, "a skipped check has no result to review");
            const empty = await call("review_final_verification", { ...review, checkReviews: [] });
            assert.equal(empty.isError, false, empty.error?.message ?? "");
            return;
          }
          throw new Error(`Unexpected Architect reason ${request.reason.type}`);
        },
      },
    });
    const approved = () => rebuildSchedulerProjection(store.readRun(runId)).finalVerification?.current?.review?.status === "approved";
    for (let step = 0; step < 10 && !approved(); step += 1) await runtime.step();
    assert.equal(approved(), true, reasons.join(", "));
    const projection = rebuildSchedulerProjection(store.readRun(runId));
    const current = projection.finalVerification!.current!;
    assert.deepEqual(current.plan, { version: 2, checks: [], skipped: [{ checkId: "build", reason: "A static export has no server for next start to run." }] });
    assert.deepEqual(current.review?.decision?.checkReviews, []);
    assert.deepEqual(buildCompletionReadiness(projection).issues.filter((issue) => /final.verification/i.test(issue)), []);
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
