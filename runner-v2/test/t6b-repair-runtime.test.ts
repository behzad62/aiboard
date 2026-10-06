import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import {
  BuildRuntime,
  type FinalVerificationCheckDriver,
  type FinalVerificationCheckExecution,
  type FinalVerificationCleanupDriver,
  type FlakyIsolationDriver,
} from "../src/build-runtime.js";
import type { FinalVerificationCategory } from "../src/final-verification-contracts.js";
import type { FinalVerificationExecutionProfile } from "../src/final-verification-profile.js";
import type { FinalVerificationCommandFact } from "../src/final-verification-runtime.js";
import { repairIssueIdentity, repairRootCauseForCheck } from "../src/repair-budget-contracts.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteProjectMemoryStore } from "../src/sqlite-project-memory.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { buildPlanningFixtureScenario } from "./fixtures/planning-source-fixture.js";
import { commandEvidence } from "./support/evidence-fixtures.js";
import { seedCompletedDeliveryReview } from "./support/delivery-seed.js";
import {
  acceptFinalVerificationProfile,
  profileForRequiredCategories,
} from "./support/final-verification-profile.js";

const RUN_ID = "run-t6b-repair-runtime";
const PROJECT_ID = "t6b-project";
const REVISION = "a".repeat(40);
const TASK_ID = "final-verification-t6b";
const GENERATION_ID = "fv-t6b-generation";
const CLOCK_START = Date.UTC(2026, 8, 26, 0, 0, 0);

function advancingClock() {
  let tick = 0;
  return () => new Date(CLOCK_START + (tick += 1) * 10).toISOString();
}

interface Fixture {
  root: string;
  store: SqliteSchedulerStore;
  evidence: SqliteEvidenceStore;
  artifacts: ArtifactStore;
  clock: () => string;
  close(): void;
}

function createStore(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t6b-runtime-"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    evidenceStore: evidence,
    artifacts,
    validateCleanupReceipt: () => undefined,
    validateExecutionProfile: acceptFinalVerificationProfile,
  });
  const clock = advancingClock();
  return {
    root,
    store,
    evidence,
    artifacts,
    clock,
    close: () => {
      store.close();
      evidence.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function append(fixture: Fixture, type: string, key: string, actor: { role: "runner" | "architect" | "verifier" | "user"; id: string }, payload: Record<string, unknown>): void {
  fixture.store.append({
    runId: RUN_ID,
    type: type as never,
    occurredAt: fixture.clock(),
    actor,
    idempotencyKey: key,
    payload,
  });
}

function seedPolicy(fixture: Fixture): void {
  append(fixture, "run.initialized", "run-initialized", { role: "runner", id: "runner-test" }, {});
  append(fixture, "planning.policy_configured", "planning-policy", { role: "runner", id: "build-runtime" }, { version: 1 });
}

const SCENARIO = (() => {
  const base = buildPlanningFixtureScenario();
  return {
    ...base,
    manifest: {
      ...base.manifest,
      amendment: {
        ...base.manifest.amendment!,
        recordedImpact: { addsSectionIds: ["s8"], retiresSectionIds: ["s7"], addsRequirementIds: [], retiresRequirementIds: ["REQ-RETIRED"] },
      },
    },
  };
})();

function seedReadyPlan(fixture: Fixture): void {
  append(fixture, "planning.source_registered", "t6b-source", { role: "user", id: "owner" }, { manifest: SCENARIO.priorManifest });
  append(fixture, "planning.source_amended", "t6b-source-amendment", { role: "user", id: "owner" }, { manifest: SCENARIO.manifest });
  append(fixture, "request.triaged", "t6b-triage", { role: "architect", id: "architect" }, { decision: "build", rationale: "Build the fixture." });
  append(fixture, "planning.ledger_persisted", "t6b-ledger", { role: "architect", id: "architect" }, { id: "ledger", requirements: SCENARIO.requirements, phases: SCENARIO.phases, nonNormativeSections: [] });
  for (const section of SCENARIO.manifest.sections) {
    append(fixture, "planning.source_section_read", `t6b-read:${section.id}`, { role: "architect", id: "architect" }, { manifestId: SCENARIO.manifest.manifestId, manifestDigest: SCENARIO.manifest.artifactDigest, sectionId: section.id, sectionDigest: section.digest, readAt: fixture.clock() });
  }
  append(fixture, "planning.plan_drafted", "t6b-plan", { role: "architect", id: "architect" }, { revision: SCENARIO.revision, expectedRevisionId: null, expectedDigest: null });
  append(fixture, "planning.coverage_review_requested", "t6b-coverage-request", { role: "architect", id: "architect" }, { reviewId: SCENARIO.coverageReview.id, planRevisionId: SCENARIO.revision.revisionId, planRevisionDigest: SCENARIO.revision.digest, sourceManifestId: SCENARIO.manifest.manifestId, requestedAt: fixture.clock() });
  append(fixture, "planning.coverage_obligations_recorded", "t6b-coverage-obligations", { role: "verifier", id: "coverage-reviewer" }, { reviewId: SCENARIO.coverageReview.id, sourceManifestId: SCENARIO.manifest.manifestId, sourceManifestDigest: SCENARIO.manifest.artifactDigest, obligations: SCENARIO.coverageReview.derivedObligations, sectionCoverage: SCENARIO.manifest.sections.map((section) => ({ sectionId: section.id, obligationIds: SCENARIO.coverageReview.derivedObligations.map((obligation) => obligation.id) })), recordedAt: fixture.clock() });
  append(fixture, "planning.coverage_plan_delivered", "t6b-coverage-plan", { role: "runner", id: "build-runtime" }, { reviewId: SCENARIO.coverageReview.id, planRevisionId: SCENARIO.revision.revisionId, planRevisionDigest: SCENARIO.revision.digest, sourceManifestId: SCENARIO.manifest.manifestId, deliveredAt: fixture.clock() });
  append(fixture, "planning.coverage_review_recorded", "t6b-coverage-review", { role: "verifier", id: "coverage-reviewer" }, { review: SCENARIO.coverageReview });
  append(fixture, "planning.plan_ready", "t6b-ready", { role: "runner", id: "build-runtime" }, { hostCapabilities: SCENARIO.hostCapabilities });
}

function seedLegacyPlan(fixture: Fixture): void {
  append(fixture, "plan.created", "t6b-legacy-plan", { role: "architect", id: "architect-test" }, {
    revision: 1,
    tasks: [{
      id: "implementation-one",
      objective: "Implement the t6b fixture feature.",
      dependencies: [],
      status: "integrated",
      requiredCapabilities: ["code"],
      acceptanceCriteria: [{ id: "done", text: "Feature implemented." }],
      acceptanceCriteriaVersion: 1,
      attempt: 1,
    }],
  });
}

function seedIntegrationRevision(fixture: Fixture): void {
  append(fixture, "integration.revision_advanced", "integration:revision:one", { role: "runner", id: "integration-manager" }, { integrationRevision: REVISION });
}

function seedGeneration(fixture: Fixture): void {
  append(fixture, "final_verification.generation_created", "final-verification-plan:one", { role: "runner", id: "build-runtime" }, {
    taskId: TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    planVersion: 1,
    plan: {
      // Tests first: the pump executes plan checks in order, and these
      // fixtures fail the tests check before later checks run.
      checks: (["tests", "build", "runtime_smoke", "browser"] as FinalVerificationCategory[]).map((category) => category === "tests"
        ? { category, status: "required" as const }
        : { category, status: "not_applicable" as const, rationale: `No ${category} fixture is configured.`, repositoryInspection: { paths: ["package.json"], summary: `No ${category} fixture is configured.` } }),
    },
    executionProfile: profileForRequiredCategories(REVISION, ["tests"]),
  });
}

async function testsFact(fixture: Fixture, tag: string, report?: { failingTestIds: string[] }): Promise<FinalVerificationCommandFact> {
  const stdout = await fixture.artifacts.put(Buffer.from(`t6b stdout ${tag}`), "text/plain", "t6b fixture stdout");
  const stderr = await fixture.artifacts.put(Buffer.from(`t6b stderr ${tag}`), "text/plain", "t6b fixture stderr");
  return {
    kind: "command",
    category: "tests",
    label: "tests",
    executable: "fixture",
    command: "fixture",
    args: [],
    cwd: "C:/verification-workspace",
    startedAt: "2026-08-26T00:00:03.000Z",
    finishedAt: "2026-08-26T00:00:04.000Z",
    exitCode: 1,
    signal: null,
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
    stdoutArtifactHash: stdout.hash,
    stderrArtifactHash: stderr.hash,
    repositoryRevision: REVISION,
    targetRevision: REVISION,
    startState: { revision: REVISION, status: "clean" },
    endState: { revision: REVISION, status: "clean" },
    ...(report ? { report } : {}),
  } as FinalVerificationCommandFact;
}

function failingCheckDriver(fixture: Fixture, calls: string[], report?: { failingTestIds: string[] }, anyGeneration = false): FinalVerificationCheckDriver {
  return {
    executeCheck: async (input) => {
      calls.push(input.category);
      if (!anyGeneration) assert.equal(input.generationId, GENERATION_ID);
      assert.equal(input.taskId, TASK_ID);
      assert.equal(input.targetRevision, REVISION);
      const fact = await testsFact(fixture, `${calls.length}`, report);
      const record = fixture.evidence.record({
        runId: RUN_ID,
        taskId: TASK_ID,
        actor: { role: "worker", id: "t6b-fixture-worker" },
        fact: fact as never,
        createdAt: fixture.clock(),
        idempotencyKey: `${GENERATION_ID}:fact:tests:${calls.length}`,
        attempt: 1,
      });
      const check: FinalVerificationCheckExecution = {
        workspacePath: "C:/verification-workspace",
        startedAt: "2026-08-26T00:00:03.000Z",
        finishedAt: "2026-08-26T00:00:04.000Z",
        check: {
          category: "tests",
          status: "required",
          green: false,
          evidenceIds: [record.id],
          facts: [fact],
          issues: ["tests failed mechanically."],
        },
      };
      return check;
    },
  };
}

function buildTestRuntime(
  fixture: Fixture,
  driver: FinalVerificationCheckDriver,
  options: {
    flakyIsolation?: FlakyIsolationDriver;
    cleanupAfterAttempt?: (context: { readonly taskAttempt: "task_attempt" | "verification" }) => Promise<{ processes: []; tempPaths: [] }>;
    reviewOutcomeRecorder?: { projectId: string; record(input: { readonly modelId: string; readonly taskId: string; readonly accepted: boolean; readonly defectFound: boolean; readonly recordedAt: string }): void };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    architectDriver?: { run: (request: any) => Promise<void> };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workerDriver?: { run: (assignment: any) => Promise<any> };
    maxTaskAttempts?: number;
    repairPlanLimit?: number;
    deliveryReview?: { review: (input: { runId: string; taskId: string }) => Promise<{ status: "reviewed"; reviewId: string; runtimeId: string; independence: "fresh_context"; tier: "medium"; replayed: boolean }> };
    deliveryBoundary?: { check: (input: { runId: string; taskId: string; boundaryId: string; attempt: number; integrationRevision: string }) => Promise<{ changedFiles: string[]; executedScope: "full_test_script"; selection: { rung: string; selectedTests: string[] }; checks: { checkId: string; command: string; args: string[]; evidenceIds: string[]; exitCode: number; outcome: "failed"; report: { status: "failed"; runner: string; counts: { selected: number; passed: number; failed: number; skipped: number } } }[] }> };
    finalVerificationProfileFor?: (targetRevision: string) => Promise<FinalVerificationExecutionProfile>;
  } = {},
) {
  const cleanupDriver: FinalVerificationCleanupDriver = {
    cleanup: async () => ({ diagnosticsPath: "C:/diagnostics/t6b-failure.json" }),
  };
  return new BuildRuntime({
    runId: RUN_ID,
    store: fixture.store,
    evidenceStore: fixture.evidence,
    clock: fixture.clock,
    projectId: PROJECT_ID,
    maxConcurrency: 1,
    ...(options.maxTaskAttempts !== undefined ? { maxTaskAttempts: options.maxTaskAttempts } : {}),
    ...(options.finalVerificationProfileFor !== undefined ? { finalVerificationProfileFor: options.finalVerificationProfileFor } : {}),
    ...(options.repairPlanLimit !== undefined ? { repairPlanLimit: options.repairPlanLimit } : {}),
    ...(options.deliveryReview !== undefined ? { deliveryReview: options.deliveryReview } : {}),
    ...(options.deliveryBoundary !== undefined ? { deliveryBoundary: options.deliveryBoundary } : {}),
    workspaceFor: async () => "C:/never",
    workerDriver: options.workerDriver ?? { run: async () => ({ type: "failed" as const, reason: "t6b must not use workers" }) },
    architectDriver: options.architectDriver ?? { run: async () => undefined },
    integrationDriver: { integrate: async () => ({ status: "integrated" as const, integrationRevision: REVISION }) },
    finalVerificationDriver: driver,
    finalVerificationCleanupDriver: cleanupDriver,
    ...(options.flakyIsolation ? { flakyIsolation: options.flakyIsolation } : {}),
    ...(options.cleanupAfterAttempt ? { cleanupAfterAttempt: options.cleanupAfterAttempt } : {}),
    ...(options.reviewOutcomeRecorder ? { reviewOutcomeRecorder: options.reviewOutcomeRecorder } : {}),
  });
}

function eventsOf(fixture: Fixture, type: string) {
  return fixture.store.readRun(RUN_ID).filter((event) => event.type === type);
}

function testsIssueId(): string {
  return repairIssueIdentity({ projectId: PROJECT_ID, rootCause: "final-verification:tests" });
}

/** T6b repair (R2-B5): the issue identity carries the sorted failing test ids. */
function testsIssueIdFor(failingIds: readonly string[]): string {
  return repairIssueIdentity({ projectId: PROJECT_ID, rootCause: repairRootCauseForCheck({ category: "tests", failingIds }) });
}

function seedRepairIssue(fixture: Fixture, cycles: number): string {
  const issueId = testsIssueId();
  append(fixture, "repair.issue_recorded", `repair-issue:${issueId}`, { role: "runner", id: "delivery-review-runtime" }, {
    issueId,
    rootCause: "final-verification:tests",
    limit: 3,
  });
  for (let index = 0; index < cycles; index += 1) {
    append(fixture, "repair.cycle_recorded", `repair-cycle:seed:${index}`, { role: "runner", id: "build-runtime" }, {
      issueId,
      hypothesis: `seed hypothesis ${index}`,
      outcome: "failed",
      evidenceIds: [`seed-ev-${index}`],
    });
  }
  return issueId;
}

test("a failing check opens the issue without charging and searches cleanup", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    seedIntegrationRevision(fixture);
    seedGeneration(fixture);
    const calls: string[] = [];
    const cleanups: string[] = [];
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, calls), {
      cleanupAfterAttempt: async (context) => {
        cleanups.push(context.taskAttempt);
        return { processes: [], tempPaths: [] };
      },
    });
    assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_check_non_green" });
    assert.deepEqual(calls, ["tests"]);
    const issues = eventsOf(fixture, "repair.issue_recorded");
    assert.equal(issues.length, 1);
    assert.equal(issues[0]!.payload.issueId, testsIssueId());
    assert.equal(issues[0]!.payload.rootCause, "final-verification:tests");
    assert.equal(issues[0]!.payload.limit, 3);
    // T6b repair (B5): the first failure opens the issue; the cycle is
    // charged when a correction is dispatched through a repair planning
    // tool, never here.
    assert.equal(eventsOf(fixture, "repair.cycle_recorded").length, 0);
    assert.equal(rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).repairIssues?.[testsIssueId()]?.used, 0);
    const checked = eventsOf(fixture, "cleanup.checked");
    assert.equal(checked.length, 1);
    assert.equal(checked[0]!.payload.trigger, "verification");
    assert.deepEqual(cleanups, ["verification"]);
  } finally {
    fixture.close();
  }
});

test("seeded cycles survive the check and the fourth correction pauses through the real pump", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    seedIntegrationRevision(fixture);
    seedGeneration(fixture);
    seedRepairIssue(fixture, 2);
    // T6b repair (B5): the check itself charges nothing; two seeded cycles
    // stay two until a correction is dispatched.
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, []));
    assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_check_non_green" });
    assert.equal(rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).repairIssues?.[testsIssueId()]?.used, 2);
  } finally {
    fixture.close();
  }
  const refused = createStore();
  try {
    seedPolicy(refused);
    seedReadyPlan(refused);
    seedIntegrationRevision(refused);
    seedGeneration(refused);
    seedRepairIssue(refused, 3);
    const runtime = buildTestRuntime(refused, failingCheckDriver(refused, []));
    // T6b repair (B3): the fourth correction pauses instead of throwing.
    assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_check_non_green" });
    assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_failure_reported" });
    assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_cleanup_succeeded" });
    assert.deepEqual(await runtime.step(), { status: "paused", action: "repair_issue_paused" });
    assert.equal(rebuildSchedulerProjection(refused.store.readRun(RUN_ID)).repairIssues?.[testsIssueId()]?.used, 3);
  } finally {
    refused.close();
  }
});

test("flaky pass-on-rerun charges nothing but still blocks acceptance", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    seedIntegrationRevision(fixture);
    seedGeneration(fixture);
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, [], { failingTestIds: ["red-one"] }), {
      flakyIsolation: {
        rerunFailingTests: async (input) => {
          assert.deepEqual([...input.failingTestIds], ["red-one"]);
          assert.equal(input.targetRevision, REVISION);
          return { status: "rerun", green: true, evidenceIds: ["rerun-evidence"], note: "reran red-one alone" };
        },
      },
    });
    assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_check_non_green" });
    const flaky = eventsOf(fixture, "repair.flaky_isolated");
    assert.equal(flaky.length, 1);
    assert.equal(flaky[0]!.payload.rerunGreen, true);
    assert.equal(eventsOf(fixture, "repair.cycle_recorded").length, 0);
    // T6b repair (R2-B5): the issue identity is the category plus the
    // failing test ids, never the category alone.
    assert.equal(rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).repairIssues?.[testsIssueIdFor(["red-one"])]?.used, 0);
    assert.equal(rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).repairIssues?.[testsIssueId()], undefined);
    // The flaky check still blocks: the next step reports the failure, never an acceptance.
    assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_failure_reported" });
  } finally {
    fixture.close();
  }
});

test("flaky fail-again records a consistent failure and charges nothing at the check", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    seedIntegrationRevision(fixture);
    seedGeneration(fixture);
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, [], { failingTestIds: ["red-one"] }), {
      flakyIsolation: {
        rerunFailingTests: async () => ({ status: "rerun", green: false, evidenceIds: ["rerun-evidence"], note: "red-one failed again" }),
      },
    });
    assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_check_non_green" });
    assert.equal(eventsOf(fixture, "repair.flaky_isolated")[0]!.payload.rerunGreen, false);
    // T6b repair (B5): a consistent failure still charges only when its
    // correction is dispatched, never at the check.
    assert.equal(eventsOf(fixture, "repair.cycle_recorded").length, 0);
    assert.equal(rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).repairIssues?.[testsIssueIdFor(["red-one"])]?.used, 0);
    assert.equal(rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).repairIssues?.[testsIssueId()], undefined);
  } finally {
    fixture.close();
  }
});

test("an unsupported rerun records not_performed with its reason and charges nothing at the check", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    seedIntegrationRevision(fixture);
    seedGeneration(fixture);
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, [], { failingTestIds: ["red-one"] }), {
      flakyIsolation: {
        rerunFailingTests: async () => ({ status: "unsupported", note: "no filterable node --test command" }),
      },
    });
    assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_check_non_green" });
    // T6b repair (B2/B5): no rerun was performed, so the finding records
    // not_performed with the reason; the cycle is charged at dispatch.
    const flaky = eventsOf(fixture, "repair.flaky_isolated");
    assert.equal(flaky.length, 1);
    assert.ok((flaky[0]!.payload.finding as string).includes("not_performed"));
    assert.ok((flaky[0]!.payload.finding as string).includes("no filterable node --test command"));
    assert.equal(eventsOf(fixture, "repair.cycle_recorded").length, 0);
  } finally {
    fixture.close();
  }
});

test("a proven external blocker consumes no charge and still blocks", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    seedIntegrationRevision(fixture);
    seedGeneration(fixture);
    const issueId = seedRepairIssue(fixture, 0);
    append(fixture, "repair.external_blocker_recorded", `repair-blocker:${issueId}`, { role: "architect", id: "architect-test" }, {
      issueId,
      acceptanceCondition: "fixture service reachable",
      evidence: ["probe refused"],
      attemptedResolutions: ["restarted fixture"],
      requiredOwnerAction: "owner enables the fixture service",
    });
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, []));
    assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_check_non_green" });
    assert.equal(eventsOf(fixture, "repair.cycle_recorded").length, 0);
    assert.equal(rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).repairIssues?.[issueId]?.used, 0);
    const stored = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).repairIssues?.[issueId]?.externalBlocker;
    assert.equal(stored?.acceptanceCondition, "fixture service reachable");
    assert.deepEqual(stored?.evidence, ["probe refused"]);
    assert.deepEqual(stored?.attemptedResolutions, ["restarted fixture"]);
    assert.equal(stored?.requiredOwnerAction, "owner enables the fixture service");
  } finally {
    fixture.close();
  }
});

async function driveToDispatchReady(fixture: Fixture): Promise<void> {
  const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, []));
  assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_check_non_green" });
  assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_failure_reported" });
  assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_cleanup_succeeded" });
}

/**
 * An Architect that records a fresh approach decision and plans the repair
 * through the real lifecycle tools on every repair turn (probe-D pattern).
 * Other turn types are left to the caller's driver.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function repairPlanningArchitectDriver(plans: { count: number }, taskPrefix: string): { run: (request: any) => Promise<void> } {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run: async (request: any) => {
      if (request.reason?.type !== "final_verification_repair_plan_required") return undefined;
      const projection = request.projection;
      const issueId = Object.keys(projection.repairIssues ?? {})[0] as string;
      const current = projection.finalVerification?.current;
      const failure = current?.failure;
      const evidenceIds = [...(failure?.evidenceIds ?? [])];
      plans.count += 1;
      const n = plans.count;
      const decision = await request.tools.invoke({ type: "tool_call", callId: `dec-${taskPrefix}-${n}`, name: "record_repair_approach_decision", arguments: { issueId, approachId: `${taskPrefix}a${n}`, repeat: false, hypothesis: `fix attempt ${n}`, diagnosticSet: [], evidenceIds } }, request.context);
      assert.equal((decision as { isError?: boolean }).isError, false);
      const plan = await request.tools.invoke({ type: "tool_call", callId: `plan-${taskPrefix}-${n}`, name: "plan_verification_repairs", arguments: {
        finalVerificationTaskId: TASK_ID, generationId: current?.generationId, targetRevision: REVISION,
        source: { type: "mechanical_failure", failureId: failure.failureId, issueIds: failure.issueIds, factIds: failure.factIds },
        tasks: [{ id: `${taskPrefix}repair-${n}`, objective: "fix tests", categories: ["tests"], evidenceIds, dependencies: [], requiredCapabilities: ["code"], acceptanceCriteria: [{ id: "ac-1", text: "tests pass" }] }],
      } }, request.context);
      assert.equal((plan as { isError?: boolean }).isError, false);
      return undefined;
    },
  };
}

test("an exhausted issue pauses repair dispatch through the real pump", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    seedIntegrationRevision(fixture);
    seedGeneration(fixture);
    await driveToDispatchReady(fixture);
    // T6b repair (B5): reaching dispatch-ready charges nothing by itself.
    assert.equal(rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).repairIssues?.[testsIssueId()]?.used, 0);
    seedRepairIssueExtraCycles(fixture, 3);
    assert.equal(rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).repairIssues?.[testsIssueId()]?.used, 3);
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, []));
    // T6b repair (B3): an exhausted issue pauses with a durable
    // owner-visible reason instead of throwing, and the run never loops.
    // The step action carries the pause reason, namespaced by issue.
    assert.deepEqual(await runtime.step(), { status: "paused", action: "repair_issue_paused" });
    const paused = eventsOf(fixture, "repair.issue_paused");
    assert.equal(paused.length, 1);
    assert.equal(paused[0]!.payload.cause, "budget_exhausted");
    // A repeat visit maps through the durable pause reason, which names
    // the exhausted issue; the pause event is idempotent.
    assert.deepEqual(await runtime.step(), { status: "paused", action: `repair_issue_paused:${testsIssueId()}` });
    assert.equal(eventsOf(fixture, "repair.issue_paused").length, 1);
  } finally {
    fixture.close();
  }
});

function seedRepairIssueExtraCycles(fixture: Fixture, cycles: number): void {
  const issueId = testsIssueId();
  const used = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).repairIssues?.[issueId]?.used ?? 0;
  for (let index = 0; index < cycles; index += 1) {
    append(fixture, "repair.cycle_recorded", `repair-cycle:extra:${used + index}`, { role: "runner", id: "build-runtime" }, {
      issueId,
      hypothesis: `extra hypothesis ${used + index}`,
      outcome: "failed",
      evidenceIds: [`extra-ev-${used + index}`],
    });
  }
}

test("a failed approach gives the Architect a turn; a new approach dispatches and charges", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    seedIntegrationRevision(fixture);
    seedGeneration(fixture);
    await driveToDispatchReady(fixture);
    const issueId = testsIssueId();
    append(fixture, "repair.approach_decided", `repair-approach:${issueId}:a1`, { role: "architect", id: "architect-test" }, {
      issueId,
      approachId: "a1",
      repeat: false,
      hypothesis: "first remedy",
      diagnosticSet: ["d1"],
      evidenceIds: ["d1"],
    });
    append(fixture, "repair.cycle_recorded", "repair-cycle:approach:a1", { role: "runner", id: "build-runtime" }, {
      issueId,
      hypothesis: "first remedy",
      outcome: "failed",
      evidenceIds: ["d1"],
      approachId: "a1",
    });
    // T6b repair (B3/B4, probe D): the failed approach does not throw
    // before the Architect. The kernel never synthesizes a decision, so a
    // no-op Architect faults the turn instead of dispatching anything.
    const stalled = buildTestRuntime(fixture, failingCheckDriver(fixture, []));
    await assert.rejects(() => stalled.step(), /without a typed action/);
    assert.equal(rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).repairIssues?.[issueId]?.used, 1);
    // The Architect records a new approach with new evidence and dispatches
    // through the real tools: exactly one cycle is charged.
    const plans = { count: 0 };
    const proceeding = buildTestRuntime(fixture, failingCheckDriver(fixture, []), {
      architectDriver: repairPlanningArchitectDriver(plans, "t6b484-"),
    });
    await proceeding.step();
    assert.equal(plans.count, 1);
    assert.equal(rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).repairIssues?.[issueId]?.used, 2);
    const cycles = eventsOf(fixture, "repair.cycle_recorded");
    assert.equal(cycles.length, 2);
    assert.equal(cycles[1]!.payload.outcome, "dispatched");
    assert.equal(cycles[1]!.payload.approachId, "t6b484-a1");
    const current = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).finalVerification?.current;
    assert.equal(current?.repairTaskIds?.length, 1);
  } finally {
    fixture.close();
  }
});

test("a stricter run cap pauses dispatch although the issue has credits", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    append(fixture, "repair.policy_configured", "repair-policy:zero", { role: "runner", id: "build-runtime" }, { repairPlanLimit: 0 });
    seedReadyPlan(fixture);
    seedIntegrationRevision(fixture);
    seedGeneration(fixture);
    await driveToDispatchReady(fixture);
    assert.equal(rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).repairIssues?.[testsIssueId()]?.used, 0);
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, []));
    assert.deepEqual(await runtime.step(), { status: "paused", action: "repair_cycle_limit_reached" });
  } finally {
    fixture.close();
  }
});

test("legacy runs charge nothing and record no T6b events", async () => {
  const fixture = createStore();
  try {
    append(fixture, "run.initialized", "run-initialized", { role: "runner", id: "runner-test" }, {});
    seedLegacyPlan(fixture);
    seedIntegrationRevision(fixture);
    seedGeneration(fixture);
    const runtime = buildTestRuntime(fixture, {
      executeCheck: async () => ({
        workspacePath: "C:/verification-workspace",
        startedAt: "2026-08-26T00:00:03.000Z",
        finishedAt: "2026-08-26T00:00:04.000Z",
        check: {
          category: "tests",
          status: "required",
          green: false,
          evidenceIds: [],
          facts: [],
          issues: ["tests failed mechanically."],
        },
      }),
    });
    assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_check_non_green" });
    const types = new Set(fixture.store.readRun(RUN_ID).map((event) => event.type as string));
    assert.ok(![...types].some((type) => type.startsWith("repair.") || type === "cleanup.checked"));
    assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_failure_reported" });
  } finally {
    fixture.close();
  }
});

test("scheduler refuses a second blocker, post-blocker charges, and evidence reuse", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    const issueId = seedRepairIssue(fixture, 0);
    const blocker = {
      issueId,
      acceptanceCondition: "service reachable",
      evidence: ["probe refused"],
      attemptedResolutions: ["restarted fixture"],
      requiredOwnerAction: "owner enables the fixture service",
    };
    append(fixture, "repair.approach_decided", `repair-approach:${issueId}:a1`, { role: "architect", id: "architect-test" }, {
      issueId,
      approachId: "a1",
      repeat: false,
      hypothesis: "first remedy",
      diagnosticSet: ["d1"],
      evidenceIds: ["d1"],
    });
    append(fixture, "repair.cycle_recorded", "repair-cycle:a1-failed", { role: "runner", id: "build-runtime" }, {
      issueId,
      hypothesis: "first remedy",
      outcome: "failed",
      evidenceIds: ["d1"],
      approachId: "a1",
    });
    append(fixture, "repair.external_blocker_recorded", `repair-blocker:${issueId}`, { role: "architect", id: "architect-test" }, blocker);
    assert.throws(() => append(fixture, "repair.external_blocker_recorded", `repair-blocker:${issueId}:again`, { role: "architect", id: "architect-test" }, blocker), /already has an external blocker/);
    assert.throws(() => append(fixture, "repair.cycle_recorded", "repair-cycle:blocked", { role: "runner", id: "build-runtime" }, {
      issueId,
      hypothesis: "futile",
      outcome: "failed",
      evidenceIds: ["ev"],
    }), /futile attempts/);
    // The repeat cites the failure's own evidence (the failed cycle's
    // evidenceIds), so it is refused before any NEW-evidence analysis.
    assert.throws(() => append(fixture, "repair.approach_decided", `repair-approach:${issueId}:a1-repeat`, { role: "architect", id: "architect-test" }, {
      issueId,
      approachId: "a1",
      repeat: true,
      hypothesis: "same remedy again",
      diagnosticSet: [],
      evidenceIds: ["d1"],
    }), /must not cite the failure's own evidence/);
  } finally {
    fixture.close();
  }
});

/**
 * T6b repair (R2-B1, probe G): after the owner extends an exhausted
 * issue, the next exhaustion pauses again with a new pause occurrence
 * instead of throwing an idempotency conflict.
 */
test("an owner extension lets the next exhaustion pause again instead of throwing", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    seedIntegrationRevision(fixture);
    seedGeneration(fixture);
    await driveToDispatchReady(fixture);
    seedRepairIssueExtraCycles(fixture, 3);
    const issueId = testsIssueId();
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, []));
    assert.deepEqual(await runtime.step(), { status: "paused", action: "repair_issue_paused" });
    assert.equal(eventsOf(fixture, "repair.issue_paused").length, 1);
    append(fixture, "repair.issue_budget_extended", "owner-extend-1", { role: "user", id: "owner" }, { issueId, additionalCycles: 1 });
    assert.equal(rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).status, "running");
    // The fourth, owner-authorized correction is charged: 4/4.
    seedRepairIssueExtraCycles(fixture, 1);
    assert.equal(rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).repairIssues?.[issueId]?.used, 4);
    let error: string | undefined;
    let second: unknown;
    try {
      second = await runtime.step();
    } catch (e) {
      error = (e as Error).message;
    }
    assert.equal(error, undefined, "the second exhaustion must pause, not throw");
    assert.deepEqual(second, { status: "paused", action: "repair_issue_paused" });
    const end = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(end.status, "paused");
    assert.equal(end.pauseReason?.reason, `repair_issue_paused:${issueId}`);
    const pauses = eventsOf(fixture, "repair.issue_paused");
    assert.equal(pauses.length, 2);
    assert.ok((pauses[1]!.payload.detail as string).includes("4/4"));
  } finally {
    fixture.close();
  }
});

/**
 * T6b repair (R2-B1, probe H): an ordinary owner resume of an
 * exhausted-issue pause re-pauses durably — a step never reports paused
 * while the projection says running.
 */
test("a generic owner resume re-pauses durably instead of leaving a phantom running run", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    seedIntegrationRevision(fixture);
    seedGeneration(fixture);
    await driveToDispatchReady(fixture);
    seedRepairIssueExtraCycles(fixture, 3);
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, []));
    assert.deepEqual(await runtime.step(), { status: "paused", action: "repair_issue_paused" });
    append(fixture, "run.resumed", "owner-resume-1", { role: "user", id: "owner" }, {});
    const results: unknown[] = [];
    for (let index = 0; index < 3; index += 1) results.push(await runtime.step());
    for (const result of results) {
      assert.equal((result as { status: string }).status, "paused");
    }
    const end = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(end.status, "paused");
    assert.equal(end.pauseReason?.reason, `repair_issue_paused:${testsIssueId()}`);
    assert.ok(eventsOf(fixture, "repair.issue_paused").length >= 2);
  } finally {
    fixture.close();
  }
});

/**
 * T6b repair (R2-B3, probe I): a failed approach relabelled with the same
 * hypothesis and NO evidence is refused by the decision tool, plans
 * nothing, and charges nothing.
 */
test("a failed approach relabelled with no evidence is refused and charges nothing", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    seedIntegrationRevision(fixture);
    seedGeneration(fixture);
    await driveToDispatchReady(fixture);
    const issueId = testsIssueId();
    const diag = fixture.evidence.record({
      runId: RUN_ID,
      taskId: TASK_ID,
      actor: { role: "worker", id: "t6b-fixture-worker" },
      fact: commandEvidence("t6b-r2b3:diag", { label: "tests", command: "fixture", exitCode: 1 }).fact as never,
      createdAt: fixture.clock(),
      idempotencyKey: `${GENERATION_ID}:diag:r2b3`,
      attempt: 1,
    });
    const diagId = diag.id;
    append(fixture, "repair.approach_decided", `repair-approach:${issueId}:a1`, { role: "architect", id: "architect-test" }, {
      issueId, approachId: "a1", repeat: false, hypothesis: "first remedy", diagnosticSet: [diagId], evidenceIds: [diagId],
    });
    append(fixture, "repair.cycle_recorded", "repair-cycle:approach:a1", { role: "runner", id: "build-runtime" }, {
      issueId, hypothesis: "first remedy", outcome: "failed", evidenceIds: [diagId], approachId: "a1",
    });
    const observed: Record<string, unknown> = {};
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, []), {
      architectDriver: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        run: async (request: any) => {
          if (request.reason?.type !== "final_verification_repair_plan_required") return undefined;
          const current = request.projection.finalVerification?.current;
          const failure = current?.failure;
          const decision = await request.tools.invoke({ type: "tool_call", callId: "relabel", name: "record_repair_approach_decision", arguments: { issueId, approachId: "a1-renamed", repeat: false, hypothesis: "first remedy", diagnosticSet: [diagId], evidenceIds: [] } }, request.context);
          observed.decisionIsError = (decision as { isError?: boolean }).isError;
          observed.decisionCode = (decision as { error?: { code?: string } }).error?.code;
          const plan = await request.tools.invoke({ type: "tool_call", callId: "plan", name: "plan_verification_repairs", arguments: {
            finalVerificationTaskId: TASK_ID, generationId: current?.generationId, targetRevision: REVISION,
            source: { type: "mechanical_failure", failureId: failure.failureId, issueIds: failure.issueIds, factIds: failure.factIds },
            tasks: [{ id: "relabel-repair", objective: "fix tests", categories: ["tests"], evidenceIds: [...failure.evidenceIds], dependencies: [], requiredCapabilities: ["code"], acceptanceCriteria: [{ id: "ac-1", text: "tests pass" }] }],
          } }, request.context);
          observed.planIsError = (plan as { isError?: boolean }).isError;
          return undefined;
        },
      },
    });
    let error: string | undefined;
    try {
      await runtime.step();
    } catch (e) {
      error = (e as Error).message;
    }
    assert.equal(observed.decisionIsError, true, "a relabel of a failed approach with no evidence must be refused");
    assert.equal(observed.decisionCode, "invalid_repair_approach_decision", "the refusal is the relabel rule, not the unknown-evidence gate");
    assert.equal(observed.planIsError, true, "no live decision means no dispatch");
    assert.ok(error === undefined || /without a typed action/.test(error), error ?? "unexpected error");
    const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.repairIssues?.[issueId]?.used, 1);
    assert.equal(projection.finalVerification?.current?.repairTaskIds, undefined);
  } finally {
    fixture.close();
  }
});
/**
 * T6b repair (R2-N3): a repair approach that cites a fabricated diagnostic
 * id is refused by the unknown-evidence gate and charges nothing.
 */
test("a repair approach citing unknown diagnostic evidence is refused and charges nothing", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    seedIntegrationRevision(fixture);
    seedGeneration(fixture);
    await driveToDispatchReady(fixture);
    const issueId = testsIssueId();
    const diag = fixture.evidence.record({
      runId: RUN_ID,
      taskId: TASK_ID,
      actor: { role: "worker", id: "t6b-fixture-worker" },
      fact: commandEvidence("t6b-n3:diag", { label: "tests", command: "fixture", exitCode: 1 }).fact as never,
      createdAt: fixture.clock(),
      idempotencyKey: `${GENERATION_ID}:diag:n3`,
      attempt: 1,
    });
    const observed: Record<string, unknown> = {};
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, []), {
      architectDriver: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        run: async (request: any) => {
          if (request.reason?.type !== "final_verification_repair_plan_required") return undefined;
          const decision = await request.tools.invoke({ type: "tool_call", callId: "fabricated-diag", name: "record_repair_approach_decision", arguments: { issueId, approachId: "a1", repeat: false, hypothesis: "first remedy", diagnosticSet: ["fabricated-diagnostic"], evidenceIds: [diag.id] } }, request.context);
          observed.decisionIsError = (decision as { isError?: boolean }).isError;
          observed.decisionCode = (decision as { error?: { code?: string } }).error?.code;
          return undefined;
        },
      },
    });
    await assert.rejects(() => runtime.step(), /without a typed action/);
    assert.equal(observed.decisionIsError, true, "a fabricated diagnostic id must be refused");
    assert.equal(observed.decisionCode, "unknown_evidence", "the refusal is the evidence-store gate");
    const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.repairIssues?.[issueId]?.used, 0);
    assert.equal(projection.repairIssues?.[issueId]?.approaches.length, 0);
  } finally {
    fixture.close();
  }
});
/**
 * T6b repair (R2-N4): model review outcomes are keyed by run. The same
 * model and task id in two runs keep separate rows, a defect recorded in
 * run A never leaks into run B, and a pre-N4 table migrates (legacy rows
 * stay readable in the '' run bucket).
 */
test("model review outcomes are isolated per run and legacy tables migrate", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t6b-n4-"));
  try {
    const legacyPath = join(root, "legacy.sqlite");
    const legacy = new DatabaseSync(legacyPath);
    legacy.exec("CREATE TABLE model_review_outcomes (project_id TEXT NOT NULL, model_id TEXT NOT NULL, task_id TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0, defect_found INTEGER NOT NULL DEFAULT 0, recorded_at TEXT NOT NULL DEFAULT '', PRIMARY KEY (project_id, model_id, task_id))");
    legacy.exec("INSERT INTO model_review_outcomes (project_id, model_id, task_id, accepted, defect_found, recorded_at) VALUES ('p', 'm', 'T1', 1, 1, '2026-09-25T00:00:00.000Z')");
    legacy.close();
    const store = new SqliteProjectMemoryStore(legacyPath);
    try {
      const migrated = store.modelReviewOutcomes("p");
      assert.equal(migrated.length, 1);
      assert.equal(migrated[0]?.runId, "");
      assert.equal(migrated[0]?.defectFound, true);
      store.recordModelReviewOutcome({ projectId: "p", runId: "run-a", modelId: "m", taskId: "T1", accepted: true, defectFound: true, recordedAt: "2026-09-25T00:00:01.000Z" });
      store.recordModelReviewOutcome({ projectId: "p", runId: "run-b", modelId: "m", taskId: "T1", accepted: true, defectFound: false, recordedAt: "2026-09-25T00:00:02.000Z" });
      const runA = store.modelReviewOutcomes("p", "run-a");
      const runB = store.modelReviewOutcomes("p", "run-b");
      assert.equal(runA.length, 1);
      assert.equal(runA[0]?.defectFound, true);
      assert.equal(runB.length, 1);
      assert.equal(runB[0]?.defectFound, false);
      assert.equal(store.modelReviewOutcomes("p").length, 3);
      store.recordModelReviewOutcome({ projectId: "p", runId: "run-b", modelId: "m", taskId: "T1", accepted: true, defectFound: false, recordedAt: "2026-09-25T00:00:03.000Z" });
      assert.equal(store.modelReviewOutcomes("p", "run-b")[0]?.defectFound, false);
      assert.equal(store.modelReviewOutcomes("p", "run-a")[0]?.defectFound, true);
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * T6b repair (R2-B5): T6a review-finding fix rounds (reject -> fix ->
 * re-review) open and charge a delivery-review:<task>:<criterion> issue
 * through the real pump. Three real fixes charge three cycles; the fourth
 * round pauses with a durable owner-visible reason instead of retrying.
 */
test("blocking review fix rounds charge the review issue budget and the fourth round pauses", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    // Only T1 flows; the other planned tasks stay cancelled.
    for (const taskId of ["T2", "T3", "T4", "T5", "T-INV"]) {
      append(fixture, "task.transitioned", `cancel:${taskId}`, { role: "architect", id: "architect-test" }, { taskId, status: "cancelled" });
    }
    const workerEvidence: string[] = [];
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, []), {
      maxTaskAttempts: 6,
      workerDriver: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        run: async (assignment: any) => {
          if (assignment.task.id !== "T1") return { type: "failed" as const, reason: "t6b review test only runs T1" };
          const record = fixture.evidence.record({
            runId: RUN_ID,
            taskId: "T1",
            actor: { role: "worker", id: assignment.workerId },
            fact: commandEvidence(`t6b-review:T1:${assignment.attempt}`, { label: "fix" }).fact as never,
            createdAt: fixture.clock(),
            idempotencyKey: `t6b-review:T1:${assignment.attempt}`,
            attempt: assignment.attempt,
          });
          workerEvidence.push(record.id);
          return {
            type: "submitted" as const,
            changeSetId: `changeset:T1:${assignment.attempt}`,
            criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: record.id, artifactHashes: ["a".repeat(64)], taskId: "T1", attempt: assignment.attempt }],
          };
        },
      },
      architectDriver: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        run: async (request: any) => {
          if (request.reason?.type !== "review_required" || request.reason.taskId !== "T1") return undefined;
          const evidenceId = workerEvidence.at(-1)!;
          fixture.store.append({
            runId: RUN_ID,
            type: "review.decided" as never,
            occurredAt: fixture.clock(),
            actor: { role: "architect", id: "architect-test" },
            idempotencyKey: `review:T1:${request.projection.tasks.T1.attempt}`,
            payload: {
              taskId: "T1",
              decision: "rejected",
              summary: "Still broken.",
              evidenceArtifactHashes: ["a".repeat(64)],
              criterionVerdicts: [{ criterionId: "c1", verdict: "unsatisfied", rationale: "c1 still broken", evidenceIds: [evidenceId], artifactHashes: ["a".repeat(64)] }],
            },
          });
          return undefined;
        },
      },
    });
    const reviewIssueId = repairIssueIdentity({ projectId: PROJECT_ID, rootCause: "delivery-review:T1:c1" });
    const statusOf = () => rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).tasks.T1.status;
    const usedOf = () => rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).repairIssues?.[reviewIssueId]?.used;
    for (let round = 1; round <= 3; round += 1) {
      for (let guard = 0; guard < 12 && statusOf() !== "submitted"; guard += 1) await runtime.step();
      assert.equal(statusOf(), "submitted", `round ${round}: T1 submitted`);
      seedCompletedDeliveryReview(fixture.store, RUN_ID, "T1", { clock: fixture.clock() });
      await runtime.step(); // review_required turn rejects T1
      assert.equal(statusOf(), "rejected", `round ${round}: T1 rejected`);
      assert.deepEqual(await runtime.step(), { status: "progressed", action: "task_retry_planned" });
      assert.equal(statusOf(), "planned", `round ${round}: T1 planned again`);
      assert.equal(usedOf(), round, `round ${round}: one review cycle charged`);
    }
    // The fourth fix round is refused: the run pauses on the review issue.
    for (let guard = 0; guard < 12 && statusOf() !== "submitted"; guard += 1) await runtime.step();
    assert.equal(statusOf(), "submitted", "round 4: T1 submitted");
    seedCompletedDeliveryReview(fixture.store, RUN_ID, "T1", { clock: fixture.clock() });
    await runtime.step();
    assert.equal(statusOf(), "rejected", "round 4: T1 rejected");
    assert.deepEqual(await runtime.step(), { status: "paused", action: "repair_issue_paused" });
    const end = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(end.pauseReason?.reason, `repair_issue_paused:${reviewIssueId}`);
    assert.equal(end.repairIssues?.[reviewIssueId]?.used, 3);
  } finally {
    fixture.close();
  }
});

/**
 * T6b repair (R2-B5): three real fixes on the same failing test charge
 * three cycles against one category-plus-failing-ids issue through the
 * real pump and the real tools; the fourth round pauses. Each round runs
 * a fresh generation (fresh evidence, same failing test id).
 */
test("three real fixes on the same failing test charge once each, then the fourth round pauses", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    for (const taskId of ["T1", "T2", "T3", "T4", "T5", "T-INV"]) {
      append(fixture, "task.transitioned", `cancel:${taskId}`, { role: "architect", id: "architect-test" }, { taskId, status: "cancelled" });
    }
    const revisionFor = (round: number): string => `${round}`.repeat(40);
    const failingPlan = {
      checks: (["tests", "build", "runtime_smoke", "browser"] as const).map((category) =>
        category === "tests"
          ? { category, status: "required" as const }
          : {
            category,
            status: "not_applicable" as const,
            rationale: `No ${category} check is configured.`,
            repositoryInspection: { paths: ["package.json"], summary: `No ${category} check is configured.` },
          }),
    };
    let round = 0;
    let checkCalls = 0;
    const runtime = buildTestRuntime(fixture, {
      executeCheck: async (input) => {
        // Non-tests categories are not applicable: mirror the plan entry
        // and answer green with no executable evidence.
        if (input.category !== "tests") {
          const planned = input.plan.checks.find((check) => check.category === input.category)!;
          return {
            workspacePath: "C:/verification-workspace",
            startedAt: fixture.clock(),
            finishedAt: fixture.clock(),
            check: {
              ...planned,
              green: true,
              evidenceIds: [],
              facts: [],
              issues: [],
            },
          };
        }
        checkCalls += 1;
        const template = await testsFact(fixture, `t6b-three-round:${input.generationId}:${checkCalls}`, { failingTestIds: ["red-one"] });
        const fact = {
          ...template,
          repositoryRevision: input.targetRevision,
          targetRevision: input.targetRevision,
          startState: { revision: input.targetRevision, status: "clean" as const },
          endState: { revision: input.targetRevision, status: "clean" as const },
        };
        const record = fixture.evidence.record({
          runId: RUN_ID,
          taskId: input.taskId,
          actor: { role: "worker", id: "t6b-fixture-worker" },
          fact: fact as never,
          createdAt: fixture.clock(),
          idempotencyKey: `${input.generationId}:t6b-three-round:${checkCalls}`,
          attempt: 1,
        });
        return {
          workspacePath: "C:/verification-workspace",
          startedAt: fixture.clock(),
          finishedAt: fixture.clock(),
          check: {
            category: "tests",
            status: "required",
            green: false,
            evidenceIds: [record.id],
            facts: [fact],
            issues: ["red-one fails"],
          },
        };
      },
    }, {
      repairPlanLimit: 6,
      finalVerificationProfileFor: async (targetRevision: string) => profileForRequiredCategories(targetRevision, ["tests"]),
      architectDriver: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        run: async (request: any) => {
          if (request.reason?.type === "final_verification_plan_required") {
            await request.tools.invoke({ type: "tool_call", callId: `three-round-plan-${request.reason.integrationRevision.slice(0, 1)}`, name: "plan_final_verification", arguments: { plan: failingPlan } }, request.context);
            return undefined;
          }
          if (request.reason?.type !== "final_verification_repair_plan_required") return undefined;
          round += 1;
          const current = request.projection.finalVerification?.current;
          const failure = current?.failure;
          const issueId = testsIssueIdFor(["red-one"]);
          await request.tools.invoke({ type: "tool_call", callId: `three-round-decision-${round}`, name: "record_repair_approach_decision", arguments: {
            issueId, approachId: `three-round-a${round}`, repeat: false,
            hypothesis: `three-round fix ${round}`, diagnosticSet: [], evidenceIds: [...failure.evidenceIds],
          } }, request.context);
          await request.tools.invoke({ type: "tool_call", callId: `three-round-repair-${round}`, name: "plan_verification_repairs", arguments: {
            finalVerificationTaskId: current.taskId, generationId: current.generationId, targetRevision: current.targetRevision,
            source: { type: "mechanical_failure", failureId: failure.failureId, issueIds: [...failure.issueIds], factIds: [...failure.factIds] },
            tasks: [{
              id: `three-round-fix-${round}`, objective: `Fix red-one (round ${round}).`, categories: ["tests"],
              evidenceIds: [...failure.evidenceIds], dependencies: [], requiredCapabilities: ["code"],
              acceptanceCriteria: [{ id: "ac-1", text: "red-one passes" }],
            }],
          } }, request.context);
          return undefined;
        },
      },
    });
    const issueId = testsIssueIdFor(["red-one"]);
    append(fixture, "integration.revision_advanced", "t6b-three-round-rev-1", { role: "runner", id: "integration-test" }, { integrationRevision: revisionFor(1) });
    for (let dispatch = 1; dispatch <= 3; dispatch += 1) {
      for (let guard = 0; guard < 25; guard += 1) {
        const current = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).finalVerification?.current;
        if (current?.failure && current.cleanup?.status === "succeeded" && !current.repairTaskIds?.length) break;
        await runtime.step();
      }
      const ready = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).finalVerification?.current;
      assert.ok(ready?.failure && ready.cleanup?.status === "succeeded" && !ready.repairTaskIds?.length, `round ${dispatch}: dispatch ready`);
      await runtime.step(); // repair turn dispatches through the real tools
      const after = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
      assert.equal(after.finalVerification?.current?.repairTaskIds?.length, 1, `round ${dispatch}: one repair task`);
      assert.equal(after.repairIssues?.[issueId]?.used, dispatch, `round ${dispatch}: exactly one charge`);
      // The next revision invalidates this generation; only then is its
      // dispatched repair set aside (owner cancels it), so the next
      // round's fresh generation re-fails on the same test.
      append(fixture, "integration.revision_advanced", `t6b-three-round-rev-${dispatch + 1}`, { role: "runner", id: "integration-test" }, { integrationRevision: revisionFor(dispatch + 1) });
      for (const repairTaskId of after.finalVerification?.current?.repairTaskIds ?? []) {
        append(fixture, "task.transitioned", `cancel:${repairTaskId}`, { role: "architect", id: "architect-test" }, { taskId: repairTaskId, status: "cancelled" });
      }
    }
    // The fourth round runs a fresh generation against the same failing
    // test and is refused: the run pauses on the exhausted issue.
    for (let guard = 0; guard < 25; guard += 1) {
      const current = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).finalVerification?.current;
      if (current?.failure && current.cleanup?.status === "succeeded" && !current.repairTaskIds?.length) break;
      await runtime.step();
    }
    assert.deepEqual(await runtime.step(), { status: "paused", action: "repair_issue_paused" });
    const end = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(Object.keys(end.repairIssues ?? {}).length, 1, "one issue for one failing test across revisions");
    assert.equal(end.repairIssues?.[issueId]?.used, 3);
    assert.equal(end.pauseReason?.reason, `repair_issue_paused:${issueId}`);
  } finally {
    fixture.close();
  }
});

/**
 * T6b repair (R2-B2, probe J): the kernel opens the delivery-boundary
 * issue when a boundary check fails, so resolve_delivery_boundary_failure
 * works through the tools. The scripted Architect plans the boundary
 * repair and dispatches it through the real tools — never a direct event
 * append — and the fix is charged exactly once.
 */
test("a failed delivery boundary opens repair issues so the Architect resolves through the tools", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    for (const taskId of ["T2", "T3", "T4", "T5", "T-INV"]) {
      append(fixture, "task.transitioned", `cancel:${taskId}`, { role: "architect", id: "architect-test" }, { taskId, status: "cancelled" });
    }
    seedIntegrationRevision(fixture);
    const workerEvidence: string[] = [];
    const observed: { turnSawIssue: boolean; decisionIsError?: boolean; resolveIsError?: boolean; resolveDetail?: string } = { turnSawIssue: false };
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, []), {
      workerDriver: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        run: async (assignment: any) => {
          if (assignment.task.id !== "T1") return { type: "failed" as const, reason: "t6b boundary test only runs T1" };
          const record = fixture.evidence.record({
            runId: RUN_ID,
            taskId: "T1",
            actor: { role: "worker", id: assignment.workerId },
            fact: commandEvidence(`t6b-boundary:T1:${assignment.attempt}`, { label: "fix" }).fact as never,
            createdAt: fixture.clock(),
            idempotencyKey: `t6b-boundary:T1:${assignment.attempt}`,
            attempt: assignment.attempt,
          });
          workerEvidence.push(record.id);
          return {
            type: "submitted" as const,
            changeSetId: `changeset:T1:${assignment.attempt}`,
            criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: record.id, artifactHashes: ["a".repeat(64)], taskId: "T1", attempt: assignment.attempt }],
          };
        },
      },
      deliveryReview: {
        review: async (input) => {
          const reviewId = seedCompletedDeliveryReview(fixture.store, RUN_ID, input.taskId, { clock: fixture.clock() });
          return { status: "reviewed", reviewId, runtimeId: "t6b-boundary-reviewer", independence: "fresh_context", tier: "medium", replayed: false };
        },
      },
      deliveryBoundary: {
        check: async () => {
          const record = fixture.evidence.record({
            runId: RUN_ID,
            taskId: "T1",
            actor: { role: "worker", id: "t6b-boundary-check" },
            fact: commandEvidence("t6b-boundary:tests:1", { label: "tests", command: "npm", args: ["test"], exitCode: 1 }).fact as never,
            createdAt: fixture.clock(),
            idempotencyKey: "t6b-boundary:tests:1",
            attempt: 1,
          });
          return {
            changedFiles: ["src/t1.ts"],
            executedScope: "full_test_script",
            selection: { rung: "seed", selectedTests: ["test/t1.test.ts"] },
            checks: [{
              checkId: "tests",
              command: "npm",
              args: ["test"],
              evidenceIds: [record.id],
              exitCode: 1,
              outcome: "failed" as const,
              report: { status: "failed" as const, runner: "t6b-boundary", counts: { selected: 1, passed: 0, failed: 1, skipped: 0 } },
            }],
          };
        },
      },
      architectDriver: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        run: async (request: any) => {
          if (request.reason?.type === "review_required" && request.reason.taskId === "T1") {
            const evidenceId = workerEvidence.at(-1)!;
            fixture.store.append({
              runId: RUN_ID,
              type: "review.decided" as never,
              occurredAt: fixture.clock(),
              actor: { role: "architect", id: "architect-test" },
              idempotencyKey: `review:T1:${request.projection.tasks.T1.attempt}`,
              payload: {
                taskId: "T1",
                decision: "approved",
                summary: "T1 done.",
                evidenceArtifactHashes: ["a".repeat(64)],
                criterionVerdicts: [{ criterionId: "c1", verdict: "satisfied", rationale: "c1 done", evidenceIds: [evidenceId], artifactHashes: ["a".repeat(64)] }],
              },
            });
            return undefined;
          }
          if (request.reason?.type === "integration_approval_required" && request.reason.taskId === "T1") {
            await request.tools.invoke({ type: "tool_call", callId: "t6b-boundary-integrate-1", name: "request_integration", arguments: { taskId: "T1" } }, request.context);
            return undefined;
          }
          if (request.reason?.type !== "delivery_boundary_failed" || request.reason.taskId !== "T1") return undefined;
          // The kernel must have opened the issue before this turn.
          const issues = request.projection.repairIssues ?? {};
          const issueId = Object.keys(issues).find((id) => (issues[id] as { rootCause: string }).rootCause === "delivery-boundary:T1:tests");
          observed.turnSawIssue = issueId !== undefined;
          assert.ok(issueId, "the boundary turn sees the opened delivery-boundary:T1:tests issue");
          const boundary = request.projection.delivery.boundaries.T1.at(-1);
          const evidenceIds = [...new Set(boundary.checks.flatMap((check: { evidenceIds: string[] }) => check.evidenceIds))];
          const decision = await request.tools.invoke({
            type: "tool_call", callId: "t6b-boundary-decision-1", name: "record_repair_approach_decision", arguments: {
              issueId, approachId: "t6b-boundary-a1", repeat: false,
              hypothesis: "Fix the boundary tests failure.", diagnosticSet: [], evidenceIds,
            },
          }, request.context);
          observed.decisionIsError = (decision as { isError?: boolean }).isError;
          const resolution = await request.tools.invoke({
            type: "tool_call", callId: "t6b-boundary-resolve-1", name: "resolve_delivery_boundary_failure", arguments: {
              taskId: "T1",
              boundaryId: request.reason.boundaryId,
              resolution: "repair_planned",
              rationale: "The boundary tests failure is a real regression; plan a focused repair.",
              tasks: [{
                id: "t6b-boundary-fix",
                objective: "Fix the boundary tests failure.",
                dependencies: [],
                requiredCapabilities: ["code"],
                acceptanceCriteria: [{ id: "done", text: "Boundary tests pass." }],
              }],
            },
          }, request.context);
          observed.resolveIsError = (resolution as { isError?: boolean }).isError;
          (observed as { resolveDetail?: string }).resolveDetail = JSON.stringify(resolution).slice(0, 600);
          return undefined;
        },
      },
    });
    for (let guard = 0; guard < 30; guard += 1) {
      const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
      if (projection.finalVerification?.current) break;
      await runtime.step();
      const after = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
      if ((after.delivery?.boundaries.T1?.length ?? 0) > 0 && after.finalVerification?.current === undefined) {
        const boundary = after.delivery!.boundaries.T1!.at(-1)!;
        if (boundary.resolution?.resolution === "repair_planned") break;
        if (!boundary.passed) {
          // Boundary failed: the next step runs the repair turn.
          const result = await runtime.step();
          assert.equal(result.status, "progressed", `boundary repair turn progressed, got ${result.status}`);
          break;
        }
      }
    }
    assert.equal(observed.turnSawIssue, true, "the kernel opened the issue before the turn");
    assert.equal(observed.decisionIsError, false, "the approach decision worked through the tool");
    assert.equal(observed.resolveIsError, false, `the boundary repair dispatched through the tool: ${observed.resolveDetail}`);
    const end = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    const boundaryIssueId = Object.keys(end.repairIssues ?? {}).find((id) => end.repairIssues?.[id]?.rootCause === "delivery-boundary:T1:tests");
    assert.ok(boundaryIssueId, "the delivery-boundary:T1:tests issue exists");
    assert.equal(end.repairIssues?.[boundaryIssueId]?.used, 1, "the boundary fix is charged exactly once");
    assert.equal(end.tasks["t6b-boundary-fix"]?.status, "planned", "the boundary repair task is planned");
    assert.equal(end.delivery?.boundaries.T1?.at(-1)?.resolution?.resolution, "repair_planned");
  } finally {
    fixture.close();
  }
});

/**
 * T6b repair (R3-B2): one RepairApproachDecision authorizes exactly one
 * repair dispatch. The "three real fixes" loop with a decision recorded
 * only in round 1 dispatches round 1, then refuses the round-2 dispatch
 * (no live decision; used unchanged) until a new decision is recorded —
 * at which point round 2 dispatches exactly once. Inverted from review-r3
 * PROBE-LIVE, where rounds 2 and 3 dispatched with no new decision.
 */
test("a decision recorded only in round 1 refuses the round-2 dispatch until a new decision is recorded", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    for (const taskId of ["T1", "T2", "T3", "T4", "T5", "T-INV"]) {
      append(fixture, "task.transitioned", `cancel:${taskId}`, { role: "architect", id: "architect-test" }, { taskId, status: "cancelled" });
    }
    const revisionFor = (round: number): string => `${round}`.repeat(40);
    const failingPlan = {
      checks: (["tests", "build", "runtime_smoke", "browser"] as const).map((category) =>
        category === "tests"
          ? { category, status: "required" as const }
          : {
            category,
            status: "not_applicable" as const,
            rationale: `No ${category} check is configured.`,
            repositoryInspection: { paths: ["package.json"], summary: `No ${category} check is configured.` },
          }),
    };
    let round = 0;
    let checkCalls = 0;
    const planned: Array<{ round: number; decided: boolean; planIsError?: boolean; planCode?: string }> = [];
    const executeCheck: FinalVerificationCheckDriver["executeCheck"] = async (input) => {
      if (input.category !== "tests") {
        const plannedCheck = input.plan.checks.find((check) => check.category === input.category)!;
        return {
          workspacePath: "C:/verification-workspace",
          startedAt: fixture.clock(),
          finishedAt: fixture.clock(),
          check: {
            ...plannedCheck,
            green: true,
            evidenceIds: [],
            facts: [],
            issues: [],
          },
        };
      }
      checkCalls += 1;
      const template = await testsFact(fixture, `r3b2:${input.generationId}:${checkCalls}`, { failingTestIds: ["red-one"] });
      const fact = {
        ...template,
        repositoryRevision: input.targetRevision,
        targetRevision: input.targetRevision,
        startState: { revision: input.targetRevision, status: "clean" as const },
        endState: { revision: input.targetRevision, status: "clean" as const },
      };
      const record = fixture.evidence.record({
        runId: RUN_ID,
        taskId: input.taskId,
        actor: { role: "worker", id: "t6b-fixture-worker" },
        fact: fact as never,
        createdAt: fixture.clock(),
        idempotencyKey: `${input.generationId}:r3b2:${checkCalls}`,
        attempt: 1,
      });
      return {
        workspacePath: "C:/verification-workspace",
        startedAt: fixture.clock(),
        finishedAt: fixture.clock(),
        check: {
          category: "tests",
          status: "required",
          green: false,
          evidenceIds: [record.id],
          facts: [fact],
          issues: ["red-one fails"],
        },
      };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repairTurn = async (request: any, decide: boolean, approachTag: string) => {
      if (request.reason?.type === "final_verification_plan_required") {
        await request.tools.invoke({ type: "tool_call", callId: `r3b2-plan-${request.reason.integrationRevision.slice(0, 1)}`, name: "plan_final_verification", arguments: { plan: failingPlan } }, request.context);
        return;
      }
      if (request.reason?.type !== "final_verification_repair_plan_required") return;
      round += 1;
      const current = request.projection.finalVerification?.current;
      const failure = current?.failure;
      const issueId = testsIssueIdFor(["red-one"]);
      let decided = false;
      if (decide) {
        const decision = await request.tools.invoke({ type: "tool_call", callId: `r3b2-decision-${approachTag}-${round}`, name: "record_repair_approach_decision", arguments: {
          issueId, approachId: `r3b2-${approachTag}`, repeat: false,
          hypothesis: `r3b2 fix ${approachTag}`, diagnosticSet: [], evidenceIds: [...failure.evidenceIds],
        } }, request.context);
        assert.equal((decision as { isError?: boolean }).isError, false);
        decided = true;
      }
      const planOut = await request.tools.invoke({ type: "tool_call", callId: `r3b2-repair-${approachTag}-${round}`, name: "plan_verification_repairs", arguments: {
        finalVerificationTaskId: current.taskId, generationId: current.generationId, targetRevision: current.targetRevision,
        source: { type: "mechanical_failure", failureId: failure.failureId, issueIds: [...failure.issueIds], factIds: [...failure.factIds] },
        tasks: [{
          id: `r3b2-fix-${approachTag}-${round}`, objective: `Fix red-one (${approachTag} round ${round}).`, categories: ["tests"],
          evidenceIds: [...failure.evidenceIds], dependencies: [], requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "ac-1", text: "red-one passes" }],
        }],
      } }, request.context);
      planned.push({ round, decided, planIsError: (planOut as { isError?: boolean }).isError, planCode: (planOut as { error?: { code?: string } }).error?.code });
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const roundOneOnlyDriver = { run: async (request: any) => repairTurn(request, round === 0, "a1") };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const decidingDriver = { run: async (request: any) => repairTurn(request, true, "a2") };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const buildRuntime = (architectDriver: { run: (request: any) => Promise<void> }) => buildTestRuntime(fixture, { executeCheck }, {
      repairPlanLimit: 6,
      finalVerificationProfileFor: async (targetRevision: string) => profileForRequiredCategories(targetRevision, ["tests"]),
      architectDriver,
    });
    const issueId = testsIssueIdFor(["red-one"]);
    const driveReady = async (runtime: { step: () => Promise<unknown> }) => {
      for (let guard = 0; guard < 25; guard += 1) {
        const current = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).finalVerification?.current;
        if (current?.failure && current.cleanup?.status === "succeeded" && !current.repairTaskIds?.length) return;
        await runtime.step();
      }
      assert.fail("round never reached dispatch-ready");
    };
    // Round 1 records its decision and dispatches exactly once.
    let runtime = buildRuntime(roundOneOnlyDriver);
    append(fixture, "integration.revision_advanced", "r3b2-rev-1", { role: "runner", id: "integration-test" }, { integrationRevision: revisionFor(1) });
    await driveReady(runtime);
    await runtime.step();
    let after = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(after.finalVerification?.current?.repairTaskIds?.length, 1, "round 1: one repair task");
    assert.equal(after.repairIssues?.[issueId]?.used, 1, "round 1: exactly one charge");
    assert.equal(after.repairIssues?.[issueId]?.approaches.at(-1)?.dispatched, true, "the decision is consumed at dispatch");
    // The next revision invalidates this generation; its dispatched repair
    // is set aside so the next round's fresh generation re-fails.
    append(fixture, "integration.revision_advanced", "r3b2-rev-2", { role: "runner", id: "integration-test" }, { integrationRevision: revisionFor(2) });
    for (const repairTaskId of after.finalVerification?.current?.repairTaskIds ?? []) {
      append(fixture, "task.transitioned", `cancel:${repairTaskId}`, { role: "architect", id: "architect-test" }, { taskId: repairTaskId, status: "cancelled" });
    }
    // Round 2 records no new decision: the dispatch is refused with
    // repair_approach_decision_required and nothing is charged.
    await driveReady(runtime);
    await assert.rejects(() => runtime.step(), /without a typed action/);
    after = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(after.repairIssues?.[issueId]?.used, 1, "round 2 without a decision charges nothing");
    assert.equal(after.finalVerification?.current?.repairTaskIds, undefined, "round 2 dispatches no repair");
    assert.equal(planned.at(-1)?.decided, false);
    assert.equal(planned.at(-1)?.planIsError, true);
    assert.equal(planned.at(-1)?.planCode, "repair_approach_decision_required");
    const failedMarks = eventsOf(fixture, "repair.approach_failed");
    assert.equal(failedMarks.length, 1, "the dispatched repair's next validation failure durably fails its approach");
    assert.deepEqual(failedMarks[0]!.payload, { issueId, approachId: "r3b2-a1" });
    assert.equal(after.repairIssues?.[issueId]?.approaches.at(-1)?.failed, true);
    // A new decision authorizes exactly one more dispatch.
    runtime = buildRuntime(decidingDriver);
    await runtime.step();
    after = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(after.finalVerification?.current?.repairTaskIds?.length, 1, "a new decision dispatches once");
    assert.equal(after.repairIssues?.[issueId]?.used, 2, "the new decision charges exactly one cycle");
  } finally {
    fixture.close();
  }
});

// __APPEND_POINT__



/**
 * T6b repair (B3/B5, probes A and D): after two completed rounds, the
 * third correction dispatches through the real pump — one charge bound to
 * its live recorded approach — reaching exactly three cycles. The fourth
 * dispatch then pauses (covered by the exhausted-issue test). No step
 * throws. A full three-round worker loop would also need the delivery
 * review/boundary drivers; the unit harness stops at dispatch, which is
 * where every T6b charge lands.
 */
test("the third correction dispatches and charges through the real pump", async () => {
  const fixture = createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    seedIntegrationRevision(fixture);
    seedGeneration(fixture);
    const issueId = testsIssueId();
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, []));
    assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_check_non_green" });
    assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_failure_reported" });
    assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_cleanup_succeeded" });
    // Two completed rounds stand in for earlier pump rounds (same shape the
    // pump produces: a decided approach plus its failed dispatched cycle).
    for (const round of [1, 2]) {
      append(fixture, "repair.approach_decided", `repair-approach:${issueId}:prior-a${round}`, { role: "architect", id: "architect-test" }, {
        issueId,
        approachId: `prior-a${round}`,
        repeat: false,
        hypothesis: `prior remedy ${round}`,
        diagnosticSet: [`prior-d${round}`],
        evidenceIds: [`prior-d${round}`],
      });
      append(fixture, "repair.cycle_recorded", `repair-cycle:prior-a${round}`, { role: "runner", id: "build-runtime" }, {
        issueId,
        hypothesis: `prior remedy ${round}`,
        outcome: "failed",
        evidenceIds: [`prior-d${round}`],
        approachId: `prior-a${round}`,
      });
    }
    assert.equal(rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).repairIssues?.[issueId]?.used, 2);
    // The Architect records a new approach with new evidence and dispatches
    // the third correction through the real tools.
    const plans = { count: 0 };
    const dispatching = buildTestRuntime(fixture, failingCheckDriver(fixture, []), {
      architectDriver: repairPlanningArchitectDriver(plans, "r3-"),
    });
    await dispatching.step();
    assert.equal(plans.count, 1);
    const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.repairIssues?.[issueId]?.used, 3);
    const cycles = eventsOf(fixture, "repair.cycle_recorded");
    assert.equal(cycles.length, 3);
    assert.equal(cycles[2]!.payload.outcome, "dispatched");
    assert.equal(cycles[2]!.payload.approachId, "r3-a1");
    assert.equal(projection.finalVerification?.current?.repairTaskIds?.length, 1);
  } finally {
    fixture.close();
  }
});
