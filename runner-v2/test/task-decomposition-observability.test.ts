import assert from "node:assert/strict";
import test from "node:test";

import { rebuildBudgetProjection, type BudgetReservationProjection } from "../src/budget-ledger.js";
import type { SchedulerEvent } from "../src/scheduler-store.js";
import type { BuildTask } from "../src/task-contracts.js";
import { projectTaskDecompositionObservability } from "../src/task-decomposition-observability.js";

function task(id: string, overrides: Partial<BuildTask> = {}): BuildTask {
  return { id, objective: `Deliver ${id}`, status: "planned", dependencies: [], requiredCapabilities: [], attempt: 0, ...overrides };
}

function event(sequence: number, type: SchedulerEvent["type"], taskId: string, payload: Record<string, unknown> = {}): SchedulerEvent {
  return {
    eventId: `event-${sequence}`, runId: "run", sequence, type,
    occurredAt: "2026-10-26T00:00:00.000Z", actor: { role: "runner", id: "runner" },
    idempotencyKey: `event-${sequence}`, payload: { taskId, ...payload },
  };
}

function assigned(sequence: number, taskId: string, attempt: number): SchedulerEvent {
  return event(sequence, "task.transitioned", taskId, { status: "assigned", patch: { attempt } });
}

function submitted(sequence: number, taskId: string, attempt: number, paths?: string[]): SchedulerEvent {
  const changeSetId = `cs-${taskId}-${attempt}`;
  return event(sequence, "task.transitioned", taskId, {
    status: "submitted",
    patch: {
      changeSetId,
      ...(paths !== undefined ? {
        submissionScope: { runId: "run", taskId, attempt, changeSetId, files: paths.map((path) => ({ path, added: false })) },
      } : {}),
    },
  });
}

test("decomposition replay retains attempt history, corrections, conflict overhead and cancelled work", () => {
  const projection = { tasks: {
    A: task("A", { status: "running", attempt: 3 }),
    B: task("B", { status: "integrated", attempt: 1, kind: "verification_repair" }),
    C: task("C", { status: "cancelled", attempt: 1 }),
    FV: task("FV", { kind: "final_verification", status: "integrated", attempt: 1 }),
    D: task("D"),
  } };
  const events = [
    assigned(1, "A", 1), submitted(2, "A", 1, ["src/feature.ts", "test/feature.ts"]),
    event(3, "delivery.review_started", "A"),
    event(4, "review.decided", "A", { decision: "rejected" }),
    event(5, "task.revised", "A"),
    assigned(6, "A", 2), submitted(7, "A", 2, ["src/feature.ts", "test/feature.ts", "src/index.ts"]),
    event(8, "delivery.review_started", "A"),
    event(9, "review.decided", "A", { decision: "approved" }),
    event(10, "task.transitioned", "A", { status: "integration_resolution", patch: { conflictPaths: ["src/index.ts"] } }),
    // A fresh attempt after a budget stop is not a failed-review correction cycle.
    event(11, "task.revised", "A"), assigned(12, "A", 3),
    assigned(13, "B", 1), submitted(14, "B", 1, []),
    assigned(15, "C", 1), submitted(16, "C", 1, ["src/old.ts"]),
    assigned(17, "FV", 1), submitted(18, "FV", 1, ["ignored.ts"]),
  ];
  const original = structuredClone({ projection, events });
  const result = projectTaskDecompositionObservability(projection, events);
  assert.equal(result.taskCount, 4);
  assert.equal(result.activeTaskCount, 3);
  assert.equal(result.cancelledTaskCount, 1);
  assert.equal(result.submissions, 4);
  assert.equal(result.submissionsWithFileInventory, 4);
  assert.equal(result.uniqueChangedFileCount, 4, "paths shared between attempts count once");
  assert.equal(result.correctionCycles, 1);
  assert.equal(result.integrationConflicts, 1);
  assert.deepEqual(result.tasks[0], {
    taskId: "A", status: "running", attempts: 3, submissions: 2, submissionsWithFileInventory: 2,
    changedFileCount: 3, independentReviews: 2, reusedReviews: 0, reviewDecisions: 2,
    correctionCycles: 1, integrationConflicts: 1,
  });
  assert.equal(result.tasks[1]!.changedFileCount, 0, "an observed evidence-only submission can change zero files");
  assert.equal(result.tasks[3]!.changedFileCount, null, "planned work has no measured size");
  assert.equal(result.reviewUsage, null, "missing usage is not a zero-cost review");
  assert.deepEqual({ projection, events }, original, "diagnostics do not mutate lifecycle state");
  assert.deepEqual(projectTaskDecompositionObservability(projection, structuredClone(events)), result);
});

test("missing and stale submission inventories stay unknown; duplicated submission receipts count once", () => {
  const projection = { tasks: { A: task("A", { attempt: 1 }) } };
  for (const override of [
    { runId: "other" }, { taskId: "other" }, { attempt: 2 }, { changeSetId: "other" },
    { files: [{ path: "" }] }, { files: [{}] },
  ]) {
    const submission = submitted(2, "A", 1, ["src/a.ts"]);
    const patch = submission.payload.patch as Record<string, unknown>;
    patch.submissionScope = { ...patch.submissionScope as Record<string, unknown>, ...override };
    const result = projectTaskDecompositionObservability(projection, [assigned(1, "A", 1), submission]);
    assert.equal(result.submissions, 1);
    assert.equal(result.submissionsWithFileInventory, 0);
    assert.equal(result.uniqueChangedFileCount, null);
    assert.equal(result.tasks[0]!.changedFileCount, null);
  }
  const legacy = projectTaskDecompositionObservability(projection, [assigned(1, "A", 1), submitted(2, "A", 1)]);
  assert.equal(legacy.uniqueChangedFileCount, null);
  const submission = submitted(2, "A", 1, ["src/a.ts"]);
  const duplicate = { ...submission, eventId: "scheduler-receipt", sequence: 3 };
  const result = projectTaskDecompositionObservability(projection, [assigned(1, "A", 1), submission, duplicate]);
  assert.equal(result.submissions, 1);
  assert.equal(result.uniqueChangedFileCount, 1);
});

test("review reuse and early corrections remain visible beyond the UI event tail", () => {
  const events = [
    assigned(1, "A", 1), submitted(2, "A", 1, ["src/a.ts"]),
    event(3, "review.decided", "A", { decision: "rejected" }),
    ...Array.from({ length: 1_100 }, (_, index) => event(index + 4, "run.resumed", "none")),
    event(1_104, "delivery.review_reused", "A"),
  ];
  const result = projectTaskDecompositionObservability({ tasks: { A: task("A", { attempt: 1 }) } }, events);
  assert.equal(result.correctionCycles, 1);
  assert.equal(result.tasks[0]!.reusedReviews, 1);
  assert.equal(result.tasks[0]!.independentReviews, 0);
  assert.equal(result.uniqueChangedFileCount, 1);
});

test("review usage separates settled API estimates, account-backed calls, unknown pricing and pending work across windows", () => {
  const budget = rebuildBudgetProjection("run", []);
  const reservation = (id: string, overrides: Partial<BudgetReservationProjection> = {}): BudgetReservationProjection => ({
    reservationId: id, kind: "model", status: "settled", estimate: {}, windowIndex: 1,
    attribution: { role: "verifier", runtimeId: "reviewer", modelId: "model", providerId: "provider", sessionId: id },
    actual: { inputTokens: 100, outputTokens: 10, estimatedCostMicros: 500 },
    costBasis: { kind: "api_estimate", inputCostMicrosPerMillion: 1, outputCostMicrosPerMillion: 1, cachedInputCostMicrosPerMillion: 1, cacheWriteInputCostMicrosPerMillion: 1 },
    ...overrides,
  });
  budget.window.index = 2;
  budget.reservations = {
    api: reservation("api"),
    account: reservation("account", { costBasis: { kind: "account_not_metered" } }),
    unknown: reservation("unknown", { costBasis: { kind: "unknown" } }),
    missingPrice: reservation("missingPrice", { actual: { inputTokens: 100, outputTokens: 10 } }),
    pending: reservation("pending", { status: "reserved", actual: undefined, estimate: { estimatedCostMicros: 10_000 } }),
    worker: reservation("worker", { attribution: { role: "worker", runtimeId: "worker", modelId: "model", providerId: "provider", sessionId: "worker" } }),
    historical: reservation("historical", { attribution: undefined }),
    tool: reservation("tool", { kind: "tool", attribution: undefined }),
  };
  const original = structuredClone(budget);
  const result = projectTaskDecompositionObservability({ tasks: {} }, [], budget);
  assert.deepEqual(result.reviewUsage, {
    settledCalls: 4, pendingCalls: 1, inputTokens: 400, outputTokens: 40,
    apiEstimatedCostMicros: 500, apiPricedCalls: 1, accountBackedCalls: 1,
    unknownCostCalls: 2, unattributedModelCalls: 1,
  });
  assert.deepEqual(budget, original);
});
