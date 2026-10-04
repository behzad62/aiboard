import assert from "node:assert/strict";
import test from "node:test";
import { assessDeliveryRisk, deliveryReviewDepthForTier } from "../src/delivery-acceptance.js";
import { rebuildSchedulerProjection, type SchedulerEvent } from "../src/scheduler-store.js";
import { reviewRunnerSignals } from "../src/review-integrity.js";
import { DELIVERY_REVIEW_RUNNER_ID, deliveryReviewId } from "../src/delivery-acceptance.js";
import { reduceSchedulerEvent } from "../src/scheduler-store.js";
import { captureReviewSignals, validateReviewSignals } from "../src/review-integrity.js";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGit } from "./support/git-fixture.js";

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
  append("worker.runtime_assigned", { taskId: "T1", attempt: 1, runtimeId: "work:A", sessionId: "s1", modelIdentity: "a" });
  append("worker.runtime_assigned", { taskId: "T1", attempt: 1, runtimeId: "work:B", sessionId: "s1", modelIdentity: "b" });
  const projection = rebuildSchedulerProjection(events);
  assert.equal(projection.runtime.workerAssignments["T1:1"]!.runtimeId, "work:B");
  const history = (projection.runtime as typeof projection.runtime & { workerAssignmentHistory?: Record<string, Array<{ runtimeId: string }>> }).workerAssignmentHistory;
  assert.deepEqual(history?.["T1:1"]?.map((assignment) => assignment.runtimeId), ["work:A", "work:B"]);
  const drift = structuredClone(projection);
  drift.planningPolicyVersion = 1;
  drift.tasks.T1 = { ...drift.tasks.T1!, status: "submitted", changeSetId: "changeset_test", acceptanceCriteria: [{ id: "c1", text: "Deliver" }] };
  drift.delivery = { reviews: {}, reviewHistory: {}, authorModelIdentities: { "work:B": "prior-model" }, boundaries: {}, taskAcceptances: {}, phaseAcceptances: {} };
  const reviewEvent: SchedulerEvent = { runId: drift.runId, eventId: "drift", sequence: drift.lastSequence + 1, type: "delivery.review_started", occurredAt: "2026-10-04T00:00:00.000Z", actor: { role: "runner", id: DELIVERY_REVIEW_RUNNER_ID }, idempotencyKey: "drift", payload: { taskId: "T1", reviewId: deliveryReviewId("T1", 1, 1), generation: 1, attempt: 1, changeSetId: "changeset_test", diffArtifactHash: "a".repeat(64), criteriaIds: ["c1"], authorRuntimeId: "work:B", authorModelIdentity: "b", architectRuntimeId: "arch", architectModelIdentity: "architect" } };
  assert.throws(() => reduceSchedulerEvent(drift, reviewEvent), /model identity changed during the run/);
  const legacy = rebuildSchedulerProjection(events.map((event, index) => index === 0 ? { ...event, payload: {} } : event));
  assert.equal(Object.hasOwn(legacy.runtime, "workerAssignmentHistory"), false);
});

test("E3 supported C++ header source identities raise orphan facts and accept real include references", () => {
  for (const path of ["src/orphan.hxx", "src/orphan.hh"]) {
    const files = [{ path, added: true }];
    assert.deepEqual(reviewRunnerSignals(files, new Map([[path, "int value();"]])).unreferencedSourceFiles, [path]);
    assert.deepEqual(reviewRunnerSignals(files, new Map([[path, "int value();"], ["main.cpp", `#include "${path}"`]])).unreferencedSourceFiles, []);
  }
});

test("E3 comments and ordinary strings cannot manufacture a source import reference", () => {
  const files = [{ path: "src/orphan.mjs", added: true }];
  for (const fake of ["// import './orphan.mjs';", "/* import './orphan.mjs'; */", "const text = \"import './orphan.mjs';\";"]) {
    assert.deepEqual(reviewRunnerSignals(files, new Map([["src/orphan.mjs", "export const value = 2;"], ["src/main.mjs", fake]])).unreferencedSourceFiles, ["src/orphan.mjs"]);
  }
  assert.deepEqual(reviewRunnerSignals(files, new Map([["src/orphan.mjs", "export const value = 2;"], ["src/main.mjs", "export { value } from './orphan.mjs';"]])).unreferencedSourceFiles, []);
});

test("E3 C++ raw literals cannot manufacture header references", () => {
  const path = "src/orphan.hh";
  const files = [{ path, added: true }];
  const fake = `const char* text = R"example(\n#include "${path}"\n)example";`;
  assert.deepEqual(reviewRunnerSignals(files, new Map([[path, "int value();"], ["main.cpp", fake]])).unreferencedSourceFiles, [path]);
});

test("E3 real Git signals use the immutable candidate rather than dirty owner/index files", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-e3-signals-")); const project = join(root, "project"); mkdirSync(join(project, "src"), { recursive: true });
  const git = (args: string[]) => runGit({ cwd: project, args });
  try {
    await git(["init"]); writeFileSync(join(project, "src/main.mjs"), "export const main = 1;\n"); await git(["add", "-A"]); await git(["commit", "-m", "baseline"]);
    const baseline = (await git(["rev-parse", "HEAD"])).stdout.trim();
    writeFileSync(join(project, "src/new.mjs"), "export const value = 2;\n"); await git(["add", "-A"]); await git(["commit", "-m", "orphan"]);
    const orphan = (await git(["rev-parse", "HEAD"])).stdout.trim();
    writeFileSync(join(project, "src/main.mjs"), "export { value } from './new.mjs';\n"); await git(["add", "-A"]);
    const record = await captureReviewSignals({ git: runGit, workspacePath: project, runId: "e3-git", taskId: "T1", baselineRevision: baseline, taskRevision: orphan });
    assert.deepEqual(record.signals.unreferencedSourceFiles, ["src/new.mjs"]);
    const detached = validateReviewSignals(record, record); detached.signals.unreferencedSourceFiles.push("src/alias.mjs"); assert.deepEqual(record.signals.unreferencedSourceFiles, ["src/new.mjs"]);
    assert.throws(() => validateReviewSignals({ ...record, taskRevision: baseline }, record), /exact authority/);
    await git(["commit", "-m", "wired"]); const wired = (await git(["rev-parse", "HEAD"])).stdout.trim();
    assert.deepEqual((await captureReviewSignals({ git: runGit, workspacePath: project, runId: "e3-git", taskId: "T1", baselineRevision: baseline, taskRevision: wired })).signals.unreferencedSourceFiles, []);
    for (const path of ["jest.config.mjs", "pytest.ini", "test/value.test.mjs"]) assert.equal(reviewRunnerSignals([{ path, added: true }], new Map()).testOnlyDiff, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
