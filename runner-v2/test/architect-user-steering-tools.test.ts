import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ToolCallBlock, ToolExecutionContext } from "../src/agent-contracts.js";
import { createArchitectTools } from "../src/architect-tools.js";
import {
  architectLifecycleEventMatchesReason,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type SchedulerEvent,
} from "../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { ToolRegistry } from "../src/tool-registry.js";
import type { ArchitectActionReason } from "../src/user-steering-contracts.js";

const RUN_ID = "architect-steering-tools";
const CLOCK = () => "2026-08-27T00:00:00.000Z";
const ARCHITECT = { role: "architect" as const, id: "architect-test" };
const USER = { role: "user" as const, id: "local-user" };

test("acknowledge_user_guidance is action-bound and no-plan-change requires current-run durable evidence", async () => {
  await withStores(async ({ store, evidenceStore, schedulerDatabase }) => {
    seedPlan(store);
    append(store, "user.guidance_submitted", USER, "guidance:one", {
      guidanceId: "guidance-one", text: "Keep the already-proven public API unchanged.", version: 1,
    });
    const evidence = evidenceStore.record({
      runId: RUN_ID,
      taskId: "architect",
      actor: ARCHITECT,
      fact: {
        kind: "browser_screenshot",
        label: "current API evidence",
        capturedAt: CLOCK(),
        screenshotArtifactHash: "a".repeat(64),
        mediaType: "image/png",
        byteLength: 16,
      },
      createdAt: CLOCK(),
      idempotencyKey: "evidence:current-api",
    });
    const registry = architectRegistry(store, evidenceStore, {
      reason: { type: "user_guidance_required", guidanceId: "guidance-one", version: 1 },
      sequence: projection(store).lastSequence,
    });
    assert.equal(registry.definitions().some((tool) => tool.name === "acknowledge_user_guidance"), true);
    const unrelatedRegistry = new ToolRegistry();
    for (const tool of createArchitectTools({ store, evidenceStore, clock: CLOCK })) {
      unrelatedRegistry.register(tool);
    }
    assert.equal(unrelatedRegistry.definitions().some((tool) => tool.name === "acknowledge_user_guidance"), false);
    assert.equal(unrelatedRegistry.definitions().some((tool) => tool.name === "ask_user"), false);

    const wrongId = await invoke(registry, "acknowledge_user_guidance", {
      guidanceId: "guidance-other",
      expectedVersion: 1,
      resolution: { type: "no_plan_change", rationale: "Evidence proves equivalence.", evidenceIds: [evidence.id] },
    });
    assert.equal(wrongId.isError, true);
    assert.match(wrongId.error?.message ?? "", /exact oldest pending guidance/i);
    const wrongVersion = await invoke(registry, "acknowledge_user_guidance", {
      guidanceId: "guidance-one",
      expectedVersion: 2,
      resolution: { type: "no_plan_change", rationale: "Evidence proves equivalence.", evidenceIds: [evidence.id] },
    });
    assert.equal(wrongVersion.isError, true);
    assert.match(wrongVersion.error?.message ?? "", /exact oldest pending guidance/i);
    const fabricated = await invoke(registry, "acknowledge_user_guidance", {
      guidanceId: "guidance-one",
      expectedVersion: 1,
      resolution: { type: "no_plan_change", rationale: "Evidence proves equivalence.", evidenceIds: ["evidence_fabricated"] },
    });
    assert.equal(fabricated.isError, true);
    assert.match(fabricated.error?.message ?? "", /missing or foreign evidence/i);
    const foreignEvidence = evidenceStore.record({
      runId: "foreign-run",
      taskId: "architect",
      actor: ARCHITECT,
      fact: {
        kind: "browser_screenshot",
        label: "foreign evidence",
        capturedAt: CLOCK(),
        screenshotArtifactHash: "b".repeat(64),
        mediaType: "image/png",
        byteLength: 16,
      },
      createdAt: CLOCK(),
      idempotencyKey: "evidence:foreign-api",
    });
    const foreign = await invoke(registry, "acknowledge_user_guidance", {
      guidanceId: "guidance-one",
      expectedVersion: 1,
      resolution: { type: "no_plan_change", rationale: "Foreign evidence is not authority.", evidenceIds: [foreignEvidence.id] },
    });
    assert.equal(foreign.isError, true);
    assert.match(foreign.error?.message ?? "", /missing or foreign evidence/i);

    const tasksBefore = projection(store).tasks;
    const acknowledged = await invoke(registry, "acknowledge_user_guidance", {
      guidanceId: "guidance-one",
      expectedVersion: 1,
      resolution: { type: "no_plan_change", rationale: "The durable API evidence proves semantic equivalence.", evidenceIds: [evidence.id] },
    });
    assert.equal(acknowledged.isError, false);
    assert.equal(projection(store).userGuidance["guidance-one"].status, "acknowledged");
    assert.deepEqual(projection(store).tasks, tasksBefore);
    assert.equal(store.readRun(RUN_ID).filter((event) => event.type === "user.guidance_acknowledged").length, 1);
    const duplicate = await invoke(registry, "acknowledge_user_guidance", {
      guidanceId: "guidance-one",
      expectedVersion: 1,
      resolution: { type: "no_plan_change", rationale: "The durable API evidence proves semantic equivalence.", evidenceIds: [evidence.id] },
    });
    assert.equal(duplicate.isError, true);
    assert.equal(store.readRun(RUN_ID).filter((event) => event.type === "user.guidance_acknowledged").length, 1);

    store.close();
    const missingAuthority = new SqliteSchedulerStore(schedulerDatabase);
    try {
      assert.throws(() => missingAuthority.readRun(RUN_ID), /authoritative evidence store/i);
    } finally {
      missingAuthority.close();
    }
    const missingEvidence = new SqliteSchedulerStore(schedulerDatabase, {
      evidenceStore: {
        record: () => { throw new Error("unused"); },
        list: () => [],
        getByIds: () => [],
        close: () => undefined,
      },
    });
    try {
      assert.throws(() => missingEvidence.readRun(RUN_ID), /missing or foreign evidence/i);
    } finally {
      missingEvidence.close();
    }
  });
});

test("scope-changing acknowledgement atomically adds validated planned tasks after prior integration", async () => {
  await withStores(async ({ store, evidenceStore }) => {
    seedPlan(store, "integrated");
    append(store, "user.guidance_submitted", USER, "guidance:scope", {
      guidanceId: "guidance-scope", text: "Add a keyboard-accessible account settings screen.", version: 1,
    });
    const action = {
      reason: { type: "user_guidance_required" as const, guidanceId: "guidance-scope", version: 1 },
      sequence: projection(store).lastSequence,
    };
    const registry = architectRegistry(store, evidenceStore, action);
    const added = await invoke(registry, "acknowledge_user_guidance", {
      guidanceId: "guidance-scope",
      expectedVersion: 1,
      resolution: {
        type: "plan_reconciled",
        rationale: "The requested settings screen is new scope and requires a new task.",
        planReconciliation: {
          revision: 2,
          summary: "Add accessible account settings.",
          taskUpdates: [],
          newTasks: [{
            id: "task-settings",
            objective: "Implement keyboard-accessible account settings.",
            dependencies: ["task-existing"],
            requiredCapabilities: ["code", "browser"],
            acceptanceCriteria: [{ id: "keyboard", text: "All settings controls are keyboard accessible." }],
          }],
        },
      },
    });
    assert.equal(added.isError, false, added.error?.message ?? "scope acknowledgement failed");
    const current = projection(store);
    assert.equal(current.tasks["task-existing"].status, "integrated");
    assert.deepEqual(current.tasks["task-settings"], {
      id: "task-settings",
      objective: "Implement keyboard-accessible account settings.",
      dependencies: ["task-existing"],
      requiredCapabilities: ["code", "browser"],
      acceptanceCriteria: [{ id: "keyboard", text: "All settings controls are keyboard accessible." }],
      acceptanceCriteriaVersion: 1,
      status: "planned",
      attempt: 0,
    });

    append(store, "user.guidance_submitted", USER, "guidance:overlap", {
      guidanceId: "guidance-overlap", text: "Add one unambiguous task.", version: 2,
    });
    const overlapRegistry = architectRegistry(store, evidenceStore, {
      reason: { type: "user_guidance_required", guidanceId: "guidance-overlap", version: 2 },
      sequence: projection(store).lastSequence,
    });
    const overlap = await invoke(overlapRegistry, "acknowledge_user_guidance", {
      guidanceId: "guidance-overlap",
      expectedVersion: 2,
      resolution: {
        type: "plan_reconciled",
        rationale: "The same task cannot have two operations in one reconciliation.",
        planReconciliation: {
          revision: 3,
          summary: "Reject ambiguous overlap.",
          newTasks: [{
            id: "task-overlap",
            objective: "Create the overlapping task.",
            dependencies: ["task-existing"],
            requiredCapabilities: ["code"],
            acceptanceCriteria: [{ id: "overlap", text: "The overlap task is complete." }],
          }],
          taskUpdates: [{
            taskId: "task-overlap",
            action: "revise",
            objective: "Immediately revise the overlapping task.",
          }],
        },
      },
    });
    assert.equal(overlap.isError, true);
    assert.match(overlap.error?.message ?? "", /one operation|duplicate|overlap/i);
    assert.equal(projection(store).planRevision, 2);

    append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:overlap:no-change", {
      guidanceId: "guidance-overlap",
      expectedVersion: 2,
      resolution: {
        type: "plan_reconciled",
        rationale: "Advance past the overlap test with a valid reconciliation.",
        planReconciliation: {
          revision: 3,
          summary: "Preserve the valid graph.",
          taskUpdates: [{ taskId: "task-settings", action: "revise", objective: "Implement accessible account settings." }],
        },
      },
    });
    append(store, "user.guidance_submitted", USER, "guidance:invalid-scope", {
      guidanceId: "guidance-invalid", text: "Add invalid cyclic work.", version: 3,
    });
    const invalidRegistry = architectRegistry(store, evidenceStore, {
      reason: { type: "user_guidance_required", guidanceId: "guidance-invalid", version: 3 },
      sequence: projection(store).lastSequence,
    });
    const before = projection(store);
    const invalid = await invoke(invalidRegistry, "acknowledge_user_guidance", {
      guidanceId: "guidance-invalid",
      expectedVersion: 3,
      resolution: {
        type: "plan_reconciled",
        rationale: "This malformed graph must be rejected atomically.",
        planReconciliation: {
          revision: 4,
          summary: "Invalid graph.",
          taskUpdates: [],
          newTasks: [{
            id: "task-cycle",
            kind: "final_verification",
            objective: "Impersonate final verification.",
            dependencies: ["task-cycle"],
            requiredCapabilities: [],
            acceptanceCriteria: [{ id: "invalid", text: "Invalid." }],
          }],
        },
      },
    });
    assert.equal(invalid.isError, true);
    assert.deepEqual(projection(store), before);
  });
});

test("ask_user is action-bound, versioned, and blocks raw semantic progress until an exact user answer", async () => {
  await withStores(async ({ store, evidenceStore }) => {
    seedPlan(store, "submitted");
    const action = {
      reason: { type: "review_required" as const, taskId: "task-existing", changeSetId: "change-existing" },
      sequence: projection(store).lastSequence,
    };
    const registry = architectRegistry(store, evidenceStore, action);
    assert.equal(registry.definitions().some((tool) => tool.name === "ask_user"), true);
    assert.throws(() => append(store, "architect.question_requested", ARCHITECT, "question:malformed-checkpoint", {
      questionId: "question-malformed",
      version: 1,
      question: "Malformed checkpoint?",
      decisionKind: "authority_decision",
      checkpoint: { reason: { type: "not_a_real_action" }, sequence: 0 },
    }), /checkpoint|action reason/i);
    assert.throws(() => append(store, "architect.question_requested", ARCHITECT, "question:future-checkpoint", {
      questionId: "question-future",
      version: 1,
      question: "Future checkpoint?",
      decisionKind: "authority_decision",
      checkpoint: { reason: action.reason, sequence: projection(store).lastSequence + 1 },
    }), /checkpoint sequence/i);
    const wrongVersion = await invoke(registry, "ask_user", {
      questionId: "question-review",
      version: 2,
      decisionKind: "authority_decision",
      question: "May this external contract change?",
    });
    assert.equal(wrongVersion.isError, true);
    const asked = await invoke(registry, "ask_user", {
      questionId: "question-review",
      version: 1,
      decisionKind: "authority_decision",
      question: "May this external contract change?",
    });
    assert.equal(asked.isError, false, asked.error?.message ?? "ask_user failed");
    const open = projection(store);
    assert.equal(open.blockingArchitectQuestionId, "question-review");
    assert.deepEqual(open.architectQuestions["question-review"].checkpoint, action);
    assert.throws(() => append(store, "review.decided", ARCHITECT, "raw:stale-review", {
      taskId: "task-existing", decision: "approved", summary: "Stale.", evidenceArtifactHashes: [],
    }), /blocking architect question/i);
    const workerAsk = await invoke(registry, "ask_user", {
      questionId: "question-worker",
      version: 2,
      decisionKind: "authority_decision",
      question: "Worker bypass?",
    }, { role: "worker", id: "worker-1" });
    assert.equal(workerAsk.isError, true);
    assert.match(workerAsk.error?.message ?? "", /only the architect/i);
    assert.throws(() => append(store, "architect.question_answered", { role: "runner", id: "runner" }, "question:runner-answer", {
      questionId: "question-review", expectedVersion: 1, answer: "Yes.",
    }), /only the user/i);
    append(store, "architect.question_answered", USER, "question:user-answer", {
      questionId: "question-review", expectedVersion: 1, answer: "Yes, preserve compatibility.",
    });
    const answered = projection(store).architectQuestions["question-review"];
    assert.equal(answered.status, "answered");
    assert.equal(answered.resumeStatus, "pending");
    append(store, "architect.question_resume_started", { role: "runner", id: "build-runtime" }, "question:resume-start", {
      questionId: "question-review", expectedVersion: 1,
    });
    const startedSequence = projection(store).architectQuestions["question-review"].resumeStartedSequence!;
    append(store, "architect.question_requested", ARCHITECT, "question:unrelated-follow-up", {
      questionId: "question-unrelated",
      version: 2,
      question: "An unrelated planning question.",
      decisionKind: "authority_decision",
      checkpoint: { reason: { type: "plan_required" }, sequence: startedSequence },
    });
    const unrelatedSequence = projection(store).lastSequence;
    assert.throws(() => append(store, "architect.question_resume_consumed", { role: "runner", id: "build-runtime" }, "question:forged-consume", {
      questionId: "question-review", expectedVersion: 1, actionEventSequence: unrelatedSequence,
    }), /no completed resumed action/i);
  });
});

test("resume consumption rejects a real Architect lifecycle event for a different stored action payload", async () => {
  await withStores(async ({ store, evidenceStore }) => {
    seedPlan(store);
    append(store, "user.guidance_submitted", USER, "guidance:actual", {
      guidanceId: "guidance-actual",
      text: "Revise the current task objective.",
      version: 1,
    });
    append(store, "user.guidance_submitted", USER, "guidance:other", {
      guidanceId: "guidance-other",
      text: "Retain the secondary alias.",
      version: 2,
    });
    append(store, "architect.question_requested", ARCHITECT, "question:forged-action", {
      questionId: "question-forged-action",
      version: 1,
      decisionKind: "authority_decision",
      question: "Resolve the current authority decision.",
      checkpoint: {
        reason: { type: "user_guidance_required", guidanceId: "guidance-actual", version: 1 },
        sequence: projection(store).lastSequence,
      },
    });
    append(store, "architect.question_answered", USER, "question:forged-action:answer", {
      questionId: "question-forged-action",
      expectedVersion: 1,
      answer: "Proceed with the durable guidance.",
    });
    append(store, "architect.question_resume_started", { role: "runner", id: "build-runtime" }, "question:forged-action:start", {
      questionId: "question-forged-action",
      expectedVersion: 1,
    });
    const evidence = evidenceStore.record({
      runId: RUN_ID,
      taskId: "architect",
      actor: ARCHITECT,
      fact: {
        kind: "browser_screenshot",
        label: "no-plan evidence",
        capturedAt: CLOCK(),
        screenshotArtifactHash: "c".repeat(64),
        mediaType: "image/png",
        byteLength: 16,
      },
      createdAt: CLOCK(),
      idempotencyKey: "evidence:no-plan-mismatch",
    });
    const acknowledgement = append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:other:ack", {
      guidanceId: "guidance-other",
      expectedVersion: 2,
      resolution: {
        type: "no_plan_change",
        rationale: "The evidence proves the current plan is equivalent.",
        evidenceIds: [evidence.id],
      },
    });
    assert.throws(() => append(store, "architect.question_resume_consumed", { role: "runner", id: "build-runtime" }, "question:forged-action:consume", {
      questionId: "question-forged-action",
      expectedVersion: 1,
      actionEventSequence: acknowledgement.sequence,
    }), /no completed resumed action/i);
  });
});

test("a resumed integration-resolution action gets a distinct durable transition identity", async () => {
  await withStores(async ({ store, evidenceStore }) => {
    seedPlan(store, "approved");
    const initialRegistry = architectRegistry(store, evidenceStore, {
      reason: {
        type: "integration_approval_required",
        taskId: "task-existing",
        changeSetId: "change-existing",
      },
      sequence: projection(store).lastSequence,
    });
    const first = await invoke(initialRegistry, "request_integration", { taskId: "task-existing" });
    assert.equal(first.isError, false, first.error?.message ?? "initial integration request failed");
    append(store, "task.transitioned", { role: "runner", id: "integration-manager" }, "integration:conflict", {
      taskId: "task-existing",
      status: "integration_resolution",
      patch: { integrationRevision: "conflict-revision", conflictPaths: ["src/conflict.ts"] },
    });
    const sequenceBeforeResume = projection(store).lastSequence;
    const resumedRegistry = architectRegistry(store, evidenceStore, {
      reason: { type: "integration_resolution_required", taskId: "task-existing" },
      sequence: sequenceBeforeResume,
    });
    const resumed = await invoke(resumedRegistry, "request_integration", { taskId: "task-existing" });
    assert.equal(resumed.isError, false, resumed.error?.message ?? "resumed integration request failed");
    assert.equal(projection(store).tasks["task-existing"].status, "integrating");
    assert.equal(projection(store).lastSequence, sequenceBeforeResume + 1);
    append(store, "task.transitioned", { role: "runner", id: "integration-manager" }, "integration:conflict:two", {
      taskId: "task-existing",
      status: "integration_resolution",
      patch: { integrationRevision: "conflict-revision-two", conflictPaths: ["src/conflict-two.ts"] },
    });
    const secondSequence = projection(store).lastSequence;
    const secondRegistry = architectRegistry(store, evidenceStore, {
      reason: { type: "integration_resolution_required", taskId: "task-existing" },
      sequence: secondSequence,
    });
    const second = await invoke(secondRegistry, "request_integration", { taskId: "task-existing" });
    assert.equal(second.isError, false, second.error?.message ?? "second integration resolution failed");
    assert.equal(projection(store).tasks["task-existing"].status, "integrating");
    assert.equal(projection(store).lastSequence, secondSequence + 1);
  });
});

test("every Architect action reason matches only its exact durable lifecycle event payload", () => {
  const cases: Array<{
    reason: ArchitectActionReason;
    event: SchedulerEvent;
    wrongPayload: Record<string, unknown>;
    wrongType?: SchedulerEvent["type"];
  }> = [
    { reason: { type: "plan_required" }, event: lifecycleEvent("plan.created", ARCHITECT, { revision: 1 }), wrongPayload: {}, wrongType: "review.decided" },
    { reason: { type: "acceptance_contract_upgrade_required" }, event: lifecycleEvent("acceptance_contract.upgraded", ARCHITECT, { revision: 2 }), wrongPayload: {}, wrongType: "review.decided" },
    { reason: { type: "user_guidance_required", guidanceId: "g1", version: 1 }, event: lifecycleEvent("user.guidance_acknowledged", ARCHITECT, { guidanceId: "g1", expectedVersion: 1 }), wrongPayload: { guidanceId: "g2", expectedVersion: 1 } },
    { reason: { type: "guidance_required", requestId: "worker-q", taskId: "task-a" }, event: lifecycleEvent("guidance.answered", ARCHITECT, { requestId: "worker-q" }), wrongPayload: { requestId: "worker-other" } },
    { reason: { type: "review_required", taskId: "task-a", changeSetId: "change-a" }, event: lifecycleEvent("review.decided", ARCHITECT, { taskId: "task-a" }), wrongPayload: { taskId: "task-b" } },
    { reason: { type: "integration_approval_required", taskId: "task-a", changeSetId: "change-a" }, event: lifecycleEvent("task.transitioned", ARCHITECT, { taskId: "task-a", status: "integrating" }), wrongPayload: { taskId: "task-b", status: "integrating" } },
    { reason: { type: "completion_decision_required" }, event: lifecycleEvent("project.handoff_requested", ARCHITECT, { summary: "Complete." }), wrongPayload: {}, wrongType: "review.decided" },
    { reason: { type: "completion_decision_required", runPolicy: "plan_only" }, event: lifecycleEvent("project.handoff_requested", ARCHITECT, { summary: "Plan complete." }), wrongPayload: {}, wrongType: "review.decided" },
    { reason: { type: "final_verification_plan_required", integrationRevision: "revision-a" }, event: lifecycleEvent("final_verification.generation_created", { role: "runner", id: "build-runtime" }, { targetRevision: "revision-a" }), wrongPayload: { targetRevision: "revision-b" } },
    { reason: { type: "final_verification_review_required", taskId: "fv-task", generationId: "generation-a", submissionId: "submission-a", targetRevision: "revision-a" }, event: lifecycleEvent("final_verification.review_decided", ARCHITECT, { taskId: "fv-task", generationId: "generation-a", submissionId: "submission-a", targetRevision: "revision-a" }), wrongPayload: { taskId: "fv-task", generationId: "generation-b", submissionId: "submission-a", targetRevision: "revision-a" } },
    { reason: { type: "final_verification_repair_plan_required", finalVerificationTaskId: "fv-task", generationId: "generation-a", targetRevision: "revision-a", source: { type: "mechanical_failure", failureId: "failure-a", issueIds: ["issue-a"], factIds: ["fact-a"] }, failedCategories: ["tests"], evidenceIds: ["evidence-a"] }, event: lifecycleEvent("final_verification.repairs_planned", ARCHITECT, { finalVerificationTaskId: "fv-task", generationId: "generation-a", targetRevision: "revision-a" }), wrongPayload: { finalVerificationTaskId: "fv-task", generationId: "generation-b", targetRevision: "revision-a" } },
    { reason: { type: "task_failure_resolution_required", taskId: "task-a", attempt: 2, failureReason: "Tests failed." }, event: lifecycleEvent("task.revised", ARCHITECT, { taskId: "task-a", revision: 2 }), wrongPayload: { taskId: "task-b", revision: 2 } },
    { reason: { type: "integration_resolution_required", taskId: "task-a" }, event: lifecycleEvent("task.transitioned", ARCHITECT, { taskId: "task-a", status: "integrating" }), wrongPayload: { taskId: "task-b", status: "integrating" } },
  ];
  for (const item of cases) {
    assert.equal(architectLifecycleEventMatchesReason(item.event, item.reason), true, item.reason.type);
    assert.equal(architectLifecycleEventMatchesReason({
      ...item.event,
      ...(item.wrongType ? { type: item.wrongType } : {}),
      payload: item.wrongPayload,
    }, item.reason), false, `${item.reason.type}:wrong`);
    assert.equal(architectLifecycleEventMatchesReason({
      ...item.event,
      actor: item.event.actor.role === "architect"
        ? { role: "runner", id: "forged-runner" }
        : { role: "architect", id: "forged-architect" },
    }, item.reason), false, `${item.reason.type}:actor`);
  }
});

test("plan-changing guidance durably supersedes a stale answered review checkpoint", async () => {
  await withStores(async ({ store, schedulerDatabase, evidenceStore }) => {
    seedPlan(store, "submitted");
    append(store, "architect.question_requested", ARCHITECT, "question:review-overlap", {
      questionId: "question-review-overlap",
      version: 1,
      decisionKind: "requirement_conflict",
      question: "Should this submitted change still be reviewed?",
      checkpoint: {
        reason: { type: "review_required", taskId: "task-existing", changeSetId: "change-existing" },
        sequence: projection(store).lastSequence,
      },
    });
    append(store, "architect.question_answered", USER, "question:review-overlap:answer", {
      questionId: "question-review-overlap",
      expectedVersion: 1,
      answer: "Apply the newer guidance first.",
    });
    append(store, "user.guidance_submitted", USER, "guidance:cancel-review", {
      guidanceId: "guidance-cancel-review",
      text: "Cancel the submitted task.",
      version: 1,
    });
    append(store, "user.guidance_acknowledged", ARCHITECT, "guidance:cancel-review:ack", {
      guidanceId: "guidance-cancel-review",
      expectedVersion: 1,
      resolution: {
        type: "plan_reconciled",
        rationale: "The newer guidance cancels the submitted work and makes its review stale.",
        planReconciliation: {
          revision: 2,
          summary: "Cancel stale submitted work.",
          taskUpdates: [{ taskId: "task-existing", action: "cancel" }],
        },
      },
    });
    const superseded = projection(store).architectQuestions["question-review-overlap"];
    assert.equal(superseded.resumeStatus, "superseded");
    assert.equal(superseded.supersededByGuidanceId, "guidance-cancel-review");
    assert.match(superseded.supersededRationale ?? "", /makes its review stale/i);

    store.close();
    const reopened = new SqliteSchedulerStore(schedulerDatabase, { evidenceStore });
    try {
      assert.deepEqual(
        projection(reopened).architectQuestions["question-review-overlap"],
        superseded,
      );
    } finally {
      reopened.close();
    }
  });
});

function architectRegistry(
  store: SqliteSchedulerStore,
  evidenceStore: SqliteEvidenceStore,
  architectAction: { reason: ArchitectActionReason; sequence: number },
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of createArchitectTools({
    store,
    evidenceStore,
    clock: CLOCK,
    architectAction,
  })) registry.register(tool);
  return registry;
}

async function invoke(
  registry: ToolRegistry,
  name: string,
  argumentsValue: unknown,
  actor: ToolExecutionContext["actor"] = ARCHITECT,
) {
  const call: ToolCallBlock = { type: "tool_call", callId: `${name}:call`, name, arguments: argumentsValue };
  return await registry.invoke(call, {
    runId: RUN_ID,
    sessionId: "architect:test",
    actor,
  });
}

function seedPlan(
  store: SqliteSchedulerStore,
  status: "planned" | "submitted" | "approved" | "integrated" = "planned",
): void {
  append(store, "run.initialized", { role: "runner", id: "runner" }, "initialized", {
    objective: "Build the immutable requested application.",
  });
  append(store, "plan.created", ARCHITECT, "plan:1", {
    revision: 1,
    tasks: [{
      id: "task-existing",
      objective: "Implement the existing application.",
      dependencies: [],
      status,
      requiredCapabilities: ["code"],
      acceptanceCriteria: [{ id: "done", text: "The existing application is complete." }],
      acceptanceCriteriaVersion: 1,
      attempt: status === "planned" ? 0 : 1,
      ...(status === "submitted" || status === "approved" ? {
        assignedWorkerId: "worker_task-existing_1",
        changeSetId: "change-existing",
        criterionEvidenceLinks: [{ criterionId: "done", evidenceIds: ["legacy-test-evidence"], artifactHashes: [] }],
      } : {}),
      ...(status === "integrated" ? { integrationRevision: "integrated-revision" } : {}),
    }],
  });
}

function append(
  store: SqliteSchedulerStore,
  type: NewSchedulerEvent["type"],
  actor: NewSchedulerEvent["actor"],
  idempotencyKey: string,
  payload: Record<string, unknown>,
) {
  if (type === "user.guidance_acknowledged") {
    const guidanceId = payload.guidanceId;
    const expectedVersion = payload.expectedVersion;
    if (typeof guidanceId === "string" && typeof expectedVersion === "number") {
      const guidance = projection(store).userGuidance[guidanceId];
      if (guidance?.interruptionStatus === "pending") {
        store.append({
          runId: RUN_ID,
          type: "user.guidance_interruption_completed",
          occurredAt: CLOCK(),
          actor: { role: "runner", id: "build-manager" },
          idempotencyKey: `guidance-interruption:${guidanceId}:version:${expectedVersion}`,
          payload: { guidanceId, expectedVersion },
        });
      }
    }
  }
  const appended = store.append({ runId: RUN_ID, type, occurredAt: CLOCK(), actor, idempotencyKey, payload });
  if (type === "user.guidance_submitted") {
    const guidanceId = payload.guidanceId;
    const version = payload.version;
    if (typeof guidanceId === "string" && typeof version === "number") {
      store.append({
        runId: RUN_ID,
        type: "user.guidance_interruption_completed",
        occurredAt: CLOCK(),
        actor: { role: "runner", id: "build-manager" },
        idempotencyKey: `guidance-interruption:${guidanceId}:version:${version}`,
        payload: { guidanceId, expectedVersion: version },
      });
    }
  }
  return appended;
}

function projection(store: SqliteSchedulerStore) {
  return rebuildSchedulerProjection(store.readRun(RUN_ID));
}

function lifecycleEvent(
  type: SchedulerEvent["type"],
  actor: SchedulerEvent["actor"],
  payload: Record<string, unknown>,
): SchedulerEvent {
  return {
    eventId: `event:${type}`,
    runId: RUN_ID,
    sequence: 1,
    type,
    occurredAt: CLOCK(),
    actor,
    idempotencyKey: `event:${type}`,
    payload,
  };
}

async function withStores(
  run: (input: {
    store: SqliteSchedulerStore;
    evidenceStore: SqliteEvidenceStore;
    schedulerDatabase: string;
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-architect-steering-tools-"));
  const schedulerDatabase = join(root, "scheduler.sqlite");
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(schedulerDatabase, { evidenceStore });
  try {
    await run({ store, evidenceStore, schedulerDatabase });
  } finally {
    try { store.close(); } catch { /* a replay test may close it */ }
    evidenceStore.close();
    rmSync(root, { recursive: true, force: true });
  }
}
