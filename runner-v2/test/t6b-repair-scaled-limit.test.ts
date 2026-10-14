import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import {
  BuildRuntime,
  type FinalVerificationCheckDriver,
  type FinalVerificationCheckExecution,
  type FinalVerificationCleanupDriver,
} from "../src/build-runtime.js";
import type { FinalVerificationCategory } from "../src/final-verification-contracts.js";
import type { FinalVerificationExecutionProfile } from "../src/final-verification-profile.js";
import type { FinalVerificationCommandFact } from "../src/final-verification-runtime.js";
import { renderPlanningStatus, renderRunRepairBudget } from "../src/agent-prompts.js";
import {
  DEFAULT_REPAIR_PLAN_LIMIT,
  consumeRepairCycle,
  currentExplicitStartIdentity,
  effectiveRepairPlanLimit,
  readyPlanTaskCount,
  rebuildSchedulerProjection,
  repairCyclesExhausted,
  repairPlanLimitScales,
} from "../src/scheduler-store.js";
import {
  newRepairBudgetRecord,
  repairBudgetAllowsDispatch,
  repairIssueIdentity,
  repairRootCauseForCheck,
} from "../src/repair-budget-contracts.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import {
  FIXTURE_AMENDED_TEXT,
  buildPlanningFixtureScenario,
  type PlanningFixtureScenario,
} from "./fixtures/planning-source-fixture.js";
import {
  acceptFinalVerificationProfile,
  profileForRequiredCategories,
} from "./support/final-verification-profile.js";

/**
 * Owner decision 2026-09-26 ("Scale with tasks"): the whole-run repair-plan
 * limit grows with the ready plan (3 + tasks) on new-policy runs without an
 * explicit cap. Real SQLite stores, the real kernel reducer, and the real
 * pump throughout. Per-issue 3-cycle budgets are untouched, and legacy runs
 * keep the flat DEFAULT_REPAIR_PLAN_LIMIT.
 */

const RUN_ID = "run-t6b-scaled-limit";
const PROJECT_ID = "t6b-scaled-project";
const REVISION = "b".repeat(40);
const TASK_ID = "final-verification-scaled";
const GENERATION_ID = "fv-scaled-generation";
const CLOCK_START = Date.UTC(2026, 8, 27, 0, 0, 0);

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

/**
 * The approved amended fixture text extends the prior text with exactly one
 * appended section line (see planning-source-fixture.ts). The prior bytes are
 * derived deterministically from the exported amended text and then verified
 * against the prior manifest, so any fixture drift fails loudly below.
 */
const FIXTURE_PRIOR_SUFFIX = "\nSECTION 8: AMENDMENT. Section 7 is retired by this amendment.";

async function provisionPlanningSourceBytes(
  artifacts: ArtifactStore,
  scenario: Pick<PlanningFixtureScenario, "priorManifest" | "manifest">,
): Promise<void> {
  assert.ok(
    FIXTURE_AMENDED_TEXT.endsWith(FIXTURE_PRIOR_SUFFIX),
    "the approved amended fixture text still carries the deterministic prior-text suffix",
  );
  const priorText = FIXTURE_AMENDED_TEXT.slice(0, FIXTURE_AMENDED_TEXT.length - FIXTURE_PRIOR_SUFFIX.length);
  const priorBytes = Buffer.from(priorText, "utf-8");
  const amendedBytes = Buffer.from(FIXTURE_AMENDED_TEXT, "utf-8");
  assert.equal(priorBytes.byteLength, scenario.priorManifest.byteLength, "prior manifest byteLength matches actual fixture bytes");
  assert.equal(amendedBytes.byteLength, scenario.manifest.byteLength, "current manifest byteLength matches actual fixture bytes");
  const prior = await artifacts.put(priorBytes, scenario.priorManifest.mediaType, "planning-source-prior.txt");
  const amended = await artifacts.put(amendedBytes, scenario.manifest.mediaType, "planning-source.txt");
  assert.equal(prior.hash, scenario.priorManifest.artifactDigest, "prior manifest digest matches actual stored bytes");
  assert.equal(amended.hash, scenario.manifest.artifactDigest, "current manifest digest matches actual stored bytes");
}

async function createStore(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t6b-scaled-"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  // Planning-source authority through real stored bytes: the approved
  // fixture texts are provisioned via ArtifactStore.put and awaited before
  // scheduler/runtime admission, and the manifest byteLength/digest are
  // verified against the actual stored bytes. verifySync is NOT overridden,
  // so unknown/missing/tampered digests still throw from the real store.
  // One authority serves both the scheduler store and the runtime, so the
  // two can never diverge on the current source.
  const scenario = buildPlanningFixtureScenario();
  await provisionPlanningSourceBytes(artifacts, scenario);
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
  append(fixture, "project_docs.policy_configured", "project-docs-policy", { role: "runner", id: "build-runtime" }, { version: 2 });
  append(fixture, "run.initialized", "run-initialized", { role: "runner", id: "build-runtime" }, {});
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

// Explicit owner start for the current ready plan (accepted T6/T7b
// contract): the scripted owner authorizes THIS current identity — plan
// revision + digest, source manifest + digest, planning + docs policy
// versions — with ownerChoice "execute" as user:local-user. Each scenario
// that intends execution calls this explicitly after seedReadyPlan; it is
// never called for legacy runs, never for plan_only, and never with a
// stale identity (a new ready revision needs a fresh call).
function authorizeOwnerStart(fixture: Fixture, key = "owner-start:1"): void {
  const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
  const identity = currentExplicitStartIdentity(projection);
  assert.ok(identity, "the seeded ready plan has an exact owner-start identity");
  append(fixture, "planning.execution_authorized", key, { role: "user", id: "local-user" }, {
    authorization: { ...identity, version: 1, ownerChoice: "execute" },
  });
}

function seedLegacyPlan(fixture: Fixture): void {
  append(fixture, "plan.created", "t6b-legacy-plan", { role: "architect", id: "architect-test" }, {
    revision: 1,
    tasks: [{
      id: "implementation-one",
      objective: "Implement the scaled-limit fixture feature.",
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
      checks: (["tests", "build", "runtime_smoke", "browser"] as FinalVerificationCategory[]).map((category) => category === "tests"
        ? { category, status: "required" as const }
        : { category, status: "not_applicable" as const, rationale: `No ${category} fixture is configured.`, repositoryInspection: { paths: ["package.json"], summary: `No ${category} fixture is configured.` } }),
    },
    executionProfile: profileForRequiredCategories(REVISION, ["tests"]),
  });
}

async function testsFact(fixture: Fixture, tag: string): Promise<FinalVerificationCommandFact> {
  const stdout = await fixture.artifacts.put(Buffer.from(`scaled stdout ${tag}`), "text/plain", "scaled fixture stdout");
  const stderr = await fixture.artifacts.put(Buffer.from(`scaled stderr ${tag}`), "text/plain", "scaled fixture stderr");
  return {
    kind: "command",
    category: "tests",
    label: "tests",
    executable: "fixture",
    command: "fixture",
    args: [],
    cwd: "C:/verification-workspace",
    startedAt: "2026-08-27T00:00:03.000Z",
    finishedAt: "2026-08-27T00:00:04.000Z",
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
  } as FinalVerificationCommandFact;
}

function failingCheckDriver(fixture: Fixture, calls: string[]): FinalVerificationCheckDriver {
  return {
    executeCheck: async (input) => {
      calls.push(input.category);
      assert.equal(input.generationId, GENERATION_ID);
      assert.equal(input.taskId, TASK_ID);
      assert.equal(input.targetRevision, REVISION);
      const fact = await testsFact(fixture, `${calls.length}`);
      const record = fixture.evidence.record({
        runId: RUN_ID,
        taskId: TASK_ID,
        actor: { role: "worker", id: "scaled-fixture-worker" },
        fact: fact as never,
        createdAt: fixture.clock(),
        idempotencyKey: `${GENERATION_ID}:fact:tests:${calls.length}`,
        attempt: 1,
      });
      const check: FinalVerificationCheckExecution = {
        workspacePath: "C:/verification-workspace",
        startedAt: "2026-08-27T00:00:03.000Z",
        finishedAt: "2026-08-27T00:00:04.000Z",
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    architectDriver?: { run: (request: any) => Promise<void> };
    repairPlanLimit?: number;
    finalVerificationProfileFor?: (targetRevision: string) => Promise<FinalVerificationExecutionProfile>;
    // Worker assignment requires artifact authority (T7b); only scenarios
    // that assign workers opt in. Final-verification-only flows keep the
    // original artifacts-absent configuration.
    withArtifacts?: boolean;
  } = {},
) {
  const cleanupDriver: FinalVerificationCleanupDriver = {
    cleanup: async () => ({ diagnosticsPath: "C:/diagnostics/scaled-failure.json" }),
  };
  return new BuildRuntime({
    runId: RUN_ID,
    store: fixture.store,
    evidenceStore: fixture.evidence,
    ...(options.withArtifacts ? { artifacts: fixture.artifacts } : {}),
    clock: fixture.clock,
    projectId: PROJECT_ID,
    maxConcurrency: 1,
    ...(options.finalVerificationProfileFor !== undefined ? { finalVerificationProfileFor: options.finalVerificationProfileFor } : {}),
    ...(options.repairPlanLimit !== undefined ? { repairPlanLimit: options.repairPlanLimit } : {}),
    workspaceFor: async () => "C:/never",
    workerDriver: { run: async () => ({ type: "failed" as const, reason: "scaled must not use workers" }) },
    architectDriver: options.architectDriver ?? { run: async () => undefined },
    integrationDriver: { integrate: async () => ({ status: "integrated" as const, integrationRevision: REVISION }) },
    finalVerificationDriver: driver,
    finalVerificationCleanupDriver: cleanupDriver,
  });
}

async function driveToDispatchReady(fixture: Fixture): Promise<void> {
  const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, []));
  assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_check_non_green" });
  assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_failure_reported" });
  assert.deepEqual(await runtime.step(), { status: "progressed", action: "final_verification_cleanup_succeeded" });
}

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

test("a 6-task new-policy plan scales the effective run limit to 3 + 6 = 9", async () => {
  const fixture = await createStore();
  try {
    seedPolicy(fixture);
    assert.equal(SCENARIO.revision.tasks.length, 6, "the ready plan carries six tasks");
    seedReadyPlan(fixture);
    // Production wiring records the default (non-explicit) repair policy.
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, []));
    const projection = runtime.projection();
    assert.equal(readyPlanTaskCount(projection), 6);
    assert.equal(projection.repairCycles?.limit, 3, "the stored base stays the flat default");
    assert.equal(projection.repairCycles?.explicitLimit, false);
    assert.equal(repairPlanLimitScales(projection), true);
    assert.equal(effectiveRepairPlanLimit(projection), 9);
    assert.equal(repairCyclesExhausted(projection), false);
    const status = JSON.parse(renderPlanningStatus(projection)) as { repairBudget: unknown };
    assert.deepEqual(status.repairBudget, { used: 0, limit: 9, scalesWithReadyPlan: true, readyPlanTasks: 6 });
    assert.ok(renderRunRepairBudget(projection).includes("used 0/9"));
  } finally {
    fixture.close();
  }
});

test("a 6-task plan allows a 4th unrelated repair plan (limit 9)", async () => {
  const fixture = await createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, []));
    assert.equal(effectiveRepairPlanLimit(runtime.projection()), 9);
    // Three prior unrelated repair plans, each for a distinct root cause so
    // no per-issue budget blocks: the kernel run cap is the only gate.
    const live = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    for (let n = 1; n <= 3; n += 1) {
      const rootCause = repairRootCauseForCheck({ category: "tests", failingIds: [`t-${n}`] });
      const issueId = repairIssueIdentity({ projectId: PROJECT_ID, rootCause });
      const remaining = (effectiveRepairPlanLimit(live) ?? 0) - (live.repairCycles?.used ?? 0);
      assert.equal(
        repairBudgetAllowsDispatch(newRepairBudgetRecord(issueId, rootCause), { maxTaskAttemptsRemaining: 2, maxRepairPlanRemaining: remaining }).allowed,
        true,
        `unrelated repair ${n} must still dispatch`,
      );
      consumeRepairCycle(live);
    }
    assert.equal(live.repairCycles?.used, 3);
    assert.equal(repairCyclesExhausted(live), false, "a flat 3 would already be exhausted here");
    const fourthRoot = repairRootCauseForCheck({ category: "tests", failingIds: ["t-4"] });
    const fourthId = repairIssueIdentity({ projectId: PROJECT_ID, rootCause: fourthRoot });
    const remaining = (effectiveRepairPlanLimit(live) ?? 0) - (live.repairCycles?.used ?? 0);
    assert.equal(
      repairBudgetAllowsDispatch(newRepairBudgetRecord(fourthId, fourthRoot), { maxTaskAttemptsRemaining: 2, maxRepairPlanRemaining: remaining }).allowed,
      true,
      "the 4th unrelated repair must still dispatch",
    );
    consumeRepairCycle(live);
    assert.equal(live.repairCycles?.used, 4);
    assert.equal(effectiveRepairPlanLimit(live), 9);
    assert.equal(repairCyclesExhausted(live), false);
  } finally {
    fixture.close();
  }
});

test("a run that keeps failing still stops at its scaled limit", async () => {
  const fixture = await createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    buildTestRuntime(fixture, failingCheckDriver(fixture, []));
    const live = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    for (let n = 1; n <= 9; n += 1) consumeRepairCycle(live);
    assert.equal(live.repairCycles?.used, 9);
    assert.equal(effectiveRepairPlanLimit(live), 9);
    assert.equal(repairCyclesExhausted(live), true);
    assert.throws(() => consumeRepairCycle(live), /Repair plan limit reached: 9 of 9 repair plans used/);
  } finally {
    fixture.close();
  }
});

test("an explicit repairPlanLimit=3 still stops at 3 on a 6-task plan", async () => {
  const fixture = await createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, []), { repairPlanLimit: 3 });
    const projection = runtime.projection();
    assert.equal(readyPlanTaskCount(projection), 6);
    assert.equal(projection.repairCycles?.explicitLimit, true);
    assert.equal(repairPlanLimitScales(projection), false);
    assert.equal(effectiveRepairPlanLimit(projection), 3, "explicit wins over 3 + 6");
    const live = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    for (let n = 1; n <= 3; n += 1) consumeRepairCycle(live);
    assert.equal(repairCyclesExhausted(live), true);
    assert.throws(() => consumeRepairCycle(live), /Repair plan limit reached: 3 of 3 repair plans used/);
  } finally {
    fixture.close();
  }
});

test("legacy runs keep the flat DEFAULT_REPAIR_PLAN_LIMIT = 3", async () => {
  assert.equal(DEFAULT_REPAIR_PLAN_LIMIT, 3);
  const fixture = await createStore();
  try {
    append(fixture, "run.initialized", "run-initialized", { role: "runner", id: "runner-test" }, {});
    seedLegacyPlan(fixture);
    append(fixture, "repair.policy_configured", "repair-policy", { role: "runner", id: "build-runtime" }, { repairPlanLimit: 3 });
    const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.planningPolicyVersion, undefined);
    assert.equal(repairPlanLimitScales(projection), false);
    assert.equal(effectiveRepairPlanLimit(projection), 3);
    const live = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    for (let n = 1; n <= 3; n += 1) consumeRepairCycle(live);
    assert.equal(repairCyclesExhausted(live), true);
    assert.throws(() => consumeRepairCycle(live), /Repair plan limit reached: 3 of 3 repair plans used/);
  } finally {
    fixture.close();
  }
});

test("the run-limit pause reason carries the effective limit and usage", async () => {
  const fixture = await createStore();
  try {
    seedPolicy(fixture);
    append(fixture, "repair.policy_configured", "repair-policy:zero", { role: "runner", id: "build-runtime" }, { repairPlanLimit: 0 });
    seedReadyPlan(fixture);
    authorizeOwnerStart(fixture);
    seedIntegrationRevision(fixture);
    seedGeneration(fixture);
    await driveToDispatchReady(fixture);
    const runtime = buildTestRuntime(fixture, failingCheckDriver(fixture, []));
    assert.deepEqual(await runtime.step(), { status: "paused", action: "repair_cycle_limit_reached" });
    const paused = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(paused.status, "paused");
    assert.equal(paused.pauseReason?.reason, "repair_cycle_limit");
    assert.ok((paused.pauseReason?.detail ?? "").includes("used 0 of 0"), "pause reason shows usage and the effective cap");
  } finally {
    fixture.close();
  }
});

test("a scaled run dispatches its first repair through the real pump", async () => {
  const fixture = await createStore();
  try {
    seedPolicy(fixture);
    seedReadyPlan(fixture);
    authorizeOwnerStart(fixture);
    seedIntegrationRevision(fixture);
    seedGeneration(fixture);
    await driveToDispatchReady(fixture);
    const plans = { count: 0 };
    const proceeding = buildTestRuntime(fixture, failingCheckDriver(fixture, []), {
      architectDriver: repairPlanningArchitectDriver(plans, "scaled-"),
    });
    await proceeding.step();
    assert.equal(plans.count, 1);
    const after = proceeding.projection();
    assert.equal(after.repairCycles?.used, 1);
    assert.equal(effectiveRepairPlanLimit(after), 9);
    assert.equal(repairCyclesExhausted(after), false);
  } finally {
    fixture.close();
  }
});
