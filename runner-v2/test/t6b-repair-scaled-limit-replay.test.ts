/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars -- T6b r5 regression test adapted from the reviewer's replay probe; builds raw events against the reducer. */
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
  effectiveRepairPlanLimit,
  readyPlanTaskCount,
  rebuildSchedulerProjection,
  reduceSchedulerEvent,
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
import { buildPlanningFixtureScenario } from "./fixtures/planning-source-fixture.js";
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

function createStore(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t6b-scaled-"));
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
  } = {},
) {
  const cleanupDriver: FinalVerificationCleanupDriver = {
    cleanup: async () => ({ diagnosticsPath: "C:/diagnostics/scaled-failure.json" }),
  };
  return new BuildRuntime({
    runId: RUN_ID,
    store: fixture.store,
    evidenceStore: fixture.evidence,
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

function oldFormatRun(fixture: Fixture) {
  seedPolicy(fixture);
  seedReadyPlan(fixture);
  // Exactly what the committed HEAD runtime wrote: no `explicit` flag.
  append(fixture, "repair.policy_configured", "repair-policy", { role: "runner", id: "build-runtime" }, { repairPlanLimit: 3 });
  return rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
}
function ev(p: any, type: string, actor: any, payload: Record<string, unknown>) {
  return { runId: RUN_ID, sequence: (p.lastSequence ?? 0) + 1, type, occurredAt: "2026-09-27T00:00:00.000Z", actor, idempotencyKey: `probe:${type}:${Math.random()}`, payload } as any;
}
function lastSeq(fixture: Fixture) { const e = fixture.store.readRun(RUN_ID); return e[e.length - 1]!.sequence; }

test("T6b-R5 OLDROW replay of a HEAD-written limit_reached {used 3, limit 3}", () => {
  const fixture = createStore();
  try {
    const p: any = oldFormatRun(fixture);
    p.lastSequence = lastSeq(fixture);
    const out: Record<string, unknown> = { explicitLimit: p.repairCycles?.explicitLimit ?? "absent", scales: repairPlanLimitScales(p), effective: effectiveRepairPlanLimit(p) };
    for (let n = 0; n < 3; n += 1) consumeRepairCycle(p);
    let error: string | undefined;
    try { reduceSchedulerEvent(p, ev(p, "repair.cycle_limit_reached", { role: "runner", id: "build-runtime" }, { source: "final_verification", targetRevision: REVISION, used: 3, limit: 3 })); } catch (e) { error = (e as Error).message; }
    out.replayError = error ?? null;
    console.log("PROBE-R5-OLDROW", JSON.stringify(out));
    assert.equal(error, undefined, "a HEAD-era log must replay deterministically");
  } finally { fixture.close(); }
});

test("T6b-R5 EXTEND an owner extension on an old-format row must not shrink the limit below used", () => {
  const fixture = createStore();
  try {
    const p: any = oldFormatRun(fixture);
    p.lastSequence = lastSeq(fixture);
    // A row without the explicit flag keeps HEAD's flat limit (3): it pauses at 3/3.
    assert.equal(repairPlanLimitScales(p), false);
    for (let n = 0; n < 3; n += 1) consumeRepairCycle(p);
    const paused = reduceSchedulerEvent(p, ev(p, "repair.cycle_limit_reached", { role: "runner", id: "build-runtime" }, { source: "final_verification", targetRevision: REVISION, used: 3, limit: 3 })) as any;
    paused.lastSequence = p.lastSequence + 1;
    const extended = reduceSchedulerEvent(paused, ev(paused, "repair.cycle_limit_extended", { role: "user", id: "owner" }, { additionalRepairPlans: 1 }));
    const out = { before: effectiveRepairPlanLimit(paused), after: effectiveRepairPlanLimit(extended), used: extended.repairCycles?.used, cycles: extended.repairCycles, exhaustedAfterExtend: repairCyclesExhausted(extended) };
    console.log("PROBE-R5-EXTEND", JSON.stringify(out));
    assert.ok((out.after ?? 0) > (out.used ?? 0), "an extension must grant at least one more repair plan");
  } finally { fixture.close(); }
});

test("T6b-R5 EXPLICIT3 new-policy run configured explicitly with 3 stays at 3; default grows; legacy flat", () => {
  const a = createStore();
  try {
    seedPolicy(a); seedReadyPlan(a);
    buildTestRuntime(a, failingCheckDriver(a, []), { repairPlanLimit: 3 });
    const p = rebuildSchedulerProjection(a.store.readRun(RUN_ID));
    console.log("PROBE-R5-EXPLICIT3", JSON.stringify({ explicit: p.repairCycles?.explicitLimit, eff: effectiveRepairPlanLimit(p) }));
    assert.equal(effectiveRepairPlanLimit(p), 3);
  } finally { a.close(); }
  const b = createStore();
  try {
    append(b, "run.initialized", "run-initialized", { role: "runner", id: "runner-test" }, {});
    seedLegacyPlan(b);
    append(b, "repair.policy_configured", "repair-policy", { role: "runner", id: "build-runtime" }, { repairPlanLimit: 5 });
    const p = rebuildSchedulerProjection(b.store.readRun(RUN_ID));
    console.log("PROBE-R5-LEGACY5", JSON.stringify({ scales: repairPlanLimitScales(p), eff: effectiveRepairPlanLimit(p) }));
    assert.equal(effectiveRepairPlanLimit(p), 5);
  } finally { b.close(); }
});