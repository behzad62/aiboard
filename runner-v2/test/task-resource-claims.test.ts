// Real SQLite/scheduler behavior is exercised below; filesystem/Git cases are
// explicitly marked and the real-Git workspace suite remains controller-run.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { BuildTask } from "../src/task-contracts.js";
import { BuildRuntime } from "../src/build-runtime.js";
import {
  droppedReadyContractTasks,
  newPolicyStaleTasksRequireArchitect,
  newPolicyTaskAdmissionBlocked,
  rebuildSchedulerProjection,
  taskPlanMembership,
  type NewSchedulerEvent,
  type SchedulerProjection,
  type SchedulerStore,
} from "../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import {
  TaskScheduler,
  type WorkerAssignment,
  type WorkerOutcome,
  type WorkerRuntimeDriver,
} from "../src/task-scheduler.js";
import {
  dependencyBlockReason,
  readyTaskIds,
} from "../src/task-graph.js";
import {
  buildAssignmentClaim,
  claimPathContains,
  claimPathsEqual,
  claimPathsOverlap,
  effectiveMaxWorkers,
  findClaimConflict,
  isSharedSurface,
  MAX_WORKERS,
  normalizeClaimPath,
  normalizeResourceClaim,
  resolveClaimPathAgainstRoot,
  releaseAssignmentClaim,
  type TaskWriteClaim,
} from "../src/task-resource-claims.js";
import {
  buildExecutionPlanRevision,
} from "../src/planning-contracts.js";
import type {
  CoverageReview,
  ExecutionPlanRevisionWithoutDigest,
  ExecutionTaskContract,
  SourceRequirement,
} from "../src/planning-contracts.js";
import type { ApprovedSourceManifest } from "../src/source-manifest.js";
import { buildPlanningFixtureScenario } from "./fixtures/planning-source-fixture.js";
import { seedBoundCoverageAndReady } from "./support/planning-seed.js";
import { emptyFinalVerificationProfile } from "./support/final-verification-profile.js";

/**
 * T4 — dependency/resource admission with bounded parallel lanes (EP08,
 * EP11, EP12 T4 half, EP13, plus the N-A / bridge carry-forwards).
 *
 * Durable behavior is exercised on the REAL SQLite scheduler store with an
 * advancing clock, and dispatch through the REAL pump (BuildRuntime.step)
 * and TaskScheduler.tick — never in-memory fakes.
 */

// ---------------------------------------------------------------------------
// Harness: real SQLite store, advancing clock, controllable driver
// ---------------------------------------------------------------------------

const SEED_AT = "2026-09-24T00:00:00.000Z";

interface T4Fixture {
  root: string;
  evidence: SqliteEvidenceStore;
  store: SqliteSchedulerStore;
  clock: () => string;
  close(): void;
}

function openFixture(name: string): T4Fixture {
  const root = mkdtempSync(join(tmpdir(), `aiboard-t4-${name}-`));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    evidenceStore: evidence,
  });
  let now = Date.parse(SEED_AT);
  const clock = (): string => {
    const iso = new Date(now).toISOString();
    now += 1000;
    return iso;
  };
  return {
    root,
    evidence,
    store,
    clock,
    close() {
      store.close();
      evidence.close();
      setTimeout(() => {
        try {
          rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 100,
            retryDelay: 100,
          });
        } catch {
          // Windows may briefly retain SQLite WAL handles; never turn
          // asynchronous cleanup into a test failure.
        }
      }, 250);
    },
  };
}

function projectionOf(store: SchedulerStore, runId: string): SchedulerProjection {
  return rebuildSchedulerProjection(store.readRun(runId));
}

/** Records assignments; resolves outcomes on demand, or fails fast. */
class DeferredDriver implements WorkerRuntimeDriver {
  readonly assignments: string[] = [];
  private readonly pending = new Map<string, (outcome: WorkerOutcome) => void>();
  constructor(private readonly failFast = false) {}
  run(assignment: WorkerAssignment): Promise<WorkerOutcome> {
    this.assignments.push(assignment.task.id);
    if (this.failFast) {
      return Promise.resolve({ type: "failed", reason: "t4-probe" });
    }
    return new Promise((resolve) => {
      this.pending.set(assignment.task.id, resolve);
    });
  }
  resolve(taskId: string, outcome: WorkerOutcome): void {
    this.pending.get(taskId)?.(outcome);
  }
}



// ---------------------------------------------------------------------------
// Real SQLite scheduler admission matrix
// ---------------------------------------------------------------------------

interface ContractSpec {
  readonly id: string;
  readonly dependencies?: readonly string[];
  readonly phaseId?: "P1" | "P2";
  readonly files?: readonly string[];
  readonly resources?: readonly string[];
}

interface ReadyPlanFixture {
  readonly manifest: ApprovedSourceManifest;
  readonly priorManifest: ApprovedSourceManifest;
  readonly revision: ExecutionPlanRevisionWithoutDigest;
  readonly review: CoverageReview;
}

function taskContract(
  manifest: ApprovedSourceManifest,
  spec: ContractSpec,
): ExecutionTaskContract {
  const requirementId = `REQ-${spec.id}`;
  return {
    id: spec.id,
    lineage: [],
    accountablePhaseId: spec.phaseId ?? "P1",
    requirementIds: [requirementId],
    outcome: {
      user: `Deliver observable behavior for ${spec.id}.`,
      system: `Record system behavior for ${spec.id}.`,
    },
    scope: { includes: [...(spec.files ?? [`src/${spec.id}.ts`])], excludes: [] },
    writableSurfaces: [...(spec.files ?? [`src/${spec.id}.ts`])],
    forbiddenSurfaces: ["AGENTS.md"],
    ...(spec.resources?.length
      ? { sharedResourceClaims: [...spec.resources] }
      : {}),
    dependencies: [...(spec.dependencies ?? [])],
    requiredBase: "accepted T9 snapshot",
    inputs: ["approved plan"],
    outputs: ["implemented behavior"],
    steps: ["Inspect.", "Implement.", "Validate."],
    acceptance: {
      criteria: [{ id: "done", text: `${spec.id} satisfies its observable outcome.` }],
      definitionOfDone: "Accepted with current evidence.",
    },
    validation: {
      targetedRationale: "Exact task behavior.",
      affectedScopeRationale: "Declared consumers and shared surfaces.",
    },
    negativeProofApplicability: {
      applicable: true,
      rationale: "A prior-incorrect guard case is available.",
    },
    reviewCriteria: ["Independent review checks the task contract."],
    integrationChecks: ["Affected boundary remains valid."],
    cleanup: {
      cleanup: "Remove task scratch files.",
      recovery: "Resume from the durable claim.",
      rollback: "Discard the isolated task worktree.",
    },
    requirementCriteriaMap: [{ taskLocalCriterionId: "done", requirementId }],
  };
}

function coverageFor(
  runId: string,
  revision: ExecutionPlanRevisionWithoutDigest,
  manifest: ApprovedSourceManifest,
  reviewId: string,
): CoverageReview {
  const derivedObligations = revision.requirements.map((requirement) => ({
    id: `obl-${requirement.id}`,
    requirementId: requirement.id,
    description: `Derived obligation for ${requirement.id}.`,
    recordedBeforePlanOrDiffProvided: true,
    recordedAt: "2026-09-24T00:00:00.000Z",
  }));
  return {
    id: reviewId,
    runId,
    reviewerRuntimeId: "reviewer:t4",
    independence: "fresh_context",
    sourceReadManifestId: manifest.manifestId,
    planRevisionId: revision.revisionId,
    planRevisionDigest: buildExecutionPlanRevision(revision).digest,
    derivedObligations,
    obligationVerdicts: derivedObligations.map((obligation) => ({
      obligationId: obligation.id,
      verdict: "covered",
      severity: "advisory",
      rationale: "The plan contract covers this derived obligation.",
      evidenceRefs: ["ledger:t4"],
    })),
    findings: [],
    recordedAt: "2026-09-24T00:00:00.000Z",
  };
}

function buildReadyPlanFixture(
  runId: string,
  specs: readonly ContractSpec[],
  options: {
    revisionId?: string;
    createdAt?: string;
    dropTaskId?: string;
    reviewId?: string;
  } = {},
): ReadyPlanFixture {
  const scenario = buildPlanningFixtureScenario();
  const amendment = scenario.manifest.amendment!;
  const manifest: ApprovedSourceManifest = {
    ...scenario.manifest,
    amendment: {
      ...amendment,
      recordedImpact: {
        addsSectionIds: ["s8"],
        retiresSectionIds: ["s7"],
        addsRequirementIds: [],
        retiresRequirementIds: ["REQ-RETIRED"],
      },
    },
  };
  let tasks = specs
    .filter((spec) => spec.id !== options.dropTaskId)
    .map((spec) => taskContract(manifest, spec));
  const requirements: SourceRequirement[] = specs.map((spec, index) => {
    const requirementId = `REQ-${spec.id}`;
    const dropped = spec.id === options.dropTaskId;
    return {
      id: requirementId,
      reference: {
        sourceId: manifest.sourceId,
        sectionIds: manifest.sections.map((section) => section.id),
      },
      purpose: `Obligation for ${spec.id}.`,
      observableOutcome: `${spec.id} produces its declared observable outcome.`,
      obligationKind: index % 2 === 0 ? "mandatory" : "operational",
      applicability: { status: "applicable" },
      accountablePhaseId: spec.phaseId ?? "P1",
      contributingTaskIds: dropped
        ? [specs.find((candidate) => candidate.id !== options.dropTaskId)!.id]
        : [spec.id],
      acceptanceConditions: [{
        id: `${requirementId}-ac`,
        description: `${spec.id} meets its acceptance contract.`,
        responsibleGateId: `${spec.phaseId ?? "P1"}-exit`,
        requiredEvidenceKinds: ["test"],
      }],
    };
  });
  tasks = tasks.map((task) => {
    const linkedRequirements = requirements.filter((requirement) =>
      requirement.contributingTaskIds.includes(task.id),
    );
    return {
      ...task,
      requirementIds: linkedRequirements.map((requirement) => requirement.id),
      requirementCriteriaMap: linkedRequirements.map((requirement) => ({
        taskLocalCriterionId: "done",
        requirementId: requirement.id,
      })),
    };
  });
  const phaseIds = [...new Set(tasks.map((task) => task.accountablePhaseId))];
  const phases = phaseIds.map((phaseId) => ({
    id: phaseId,
    purpose: `Acceptance boundary ${phaseId}.`,
    requirementIds: requirements
      .filter((requirement) => requirement.accountablePhaseId === phaseId)
      .map((requirement) => requirement.id),
    scope: { includes: ["src"], excludes: ["docs/project"] },
    entryConditions: ["Ready plan identity is current."],
    contributingTaskIds: tasks
      .filter((task) => task.accountablePhaseId === phaseId)
      .map((task) => task.id),
    exitCriteria: ["Every contributing task is accepted."],
    requiredCombinedValidation: ["targeted-tests"],
    exitUnlocks: ["next phase"],
  }));
  const revision = buildExecutionPlanRevision({
    revisionId: options.revisionId ?? "revision_1",
    runId,
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements,
    tasks,
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [{
      id: "T4-capacity",
      description: "New-policy workers use bounded admission.",
      decidedAt: "2026-09-24T00:00:00.000Z",
    }],
    validationObligations: ["targeted-tests"],
    createdAt: options.createdAt ?? "2026-09-24T00:00:00.000Z",
  });
  const { digest: _digest, ...withoutDigest } = revision;
  return {
    manifest,
    priorManifest: scenario.priorManifest,
    revision: withoutDigest,
    review: coverageFor(
      runId,
      withoutDigest,
      manifest,
      options.reviewId ?? "coverage_1",
    ),
  };
}

function appendEvent(
  store: SchedulerStore,
  input: Omit<NewSchedulerEvent, "runId" | "occurredAt"> & {
    runId?: string;
    occurredAt?: string;
  },
): void {
  store.append({
    runId: input.runId ?? "run_t4",
    occurredAt: input.occurredAt ?? SEED_AT,
    ...input,
  });
}

function seedReadyPlan(
  store: SchedulerStore,
  fixture: ReadyPlanFixture,
  runId = "run_t4",
): void {
  appendEvent(store, {
    runId,
    type: "run.initialized",
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "run:init",
    payload: {},
  });
  appendEvent(store, {
    runId,
    type: "run.policy_configured",
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "run:policy",
    payload: { runPolicy: "finish" },
  });
  appendEvent(store, {
    runId,
    type: "planning.policy_configured",
    actor: { role: "runner", id: "runner" },
    idempotencyKey: "planning:policy",
    payload: { version: 1 },
  });
  appendEvent(store, {
    runId,
    type: "planning.source_registered",
    actor: { role: "user", id: "owner" },
    idempotencyKey: "source:base",
    payload: { manifest: fixture.priorManifest },
  });
  appendEvent(store, {
    runId,
    type: "planning.source_amended",
    actor: { role: "user", id: "owner" },
    idempotencyKey: "source:amend-1",
    payload: { manifest: fixture.manifest },
  });
  appendEvent(store, {
    runId,
    type: "request.triaged",
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: "triage:build",
    payload: {
      decision: "build",
      rationale: "The request changes project source.",
    },
  });
  appendEvent(store, {
    runId,
    type: "planning.ledger_persisted",
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: "ledger:1",
    payload: {
      id: "ledger-t4",
      requirements: fixture.revision.requirements,
      phases: fixture.revision.phases,
      nonNormativeSections: [],
    },
  });
  appendEvent(store, {
    runId,
    type: "planning.plan_drafted",
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: `plan:${fixture.revision.revisionId}`,
    payload: { revision: buildExecutionPlanRevision(fixture.revision) },
  });
  seedBoundCoverageAndReady(store, runId, {
    revision: buildExecutionPlanRevision(fixture.revision),
    manifest: fixture.manifest,
    review: fixture.review,
    hostCapabilities: buildPlanningFixtureScenario().hostCapabilities,
  });
}

function fixtureClock(): () => string {
  let now = Date.parse(SEED_AT);
  return () => {
    const value = new Date(now).toISOString();
    now += 1000;
    return value;
  };
}

async function waitFor(condition: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function schedulerFor(
  store: SqliteSchedulerStore,
  driver: WorkerRuntimeDriver,
  options: {
    maxConcurrency?: number;
    workspaceFor?: TaskSchedulerOptionsWorkspace;
    resourceCapacity?: number | (() => number | undefined);
  } = {},
): TaskScheduler {
  return new TaskScheduler({
    runId: "run_t4",
    store,
    driver,
    maxConcurrency: options.maxConcurrency ?? 4,
    workspaceFor: options.workspaceFor ?? (async (task) => `C:/work/${task.id}`),
    clock: fixtureClock(),
    ...(options.resourceCapacity !== undefined
      ? { resourceCapacity: options.resourceCapacity }
      : {}),
  });
}

type TaskSchedulerOptionsWorkspace = NonNullable<
  ConstructorParameters<typeof TaskScheduler>[0]["workspaceFor"]
>;

test("T4 real SQLite admission runs independent cross-phase tasks concurrently to four and respects lower/resource capacity", async () => {
  const specs: ContractSpec[] = [
    { id: "A1", phaseId: "P1" },
    { id: "A2", phaseId: "P2" },
    { id: "A3", phaseId: "P1" },
    { id: "A4", phaseId: "P2" },
    { id: "A5", phaseId: "P1" },
  ];
  const fixture = openFixture("capacity");
  try {
    seedReadyPlan(fixture.store, buildReadyPlanFixture("run_t4", specs));
    const driver = new DeferredDriver();
    const scheduler = schedulerFor(fixture.store, driver, {
      maxConcurrency: 8,
    });
    await scheduler.tick();
    assert.deepEqual(driver.assignments.sort(), ["A1", "A2", "A3", "A4"]);

    const lowerStore = new SqliteSchedulerStore(
      join(fixture.root, "lower.sqlite"),
      { evidenceStore: fixture.evidence },
    );
    seedReadyPlan(
      lowerStore,
      buildReadyPlanFixture("run_t4", specs, {
        revisionId: "revision_lower",
        reviewId: "coverage_lower",
      }),
    );
    const lowerDriver = new DeferredDriver();
    const lower = schedulerFor(lowerStore, lowerDriver, {
      maxConcurrency: 3,
      resourceCapacity: 2,
    });
    await lower.tick();
    assert.equal(lowerDriver.assignments.length, 2);
    lowerStore.close();

    const legacyStore = new SqliteSchedulerStore(
      join(fixture.root, "legacy.sqlite"),
      { evidenceStore: fixture.evidence },
    );
    legacyStore.append({
      runId: "run_t4",
      type: "plan.created",
      occurredAt: SEED_AT,
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "legacy-plan",
      payload: {
        revision: 1,
        tasks: specs.map((spec, index) => ({
          id: spec.id,
          objective: `Legacy ${spec.id}`,
          dependencies: [],
          status: "planned",
          requiredCapabilities: [],
          acceptanceCriteria: [{ id: "ready", text: "Ready." }],
          acceptanceCriteriaVersion: 1,
          attempt: 0,
          workspacePath: `C:/legacy/${index}`,
        })),
      },
    });
    const legacyDriver = new DeferredDriver();
    const legacy = schedulerFor(legacyStore, legacyDriver, {
      maxConcurrency: 8,
    });
    await legacy.tick();
    assert.equal(legacyDriver.assignments.length, 5);
    legacyStore.close();
  } finally {
    fixture.close();
  }
});

test("T4 dependencies, shared worktrees and overlapping or aliased writes prevent dual admission", async () => {
  const fixture = openFixture("conflicts");
  try {
    const sameWorktree = buildReadyPlanFixture("run_t4", [
      { id: "W1", files: ["src/w1.ts"] },
      { id: "W2", files: ["src/w2.ts"] },
    ], { revisionId: "revision_worktree", reviewId: "coverage_worktree" });
    seedReadyPlan(fixture.store, sameWorktree);
    const worktreeDriver = new DeferredDriver();
    const worktreeScheduler = schedulerFor(
      fixture.store,
      worktreeDriver,
      { workspaceFor: async () => "C:/work/shared" },
    );
    await worktreeScheduler.tick();
    assert.deepEqual(worktreeDriver.assignments, ["W1"]);
    worktreeDriver.resolve("W1", { type: "failed", reason: "done" });
    await worktreeScheduler.awaitIdle();

    const conflictStore = new SqliteSchedulerStore(
      join(fixture.root, "conflicts.sqlite"),
      { evidenceStore: fixture.evidence },
    );
    const overlap = buildReadyPlanFixture("run_t4", [
      { id: "O1", files: ["src/shared.ts"] },
      { id: "O2", files: ["src/shared.ts"] },
    ], { revisionId: "revision_overlap", reviewId: "coverage_overlap" });
    seedReadyPlan(conflictStore, overlap);
    const overlapDriver = new DeferredDriver();
    const overlapScheduler = schedulerFor(conflictStore, overlapDriver);
    await overlapScheduler.tick();
    assert.deepEqual(overlapDriver.assignments, ["O1"]);
    overlapDriver.resolve("O1", { type: "failed", reason: "done" });
    await overlapScheduler.awaitIdle();
    conflictStore.close();

    const aliasStore = new SqliteSchedulerStore(
      join(fixture.root, "alias.sqlite"),
      { evidenceStore: fixture.evidence },
    );
    const alias = buildReadyPlanFixture("run_t4", [
      { id: "L1", files: ["src/./../src/A.ts"] },
      { id: "L2", files: ["SRC/a.TS"] },
    ], { revisionId: "revision_alias", reviewId: "coverage_alias" });
    seedReadyPlan(aliasStore, alias);
    const aliasDriver = new DeferredDriver();
    const aliasScheduler = schedulerFor(aliasStore, aliasDriver);
    await aliasScheduler.tick();
    assert.deepEqual(aliasDriver.assignments, ["L1"]);
    aliasDriver.resolve("L1", { type: "failed", reason: "done" });
    await aliasScheduler.awaitIdle();
    aliasStore.close();

    const dependencyStore = new SqliteSchedulerStore(
      join(fixture.root, "dependency.sqlite"),
      { evidenceStore: fixture.evidence },
    );
    seedReadyPlan(dependencyStore, buildReadyPlanFixture("run_t4", [
      { id: "D1" },
      { id: "D2", dependencies: ["D1"] },
    ], { revisionId: "revision_dependency", reviewId: "coverage_dependency" }));
    const dependencyDriver = new DeferredDriver();
    const dependencyScheduler = schedulerFor(dependencyStore, dependencyDriver);
    await dependencyScheduler.tick();
    assert.deepEqual(dependencyDriver.assignments, ["D1"]);
    assert.match(
      dependencyBlockReason(
        Object.values(projectionOf(dependencyStore, "run_t4").tasks),
        "D2",
      ) ?? "",
      /waits for dependency D1/,
    );
    dependencyDriver.resolve("D1", { type: "failed", reason: "done" });
    await dependencyScheduler.awaitIdle();
    dependencyStore.close();
  } finally {
    fixture.close();
  }
});

test("T4 shared DB-port-schema-config resources and shared config files serialize", async () => {
  const fixture = openFixture("resources");
  try {
    seedReadyPlan(fixture.store, buildReadyPlanFixture("run_t4", [
      {
        id: "R1",
        files: ["src/r1.ts"],
        resources: ["database:main", "port:5432", "schema:public", "config:runner.json"],
      },
      {
        id: "R2",
        files: ["src/r2.ts"],
        resources: ["db:MAIN", "tcp: 5432", "SCHEMA: PUBLIC", "config: RUNNER.JSON"],
      },
    ], { revisionId: "revision_resources", reviewId: "coverage_resources" }));
    const driver = new DeferredDriver();
    await schedulerFor(fixture.store, driver).tick();
    assert.deepEqual(driver.assignments, ["R1"]);

    const configStore = new SqliteSchedulerStore(
      join(fixture.root, "config.sqlite"),
      { evidenceStore: fixture.evidence },
    );
    seedReadyPlan(configStore, buildReadyPlanFixture("run_t4", [
      { id: "C1", files: ["config/alpha.json"] },
      { id: "C2", files: ["config/beta.json"] },
    ], { revisionId: "revision_config", reviewId: "coverage_config" }));
    const configDriver = new DeferredDriver();
    await schedulerFor(configStore, configDriver).tick();
    assert.deepEqual(configDriver.assignments, ["C1"]);
    configStore.close();
  } finally {
    fixture.close();
  }
});

test("T4 unknown running writers block reassignment", async () => {
  const fixture = openFixture("undeclared");
  try {
    seedReadyPlan(fixture.store, buildReadyPlanFixture("run_t4", [
      { id: "U1", files: ["src/u1.ts"] },
      { id: "U2", files: ["src/u2.ts"] },
    ]));
    const driver = new DeferredDriver();
    const scheduler = schedulerFor(fixture.store, driver);
    appendEvent(fixture.store, {
      type: "task.transitioned",
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: "U2:assigned",
      payload: {
        taskId: "U2",
        status: "assigned",
        patch: { attempt: 1, assignedWorkerId: "worker_U2_1" },
      },
    });
    appendEvent(fixture.store, {
      type: "task.transitioned",
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: "U2:running",
      payload: { taskId: "U2", status: "running", patch: {} },
    });
    await scheduler.tick();
    assert.deepEqual(driver.assignments, []);
  } finally {
    fixture.close();
  }
});

test("T4 ending a caller never frees an unconfirmed live claim; ambiguous restart blocks reassignment", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t4-restart-"));
  const database = join(root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  let store = new SqliteSchedulerStore(database, { evidenceStore: evidence });
  try {
    seedReadyPlan(store, buildReadyPlanFixture("run_t4", [
      { id: "K1", files: ["src/k1.ts"] },
    ], { revisionId: "revision_restart", reviewId: "coverage_restart" }));
    const firstDriver = new DeferredDriver();
    await schedulerFor(store, firstDriver).tick();
    assert.deepEqual(firstDriver.assignments, ["K1"]);
    assert.equal(
      projectionOf(store, "run_t4").planning?.assignments[
        "t4claim:K1:gen:1"
      ]?.status,
      "claimed",
    );

    store.close();
    store = new SqliteSchedulerStore(database, { evidenceStore: evidence });
    const recoveredDriver = new DeferredDriver();
    const recovered = schedulerFor(store, recoveredDriver);
    await recovered.tick();
    assert.deepEqual(recoveredDriver.assignments, ["K1"]);
    assert.equal(
      newPolicyTaskAdmissionBlocked(projectionOf(store, "run_t4"), "K1"),
      undefined,
    );
    assert.equal(
      projectionOf(store, "run_t4").planning?.assignments[
        "t4claim:K1:gen:1"
      ]?.status,
      "claimed",
    );
    assert.throws(
      () => appendEvent(store, {
        type: "planning.assignment_claimed",
        actor: { role: "runner", id: "competing-controller" },
        idempotencyKey: "competing-claim",
        payload: {
          claim: buildAssignmentClaim({
            packetId: "K1",
            laneId: "P1",
            workerOrSessionId: "worker_other",
            acceptedBaseRevision: "base-2",
            branchOrWorktree: "C:/work/other",
            writableSurfaces: ["src/k1.ts"],
            forbiddenSurfaces: [],
            ownershipGeneration: 2,
          }),
        },
      }),
/still owned/,
    );
  } finally {
    store.close();
    evidence.close();
    await new Promise((resolve) => setTimeout(resolve, 250));
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 100,
      retryDelay: 100,
    });
  }
});

test("T4 stopped/fenced evidence is required before claim reassignment", () => {
  const fixture = openFixture("fencing");
  try {
    seedReadyPlan(fixture.store, buildReadyPlanFixture("run_t4", [
      { id: "F1", files: ["src/f1.ts"] },
    ], { revisionId: "revision_fence", reviewId: "coverage_fence" }));
    const first = buildAssignmentClaim({
      packetId: "F1",
      laneId: "P1",
      workerOrSessionId: "worker_F1_1",
      acceptedBaseRevision: "base-1",
      branchOrWorktree: "C:/work/f1",
      writableSurfaces: ["src/f1.ts"],
      forbiddenSurfaces: [],
      ownershipGeneration: 1,
    });
    appendEvent(fixture.store, {
      type: "planning.assignment_claimed",
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: "claim:1",
      payload: { claim: first },
    });
    const second = buildAssignmentClaim({
      packetId: "F1",
      laneId: "P1",
      workerOrSessionId: "worker_F1_2",
      acceptedBaseRevision: "base-2",
      branchOrWorktree: "C:/work/f1-next",
      writableSurfaces: ["src/f1.ts"],
      forbiddenSurfaces: [],
      ownershipGeneration: 2,
    });
    assert.throws(
      () => appendEvent(fixture.store, {
        type: "planning.assignment_claimed",
        actor: { role: "runner", id: "scheduler" },
        idempotencyKey: "claim:2",
        payload: { claim: second },
      }),
/owned|stopped\/fenced writer evidence/,
    );
    appendEvent(fixture.store, {
      type: "planning.assignment_released",
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: "release:1",
      payload: {
        claim: releaseAssignmentClaim(first, "stopped_fenced", "writer process exited"),
      },
    });
    appendEvent(fixture.store, {
      type: "planning.assignment_claimed",
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: "claim:2",
      payload: { claim: second },
    });
    assert.equal(
      projectionOf(fixture.store, "run_t4").planning?.assignments[
        "t4claim:F1:gen:2"
      ]?.status,
      "claimed",
    );
  } finally {
    fixture.close();
  }
});

test("T4 ready-plan bridge creates contract tasks and the real pump dispatches them", async () => {
  const fixture = openFixture("bridge-pump");
  try {
    const specs: ContractSpec[] = [
      { id: "B1", phaseId: "P1", files: ["src/b1.ts"] },
      { id: "B2", phaseId: "P2", files: ["src/b2.ts"] },
    ];
    seedReadyPlan(fixture.store, buildReadyPlanFixture("run_t4", specs));
    const projection = projectionOf(fixture.store, "run_t4");
    assert.deepEqual(
      Object.keys(projection.tasks).sort(),
      specs.map((spec) => spec.id).sort(),
    );
    for (const spec of specs) {
      assert.equal(projection.readyPlanTaskBindings?.[spec.id]?.contractId, spec.id);
    }

    const driver = new DeferredDriver(true);
    const runtime = new BuildRuntime({
      runId: "run_t4",
      store: fixture.store,
      workerDriver: driver,
      architectDriver: {
        run: async () => {
          throw new Error("architect_not_expected");
        },
      },
      integrationDriver: {
        integrate: async () => {
          throw new Error("integration_not_expected");
        },
      },
      maxConcurrency: 4,
      workspaceFor: async (task) => `C:/work/${task.id}`,
      clock: () => SEED_AT,
      finalVerificationProfileFor: async (revision) =>
        emptyFinalVerificationProfile(revision),
    });
    const result = await runtime.step();
    assert.equal(result.status, "progressed");
    assert.equal(result.action, "workers_advanced");
    assert.deepEqual(driver.assignments.sort(), ["B1", "B2"]);
  } finally {
    fixture.close();
  }
});

test("T4 true membership drops a contract, blocks stale digest, surfaces it, and refuses post-ready rogue plan_tasks", async () => {
  const fixture = openFixture("membership");
  try {
    const initial = buildReadyPlanFixture("run_t4", [
      { id: "M1", phaseId: "P1", files: ["src/m1.ts"] },
      { id: "M2", phaseId: "P1", files: ["src/m2.ts"] },
    ], { revisionId: "revision_1", reviewId: "coverage_1" });
    seedReadyPlan(fixture.store, initial);
    const current = projectionOf(fixture.store, "run_t4").planning!.plan!;
    const revisionTwo = buildReadyPlanFixture("run_t4", [
      { id: "M1", phaseId: "P1", files: ["src/m1.ts"] },
      { id: "M2", phaseId: "P1", files: ["src/m2.ts"], },
    ], {
      revisionId: "revision_2",
      createdAt: "2026-09-24T00:01:00.000Z",
      dropTaskId: "M2",
      reviewId: "coverage_2",
    });
    appendEvent(fixture.store, {
      type: "planning.plan_revised",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:revision_2",
      payload: {
        revision: buildExecutionPlanRevision(revisionTwo.revision),
        expectedRevisionId: current.currentRevisionId,
        expectedDigest: current.currentDigest,
      },
    });
    seedBoundCoverageAndReady(fixture.store, "run_t4", {
      revision: buildExecutionPlanRevision(revisionTwo.revision),
      manifest: revisionTwo.manifest,
      review: revisionTwo.review,
      hostCapabilities: buildPlanningFixtureScenario().hostCapabilities,
    });

    const after = projectionOf(fixture.store, "run_t4");
    assert.deepEqual(droppedReadyContractTasks(after), ["M2"]);
    assert.equal(taskPlanMembership(after, "M1").status, "member");
    assert.equal(taskPlanMembership(after, "M2").status, "dropped");
    assert.match(
      newPolicyTaskAdmissionBlocked(after, "M2") ?? "",
      /not in the current ready plan revision|not bound to the current ready plan revision/,
    );
    assert.equal(newPolicyStaleTasksRequireArchitect(after), true);

    const driver = new DeferredDriver();
    await schedulerFor(fixture.store, driver).tick();
    assert.deepEqual(driver.assignments, ["M1"]);

    appendEvent(fixture.store, {
      type: "plan.created",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "rogue-plan",
      payload: {
        revision: 2,
        tasks: [{
          id: "ROGUE",
          objective: "Post-ready rogue task",
          dependencies: [],
          status: "planned",
          requiredCapabilities: [],
          acceptanceCriteria: [{ id: "ready", text: "Rogue is ready." }],
          acceptanceCriteriaVersion: 1,
          attempt: 0,
        }],
      },
    });
    const rogue = projectionOf(fixture.store, "run_t4");
    assert.match(
      newPolicyTaskAdmissionBlocked(rogue, "ROGUE") ?? "",
      /does not map to a contract/,
    );
    assert.deepEqual(rebuildSchedulerProjection(fixture.store.readRun("run_t4")), rogue);
  } finally {
    fixture.close();
  }
});


test("R1-B2 same-owner guidance, pause and restart resume without reassignment", async () => {
  const fixture = openFixture("repair-b2-resume");
  try {
    seedReadyPlan(fixture.store, buildReadyPlanFixture("run_t4", [
      { id: "R2", files: ["src/r2.ts"] },
    ], { revisionId: "revision_b2", reviewId: "coverage_b2" }));
    let calls = 0;
    const evidenceRecord = fixture.evidence.record({
      runId: "run_t4",
      taskId: "R2",
      actor: { role: "worker", id: "worker_R2_1" },
      fact: {
        kind: "browser_screenshot",
        label: "R2 evidence",
        capturedAt: fixture.clock(),
        screenshotArtifactHash: "1".repeat(64),
        mediaType: "image/png",
        byteLength: 1,
      },
      createdAt: fixture.clock(),
      idempotencyKey: "evidence:R2",
      attempt: 1,
    });
    const driver: WorkerRuntimeDriver = {
      run: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            type: "guidance",
            requestId: "guidance-r2",
            blocking: true,
            question: "Which API?",
            evidenceSequence: 1,
          };
        }
        if (calls === 2) {
          return { type: "paused", reason: "worker_pause_for_resume" };
        }
        return {
          type: "submitted",
          changeSetId: `changeset-${calls}`,
          criterionEvidenceLinks: [{
            criterionId: "done",
            evidenceId: evidenceRecord.id,
            artifactHashes: ["1".repeat(64)],
          }],
        };
      },
    };
    const scheduler = schedulerFor(fixture.store, driver);
    await scheduler.tick();
    await scheduler.awaitIdle();
    fixture.store.append({
      runId: "run_t4",
      type: "guidance.answered",
      occurredAt: fixture.clock(),
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "answer:r2",
      payload: {
        requestId: "guidance-r2",
        answer: "Use v2.",
        expectedVersion: 1,
      },
    });
    await scheduler.tick();
    await scheduler.awaitIdle();
    scheduler.pause("worker_pause_for_resume", "pause:r2");
    scheduler.resume("resume:r2");
    await scheduler.tick();
    await scheduler.awaitIdle();
    assert.equal(calls, 3);
    assert.equal(projectionOf(fixture.store, "run_t4").tasks.R2.status, "submitted");
  } finally {
    fixture.close();
  }
});

test("R1-B3 restart counts all four durable in-flight writers and admits no fifth", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-r1-b3-"));
  const database = join(root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  let store = new SqliteSchedulerStore(database, { evidenceStore: evidence });
  try {
    seedReadyPlan(store, buildReadyPlanFixture("run_t4", [
      { id: "C1" }, { id: "C2" }, { id: "C3" }, { id: "C4" },
      { id: "C5" }, { id: "C6" }, { id: "C7" }, { id: "C8" },
    ], { revisionId: "revision_capacity", reviewId: "coverage_capacity" }));
    const firstDriver = new DeferredDriver();
    await schedulerFor(store, firstDriver).tick();
    assert.equal(firstDriver.assignments.length, 4);
    store.close();
    store = new SqliteSchedulerStore(database, { evidenceStore: evidence });
    const recoveredDriver = new DeferredDriver();
    const recoveredScheduler = schedulerFor(store, recoveredDriver);
    await recoveredScheduler.tick();
    assert.deepEqual(recoveredDriver.assignments.sort(), ["C1", "C2", "C3", "C4"]);
    assert.equal(recoveredDriver.assignments.includes("C5"), false);
    for (const taskId of recoveredDriver.assignments) {
      recoveredDriver.resolve(taskId, { type: "failed", reason: "done" });
    }
    await recoveredScheduler.awaitIdle();
  } finally {
    store.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 });
  }
});

test("R1-B4 a released claim admits the next generation and rejected work retries", async () => {
  const fixture = openFixture("repair-b4-released");
  try {
    seedReadyPlan(fixture.store, buildReadyPlanFixture("run_t4", [
      { id: "J1", files: ["src/j1.ts"] },
    ], { revisionId: "revision_b4", reviewId: "coverage_b4" }));
    const first = buildAssignmentClaim({
      packetId: "J1",
      laneId: "lane-b4",
      workerOrSessionId: "worker_J1_1",
      acceptedBaseRevision: "base-1",
      branchOrWorktree: "C:/work/J1-1",
      writableSurfaces: ["src/j1.ts"],
      forbiddenSurfaces: [],
      ownershipGeneration: 1,
    });
    appendEvent(fixture.store, {
      type: "planning.assignment_claimed",
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: "b4:claim-1",
      payload: { claim: first },
    });
    appendEvent(fixture.store, {
      type: "planning.assignment_released",
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: "b4:release-1",
      payload: { claim: releaseAssignmentClaim(first, "released") },
    });
    const second = buildAssignmentClaim({
      packetId: "J1",
      laneId: "lane-b4",
      workerOrSessionId: "worker_J1_2",
      acceptedBaseRevision: "base-2",
      branchOrWorktree: "C:/work/J1-2",
      writableSurfaces: ["src/j1.ts"],
      forbiddenSurfaces: [],
      ownershipGeneration: 2,
    });
    appendEvent(fixture.store, {
      type: "planning.assignment_claimed",
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: "b4:claim-2",
      payload: { claim: second },
    });
    assert.equal(
      projectionOf(fixture.store, "run_t4").planning?.assignments[second.id]?.status,
      "claimed",
    );
  } finally {
    fixture.close();
  }
});

test("R1-B4 scheduler retries a rejected task through a new claim generation", async () => {
  const fixture = openFixture("repair-b4-scheduler");
  try {
    seedReadyPlan(fixture.store, buildReadyPlanFixture("run_t4", [
      { id: "Q1", files: ["src/q1.ts"] },
    ], { revisionId: "revision_b4_scheduler", reviewId: "coverage_b4_scheduler" }));
    const evidence = fixture.evidence.record({
      runId: "run_t4",
      taskId: "Q1",
      actor: { role: "worker", id: "worker_Q1_1" },
      fact: {
        kind: "browser_screenshot",
        label: "Q1 evidence",
        capturedAt: fixture.clock(),
        screenshotArtifactHash: "1".repeat(64),
        mediaType: "image/png",
        byteLength: 1,
      },
      createdAt: fixture.clock(),
      idempotencyKey: "evidence:Q1",
      attempt: 1,
    });
    const driver = new DeferredDriver();
    const scheduler = schedulerFor(fixture.store, driver);
    await scheduler.tick();
    driver.resolve("Q1", {
      type: "submitted",
      changeSetId: "changeset-q1",
      criterionEvidenceLinks: [{
        criterionId: "done",
        evidenceId: evidence.id,
        artifactHashes: ["1".repeat(64)],
      }],
    });
    await scheduler.awaitIdle();
    appendEvent(fixture.store, {
      type: "task.transitioned",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "Q1:review",
      payload: { taskId: "Q1", status: "architect_review", patch: {} },
    });
    appendEvent(fixture.store, {
      type: "task.transitioned",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "Q1:rejected",
      payload: { taskId: "Q1", status: "rejected", patch: {} },
    });
    appendEvent(fixture.store, {
      type: "task.transitioned",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "Q1:retry",
      payload: { taskId: "Q1", status: "planned", patch: {} },
    });
    await scheduler.tick();
    assert.deepEqual(driver.assignments, ["Q1", "Q1"]);
    assert.equal(
      projectionOf(fixture.store, "run_t4").planning?.assignments[
        "t4claim:Q1:gen:2"
      ]?.status,
      "claimed",
    );
    driver.resolve("Q1", { type: "failed", reason: "done" });
    await scheduler.awaitIdle();
  } finally {
    fixture.close();
  }
});

test("R1-B5 post-ready plan events cannot overwrite contract tasks or forge integration", async () => {
  const fixture = openFixture("repair-b5-immutable");
  try {
    seedReadyPlan(fixture.store, buildReadyPlanFixture("run_t4", [
      { id: "D1" }, { id: "D2", dependencies: ["D1"] },
    ], { revisionId: "revision_b5", reviewId: "coverage_b5" }));
    assert.throws(
      () => appendEvent(fixture.store, {
        type: "plan.created",
        actor: { role: "architect", id: "architect_1" },
        idempotencyKey: "b5:reuse",
        payload: {
          revision: 2,
          tasks: [{
            id: "D2",
            objective: "overwrite",
            dependencies: [],
            status: "planned",
            requiredCapabilities: [],
            acceptanceCriteria: [{ id: "x", text: "x" }],
            acceptanceCriteriaVersion: 1,
            attempt: 0,
          }],
        },
      }),
      /reuses a bridged ready-plan contract id/,
    );
    assert.throws(
      () => appendEvent(fixture.store, {
        type: "plan.created",
        actor: { role: "architect", id: "architect_1" },
        idempotencyKey: "b5:integrated",
        payload: {
          revision: 2,
          tasks: [{
            id: "Rogue",
            objective: "forge integration",
            dependencies: [],
            status: "integrated",
            requiredCapabilities: [],
            acceptanceCriteria: [{ id: "x", text: "x" }],
            acceptanceCriteriaVersion: 1,
            attempt: 1,
          }],
        },
      }),
      /cannot set a task to integrated/,
    );
    assert.deepEqual(projectionOf(fixture.store, "run_t4").tasks.D2.dependencies, ["D1"]);
  } finally {
    fixture.close();
  }
});

test("R1-B6 claim conflicts are pure and resolved against the project root", async () => {
  const cwd = process.cwd();
  const root = mkdtempSync(join(tmpdir(), "aiboard-r1-b6-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "existing.ts"), "existing\n");
  try {
    const directory = {
      taskId: "X1",
      files: ["src"],
      resources: [],
      worktree: root,
    };
    const nested = {
      taskId: "X2",
      files: ["src/brand-new.ts"],
      resources: [],
      worktree: "C:/other",
    };
    const conflict = findClaimConflict(
      nested,
      [directory],
      (path) => resolveClaimPathAgainstRoot(path, root),
    );
    assert.equal(conflict?.kind, "file");
    process.chdir(tmpdir());
    assert.equal(
      findClaimConflict(
        { ...nested, files: [normalizeClaimPath("src/brand-new.ts")] },
        [{ ...directory, files: [normalizeClaimPath("src")] }],
      )?.kind,
      "file",
    );
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test("R1-B7 revised ready contracts enforce newly added dependencies", async () => {
  const fixture = openFixture("repair-b7-deps");
  try {
    seedReadyPlan(fixture.store, buildReadyPlanFixture("run_t4", [
      { id: "E1" }, { id: "E2" },
    ], { revisionId: "revision_1", reviewId: "coverage_1" }));
    const current = projectionOf(fixture.store, "run_t4").planning!.plan!;
    const two = buildReadyPlanFixture("run_t4", [
      { id: "E1" }, { id: "E2", dependencies: ["E1"] },
    ], {
      revisionId: "revision_2",
      createdAt: "2026-09-24T00:01:00.000Z",
      reviewId: "coverage_2",
    });
    appendEvent(fixture.store, {
      type: "planning.plan_revised",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "plan:revision_2",
      payload: {
        revision: buildExecutionPlanRevision(two.revision),
        expectedRevisionId: current.currentRevisionId,
        expectedDigest: current.currentDigest,
      },
    });
    seedBoundCoverageAndReady(fixture.store, "run_t4", {
      revision: buildExecutionPlanRevision(two.revision),
      manifest: two.manifest,
      review: two.review,
      hostCapabilities: buildPlanningFixtureScenario().hostCapabilities,
    });
    assert.deepEqual(projectionOf(fixture.store, "run_t4").tasks.E2.dependencies, ["E1"]);
    const driver = new DeferredDriver();
    await schedulerFor(fixture.store, driver).tick();
    assert.deepEqual(driver.assignments, ["E1"]);
  } finally {
    fixture.close();
  }
});

test("R1-N4 lane identity is independent from accountable phase", async () => {
  const fixture = openFixture("repair-n4-lane");
  try {
    seedReadyPlan(fixture.store, buildReadyPlanFixture("run_t4", [
      { id: "L1", files: ["src/l1.ts"] },
    ], { revisionId: "revision_lane", reviewId: "coverage_lane" }));
    const claim = buildAssignmentClaim({
      packetId: "L1",
      laneId: "parallel-lane-A",
      workerOrSessionId: "worker_L1_1",
      acceptedBaseRevision: "base",
      branchOrWorktree: "C:/work/L1",
      writableSurfaces: ["src/l1.ts"],
      forbiddenSurfaces: [],
      ownershipGeneration: 1,
    });
    appendEvent(fixture.store, {
      type: "planning.assignment_claimed",
      actor: { role: "runner", id: "scheduler" },
      idempotencyKey: "lane:claim",
      payload: { claim },
    });
    assert.equal(projectionOf(fixture.store, "run_t4").planning?.assignments[claim.id]?.status, "claimed");
  } finally {
    fixture.close();
  }
});


test("R2-B1 resume ignores its existing slot while new admissions stay bounded", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-r2-b1-"));
  const database = join(root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  let store = new SqliteSchedulerStore(database, { evidenceStore: evidence });
  try {
    seedReadyPlan(store, buildReadyPlanFixture("run_t4", [
      { id: "A1" }, { id: "A2" }, { id: "A3" }, { id: "A4" }, { id: "A5" },
    ], { revisionId: "revision_r2_b1", reviewId: "coverage_r2_b1" }));
    const first = new DeferredDriver();
    const firstScheduler = schedulerFor(store, first, { maxConcurrency: 4 });
    await firstScheduler.tick();
    assert.deepEqual(first.assignments.sort(), ["A1", "A2", "A3", "A4"]);
    store.close();
    store = new SqliteSchedulerStore(database, { evidenceStore: evidence });
    const recovered = new DeferredDriver();
    const recoveredScheduler = schedulerFor(store, recovered, { maxConcurrency: 4 });
    await recoveredScheduler.tick();
    assert.deepEqual(recovered.assignments.sort(), ["A1", "A2", "A3", "A4"]);
    assert.equal(recovered.assignments.includes("A5"), false);
    for (const taskId of recovered.assignments) {
      recovered.resolve(taskId, { type: "failed", reason: "done" });
    }
    await recoveredScheduler.awaitIdle();
  } finally {
    store.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2-B3 reconciliation cannot rewrite bridged contract dependencies", async () => {
  const fixture = openFixture("repair-r2-b3");
  try {
    seedReadyPlan(fixture.store, buildReadyPlanFixture("run_t4", [
      { id: "D1" }, { id: "D2", dependencies: ["D1"] },
    ], { revisionId: "revision_r2_b3", reviewId: "coverage_r2_b3" }));
    assert.throws(
      () => appendEvent(fixture.store, {
        type: "plan.reconciled",
        actor: { role: "architect", id: "architect_1" },
        idempotencyKey: "r2b3:drop",
        payload: {
          revision: 2,
          summary: "Drop D1 dependency.",
          taskUpdates: [{ taskId: "D2", action: "revise", dependencies: [] }],
        },
      }),
      /contract dependencies change only through a new ready plan revision/,
    );
    const driver = new DeferredDriver();
    await schedulerFor(fixture.store, driver).tick();
    assert.deepEqual(driver.assignments, ["D1"]);
  } finally {
    fixture.close();
  }
});

test("R2-B4 guidance revision releases the old claim and re-dispatches a fresh attempt", async () => {
  const fixture = openFixture("repair-r2-b4");
  try {
    seedReadyPlan(fixture.store, buildReadyPlanFixture("run_t4", [
      { id: "W2", files: ["src/w2.ts"] },
    ], { revisionId: "revision_r2_b4", reviewId: "coverage_r2_b4" }));
    const evidenceRecord = fixture.evidence.record({
      runId: "run_t4",
      taskId: "W2",
      actor: { role: "worker", id: "worker_W2_1" },
      fact: {
        kind: "browser_screenshot",
        label: "W2 evidence",
        capturedAt: fixture.clock(),
        screenshotArtifactHash: "1".repeat(64),
        mediaType: "image/png",
        byteLength: 1,
      },
      createdAt: fixture.clock(),
      idempotencyKey: "evidence:W2:1",
      attempt: 1,
    });
    const driver = new DeferredDriver();
    const scheduler = schedulerFor(fixture.store, driver);
    await scheduler.tick();
    driver.resolve("W2", {
      type: "guidance",
      requestId: "guidance-w2",
      blocking: true,
      question: "Use v2?",
      evidenceSequence: projectionOf(fixture.store, "run_t4").lastSequence,
    });
    await scheduler.awaitIdle();
    appendEvent(fixture.store, {
      type: "plan.reconciled",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "r2b4:revise",
      payload: {
        revision: 2,
        summary: "Use API v2.",
        taskUpdates: [{ taskId: "W2", action: "revise", objective: "Use API v2." }],
      },
    });
    await scheduler.tick();
    assert.deepEqual(driver.assignments, ["W2", "W2"]);
    assert.equal(
      projectionOf(fixture.store, "run_t4").planning?.assignments[
        "t4claim:W2:gen:2"
      ]?.status,
      "claimed",
    );
    void evidenceRecord;
    driver.resolve("W2", { type: "failed", reason: "done" });
    await scheduler.awaitIdle();
  } finally {
    fixture.close();
  }
});

test("R2-B5 managed interruption releases claims and allows fenced steering", async () => {
  const fixture = openFixture("repair-r2-b5");
  try {
    seedReadyPlan(fixture.store, buildReadyPlanFixture("run_t4", [
      { id: "S2", files: ["src/s2.ts"] },
    ], { revisionId: "revision_r2_b5", reviewId: "coverage_r2_b5" }));
    let controller = new AbortController();
    const driver = new DeferredDriver();
    const scheduler = schedulerFor(fixture.store, driver, {
      maxConcurrency: 1,
      workspaceFor: async (task) => `C:/work/${task.id}`,
    });
    (scheduler as unknown as { lifecycleSignal?: () => AbortSignal }).lifecycleSignal =
      () => controller.signal;
    await scheduler.tick();
    appendEvent(fixture.store, {
      type: "user.guidance_submitted",
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "r2b5:guidance",
      payload: {
        guidanceId: "guidance-r2b5",
        text: "Use the revised flow.",
        version: 1,
        interruptionProtocolVersion: 1,
      },
    });
    controller.abort();
    driver.resolve("S2", { type: "paused", reason: "aborted" });
    await scheduler.awaitIdle();
    assert.equal(
      projectionOf(fixture.store, "run_t4").planning?.assignments[
        "t4claim:S2:gen:1"
      ]?.status,
      "stopped_fenced",
    );
    appendEvent(fixture.store, {
      type: "user.guidance_interruption_completed",
      actor: { role: "runner", id: "build-manager" },
      idempotencyKey: "r2b5:interruption",
      payload: { guidanceId: "guidance-r2b5", expectedVersion: 1 },
    });
    appendEvent(fixture.store, {
      type: "user.guidance_acknowledged",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "r2b5:steer",
      payload: {
        guidanceId: "guidance-r2b5",
        expectedVersion: 1,
        resolution: {
          type: "plan_reconciled",
          rationale: "Restart active work with revised intent.",
          planReconciliation: {
            revision: 2,
            summary: "Steer S2 to revised flow.",
            taskUpdates: [{ taskId: "S2", action: "revise", objective: "Use revised flow." }],
          },
        },
      },
    });
    controller = new AbortController();
    (scheduler as unknown as { lifecycleSignal?: () => AbortSignal }).lifecycleSignal =
      () => controller.signal;
    await scheduler.tick();
    assert.deepEqual(driver.assignments, ["S2", "S2"]);
    driver.resolve("S2", { type: "failed", reason: "done" });
    await scheduler.awaitIdle();
  } finally {
    fixture.close();
  }
});


test("R2-B1 real pump resumes an in-flight same-owner task without admitting a fifth", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-r2-b1-pump-"));
  const database = join(root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  let store = new SqliteSchedulerStore(database, { evidenceStore: evidence });
  try {
    seedReadyPlan(store, buildReadyPlanFixture("run_t4", [
      { id: "S1" }, { id: "S2" },
    ], { revisionId: "revision_r2_b1_pump", reviewId: "coverage_r2_b1_pump" }));
    const firstDriver = new DeferredDriver();
    const firstScheduler = schedulerFor(store, firstDriver, { maxConcurrency: 1 });
    await firstScheduler.tick();
    assert.deepEqual(firstDriver.assignments, ["S1"]);
    store.close();
    store = new SqliteSchedulerStore(database, { evidenceStore: evidence });
    const recoveredDriver = new DeferredDriver();
    const runtime = new BuildRuntime({
      runId: "run_t4",
      store,
      workerDriver: recoveredDriver,
      architectDriver: {
        run: async () => {
          throw new Error("architect_not_expected");
        },
      },
      integrationDriver: {
        integrate: async () => {
          throw new Error("integration_not_expected");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async (task, attempt) => `C:/work/${task.id}-${attempt}`,
      clock: fixtureClock(),
      finalVerificationProfileFor: async (revision) =>
        emptyFinalVerificationProfile(revision),
    });
    const step = runtime.step();
    await waitFor(() => recoveredDriver.assignments.length === 1, "pump resume");
    assert.deepEqual(recoveredDriver.assignments, ["S1"]);
    recoveredDriver.resolve("S1", { type: "failed", reason: "done" });
    await step;
  } finally {
    store.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2-N2 junction alias overlap skips cleanly without pausing the run", async () => {
  const fixture = openFixture("repair-r2-n2");
  const root = mkdtempSync(join(tmpdir(), "aiboard-r2-n2-"));
  try {
    for (const id of ["J1-1", "J2-1"]) {
      mkdirSync(join(root, id, "src"), { recursive: true });
      symlinkSync(join(root, id, "src"), join(root, id, "srcalias"), "junction");
    }
    seedReadyPlan(fixture.store, buildReadyPlanFixture("run_t4", [
      { id: "J1", files: ["src/x.ts"] },
      { id: "J2", files: ["srcalias/x.ts"] },
    ], { revisionId: "revision_r2_n2", reviewId: "coverage_r2_n2" }));
    const driver = new DeferredDriver();
    const scheduler = schedulerFor(fixture.store, driver, {
      workspaceFor: async (task, attempt) => join(root, `${task.id}-${attempt}`),
    });
    await scheduler.tick();
    assert.deepEqual(driver.assignments, ["J1"]);
    assert.equal(projectionOf(fixture.store, "run_t4").status, "running");
    driver.resolve("J1", { type: "failed", reason: "done" });
    await scheduler.awaitIdle();
  } finally {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("R2-N4 a dependency added to a running task applies only to future attempts", async () => {
  const fixture = openFixture("repair-r2-n4");
  try {
    seedReadyPlan(fixture.store, buildReadyPlanFixture("run_t4", [
      { id: "R1", files: ["src/r1.ts"] },
      { id: "R2", files: ["src/r2.ts"] },
    ], { revisionId: "revision_r2_n4", reviewId: "coverage_r2_n4" }));
    const driver = new DeferredDriver();
    const scheduler = schedulerFor(fixture.store, driver, { maxConcurrency: 1 });
    await scheduler.tick();
    assert.deepEqual(driver.assignments, ["R1"]);
    const current = projectionOf(fixture.store, "run_t4").planning!.plan!;
    const revised = buildReadyPlanFixture("run_t4", [
      { id: "R1", files: ["src/r1.ts"] },
      { id: "R2", files: ["src/r2.ts"], dependencies: ["R1"] },
    ], {
      revisionId: "revision_r2_n4_b",
      createdAt: "2026-09-25T00:01:00.000Z",
      reviewId: "coverage_r2_n4_b",
    });
    appendEvent(fixture.store, {
      type: "planning.plan_revised",
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "r2n4:revised",
      payload: {
        revision: buildExecutionPlanRevision(revised.revision),
        expectedRevisionId: current.currentRevisionId,
        expectedDigest: current.currentDigest,
      },
    });
    seedBoundCoverageAndReady(fixture.store, "run_t4", {
      revision: buildExecutionPlanRevision(revised.revision),
      manifest: revised.manifest,
      review: revised.review,
      hostCapabilities: buildPlanningFixtureScenario().hostCapabilities,
    });
    assert.equal(projectionOf(fixture.store, "run_t4").tasks.R1.status, "running");
    assert.deepEqual(projectionOf(fixture.store, "run_t4").tasks.R1.dependencies, []);
    driver.resolve("R1", { type: "failed", reason: "done" });
    await scheduler.awaitIdle();
  } finally {
    fixture.close();
  }
});

// ---------------------------------------------------------------------------
// Pure unit tests: normalization, resources, capacity, conflicts,
// reconciliation, replan routing, phase-independent eligibility
// ---------------------------------------------------------------------------

test("T4 path normalization is separator, case, dotdot and alias aware", () => {
  assert.equal(
    normalizeClaimPath("runner-v2\\src\\..\\src\\a.ts"),
    "runner-v2/src/a.ts",
  );
  assert.equal(normalizeClaimPath("T4/ALIAS/../alias/./F.ts"), "T4/alias/F.ts");
  assert.equal(normalizeClaimPath("t4/dir/"), "t4/dir");
  assert.equal(claimPathsEqual("t4/Alias/F.ts", "T4\\alias\\f.ts"), true);
  assert.equal(claimPathsEqual("t4/a.ts", "t4/b.ts"), false);
  assert.equal(claimPathContains("t4/alias", "t4/alias/f.ts"), true);
  assert.equal(claimPathContains("t4/alias/f.ts", "t4/alias"), false);
  assert.equal(claimPathContains("t4/alias", "t4/alias"), true);
  assert.equal(claimPathsOverlap("t4/a.ts", "t4"), true);
  assert.equal(claimPathsOverlap("t4/a.ts", "t4/b.ts"), false);

});

test("T4 semantic resources normalize across kinds, aliases and case", () => {
  assert.equal(normalizeResourceClaim("database: Main"), "db:main");
  assert.equal(
    normalizeResourceClaim("port:5432"),
    normalizeResourceClaim("Port: 5432"),
  );
  assert.equal(normalizeResourceClaim("SCHEMA: Public"), "schema:public");
  assert.equal(
    normalizeResourceClaim("config: runner.json"),
    "config:runner.json",
  );
  assert.equal(isSharedSurface("pkg/yarn.lock"), true);
  assert.equal(isSharedSurface("YARN.LOCK"), true);
  assert.equal(isSharedSurface("prisma/migrations/0001/init.sql"), true);
  assert.equal(isSharedSurface("db/migrate/001_add.ts"), true);
  assert.equal(isSharedSurface("t4/a.ts"), false);
});

test("T4 effectiveMaxWorkers bounds new-policy admission at four", () => {
  assert.equal(MAX_WORKERS, 4);
  assert.equal(effectiveMaxWorkers({ configuredMax: 8 }), 8);
  assert.equal(
    effectiveMaxWorkers({ planningPolicyVersion: 1, configuredMax: 8 }),
    4,
  );
  assert.equal(
    effectiveMaxWorkers({ planningPolicyVersion: 1, configuredMax: 2 }),
    2,
  );
  assert.equal(
    effectiveMaxWorkers({
      planningPolicyVersion: 1,
      configuredMax: 8,
      resourceCapacity: 2,
    }),
    2,
  );
  assert.equal(
    effectiveMaxWorkers({
      planningPolicyVersion: 1,
      configuredMax: 8,
      resourceCapacity: 10,
    }),
    4,
  );
  assert.equal(
    effectiveMaxWorkers({
      planningPolicyVersion: 1,
      configuredMax: 8,
      resourceCapacity: 0,
    }),
    0,
  );
  assert.throws(
    () => effectiveMaxWorkers({ configuredMax: 0 }),
    /configuredMax must be a positive integer/,
  );
  assert.throws(
    () =>
      effectiveMaxWorkers({
        planningPolicyVersion: 1,
        configuredMax: 4,
        resourceCapacity: -1,
      }),
    /resourceCapacity must be a non-negative integer/,
  );
});

function writeClaim(
  taskId: string,
  overrides: Partial<TaskWriteClaim> = {},
): TaskWriteClaim {
  return {
    taskId,
    files: ["t4/solo.ts"],
    resources: [],
    worktree: `C:/work/${taskId}`,
    ...overrides,
  };
}

test("T4 claim conflicts cover worktree, files, aliases, shared surfaces and resources", () => {
  const worktree = findClaimConflict(
    writeClaim("b", { worktree: "C:/work/a" }),
    [writeClaim("a", { worktree: "C:/work/a", files: ["other.ts"] })],
  );
  assert.equal(worktree?.kind, "worktree");

  const file = findClaimConflict(writeClaim("b", { files: ["t4/a.ts"] }), [
    writeClaim("a", { files: ["t4"], worktree: "C:/elsewhere" }),
  ]);
  assert.equal(file?.kind, "file");

  const aliased = findClaimConflict(
    writeClaim("b", { files: ["T4\\ALIAS\\..\\alias\\F.ts"] }),
    [writeClaim("a", { files: ["t4/alias/f.ts"], worktree: "C:/elsewhere" })],
  );
  assert.equal(aliased?.kind, "file");

  const shared = findClaimConflict(
    writeClaim("b", { files: ["pkg/yarn.lock"] }),
    [writeClaim("a", { files: ["pkg/yarn.lock"], worktree: "C:/elsewhere" })],
  );
  assert.equal(shared?.kind, "shared_surface");

  const resource = findClaimConflict(
    writeClaim("b", { files: ["t4/b.ts"], resources: ["database:main"] }),
    [
      writeClaim("a", {
        files: ["t4/a.ts"],
        resources: ["db:main"],
        worktree: "C:/elsewhere",
      }),
    ],
  );
  assert.equal(resource?.kind, "resource");

  assert.equal(
    findClaimConflict(writeClaim("b", { files: ["t4/b.ts"] }), [
      writeClaim("a", { files: ["t4/a.ts"], worktree: "C:/elsewhere" }),
    ]),
    undefined,
  );
  assert.equal(
    findClaimConflict(writeClaim("a", { files: ["t4/a.ts"] }), [
      writeClaim("a", { files: ["t4/a.ts"] }),
    ]),
    undefined,
  );
});

test("T4 eligibility comes from dependencies, never phase completion", () => {
  const tasks: BuildTask[] = [
    {
      id: "X",
      objective: "X",
      dependencies: [],
      status: "planned",
      requiredCapabilities: [],
      attempt: 0,
    },
    {
      id: "Y",
      objective: "Y",
      dependencies: [],
      status: "planned",
      requiredCapabilities: [],
      attempt: 0,
    },
  ];
  const mutable: BuildTask[] = tasks.map((task) => ({
    ...task,
    dependencies: [...task.dependencies],
    requiredCapabilities: [...task.requiredCapabilities],
  }));
  // Different phases (carried on the plan contract, not the task) never
  // serialize: two unrelated complete tasks are both ready with no
  // phase-order dependency between them.
  assert.deepEqual(readyTaskIds(mutable).sort(), ["X", "Y"]);
  assert.equal(dependencyBlockReason(mutable, "X"), undefined);
  assert.equal(dependencyBlockReason(mutable, "Y"), undefined);

  const chained: BuildTask[] = mutable.map((task) =>
    task.id === "Y" ? { ...task, dependencies: ["X"] } : task,
  );
  assert.deepEqual(readyTaskIds(chained), ["X"]);
  assert.match(dependencyBlockReason(chained, "Y") ?? "", /waits for dependency X/);
  assert.match(
    dependencyBlockReason(chained, "ZZ") ?? "",
    /depends on missing task|Unknown task/,
  );
  const missing: BuildTask[] = chained.map((task) =>
    task.id === "Y" ? { ...task, dependencies: ["ghost"] } : task,
  );
  assert.match(
    dependencyBlockReason(missing, "Y") ?? "",
    /depends on missing task ghost/,
  );
});
