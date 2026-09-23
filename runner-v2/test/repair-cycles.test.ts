import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assessBuildRisk } from "../src/risk-policy.js";
import {
  consumeRepairCycle,
  DEFAULT_REPAIR_PLAN_LIMIT,
  rebuildSchedulerProjection,
  repairCyclesExhausted,
} from "../src/scheduler-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { emptyProjectionForTest } from "./support/projection-fixtures.js";
import { acceptFinalVerificationProfile } from "./support/final-verification-profile.js";
import {
  appendVerifierRequest,
  createFixture,
  createRuntime,
  event,
  FINAL_TASK_ID,
  GENERATION_ID,
  REVIEW_ID,
  REVISION,
  RUN_ID,
} from "./support/verifier-run-fixture.js";

test("consumeRepairCycle counts repair plans and blocks at the limit", () => {
  const projection = {
    ...emptyProjectionForTest(RUN_ID),
    repairCycles: { limit: 1, used: 0, extensions: 0 },
  };
  consumeRepairCycle(projection);
  assert.deepEqual(projection.repairCycles, { limit: 1, used: 1, extensions: 0 });
  assert.equal(repairCyclesExhausted(projection), true);
  assert.throws(
    () => consumeRepairCycle(projection),
    /Repair plan limit reached: 1 of 1 repair plans used; the user must extend the repair-cycle budget/,
  );
  const legacy = emptyProjectionForTest(RUN_ID);
  consumeRepairCycle(legacy);
  assert.equal(legacy.repairCycles, undefined, "runs without a policy stay uncapped");
  assert.equal(repairCyclesExhausted(legacy), false);
});

test("repair policy is runner-only, idempotent, and conflict-checked", () => {
  const fixture = createFixture("repair-policy");
  try {
    assert.throws(() => fixture.store.append(event("repair.policy_configured", "repair-policy:user", {
      repairPlanLimit: 2,
    }, { role: "user", id: "local-user" })), /Only the runner may configure repair policy/);
    fixture.store.append(event("repair.policy_configured", "repair-policy", { repairPlanLimit: 2 }));
    fixture.store.append(event("repair.policy_configured", "repair-policy", { repairPlanLimit: 2 }));
    assert.throws(() => fixture.store.append(event("repair.policy_configured", "repair-policy:again", {
      repairPlanLimit: 5,
    })), /Repair policy is already configured differently/);
    const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.deepEqual(projection.repairCycles, { limit: 2, used: 0, extensions: 0 });
    assert.equal(DEFAULT_REPAIR_PLAN_LIMIT, 3);
  } finally {
    fixture.close();
  }
});

test("a verifier repair plan consumes a cycle and the limit pauses only for the user to extend", () => {
  const fixture = createFixture("verifier-repair-cycle");
  try {
    fixture.store.append(event("repair.policy_configured", "repair-policy", { repairPlanLimit: 1 }));
    appendUnsatisfiedVerifierVerdict(fixture);
    fixture.store.append(event("verifier.repairs_planned", "verifier-repairs:1", {
      reviewId: REVIEW_ID,
      targetRevision: REVISION,
      revision: rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).planRevision + 1,
      tasks: [verifierRepairTask(fixture.evidenceIds[2]!)],
    }, { role: "architect", id: "openai:architect" }));
    let projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.repairCycles?.used, 1);
    assert.equal(repairCyclesExhausted(projection), true);
    assert.deepEqual(projection.verifier?.current?.repairTaskIds, ["repair-ui"]);

    assert.throws(() => fixture.store.append(event("repair.cycle_limit_reached", "limit:early", {
      source: "verifier", targetRevision: REVISION, used: 0, limit: 1,
    })), /does not match the kernel repair-cycle count/);
    fixture.store.append(event("repair.cycle_limit_reached", "limit:1", {
      source: "verifier", targetRevision: REVISION, used: 1, limit: 1,
    }));
    projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.status, "paused");
    assert.deepEqual(projection.pauseReason, { reason: "repair_cycle_limit" });
    assert.deepEqual(projection.repairCycles?.pause, {
      source: "verifier", targetRevision: REVISION, used: 1, limit: 1,
    });

    assert.throws(() => fixture.store.append(event("repair.cycle_limit_extended", "extend:runner", {
      additionalRepairPlans: 1,
    })), /Repair-cycle extension requires the user/);
    assert.throws(() => fixture.store.append(event("repair.cycle_limit_extended", "extend:zero", {
      additionalRepairPlans: 0,
    }, { role: "user", id: "local-user" })), /additionalRepairPlans must be an integer between 1 and 10/);
    assert.throws(() => fixture.store.append(event("repair.cycle_limit_extended", "extend:eleven", {
      additionalRepairPlans: 11,
    }, { role: "user", id: "local-user" })), /additionalRepairPlans must be an integer between 1 and 10/);
    fixture.store.append(event("repair.cycle_limit_extended", "extend:1", {
      additionalRepairPlans: 2,
    }, { role: "user", id: "local-user" }));
    projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.status, "running");
    assert.equal(projection.pauseReason, undefined);
    assert.deepEqual(projection.repairCycles, { limit: 3, used: 1, extensions: 1 });
    assert.equal(repairCyclesExhausted(projection), false);
  } finally {
    fixture.close();
  }
});

test("a final-verification repair plan consumes a cycle through its creator", () => {
  const fixture = createFixture("fv-repair-cycle", { approveFinalReview: false });
  try {
    fixture.store.append(event("repair.policy_configured", "repair-policy", { repairPlanLimit: 1 }));
    appendFinalVerificationRepairRequired(fixture.store);
    fixture.store.append(event("final_verification.repairs_planned", "fv-repairs:1", {
      ...finalVerificationRepairPayload(fixture),
      revision: rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).planRevision + 1,
    }, { role: "architect", id: "openai:architect" }));
    const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.repairCycles?.used, 1);
    assert.equal(repairCyclesExhausted(projection), true);
    assert.ok(projection.finalVerification?.current?.repairTaskIds?.includes("repair-tests"));
  } finally {
    fixture.close();
  }
});

test("a matching repair-cycle pause is rejected while budget remains", () => {
  const fixture = createFixture("forged-pause-under-budget");
  try {
    fixture.store.append(event("repair.policy_configured", "repair-policy", { repairPlanLimit: 3 }));
    assert.throws(() => fixture.store.append(event("repair.cycle_limit_reached", "limit:forged", {
      source: "verifier", targetRevision: REVISION, used: 0, limit: 3,
    })), /Repair-cycle limit event does not match the kernel repair-cycle count/);
    const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.notEqual(projection.status, "paused");
    assert.equal(projection.pauseReason, undefined);
    assert.equal(projection.repairCycles?.pause, undefined);
    assert.deepEqual(projection.repairCycles, { limit: 3, used: 0, extensions: 0 });
  } finally {
    fixture.close();
  }
});

test("a verifier repair below the limit increments used and does not pause", () => {
  const fixture = createFixture("verifier-repair-under-limit");
  try {
    fixture.store.append(event("repair.policy_configured", "repair-policy", { repairPlanLimit: 2 }));
    appendUnsatisfiedVerifierVerdict(fixture);
    fixture.store.append(event("verifier.repairs_planned", "verifier-repairs:under", {
      reviewId: REVIEW_ID,
      targetRevision: REVISION,
      revision: rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).planRevision + 1,
      tasks: [verifierRepairTask(fixture.evidenceIds[2]!)],
    }, { role: "architect", id: "openai:architect" }));
    const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.repairCycles?.used, 1);
    assert.equal(repairCyclesExhausted(projection), false);
    assert.equal(projection.status, "running");
    assert.equal(projection.repairCycles?.pause, undefined);
  } finally {
    fixture.close();
  }
});

test("a rejected verifier repair plan mutates nothing including the cycle count", () => {
  const fixture = createFixture("verifier-repair-rejected");
  try {
    fixture.store.append(event("repair.policy_configured", "repair-policy", { repairPlanLimit: 3 }));
    appendUnsatisfiedVerifierVerdict(fixture);
    assert.throws(() => fixture.store.append(event("verifier.repairs_planned", "verifier-repairs:invalid", {
      reviewId: REVIEW_ID,
      targetRevision: REVISION,
      revision: rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).planRevision + 1,
      tasks: [{
        ...verifierRepairTask(fixture.evidenceIds[0]!),
        criteria: [{ taskId: "task-api", criterionId: "typed" }],
      }],
    }, { role: "architect", id: "openai:architect" })), /satisfied|unknown|duplicated/i);
    const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.repairCycles?.used, 0);
    assert.equal(projection.verifier?.current?.repairTaskIds, undefined);
  } finally {
    fixture.close();
  }
});

test("a second verifier repair is refused once the kernel count is exhausted", () => {
  const fixture = createFixture("verifier-repair-exhausted-creator");
  try {
    fixture.store.append(event("repair.policy_configured", "repair-policy", { repairPlanLimit: 0 }));
    appendUnsatisfiedVerifierVerdict(fixture);
    assert.throws(() => fixture.store.append(event("verifier.repairs_planned", "verifier-repairs:capped", {
      reviewId: REVIEW_ID,
      targetRevision: REVISION,
      revision: rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).planRevision + 1,
      tasks: [verifierRepairTask(fixture.evidenceIds[2]!)],
    }, { role: "architect", id: "openai:architect" })), /Repair plan limit reached: 0 of 0 repair plans used/);
    const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.repairCycles?.used, 0);
    assert.equal(projection.verifier?.current?.repairTaskIds, undefined);
  } finally {
    fixture.close();
  }
});

test("a second final-verification repair is refused once the kernel count is exhausted", () => {
  const fixture = createFixture("fv-repair-exhausted-creator", { approveFinalReview: false });
  try {
    fixture.store.append(event("repair.policy_configured", "repair-policy", { repairPlanLimit: 0 }));
    appendFinalVerificationRepairRequired(fixture.store);
    assert.throws(() => fixture.store.append(event("final_verification.repairs_planned", "fv-repairs:capped", {
      ...finalVerificationRepairPayload(fixture),
      revision: rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).planRevision + 1,
    }, { role: "architect", id: "openai:architect" })), /Repair plan limit reached: 0 of 0 repair plans used/);
    const projection = rebuildSchedulerProjection(fixture.store.readRun(RUN_ID));
    assert.equal(projection.repairCycles?.used, 0);
    assert.equal(projection.finalVerification?.current?.repairTaskIds, undefined);
  } finally {
    fixture.close();
  }
});

test("repair-cycle pause survives store close and projection rebuild", () => {
  const fixture = createFixture("repair-cycle-replay");
  try {
    fixture.store.append(event("repair.policy_configured", "repair-policy", { repairPlanLimit: 1 }));
    appendUnsatisfiedVerifierVerdict(fixture);
    fixture.store.append(event("verifier.repairs_planned", "verifier-repairs:replay", {
      reviewId: REVIEW_ID,
      targetRevision: REVISION,
      revision: rebuildSchedulerProjection(fixture.store.readRun(RUN_ID)).planRevision + 1,
      tasks: [verifierRepairTask(fixture.evidenceIds[2]!)],
    }, { role: "architect", id: "openai:architect" }));
    fixture.store.append(event("repair.cycle_limit_reached", "limit:replay", {
      source: "verifier", targetRevision: REVISION, used: 1, limit: 1,
    }));
    fixture.store.close();
    const recovered = new SqliteSchedulerStore(fixture.database, {
      evidenceStore: fixture.evidenceStore,
      validateCleanupReceipt: () => undefined,
      validateExecutionProfile: acceptFinalVerificationProfile,
    });
    try {
      const projection = rebuildSchedulerProjection(recovered.readRun(RUN_ID));
      assert.equal(projection.status, "paused");
      assert.deepEqual(projection.pauseReason, { reason: "repair_cycle_limit" });
      assert.deepEqual(projection.repairCycles, {
        limit: 1,
        used: 1,
        extensions: 0,
        pause: { source: "verifier", targetRevision: REVISION, used: 1, limit: 1 },
      });
    } finally {
      recovered.close();
    }
  } finally {
    fixture.close();
  }
});

test("the runtime pauses at the repair limit instead of asking the Architect, and resumes after a user extension", async () => {
  const fixture = createFixture("runtime-verifier-limit");
  try {
    appendHighRiskAssessment(fixture.store);
    appendUnsatisfiedVerifierVerdict(fixture);
    fixture.store.append(event("repair.policy_configured", "repair-policy", { repairPlanLimit: 0 }));
    let architectCalls = 0;
    const runtime = createRuntime(
      fixture.store,
      {
        candidateRuntimeIds: ["google:verifier"],
        assessRisk: async () => { throw new Error("risk already assessed"); },
        verify: async () => ({ status: "verdict_submitted" }),
      },
      async (request) => {
        architectCalls += 1;
        assert.equal(request.reason.type, "verifier_repair_plan_required");
        if (request.reason.type !== "verifier_repair_plan_required") return;
        const result = await request.tools.invoke({
          type: "tool_call",
          callId: "plan-verifier-repair",
          name: "plan_verifier_repairs",
          arguments: {
            reviewId: REVIEW_ID,
            targetRevision: REVISION,
            tasks: [verifierRepairTask(fixture.evidenceIds[2]!)],
          },
        }, request.context);
        assert.equal(result.isError, false, result.error?.message ?? "Repair plan failed");
      },
      { repairPlanLimit: 0 },
    );
    const paused = await runtime.step();
    assert.deepEqual(paused, { status: "paused", action: "repair_cycle_limit_reached" });
    assert.equal(architectCalls, 0);
    const projection = runtime.projection();
    assert.deepEqual(projection.repairCycles, {
      limit: 0, used: 0, extensions: 0,
      pause: { source: "verifier", targetRevision: REVISION, used: 0, limit: 0 },
    });
    assert.throws(() => runtime.resume("resume:1"), /awaiting the user's repair-cycle decision/);

    runtime.extendRepairCycles(1, "extend:1");
    assert.equal(runtime.projection().status, "running");
    await runtime.step();
    assert.equal(architectCalls, 1);
  } finally {
    fixture.close();
  }
});

test("the runtime pauses final-verification repairs at the limit instead of asking the Architect", async () => {
  const fixture = createFixture("runtime-fv-limit", { approveFinalReview: false });
  try {
    appendFinalVerificationRepairRequired(fixture.store);
    fixture.store.append(event("repair.policy_configured", "repair-policy", { repairPlanLimit: 0 }));
    let architectCalls = 0;
    const runtime = createRuntime(
      fixture.store,
      {
        candidateRuntimeIds: ["google:verifier"],
        assessRisk: async () => { throw new Error("risk already assessed"); },
        verify: async () => ({ status: "verdict_submitted" }),
      },
      async () => { architectCalls += 1; },
      { repairPlanLimit: 0 },
    );
    const paused = await runtime.step();
    assert.deepEqual(paused, { status: "paused", action: "repair_cycle_limit_reached" });
    assert.equal(architectCalls, 0);
    assert.deepEqual(runtime.projection().repairCycles?.pause, {
      source: "final_verification", targetRevision: REVISION, used: 0, limit: 0,
    });
    assert.throws(() => runtime.resume("resume:fv"), /awaiting the user's repair-cycle decision/);
  } finally {
    fixture.close();
  }
});

test("the runtime pauses mechanical final-verification repairs at the limit instead of asking the Architect", async () => {
  const fixture = createFixture("runtime-fv-mechanical-limit", { mechanicalFailure: true });
  try {
    fixture.store.append(event("repair.policy_configured", "repair-policy", { repairPlanLimit: 0 }));
    let architectCalls = 0;
    const runtime = createRuntime(
      fixture.store,
      {
        candidateRuntimeIds: ["google:verifier"],
        assessRisk: async () => { throw new Error("risk already assessed"); },
        verify: async () => ({ status: "verdict_submitted" }),
      },
      async () => { architectCalls += 1; },
      { repairPlanLimit: 0 },
    );
    const paused = await runtime.step();
    assert.deepEqual(paused, { status: "paused", action: "repair_cycle_limit_reached" });
    assert.equal(architectCalls, 0);
    const limitEvent = fixture.store.readRun(RUN_ID).find((item) => item.type === "repair.cycle_limit_reached");
    assert.equal(limitEvent?.payload.source, "final_verification");
    assert.deepEqual(runtime.projection().repairCycles?.pause, {
      source: "final_verification", targetRevision: REVISION, used: 0, limit: 0,
    });
    assert.throws(() => runtime.resume("resume:fv-mechanical"), /awaiting the user's repair-cycle decision/);
  } finally {
    fixture.close();
  }
});

test("the runtime still asks the Architect when repair cycles remain", async () => {
  const fixture = createFixture("runtime-under-limit");
  try {
    appendHighRiskAssessment(fixture.store);
    appendUnsatisfiedVerifierVerdict(fixture);
    fixture.store.append(event("repair.policy_configured", "repair-policy", { repairPlanLimit: 2 }));
    let architectCalls = 0;
    const runtime = createRuntime(
      fixture.store,
      {
        candidateRuntimeIds: ["google:verifier"],
        assessRisk: async () => { throw new Error("risk already assessed"); },
        verify: async () => ({ status: "verdict_submitted" }),
      },
      async (request) => {
        architectCalls += 1;
        assert.equal(request.reason.type, "verifier_repair_plan_required");
        if (request.reason.type !== "verifier_repair_plan_required") return;
        const result = await request.tools.invoke({
          type: "tool_call",
          callId: "plan-verifier-repair",
          name: "plan_verifier_repairs",
          arguments: {
            reviewId: REVIEW_ID,
            targetRevision: REVISION,
            tasks: [verifierRepairTask(fixture.evidenceIds[2]!)],
          },
        }, request.context);
        assert.equal(result.isError, false, result.error?.message ?? "Repair plan failed");
      },
      { repairPlanLimit: 2 },
    );
    const progressed = await runtime.step();
    assert.equal(progressed.action, "verifier_repair_plan_required");
    assert.equal(architectCalls, 1);
    assert.equal(runtime.projection().repairCycles?.used, 1);
    assert.equal(repairCyclesExhausted(runtime.projection()), false);
  } finally {
    fixture.close();
  }
});

test("a fresh runtime records repair policy before any plan exists", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-repair-policy-fresh-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    validateCleanupReceipt: () => undefined,
    validateExecutionProfile: acceptFinalVerificationProfile,
  });
  try {
    const runtime = createRuntime(
      store,
      {
        candidateRuntimeIds: ["google:verifier"],
        assessRisk: async () => { throw new Error("unused"); },
        verify: async () => ({ status: "verdict_submitted" }),
      },
      async () => undefined,
      { repairPlanLimit: 4 },
    );
    const projection = runtime.projection();
    assert.deepEqual(projection.repairCycles, { limit: 4, used: 0, extensions: 0 });
    assert.equal(
      store.readRun(RUN_ID).some((item) => item.type === "repair.policy_configured"),
      true,
    );
    assert.equal(
      store.readRun(RUN_ID).some((item) => item.type === "plan.created"),
      false,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("an in-flight pre-P6.5 run stays uncapped after runtime recovery", () => {
  const fixture = createFixture("inflight-uncapped");
  try {
    const runtime = createRuntime(
      fixture.store,
      {
        candidateRuntimeIds: ["google:verifier"],
        assessRisk: async () => { throw new Error("unused"); },
        verify: async () => ({ status: "verdict_submitted" }),
      },
      async () => undefined,
      { repairPlanLimit: 0 },
    );
    assert.equal(runtime.projection().repairCycles, undefined);
    assert.equal(
      fixture.store.readRun(RUN_ID).some((item) => item.type === "repair.policy_configured"),
      false,
    );
  } finally {
    fixture.close();
  }
});

function appendHighRiskAssessment(store: SqliteSchedulerStore): void {
  store.append(event("verifier.policy_configured", "verifier:policy", {
    mode: "risk_based",
    candidateRuntimeIds: ["google:verifier"],
    alwaysRequireIndependentVerifier: false,
  }));
  const input = {
    architectDeclaration: "low" as const,
    stricterQualification: false,
    kernelFacts: {
      destructiveEffects: false,
      credentialEffects: false,
      externalWriteEffects: false,
      integrationConflict: false,
      changedPaths: ["src/auth/session.ts"],
    },
  };
  store.append(event("build.risk_assessed", "risk:high", {
    targetRevision: REVISION,
    input,
    assessment: assessBuildRisk(input),
  }));
}

function appendUnsatisfiedVerifierVerdict(fixture: ReturnType<typeof createFixture>): void {
  appendVerifierRequest(fixture.store);
  fixture.store.append(event("verifier.verdict_submitted", "verifier:verdict", {
    reviewId: REVIEW_ID,
    targetRevision: REVISION,
    sessionId: "verifier:run-verifier-contract:session",
    criterionVerdicts: [
      {
        taskId: "task-api", criterionId: "shared", verdict: "satisfied",
        rationale: "API shared criterion is met.", evidenceIds: [fixture.evidenceIds[0]!],
      },
      {
        taskId: "task-api", criterionId: "typed", verdict: "satisfied",
        rationale: "API typed criterion is met.", evidenceIds: [fixture.evidenceIds[1]!],
      },
      {
        taskId: "task-ui", criterionId: "shared", verdict: "unsatisfied",
        rationale: "The UI criterion is not met.", evidenceIds: [fixture.evidenceIds[2]!],
      },
    ],
  }, { role: "verifier", id: "google:verifier" }));
}

function verifierRepairTask(evidenceId: string): Record<string, unknown> {
  return {
    id: "repair-ui",
    objective: "Repair the UI criterion",
    criteria: [{ taskId: "task-ui", criterionId: "shared" }],
    evidenceIds: [evidenceId],
    dependencies: [],
    requiredCapabilities: ["code"],
    acceptanceCriteria: [{ id: "AC-1", text: "UI criterion satisfied." }],
  };
}

function appendFinalVerificationRepairRequired(store: SqliteSchedulerStore): void {
  store.append(event("final_verification.review_decided", "final:review:repair", {
    taskId: FINAL_TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    attempt: 1,
    submissionId: "final-submission",
    reviewId: "final-review",
    decision: "repair_required",
    summary: "Tests and browser behavior need targeted repairs.",
    categoryReviews: [
      {
        category: "build", verdict: "approved",
        rationale: "build is current and green.", evidenceIds: [],
      },
      {
        category: "tests", verdict: "repair_required",
        rationale: "tests need repair.", evidenceIds: [],
      },
      {
        category: "runtime_smoke", verdict: "approved",
        rationale: "runtime_smoke is current and green.", evidenceIds: [],
      },
      {
        category: "browser", verdict: "repair_required",
        rationale: "browser needs repair.", evidenceIds: [],
      },
    ],
  }, { role: "architect", id: "openai:architect" }));
}

function finalVerificationRepairPayload(
  fixture: ReturnType<typeof createFixture>,
): Record<string, unknown> {
  void fixture;
  return {
    finalVerificationTaskId: FINAL_TASK_ID,
    generationId: GENERATION_ID,
    targetRevision: REVISION,
    source: {
      type: "semantic_review",
      submissionId: "final-submission",
      reviewId: "final-review",
    },
    tasks: [
      {
        id: "repair-tests",
        objective: "Repair the test behavior identified by final verification review.",
        categories: ["tests"],
        evidenceIds: [],
        dependencies: ["task-api"],
        requiredCapabilities: ["code"],
        acceptanceCriteria: [{
          id: "tests-repaired",
          text: "The reviewed tests gap is repaired and regression evidence is recorded.",
        }],
      },
      {
        id: "repair-browser",
        objective: "Repair the browser behavior identified by final verification review.",
        categories: ["browser"],
        evidenceIds: [],
        dependencies: ["task-api"],
        requiredCapabilities: ["browser", "code"],
        acceptanceCriteria: [{
          id: "browser-repaired",
          text: "The reviewed browser gap is repaired and browser evidence is recorded.",
        }],
      },
    ],
  };
}
