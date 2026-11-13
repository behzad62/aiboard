/**
 * VF8 (VD-3): a non-mandatory v2 check that still fails at the repair limit becomes a known
 * defect and the Build goes on to its handoff; a mandatory one still pauses. In memory: fake
 * drivers, no process, no checkout (about 1 s), so required PR CI runs it with the VF3 contract.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BuildRuntime, type BuildStepResult } from "../src/build-runtime.js";
import {
  verificationSuggestionsForProfile,
  withResolvedVerificationPlan,
  type FinalVerificationExecutionProfile,
} from "../src/final-verification-profile.js";
import { handoffSnapshotInputFromProjection, renderHandoffSnapshot, verifyHandoffSnapshotDigest } from "../src/handoff-snapshot.js";
import { buildCompletionReadiness, rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { completeVerificationPlanV2, type VerificationCheckV2, type VerificationPlanV2 } from "../src/verification-plan-v2.js";
import { acceptFinalVerificationProfile, emptyFinalVerificationProfile } from "./support/final-verification-profile.js";
import { FINAL_TASK_ID, GENERATION_ID, WHEN, seedTasks } from "./support/verification-plan-v2-fixtures.js";

type ToolResult = { isError: boolean; error?: { message?: string; code?: string } };
type Call = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

const keep = (check: VerificationCheckV2) => ({
  id: check.id,
  label: check.label,
  kind: check.kind,
  ...(check.run ? { run: check.run } : {}),
  ...(check.start ? { start: check.start } : {}),
});

/** A v2 run whose only check (`tests`) fails, with no repair plan left: the run's limit is 0. */
function knownDefectRun(root: string, runId: string, revision: string, options: {
  mandatory: boolean;
  reasons: string[];
  onReview?: (call: Call, reason: Record<string, unknown>) => Promise<void>;
  onCompletion?: (call: Call) => Promise<void>;
}) {
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    evidenceStore: evidence, validateCleanupReceipt: () => undefined, validateExecutionProfile: acceptFinalVerificationProfile,
  });
  const base: FinalVerificationExecutionProfile = {
    ...emptyFinalVerificationProfile(revision),
    detectedSignals: [{ category: "tests", source: "fixture", detail: "tests" }],
    commands: { tests: [{ label: "tests", executable: "fixture", args: [] }] },
  };
  // Only the Runner sets mandatory (VF4 reads it from aiboard-validation.json); here the suggestion carries it.
  const suggestions = verificationSuggestionsForProfile(base).map((suggestion) => ({
    check: { ...suggestion.check, mandatory: options.mandatory },
    resolved: { ...suggestion.resolved, mandatory: options.mandatory },
  }));
  const plan = (completeVerificationPlanV2(
    { checks: suggestions.map((suggestion) => keep(suggestion.check)), skipped: [] },
    suggestions.map((suggestion) => suggestion.check),
  ) as { plan: VerificationPlanV2 }).plan;
  const checkId = plan.checks[0]!.id;
  store.append({ runId, type: "run.initialized", occurredAt: WHEN, actor: { role: "runner", id: "runner" }, idempotencyKey: "init", payload: { verificationContractVersion: 2 } });
  store.append({ runId, type: "repair.policy_configured", occurredAt: WHEN, actor: { role: "runner", id: "runner" }, idempotencyKey: "repair-policy", payload: { repairPlanLimit: 0 } });
  seedTasks(store, runId, revision);
  store.append({ runId, type: "final_verification.generation_created", occurredAt: WHEN, actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "generation", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, planVersion: 1, plan, executionProfile: withResolvedVerificationPlan(base, plan, suggestions) } });
  const runtime = new BuildRuntime({
    runId,
    store,
    evidenceStore: evidence,
    workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
    integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: revision }) },
    maxConcurrency: 1,
    workspaceFor: async (task) => `C:/repair/${task.id}`,
    finalVerificationProfileFor: async () => base,
    finalVerificationWithPlan: async (profile, nextPlan) => withResolvedVerificationPlan(profile, nextPlan, suggestions),
    finalVerificationArchitectCommands: false,
    finalVerificationDriver: {
      executeCheck: async () => ({
        workspacePath: "C:/verify", startedAt: WHEN, finishedAt: WHEN,
        check: {
          checkId, kind: "tests", label: plan.checks[0]!.label, origin: "detected", mandatory: options.mandatory,
          outcome: "failed", green: false, evidenceIds: [], facts: [], issues: ["tests exited 1"],
        },
      }),
    },
    finalVerificationCleanupDriver: { cleanup: async () => ({ diagnosticsPath: "C:/diagnostics/known-defect.json" }) },
    architectDriver: {
      run: async (request) => {
        options.reasons.push(request.reason.type);
        const call: Call = async (name, args) => await request.tools.invoke(
          { type: "tool_call", callId: `${name}-${options.reasons.length}-${Math.random()}`, name, arguments: args }, request.context);
        if (request.reason.type === "final_verification_review_required" && options.onReview) {
          await options.onReview(call, request.reason as unknown as Record<string, unknown>);
          return;
        }
        if (request.reason.type === "completion_decision_required" && options.onCompletion) {
          await options.onCompletion(call);
          return;
        }
        throw new Error(`Unexpected Architect reason ${request.reason.type}`);
      },
    },
  });
  const close = () => {
    store.close();
    evidence.close();
  };
  return { store, runtime, plan, checkId, close };
}

test("a non-mandatory check failing at the repair limit becomes a known defect, and the Build goes on to its handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 vf8 known defect "));
  const runId = "run-vf8-known-defect";
  const revision = "f".repeat(40);
  const reasons: string[] = [];
  let checkId = "";
  const fixture = knownDefectRun(root, runId, revision, {
    mandatory: false,
    reasons,
    onReview: async (call, reason) => {
      const attempt = rebuildSchedulerProjection(fixture.store.readRun(runId)).finalVerification!.current!.submission!.attempt;
      const review = {
        taskId: reason.taskId, generationId: reason.generationId, targetRevision: reason.targetRevision,
        submissionId: reason.submissionId, attempt, decision: "approved",
        summary: "The only check failed at its repair limit and ships as a known defect.",
        architectRisk: "low", architectRiskRationale: "The handoff lists the failing tests for the owner.",
      };
      const reviewed = await call("review_final_verification", { ...review, checkReviews: [
        { checkId, verdict: "approved", rationale: "Ships as known.", evidenceIds: [] },
      ] });
      assert.equal(reviewed.isError, true, "a known defect is not reviewed");
      assert.equal(reviewed.error?.code, "final_verification_check_known_defect");
      const empty = await call("review_final_verification", { ...review, checkReviews: [] });
      assert.equal(empty.isError, false, empty.error?.message ?? "");
    },
    onCompletion: async (call) => {
      const tooLong = await call("complete_run", { summary: "Done.", leftToVerify: ["x".repeat(501)] });
      assert.equal(tooLong.isError, true, "a leftToVerify item has a length cap");
      const completed = await call("complete_run", {
        summary: "Done; the tests check still fails and ships as a known defect.",
        leftToVerify: ["the installer on macOS", "the installer on macOS "],
      });
      assert.equal(completed.isError, false, completed.error?.message ?? "");
    },
  });
  checkId = fixture.checkId;
  try {
    const { store, runtime } = fixture;
    const actions: string[] = [];
    const approved = () => rebuildSchedulerProjection(store.readRun(runId)).finalVerification?.current?.review?.status === "approved";
    for (let step = 0; step < 12 && !approved(); step += 1) {
      const result = await runtime.step();
      actions.push(result.action ?? result.status);
      assert.notEqual(result.status, "paused", `no pause: ${actions.join(", ")}`);
    }
    assert.equal(approved(), true, `${actions.join(", ")} / ${reasons.join(", ")}`);
    assert.ok(actions.includes("final_verification_known_defects_recorded"), actions.join(", "));
    assert.deepEqual(reasons, ["final_verification_review_required"], "the Architect is not asked to repair past the limit");
    assert.equal(store.readRun(runId).some((event) => event.type === "repair.cycle_limit_reached" || event.type === "repair.issue_paused"), false);
    const projection = rebuildSchedulerProjection(store.readRun(runId));
    const current = projection.finalVerification!.current!;
    assert.deepEqual(current.knownDefects, [{
      checkId, label: fixture.plan.checks[0]!.label,
      reason: "still failing at the repair limit: the run's repair-plan budget is used up (0 of 0 repair plans)",
    }]);
    assert.deepEqual((current.submissionResult as { knownDefectCheckIds?: string[] }).knownDefectCheckIds, [checkId]);
    assert.deepEqual(current.review?.decision?.checkReviews, []);
    assert.deepEqual(buildCompletionReadiness(projection).issues, []);
    // The kernel takes no known defect after the submission.
    assert.throws(() => store.append({ runId, type: "final_verification.known_defects_recorded", occurredAt: WHEN, actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "late", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, checks: [{ checkId, reason: "late" }] } }), /before any submission/);

    // The Architect completes; the handoff carries the known defect and what only the owner can check.
    const requested = () => rebuildSchedulerProjection(store.readRun(runId)).projectHandoff?.status === "requested";
    for (let step = 0; step < 6 && !requested(); step += 1) {
      const result = await runtime.step();
      actions.push(result.action ?? result.status);
    }
    assert.equal(requested(), true, `${actions.join(", ")} / ${reasons.join(", ")}`);
    const handoff = rebuildSchedulerProjection(store.readRun(runId));
    assert.deepEqual(handoff.projectHandoff?.verificationKnownDefects, current.knownDefects);
    assert.deepEqual(handoff.projectHandoff?.leftToVerify, ["the installer on macOS"]);
    assert.equal(handoff.projectHandoff?.knownDefects, undefined, "no review finding was shipped as known");
    // The snapshot at the handoff stop lists each once, and its digest verifies.
    const snapshot = renderHandoffSnapshot(handoffSnapshotInputFromProjection(handoff));
    assert.equal(verifyHandoffSnapshotDigest(snapshot), true);
    const label = fixture.plan.checks[0]!.label;
    assert.equal(snapshot.split(`- known defect: final verification ${label} — still failing at the repair limit:`).length, 2, snapshot);
    assert.equal(snapshot.split("- left for the owner to verify: the installer on macOS").length, 2, snapshot);
    assert.ok(snapshot.includes(`- final verification ${label}: failed (known defect at the repair limit);`), snapshot);
  } finally {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a mandatory check failing at the repair limit still pauses, and the kernel refuses it as a known defect", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 vf8 mandatory "));
  const runId = "run-vf8-mandatory";
  const revision = "9".repeat(40);
  const reasons: string[] = [];
  const fixture = knownDefectRun(root, runId, revision, { mandatory: true, reasons });
  try {
    const { store, runtime, checkId } = fixture;
    const actions: string[] = [];
    let last: BuildStepResult | undefined;
    for (let step = 0; step < 8 && last?.status !== "paused"; step += 1) {
      last = await runtime.step();
      actions.push(last.action ?? last.status);
    }
    assert.deepEqual(last, { status: "paused", action: "repair_cycle_limit_reached" }, actions.join(", "));
    assert.deepEqual(reasons, [], "the Architect is not asked to repair past the limit");
    const projection = rebuildSchedulerProjection(store.readRun(runId));
    assert.equal(projection.finalVerification?.current?.knownDefects, undefined);
    assert.equal(projection.finalVerification?.current?.submission, undefined);
    assert.throws(() => store.append({ runId, type: "final_verification.known_defects_recorded", occurredAt: WHEN, actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "forged", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, checks: [{ checkId, reason: "forged" }] } }), /is mandatory/);
    assert.throws(() => store.append({ runId, type: "final_verification.known_defects_recorded", occurredAt: WHEN, actor: { role: "architect", id: "architect" }, idempotencyKey: "architect", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, checks: [{ checkId, reason: "forged" }] } }), /Only the runner/);
  } finally {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});
