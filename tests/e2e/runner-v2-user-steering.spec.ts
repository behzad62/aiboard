import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { classifyBuildNoteDelivery } from "../../lib/client/build-notes";
import {
  answerNativeArchitectQuestion,
  getNativeBuild,
  submitNativeBuildUserGuidance,
} from "../../lib/client/runner-v2";
import { BuildRuntime } from "../../runner-v2/src/build-runtime.js";
import { BuildRuntimeRegistry } from "../../runner-v2/src/build-runtime-registry.js";
import { ControlServer } from "../../runner-v2/src/control-server.js";
import {
  buildCompletionReadiness,
  rebuildSchedulerProjection,
  type SchedulerStore,
} from "../../runner-v2/src/scheduler-store.js";
import { RunSupervisor } from "../../runner-v2/src/run-supervisor.js";
import { SqliteEventStore } from "../../runner-v2/src/sqlite-event-store.js";
import { SqliteSchedulerStore } from "../../runner-v2/src/sqlite-scheduler-store.js";
import { emptyFinalVerificationProfile } from "../../runner-v2/test/support/final-verification-profile.js";

const RUN_ID = "run-user-steering-e2e";
const TOKEN = "runner-v2-user-steering-e2e-token";
const OBJECTIVE = "Build the exact requested application.\nPreserve this byte-for-byte.\n";

test.describe("Runner V2 durable user steering", () => {
  test("browser client reload, exact answer, guidance retry, and WAL restart preserve one durable lifecycle", async ({ page }) => {
    const root = mkdtempSync(join(tmpdir(), "runner-v2-user-steering-e2e-"));
    const schedulerPath = join(root, "scheduler.sqlite");
    const eventsPath = join(root, "events.sqlite");
    let scheduler = new SqliteSchedulerStore(schedulerPath);
    const supervisor = new RunSupervisor(new SqliteEventStore(eventsPath));
    let server: ControlServer | undefined;
    try {
      const runtime = new BuildRuntime({
        runId: RUN_ID,
        initialObjective: OBJECTIVE,
        store: scheduler,
        workerDriver: { run: async () => ({ type: "paused" as const, reason: "unused" }) },
        architectDriver: { run: async () => undefined },
        integrationDriver: { integrate: async () => ({ status: "integrated" as const, integrationRevision: "unused" }) },
        maxConcurrency: 1,
        workspaceFor: async () => "C:/unused",
        clock: () => "2026-08-27T00:00:00.000Z",
      });
      const checkpointSequence = runtime.projection().lastSequence;
      scheduler.append({
        runId: RUN_ID,
        type: "architect.question_requested",
        occurredAt: "2026-08-27T00:00:01.000Z",
        actor: { role: "architect", id: "architect-e2e" },
        idempotencyKey: "question:e2e",
        payload: {
          questionId: "question-e2e",
          question: "Which external authority should approve this dependency?",
          version: 1,
          decisionKind: "authority_decision",
          checkpoint: { reason: { type: "plan_required" }, sequence: checkpointSequence },
        },
      });
      const registry = new BuildRuntimeRegistry();
      registry.register(runtime);
      server = new ControlServer({
        supervisor,
        token: TOKEN,
        bootstrapRun: async () => ({
          baselineRevision: "a".repeat(40),
          baselineRef: "refs/aiboard/runs/e2e/baseline",
        }),
        builds: registry,
      });
      const address = await server.start(0);
      const connection = { url: address.url, token: TOKEN };

      const firstLoad = await getNativeBuild(connection, RUN_ID);
      const reload = await getNativeBuild(connection, RUN_ID);
      expect(firstLoad.blockingArchitectQuestionId).toBe("question-e2e");
      expect(reload.architectQuestions?.["question-e2e"]?.status).toBe("open");
      await page.setContent(renderSteeringPanel(reload));
      await expect(page.getByRole("heading", { name: "Architect needs your decision" })).toBeVisible();
      await expect(page.getByText("Which external authority should approve this dependency?")).toBeVisible();
      await expect(page.getByRole("textbox", { name: "Your decision" })).toBeVisible();

      const answer = {
        expectedVersion: 1,
        answer: "Use the documented project owner.",
        idempotencyKey: "question:e2e:answer",
      };
      await answerNativeArchitectQuestion(connection, RUN_ID, "question-e2e", answer);
      await answerNativeArchitectQuestion(connection, RUN_ID, "question-e2e", answer);
      await expect(answerNativeArchitectQuestion(connection, RUN_ID, "question-e2e", {
        ...answer,
        expectedVersion: 2,
        idempotencyKey: "question:e2e:stale-answer",
      })).rejects.toThrow(/version|answered|open|conflict/i);

      const guidance = {
        guidanceId: "guidance-e2e",
        text: "Include the restart-safe edge case.",
        idempotencyKey: "guidance:e2e",
      };
      const submitted = await submitNativeBuildUserGuidance(connection, RUN_ID, guidance);
      const replayed = await submitNativeBuildUserGuidance(connection, RUN_ID, guidance);
      expect(submitted.userGuidance?.["guidance-e2e"]?.status).toBe("submitted");
      expect(replayed.userGuidanceVersion).toBe(1);
      expect(scheduler.readRun(RUN_ID).filter((event) => event.type === "user.guidance_submitted")).toHaveLength(1);
      expect(scheduler.readRun(RUN_ID).filter((event) => event.type === "architect.question_answered")).toHaveLength(1);
      expect(runtime.projection().initialObjective).toBe(OBJECTIVE);

      await server.close();
      server = undefined;
      scheduler.close();
      scheduler = new SqliteSchedulerStore(schedulerPath);
      const recovered = rebuildSchedulerProjection(scheduler.readRun(RUN_ID));
      expect(recovered.initialObjective).toBe(OBJECTIVE);
      expect(recovered.userGuidance["guidance-e2e"]?.status).toBe("submitted");
      expect(recovered.architectQuestions["question-e2e"]?.status).toBe("answered");
      expect(recovered.architectQuestions["question-e2e"]?.answer).toBe(answer.answer);
      expect(classifyBuildNoteDelivery(
        { nativeBuildRunId: RUN_ID },
        { runId: RUN_ID, status: "completed" },
      )).toBe("follow_up");
    } finally {
      await server?.close();
      scheduler.close();
      supervisor.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an answer followed by immediate runner restart resumes its exact Architect checkpoint once", async () => {
    const root = mkdtempSync(join(tmpdir(), "runner-v2-answer-restart-e2e-"));
    const schedulerPath = join(root, "scheduler.sqlite");
    let scheduler = new SqliteSchedulerStore(schedulerPath);
    let resumedActions = 0;
    try {
      let runtime = new BuildRuntime({
        runId: RUN_ID,
        initialObjective: OBJECTIVE,
        store: scheduler,
        workerDriver: { run: async () => ({ type: "paused" as const, reason: "unused" }) },
        architectDriver: { run: async () => undefined },
        integrationDriver: { integrate: async () => ({ status: "integrated" as const, integrationRevision: "unused" }) },
        maxConcurrency: 1,
        workspaceFor: async () => "C:/unused",
      });
      scheduler.append({
        runId: RUN_ID,
        type: "architect.question_requested",
        occurredAt: "2026-08-27T00:00:01.000Z",
        actor: { role: "architect", id: "architect-e2e" },
        idempotencyKey: "question:restart",
        payload: {
          questionId: "question-restart",
          question: "Which contract is authoritative?",
          version: 1,
          decisionKind: "authority_decision",
          checkpoint: { reason: { type: "plan_required" }, sequence: runtime.projection().lastSequence },
        },
      });
      const exactAnswer = {
        questionId: "question-restart",
        expectedVersion: 1,
        answer: "The documented public contract.",
        idempotencyKey: "question:restart:answer",
      };
      runtime.answerArchitectQuestion(exactAnswer);
      runtime.answerArchitectQuestion(exactAnswer);
      expect(scheduler.readRun(RUN_ID).filter((event) => event.type === "architect.question_answered")).toHaveLength(1);

      scheduler.close();
      scheduler = new SqliteSchedulerStore(schedulerPath);
      runtime = new BuildRuntime({
        runId: RUN_ID,
        initialObjective: OBJECTIVE,
        store: scheduler,
        workerDriver: { run: async () => ({ type: "paused" as const, reason: "unused" }) },
        architectDriver: {
          run: async (request) => {
            resumedActions += 1;
            expect(request.reason).toEqual({ type: "plan_required" });
            const planned = await request.tools.invoke({
              type: "tool_call",
              callId: "plan-after-restart",
              name: "plan_tasks",
              arguments: {
                revision: 1,
                tasks: [{
                  id: "task-after-restart",
                  objective: "Implement the confirmed contract.",
                  dependencies: [],
                  requiredCapabilities: ["code"],
                  acceptanceCriteria: [{ id: "done", text: "The confirmed contract is implemented." }],
                }],
              },
            }, request.context);
            expect(planned.isError).toBe(false);
          },
        },
        integrationDriver: { integrate: async () => ({ status: "integrated" as const, integrationRevision: "unused" }) },
        maxConcurrency: 1,
        workspaceFor: async () => "C:/unused",
      });
      expect(await runtime.step()).toEqual({ status: "progressed", action: "architect_question_resumed" });
      expect(resumedActions).toBe(1);
      expect(runtime.projection().architectQuestions["question-restart"]?.resumeStatus).toBe("consumed");
      expect(scheduler.readRun(RUN_ID).filter((event) => event.type === "architect.question_resume_consumed")).toHaveLength(1);

      scheduler.close();
      scheduler = new SqliteSchedulerStore(schedulerPath);
      expect(rebuildSchedulerProjection(scheduler.readRun(RUN_ID)).architectQuestions["question-restart"]?.resumeStatus).toBe("consumed");
    } finally {
      scheduler.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("approved verification and pending handoff are durably revoked before steering can continue", async () => {
    const root = mkdtempSync(join(tmpdir(), "runner-v2-final-handoff-steering-e2e-"));
    const schedulerPath = join(root, "scheduler.sqlite");
    const options = {
      evidenceStore: {
        record: () => { throw new Error("No evidence is expected in this not-applicable fixture."); },
        list: () => [],
        getByIds: () => [],
        close: () => undefined,
      },
      validateCleanupReceipt: () => undefined,
      validateExecutionProfile: () => undefined,
    };
    let scheduler = new SqliteSchedulerStore(schedulerPath, options);
    try {
      seedApprovedHandoff(scheduler);
      expect(buildCompletionReadiness(rebuildSchedulerProjection(scheduler.readRun(RUN_ID))).ready).toBe(true);
      const runtime = steeringRuntime(scheduler);
      const guidance = {
        guidanceId: "guidance-after-approval",
        text: "Add one more durable behavior before handoff.",
        version: 1,
        idempotencyKey: "guidance:after-approval",
      };
      runtime.submitUserGuidance(guidance);
      runtime.submitUserGuidance(guidance);
      const revoked = runtime.projection();
      expect(buildCompletionReadiness(revoked).ready).toBe(false);
      expect(revoked.finalVerification?.current).toBeUndefined();
      expect(revoked.finalVerification?.history[0]?.invalidatedByGuidanceId).toBe(guidance.guidanceId);
      expect(revoked.projectHandoff).toBeUndefined();
      expect(revoked.projectHandoffHistory?.[0]?.status).toBe("withdrawn");
      expect(revoked.projectHandoffHistory?.[0]?.withdrawnByGuidanceId).toBe(guidance.guidanceId);
      expect(scheduler.readRun(RUN_ID).filter((event) => event.type === "user.guidance_submitted")).toHaveLength(1);
      expect(() => runtime.selectProjectHandoff(
        "apply_to_project",
        { integrationRevision: FINAL_REVISION, integrationBranch: "aiboard/run/integration", appliedToProject: true },
        "handoff:stale-choice",
      )).toThrow(/guidance|handoff|completion|verification/i);

      scheduler.append({
        runId: RUN_ID,
        type: "user.guidance_acknowledged",
        occurredAt: "2026-08-27T00:00:20.000Z",
        actor: { role: "architect", id: "architect-e2e" },
        idempotencyKey: "guidance:after-approval:ack",
        payload: {
          guidanceId: guidance.guidanceId,
          expectedVersion: 1,
          resolution: {
            type: "plan_reconciled",
            rationale: "The added scope is now represented by a durable task.",
            planReconciliation: {
              revision: 2,
              summary: "Add the steered scope.",
              taskUpdates: [],
              newTasks: [{
                id: "steered-follow-up",
                objective: "Implement the steered follow-up.",
                dependencies: ["implementation"],
                requiredCapabilities: ["code"],
                acceptanceCriteria: [{ id: "follow-up", text: "The steered follow-up is implemented." }],
              }],
            },
          },
        },
      });
      scheduler.append({
        runId: RUN_ID,
        type: "task.transitioned",
        occurredAt: "2026-08-27T00:00:21.000Z",
        actor: { role: "architect", id: "architect-e2e" },
        idempotencyKey: "steered-follow-up:cancel",
        payload: { taskId: "steered-follow-up", status: "cancelled" },
      });
      appendVerificationGeneration(scheduler, 2);
      const fresh = rebuildSchedulerProjection(scheduler.readRun(RUN_ID));
      expect(fresh.finalVerification?.current?.generationId).toBe(`${FINAL_GENERATION}-2`);
      expect(fresh.finalVerification?.current?.targetRevision).toBe(FINAL_REVISION);

      scheduler.close();
      scheduler = new SqliteSchedulerStore(schedulerPath, options);
      const recovered = rebuildSchedulerProjection(scheduler.readRun(RUN_ID));
      expect(recovered.initialObjective).toBe(OBJECTIVE);
      expect(recovered.finalVerification?.history[0]?.invalidatedByGuidanceId).toBe(guidance.guidanceId);
      expect(recovered.projectHandoffHistory?.[0]?.withdrawnByGuidanceId).toBe(guidance.guidanceId);
      expect(recovered.finalVerification?.current?.generationId).toBe(`${FINAL_GENERATION}-2`);
    } finally {
      scheduler.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

const FINAL_REVISION = "f".repeat(40);
const FINAL_TASK = "final-verification-e2e";
const FINAL_GENERATION = "final-verification-generation-e2e";
const FINAL_PLAN = {
  checks: (["build", "tests", "runtime_smoke", "browser"] as const).map((category) => ({
    category,
    status: "not_applicable" as const,
    rationale: `No ${category} fixture is configured.`,
    repositoryInspection: { paths: ["package.json"], summary: `No ${category} fixture is configured.` },
  })),
};

function steeringRuntime(store: SchedulerStore): BuildRuntime {
  return new BuildRuntime({
    runId: RUN_ID,
    initialObjective: OBJECTIVE,
    store,
    workerDriver: { run: async () => ({ type: "paused" as const, reason: "unused" }) },
    architectDriver: { run: async () => undefined },
    integrationDriver: { integrate: async () => ({ status: "integrated" as const, integrationRevision: FINAL_REVISION }) },
    maxConcurrency: 1,
    workspaceFor: async () => "C:/unused",
  });
}

function appendVerificationGeneration(store: SchedulerStore, version: number): void {
  const suffix = version === 1 ? "" : `-${version}`;
  store.append({
    runId: RUN_ID,
    type: "final_verification.generation_created",
    occurredAt: "2026-08-27T00:00:03.000Z",
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: `verification:generation:${version}`,
    payload: {
      taskId: `${FINAL_TASK}${suffix}`,
      generationId: `${FINAL_GENERATION}${suffix}`,
      targetRevision: FINAL_REVISION,
      planVersion: version,
      plan: FINAL_PLAN,
      executionProfile: emptyFinalVerificationProfile(FINAL_REVISION),
    },
  });
}

function seedApprovedHandoff(store: SchedulerStore): void {
  store.append({ runId: RUN_ID, type: "run.initialized", occurredAt: "2026-08-27T00:00:00.000Z", actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "run:initialized", payload: { objective: OBJECTIVE } });
  store.append({ runId: RUN_ID, type: "run.policy_configured", occurredAt: "2026-08-27T00:00:00.100Z", actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "run:policy", payload: { runPolicy: "finish" } });
  store.append({ runId: RUN_ID, type: "plan.created", occurredAt: "2026-08-27T00:00:01.000Z", actor: { role: "architect", id: "architect-e2e" }, idempotencyKey: "plan:one", payload: { revision: 1, tasks: [{ id: "implementation", objective: "Implement the application.", dependencies: [], status: "integrated", requiredCapabilities: ["code"], acceptanceCriteria: [{ id: "done", text: "The application is implemented." }], acceptanceCriteriaVersion: 1, attempt: 1 }] } });
  store.append({ runId: RUN_ID, type: "integration.revision_advanced", occurredAt: "2026-08-27T00:00:02.000Z", actor: { role: "runner", id: "integration" }, idempotencyKey: "integration:revision", payload: { integrationRevision: FINAL_REVISION } });
  appendVerificationGeneration(store, 1);
  for (const [index, check] of FINAL_PLAN.checks.entries()) {
    store.append({ runId: RUN_ID, type: "final_verification.check_completed", occurredAt: `2026-08-27T00:00:0${index + 4}.000Z`, actor: { role: "runner", id: "build-runtime" }, idempotencyKey: `verification:check:${check.category}`, payload: { taskId: FINAL_TASK, generationId: FINAL_GENERATION, targetRevision: FINAL_REVISION, attempt: 1, workspacePath: "C:/verification", startedAt: "2026-08-27T00:00:04.000Z", finishedAt: "2026-08-27T00:00:05.000Z", result: { ...check, green: true, evidenceIds: [], facts: [], issues: [] } } });
  }
  const checks = FINAL_PLAN.checks.map((check) => ({ ...check, green: true, evidenceIds: [], facts: [] }));
  store.append({ runId: RUN_ID, type: "final_verification.submitted", occurredAt: "2026-08-27T00:00:09.000Z", actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "verification:submission", payload: { taskId: FINAL_TASK, generationId: FINAL_GENERATION, targetRevision: FINAL_REVISION, submissionId: "submission-e2e", attempt: 1, submissionResult: { kind: "final_verification_submission", generationId: FINAL_GENERATION, runId: RUN_ID, taskId: FINAL_TASK, attempt: 1, targetRevision: FINAL_REVISION, plan: FINAL_PLAN, executionProfile: emptyFinalVerificationProfile(FINAL_REVISION), checks, evidenceIds: [], submittedAt: "2026-08-27T00:00:09.000Z", green: true } } });
  store.append({ runId: RUN_ID, type: "final_verification.cleanup_started", occurredAt: "2026-08-27T00:00:10.000Z", actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "verification:cleanup:start", payload: { taskId: FINAL_TASK, generationId: FINAL_GENERATION, targetRevision: FINAL_REVISION, attempt: 1 } });
  store.append({ runId: RUN_ID, type: "final_verification.cleanup_succeeded", occurredAt: "2026-08-27T00:00:11.000Z", actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "verification:cleanup:success", payload: { taskId: FINAL_TASK, generationId: FINAL_GENERATION, targetRevision: FINAL_REVISION, attempt: 1 } });
  store.append({ runId: RUN_ID, type: "final_verification.review_requested", occurredAt: "2026-08-27T00:00:12.000Z", actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "verification:review:request", payload: { taskId: FINAL_TASK, generationId: FINAL_GENERATION, targetRevision: FINAL_REVISION, submissionId: "submission-e2e", reviewId: "review-e2e", attempt: 1 } });
  store.append({ runId: RUN_ID, type: "final_verification.review_decided", occurredAt: "2026-08-27T00:00:13.000Z", actor: { role: "architect", id: "architect-e2e" }, idempotencyKey: "verification:review:decision", payload: { taskId: FINAL_TASK, generationId: FINAL_GENERATION, targetRevision: FINAL_REVISION, submissionId: "submission-e2e", reviewId: "review-e2e", attempt: 1, decision: "approved", summary: "Every category is approved.", categoryReviews: FINAL_PLAN.checks.map((check) => ({ category: check.category, verdict: "approved", rationale: `The ${check.category} inspection supports approval.`, evidenceIds: [] })) } });
  store.append({ runId: RUN_ID, type: "project.handoff_requested", occurredAt: "2026-08-27T00:00:14.000Z", actor: { role: "architect", id: "architect-e2e" }, idempotencyKey: "handoff:request", payload: { summary: "Ready for handoff." } });
}

function renderSteeringPanel(projection: unknown): string {
  const source = [
    'import { createElement } from "react";',
    'import { renderToStaticMarkup } from "react-dom/server";',
    'import { RunnerV2SteeringPanel } from "./components/RunnerV2ObservabilityPanel";',
    'const projection = JSON.parse(process.env.RUNNER_STEERING_PROJECTION ?? "null");',
    'process.stdout.write(renderToStaticMarkup(createElement(RunnerV2SteeringPanel, { projection, onAnswerQuestion: async () => undefined })));',
  ].join("\n");
  return execFileSync(
    process.execPath,
    [resolve("node_modules/tsx/dist/cli.mjs"), "--eval", source],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, RUNNER_STEERING_PROJECTION: JSON.stringify(projection) },
    },
  );
}
