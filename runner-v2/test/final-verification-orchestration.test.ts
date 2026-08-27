import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallBlock } from "../src/agent-contracts.js";
import {
  BuildRuntime,
  type ArchitectActionRequest,
} from "../src/build-runtime.js";
import { createArchitectTools } from "../src/architect-tools.js";
import { buildArchitectContext } from "../src/agent-prompts.js";
import type { FinalVerificationPlan } from "../src/final-verification-contracts.js";
import {
  rebuildSchedulerProjection,
} from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { TaskScheduler } from "../src/task-scheduler.js";
import { ToolRegistry } from "../src/tool-registry.js";
import {
  acceptFinalVerificationProfile,
  emptyFinalVerificationProfile,
} from "./support/final-verification-profile.js";

const INTEGRATION_REVISION = "integration-revision-one";
const RUN_ID = "run-final-verification-orchestration";

test("terminal implementation work requires a typed final-verification plan", async () => {
  const fixture = createFixture();
  let reason: ArchitectActionRequest["reason"] | undefined;
  let planToolCalls = 0;
  try {
    const runtime = new BuildRuntime({
      runId: RUN_ID,
      store: fixture.store,
      workerDriver: {
        run: async () => ({ type: "failed", reason: "final verification must not use a worker" }),
      },
      architectDriver: {
        run: async (request) => {
          reason = request.reason;
          assert.equal(request.reason.type, "final_verification_plan_required");
          assert.ok(request.reason.integrationRevision);
          assert.equal(
            request.tools.definitions().some((tool) => tool.name === "plan_final_verification"),
            true,
          );
          planToolCalls += 1;
          const result = await request.tools.invoke({
            type: "tool_call",
            callId: "plan-final-verification",
            name: "plan_final_verification",
            arguments: { plan: finalVerificationPlan() },
          }, request.context);
          assert.equal(result.isError, false, result.error?.message ?? "final plan failed");
        },
      },
      integrationDriver: {
        integrate: async () => ({
          status: "integrated" as const,
          integrationRevision: INTEGRATION_REVISION,
        }),
      },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
      finalVerificationProfileFor: async (revision) => emptyFinalVerificationProfile(revision),
    });

    const step = await runtime.step();
    assert.equal(step.status, "progressed");
    assert.equal(step.action, "final_verification_plan_required");
    assert.equal(reason?.type, "final_verification_plan_required");
    assert.equal(planToolCalls, 1);
    const projection = runtime.projection();
    assert.equal(projection.integrationRevision, INTEGRATION_REVISION);
    assert.ok(projection.finalVerification?.current);
    const current = projection.finalVerification.current;
    assert.equal(current.targetRevision, INTEGRATION_REVISION);
    assert.match(current.taskId, /^final-verification-[a-f0-9]{16}$/);
    assert.equal(current.state, "current");
    assert.equal(projection.tasks[current.taskId]?.kind, "final_verification");
    assert.equal(projection.tasks[current.taskId]?.changeSetId, undefined);
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("prose or a no-op Architect response cannot create final verification", async () => {
  const fixture = createFixture();
  try {
    const runtime = new BuildRuntime({
      runId: RUN_ID,
      store: fixture.store,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: {
        integrate: async () => ({
          status: "integrated" as const,
          integrationRevision: INTEGRATION_REVISION,
        }),
      },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
    });

    await assert.rejects(
      () => runtime.step(),
      /final_verification_plan_required.*typed action/i,
    );
    const projection = runtime.projection();
    assert.equal(projection.finalVerification?.current, undefined);
    assert.equal(
      Object.values(projection.tasks).some((task) => task.kind === "final_verification"),
      false,
    );
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("plan_final_verification is idempotent and rejects a conflicting current plan", async () => {
  const fixture = createFixture();
  const tools = new ToolRegistry();
  for (const tool of createArchitectTools({
    store: fixture.store,
    finalVerificationPlanAvailable: true,
    finalVerificationProfileFor: async (revision) => emptyFinalVerificationProfile(revision),
  })) tools.register(tool);
  const context = {
    runId: RUN_ID,
    sessionId: "architect:test",
    actor: { role: "architect" as const, id: "architect-test" },
  };
  try {
    const first = await invokePlan(tools, context, "plan-one", finalVerificationPlan());
    assert.equal(first.isError, false, first.error?.message ?? "first plan failed");
    const semanticallyEquivalent = finalVerificationPlan();
    semanticallyEquivalent.checks.reverse();
    const second = await invokePlan(tools, context, "plan-two", semanticallyEquivalent);
    assert.equal(second.isError, false, second.error?.message ?? "replayed plan failed");
    assert.equal(
      fixture.store.readRun(RUN_ID).filter((event) => event.type === "final_verification.generation_created").length,
      1,
    );
    assert.equal(Object.values(runtimeProjection(fixture.store).tasks).filter((task) => task.kind === "final_verification").length, 1);

    const conflicting = finalVerificationPlan();
    conflicting.checks[0] = {
      ...conflicting.checks[0],
      rationale: "A conflicting plan must not replace the current generation.",
    };
    const result = await invokePlan(tools, context, "plan-conflict", conflicting);
    assert.equal(result.isError, true);
    assert.match(result.error?.message ?? "", /conflict|current|idempotency/i);
    assert.equal(
      fixture.store.readRun(RUN_ID).filter((event) => event.type === "final_verification.generation_created").length,
      1,
    );
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("runner-owned final-verification planning cannot bypass pending user guidance", async () => {
  const fixture = createFixture();
  const tools = new ToolRegistry();
  for (const tool of createArchitectTools({
    store: fixture.store,
    finalVerificationPlanAvailable: true,
    finalVerificationProfileFor: async (revision) => emptyFinalVerificationProfile(revision),
  })) tools.register(tool);
  try {
    fixture.store.append({
      runId: RUN_ID,
      type: "user.guidance_submitted",
      occurredAt: "2026-08-27T00:00:00.000Z",
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "guidance-before-final-plan",
      payload: {
        guidanceId: "guidance-before-final-plan",
        text: "Reconcile this before final verification planning.",
        version: 1,
      },
    });
    const result = await invokePlan(
      tools,
      {
        runId: RUN_ID,
        sessionId: "architect:test",
        actor: { role: "architect", id: "architect-test" },
      },
      "stale-final-plan",
      finalVerificationPlan(),
    );
    assert.equal(result.isError, true);
    assert.match(result.error?.message ?? "", /user guidance/i);
    assert.equal(runtimeProjection(fixture.store).finalVerification?.current, undefined);
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Architect context exposes the canonical revision and verification generation state", () => {
  const fixture = createFixture();
  try {
    const projection = runtimeProjection(fixture.store);
    const context = buildArchitectContext({
      limits: { maxBytes: 64 * 1024, maxEstimatedTokens: 16 * 1024 },
      objective: "Implement and verify the feature.",
      reason: {
        type: "final_verification_plan_required",
        integrationRevision: INTEGRATION_REVISION,
      },
      projection,
      instructions: [],
      skills: [],
      memories: [],
      evidence: [],
      recentHistory: [],
    });
    assert.match(context.text, new RegExp(INTEGRATION_REVISION));
    assert.match(context.text, /"finalVerification"/);
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("a kernel final-verification task is excluded from worker scheduling", async () => {
  const fixture = createFixture();
  let workerCalls = 0;
  const tools = new ToolRegistry();
  for (const tool of createArchitectTools({
    store: fixture.store,
    finalVerificationPlanAvailable: true,
    finalVerificationProfileFor: async (revision) => emptyFinalVerificationProfile(revision),
  })) tools.register(tool);
  try {
    const result = await invokePlan(
      tools,
      {
        runId: RUN_ID,
        sessionId: "architect:test",
        actor: { role: "architect", id: "architect-test" },
      },
      "plan-for-worker-exclusion",
      finalVerificationPlan(),
    );
    assert.equal(result.isError, false, result.error?.message ?? "plan failed");

    const scheduler = new TaskScheduler({
      runId: RUN_ID,
      store: fixture.store,
      driver: {
        run: async () => {
          workerCalls += 1;
          return { type: "failed", reason: "final verification must not use a worker" };
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/never",
    });
    await scheduler.tick();
    await scheduler.awaitIdle();
    assert.equal(workerCalls, 0);
    const finalTasks = Object.values(runtimeProjection(fixture.store).tasks).filter(
      (task) => task.kind === "final_verification",
    );
    assert.equal(finalTasks.length, 1);
    assert.equal(finalTasks[0].status, "planned");
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("guidance cancellation of a rejecting final-check driver does not create a pump error or durable stale check", async () => {
  const fixture = createFixture();
  const tools = new ToolRegistry();
  for (const tool of createArchitectTools({
    store: fixture.store,
    finalVerificationPlanAvailable: true,
    finalVerificationProfileFor: async (revision) => emptyFinalVerificationProfile(revision),
  })) tools.register(tool);
  let checkStarted!: () => void;
  const started = new Promise<void>((resolve) => { checkStarted = resolve; });
  try {
    const planned = await invokePlan(
      tools,
      {
        runId: RUN_ID,
        sessionId: "architect:test",
        actor: { role: "architect", id: "architect-test" },
      },
      "plan-for-steering-cancel",
      finalVerificationPlan(),
    );
    assert.equal(planned.isError, false, planned.error?.message ?? "plan failed");
    const runtime = new BuildRuntime({
      runId: RUN_ID,
      store: fixture.store,
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "unused" }) },
      finalVerificationDriver: {
        executeCheck: async (input) => {
          checkStarted();
          return await new Promise((_, reject) => {
            input.signal?.addEventListener("abort", () => {
              reject(input.signal?.reason ?? new DOMException("cancelled", "AbortError"));
            }, { once: true });
          });
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => "unused",
    });
    const active = runtime.step();
    await started;
    runtime.submitUserGuidance({
      guidanceId: "guidance-final-check",
      text: "Reconcile this before accepting verification output.",
      version: 1,
      idempotencyKey: "guidance:final-check",
    });
    assert.deepEqual(await active, {
      status: "progressed",
      action: "final_verification_interrupted",
    });
    const current = runtime.projection().finalVerification?.current;
    assert.equal(current?.completedChecks?.length ?? 0, 0);
    assert.equal(runtime.projection().status, "running");
  } finally {
    fixture.store.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 final verification orchestration "));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    validateExecutionProfile: acceptFinalVerificationProfile,
  });
  store.append({
    runId: RUN_ID,
    type: "run.initialized",
    occurredAt: "2026-08-26T00:00:00.000Z",
    actor: { role: "runner", id: "runner-test" },
    idempotencyKey: "run-initialized",
    payload: {},
  });
  store.append({
    runId: RUN_ID,
    type: "plan.created",
    occurredAt: "2026-08-26T00:00:01.000Z",
    actor: { role: "architect", id: "architect-test" },
    idempotencyKey: "plan:one",
    payload: {
      revision: 1,
      tasks: [{
        id: "implementation-one",
        objective: "Implement the feature",
        dependencies: [],
        status: "integrated",
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{ id: "implemented", text: "The feature is implemented." }],
        acceptanceCriteriaVersion: 1,
        attempt: 1,
      }],
    },
  });
  store.append({
    runId: RUN_ID,
    type: "integration.revision_advanced",
    occurredAt: "2026-08-26T00:00:02.000Z",
    actor: { role: "runner", id: "integration-manager" },
    idempotencyKey: "integration:revision:one",
    payload: { integrationRevision: INTEGRATION_REVISION },
  });
  return { root, store };
}

async function invokePlan(
  tools: ToolRegistry,
  context: { runId: string; sessionId: string; actor: { role: "architect"; id: string } },
  callId: string,
  plan: FinalVerificationPlan,
) {
  const call: ToolCallBlock = {
    type: "tool_call",
    callId,
    name: "plan_final_verification",
    arguments: { plan },
  };
  return tools.invoke(call, context);
}

function runtimeProjection(store: SqliteSchedulerStore) {
  return rebuildSchedulerProjection(store.readRun(RUN_ID));
}

function finalVerificationPlan(): FinalVerificationPlan {
  return {
    checks: ["build", "tests", "runtime_smoke", "browser"].map((category) => ({
      category: category as FinalVerificationPlan["checks"][number]["category"],
      status: "not_applicable" as const,
      rationale: `No ${category} fixture is configured.`,
      repositoryInspection: {
        paths: ["package.json"],
        summary: `No ${category} fixture is configured.`,
      },
    })),
  };
}
