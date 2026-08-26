import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createArchitectTools } from "../src/architect-tools.js";
import { BuildRuntime } from "../src/build-runtime.js";
import type { BuildControlPlane } from "../src/build-runtime-registry.js";
import type { NativeBuildSpec } from "../src/build-spec.js";
import { ControlServer } from "../src/control-server.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import {
  rebuildSchedulerProjection,
  reduceSchedulerEvent,
  type SchedulerEvent,
  type SchedulerProjection,
} from "../src/scheduler-store.js";
import type { FinalVerificationPlan } from "../src/final-verification-contracts.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { ToolRegistry } from "../src/tool-registry.js";

const RUN_ID = "run-final-verification-completion";
const REVISION = "a".repeat(40);
const OTHER_REVISION = "b".repeat(40);
const GENERATION_ID = "generation-completion";
const FINAL_TASK_ID = "final-verification-completion";
const SUBMISSION_ID = `final-verification-submission:${GENERATION_ID}`;
const REVIEW_ID = `final-verification-review:${GENERATION_ID}`;

test("raw terminal events require the exact current approved verification projection", () => {
  const invalid: Array<[string, (projection: SchedulerProjection) => void]> = [
    ["ordinary task terminal", (projection) => {
      projection.tasks.implementation!.status = "planned";
    }],
    ["canonical integration revision", (projection) => {
      delete projection.integrationRevision;
    }],
    ["current verification generation", (projection) => {
      projection.finalVerification!.history.push({
        ...projection.finalVerification!.current!,
        state: "invalidated",
        invalidatedByRevision: OTHER_REVISION,
      });
      delete projection.finalVerification!.current;
    }],
    ["current verification revision", (projection) => {
      projection.integrationRevision = OTHER_REVISION;
    }],
    ["green complete submission", (projection) => {
      delete projection.finalVerification!.current!.submissionResult;
    }],
    ["all completed categories", (projection) => {
      projection.finalVerification!.current!.completedChecks!.pop();
    }],
    ["required category evidence", (projection) => {
      const current = projection.finalVerification!.current!;
      const planned = current.plan.checks[0]!;
      current.plan.checks[0] = { category: planned.category, status: "required" };
      projection.tasks[FINAL_TASK_ID]!.verificationPlan = current.plan;
      const completed = current.completedChecks![0]!;
      completed.status = "required";
      delete completed.rationale;
      delete completed.repositoryInspection;
      const submitted = current.submissionResult!.checks[0]! as {
        status: "required" | "not_applicable";
        rationale?: string;
        repositoryInspection?: unknown;
      };
      submitted.status = "required";
      delete submitted.rationale;
      delete submitted.repositoryInspection;
      current.submissionResult!.plan = current.plan;
    }],
    ["all submitted categories", (projection) => {
      (projection.finalVerification!.current!.submissionResult!.checks as unknown[]).pop();
    }],
    ["structured approved review", (projection) => {
      delete projection.finalVerification!.current!.review!.decision;
    }],
    ["all approved review categories", (projection) => {
      projection.finalVerification!.current!.review!.decision!.categoryReviews.pop();
    }],
  ];
  for (const [dimension, mutate] of invalid) {
    for (const kind of ["run.completed", "project.handoff_requested", "project.handoff_selected"] as const) {
      const projection = validProjection();
      mutate(projection);
      if (kind === "project.handoff_selected") projection.projectHandoff = requestedHandoff();
      assert.throws(
        () => reduceSchedulerEvent(projection, terminalEvent(projection, kind)),
        /completion|verification|terminal|revision|submission|review|ready/i,
        `${kind} must reject missing ${dimension}`,
      );
    }
  }

  const completed = reduceSchedulerEvent(
    validProjection(),
    terminalEvent(validProjection(), "run.completed"),
  );
  assert.equal(completed.status, "completed");

  const requested = reduceSchedulerEvent(
    validProjection(),
    terminalEvent(validProjection(), "project.handoff_requested"),
  );
  assert.equal(requested.projectHandoff?.status, "requested");
  const selected = reduceSchedulerEvent(
    requested,
    terminalEvent(requested, "project.handoff_selected"),
  );
  assert.equal(selected.status, "completed");
  assert.equal(selected.projectHandoff?.status, "selected");
});

test("SQLite append and replay fail closed on forged completion", () => {
  const fixture = createStoreFixture(false);
  try {
    assert.throws(
      () => appendTerminal(fixture.store, "run.completed", "forged-append"),
      /completion|verification|ready/i,
    );
    fixture.store.close();
    const database = new DatabaseSync(fixture.database);
    try {
      database.prepare(`INSERT INTO scheduler_events (
        event_id, run_id, sequence, event_type, occurred_at,
        actor_json, idempotency_key, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          "forged-completion",
          RUN_ID,
          4,
          "run.completed",
          "2026-08-26T00:00:04.000Z",
          JSON.stringify({ role: "architect", id: "architect" }),
          "forged-replay",
          JSON.stringify({}),
        );
    } finally {
      database.close();
    }
    fixture.store = new SqliteSchedulerStore(fixture.database, {
      evidenceStore: fixture.evidence,
    });
    assert.throws(() => fixture.store.readRun(RUN_ID), /completion|verification|ready/i);
  } finally {
    fixture.close();
  }
});

test("complete_run rejects early and an approved current generation requests one handoff", async () => {
  const early = createStoreFixture(false);
  try {
    const result = await invokeComplete(early.store, early.evidence, "early-complete");
    assert.equal(result.isError, true);
    assert.equal(result.error?.code, "completion_not_ready");
    assert.match(result.error?.message ?? "", /completion|verification|ready/i);
    assert.equal(rebuildSchedulerProjection(early.store.readRun(RUN_ID)).projectHandoff, undefined);
  } finally {
    early.close();
  }

  const ready = createStoreFixture(true);
  try {
    const runtime = new BuildRuntime({
      runId: RUN_ID,
      store: ready.store,
      evidenceStore: ready.evidence,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: {
        run: async (request) => {
          assert.equal(request.reason.type, "completion_decision_required");
          const result = await request.tools.invoke({
            type: "tool_call",
            callId: "approved-complete",
            name: "complete_run",
            arguments: { summary: "Current verification is approved." },
          }, request.context);
          assert.equal(result.isError, false, result.error?.message ?? "completion failed");
        },
      },
      integrationDriver: {
        integrate: async () => ({ status: "integrated", integrationRevision: REVISION }),
      },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
    });
    const result = await runtime.step();
    assert.equal(result.status, "paused");
    assert.equal(result.action, "completion_decision_required");
    assert.equal(runtime.projection().projectHandoff?.status, "requested");
    assert.equal(runtime.events().filter(
      (event) => event.type === "project.handoff_requested",
    ).length, 1);
  } finally {
    ready.close();
  }
});

test("integration advancement after approval blocks tool, request, selection, and completion", async () => {
  const stale = createStoreFixture(true);
  try {
    appendTerminal(stale.store, "project.handoff_requested", "request-before-stale");
    stale.store.append({
      runId: RUN_ID,
      type: "integration.revision_advanced",
      occurredAt: "2026-08-26T00:00:05.000Z",
      actor: { role: "runner", id: "integration" },
      idempotencyKey: "revision-advanced-after-approval",
      payload: { integrationRevision: OTHER_REVISION, previousIntegrationRevision: REVISION },
    });
    const runtime = new BuildRuntime({
      runId: RUN_ID,
      store: stale.store,
      evidenceStore: stale.evidence,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: {
        integrate: async () => ({ status: "integrated", integrationRevision: OTHER_REVISION }),
      },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
    });
    assert.throws(
      () => runtime.selectProjectHandoff(
        "keep_integration_branch",
        {
          integrationRevision: OTHER_REVISION,
          integrationBranch: "aiboard/run/integration",
          appliedToProject: false,
        },
        "stale-selection",
      ),
      /completion|verification|current|ready/i,
    );
    assert.throws(
      () => appendTerminal(stale.store, "run.completed", "stale-completion"),
      /completion|verification|current|ready/i,
    );
    const toolResult = await invokeComplete(stale.store, stale.evidence, "stale-tool");
    assert.equal(toolResult.isError, true);
    assert.notEqual(rebuildSchedulerProjection(stale.store.readRun(RUN_ID)).status, "completed");
  } finally {
    stale.close();
  }
});

test("control lifecycle ignores a forged completed result from an unready Build projection", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 completion control "));
  const supervisor = new RunSupervisor(new SqliteEventStore(join(root, "runs.sqlite")));
  const token = "completion-control-token";
  const projection = validProjection();
  delete projection.finalVerification!.current;
  const builds = {
    projection: () => projection,
    step: async () => ({ status: "completed" as const, action: "forged-completion" }),
  } as unknown as BuildControlPlane;
  const server = new ControlServer({
    supervisor,
    builds,
    token,
    checkGit: async () => ({
      available: true,
      version: "2.51.0",
      code: "git_ready",
      reason: null,
    }),
    bootstrapRun: async () => ({ baselineRevision: REVISION, baselineRef: "refs/heads/main" }),
  });
  try {
    supervisor.createRun({
      runId: RUN_ID,
      projectPath: "C:/project",
      permissionProfile: "full",
      idempotencyKey: "create",
    });
    supervisor.captureBaseline(RUN_ID, "baseline", REVISION, "refs/heads/main");
    supervisor.start(RUN_ID, "start");
    const { url } = await server.start(0);
    const response = await fetch(`${url}/v2/runs/${RUN_ID}/build/step`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { status: string }).status, "completed");
    assert.equal(supervisor.getRun(RUN_ID).state, "running");
  } finally {
    await server.close();
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("RunSupervisor completes a Build run only from an authoritative ready projection", () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 completion supervisor "));
  const supervisor = new RunSupervisor(new SqliteEventStore(join(root, "runs.sqlite")));
  try {
    supervisor.createRun({
      runId: RUN_ID,
      projectPath: "C:/project",
      permissionProfile: "full",
      idempotencyKey: "create",
    });
    supervisor.captureBaseline(RUN_ID, "baseline", REVISION, "refs/heads/main");
    supervisor.start(RUN_ID, "start");
    const forged = validProjection();
    forged.status = "completed";
    delete forged.finalVerification!.current;
    assert.equal(
      supervisor.completeBuild(RUN_ID, "forged-build-complete", forged).state,
      "running",
    );
    const ready = validProjection();
    ready.status = "completed";
    assert.equal(
      supervisor.completeBuild(RUN_ID, "verified-build-complete", ready).state,
      "completed",
    );
  } finally {
    supervisor.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("native handoff selection checks readiness before applying the project handoff", async () => {
  const fixture = createStoreFixture(true);
  const managerRoot = mkdtempSync(join(tmpdir(), "runner-v2 completion manager "));
  let physicalHandoffs = 0;
  const runtime = new BuildRuntime({
    runId: RUN_ID,
    store: fixture.store,
    evidenceStore: fixture.evidence,
    workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
    architectDriver: { run: async () => undefined },
    integrationDriver: {
      integrate: async () => ({ status: "integrated", integrationRevision: OTHER_REVISION }),
    },
    maxConcurrency: 1,
    workspaceFor: async () => "C:/unused",
  });
  const manager = new NativeBuildManager({
    specs: new SqliteBuildSpecStore(join(managerRoot, "builds.sqlite")),
    createRuntime: async () => ({
      runtime,
      projectHandoff: async () => {
        physicalHandoffs += 1;
        return {
          integrationRevision: OTHER_REVISION,
          integrationBranch: "aiboard/run/integration",
          appliedToProject: false,
        };
      },
      close: () => undefined,
    } as never),
  });
  try {
    appendTerminal(fixture.store, "project.handoff_requested", "request-before-manager-stale");
    fixture.store.append({
      runId: RUN_ID,
      type: "integration.revision_advanced",
      occurredAt: "2026-08-26T00:00:13.000Z",
      actor: { role: "runner", id: "integration" },
      idempotencyKey: "manager-stale-revision",
      payload: { integrationRevision: OTHER_REVISION, previousIntegrationRevision: REVISION },
    });
    await manager.create(nativeSpec());
    await assert.rejects(
      manager.selectProjectHandoff(RUN_ID, "apply_to_project", "manager-stale-selection"),
      /completion|verification|current|ready/i,
    );
    assert.equal(physicalHandoffs, 0);
  } finally {
    await manager.close();
    fixture.close();
    rmSync(managerRoot, { recursive: true, force: true });
  }
});

function validProjection(): SchedulerProjection {
  const plan = finalPlan();
  const completedChecks = plan.checks.map((check) => ({
    ...check,
    green: true,
    evidenceIds: [],
    facts: [],
    issues: [],
    attempt: 1,
    workspacePath: "C:/verification",
    startedAt: "2026-08-26T00:00:00.000Z",
    finishedAt: "2026-08-26T00:00:01.000Z",
  }));
  const submissionChecks = plan.checks.map((check) => ({
    ...check,
    green: true as const,
    evidenceIds: [],
    facts: [],
  }));
  return {
    runId: RUN_ID,
    runPolicy: "finish",
    status: "running",
    acceptanceContractStatus: "current",
    planRevision: 1,
    tasks: {
      implementation: {
        id: "implementation",
        objective: "Implement the requested behavior.",
        dependencies: [],
        status: "integrated",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "done", text: "The behavior is implemented." }],
        acceptanceCriteriaVersion: 1,
        attempt: 1,
      },
      [FINAL_TASK_ID]: {
        id: FINAL_TASK_ID,
        kind: "final_verification",
        objective: "Verify the canonical integrated revision.",
        dependencies: [],
        status: "planned",
        requiredCapabilities: ["verification"],
        attempt: 0,
        generationId: GENERATION_ID,
        targetRevision: REVISION,
        planVersion: 1,
        verificationPlan: plan,
        verificationSubmissionId: SUBMISSION_ID,
        verificationReviewId: REVIEW_ID,
      },
    },
    guidance: {},
    reviews: {},
    runtime: { providerHealth: {}, workerAssignments: {}, architect: {} },
    integrationRevision: REVISION,
    finalVerification: {
      current: {
        taskId: FINAL_TASK_ID,
        generationId: GENERATION_ID,
        targetRevision: REVISION,
        planVersion: 1,
        plan,
        state: "current",
        completedChecks,
        submission: {
          submissionId: SUBMISSION_ID,
          generationId: GENERATION_ID,
          targetRevision: REVISION,
          attempt: 1,
        },
        submissionResult: {
          kind: "final_verification_submission",
          generationId: GENERATION_ID,
          runId: RUN_ID,
          taskId: FINAL_TASK_ID,
          attempt: 1,
          targetRevision: REVISION,
          plan,
          checks: submissionChecks,
          evidenceIds: [],
          submittedAt: "2026-08-26T00:00:02.000Z",
          green: true,
        },
        review: {
          reviewId: REVIEW_ID,
          submissionId: SUBMISSION_ID,
          generationId: GENERATION_ID,
          targetRevision: REVISION,
          attempt: 1,
          status: "approved",
          decision: {
            decision: "approved",
            summary: "Every persisted category supports completion.",
            targetRevision: REVISION,
            categoryReviews: plan.checks.map((check) => ({
              category: check.category,
              verdict: "approved" as const,
              rationale: `The ${check.category} inspection supports approval.`,
              evidenceIds: [],
            })),
            failedCategories: [],
          },
        },
      },
      history: [],
    },
    lastSequence: 20,
  };
}

function terminalEvent(
  projection: SchedulerProjection,
  type: "run.completed" | "project.handoff_requested" | "project.handoff_selected",
): SchedulerEvent {
  return {
    eventId: `event-${type}`,
    runId: RUN_ID,
    sequence: projection.lastSequence + 1,
    type,
    occurredAt: "2026-08-26T00:00:03.000Z",
    actor: type === "project.handoff_selected"
      ? { role: "user", id: "local-user" }
      : { role: "architect", id: "architect" },
    idempotencyKey: `terminal-${type}`,
    payload: type === "project.handoff_requested"
      ? { summary: "The verified build is ready for user choice." }
      : type === "project.handoff_selected"
        ? {
            choice: "keep_integration_branch",
            integrationRevision: REVISION,
            integrationBranch: "aiboard/run/integration",
            appliedToProject: false,
          }
        : {},
  };
}

function requestedHandoff() {
  return {
    status: "requested" as const,
    summary: "The verified build is ready for user choice.",
    options: ["keep_integration_branch", "apply_to_project"] as Array<
      "keep_integration_branch" | "apply_to_project"
    >,
  };
}

function finalPlan(): FinalVerificationPlan {
  return {
    checks: (["build", "tests", "runtime_smoke", "browser"] as const).map((category) => ({
      category,
      status: "not_applicable" as const,
      rationale: `No ${category} fixture exists.`,
      repositoryInspection: {
        paths: ["package.json"],
        summary: `The repository has no ${category} entry point.`,
      },
    })),
  };
}

interface StoreFixture {
  root: string;
  database: string;
  evidence: SqliteEvidenceStore;
  store: SqliteSchedulerStore;
  close(): void;
}

function createStoreFixture(ready: boolean): StoreFixture {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 completion gate "));
  const database = join(root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const fixture: StoreFixture = {
    root,
    database,
    evidence,
    store: new SqliteSchedulerStore(database, { evidenceStore: evidence }),
    close() {
      this.store.close();
      this.evidence.close();
      rmSync(this.root, { recursive: true, force: true });
    },
  };
  const plan = finalPlan();
  fixture.store.append({
    runId: RUN_ID,
    type: "run.policy_configured",
    occurredAt: "2026-08-26T00:00:00.000Z",
    actor: { role: "runner", id: "runtime" },
    idempotencyKey: "policy",
    payload: { runPolicy: "finish" },
  });
  fixture.store.append({
    runId: RUN_ID,
    type: "plan.created",
    occurredAt: "2026-08-26T00:00:01.000Z",
    actor: { role: "architect", id: "architect" },
    idempotencyKey: "plan",
    payload: {
      revision: 1,
      tasks: [validProjection().tasks.implementation],
    },
  });
  fixture.store.append({
    runId: RUN_ID,
    type: "integration.revision_advanced",
    occurredAt: "2026-08-26T00:00:02.000Z",
    actor: { role: "runner", id: "integration" },
    idempotencyKey: "integration-revision",
    payload: { integrationRevision: REVISION },
  });
  if (!ready) return fixture;
  fixture.store.append({
    runId: RUN_ID,
    type: "final_verification.generation_created",
    occurredAt: "2026-08-26T00:00:03.000Z",
    actor: { role: "runner", id: "runtime" },
    idempotencyKey: "generation",
    payload: {
      taskId: FINAL_TASK_ID,
      generationId: GENERATION_ID,
      targetRevision: REVISION,
      planVersion: 1,
      plan,
    },
  });
  for (const [index, check] of plan.checks.entries()) {
    fixture.store.append({
      runId: RUN_ID,
      type: "final_verification.check_completed",
      occurredAt: `2026-08-26T00:00:0${index + 4}.000Z`,
      actor: { role: "runner", id: "runtime" },
      idempotencyKey: `check:${check.category}`,
      payload: {
        taskId: FINAL_TASK_ID,
        generationId: GENERATION_ID,
        targetRevision: REVISION,
        attempt: 1,
        workspacePath: "C:/verification",
        startedAt: "2026-08-26T00:00:04.000Z",
        finishedAt: "2026-08-26T00:00:05.000Z",
        result: { ...check, green: true, evidenceIds: [], facts: [], issues: [] },
      },
    });
  }
  const submissionResult = validProjection().finalVerification!.current!.submissionResult!;
  fixture.store.append({
    runId: RUN_ID,
    type: "final_verification.submitted",
    occurredAt: "2026-08-26T00:00:09.000Z",
    actor: { role: "runner", id: "runtime" },
    idempotencyKey: "submission",
    payload: {
      taskId: FINAL_TASK_ID,
      generationId: GENERATION_ID,
      targetRevision: REVISION,
      submissionId: SUBMISSION_ID,
      attempt: 1,
      submissionResult,
    },
  });
  fixture.store.append({
    runId: RUN_ID,
    type: "final_verification.review_requested",
    occurredAt: "2026-08-26T00:00:10.000Z",
    actor: { role: "runner", id: "runtime" },
    idempotencyKey: "review-request",
    payload: {
      taskId: FINAL_TASK_ID,
      generationId: GENERATION_ID,
      targetRevision: REVISION,
      submissionId: SUBMISSION_ID,
      reviewId: REVIEW_ID,
      attempt: 1,
    },
  });
  fixture.store.append({
    runId: RUN_ID,
    type: "final_verification.review_decided",
    occurredAt: "2026-08-26T00:00:11.000Z",
    actor: { role: "architect", id: "architect" },
    idempotencyKey: "review-decision",
    payload: {
      taskId: FINAL_TASK_ID,
      generationId: GENERATION_ID,
      targetRevision: REVISION,
      submissionId: SUBMISSION_ID,
      reviewId: REVIEW_ID,
      attempt: 1,
      decision: "approved",
      summary: "Every persisted category supports completion.",
      categoryReviews: plan.checks.map((check) => ({
        category: check.category,
        verdict: "approved",
        rationale: `The ${check.category} inspection supports approval.`,
        evidenceIds: [],
      })),
    },
  });
  return fixture;
}

async function invokeComplete(
  store: SqliteSchedulerStore,
  evidenceStore: SqliteEvidenceStore,
  callId: string,
) {
  const tools = new ToolRegistry();
  for (const tool of createArchitectTools({
    store,
    evidenceStore,
    runPolicy: "finish",
  })) tools.register(tool);
  return await tools.invoke({
    type: "tool_call",
    callId,
    name: "complete_run",
    arguments: { summary: "The build is complete." },
  }, {
    runId: RUN_ID,
    sessionId: "architect:completion",
    actor: { role: "architect", id: "architect" },
  });
}

function appendTerminal(
  store: SqliteSchedulerStore,
  type: "run.completed" | "project.handoff_requested" | "project.handoff_selected",
  idempotencyKey: string,
): void {
  store.append({
    runId: RUN_ID,
    type,
    occurredAt: "2026-08-26T00:00:12.000Z",
    actor: type === "project.handoff_selected"
      ? { role: "user", id: "local-user" }
      : { role: "architect", id: "architect" },
    idempotencyKey,
    payload: type === "project.handoff_requested"
      ? { summary: "The verified build is ready for user choice." }
      : type === "project.handoff_selected"
        ? {
            choice: "keep_integration_branch",
            integrationRevision: REVISION,
            integrationBranch: "aiboard/run/integration",
            appliedToProject: false,
          }
        : {},
  });
}

function nativeSpec(): NativeBuildSpec {
  return {
    version: 1,
    runId: RUN_ID,
    projectId: "project-completion",
    objective: "Prove the final completion gate.",
    architectRuntimeId: "chatgpt:gpt-5.5",
    workerRuntimeIds: ["chatgpt:gpt-5.4"],
    maxConcurrency: 1,
    permissionProfile: "full",
    runPolicy: "finish",
    budgetLimits: {},
    createdAt: "2026-08-26T00:00:00.000Z",
    idempotencyKey: "completion-build-spec",
  };
}
