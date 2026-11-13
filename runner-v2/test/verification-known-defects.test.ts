/**
 * VF8 (VD-3): a non-mandatory v2 check at its repair limit becomes a known defect and the Build
 * goes on to its handoff; a mandatory one, a v1 run and a check with an external blocker still
 * pause. In memory: fake drivers, no process, no checkout (about 1 s), so required PR CI runs it
 * with the VF3 contract.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { projectFinalVerificationObservability } from "../src/build-observability.js";
import { BuildRuntime, type BuildStepResult } from "../src/build-runtime.js";
import type { FinalVerificationPlan } from "../src/final-verification-contracts.js";
import {
  verificationSuggestionsForProfile,
  withResolvedVerificationPlan,
  type FinalVerificationExecutionProfile,
} from "../src/final-verification-profile.js";
import {
  handoffNotVerifiedItems,
  handoffSnapshotInputFromProjection,
  renderHandoffSnapshot,
  verifyHandoffSnapshotDigest,
} from "../src/handoff-snapshot.js";
import { repairMemberIssues, withFailingIds } from "../src/repair-budget-contracts.js";
import {
  buildCompletionReadiness,
  finalVerificationKnownDefectReason,
  finalVerificationReviewAccepted,
  rebuildSchedulerProjection,
  type SchedulerProjection,
} from "../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import {
  completeVerificationPlanV2,
  factCategoryForMode,
  type VerificationCheckV2,
  type VerificationPlanV2,
} from "../src/verification-plan-v2.js";
import { acceptFinalVerificationProfile, emptyFinalVerificationProfile } from "./support/final-verification-profile.js";
import { FINAL_TASK_ID, GENERATION_ID, REVIEW_ID, WHEN, seedTasks, v1NotApplicablePlan } from "./support/verification-plan-v2-fixtures.js";

type ToolResult = { isError: boolean; error?: { message?: string; code?: string } };
type Call = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
/** `unproven`: the check's program was started, but its stop did not prove it stopped. */
type Outcome = "passed" | "failed" | "unproven";

/** An Architect-named check: `tests` runs a command, `start` starts a server on a leased port. */
interface ArchitectCheck {
  id: string;
  label: string;
  kind: "tests" | "start";
  outcome: Outcome;
  run?: { executable: string; args: string[] };
}

const WORKSPACE = "C:/verify";
const LIMIT_REASON = "the run's repair-plan budget is used up (0 of 0 repair plans)";

const keep = (check: VerificationCheckV2) => ({
  id: check.id,
  label: check.label,
  kind: check.kind,
  ...(check.run ? { run: check.run } : {}),
  ...(check.start ? { start: check.start } : {}),
});

const rootCauseOf = (checkId: string) => repairMemberIssues("fixture", [withFailingIds(checkId, new Map())])[0]!.rootCause;

/**
 * A run with one final-verification generation. By default its only check is the suggested `tests`
 * check, failing, with no repair plan left (the run's limit is 0). `checks` plans Architect-named
 * checks instead; `v1` uses the four categories.
 */
function knownDefectRun(root: string, runId: string, revision: string, options: {
  mandatory?: boolean;
  outcome?: Outcome;
  checks?: ArchitectCheck[];
  /** The run's repair-plan limit; null leaves the default. */
  repairPlanLimit?: number | null;
  v1?: boolean;
  /** v1 only: every category is not applicable, so the generation goes green to its review. */
  v1NotApplicable?: boolean;
  seed?: (store: SqliteSchedulerStore, checkId: string) => void;
  reasons: string[];
  onReview?: (call: Call, reason: Record<string, unknown>) => Promise<void>;
  onCompletion?: (call: Call) => Promise<void>;
  onRepairPlan?: (reason: Record<string, unknown>) => void;
}) {
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    evidenceStore: evidence, artifacts, validateCleanupReceipt: () => undefined, validateExecutionProfile: acceptFinalVerificationProfile,
  });
  const base: FinalVerificationExecutionProfile = {
    ...emptyFinalVerificationProfile(revision),
    detectedSignals: [{ category: "tests", source: "fixture", detail: "tests" }],
    commands: { tests: [{ label: "tests", executable: "fixture", args: [] }] },
  };
  // Only the Runner sets mandatory (VF4 reads it from aiboard-validation.json); here the suggestion carries it.
  const suggestions = verificationSuggestionsForProfile(base).map((suggestion) => ({
    check: { ...suggestion.check, mandatory: options.mandatory === true },
    resolved: { ...suggestion.resolved, mandatory: options.mandatory === true },
  }));
  let plan: VerificationPlanV2 | FinalVerificationPlan;
  let profile: FinalVerificationExecutionProfile;
  if (options.v1) {
    plan = options.v1NotApplicable
      ? v1NotApplicablePlan()
      : { checks: v1NotApplicablePlan().checks.map((check) => check.category === "tests" ? { category: "tests" as const, status: "required" as const } : check) };
    profile = options.v1NotApplicable ? emptyFinalVerificationProfile(revision) : base;
  } else if (options.checks) {
    plan = (completeVerificationPlanV2({
      checks: options.checks.map((check) => check.kind === "tests"
        ? { id: check.id, label: check.label, kind: "tests", run: check.run ?? { executable: "fixture", args: [check.id] } }
        : { id: check.id, label: check.label, kind: "start", start: { executable: "node", args: ["relay.js", "{port}"], ready: { http: { path: "/healthz", status: 200 } } } }),
      skipped: [],
    }, []) as { plan: VerificationPlanV2 }).plan;
    // A start check's {port} comes from the Runner's port lease for this run and revision.
    const empty = emptyFinalVerificationProfile(revision);
    profile = withResolvedVerificationPlan(empty, plan, verificationSuggestionsForProfile(empty), { version: 1, runId, targetRevision: revision, port: 41234, leaseId: "lease-relay" });
  } else {
    plan = (completeVerificationPlanV2(
      { checks: suggestions.map((suggestion) => keep(suggestion.check)), skipped: [] },
      suggestions.map((suggestion) => suggestion.check),
    ) as { plan: VerificationPlanV2 }).plan;
    profile = withResolvedVerificationPlan(base, plan, suggestions);
  }
  const checkId = "version" in plan ? plan.checks[0]!.id : "tests";
  const outcomeOf = (id: string): Outcome => options.checks?.find((check) => check.id === id)?.outcome ?? options.outcome ?? "failed";
  store.append({ runId, type: "run.initialized", occurredAt: WHEN, actor: { role: "runner", id: "runner" }, idempotencyKey: "init", payload: options.v1 ? {} : { verificationContractVersion: 2 } });
  if (options.repairPlanLimit !== null) {
    store.append({ runId, type: "repair.policy_configured", occurredAt: WHEN, actor: { role: "runner", id: "runner" }, idempotencyKey: "repair-policy", payload: { repairPlanLimit: options.repairPlanLimit ?? 0 } });
  }
  seedTasks(store, runId, revision);
  store.append({ runId, type: "final_verification.generation_created", occurredAt: WHEN, actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "generation", payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, planVersion: 1, plan, executionProfile: profile } });
  options.seed?.(store, checkId);

  // What the drivers did, in order; a start check's port lease ends with the generation's cleanup.
  const calls: string[] = [];
  let leaseReleased = false;
  const runtime = new BuildRuntime({
    runId,
    store,
    evidenceStore: evidence,
    artifacts,
    workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
    integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: revision }) },
    maxConcurrency: 1,
    workspaceFor: async (task) => `C:/repair/${task.id}`,
    finalVerificationProfileFor: async () => base,
    finalVerificationWithPlan: async (current, nextPlan) => withResolvedVerificationPlan(current, nextPlan, suggestions),
    finalVerificationArchitectCommands: false,
    finalVerificationDriver: {
      executeCheck: async (input) => {
        const key = input.checkId ?? input.category;
        calls.push(`execute:${key}`);
        const timing = { workspacePath: WORKSPACE, startedAt: WHEN, finishedAt: WHEN };
        if (options.v1) {
          const planned = (plan as FinalVerificationPlan).checks.find((check) => check.category === input.category)!;
          const failed = planned.status === "required";
          return { ...timing, check: { ...planned, green: !failed, evidenceIds: [], facts: [], issues: failed ? ["tests exited 1"] : [] } };
        }
        const resolved = input.executionProfile.verification!.checks.find((check) => check.checkId === key)!;
        if (resolved.mode === "program" && leaseReleased) {
          throw new Error(`the port lease for ${key} was released with the generation's cleanup`);
        }
        const identity = { checkId: key, kind: resolved.kind, label: resolved.label, origin: resolved.origin, mandatory: resolved.mandatory };
        if (outcomeOf(key) === "failed") {
          return { ...timing, check: { ...identity, outcome: "failed", green: false, evidenceIds: [], facts: [], issues: [`${resolved.label} exited 1`] } };
        }
        // A passed check carries one recorded command fact per planned command; an unproven one
        // the same facts, with the cleanup not proven.
        const unproven = outcomeOf(key) === "unproven";
        const program = resolved.mode === "program";
        const stdout = await artifacts.put(Buffer.from("ok" + String.fromCharCode(10)), "text/plain", "stdout");
        const stderr = await artifacts.put(Buffer.from(""), "text/plain", "stderr");
        const facts = resolved.commands.map((command, index) => ({
          kind: "command" as const,
          checkId: key,
          category: factCategoryForMode(resolved.mode),
          label: command.label,
          command: command.executable,
          executable: command.executable,
          args: [...command.args],
          cwd: WORKSPACE,
          startedAt: WHEN,
          finishedAt: WHEN,
          exitCode: program && index === 0 ? null : resolved.mode === "exit" && index === 0 ? resolved.expectedExitCode ?? 0 : 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          outputTruncated: false,
          stdoutArtifactHash: stdout.hash,
          stderrArtifactHash: stderr.hash,
          targetRevision: revision,
          repositoryRevision: revision,
          startState: { revision, status: "clean" },
          endState: { revision, status: "clean" },
          ...(index > 0 ? { workflowStep: true as const } : {}),
          ...(program ? { endpoint: resolved.endpoint } : {}),
          ...(program && index === 0 ? { readinessSatisfied: true, cleanupRequested: true, cleanupSucceeded: !unproven } : {}),
        }));
        const evidenceIds = facts.map((fact, index) => evidence.record({
          runId, taskId: FINAL_TASK_ID, actor: { role: "worker", id: "final-verification" }, fact,
          createdAt: WHEN, idempotencyKey: `${GENERATION_ID}:${key}:${index}`, attempt: 1,
        }).id);
        if (unproven) {
          return { ...timing, check: { ...identity, outcome: "failed", green: false, evidenceIds, facts, issues: [`${resolved.label} process cleanup failed: the stop did not prove it stopped.`] } };
        }
        return { ...timing, check: { ...identity, outcome: "passed", green: true, evidenceIds, facts, issues: [] } };
      },
    },
    finalVerificationCleanupDriver: {
      cleanup: async () => {
        calls.push("cleanup");
        leaseReleased = true;
        return { diagnosticsPath: "C:/diagnostics/known-defect.json" };
      },
    },
    architectDriver: {
      run: async (request) => {
        options.reasons.push(request.reason.type);
        const call: Call = async (name, args) => await request.tools.invoke(
          { type: "tool_call", callId: `${name}-${options.reasons.length}-${Math.random()}`, name, arguments: args }, request.context);
        const reason = request.reason as unknown as Record<string, unknown>;
        if (request.reason.type === "final_verification_review_required" && options.onReview) {
          await options.onReview(call, reason);
          return;
        }
        if (request.reason.type === "completion_decision_required" && options.onCompletion) {
          await options.onCompletion(call);
          return;
        }
        if (request.reason.type === "final_verification_repair_plan_required" && options.onRepairPlan) {
          options.onRepairPlan(reason);
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
  return { store, runtime, plan, checkId, calls, close };
}

/** Steps until `done`, a pause or an error; returns the actions taken. */
async function stepUntil(runtime: BuildRuntime, done: () => boolean, limit = 16): Promise<{ actions: string[]; last?: BuildStepResult; error?: string }> {
  const actions: string[] = [];
  let last: BuildStepResult | undefined;
  for (let step = 0; step < limit && !done(); step += 1) {
    try {
      last = await runtime.step();
    } catch (error) {
      return { actions, ...(last ? { last } : {}), error: error instanceof Error ? error.message : String(error) };
    }
    actions.push(last.action ?? last.status);
    if (last.status === "paused") break;
  }
  return { actions, ...(last ? { last } : {}) };
}

function reviewArgs(projection: SchedulerProjection, reason: Record<string, unknown>, decision: "approved" | "repair_required", summary: string) {
  return {
    taskId: reason.taskId, generationId: reason.generationId, targetRevision: reason.targetRevision,
    submissionId: reason.submissionId, attempt: projection.finalVerification!.current!.submission!.attempt, decision,
    summary, architectRisk: "low", architectRiskRationale: "The handoff lists every check that was not verified.",
  };
}

function evidenceOf(projection: SchedulerProjection, checkId: string): string[] {
  const completed = projection.finalVerification!.current!.completedChecks ?? [];
  return [...(completed.find((check) => "checkId" in check && check.checkId === checkId)?.evidenceIds ?? [])];
}

const forge = (
  revision: string,
  source: "failure" | "review",
  checkId: string,
  actor: "runner" | "architect" = "runner",
  limit: Record<string, unknown> = { kind: "run_budget" },
) => ({
  runId: "", type: "final_verification.known_defects_recorded" as const, occurredAt: WHEN,
  actor: { role: actor, id: actor === "runner" ? "build-runtime" : "architect" }, idempotencyKey: `forged-${source}-${actor}`,
  payload: { taskId: FINAL_TASK_ID, generationId: GENERATION_ID, targetRevision: revision, source, checks: [{ checkId, limit, reason: "forged" }] },
});

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
      const review = reviewArgs(rebuildSchedulerProjection(fixture.store.readRun(runId)), reason, "approved", "The only check failed at its repair limit and ships as a known defect.");
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
    const approved = () => rebuildSchedulerProjection(store.readRun(runId)).finalVerification?.current?.review?.status === "approved";
    const run = await stepUntil(runtime, approved);
    assert.equal(run.error, undefined, run.error ?? "");
    assert.notEqual(run.last?.status, "paused", `no pause: ${run.actions.join(", ")}`);
    assert.equal(approved(), true, `${run.actions.join(", ")} / ${reasons.join(", ")}`);
    assert.ok(run.actions.includes("final_verification_known_defects_recorded"), run.actions.join(", "));
    assert.deepEqual(reasons, ["final_verification_review_required"], "the Architect is not asked to repair past the limit");
    assert.equal(store.readRun(runId).some((event) => event.type === "repair.cycle_limit_reached" || event.type === "repair.issue_paused"), false);
    const projection = rebuildSchedulerProjection(store.readRun(runId));
    const current = projection.finalVerification!.current!;
    assert.deepEqual(current.knownDefects, [{
      checkId, label: (fixture.plan as VerificationPlanV2).checks[0]!.label,
      reason: `still failing at the repair limit: ${LIMIT_REASON}`,
      source: "failure",
      limit: { kind: "run_budget", used: 0, limit: 0 },
    }]);
    assert.deepEqual((current.submissionResult as { knownDefectCheckIds?: string[] }).knownDefectCheckIds, [checkId]);
    assert.deepEqual(current.review?.decision?.checkReviews, []);
    assert.deepEqual(buildCompletionReadiness(projection).issues, []);
    // The kernel takes no known defect after the submission.
    assert.throws(() => store.append({ ...forge(revision, "failure", checkId), runId }), /before any submission/);

    // The Architect completes; the handoff carries the known defect and what only the owner can check.
    const requested = () => rebuildSchedulerProjection(store.readRun(runId)).projectHandoff?.status === "requested";
    const completion = await stepUntil(runtime, requested, 6);
    assert.equal(requested(), true, `${completion.actions.join(", ")} / ${reasons.join(", ")}`);
    const handoff = rebuildSchedulerProjection(store.readRun(runId));
    assert.deepEqual(handoff.projectHandoff?.verificationKnownDefects, current.knownDefects);
    assert.deepEqual(handoff.projectHandoff?.leftToVerify, ["the installer on macOS"]);
    assert.equal(handoff.projectHandoff?.knownDefects, undefined, "no review finding was shipped as known");
    // The snapshot at the handoff stop lists each once, and its digest verifies.
    const snapshot = renderHandoffSnapshot(handoffSnapshotInputFromProjection(handoff));
    assert.equal(verifyHandoffSnapshotDigest(snapshot), true);
    const label = (fixture.plan as VerificationPlanV2).checks[0]!.label;
    assert.equal(snapshot.split(`- known defect: final verification ${label} — still failing at the repair limit:`).length, 2, snapshot);
    assert.equal(snapshot.split("- left for the owner to verify: the installer on macOS").length, 2, snapshot);
    assert.ok(snapshot.includes(`- final verification ${label}: failed (known defect at the repair limit);`), snapshot);
    // The final card and Run details list exactly the snapshot's items.
    assert.deepEqual(handoff.projectHandoff?.notVerified, handoffNotVerifiedItems(handoff));
    assert.deepEqual(projectFinalVerificationObservability(handoff).notVerified, handoff.projectHandoff?.notVerified);
    assert.deepEqual(handoff.projectHandoff?.notVerified?.map((item) => item.kind), ["known_defect", "left_to_verify"]);

    // Replay compares the limit's kind and identity, never its display text: a recorded event
    // whose wording differs from today's replays to the same known defect.
    const events = store.readRun(runId);
    const reworded = events.map((event) => event.type !== "final_verification.known_defects_recorded" ? event : {
      ...event,
      payload: { ...event.payload, checks: (event.payload.checks as Array<Record<string, unknown>>).map((check) => ({ ...check, reason: "an older wording of the limit" })) },
    });
    assert.deepEqual(rebuildSchedulerProjection(reworded).finalVerification?.current?.knownDefects, current.knownDefects);
    const unworded = events.map((event) => event.type !== "final_verification.known_defects_recorded" ? event : {
      ...event,
      payload: { ...event.payload, checks: (event.payload.checks as Array<Record<string, unknown>>).map(({ reason: _reason, ...check }) => check) },
    });
    assert.deepEqual(rebuildSchedulerProjection(unworded).finalVerification?.current?.knownDefects, current.knownDefects);
    // It still fails closed: a limit the check did not reach does not replay.
    const forged = events.map((event) => event.type !== "final_verification.known_defects_recorded" ? event : {
      ...event,
      payload: { ...event.payload, checks: (event.payload.checks as Array<Record<string, unknown>>).map((check) => ({ ...check, limit: { kind: "task_attempts", taskId: FINAL_TASK_ID } })) },
    });
    assert.throws(() => rebuildSchedulerProjection(forged), /has not reached a repair limit \(task_attempts\)/);
  } finally {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a known defect that is not the last check: every check runs before the one cleanup, and each later failure is reported", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 vf8 known defect first "));
  const runId = "run-vf8-known-defect-first";
  const revision = "e".repeat(40);
  const reasons: string[] = [];
  const fixture = knownDefectRun(root, runId, revision, {
    // Two checks share the label "tests"; the Not verified items are keyed by check id.
    checks: [
      { id: "py-tests", label: "tests", kind: "tests", outcome: "failed", run: { executable: "python", args: ["-m", "pytest"] } },
      { id: "relay", label: "relay server", kind: "start", outcome: "passed" },
      { id: "rs-tests", label: "tests", kind: "tests", outcome: "failed", run: { executable: "cargo", args: ["test"] } },
    ],
    reasons,
    onReview: async (call, reason) => {
      const projection = rebuildSchedulerProjection(fixture.store.readRun(runId));
      const reviewed = await call("review_final_verification", {
        ...reviewArgs(projection, reason, "approved", "The relay starts; both test suites ship as known defects."),
        checkReviews: [{ checkId: "relay", verdict: "approved", rationale: "The relay answered its health check.", evidenceIds: evidenceOf(projection, "relay") }],
      });
      assert.equal(reviewed.isError, false, reviewed.error?.message ?? "");
    },
    onCompletion: async (call) => {
      const completed = await call("complete_run", { summary: "Done; both test suites still fail." });
      assert.equal(completed.isError, false, completed.error?.message ?? "");
    },
  });
  try {
    const { store, runtime, calls } = fixture;
    const requested = () => rebuildSchedulerProjection(store.readRun(runId)).projectHandoff?.status === "requested";
    const run = await stepUntil(runtime, requested, 24);
    assert.equal(run.error, undefined, `${run.error} / ${run.actions.join(", ")}`);
    assert.equal(requested(), true, `${run.actions.join(", ")} / ${reasons.join(", ")}`);
    // Every planned check ran before the cleanup, the cleanup ran once, and nothing ran after it.
    assert.deepEqual(calls, ["execute:py-tests", "execute:relay", "execute:rs-tests", "cleanup"]);
    const events = store.readRun(runId);
    const failureAt = events.findIndex((event) => event.type === "final_verification.failure_reported");
    assert.ok(failureAt > 0);
    assert.deepEqual(events.flatMap((event, index) => event.type === "final_verification.check_completed" && index > failureAt ? [index] : []), []);
    const handoff = rebuildSchedulerProjection(events);
    const current = handoff.finalVerification!.current!;
    assert.deepEqual(current.failure?.failedCheckIds, ["py-tests", "rs-tests"], "the failure names every failed check");
    assert.deepEqual(current.knownDefects?.map((defect) => [defect.checkId, defect.reason]), [
      ["py-tests", `still failing at the repair limit: ${LIMIT_REASON}`],
      ["rs-tests", `still failing at the repair limit: ${LIMIT_REASON}`],
    ]);
    assert.equal(current.repairTaskIds, undefined);
    assert.deepEqual(reasons, ["final_verification_review_required", "completion_decision_required"]);
    // Each check is listed once, by id, though both are labelled "tests".
    const snapshot = renderHandoffSnapshot(handoffSnapshotInputFromProjection(handoff));
    assert.equal(verifyHandoffSnapshotDigest(snapshot), true);
    for (const id of ["py-tests", "rs-tests"]) {
      assert.equal(snapshot.split(`- known defect: final verification tests (${id}) — still failing at the repair limit:`).length, 2, snapshot);
    }
    assert.match(snapshot, /not verified: 2 total \(0 not run, 0 skipped, 2 known defects, 0 Architect overrides, 0 left for the owner\)/);
    assert.deepEqual(handoff.projectHandoff?.notVerified?.map((item) => item.key), ["check:py-tests", "check:rs-tests"]);
    assert.deepEqual(handoff.projectHandoff?.notVerified, handoffNotVerifiedItems(handoff));
    assert.deepEqual(projectFinalVerificationObservability(handoff).notVerified, handoff.projectHandoff?.notVerified);
  } finally {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a check whose own repair issue is used up is a known defect, while a later failure still gets its repair", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 vf8 issue limit "));
  const runId = "run-vf8-issue-limit";
  const revision = "d".repeat(40);
  const reasons: string[] = [];
  const repairReasons: Record<string, unknown>[] = [];
  const fixture = knownDefectRun(root, runId, revision, {
    checks: [
      { id: "py-tests", label: "tests", kind: "tests", outcome: "failed", run: { executable: "python", args: ["-m", "pytest"] } },
      { id: "relay", label: "relay server", kind: "start", outcome: "passed" },
      { id: "rs-tests", label: "tests", kind: "tests", outcome: "failed", run: { executable: "cargo", args: ["test"] } },
    ],
    // The run's own budget is not used up; py-tests' repair issue is.
    repairPlanLimit: null,
    seed: (store) => {
      store.append({ runId, type: "repair.issue_recorded", occurredAt: WHEN, actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "issue-py", payload: { issueId: "issue-py", rootCause: rootCauseOf("py-tests"), limit: 1 } });
      store.append({ runId, type: "repair.cycle_recorded", occurredAt: WHEN, actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "cycle-py", payload: { issueId: "issue-py", hypothesis: "pin the pytest version", outcome: "still_failing", evidenceIds: ["earlier-evidence"] } });
    },
    reasons,
    onRepairPlan: (reason) => repairReasons.push(reason),
  });
  try {
    const { store, runtime, calls } = fixture;
    const run = await stepUntil(runtime, () => repairReasons.length > 0, 16);
    assert.equal(repairReasons.length, 1, `${run.error} / ${run.actions.join(", ")} / ${reasons.join(", ")}`);
    assert.deepEqual(repairReasons[0]!.failedCheckIds, ["rs-tests"], "the repair covers only the check with repairs left");
    assert.deepEqual(calls, ["execute:py-tests", "execute:relay", "execute:rs-tests", "cleanup"]);
    const projection = rebuildSchedulerProjection(store.readRun(runId));
    const current = projection.finalVerification!.current!;
    assert.deepEqual(current.failure?.failedCheckIds, ["py-tests", "rs-tests"]);
    assert.deepEqual(current.knownDefects, [{
      checkId: "py-tests", label: "tests", source: "failure",
      reason: `still failing at the repair limit: issue ${rootCauseOf("py-tests")} used 1/1 repair cycles`,
      limit: { kind: "issue", issueId: "issue-py", rootCause: rootCauseOf("py-tests"), used: 1, limit: 1 },
    }]);
    // The kernel's rule, for the check that still has repairs: no limit yet, until the
    // verification task's recorded attempt limit is used up.
    assert.equal(finalVerificationKnownDefectReason(projection, current, "rs-tests", "failure"), undefined);
    const task = projection.tasks[FINAL_TASK_ID] ?? ({ id: FINAL_TASK_ID, attempt: 1 } as SchedulerProjection["tasks"][string]);
    const attemptsUsed: SchedulerProjection = { ...projection, tasks: { ...projection.tasks, [FINAL_TASK_ID]: { ...task, attemptLimit: task.attempt } } };
    assert.equal(
      finalVerificationKnownDefectReason(attemptsUsed, current, "rs-tests", "failure"),
      `still failing at the repair limit: final verification task ${FINAL_TASK_ID} used ${task.attempt}/${task.attempt} attempts`,
    );
    assert.equal(finalVerificationKnownDefectReason(attemptsUsed, current, "relay", "failure"), undefined, "a passed check is no known defect");
    assert.equal(finalVerificationKnownDefectReason(attemptsUsed, current, "rs-tests", "review"), undefined, "there is no review yet");
    assert.throws(() => store.append({ ...forge(revision, "failure", "rs-tests"), runId }), /has not reached a repair limit \(run_budget\)/);
    assert.throws(() => store.append({ ...forge(revision, "failure", "rs-tests", "runner", { kind: "issue", issueId: "issue-py" }), runId }), /has not reached a repair limit \(issue\)/, "py-tests' issue is not rs-tests' limit");
    assert.throws(() => store.append({ ...forge(revision, "failure", "rs-tests", "runner", { kind: "nonsense" }), runId }), /must name the repair limit/);
  } finally {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a check with a recorded external blocker is no known defect: the run still pauses for the owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 vf8 external blocker "));
  const runId = "run-vf8-external-blocker";
  const revision = "c".repeat(40);
  const reasons: string[] = [];
  const fixture = knownDefectRun(root, runId, revision, {
    mandatory: false,
    reasons,
    seed: (store, checkId) => {
      store.append({ runId, type: "repair.issue_recorded", occurredAt: WHEN, actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "issue-tests", payload: { issueId: "issue-tests", rootCause: rootCauseOf(checkId), limit: 1 } });
      store.append({ runId, type: "repair.external_blocker_recorded", occurredAt: WHEN, actor: { role: "architect", id: "architect" }, idempotencyKey: "blocker", payload: { issueId: "issue-tests", acceptanceCondition: "The test database is reachable.", evidence: ["connection refused"], attemptedResolutions: ["retried the connection"], requiredOwnerAction: "Start the test database." } });
    },
  });
  try {
    const { store, runtime, checkId } = fixture;
    const run = await stepUntil(runtime, () => false, 10);
    assert.equal(run.error, undefined, run.error ?? "");
    assert.equal(run.last?.status, "paused", run.actions.join(", "));
    const projection = rebuildSchedulerProjection(store.readRun(runId));
    assert.equal(projection.finalVerification?.current?.knownDefects, undefined);
    assert.equal(finalVerificationKnownDefectReason(projection, projection.finalVerification!.current!, checkId, "failure"), undefined);
    assert.throws(() => store.append({ ...forge(revision, "failure", checkId), runId }), /has not reached a repair limit/);
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
    const run = await stepUntil(runtime, () => false, 8);
    assert.deepEqual(run.last, { status: "paused", action: "repair_cycle_limit_reached" }, run.actions.join(", "));
    assert.deepEqual(reasons, [], "the Architect is not asked to repair past the limit");
    const projection = rebuildSchedulerProjection(store.readRun(runId));
    assert.equal(projection.finalVerification?.current?.knownDefects, undefined);
    assert.equal(projection.finalVerification?.current?.submission, undefined);
    assert.throws(() => store.append({ ...forge(revision, "failure", checkId), runId }), /is mandatory/);
    assert.throws(() => store.append({ ...forge(revision, "failure", checkId, "architect"), runId }), /Only the runner/);
  } finally {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a review that asks to repair a non-mandatory check at the repair limit records a known defect, and the Build finishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 vf8 review known defect "));
  const runId = "run-vf8-review-known-defect";
  const revision = "b".repeat(40);
  const reasons: string[] = [];
  let checkId = "";
  const fixture = knownDefectRun(root, runId, revision, {
    mandatory: false,
    outcome: "passed",
    reasons,
    onReview: async (call, reason) => {
      const projection = rebuildSchedulerProjection(fixture.store.readRun(runId));
      const reviewed = await call("review_final_verification", {
        ...reviewArgs(projection, reason, "repair_required", "The tests pass but assert nothing about the total."),
        checkReviews: [{ checkId, verdict: "repair_required", rationale: "The tests do not check the printed total.", evidenceIds: evidenceOf(projection, checkId) }],
      });
      assert.equal(reviewed.isError, false, reviewed.error?.message ?? "");
    },
    onCompletion: async (call) => {
      const completed = await call("complete_run", { summary: "Done; the tests check is a known defect." });
      assert.equal(completed.isError, false, completed.error?.message ?? "");
    },
  });
  checkId = fixture.checkId;
  try {
    const { store, runtime } = fixture;
    const requested = () => rebuildSchedulerProjection(store.readRun(runId)).projectHandoff?.status === "requested";
    const run = await stepUntil(runtime, requested, 16);
    assert.equal(run.error, undefined, `${run.error} / ${run.actions.join(", ")}`);
    assert.equal(requested(), true, `${run.actions.join(", ")} / ${reasons.join(", ")}`);
    assert.deepEqual(reasons, ["final_verification_review_required", "completion_decision_required"], "no repair is asked for past the limit");
    const handoff = rebuildSchedulerProjection(store.readRun(runId));
    const current = handoff.finalVerification!.current!;
    assert.equal(current.review?.status, "repair_required");
    assert.equal(finalVerificationReviewAccepted(current), true);
    assert.equal(current.repairTaskIds, undefined);
    assert.deepEqual(current.knownDefects, [{
      checkId, label: (fixture.plan as VerificationPlanV2).checks[0]!.label, source: "review",
      reason: `the Architect's review still asks for a repair at the repair limit: ${LIMIT_REASON}`,
      limit: { kind: "run_budget", used: 0, limit: 0 },
    }]);
    assert.deepEqual(handoff.projectHandoff?.verificationKnownDefects, current.knownDefects);
    assert.equal(projectFinalVerificationObservability(handoff).current?.review.acceptedWithKnownDefects, true);
    const snapshot = renderHandoffSnapshot(handoffSnapshotInputFromProjection(handoff));
    assert.equal(verifyHandoffSnapshotDigest(snapshot), true);
    const label = (fixture.plan as VerificationPlanV2).checks[0]!.label;
    assert.ok(snapshot.includes(`- final verification ${label}: passed; the Architect's review asked for a repair (known defect at the repair limit)`), snapshot);
    assert.equal(snapshot.split(`- known defect: final verification ${label} — the Architect's review still asks for a repair`).length, 2, snapshot);
    // A review-source known defect is recorded once; a different limit for it conflicts.
    assert.throws(() => store.append({ ...forge(revision, "review", checkId, "runner", { kind: "issue", issueId: "another" }), runId }), /conflicts with the recorded one/);
  } finally {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a review that asks to repair a mandatory check at the repair limit still pauses", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 vf8 review mandatory "));
  const runId = "run-vf8-review-mandatory";
  const revision = "a".repeat(40);
  const reasons: string[] = [];
  let checkId = "";
  const fixture = knownDefectRun(root, runId, revision, {
    mandatory: true,
    outcome: "passed",
    reasons,
    onReview: async (call, reason) => {
      const projection = rebuildSchedulerProjection(fixture.store.readRun(runId));
      const reviewed = await call("review_final_verification", {
        ...reviewArgs(projection, reason, "repair_required", "The tests pass but assert nothing about the total."),
        checkReviews: [{ checkId, verdict: "repair_required", rationale: "The tests do not check the printed total.", evidenceIds: evidenceOf(projection, checkId) }],
      });
      assert.equal(reviewed.isError, false, reviewed.error?.message ?? "");
    },
  });
  checkId = fixture.checkId;
  try {
    const { store, runtime } = fixture;
    const run = await stepUntil(runtime, () => false, 12);
    assert.deepEqual(run.last, { status: "paused", action: "repair_cycle_limit_reached" }, `${run.error} / ${run.actions.join(", ")}`);
    const projection = rebuildSchedulerProjection(store.readRun(runId));
    assert.equal(projection.finalVerification?.current?.knownDefects, undefined);
    assert.equal(finalVerificationReviewAccepted(projection.finalVerification!.current!), false);
    assert.throws(() => store.append({ ...forge(revision, "review", checkId), runId }), /is mandatory/);
  } finally {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a v1 run at the repair limit pauses as before, and the kernel takes no known defect on it", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 vf8 v1 "));
  const runId = "run-vf8-v1";
  const revision = "8".repeat(40);
  const reasons: string[] = [];
  const fixture = knownDefectRun(root, runId, revision, { v1: true, reasons });
  try {
    const { store, runtime } = fixture;
    const run = await stepUntil(runtime, () => false, 10);
    assert.deepEqual(run.last, { status: "paused", action: "repair_cycle_limit_reached" }, `${run.error} / ${run.actions.join(", ")}`);
    assert.deepEqual(reasons, []);
    const projection = rebuildSchedulerProjection(store.readRun(runId));
    assert.equal(projection.finalVerification?.current?.knownDefects, undefined);
    assert.throws(() => store.append({ ...forge(revision, "failure", "tests"), runId }), /Only a v2 final verification/);
  } finally {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a start check whose program was not proven stopped ends the generation there: no later check, no known defect", async () => {
  for (const [name, checks, ran] of [
    ["before another check", [
      { id: "relay", label: "relay server", kind: "start", outcome: "unproven" },
      { id: "py-tests", label: "tests", kind: "tests", outcome: "failed", run: { executable: "python", args: ["-m", "pytest"] } },
    ], ["execute:relay", "cleanup"]],
    ["as the last check", [
      { id: "py-tests", label: "tests", kind: "tests", outcome: "failed", run: { executable: "python", args: ["-m", "pytest"] } },
      { id: "relay", label: "relay server", kind: "start", outcome: "unproven" },
    ], ["execute:py-tests", "execute:relay", "cleanup"]],
  ] as Array<[string, ArchitectCheck[], string[]]>) {
    const root = mkdtempSync(join(tmpdir(), "runner-v2 vf8 unproven "));
    const runId = `run-vf8-unproven-${ran.length}`;
    const revision = "7".repeat(40);
    const reasons: string[] = [];
    const fixture = knownDefectRun(root, runId, revision, { checks, reasons });
    try {
      const { store, runtime, calls } = fixture;
      const run = await stepUntil(runtime, () => false, 12);
      assert.deepEqual(run.last, { status: "paused", action: "repair_cycle_limit_reached" }, `${name}: ${run.error} / ${run.actions.join(", ")}`);
      // No check ran beside the program that may still be running, and the generation was cleaned up.
      assert.deepEqual(calls, ran, name);
      assert.deepEqual(reasons, [], name);
      const projection = rebuildSchedulerProjection(store.readRun(runId));
      const current = projection.finalVerification!.current!;
      assert.equal(current.cleanup?.status, "succeeded", name);
      assert.equal(current.knownDefects, undefined, `${name}: a generation with an unproven program records no known defect`);
      for (const checkId of current.failure?.failedCheckIds ?? []) {
        assert.equal(finalVerificationKnownDefectReason(projection, current, checkId, "failure"), undefined, `${name}: ${checkId}`);
        assert.throws(() => store.append({ ...forge(revision, "failure", checkId), runId }), /has not reached a repair limit/, `${name}: ${checkId}`);
      }
    } finally {
      fixture.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a legacy v1 approval with no structured decision still reaches the completion turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 vf8 v1 legacy approval "));
  const runId = "run-vf8-v1-legacy-approval";
  const revision = "6".repeat(40);
  const reasons: string[] = [];
  const fixture = knownDefectRun(root, runId, revision, {
    v1: true,
    v1NotApplicable: true,
    reasons,
    onReview: async (_call, reason) => {
      // Before VF3, a v1 review could approve without categoryReviews: no structured decision.
      fixture.store.append({
        runId, type: "final_verification.review_decided", occurredAt: WHEN, actor: { role: "architect", id: "architect" },
        idempotencyKey: "legacy-approval",
        payload: {
          taskId: reason.taskId, generationId: reason.generationId, targetRevision: reason.targetRevision,
          submissionId: reason.submissionId, reviewId: REVIEW_ID, attempt: 1, decision: "approved",
          summary: "Nothing applies to this revision.",
        },
      });
    },
    // The completion turn is reached; this fixture's Architect takes no action there.
    onCompletion: async () => undefined,
  });
  try {
    const { store, runtime } = fixture;
    const run = await stepUntil(runtime, () => reasons.includes("completion_decision_required"), 12);
    const current = rebuildSchedulerProjection(store.readRun(runId)).finalVerification!.current!;
    assert.equal(current.review?.status, "approved", `${run.error} / ${run.actions.join(", ")}`);
    assert.equal(current.review?.decision, undefined, "the approval is the legacy unstructured one");
    assert.deepEqual(reasons, ["final_verification_review_required", "completion_decision_required"], `${run.error} / ${run.actions.join(", ")}`);
    assert.doesNotMatch(run.error ?? "", /review request was not durably recorded/);
  } finally {
    fixture.close();
    rmSync(root, { recursive: true, force: true });
  }
});
