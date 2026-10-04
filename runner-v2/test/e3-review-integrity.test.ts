import assert from "node:assert/strict";
import test from "node:test";
import { assessDeliveryRisk, deliveryReviewDepthForTier } from "../src/delivery-acceptance.js";
import { rebuildSchedulerProjection, type SchedulerEvent } from "../src/scheduler-store.js";

const riskInput = {
  authorModelId: "frontier", changedFiles: ["src/value.mjs", "test/value.test.mjs"], linesAdded: 4, linesRemoved: 1,
  attempts: 1, acceptedFailuresUsed: false,
  trackRecord: { snapshotId: "e3-frontier", records: { frontier: { tasksReviewed: 5, defectsFound: 0 } } },
};

test("E3 active low-tier review requires real inspection; historical low tier retains its recorded depth", () => {
  assert.equal(deliveryReviewDepthForTier("low").repositoryInspection, false);
  assert.equal(deliveryReviewDepthForTier("low", 1).repositoryInspection, true);
});

test("E3 unreferenced new source raises an otherwise low review to at least medium", () => {
  assert.equal(assessDeliveryRisk(riskInput).tier, "low");
  const input = { ...riskInput, runnerSignals: { unreferencedSourceFiles: ["src/value.mjs"], testOnlyDiff: false } };
  const risk = assessDeliveryRisk(input);
  assert.ok(risk.tier === "medium" || risk.tier === "high");
  assert.ok(risk.signals.some((signal) => signal.startsWith("unreferenced_source:")));
});

test("E3 test-only changes raise an otherwise low review to at least medium; referenced product control stays low", () => {
  const input = { ...riskInput, changedFiles: ["test/value.test.mjs"], runnerSignals: { unreferencedSourceFiles: [], testOnlyDiff: true } };
  const risk = assessDeliveryRisk(input);
  assert.ok(risk.tier === "medium" || risk.tier === "high");
  assert.ok(risk.signals.some((signal) => signal.startsWith("test_only_diff:")));
  assert.equal(assessDeliveryRisk({ ...riskInput, runnerSignals: { unreferencedSourceFiles: [], testOnlyDiff: false } }).tier, "low");
});

test("E3 current attempt retains every assigned runtime across failover while activation-free history stays absent", () => {
  const events: SchedulerEvent[] = [];
  const append = (type: SchedulerEvent["type"], payload: Record<string, unknown>, role: SchedulerEvent["actor"]["role"] = "runner", id = "runtime-router") => {
    events.push({ runId: "e3-authors", eventId: `e${events.length + 1}`, sequence: events.length + 1, type,
      occurredAt: "2026-10-04T00:00:00.000Z", actor: { role, id }, idempotencyKey: `e${events.length + 1}`, payload });
  };
  append("run.initialized", { reviewIntegrityPolicyVersion: 1 }, "runner", "build-runtime");
  append("plan.created", { revision: 1, tasks: [{ id: "T1", objective: "Deliver", dependencies: [], status: "planned", requiredCapabilities: ["code"], attempt: 1 }] }, "architect", "architect_1");
  append("task.transitioned", { taskId: "T1", status: "assigned", patch: { assignedWorkerId: "worker_T1_1" } }, "runner", "scheduler");
  append("task.transitioned", { taskId: "T1", status: "running", patch: {} }, "runner", "scheduler");
  append("worker.runtime_assigned", { taskId: "T1", attempt: 1, runtimeId: "work:A", sessionId: "s1" });
  append("worker.runtime_assigned", { taskId: "T1", attempt: 1, runtimeId: "work:B", sessionId: "s1" });
  const projection = rebuildSchedulerProjection(events);
  assert.equal(projection.runtime.workerAssignments["T1:1"]!.runtimeId, "work:B");
  const history = (projection.runtime as typeof projection.runtime & { workerAssignmentHistory?: Record<string, Array<{ runtimeId: string }>> }).workerAssignmentHistory;
  assert.deepEqual(history?.["T1:1"]?.map((assignment) => assignment.runtimeId), ["work:A", "work:B"]);
  const legacy = rebuildSchedulerProjection(events.map((event, index) => index === 0 ? { ...event, payload: {} } : event));
  assert.equal(Object.hasOwn(legacy.runtime, "workerAssignmentHistory"), false);
});
