import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type {
  ToolCallBlock,
  ToolExecutionOutput,
} from "../src/agent-contracts.js";
import {
  BuildRuntime,
  type ArchitectActionRequest,
  type ArchitectRuntimeDriver,
} from "../src/build-runtime.js";
import { createArchitectTools } from "../src/architect-tools.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { parseContextManifestPayload } from "../src/context-manifest-store.js";
import { currentSubmissionReview, deliveryReviewApprovalIssues, deriveReviewTaskPrefill, diffReviewTaskVerdicts, finalReadyCoverageIssues, finalReadyRequirementIssues } from "../src/delivery-acceptance.js";
import { createPlanningTools } from "../src/planning-tools.js";
import {
  CLAUDE_POINTER_LINE,
  DEFAULT_AGENTS_SECTION_BODY,
  DEFAULT_README_TEMPLATE,
  DEFAULT_STATE_TEMPLATE,
} from "../src/project-docs.js";
import { createRequestTriageTools } from "../src/request-triage.js";
import {
  buildCompletionReadiness,
  isAnsweredRun,
  isPlanningState,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type SchedulerEvent,
  type SchedulerProjection,
  type SchedulerStore,
} from "../src/scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { type ApprovedSourceManifest } from "../src/source-manifest.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import type {
  WorkerAssignment,
  WorkerOutcome,
  WorkerRuntimeDriver,
} from "../src/task-scheduler.js";
import { buildPlanningFixtureScenario } from "./fixtures/planning-source-fixture.js";
import { acceptFinalVerificationProfile } from "./support/final-verification-profile.js";

/**
 * T8 final qualification (SRC-P T8, EP16, EP27-EP29, EP40, EP52; AR-R31).
 *
 * Focused deterministic scenarios on the integrated candidate. Packet suites
 * (T7, T9, V2, V3, W2, E1, C3, replay) own their own coverage and re-run at
 * the layer-4 final gate; this file proves the T8-level composition only:
 * the synthetic build spine, the answer-path journeys, the non-JS delivery
 * boundary with host-gated skips, the AR-R31 product behaviors, and the
 * verdict/trace chain. No live model or provider is required: every model
 * transport is scripted, while Git, SQLite, worktrees, and the executed
 * boundary commands are real.
 *
 * AR-4 note: the parent plan's "unrelated-change reuse" case is amended to
 * exact-identity reuse within one run (V2); semantic reuse is P7. The reuse
 * scenarios below assert exact-identity reuse plus related-change
 * invalidation, and never semantic reuse.
 *
 * Host-gating policy: a missing host toolchain is an explicit recorded skip
 * naming the exact missing tool — never a pass.
 */

const T8_BASE_MS = Date.parse("2026-10-07T00:00:00.000Z");

function t8Clock(): () => string {
  let now = T8_BASE_MS;
  return () => new Date(now += 1000).toISOString();
}

function t8ProjectionOf(store: SchedulerStore, runId: string): SchedulerProjection {
  return rebuildSchedulerProjection(store.readRun(runId));
}

/** Production policy order: docs, run, then planning policy. */
function t8SeedNewPolicy(
  store: SchedulerStore,
  runId: string,
  clock: () => string,
  runPolicy: "finish" | "plan_only" = "finish",
  docsVersion = 1,
): void {
  store.append({
    runId,
    type: "project_docs.policy_configured",
    occurredAt: clock(),
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "project-docs-policy",
    payload: { version: docsVersion },
  });
  store.append({
    runId,
    type: "run.policy_configured",
    occurredAt: clock(),
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "run-policy-configured",
    payload: { runPolicy },
  });
  store.append({
    runId,
    type: "planning.policy_configured",
    occurredAt: clock(),
    actor: { role: "runner", id: "runner" },
    idempotencyKey: "planning-policy:1",
    payload: { version: 1 },
  });
}

function t8SeedSource(
  store: SchedulerStore,
  runId: string,
  clock: () => string,
  manifest: ApprovedSourceManifest,
  key = "source:base",
): void {
  store.append({
    runId,
    type: "planning.source_registered",
    occurredAt: clock(),
    actor: { role: "user", id: "owner" },
    idempotencyKey: key,
    payload: { manifest },
  });
}

function t8EntryPointDocs(): { path: string; content: string }[] {
  return [
    { path: "docs/project/README.md", content: DEFAULT_README_TEMPLATE },
    { path: "AGENTS.md", content: DEFAULT_AGENTS_SECTION_BODY },
    { path: "CLAUDE.md", content: CLAUDE_POINTER_LINE },
    { path: "docs/project/STATE.md", content: DEFAULT_STATE_TEMPLATE },
  ];
}

/** Deterministic project-docs port: durable shapes without a git checkout. */
function t8StubProjectDocsPort() {
  return {
    commit: async (input: { writes: { path: string; content: string }[]; summary: string; runId: string; requestId: string }) => ({
      commit: createHash("sha256").update(`commit:${input.requestId}`).digest("hex").slice(0, 40),
      parent: createHash("sha256").update(`parent:${input.requestId}`).digest("hex").slice(0, 40),
      head: createHash("sha256").update(`head:${input.requestId}`).digest("hex").slice(0, 40),
      entryPoint: { readme: true, agentsMarkedSection: true, claudePointer: true, agentsMarkedSectionV2: false, claudePointerV2: false },
    }),
    relateRevision: async () => "equal_to_tip" as const,
    readHandoffSnapshotFile: async () => {
      throw new Error("t8 stubs never reach the handoff snapshot read");
    },
    readIntegrationTipFile: async () => {
      throw new Error("t8 stubs never reach the integration tip read");
    },
    findTrackedFileWithDigest: async () => {
      throw new Error("t8 stubs never reach the tracked file search");
    },
    findHandoffSnapshotCommit: async () => {
      throw new Error("t8 stubs never reach the handoff snapshot lookup");
    },
    readIntegrationBaselineRevision: async () => {
      throw new Error("t8 stubs never reach the baseline revision read");
    },
    canStageSpecPath: async () => {
      throw new Error("t8 stubs never reach the spec stageability check");
    },
    commitHandoffSnapshot: async (input: { writes: { path: string; content: string }[]; summary: string; runId: string; snapshotKey: string }) => ({
      commit: createHash("sha256").update(`snapshot:${input.snapshotKey}`).digest("hex").slice(0, 40),
      parent: createHash("sha256").update(`parent:${input.snapshotKey}`).digest("hex").slice(0, 40),
      head: createHash("sha256").update(`head:${input.snapshotKey}`).digest("hex").slice(0, 40),
      entryPoint: { readme: false, agentsMarkedSection: false, claudePointer: false, agentsMarkedSectionV2: false, claudePointerV2: false },
    }),
  };
}

async function t8InvokeMustSucceed(
  request: ArchitectActionRequest,
  name: string,
  args: unknown,
  callSuffix = "1",
): Promise<ToolExecutionOutput> {
  const call: ToolCallBlock = {
    type: "tool_call",
    callId: `${name}:${callSuffix}`,
    name,
    arguments: args,
  };
  const output = await request.tools.invoke(call, request.context);
  assert.equal(output.isError, false, `${name}: ${JSON.stringify(output.error)}`);
  return output;
}

function t8OutputJson(output: ToolExecutionOutput): Record<string, unknown> & { payload?: Record<string, unknown> } {
  const block = output.content.find((entry) => entry.type === "json");
  assert.ok(block && block.type === "json");
  return block.value as Record<string, unknown> & { payload?: Record<string, unknown> };
}

class T8CountingWorkerDriver implements WorkerRuntimeDriver {
  readonly assignments: string[] = [];
  async run(assignment: WorkerAssignment): Promise<WorkerOutcome> {
    this.assignments.push(assignment.task.id);
    return { type: "failed", reason: "must_not_dispatch" };
  }
}

class T8CountingReviewDriver {
  readonly calls: unknown[] = [];
  readonly candidateRuntimeIds: readonly string[] = ["google:reviewer"];
  async review(input: unknown): Promise<{ status: "unavailable"; reviewId: string; reason: string }> {
    this.calls.push(input);
    return { status: "unavailable", reviewId: "t8_unused", reason: "unused" };
  }
}

/** Scripted pure-question Architect: triage → answer → entry-point docs → complete. */
class T8AnswerArchitectDriver implements ArchitectRuntimeDriver {
  readonly reasons: string[] = [];
  readonly turnTools: string[][] = [];
  readonly addressedInTurn: (readonly string[] | undefined)[] = [];
  private step = 0;
  async run(request: ArchitectActionRequest): Promise<void> {
    this.reasons.push(request.reason.type);
    this.turnTools.push(request.tools.definitions().map((tool) => tool.name).sort());
    const step = this.step++;
    if (request.reason.type === "completion_decision_required") {
      await t8InvokeMustSucceed(request, "complete_run", { summary: "Answered." }, "complete");
      return;
    }
    if (step === 0) {
      await t8InvokeMustSucceed(request, "record_triage", {
        decision: "answer",
        rationale: "The request is a pure question with no requested change.",
      }, "triage");
      return;
    }
    if (step === 1) {
      const output = await t8InvokeMustSucceed(request, "record_answer", {
        answerText: "The build fails because the cache key omits the lockfile; add it to the key.",
        addressedParts: ["Why the build fails", "How to fix it"],
      }, "answer");
      this.addressedInTurn.push(t8OutputJson(output).payload?.addressedParts as string[]);
      return;
    }
    for (const write of t8EntryPointDocs()) {
      await t8InvokeMustSucceed(request, "write_project_doc", {
        path: write.path,
        content: write.content,
        summary: `Write ${write.path}`,
      }, write.path);
    }
  }
}

/** Amendment impact scoped so retirements validate (T2 pattern). */
function t8ScopedFixture() {
  const fixture = buildPlanningFixtureScenario();
  const amendment = fixture.manifest.amendment!;
  return {
    ...fixture,
    manifest: {
      ...fixture.manifest,
      amendment: {
        ...amendment,
        recordedImpact: {
          addsSectionIds: ["s8"],
          retiresSectionIds: ["s7"],
          addsRequirementIds: [],
          retiresRequirementIds: ["REQ-RETIRED"],
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Suite B: answer-path journeys (SRC-P T8 amendment; EP39).
// ---------------------------------------------------------------------------

test("T8-B1 pure question completes with zero tasks, zero dispatches, no integration", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t8-answer-"));
  const clock = t8Clock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t8_pure_question";
  const architect = new T8AnswerArchitectDriver();
  const workers = new T8CountingWorkerDriver();
  const answerReview = new T8CountingReviewDriver();
  const coverageReview = new T8CountingReviewDriver();
  const integrations: unknown[] = [];
  try {
    t8SeedNewPolicy(store, runId, clock);
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Why does the build fail, and how do I fix it?",
      store,
      clock,
      workerDriver: workers,
      architectDriver: architect,
      integrationDriver: {
        integrate: async (input) => {
          integrations.push(input);
          return { status: "conflict", integrationRevision: "x".repeat(40), conflictPaths: ["must_not_integrate"] };
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      projectDocs: t8StubProjectDocsPort(),
      answerReview,
      coverageReview: coverageReview as never,
    });
    const blocked = await runtime.runUntilBlocked(20);
    assert.equal(blocked.status, "paused");
    assert.equal(runtime.projection().projectHandoff?.status, "requested");
    const selected = runtime.selectProjectHandoff(
      "keep_integration_branch",
      {
        integrationRevision: "no_integration",
        integrationBranch: `aiboard/integration/${runId}`,
        appliedToProject: false,
      },
      "handoff:answer",
    );
    assert.equal(selected.status, "completed");
    assert.equal(isAnsweredRun(selected), true);

    const events = store.readRun(runId);
    const types = events.map((event) => event.type);
    assert.equal(Object.keys(selected.tasks).length, 0);
    assert.equal(types.filter((type) => type === "task.transitioned").length, 0);
    assert.equal(types.filter((type) => type === "plan.created").length, 0);
    assert.equal(types.filter((type) => type.startsWith("planning.")).length, 1);
    assert.equal(selected.integrationRevision, undefined);
    assert.equal(selected.finalVerification, undefined);
    assert.equal(workers.assignments.length, 0);
    assert.equal(integrations.length, 0);
    assert.equal(answerReview.calls.length, 0, "no answer review without opt-in");
    assert.equal(coverageReview.calls.length, 0, "no coverage review on the answer path");
    assert.equal(types.some((type) => type.startsWith("answer.review")), false);
    assert.deepEqual(architect.reasons, [
      "plan_required",
      "plan_required",
      "plan_required",
      "completion_decision_required",
    ]);
    assert.equal(architect.turnTools[0]?.includes("record_triage"), true);
    assert.deepEqual(architect.addressedInTurn, [["Why the build fails", "How to fix it"]]);
    assert.deepEqual(selected.requestAnswer?.addressedParts, ["Why the build fails", "How to fix it"]);
    assert.ok(selected.projectDocs?.committed?.some((commit) => commit.path === "docs/project/STATE.md"));
    const triagedAt = types.indexOf("request.triaged");
    assert.ok(triagedAt >= 0);
    assert.equal(
      types.findIndex((type, index) => index > triagedAt && type.startsWith("planning.") && type !== "planning.policy_configured"),
      -1,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T8-B2 question converted to build records the conversion and restores planning", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t8-convert-"));
  const clock = t8Clock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_t8_convert";
  const fixture = t8ScopedFixture();
  try {
    t8SeedNewPolicy(store, runId, clock);
    t8SeedSource(store, runId, clock, fixture.priorManifest);
    store.append({
      runId,
      type: "planning.source_amended",
      occurredAt: clock(),
      actor: { role: "user", id: "owner" },
      idempotencyKey: "source:amend-1",
      payload: { manifest: fixture.manifest },
    });
    store.append({
      runId,
      type: "request.triaged",
      occurredAt: clock(),
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "triage:answer",
      payload: { decision: "answer", rationale: "Seed triage to answer." },
    });
    store.append({
      runId,
      type: "request.answered",
      occurredAt: clock(),
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "answer:1",
      payload: {
        answerText: "The build fails because the cache key omits the lockfile; add it.",
        addressedParts: ["Why the build fails"],
      },
    });
    const tools = createArchitectTools({
      store,
      clock,
      runPolicy: "finish",
      triageTools: true,
      planningTools: {},
      answerPath: true,
      architectAction: { reason: { type: "plan_required" }, sequence: 0 },
    });
    const context = {
      runId,
      sessionId: "session_convert",
      actor: { role: "architect", id: "architect_1" } as const,
      workspacePath: root,
    };
    const retriage = tools.find((tool) => tool.definition.name === "record_triage")!;
    const retriaged = await retriage.execute(
      { decision: "build", rationale: "Change of mind." } as never,
      context,
    );
    assert.equal(retriaged.isError, true);
    assert.equal(retriaged.error?.code, "already_answered");
    const convert = tools.find((tool) => tool.definition.name === "convert_to_build")!;
    const converted = await convert.execute({ reason: "The answer needs a code fix." } as never, context);
    assert.equal(converted.isError, false, JSON.stringify(converted.error));
    const convertedProjection = t8ProjectionOf(store, runId);
    assert.equal(convertedProjection.planningTriageDecision, "build");
    assert.deepEqual(convertedProjection.requestTriage?.conversions, [{
      from: "answer",
      to: "build",
      reason: "The answer needs a code fix.",
      sequence: converted && !converted.isError
        ? (t8OutputJson(converted).sequence as number)
        : -1,
    }]);
    assert.equal(isPlanningState(convertedProjection), true);
    assert.equal(isAnsweredRun(convertedProjection), false);
    const planning = createPlanningTools({ store, clock });
    const ledger = planning.find((tool) => tool.definition.name === "persist_planning_ledger")!;
    const persisted = await ledger.execute(
      {
        id: "ledger-1",
        requirements: fixture.requirements,
        phases: fixture.phases,
      } as never,
      context,
    );
    assert.equal(persisted.isError, false, JSON.stringify(persisted.error));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T8-B3 mixed request triages to build and refuses the answer tool", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t8-mixed-"));
  const clock = t8Clock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_t8_mixed";
  const fixture = t8ScopedFixture();
  try {
    t8SeedNewPolicy(store, runId, clock);
    t8SeedSource(store, runId, clock, fixture.priorManifest);
    store.append({
      runId,
      type: "planning.source_amended",
      occurredAt: clock(),
      actor: { role: "user", id: "owner" },
      idempotencyKey: "source:amend-1",
      payload: { manifest: fixture.manifest },
    });
    const tools = createRequestTriageTools({ store, clock });
    const context = {
      runId,
      sessionId: "session_mixed",
      actor: { role: "architect", id: "architect_1" } as const,
      workspacePath: root,
    };
    const triage = tools.find((tool) => tool.definition.name === "record_triage")!;
    const decided = await triage.execute(
      { decision: "build", rationale: "Explains the cache, then fixes the key." } as never,
      context,
    );
    assert.equal(decided.isError, false, JSON.stringify(decided.error));
    assert.equal(t8ProjectionOf(store, runId).planningTriageDecision, "build");
    assert.equal(isPlanningState(t8ProjectionOf(store, runId)), true);
    const planning = createPlanningTools({ store, clock });
    const ledger = planning.find((tool) => tool.definition.name === "persist_planning_ledger")!;
    const persisted = await ledger.execute(
      { id: "ledger-1", requirements: fixture.requirements, phases: fixture.phases } as never,
      context,
    );
    assert.equal(persisted.isError, false, JSON.stringify(persisted.error));
    const answer = tools.find((tool) => tool.definition.name === "record_answer")!;
    const refused = await answer.execute(
      { answerText: "Too late.", addressedParts: ["x"] } as never,
      context,
    );
    assert.equal(refused.isError, true);
    assert.equal(refused.error?.code, "triage_not_answer");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T8-B4 clarify pauses through ask_user and resumes back to triage", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t8-clarify-"));
  const clock = t8Clock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_t8_clarify";
  const reasons: string[] = [];
  let step = 0;
  try {
    t8SeedNewPolicy(store, runId, clock);
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Fix the thing.",
      store,
      clock,
      workerDriver: new T8CountingWorkerDriver(),
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      architectDriver: {
        run: async (request) => {
          reasons.push(request.reason.type);
          const current = step++;
          if (current === 0) {
            await t8InvokeMustSucceed(request, "record_triage", {
              decision: "clarify",
              rationale: "The request names no thing to fix.",
            }, "triage");
          } else if (current === 1) {
            await t8InvokeMustSucceed(request, "ask_user", {
              questionId: "q_clarify",
              version: 1,
              question: "Which thing should I fix?",
              decisionKind: "requirement_conflict",
              blocking: true,
            }, "ask");
          } else if (current === 2) {
            await t8InvokeMustSucceed(request, "record_triage", {
              decision: "answer",
              rationale: "The user asked a pure question instead.",
            }, "retriage");
          } else {
            await t8InvokeMustSucceed(request, "record_answer", {
              answerText: "The cache key omits the lockfile.",
              addressedParts: ["Which thing", "How it works"],
            }, "answer");
          }
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
    });
    const blocked = await runtime.runUntilBlocked(10);
    assert.equal(blocked.status, "blocked");
    assert.equal(t8ProjectionOf(store, runId).planningTriageDecision, "clarify");
    const question = t8ProjectionOf(store, runId).architectQuestions["q_clarify"];
    assert.equal(question?.status, "open");
    runtime.answerArchitectQuestion({
      questionId: "q_clarify",
      expectedVersion: question!.version,
      answer: "Just explain the cache; no fix needed.",
      idempotencyKey: "answer:q_clarify",
    });
    assert.equal((await runtime.step()).status, "progressed");
    assert.equal((await runtime.step()).status, "progressed");
    const after = t8ProjectionOf(store, runId);
    assert.equal(after.planningTriageDecision, "answer");
    assert.equal(after.architectQuestions["q_clarify"]?.resumeStatus, "consumed");
    assert.deepEqual(reasons, ["plan_required", "plan_required", "plan_required", "plan_required"]);
    assert.ok(store.readRun(runId).some((event) => event.type === "architect.question_resume_consumed"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Suite E: verdict/trace chain negatives (SRC-P T8; EP29). The positive final
// conjunction is proven on the real completed spine run in T8-A1.
// ---------------------------------------------------------------------------

test("T8-E1 omitted obligations and open mandatory failures block the final conjunction", () => {
  assert.deepEqual(
    finalReadyRequirementIssues([{ id: "REQ-1", applicability: { status: "conditional_pending" } }]),
    ["Requirement REQ-1 remains conditional_pending."],
  );
  assert.deepEqual(
    finalReadyRequirementIssues([{ id: "REQ-2", applicability: { status: "not_applicable" } }]),
    ["Requirement REQ-2 has no authorized not-applicable disposition."],
  );
  assert.deepEqual(
    finalReadyRequirementIssues([{
      id: "REQ-3",
      applicability: { status: "not_applicable", disposition: { evidenceRef: "answer:1" } },
    }]),
    [],
  );
  assert.deepEqual(
    finalReadyCoverageIssues(
      [{ id: "REQ-4", contributingTaskIds: [], applicability: { status: "applicable" } }],
      new Map(),
    ),
    ["Requirement REQ-4 has no contributing task coverage."],
  );
  assert.deepEqual(
    finalReadyCoverageIssues(
      [{ id: "REQ-5", contributingTaskIds: ["T1"], applicability: { status: "applicable" } }],
      new Map([["T1", "cancelled"]]),
    ),
    ["Requirement REQ-5 has cancelled-only coverage."],
  );
  assert.deepEqual(
    finalReadyCoverageIssues(
      [{ id: "REQ-6", contributingTaskIds: ["T1"], applicability: { status: "applicable" } }],
      new Map([["T1", "integrated"]]),
    ),
    [],
  );
});

test("T8-E1b the completion gate stays fail-closed on an incomplete converted run", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t8-gate-"));
  const clock = t8Clock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_t8_gate";
  const fixture = t8ScopedFixture();
  try {
    t8SeedNewPolicy(store, runId, clock);
    t8SeedSource(store, runId, clock, fixture.priorManifest);
    const tools = createRequestTriageTools({ store, clock });
    const context = {
      runId,
      sessionId: "session_gate",
      actor: { role: "architect", id: "architect_1" } as const,
      workspacePath: root,
    };
    const triage = tools.find((tool) => tool.definition.name === "record_triage")!;
    const decided = await triage.execute(
      { decision: "build", rationale: "Incomplete build run." } as never,
      context,
    );
    assert.equal(decided.isError, false, JSON.stringify(decided.error));
    const readiness = buildCompletionReadiness(t8ProjectionOf(store, runId));
    assert.equal(readiness.ready, false, "an unplanned build run is never completion-ready");
    assert.ok(readiness.issues.length > 0);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Suite C5: v1 docs log/replay compatibility (AR-R31).
// ---------------------------------------------------------------------------

test("T8-C5 recorded v1 log replays to the unchanged projection on the final candidate", () => {
  const fixturePath = fileURLToPath(new URL("./support/pre-capability-run.fixture.json", import.meta.url));
  const fixtureBytes = readFileSync(fixturePath);
  assert.equal(
    createHash("sha256").update(fixtureBytes).digest("hex"),
    "cc18719f05160e6e432187ae5dd2d7571976bb89240b7edfa65c5561fefde236",
    "historical fixture bytes are immutable",
  );
  const fixture = JSON.parse(fixtureBytes.toString("utf8")) as {
    baseRevision: string;
    schedulerEvents: SchedulerEvent[];
    schedulerProjection: SchedulerProjection;
    evidenceRecords: Parameters<SqliteEvidenceStore["record"]>[0] & { id: string; runId: string; taskId: string; fact: { kind: string } }[];
    contextManifests: Array<{ manifestId: string; payloadJson: string }>;
  };
  assert.equal(fixture.baseRevision, "6c166f97", "the recorded log predates the capability program");
  assert.equal(fixture.schedulerEvents.length, 26, "the recorded log holds 26 scheduler events");
  const replayed = rebuildSchedulerProjection(fixture.schedulerEvents);
  assert.deepEqual(JSON.parse(JSON.stringify(replayed)), fixture.schedulerProjection);
  assert.equal(replayed.planningTriageDecision, undefined);
  assert.equal(replayed.planningPolicyVersion, undefined);
  assert.equal(replayed.projectDocs, undefined);
  const root = mkdtempSync(join(tmpdir(), "aiboard-t8-replay-"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), {
    evidenceStore: evidence,
    validateCleanupReceipt: () => undefined,
    validateExecutionProfile: acceptFinalVerificationProfile,
  });
  try {
    for (const record of fixture.evidenceRecords) {
      const { id: _id, ...input } = record;
      void _id;
      const written = evidence.record(input as Parameters<SqliteEvidenceStore["record"]>[0]);
      assert.equal(written.id, record.id, "evidence re-records under its captured id");
    }
    for (const event of fixture.schedulerEvents) {
      store.append({
        runId: event.runId,
        type: event.type,
        occurredAt: event.occurredAt,
        actor: event.actor,
        idempotencyKey: event.idempotencyKey,
        payload: event.payload,
      } satisfies NewSchedulerEvent);
    }
    assert.deepEqual(
      JSON.parse(JSON.stringify(rebuildSchedulerProjection(store.readRun("run-pre-capability")))),
      fixture.schedulerProjection,
      "sqlite replay matches the independently captured projection",
    );
  } finally {
    store.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
  for (const entry of fixture.contextManifests) {
    const manifest = parseContextManifestPayload(entry.payloadJson, entry.manifestId);
    assert.equal(manifest.manifestId, entry.manifestId);
    assert.equal(manifest.runId, "run-pre-capability");
  }
});
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join as joinPath } from "node:path";

import { ArtifactStore as T8ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import {
  inspectFinalVerificationExecutionProfile,
} from "../src/final-verification-profile.js";
import type { FinalVerificationPlan } from "../src/final-verification-contracts.js";
import {
  detectLanguageFamilies,
  planLanguageTestReport,
} from "../src/language-execution-profile.js";
import {
  familyForPath,
  generateMutants,
} from "../src/mutation-probe.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { createRunnerCapabilityContract } from "../src/runner-capability-contract.js";
import { SqliteEvidenceStore as T8SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import {
  outcomeFromReportReading,
  readJUnitReport,
  readTrxReport,
} from "../src/test-report-readers.js";
import {
  captureGitBaseline,
  FinalVerificationRuntime as T8FinalVerificationRuntime,
  runGit,
  VerificationWorkspaceManager as T8VerificationWorkspaceManager,
} from "./support/git-fixture.js";

// ---------------------------------------------------------------------------
// Suite D: non-JS final-family coverage (SRC-P T8; EP45-EP47; V3/AR-R26).
// A missing host toolchain is an explicit host-gated skip naming the exact
// missing tool — never a pass.
// ---------------------------------------------------------------------------

/** PATH lookup without spawning: the exact host-gate probe. */
function t8Which(executable: string): string | undefined {
  const pathEnv = process.env.PATH ?? process.env.Path ?? "";
  const candidates = process.platform === "win32"
    ? (() => {
      const exts = (process.env.PATHEXT ?? ".EXE").split(";").map((ext) => ext.toLowerCase());
      const names = [executable];
      if (!/\.[a-z0-9]+$/i.test(executable)) {
        for (const ext of exts) names.push(`${executable}${ext}`);
      }
      return names;
    })()
    : [executable];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const name of candidates) {
      try {
        const full = joinPath(dir, name);
        if (!statSync(full).isDirectory()) return full;
      } catch {
        // Not here; keep scanning.
      }
    }
  }
  return undefined;
}

async function t8WriteFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    const absolute = joinPath(root, ...path.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
}

async function t8CommitAll(cwd: string, message: string): Promise<string> {
  await runGit({ cwd, args: ["add", "-A"] });
  await runGit({ cwd, args: ["commit", "-m", message] });
  return (await runGit({ cwd, args: ["rev-parse", "HEAD"] })).stdout.trim();
}

function t8CategoryPlan(required: "build" | "tests"): FinalVerificationPlan {
  const skipped = (category: "build" | "tests" | "runtime_smoke" | "browser", reason: string) => ({
    category,
    status: "not_applicable" as const,
    rationale: reason,
    repositoryInspection: { paths: ["fixture"], summary: reason },
  });
  return {
    checks: [
      required === "build" ? { category: "build", status: "required" } : skipped("build", "No build command is present."),
      required === "tests" ? { category: "tests", status: "required" } : skipped("tests", "No tests command is present."),
      skipped("runtime_smoke", "No runtime command is present."),
      skipped("browser", "No browser surface is present."),
    ],
  };
}

interface T8RealCategoryInput {
  project: string;
  state: string;
  runId: string;
  revision: string;
  generationId: string;
  categories: ("build" | "tests")[];
}

/**
 * The real build/tests category pipeline: the inspected execution profile
 * (never hand-written), the real audited executor, one real Git worktree
 * checkout shared across the run's categories, and the product report
 * readers. Returns each category check plus its report texts.
 */
async function t8RunRealCategory(input: T8RealCategoryInput) {
  const profile = await inspectFinalVerificationExecutionProfile({
    repositoryRoot: input.project,
    targetRevision: input.revision,
    execute: runGit,
  });
  const artifacts = new T8ArtifactStore(joinPath(input.state, "artifacts"));
  const evidence = new T8SqliteEvidenceStore(joinPath(input.state, "evidence.sqlite"));
  const ambient = { ...snapshotNativeBuildAmbientEnvironment() };
  delete ambient.NODE_TEST_CONTEXT;
  const host = createExecutionHost({
    projectRoot: input.project,
    stateDirectory: input.state,
    artifacts,
    ambientEnvironment: ambient,
  });
  try {
    const config = emptyRunnerCapabilitiesConfig();
    const capabilityContract = await createRunnerCapabilityContract(config);
    const binding = await host.bindRun({
      runId: input.runId,
      permissionProfile: "full",
      capabilityContract,
      capabilitiesConfig: config,
    });
    const workspace = new T8VerificationWorkspaceManager({
      repositoryRoot: input.project,
      stateDirectory: input.state,
      runId: input.runId,
      targetRevision: input.revision,
    });
    const runtime = new T8FinalVerificationRuntime({
      workspaceManager: workspace,
      artifacts,
      evidenceStore: evidence,
      runId: input.runId,
      integrationRevision: () => input.revision,
      generationId: input.generationId,
      execution: binding.commandExecution,
    });
    try {
      const fullCommands = Object.fromEntries(
        Object.entries(profile.commands).map(([category, entries]) => [
          category,
          (entries ?? []).map((command) => ({ ...command, args: [...command.args] })),
        ]),
      ) as { tests: { label: string; executable: string; args: string[] }[] };
      const runs: Array<{
        category: "build" | "tests";
        run: Awaited<ReturnType<T8FinalVerificationRuntime["runCategory"]>>;
        reportTexts: (string | null)[];
        rawReport: string | null;
      }> = [];
      for (const category of input.categories) {
        const planned = category === "tests" ? profile.commands.tests : profile.commands.build;
        assert.ok(planned && planned.length > 0, `the inspected profile plans ${category} commands`);
        const run = await runtime.runCategory(
          {
            plan: t8CategoryPlan(category),
            executionProfile: profile,
            commands: fullCommands,
          },
          category,
        );
        const reportTexts: (string | null)[] = [];
        for (const fact of run.check.facts) {
          if (fact.kind !== "command") continue;
          const hash = (fact as { report?: { artifactHash?: string } }).report?.artifactHash;
          reportTexts.push(hash ? (await artifacts.get(hash)).toString("utf8") : null);
        }
        // The runner-owned report file as the command wrote it, read before
        // workspace cleanup (null when the command wrote nothing).
        let rawReport: string | null = null;
        for (const entry of readdirSync(run.workspacePath)) {
          if (entry.startsWith(".aiboard-report-") && entry.endsWith(".xml")) {
            rawReport = readFileSync(joinPath(run.workspacePath, entry), "utf8");
            break;
          }
        }
        runs.push({ category, run, reportTexts, rawReport });
      }
      return { profile, runs };
    } finally {
      await workspace.cleanup().catch(() => undefined);
    }
  } finally {
    evidence.close();
    await host.close();
  }
}

function t8CommandReport(check: { facts: readonly { kind: string }[] }): { executed: number; failed: number; artifactHash?: string } | undefined {
  const fact = check.facts.find((entry) => entry.kind === "command") as unknown as
    | { report?: { executed: number; failed: number; artifactHash?: string } }
    | undefined;
  return fact?.report;
}

const T8D_CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.9.0" />
    <PackageReference Include="xunit" Version="2.9.3" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
  </ItemGroup>
</Project>
`;
const T8D_CALC_BROKEN = "public static class Calc\n{\n    public static int Value => 1;\n}\n";
const T8D_CALC_FIXED = "public static class Calc\n{\n    public static int Value => 2;\n}\n";
const T8D_CALC_TESTS = `using Xunit;

public sealed class CalcTests
{
    [Fact]
    public void ValueIsTwo() => Assert.Equal(2, Calc.Value);

    [Fact]
    public void ValueIsNonNegative() => Assert.True(Calc.Value >= 0);
}
`;

test("T8-D1 C#/.NET TRX passes the real tests pipeline (failing baseline, then green)", async (t) => {
  const dotnet = t8Which("dotnet");
  if (!dotnet) {
    t.skip("host-gated: dotnet executable not on PATH");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-t8-dotnet-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  const runId = "run_t8_dotnet";
  try {
    await t8WriteFiles(project, {
      ".gitignore": "bin/\nobj/\nTestResults/\n.aiboard-report-*\n.vs/\n",
      "Calc.Tests.csproj": T8D_CSPROJ,
      "Calc.Tests.cs": T8D_CALC_TESTS,
      "Calc.cs": T8D_CALC_BROKEN,
    });
    await runGit({ cwd: project, args: ["init", "-b", "main"] });
    const brokenRevision = await t8CommitAll(project, "t8 dotnet failing baseline");
    const failing = await t8RunRealCategory({ project, state, runId, revision: brokenRevision, generationId: "t8dotnetfail", categories: ["tests"] });
    const failingCommand = failing.profile.commands.tests?.[0];
    assert.equal(failingCommand?.executable, "dotnet");
    assert.deepEqual(failingCommand?.args, ["test", "Calc.Tests.csproj", "--disable-build-servers"]);
    assert.deepEqual(failing.profile.reports, [{ commandLabel: "dotnet test", runner: "dotnet test", format: "trx" }]);
    assert.equal(failing.runs[0]!.run.check.green, false, failing.runs[0]!.run.check.issues.join("\n"));
    assert.deepEqual(
      { executed: t8CommandReport(failing.runs[0]!.run.check)?.executed, failed: t8CommandReport(failing.runs[0]!.run.check)?.failed },
      { executed: 2, failed: 1 },
    );
    assert.equal(failing.runs[0]!.reportTexts.length, 1);
    const failingReading = readTrxReport(failing.runs[0]!.reportTexts[0]);
    assert.equal(failingReading.status, "ok");
    if (failingReading.status === "ok") {
      assert.deepEqual(failingReading.counts, { selected: 2, passed: 1, failed: 1, skipped: 0 });
      assert.equal(outcomeFromReportReading(failingReading).outcome, "failed");
    }
    await t8WriteFiles(project, { "Calc.cs": T8D_CALC_FIXED });
    const fixedRevision = await t8CommitAll(project, "t8 dotnet fix");
    const passing = await t8RunRealCategory({ project, state, runId, revision: fixedRevision, generationId: "t8dotnetpass", categories: ["tests"] });
    assert.equal(passing.runs[0]!.run.check.green, true, passing.runs[0]!.run.check.issues.join("\n"));
    assert.deepEqual(
      { executed: t8CommandReport(passing.runs[0]!.run.check)?.executed, failed: t8CommandReport(passing.runs[0]!.run.check)?.failed },
      { executed: 2, failed: 0 },
    );
    assert.match(t8CommandReport(passing.runs[0]!.run.check)?.artifactHash ?? "", /^[a-f0-9]{64}$/, "this run's TRX is captured immutably");
    assert.equal(passing.runs[0]!.reportTexts.length, 1);
    const passingReading = readTrxReport(passing.runs[0]!.reportTexts[0]);
    assert.equal(passingReading.status, "ok");
    if (passingReading.status === "ok") {
      assert.deepEqual(passingReading.counts, { selected: 2, passed: 2, failed: 0, skipped: 0 });
      assert.equal(outcomeFromReportReading(passingReading).outcome, "passed");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
const T8D_CMAKE_BROKEN = `cmake_minimum_required(VERSION 3.20)
project(t8ctest NONE)
enable_testing()
add_test(NAME pass_echo COMMAND \${CMAKE_COMMAND} -E echo t8-ok)
add_test(NAME check_value COMMAND \${CMAKE_COMMAND} -E compare_files value.txt expected.txt)
`;
// Real ctest-emitted JUnit bytes captured on this host (ctest 4.3.1,
// Visual Studio 18 multi-config generator, `ctest -C Debug
// --output-junit`, 2026-10-07; script-mode fixture with absolute source
// paths). Timestamps vary per run; the reader ignores them.
const T8D_CTEST_JUNIT_RED = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="(empty)"
\ttests="2"
\tfailures="1"
\tdisabled="0"
\tskipped="0"
\thostname=""
\ttime="0"
\ttimestamp="2026-10-07T02:42:48"
\t>
\t<testcase name="pass_echo" classname="pass_echo" time="0.0154132" status="run">
\t\t<properties/>
\t\t<system-out>t8-ok
</system-out>
\t</testcase>
\t<testcase name="check_value" classname="check_value" time="0.0135743" status="fail">
\t\t<failure message="Failed"/>
\t\t<properties/>
\t\t<system-out></system-out>
\t</testcase>
</testsuite>
`;
const T8D_CTEST_JUNIT_GREEN = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="(empty)"
\ttests="2"
\tfailures="0"
\tdisabled="0"
\tskipped="0"
\thostname=""
\ttime="0"
\ttimestamp="2026-10-07T02:42:48"
\t>
\t<testcase name="pass_echo" classname="pass_echo" time="0.0142212" status="run">
\t\t<properties/>
\t\t<system-out>t8-ok
</system-out>
\t</testcase>
\t<testcase name="check_value" classname="check_value" time="0.0139742" status="run">
\t\t<properties/>
\t\t<system-out></system-out>
\t</testcase>
</testsuite>
`;
const T8D_CTEST_JUNIT_NOTRUN = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="(empty)"
\ttests="2"
\tfailures="0"
\tdisabled="0"
\tskipped="2"
\thostname=""
\ttime="0"
\ttimestamp="2026-10-07T02:41:28"
\t>
\t<testcase name="pass_echo" classname="pass_echo" time="0" status="notrun">
\t\t<skipped message="Missing Configuration"/>
\t\t<properties/>
\t\t<system-out>Test not available without configuration.  (Missing "-C &lt;config&gt;"?)</system-out>
\t</testcase>
\t<testcase name="check_value" classname="check_value" time="0" status="notrun">
\t\t<skipped message="Missing Configuration"/>
\t\t<properties/>
\t\t<system-out>Test not available without configuration.  (Missing "-C &lt;config&gt;"?)</system-out>
\t</testcase>
</testsuite>
`;

test("T8-D2 cmake/ctest executes for real; the outcome always matches reality, never false green", async (t) => {
  const cmake = t8Which("cmake");
  const ctest = t8Which("ctest");
  if (!cmake || !ctest) {
    const missing = [!cmake ? "cmake" : null, !ctest ? "ctest" : null].filter((tool) => tool !== null);
    t.skip(`host-gated: ${missing.join(" and ")} not on PATH`);
    return;
  }
  // Compiled C++ stays host-gated: no bare C++ compiler is on PATH (cl,
  // g++, gcc, clang++ all absent). A VS-bundled cl exists off-PATH, but
  // CXX compiler detection hangs under the runner's audited execution
  // (manual configure succeeds in 1.7s outside the fence), so compiled
  // execution cannot qualify here. The CMake configure/build + ctest
  // --output-junit delivery path executes for real in script mode,
  // mirroring the V3 CMAKE_TESTS fixture shape.
  const bareCompiler = t8Which("cl") ?? t8Which("g++") ?? t8Which("gcc") ?? t8Which("clang++");
  if (!bareCompiler) {
    console.info("T8-D2 compiled C++ host-gated: no C++ compiler on PATH (cl, g++, gcc, clang++ absent)");
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-t8-ctest-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  const runId = "run_t8_ctest";
  try {
    await t8WriteFiles(project, {
      "CMakeLists.txt": T8D_CMAKE_BROKEN,
      "value.txt": "1\n",
      "expected.txt": "2\n",
    });
    await runGit({ cwd: project, args: ["init", "-b", "main"] });
    const revision = await t8CommitAll(project, "t8 ctest fixture");
    const live = await t8RunRealCategory({ project, state, runId, revision, generationId: "t8ctestlive", categories: ["build", "tests"] });
    assert.deepEqual(
      live.profile.commands.build?.map((command) => [command.executable, ...command.args]),
      [["cmake", "-S", ".", "-B", ".aiboard-cmake-build"], ["cmake", "--build", ".aiboard-cmake-build"]],
    );
    assert.deepEqual(live.profile.commands.tests, [
      { label: "ctest", executable: "ctest", args: ["--test-dir", ".aiboard-cmake-build"] },
    ]);
    assert.deepEqual(live.profile.reports, [{ commandLabel: "ctest", runner: "ctest", format: "junit" }]);
    const build = live.runs.find((entry) => entry.category === "build")!;
    const tests = live.runs.find((entry) => entry.category === "tests")!;
    assert.equal(build.run.check.green, true, build.run.check.issues.join("\n"));
    assert.equal(tests.reportTexts.length, 1);
    // The planned ctest executed for real. What it could run depends on
    // the host generator: single-config hosts run the tests (red here),
    // while multi-config hosts without a planned -C run nothing. Either
    // way the recorded outcome must match reality — never false green.
    const raw = tests.rawReport;
    assert.ok(raw && raw.includes("<testsuite"), "the live ctest run wrote a real JUnit report");
    const reading = readJUnitReport(raw);
    assert.equal(reading.status, "ok");
    if (raw.includes('status="notrun"')) {
      if (reading.status === "ok") {
        assert.deepEqual(reading.counts, { selected: 2, passed: 0, failed: 0, skipped: 2 });
      }
      assert.equal(outcomeFromReportReading(reading).outcome, "unknown", "zero executed never passes");
      assert.equal(t8CommandReport(tests.run.check), undefined, "no counts are minted when nothing executed");
      assert.equal(tests.run.check.green, false);
    } else {
      if (reading.status === "ok") {
        assert.deepEqual(reading.counts, { selected: 2, passed: 1, failed: 1, skipped: 0 });
      }
      assert.equal(outcomeFromReportReading(reading).outcome, "failed");
      assert.deepEqual(
        { executed: t8CommandReport(tests.run.check)?.executed, failed: t8CommandReport(tests.run.check)?.failed },
        { executed: 2, failed: 1 },
      );
      assert.equal(tests.run.check.green, false);
      assert.equal(tests.reportTexts[0], raw, "the archived report bytes equal the written bytes");
    }
    // Real ctest-emitted bytes read to exact counts through the product
    // reader on every host: red, green, and the notrun floor.
    const red = readJUnitReport(T8D_CTEST_JUNIT_RED);
    assert.equal(red.status, "ok");
    if (red.status === "ok") {
      assert.deepEqual(red.counts, { selected: 2, passed: 1, failed: 1, skipped: 0 });
    }
    assert.equal(outcomeFromReportReading(red).outcome, "failed");
    const green = readJUnitReport(T8D_CTEST_JUNIT_GREEN);
    assert.equal(green.status, "ok");
    if (green.status === "ok") {
      assert.deepEqual(green.counts, { selected: 2, passed: 2, failed: 0, skipped: 0 });
    }
    assert.equal(outcomeFromReportReading(green).outcome, "passed");
    const notrun = readJUnitReport(T8D_CTEST_JUNIT_NOTRUN);
    assert.equal(notrun.status, "ok");
    if (notrun.status === "ok") {
      assert.deepEqual(notrun.counts, { selected: 2, passed: 0, failed: 0, skipped: 2 });
    }
    assert.equal(outcomeFromReportReading(notrun).outcome, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const T8D_PYTEST_INI = `[pytest]
testpaths = tests
`;
const T8D_TEST_PY = `def test_value_is_two():
    assert 1 + 1 == 2


def test_value_is_non_negative():
    assert 2 >= 0
`;
const T8D_PYTEST_JUNIT_PASS = `<?xml version="1.0" encoding="utf-8"?>
<testsuite name="pytest" errors="0" failures="0" skipped="0" tests="2" time="0.02">
  <testcase classname="tests.test_calc" name="test_value_is_two" time="0.01" />
  <testcase classname="tests.test_calc" name="test_value_is_non_negative" time="0.01" />
</testsuite>
`;
const T8D_PYTEST_JUNIT_FAIL = `<?xml version="1.0" encoding="utf-8"?>
<testsuite name="pytest" errors="0" failures="1" skipped="0" tests="2" time="0.02">
  <testcase classname="tests.test_calc" name="test_value_is_two" time="0.01">
    <failure message="assert 1 == 2">E       assert 1 == 2</failure>
  </testcase>
  <testcase classname="tests.test_calc" name="test_value_is_non_negative" time="0.01" />
</testsuite>
`;

test("T8-D3a Python family: detection, planned junitxml, honest reader counts, toolchain-free mutator", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t8-pytest-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  try {
    await t8WriteFiles(project, {
      "pytest.ini": T8D_PYTEST_INI,
      "tests/test_calc.py": T8D_TEST_PY,
    });
    await runGit({ cwd: project, args: ["init", "-b", "main"] });
    const revision = await t8CommitAll(project, "t8 pytest fixture");
    const files = ["pytest.ini", "tests/test_calc.py"];
    const readFile = (relativePath: string): string | undefined =>
      files.includes(relativePath)
        ? readFileSync(joinPath(project, relativePath), "utf8")
        : undefined;
    const detections = detectLanguageFamilies({ files, readFile });
    assert.deepEqual(detections.map((detection) => detection.family), ["pytest"]);
    assert.deepEqual(detections[0]!.tests, { label: "pytest", executable: "pytest", args: [] });
    const profile = await inspectFinalVerificationExecutionProfile({
      repositoryRoot: project,
      targetRevision: revision,
      execute: runGit,
    });
    assert.deepEqual(profile.commands.tests, [{ label: "pytest", executable: "pytest", args: [] }]);
    assert.deepEqual(profile.reports, [{ commandLabel: "pytest", runner: "pytest", format: "junit" }]);
    const planned = planLanguageTestReport({
      checkoutPath: project,
      command: { label: "pytest", executable: "pytest", args: [] },
      reportName: "t8pytest",
    });
    assert.equal(planned?.runner, "pytest");
    assert.equal(planned?.format, "junit");
    assert.deepEqual(planned?.command?.args, ["--junitxml=.aiboard-report-t8pytest.xml"]);
    const passing = readJUnitReport(T8D_PYTEST_JUNIT_PASS);
    assert.equal(passing.status, "ok");
    if (passing.status === "ok") {
      assert.deepEqual(passing.counts, { selected: 2, passed: 2, failed: 0, skipped: 0 });
      assert.equal(outcomeFromReportReading(passing).outcome, "passed");
    }
    const failing = readJUnitReport(T8D_PYTEST_JUNIT_FAIL);
    assert.equal(failing.status, "ok");
    if (failing.status === "ok") {
      assert.deepEqual(failing.counts, { selected: 2, passed: 1, failed: 1, skipped: 0 });
      assert.equal(outcomeFromReportReading(failing).outcome, "failed");
    }
    assert.equal(readJUnitReport("not xml <<<").status, "unknown");
    assert.equal(outcomeFromReportReading(readJUnitReport(null)).outcome, "unknown");
    // Python-family break-it mutator (OA-11): toolchain-free, zero model calls.
    assert.equal(familyForPath("calc.py"), "python");
    const mutants = generateMutants([{
      path: "calc.py",
      content: "if a and b or True:\n    return False\n    # and or True False",
      changedLineNumbers: [1, 2, 3],
    }]);
    assert.ok(mutants.some((mutant) => mutant.original === "and" && mutant.mutated === "or"));
    assert.ok(mutants.some((mutant) => mutant.original === "True" && mutant.mutated === "False"));
    assert.ok(!mutants.some((mutant) => mutant.lineNumber === 3), "comments are never mutated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T8-D3b Python live pytest run through the real tests pipeline (host-gated)", async (t) => {
  // Live execution gate: the pytest module itself must exist.
  const python = t8Which("python") ?? t8Which("python3") ?? t8Which("py");
  if (!python) {
    t.skip("host-gated: no python executable on PATH");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "aiboard-t8-pytest-live-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  try {
    await t8WriteFiles(project, {
      "pytest.ini": T8D_PYTEST_INI,
      "tests/test_calc.py": T8D_TEST_PY,
    });
    await runGit({ cwd: project, args: ["init", "-b", "main"] });
    const revision = await t8CommitAll(project, "t8 pytest live fixture");
    const artifacts = new T8ArtifactStore(joinPath(state, "artifacts"));
    const ambient = { ...snapshotNativeBuildAmbientEnvironment() };
    delete ambient.NODE_TEST_CONTEXT;
    const host = createExecutionHost({
      projectRoot: project,
      stateDirectory: state,
      artifacts,
      ambientEnvironment: ambient,
    });
    try {
      const config = emptyRunnerCapabilitiesConfig();
      const capabilityContract = await createRunnerCapabilityContract(config);
      const binding = await host.bindRun({
        runId: "run_t8_pytest_probe",
        permissionProfile: "full",
        capabilityContract,
        capabilitiesConfig: config,
      });
      // Runner-internal host probe, mirroring the verification runtime's
      // own execution shape (architect actor, runnerInternal).
      const probe = await binding.commandExecution.execute({
        executable: python,
        arguments: ["-m", "pytest", "--version"],
        workingDirectory: project,
        timeoutMs: 60_000,
        context: {
          runId: "run_t8_pytest_probe",
          sessionId: "probe",
          actor: { role: "architect", id: "t8-host-probe" },
          callId: "pytest-probe",
          toolName: "t8-host-probe",
          runnerInternal: true,
        },
      });
      if (probe.process.outcome !== "exited" || probe.process.exitCode !== 0) {
        t.skip("host-gated: python module pytest is not installed (python is present, pytest --version fails)");
        return;
      }
    } finally {
      await host.close();
    }
    const live = await t8RunRealCategory({
      project,
      state,
      runId: "run_t8_pytest",
      revision,
      generationId: "t8pytestlive",
      categories: ["tests"],
    });
    const tests = live.runs.find((entry) => entry.category === "tests")!;
    assert.equal(tests.run.check.green, true, tests.run.check.issues.join("\n"));
    assert.deepEqual(
      { executed: t8CommandReport(tests.run.check)?.executed, failed: t8CommandReport(tests.run.check)?.failed },
      { executed: 2, failed: 0 },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("T8-D4 unknown-language fixture lands on the safe floor and never passes", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t8-unknown-"));
  const project = join(root, "project");
  mkdirSync(project, { recursive: true });
  try {
    await t8WriteFiles(project, { "README.md": "# fixture\n", "notes.txt": "plans\n" });
    await runGit({ cwd: project, args: ["init", "-b", "main"] });
    const revision = await t8CommitAll(project, "t8 unknown fixture");
    assert.deepEqual(detectLanguageFamilies({ files: ["README.md", "notes.txt"] }), []);
    const profile = await inspectFinalVerificationExecutionProfile({
      repositoryRoot: project,
      targetRevision: revision,
      execute: runGit,
    });
    assert.deepEqual(profile.commands, {});
    assert.deepEqual(profile.detectedSignals, []);
    assert.equal(profile.reports, undefined);
    assert.equal(
      planLanguageTestReport({
        checkoutPath: project,
        command: { label: "make", executable: "make", args: ["test"] },
        reportName: "t8unknown",
      }),
      undefined,
      "no family and no package.json wires nothing",
    );
    assert.equal(readJUnitReport(null).status, "unknown");
    assert.equal(readJUnitReport("").status, "unknown");
    assert.equal(readTrxReport("not xml <<<").status, "unknown");
    assert.equal(outcomeFromReportReading(readJUnitReport(null)).outcome, "unknown");
    assert.equal(outcomeFromReportReading(readJUnitReport("")).outcome, "unknown");
    const zeroSelected = readJUnitReport(`<testsuite name="empty" errors="0" failures="0" skipped="0" tests="0"></testsuite>`);
    assert.equal(zeroSelected.status, "ok");
    if (zeroSelected.status === "ok") {
      assert.deepEqual(zeroSelected.counts, { selected: 0, passed: 0, failed: 0, skipped: 0 });
    }
    assert.equal(outcomeFromReportReading(zeroSelected).outcome, "unknown", "zero-selected never passes");
    assert.equal(familyForPath("notes.xyz"), undefined, "unknown language has no mutator family");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
import type { AgentMessage, AgentModel, AgentModelRequest, ModelTurn, ToolContentBlock } from "../src/agent-contracts.js";
import { ControlServer } from "../src/control-server.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import {
  buildExecutionPlanRevision,
  type ExecutionPlanPhase,
  type ExecutionTaskContract,
  type SourceRequirement,
} from "../src/planning-contracts.js";
import { NativeBuildFactory as T8NativeBuildFactory } from "./support/git-fixture.js";
import {
  buildApprovedSourceManifest,
  validateApprovedSourceInput,
  type ApprovedSourceInputV1,
} from "../src/native-planning-provisioner.js";
import { currentExplicitStartIdentity } from "../src/scheduler-store.js";
import { computeArtifactDigest } from "../src/source-manifest.js";
import { runnerRunStateSegment } from "../src/run-state-identity.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";

// ---------------------------------------------------------------------------
// Suite A shared: unseeded factory journeys on the integrated candidate.
// Only model transports are scripted; HTTP provisioning, planning control,
// SQLite, Git, worktrees, and executed commands are real.
// ---------------------------------------------------------------------------

const T8_CLOCK = "2026-10-07T00:00:00.000Z";

function t8SourceBytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

function t8SourceInput(text: string, sections?: ApprovedSourceInputV1["sections"]): ApprovedSourceInputV1 {
  return {
    version: 1,
    approval: "approved_spec",
    bytesBase64: Buffer.from(text).toString("base64"),
    mediaType: "text/plain",
    encoding: "utf-8",
    ...(sections !== undefined ? { sections } : {}),
  };
}

/** Byte ranges for one section per line, in id order. */
function t8LineSections(text: string, ids: readonly string[]): { id: string; startByte: number; endByte: number }[] {
  const lines = text.split("\n");
  assert.equal(lines.length, ids.length + 1);
  assert.equal(lines[lines.length - 1], "");
  const sections: { id: string; startByte: number; endByte: number }[] = [];
  let start = 0;
  for (let index = 0; index < ids.length; index += 1) {
    const end = start + Buffer.byteLength(`${lines[index]!}\n`, "utf8");
    sections.push({ id: ids[index]!, startByte: start, endByte: end });
    start = end;
  }
  return sections;
}

const T8_SOURCE_V1 =
  "SECTION s1: MANDATORY. The value module must expose VALUE 2.\n" +
  "SECTION s2: CONDITIONAL. IF the project ships aiboard.config.json THEN the value module must read its default from that config.\n";
const T8_SOURCE_V2 =
  T8_SOURCE_V1 +
  "SECTION s3: OPERATIONAL. The value behavior must be covered by tests; caf\u00e9 stays byte-exact.\n";

function t8Call(name: string, args: unknown, id: string): ModelTurn {
  return {
    blocks: [{ type: "tool_call", callId: id, name, arguments: args }],
    stopReason: "tool_calls",
    usage: { inputTokens: 8, outputTokens: 4 },
  };
}

function t8TextTurn(text: string): ModelTurn {
  return { blocks: [{ type: "text", text }], stopReason: "end_turn", usage: { inputTokens: 8, outputTokens: 4 } };
}

function t8LastToolValue(request: AgentModelRequest): Record<string, unknown> | undefined {
  const message = [...request.messages].reverse().find((candidate) => candidate.role === "tool");
  const content = (message?.content as { content?: Array<{ type: string; value?: unknown }> } | undefined)?.content;
  return content?.find((item) => item.type === "json")?.value as Record<string, unknown> | undefined;
}

/** Bounded total preview of the last tool message: never throws, never masks a refusal. */
function t8ToolPreview(request: AgentModelRequest | undefined, max = 2000): string {
  if (!request) return "no-requests";
  try {
    const tools = request.messages.filter((message) => message.role === "tool");
    const text = JSON.stringify(tools.at(-1)?.content ?? null);
    return (typeof text === "string" ? text : "unserializable-tool-content").slice(0, max);
  } catch {
    return "unserializable-tool-content";
  }
}

function t8Provider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return {
    runtimeId,
    providerId: providerId!,
    modelId: modelId!,
    transport: "openai-compatible",
    baseUrl: "http://127.0.0.1:9",
    secret: "unused",
    capabilities: ["code"],
    priority,
  };
}

function t8Requirements(
  manifest: { sourceId: string },
  tasks: "single" | "spine",
  conditional: "applicable" | "conditional_pending",
): SourceRequirement[] {
  const contributor = tasks === "single" ? ["T1"] : ["T-A"];
  const configContributor = tasks === "single" ? ["T1"] : ["T-B"];
  const testsContributor = tasks === "single" ? ["T1"] : ["T-A", "T-B", "T-C"];
  return [
    {
      id: "REQ-1",
      reference: { sourceId: manifest.sourceId, sectionIds: ["s1"] },
      purpose: "Expose VALUE 2 from the value module.",
      observableOutcome: "The value module exposes VALUE 2.",
      obligationKind: "mandatory",
      applicability: { status: "applicable" },
      accountablePhaseId: "P1",
      contributingTaskIds: contributor,
      acceptanceConditions: [{
        id: "REQ-1-ac1",
        description: "VALUE is 2.",
        responsibleGateId: "P1-exit",
        requiredEvidenceKinds: ["command"],
      }],
    },
    {
      id: "REQ-2",
      reference: { sourceId: manifest.sourceId, sectionIds: ["s2"] },
      purpose: "Read the configured default when a config ships.",
      observableOutcome: "The value module reads its default from aiboard.config.json.",
      obligationKind: "conditional",
      applicability: conditional === "applicable"
        ? { status: "applicable" }
        : { status: "conditional_pending", conditionExpression: "project ships aiboard.config.json" },
      accountablePhaseId: "P1",
      contributingTaskIds: configContributor,
      acceptanceConditions: [{
        id: "REQ-2-ac1",
        description: "The default comes from the config.",
        responsibleGateId: "P1-exit",
        requiredEvidenceKinds: ["command"],
      }],
    },
    {
      id: "REQ-3",
      reference: { sourceId: manifest.sourceId, sectionIds: ["s3"] },
      purpose: "Cover the value behavior with tests.",
      observableOutcome: "Tests cover the value behavior.",
      obligationKind: "operational",
      applicability: { status: "applicable" },
      accountablePhaseId: "P1",
      contributingTaskIds: testsContributor,
      acceptanceConditions: [{
        id: "REQ-3-ac1",
        description: "Tests cover the behavior.",
        responsibleGateId: "P1-exit",
        requiredEvidenceKinds: ["command"],
      }],
    },
  ];
}

function t8Phases(mode: "single" | "spine"): ExecutionPlanPhase[] {
  return [{
    id: "P1",
    purpose: "Deliver the value modules.",
    requirementIds: ["REQ-1", "REQ-2", "REQ-3"],
    scope: { includes: ["src/**", "test/**", "aiboard.config.json"], excludes: ["docs/project/STATE.md"] },
    entryConditions: ["Plan ready."],
    contributingTaskIds: mode === "single" ? ["T1"] : ["T-A", "T-B", "T-C"],
    exitCriteria: ["The value behavior is accepted."],
    requiredCombinedValidation: ["tests"],
    exitUnlocks: ["final verification"],
  }];
}

function t8Task(
  id: string,
  requirementIds: string[],
  outcome: string,
  files: string[],
  dependencies: string[],
  revisionId: string,
): ExecutionTaskContract {
  return {
    id,
    lineage: [],
    accountablePhaseId: "P1",
    requirementIds,
    outcome: { user: outcome, system: outcome },
    scope: { includes: files, excludes: [] },
    writableSurfaces: files.filter((file) => file.startsWith("src/")),
    forbiddenSurfaces: ["docs/project/STATE.md"],
    dependencies,
    requiredBase: `accepted plan revision ${revisionId}`,
    inputs: ["accepted plan revision"],
    outputs: files.filter((file) => file.startsWith("src/")),
    steps: ["Implement the outcome.", "Run the tests."],
    acceptance: { criteria: [{ id: "c1", text: `${outcome} and the tests pass.` }], definitionOfDone: "Tests pass." },
    validation: { targetedRationale: "The module tests.", affectedScopeRationale: "The module only." },
    negativeProofApplicability: { applicable: false, rationale: "No prior-incorrect case." },
    reviewCriteria: ["Independent review confirms the outcome."],
    integrationChecks: ["Post-integration tests."],
    cleanup: { cleanup: "None.", recovery: "Retry.", rollback: "Revert." },
    requirementCriteriaMap: requirementIds.map((requirementId) => ({ taskLocalCriterionId: "c1", requirementId })),
  };
}

function t8Scenario(
  runId: string,
  manifest: ApprovedSourceManifest,
  mode: "single" | "spine",
  conditional: "applicable" | "conditional_pending",
  revisionId: string,
): { requirements: SourceRequirement[]; phases: ExecutionPlanPhase[]; revision: ReturnType<typeof buildExecutionPlanRevision> } {
  const requirements = t8Requirements(manifest, mode, conditional);
  const phases = t8Phases(mode);
  const tasks = mode === "single"
    ? [t8Task("T1", ["REQ-1", "REQ-2", "REQ-3"], "Deliver the value module.", ["src/value.mjs", "test/value.test.mjs"], [], revisionId)]
    : [
      t8Task("T-A", ["REQ-1", "REQ-3"], "Deliver module A exposing VALUE 2.", ["src/a.mjs", "test/a.test.mjs"], [], revisionId),
      t8Task("T-B", ["REQ-2", "REQ-3"], "Deliver module B reading the config default.", ["src/b.mjs", "test/b.test.mjs"], [], revisionId),
      t8Task("T-C", ["REQ-3"], "Deliver module C joining A and B.", ["src/c.mjs", "test/c.test.mjs"], ["T-A", "T-B"], revisionId),
    ];
  const revision = buildExecutionPlanRevision({
    revisionId,
    runId,
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements,
    tasks,
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [],
    validationObligations: ["tests"],
    createdAt: T8_CLOCK,
  });
  return { requirements, phases, revision };
}

function t8ManifestFor(
  runId: string,
  text: string,
  sectionIds: readonly string[],
): ReturnType<typeof buildApprovedSourceManifest> {
  const bytes = t8SourceBytes(text);
  const validated = validateApprovedSourceInput(t8SourceInput(text, t8LineSections(text, sectionIds)));
  return buildApprovedSourceManifest({
    runId,
    validated,
    artifactDigest: computeArtifactDigest(bytes),
    approvedBy: "local-user",
    createdAt: T8_CLOCK,
  });
}

interface T8ServedFactory {
  factory: T8NativeBuildFactory;
  manager: NativeBuildManager;
  server: ControlServer;
  supervisor: RunSupervisor;
  executionHost: ReturnType<typeof createExecutionHost>;
  url: string;
  runtime: () => { step: () => Promise<{ status: string; action?: string }>; projection: () => SchedulerProjection };
  control: (path: string, input: unknown, method?: string) => Promise<Response>;
  close: () => Promise<void>;
}

/** Unseeded authenticated stack over real SQLite/Git; models are scripted. */
async function t8ServeFactory(input: {
  root: string;
  project: string;
  state: string;
  runId: string;
  token: string;
  baselineRevision: string;
  architect: AgentModel;
  worker: AgentModel;
  reviewer: AgentModel;
  build: Record<string, unknown>;
}): Promise<T8ServedFactory> {
  const { root, project, state, runId, token } = input;
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
  });
  const supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")), { clock: () => T8_CLOCK });
  let runtimeRef: { step: () => Promise<{ status: string; action?: string }>; projection: () => SchedulerProjection } | undefined;
  const factory = new T8NativeBuildFactory({
    projectRoot: project,
    stateDirectory: state,
    providerConfigs: {
      load: () => [t8Provider("arch:architect", 1), t8Provider("work:worker", 2), t8Provider("rev:reviewer", 3)],
      save: () => undefined,
      close: () => undefined,
    },
    executionHost,
    baselineFor: () => input.baselineRevision,
    providerModelFactory: (config) =>
      config.runtimeId === "arch:architect" ? input.architect : config.runtimeId === "work:worker" ? input.worker : input.reviewer,
  });
  const manager = new NativeBuildManager({
    specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
    createRuntime: (spec) => factory.create(spec).then((handle) => {
      runtimeRef = handle.runtime as typeof runtimeRef & {};
      return handle;
    }),
    prepareSpec: (spec, options) => factory.prepareSpec(spec, options),
  });
  const server = new ControlServer({
    supervisor,
    token,
    builds: manager,
    buildProvisioner: manager,
    checkGit: async () => ({ available: true, version: "fixture-git", code: "git_ready", reason: null }),
    bootstrapRun: async () => ({ baselineRevision: input.baselineRevision, baselineRef: `refs/aiboard/baselines/${runId}` }),
  });
  const address = await server.start(0);
  return {
    factory,
    manager,
    server,
    supervisor,
    executionHost,
    url: address.url,
    runtime: () => {
      assert.ok(runtimeRef, "the runtime handle is captured on creation or recovery");
      return runtimeRef;
    },
    control: (path, body, method = "POST") => fetch(`${address.url}/v2/runs/${runId}/build/${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }),
    close: async () => {
      await server.close();
      supervisor.close();
      await manager.close();
      await factory.close();
      await executionHost.close();
    },
  };
}

async function t8StepUntil(
  label: string,
  runtime: () => { step: () => Promise<{ status: string; action?: string }>; projection: () => SchedulerProjection },
  done: (projection: SchedulerProjection) => boolean,
  cap = 200,
): Promise<SchedulerProjection> {
  for (let step = 0; step < cap; step += 1) {
    const projection = runtime().projection();
    if (done(projection)) return projection;
    if (projection.status === "paused" || projection.status === "failed") {
      throw new Error(`${label}: ${projection.status} ${JSON.stringify(projection.pauseReason)}`);
    }
    await runtime().step();
  }
  throw new Error(`${label}: not reached`);
}

/** Scripted coverage reviewer: obligations, then a covered verdict. */
class T8CoverageReviewer implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  constructor(private readonly obligationSpec: { obligations: unknown[]; sectionCoverage: unknown[]; verdictRationale: string }) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const seen = request.messages.filter((message) => message.role === "tool").length;
    const tools = new Set(request.tools.map((tool) => tool.name));
    if (tools.has("record_coverage_obligations")) {
      return t8Call("record_coverage_obligations", {
        obligations: this.obligationSpec.obligations,
        sectionCoverage: this.obligationSpec.sectionCoverage,
      }, `t8-obl-${seen}`);
    }
    if (tools.has("submit_coverage_verdict")) {
      const obligations = this.obligationSpec.obligations as { id: string }[];
      return t8Call("submit_coverage_verdict", {
        obligationVerdicts: obligations.map((obligation) => ({
          obligationId: obligation.id,
          verdict: "covered",
          severity: "advisory",
          rationale: this.obligationSpec.verdictRationale,
          evidenceRefs: ["ledger:REQ-1"],
        })),
        findings: [],
      }, `t8-verdict-${seen}`);
    }
    throw new Error(`T8 coverage reviewer: unexpected tools ${[...tools].join(",")}.`);
  }
}

import {
  HANDOFF_STATE_PATH,
  V2_AGENTS_SECTION_BODY,
  V2_CLAUDE_POINTER_LINE,
} from "../src/project-docs.js";

async function t8GitText(cwd: string, args: string[]): Promise<string> {
  return (await runGit({ cwd, args })).stdout.trim();
}

function t8SnapshotCommits(events: { type: string }[]): { sequence: number; payload: Record<string, unknown> }[] {
  return (events as { sequence: number; type: string; payload: Record<string, unknown> }[])
    .filter((event) => event.type === "project_docs.handoff_snapshot_committed")
    .map((event) => ({ sequence: event.sequence, payload: event.payload }));
}

function t8IntegrationRepoPath(state: string): string {
  const entries = readdirSync(joinPath(state, "integration"));
  assert.equal(entries.length, 1);
  return joinPath(state, "integration", entries[0]!);
}

async function t8TreeFiles(cwd: string, revision: string): Promise<string[]> {
  return (await t8GitText(cwd, ["ls-tree", "-r", "--name-only", revision])).split("\n").filter((line) => line.length > 0);
}

/** Scripted planning Architect: triage → reads → ledger → draft → review → (revise → review) → complete. */
class T8PlanningArchitect implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  private calls = 0;
  private readonly reviewsRequested = new Set<string>();
  constructor(
    private readonly projection: () => SchedulerProjection,
    private readonly scenario: { manifest: { manifestId: string; sections: readonly { id: string; digest: string }[] }; requirements: SourceRequirement[]; phases: ExecutionPlanPhase[]; revision: { revisionId: string; digest: string } & Record<string, unknown> },
    private readonly options: { ledgerRequirements?: SourceRequirement[]; revise?: () => Record<string, unknown>; completeSummary?: string } = {},
  ) {}
  private call(name: string, args: unknown): ModelTurn {
    this.calls += 1;
    return t8Call(name, args, `t8-arch-${this.calls}`);
  }
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const tools = new Set(request.tools.map((tool) => tool.name));
    if (tools.has("complete_run") && this.projection().planning?.readiness === "ready") {
      return this.call("complete_run", { summary: this.options.completeSummary ?? "Plan ready." });
    }
    const projection = this.projection();
    const planning = projection.planning;
    if (projection.planningTriageDecision === undefined) {
      return this.call("record_triage", { decision: "build", rationale: "T8: the approved source changes the project." });
    }
    const manifestId = planning?.source.currentManifestId;
    assert.ok(manifestId, "the approved source is registered before planning reads");
    const reads = planning?.sourceReadIndex[manifestId] ?? {};
    const sections = this.scenario.manifest.sections;
    if (sections.some((section) => reads[section.id] !== section.digest)) {
      const pending = sections.find((section) => reads[section.id] !== section.digest)!;
      if (this.requests.length <= 2) return this.call("read_planning_source_section", {});
      return this.call("read_planning_source_section", { sectionId: pending.id });
    }
    if (!planning?.ledger) {
      return this.call("persist_planning_ledger", {
        id: "ledger-1",
        requirements: this.options.ledgerRequirements ?? this.scenario.requirements,
        phases: this.scenario.phases,
        nonNormativeSections: [],
      });
    }
    if (!planning?.plan) {
      const { digest: _digest, runId: _run, createdAt: _created, ...rest } = this.scenario.revision;
      void _digest;
      void _run;
      void _created;
      return this.call("draft_planning_plan", { revision: rest });
    }
    const plan = planning.plan;
    const firstRevisionId = this.scenario.revision.revisionId as string;
    if (this.options.revise && plan.currentRevisionId === firstRevisionId && this.reviewsRequested.has(firstRevisionId)) {
      return this.call("revise_planning_plan", {
        revision: this.options.revise(),
        expectedRevisionId: plan.currentRevisionId,
        expectedDigest: plan.currentDigest,
      });
    }
    if (!this.reviewsRequested.has(plan.currentRevisionId)) {
      this.reviewsRequested.add(plan.currentRevisionId);
      return this.call("request_coverage_review", { reviewId: `coverage_t8_${plan.currentRevisionId}` });
    }
    throw new Error("T8 planning script exhausted: a review is already pending for the current revision.");
  }
}

// ---------------------------------------------------------------------------
// Suite A3: plan-only attempted execution (SRC-P T8; T7b; C2/AR-R31).
// ---------------------------------------------------------------------------

const T8A3_PACKAGE = `{
  "name": "t8-planonly",
  "type": "module",
  "scripts": { "test": "node --test" }
}
`;
const T8A3_VALUE = "export const VALUE = 1;\n";
const T8A3_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { VALUE } from '../src/value.mjs';\ntest('value', () => assert.equal(VALUE, 2));\n";
const T8A3_CONFIG = `{
  "defaultValue": 2
}
`;

test("T8-A3 plan-only run refuses execution and snapshots the plan", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t8-planonly-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, ".gitignore"), "node_modules/\n");
  writeFileSync(join(project, "package.json"), T8A3_PACKAGE);
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "test"), { recursive: true });
  writeFileSync(join(project, "src", "value.mjs"), T8A3_VALUE);
  writeFileSync(join(project, "test", "value.test.mjs"), T8A3_TEST);
  writeFileSync(join(project, "aiboard.config.json"), T8A3_CONFIG);
  const runId = "run_t8_planonly";
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const manifest = t8ManifestFor(runId, T8_SOURCE_V2, ["s1", "s2", "s3"]);
  const scenario = t8Scenario(runId, manifest, "single", "applicable", "revision_1");
  const workerCalls: AgentModelRequest[] = [];
  const throwingWorker: AgentModel = {
    async complete(request: AgentModelRequest): Promise<ModelTurn> {
      workerCalls.push(request);
      throw new Error("T8-A3: the worker must never dispatch on a plan-only run.");
    },
  };
  const reviewer = new T8CoverageReviewer({
    obligations: [
      { id: "obl-REQ-1", description: "Expose VALUE 2.", requirementId: "REQ-1" },
      { id: "obl-REQ-2", description: "Read the configured default.", requirementId: "REQ-2" },
      { id: "obl-REQ-3", description: "Cover the behavior with tests.", requirementId: "REQ-3" },
    ],
    sectionCoverage: [
      { sectionId: "s1", obligationIds: ["obl-REQ-1"] },
      { sectionId: "s2", obligationIds: ["obl-REQ-2"] },
      { sectionId: "s3", obligationIds: ["obl-REQ-3"] },
    ],
    verdictRationale: "T1 covers each obligation.",
  });
  let served: T8ServedFactory | undefined;
  const architect = new T8PlanningArchitect(
    () => served!.runtime().projection(),
    { manifest, requirements: scenario.requirements, phases: scenario.phases, revision: scenario.revision as unknown as { revisionId: string; digest: string } & Record<string, unknown> },
    { completeSummary: "Plan-only complete: the plan is snapshotted, nothing executes." },
  );
  try {
    served = await t8ServeFactory({
      root, project, state, runId, token: "t8-planonly-token", baselineRevision: baseline.revision,
      architect, worker: throwingWorker, reviewer,
      build: {},
    });
    const created = await fetch(`${served.url}/v2/runs`, {
      method: "POST",
      headers: { Authorization: "Bearer t8-planonly-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runId,
        projectPath: project,
        permissionProfile: "full",
        idempotencyKey: "t8-planonly",
        build: {
          projectId: "t8-planonly-fixture",
          objective: "Plan the value module.",
          architectRuntimeId: "arch:architect",
          workerRuntimeIds: ["work:worker"],
          verifierRuntimeIds: ["rev:reviewer"],
          alwaysRequireIndependentVerifier: false,
          maxConcurrency: 1,
          runPolicy: "plan_only",
          budgetLimits: {},
          planningPolicy: { version: 1 },
          specCopy: true,
          handoffFiles: "commit",
        },
      }),
    });
    assert.equal(created.status, 201, await created.text());
    const approve = await served.control("source", {
      approvedSource: t8SourceInput(T8_SOURCE_V2, t8LineSections(T8_SOURCE_V2, ["s1", "s2", "s3"])),
      idempotencyKey: "approve-source",
    });
    assert.equal(approve.status, 200, await approve.text());
    const ready = await t8StepUntil("ready", served.runtime, (projection) => projection.planning?.readiness === "ready");
    assert.equal(ready.runPolicy, "plan_only");
    assert.equal(ready.tasks.T1?.status, "planned");
    assert.equal(workerCalls.length, 0);
    // Explicit start is refused over HTTP with the plan-only reason.
    const identity = currentExplicitStartIdentity(ready);
    assert.ok(identity, "the ready plan-only plan still has a start identity to refuse");
    const start = await served.control("plan-start", {
      ...identity,
      version: 1,
      ownerChoice: "execute",
      idempotencyKey: "explicit-start",
    });
    const startText = await start.text();
    assert.equal(start.status, 409, startText);
    const startBody = JSON.parse(startText) as { code?: string; error?: string };
    assert.equal(startBody.code, "planning_control_refused");
    assert.match(startBody.error ?? "", /Plan start refused: an executable opted-in build is required\./);
    // Attempted execution is refused at the store gate: no authorization exists.
    const runRoot = join(state, "builds", runnerRunStateSegment(runId));
    const attemptEvidence = new SqliteEvidenceStore(join(runRoot, "evidence.sqlite"));
    const attempt = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"), {
      evidenceStore: attemptEvidence,
      artifacts: new ArtifactStore(join(state, "artifacts")),
    });
    try {
      assert.throws(
        () => attempt.append({
          runId,
          type: "task.transitioned",
          occurredAt: T8_CLOCK,
          actor: { role: "runner", id: "runner" },
          idempotencyKey: "t8-attempted-execution",
          payload: { taskId: "T1", status: "assigned", attempt: 1 },
        }),
        /Worker admission requires an explicit owner start authorization/,
      );
    } finally {
      attempt.close();
      attemptEvidence.close();
    }
    // The run completes with zero dispatch: no worker call, no transition.
    const handoffRequested = await t8StepUntil(
      "handoff requested",
      served.runtime,
      (projection) => projection.projectHandoff?.status === "requested",
    );
    assert.equal(handoffRequested.status, "paused");
    assert.equal(workerCalls.length, 0);
    assert.equal(handoffRequested.tasks.T1?.status, "planned");
    const events = served.manager.events(runId);
    assert.equal(events.filter((event) => event.type === "task.transitioned").length, 0);
    // The plan-only snapshot contains the plan.
    const snapshots = t8SnapshotCommits(events);
    const planSnapshot = snapshots.find((entry) => entry.payload.stopKind === "plan_only");
    assert.ok(planSnapshot, "a plan_only snapshot is committed");
    const repoPath = t8IntegrationRepoPath(state);
    const snapshotCommit = String(planSnapshot.payload.commit);
    const stateBody = await t8GitText(repoPath, ["show", `${snapshotCommit}:${HANDOFF_STATE_PATH}`]);
    for (const needle of ["P1", "T1", "REQ-1", "REQ-2", "REQ-3", "VALUE", "aiboard.config.json"]) {
      assert.ok(stateBody.includes(needle), `the plan-only STATE.md names ${needle}`);
    }
    const snapshotRecord = handoffRequested.projectDocs?.snapshots?.find((entry) => entry.commit === snapshotCommit);
    assert.equal(snapshotRecord?.stopKind, "plan_only");
    assert.equal(snapshotRecord?.specCopied, true, "specCopy stages the approved source");
    assert.ok(snapshotRecord?.specPath, "the snapshot records the spec path");
    // Tree inventory before the handoff selection: the handed-off tree is
    // addressed by the immutable snapshot commit.
    const finalFiles = (await t8TreeFiles(repoPath, snapshotCommit)).sort();
    assert.deepEqual(
      finalFiles,
      [".gitignore", "AGENTS.md", "CLAUDE.md", HANDOFF_STATE_PATH, "aiboard.config.json", "package.json", snapshotRecord!.specPath, "src/value.mjs", "test/value.test.mjs"].sort(),
      "the handed-off tree is exactly baseline plus the kernel handoff files plus the spec copy",
    );
    for (const path of finalFiles) {
      assert.ok(
        !/(^|\/)(evidence|diary|diaries|progress|test-output|notes)(\/|$|\.)/i.test(path),
        `no diary/evidence file in the handed-off tree (got ${path})`,
      );
    }
    const agentsBody = await t8GitText(repoPath, ["show", `${snapshotCommit}:AGENTS.md`]);
    assert.ok(agentsBody.includes(V2_AGENTS_SECTION_BODY), "the committed AGENTS.md holds the static v2 section body");
    const claudeMode = (await t8GitText(repoPath, ["ls-tree", snapshotCommit, "CLAUDE.md"])).split(/\s+/, 2).join(" ");
    if (claudeMode.startsWith("120000")) {
      assert.equal(await t8GitText(repoPath, ["show", `${snapshotCommit}:CLAUDE.md`]), "AGENTS.md");
    } else {
      assert.ok((await t8GitText(repoPath, ["show", `${snapshotCommit}:CLAUDE.md`])).includes(V2_CLAUDE_POINTER_LINE));
    }
    // The explicit owner handoff completes the run; the keep choice leaves
    // the user project tree exactly as it was.
    const projectTreeBefore = await t8GitText(project, ["rev-parse", "HEAD^{tree}"]);
    const selected = await served.manager.selectProjectHandoff(runId, "keep_integration_branch", "handoff:t8-planonly");
    assert.equal(selected.status, "completed");
    assert.equal(selected.projectHandoff?.status, "selected");
    assert.equal(await t8GitText(project, ["rev-parse", "HEAD^{tree}"]), projectTreeBefore);
  } finally {
    await served?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
// ---------------------------------------------------------------------------
// Suite A1: synthetic complete-spec build spine (SRC-P T8; EP16; AR-R31).
// Amendments + conditional/operational obligations; parallel/disjoint tasks
// with real isolated worktrees; failing and zero-selection checks; a
// corrected deliverable review; restart mid-validation behind an owner pause
// with notes; exact-identity reuse and related-change invalidation (AR-4);
// the verdict/trace chain with the final conjunction.
// ---------------------------------------------------------------------------

const T8S_PACKAGE = `{
  "name": "t8-spine",
  "type": "module",
  "scripts": { "test": "node --test" }
}
`;
const T8S_CONFIG = `{
  "defaultValue": 2
}
`;
const T8S_A_BROKEN = "// Legacy implementation replaced by T-A.\nexport const VALUE = 2;\n";
const T8S_A_FIXED = "export const VALUE = 2;\n";
const T8S_A_MARKED = "// T8-A conformance marker\nexport const VALUE = 2;\n";
const T8S_A_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { VALUE } from '../src/a.mjs';\ntest('a value', () => assert.equal(VALUE, 2));\n";
// B/C start behaviorally green so a parallel task may cross the current
// full-suite delivery boundary before the slower corrected A task. Their
// tasks still change the implementation contract: B becomes config-backed
// and C becomes the explicit accepted-A + accepted-B composition.
const T8S_B_BROKEN = "export const DEFAULT = 2;\n";
const T8S_B_FIXED = "import config from '../aiboard.config.json' with { type: 'json' };\nexport const DEFAULT = config.defaultValue;\n";
const T8S_B_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { DEFAULT } from '../src/b.mjs';\ntest('b default', () => assert.equal(DEFAULT, 2));\n";
const T8S_C_STUB = "export const TOTAL = 4;\n";
const T8S_C_CONTENT = "// Join of accepted A (VALUE 2) and B (DEFAULT 2).\nexport const TOTAL = 2 + 2;\n";
const T8S_C_TOUCHED = "// Join of accepted A (VALUE 2) and B (DEFAULT 2).\nexport const TOTAL = 2 + 2;\n// T8-C related-change touch\n";
const T8S_C_TEST = "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { TOTAL } from '../src/c.mjs';\ntest('c total', () => assert.equal(TOTAL, 4));\n";
const T8S_NOTES = "Next: resume after the owner pause and finish module A. Trap: attempt workspaces start from baseline, so rebuild the fix. Try: rerun the module tests before submitting.";
const T8S_FINDING_MARKER = {
  id: "finding:t8a-marker",
  category: "missing_coverage",
  severity: "blocking",
  claim: "src/a.mjs carries no T8-A conformance marker.",
  location: "src/a.mjs:1",
  evidenceRefs: ["src/a.mjs:1"],
  defectClass: "missing coverage",
};

type T8WorkerStep =
  | { kind: "read"; path: string }
  | { kind: "write"; path: string; content: string; shaFromCallId?: string }
  | { kind: "evidence"; label: string; args: string[] }
  | { kind: "submit"; linkCallId: string; summary: string };

const T8_NODE = process.execPath;
const T8_SPINE_SCRIPTS: Record<string, T8WorkerStep[]> = {
  "T-A/1": [
    { kind: "read", path: "src/a.mjs" },
    { kind: "evidence", label: "tests-zero-probe", args: ["-e", "process.stdout.write('TAP version 13\\n1..0\\n')"] },
    { kind: "evidence", label: "tests-red", args: ["-e", "process.exit(1)"] },
    { kind: "write", path: "src/a.mjs", content: T8S_A_FIXED, shaFromCallId: "s0" },
    { kind: "evidence", label: "tests-green", args: ["--test", "test/a.test.mjs"] },
    { kind: "submit", linkCallId: "s4", summary: "Module A exposes VALUE 2; the module tests pass." },
  ],
  "T-A/2": [
    { kind: "read", path: "src/a.mjs" },
    { kind: "write", path: "src/a.mjs", content: T8S_A_MARKED, shaFromCallId: "s0" },
    { kind: "evidence", label: "tests-green", args: ["--test", "test/a.test.mjs"] },
    { kind: "submit", linkCallId: "s2", summary: "Module A exposes VALUE 2 with the conformance marker; tests pass." },
  ],
  "T-B/1": [
    { kind: "read", path: "src/b.mjs" },
    { kind: "write", path: "src/b.mjs", content: T8S_B_FIXED, shaFromCallId: "s0" },
    { kind: "evidence", label: "tests-green-1", args: ["--test", "--test-reporter=junit", "--test-reporter-destination=t8-b-report.xml", "test/b.test.mjs"] },
    { kind: "evidence", label: "tests-green-2", args: ["--test", "--test-reporter=junit", "--test-reporter-destination=t8-b-report.xml", "test/b.test.mjs"] },
    { kind: "submit", linkCallId: "s2", summary: "Module B reads the config default; the module tests pass." },
  ],
  "T-C/1": [
    { kind: "read", path: "src/c.mjs" },
    { kind: "write", path: "src/c.mjs", content: T8S_C_CONTENT, shaFromCallId: "s0" },
    { kind: "evidence", label: "tests-green-1", args: ["--test", "--test-reporter=junit", "--test-reporter-destination=t8-c-report.xml", "test/c.test.mjs"] },
    { kind: "read", path: "src/c.mjs" },
    { kind: "write", path: "src/c.mjs", content: T8S_C_TOUCHED, shaFromCallId: "s3" },
    { kind: "evidence", label: "tests-green-2", args: ["--test", "--test-reporter=junit", "--test-reporter-destination=t8-c-report.xml", "test/c.test.mjs"] },
    { kind: "submit", linkCallId: "s5", summary: "Module C joins A and B; the module tests pass." },
  ],
};

function t8RequestText(request: AgentModelRequest): string {
  const parts: string[] = [];
  for (const message of request.messages) {
    if (typeof message.content === "string") parts.push(message.content);
  }
  return parts.join("\n");
}

function t8HistoryCallIds(request: AgentModelRequest): string[] {
  const ids: string[] = [];
  for (const message of request.messages) {
    if (message.role !== "tool" || typeof message.content !== "object" || message.content === null) continue;
    const callId = (message.content as { callId?: unknown }).callId;
    if (typeof callId === "string") ids.push(callId);
  }
  return ids;
}

function t8HistoryValueByCallId(request: AgentModelRequest, callId: string): Record<string, unknown> | undefined {
  for (const message of request.messages) {
    if (message.role !== "tool" || typeof message.content !== "object" || message.content === null) continue;
    const content = message.content as { callId?: unknown; content?: Array<{ type: string; value?: unknown }> };
    if (content.callId !== callId) continue;
    return content.content?.find((item) => item.type === "json")?.value as Record<string, unknown> | undefined;
  }
  return undefined;
}

function t8ReadTextByPath(request: AgentModelRequest, path: string): string | undefined {
  for (const message of request.messages) {
    if (message.role !== "tool" || typeof message.content !== "object" || message.content === null) continue;
    const content = message.content as { toolName?: unknown; content?: Array<{ type: string; value?: unknown; text?: unknown }> };
    if (content.toolName !== "fs.read") continue;
    const items = content.content ?? [];
    // Truthful fs.read shape: JSON metadata ({path, sha256, byteLength}) plus file bytes in a SEPARATE text block.
    const value = items.find((item) => item.type === "json")?.value as { path?: unknown; content?: unknown } | undefined;
    if (value?.path !== path) continue;
    const text = items.find((item) => item.type === "text")?.text;
    if (typeof text === "string") return text;
    if (typeof value?.content === "string") return value.content;
  }
  return undefined;
}

test("T8-A1 helper reads the real fs.read shape: JSON metadata path plus a separate text block", () => {
  const toolMessage = (callId: string, toolName: string, content: ToolContentBlock[]): AgentMessage => ({
    id: `tool-${callId}`,
    role: "tool",
    content: { callId, toolName, content, isError: false },
  });
  const requestOf = (...messages: AgentMessage[]): AgentModelRequest => ({ sessionId: "t8-helper", messages, tools: [] });
  // Exact t8a1-debug.json shape: metadata JSON block, bytes in a text block.
  const real = requestOf(toolMessage("t8s-dread-T-A-22", "fs.read", [
    { type: "json", value: { path: "src/a.mjs", sha256: "98f7", byteLength: 24 } },
    { type: "text", text: "export const VALUE = 2;\n" },
  ]));
  assert.equal(t8ReadTextByPath(real, "src/a.mjs"), "export const VALUE = 2;\n");
  assert.equal(t8ReadTextByPath(real, "src/b.mjs"), undefined);
  const compat = requestOf(toolMessage("legacy-1", "fs.read", [
    { type: "json", value: { path: "src/a.mjs", content: "legacy bytes" } },
  ]));
  assert.equal(t8ReadTextByPath(compat, "src/a.mjs"), "legacy bytes");
  const other = requestOf(toolMessage("stat-1", "fs.stat", [
    { type: "json", value: { path: "src/a.mjs" } },
  ]));
  assert.equal(t8ReadTextByPath(other, "src/a.mjs"), undefined);
});

/** Restart-safe scripted spine worker: the step index derives from durable history, never instance state. */
class T8SpineWorker implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  constructor(private readonly projection: () => SchedulerProjection) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const taskId = /Authoritative plan contract (T-[A-Z]+)/.exec(t8RequestText(request))?.[1];
    assert.ok(taskId === "T-A" || taskId === "T-B" || taskId === "T-C", `the spine worker request names a spine task: ${t8ToolPreview(request, 500)}`);
    const attempt = this.projection().tasks[taskId]?.attempt ?? 1;
    const script = T8_SPINE_SCRIPTS[`${taskId}/${attempt}`];
    assert.ok(script, `the spine has a script for ${taskId} attempt ${attempt}`);
    const prefix = `t8w-${taskId}-a${attempt}-s`;
    const done = t8HistoryCallIds(request).filter((id) => id.startsWith(prefix)).length;
    assert.ok(done < script.length, `the spine script is exhausted for ${taskId} attempt ${attempt} at step ${done}`);
    const step = script[done]!;
    const callId = `${prefix}${done}`;
    if (step.kind === "read") return t8Call("fs.read", { path: step.path }, callId);
    if (step.kind === "write") {
      const args: Record<string, unknown> = { path: step.path, content: step.content };
      if (step.shaFromCallId) {
        const seen = t8HistoryValueByCallId(request, `${prefix}${step.shaFromCallId.slice(1)}`) as { sha256?: unknown } | undefined;
        assert.ok(typeof seen?.sha256 === "string" && seen.sha256.length > 0, `the ${step.path} read carries a sha: ${t8ToolPreview(request, 500)}`);
        args.expectedSha256 = seen.sha256;
      }
      return t8Call("fs.write", args, callId);
    }
    if (step.kind === "evidence") {
      return t8Call("run_evidence_command", { label: step.label, command: T8_NODE, args: step.args }, callId);
    }
    const record = t8HistoryValueByCallId(request, `${prefix}${step.linkCallId.slice(1)}`) as { id?: unknown; fact?: { stdoutArtifactHash?: unknown } } | undefined;
    const fact = record?.fact;
    assert.ok(
      typeof record?.id === "string" && fact && typeof fact.stdoutArtifactHash === "string",
      `the linked evidence has a usable fact: ${t8ToolPreview(request, 500)}`,
    );
    const testsRun: { command: string; counts: { selected: number; passed: number; failed: number; skipped: number } }[] = [];
    const notRun: { what: string; why: string }[] = [];
    const writePaths: string[] = [];
    for (const entry of script) {
      if (entry.kind === "write" && !writePaths.includes(entry.path)) writePaths.push(entry.path);
      if (entry.kind !== "evidence") continue;
      if (entry.label.includes("zero-probe")) {
        notRun.push({ what: `zero-selection probe ${entry.label}`, why: "selected 0 tests by design, which cannot verify anything" });
        continue;
      }
      const failed = entry.label.includes("red") ? 1 : 0;
      testsRun.push({ command: `${T8_NODE} ${entry.args.join(" ")}`, counts: { selected: 1, passed: 1 - failed, failed, skipped: 0 } });
    }
    notRun.push({ what: "full suite", why: "narrow module change; sibling modules verify in their own tasks" });
    return t8Call("submit_task", {
      summary: step.summary,
      readiness: "ready_for_architect_review",
      unresolvedConcerns: [],
      criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: record.id, artifactHashes: [fact.stdoutArtifactHash] }],
      validationScope: {
        changed: writePaths,
        verified: writePaths.map((path) => `${path} exposes the planned behavior`),
        testsRun,
        notRun,
      },
    }, callId);
  }
}

/** Spine reviewer: coverage plus deliverable passes with the T-A correction cycle. */
class T8SpineReviewer implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  constructor(private readonly projection: () => SchedulerProjection) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const seen = request.messages.filter((message) => message.role === "tool").length;
    const tools = new Set(request.tools.map((tool) => tool.name));
    if (tools.has("record_coverage_obligations")) {
      return t8Call("record_coverage_obligations", {
        obligations: [
          { id: "obl-REQ-1", description: "Expose VALUE 2.", requirementId: "REQ-1" },
          { id: "obl-REQ-2", description: "Read the configured default.", requirementId: "REQ-2" },
          { id: "obl-REQ-3", description: "Cover the behavior with tests.", requirementId: "REQ-3" },
        ],
        sectionCoverage: [
          { sectionId: "s1", obligationIds: ["obl-REQ-1"] },
          { sectionId: "s2", obligationIds: ["obl-REQ-2"] },
          { sectionId: "s3", obligationIds: ["obl-REQ-3"] },
        ],
      }, `t8s-obl-${seen}`);
    }
    if (tools.has("submit_coverage_verdict")) {
      return t8Call("submit_coverage_verdict", {
        obligationVerdicts: ["obl-REQ-1", "obl-REQ-2", "obl-REQ-3"].map((obligationId, index) => ({
          obligationId,
          verdict: "covered",
          severity: "advisory",
          rationale: "The spine tasks cover it.",
          evidenceRefs: [`ledger:REQ-${index + 1}`],
        })),
        findings: [],
      }, `t8s-verdict-${seen}`);
    }
    if (tools.has("submit_plan_critique")) {
      return t8Call("submit_plan_critique", { findings: [] }, `t8s-critique-${seen}`);
    }
    if (tools.has("record_verification_expectations")) {
      return t8Call("record_verification_expectations", {
        expectations: [
          { taskId: "T-A", criterionId: "c1", expectedBehaviors: ["Module A exposes VALUE 2 with the T8 marker."], edgeCases: ["The corrected attempt remains green."], regressionSurfaces: ["src/a.mjs"], requiredTests: ["The complete fixture tests pass."] },
          { taskId: "T-B", criterionId: "c1", expectedBehaviors: ["Module B reads the configured default."], edgeCases: ["The config-backed value remains 2."], regressionSurfaces: ["src/b.mjs", "aiboard.config.json"], requiredTests: ["The complete fixture tests pass."] },
          { taskId: "T-C", criterionId: "c1", expectedBehaviors: ["Module C composes accepted A and B."], edgeCases: ["Composition remains green after integration."], regressionSurfaces: ["src/c.mjs"], requiredTests: ["The complete fixture tests pass."] },
        ],
      }, `t8s-verifier-expectations-${seen}`);
    }
    if (tools.has("submit_verifier_verdict")) {
      if (seen === 0) return t8Call("run_evidence_command", { label: "t8-final-verifier-tests", command: process.execPath, args: ["--test"] }, "t8s-final-verifier-evidence");
      const record = t8LastToolValue(request);
      const evidenceId = record?.id;
      assert.ok(typeof evidenceId === "string" && evidenceId.length > 0, `final verifier run records evidence: ${t8ToolPreview(request, 500)}`);
      return t8Call("submit_verifier_verdict", { criterionVerdicts: ["T-A", "T-B", "T-C"].map((taskId) => ({ taskId, criterionId: "c1", verdict: "satisfied", rationale: "The independent final verifier executed the complete integrated fixture test suite successfully.", evidenceIds: [evidenceId] })) }, "t8s-final-verifier-verdict");
    }
    const durable = this.projection();
    const promptTaskId = /Authoritative plan contract (T-[A-Z]+)/.exec(t8RequestText(request))?.[1];
    const activeReviewTaskId = ["T-A", "T-B", "T-C"].find((id) => {
      const status = durable.tasks[id]?.status;
      return status === "submitted" || status === "architect_review";
    });
    // Re-review delta passes do not repeat the first-generation contract marker.
    // The scripted transport falls back to the one durable task under review;
    // serial A1 admission makes that identity exact.
    const taskId = promptTaskId ?? activeReviewTaskId;
    assert.ok(taskId === "T-A" || taskId === "T-B" || taskId === "T-C", `the spine review names a spine task: ${t8ToolPreview(request, 500)}`);
    const attempt = durable.tasks[taskId]?.attempt ?? 1;
    const modulePath = taskId === "T-A" ? "src/a.mjs" : taskId === "T-B" ? "src/b.mjs" : "src/c.mjs";
    const system = request.messages.find((message) => message.role === "system");
    const pass = system?.id ?? "";
    if (pass === "delivery-obligations-system") {
      return t8Call("record_deliverable_obligations", {
        obligations: [{ id: `t8o-${taskId}`, description: `Deliver ${modulePath}.` }],
      }, `t8s-dobl-${taskId}-${seen}`);
    }
    if (pass === "delivery-findings-system") {
      if (t8ReadTextByPath(request, modulePath) === undefined) {
        return t8Call("fs.read", { path: modulePath }, `t8s-dread-${taskId}-${seen}`);
      }
      const findings = taskId === "T-A" && attempt === 1 ? [{ ...T8S_FINDING_MARKER }] : [];
      return t8Call("record_deliverable_findings", { findings }, `t8s-dfind-${taskId}-a${attempt}-${seen}`);
    }
    if (pass === "delivery-verdict-system") {
      if (t8ReadTextByPath(request, modulePath) === undefined) {
        return t8Call("fs.read", { path: modulePath }, `t8s-vread-${taskId}-${seen}`);
      }
      const text = t8RequestText(request);
      const claimIds = [...new Set([...text.matchAll(/"id"\s*:\s*"(claim:[^"]+)"/g)].map((match) => match[1]!))];
      const ownSection = text.split("Your durably recorded findings:")[1]?.split("The worker's report")[0] ?? "";
      const ownBlocking = /"severity"\s*:\s*"blocking"/.test(ownSection);
      const priorSection = text.split("Prior review")[1] ?? "";
      const hasPrior = priorSection.length > 0;
      const priorIds = [...new Set([...priorSection.matchAll(/"id"\s*:\s*"((?!claim:)[^"]+)"/g)].map((match) => match[1]!))];
      const moduleText = t8ReadTextByPath(request, modulePath) ?? "";
      const checks = priorIds.map((findingId) => {
        if (findingId === T8S_FINDING_MARKER.id) {
          const marked = moduleText.includes("T8-A conformance marker");
          return marked
            ? { findingId, resolution: "resolved", rationale: "The marker is present; inspected in this session." }
            : { findingId, resolution: "outstanding", rationale: "The marker is still missing." };
        }
        return { findingId, resolution: "outstanding", rationale: "Unresolved in the current checkout." };
      });
      const satisfied = !ownBlocking && checks.every((check) => check.resolution === "resolved");
      return t8Call("submit_deliverable_verdict", {
        summary: `Reviewed ${modulePath} against the criteria.`,
        satisfied,
        claimVerdicts: claimIds.map((claimId) => ({
          claimId,
          status: "verified",
          rationale: `Read ${modulePath} in this session and confirmed the behavior; the cited test run passed.`,
          citations: [{ path: modulePath, line: 1 }],
        })),
        ...(hasPrior ? { priorFindingChecks: checks } : {}),
      }, `t8s-dverdict-${taskId}-a${attempt}-${seen}`);
    }
    throw new Error(`Unexpected spine reviewer pass ${pass}.`);
  }
}

function t8SpineFvPlan(): FinalVerificationPlan {
  const na = (category: "build" | "runtime_smoke" | "browser"): FinalVerificationPlan["checks"][number] => ({
    category,
    status: "not_applicable",
    rationale: `The fixture has no ${category} entry point.`,
    repositoryInspection: { paths: ["package.json"], summary: `The fixture package has no ${category} entry point.` },
  });
  return {
    checks: [
      na("build"),
      { category: "tests", status: "required" },
      na("runtime_smoke"),
      na("browser"),
    ],
  };
}

interface T8SpineScenario {
  manifest: { manifestId: string; sections: readonly { id: string; digest: string }[] };
  requirements: SourceRequirement[];
  phases: ExecutionPlanPhase[];
  revision: { revisionId: string; digest: string } & Record<string, unknown>;
}

/** Spine Architect: planning with the conditional lifecycle, tasks, final verification, notes, completion. */
class T8SpineArchitect implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  private calls = 0;
  private readonly reviewsRequested = new Set<string>();
  constructor(
    private readonly projection: () => SchedulerProjection,
    private readonly scenarioRef: { current?: T8SpineScenario },
    private readonly revisedRevisionRef: { current?: Record<string, unknown> },
  ) {}
  private call(name: string, args: unknown): ModelTurn {
    this.calls += 1;
    return t8Call(name, args, `t8s-arch-${this.calls}`);
  }
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    if (request.tools.length === 0) return t8TextTurn(T8S_NOTES);
    const tools = new Set(request.tools.map((tool) => tool.name));
    const projection = this.projection();
    const planning = projection.planning;
    if (tools.has("complete_run") && planning?.readiness === "ready" && projection.finalVerification?.current?.review?.status === "approved" && !projection.projectHandoff) {
      return this.call("complete_run", { summary: "The spine build is delivered and verified." });
    }
    if (projection.planningTriageDecision === undefined) {
      return this.call("record_triage", { decision: "build", rationale: "T8 spine: the amended source changes the project." });
    }
    const scenario = this.scenarioRef.current;
    assert.ok(scenario, "the spine scenario is built from the amended kernel manifest before planning reads");
    const manifestId = planning?.source.currentManifestId;
    assert.ok(manifestId, "the approved source is registered before planning reads");
    const reads = planning?.sourceReadIndex[manifestId] ?? {};
    const sections = scenario.manifest.sections;
    if (sections.some((section) => reads[section.id] !== section.digest)) {
      const pending = sections.find((section) => reads[section.id] !== section.digest)!;
      if (this.requests.length <= 2) return this.call("read_planning_source_section", {});
      return this.call("read_planning_source_section", { sectionId: pending.id });
    }
    if (!planning?.ledger) {
      return this.call("persist_planning_ledger", {
        id: "ledger-1",
        requirements: scenario.requirements,
        phases: scenario.phases,
        nonNormativeSections: [],
      });
    }
    if (!planning?.plan) {
      const { digest: _digest, runId: _run, createdAt: _created, ...rest } = scenario.revision;
      void _digest;
      void _run;
      void _created;
      return this.call("draft_planning_plan", { revision: rest });
    }
    const plan = planning.plan;
    const firstRevisionId = scenario.revision.revisionId as string;
    // The conditional resolves before review: rev1 carries REQ-2 pending,
    // rev2 resolves it to applicable on the observed config evidence. (A
    // review would take rev1 straight to ready and pause for plan start,
    // leaving no turn to resolve.)
    if (plan.currentRevisionId === firstRevisionId && !this.reviewsRequested.has(firstRevisionId) && planning.readiness !== "ready") {
      const revisedRevision = this.revisedRevisionRef.current;
      assert.ok(revisedRevision, "the revised revision is built before the revise turn");
      return this.call("revise_planning_plan", {
        revision: revisedRevision,
        expectedRevisionId: plan.currentRevisionId,
        expectedDigest: plan.currentDigest,
      });
    }
    if (planning.readiness !== "ready") {
      if (!this.reviewsRequested.has(plan.currentRevisionId)) {
        this.reviewsRequested.add(plan.currentRevisionId);
        return this.call("request_coverage_review", { reviewId: `coverage_t8s_${plan.currentRevisionId}` });
      }
      throw new Error("T8 spine planning exhausted: a review is pending for the current revision.");
    }
    for (const taskId of ["T-A", "T-B", "T-C"]) {
      const task = projection.tasks[taskId];
      if (!task) continue;
      if (task.status === "submitted" || task.status === "architect_review") {
        const links = task.criterionEvidenceLinks ?? [];
        const submissionReview = currentSubmissionReview(projection.delivery, task);
        const approvalIssues = deliveryReviewApprovalIssues(projection.delivery, task);
        if (submissionReview?.stage === "completed" && approvalIssues.length > 0) {
          // Correction cycle: the deliverable review blocks approval, so c1 is
          // unsatisfied and the task goes back for rework. The W3 override
          // reason rides only when the kernel prefill actually deviates.
          const prefill = deriveReviewTaskPrefill({
            task: {
              id: task.id,
              attempt: task.attempt,
              ...(task.changeSetId ? { changeSetId: task.changeSetId } : {}),
              ...(task.acceptanceCriteria ? { acceptanceCriteria: task.acceptanceCriteria } : {}),
              ...(task.criterionEvidenceLinks ? { criterionEvidenceLinks: task.criterionEvidenceLinks } : {}),
            },
            review: submissionReview,
          });
          const deviates = diffReviewTaskVerdicts(prefill, [{ criterionId: "c1", verdict: "unsatisfied" }])[0]?.deviates === true;
          return this.call("review_task", {
            taskId,
            decision: "rejected",
            summary: `Correction required: ${approvalIssues.join("; ")}`,
            evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
            criterionVerdicts: [{
              criterionId: "c1",
              verdict: "unsatisfied",
              rationale: `The deliverable review blocks approval: ${approvalIssues.join("; ")}`,
              evidenceIds: links.map((link) => link.evidenceId),
              artifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
              ...(deviates ? { overrideReason: `Downgrade from the prefilled satisfied verdict: ${approvalIssues.join("; ")}` } : {}),
            }],
          });
        }
        return this.call("review_task", {
          taskId,
          decision: "approved",
          summary: "The deliverable review is satisfied and the evidence passes.",
          evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
          criterionVerdicts: [{
            criterionId: "c1",
            verdict: "satisfied",
            rationale: "Tests pass.",
            evidenceIds: links.map((link) => link.evidenceId),
            artifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
          }],
        });
      }
      if (task.status === "approved") return this.call("request_integration", { taskId });
    }
    if (["T-A", "T-B", "T-C"].every((taskId) => projection.tasks[taskId]?.status === "integrated")) {
      const current = projection.finalVerification?.current;
      if (!current) {
        return this.call("plan_final_verification", { plan: t8SpineFvPlan() });
      }
      if (current.review?.status === "requested" && current.submission && current.submissionResult) {
        const submission = current.submissionResult;
        return this.call("review_final_verification", {
          taskId: current.taskId,
          generationId: current.generationId,
          targetRevision: current.targetRevision,
          submissionId: current.submission.submissionId,
          attempt: current.submission.attempt,
          decision: "approved",
          summary: "Final verification is green on the integrated revision.",
          architectRisk: "low",
          architectRiskRationale: "Three small modules with passing tests.",
          categoryReviews: submission.checks.map((check) => ({
            category: check.category,
            verdict: "approved",
            rationale: check.status === "required" ? "Executed green with evidence." : "Not applicable to this fixture.",
            evidenceIds: [...check.evidenceIds],
          })),
        });
      }
    }
    throw new Error(`Unexpected spine Architect turn (readiness ${planning.readiness}, tasks ${["T-A", "T-B", "T-C"].map((id) => `${id}:${projection.tasks[id]?.status}`).join(",")}).`);
  }
}

test("T8-A1 synthetic complete-spec build spine with restart, correction, reuse, and handoff", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t8-spine-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, ".gitignore"), "node_modules/\nt8-b-report.xml\nt8-c-report.xml\n");
  writeFileSync(join(project, "package.json"), T8S_PACKAGE);
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(join(project, "test"), { recursive: true });
  writeFileSync(join(project, "src", "a.mjs"), T8S_A_BROKEN);
  writeFileSync(join(project, "src", "b.mjs"), T8S_B_BROKEN);
  writeFileSync(join(project, "src", "c.mjs"), T8S_C_STUB);
  writeFileSync(join(project, "test", "a.test.mjs"), T8S_A_TEST);
  writeFileSync(join(project, "test", "b.test.mjs"), T8S_B_TEST);
  writeFileSync(join(project, "test", "c.test.mjs"), T8S_C_TEST);
  writeFileSync(join(project, "aiboard.config.json"), T8S_CONFIG);
  const runId = "run_t8_spine";
  const runRoot = join(state, "builds", runnerRunStateSegment(runId));
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId });
  const manifestV1 = t8ManifestFor(runId, T8_SOURCE_V1, ["s1", "s2"]);
  const manifestV2 = t8ManifestFor(runId, T8_SOURCE_V2, ["s1", "s2", "s3"]);
  let served: T8ServedFactory | undefined;
  const scenarioRef: { current?: T8SpineScenario } = {};
  const revisedRevisionRef: { current?: Record<string, unknown> } = {};
  const worker = new T8SpineWorker(() => served!.runtime().projection());
  const reviewer = new T8SpineReviewer(() => served!.runtime().projection());
  const architect = new T8SpineArchitect(() => served!.runtime().projection(), scenarioRef, revisedRevisionRef);
  const serve = () => t8ServeFactory({
    root, project, state, runId, token: "t8-spine-token", baselineRevision: baseline.revision,
    architect, worker, reviewer,
    build: {},
  });
  try {
    served = await serve();
    const created = await fetch(`${served.url}/v2/runs`, {
      method: "POST",
      headers: { Authorization: "Bearer t8-spine-token", "Content-Type": "application/json" },
      body: JSON.stringify({
        runId,
        projectPath: project,
        permissionProfile: "full",
        idempotencyKey: "t8-spine",
        build: {
          projectId: "t8-spine-fixture",
          objective: "Deliver modules A, B, and C.",
          architectRuntimeId: "arch:architect",
          workerRuntimeIds: ["work:worker"],
          verifierRuntimeIds: ["rev:reviewer"],
          alwaysRequireIndependentVerifier: false,
          maxConcurrency: 2,
          runPolicy: "finish",
          budgetLimits: {},
          planningPolicy: { version: 1 },
          specCopy: false,
          handoffFiles: "commit",
        },
      }),
    });
    assert.equal(created.status, 201, await created.text());
    const approve = await served.control("source", {
      approvedSource: t8SourceInput(T8_SOURCE_V1, t8LineSections(T8_SOURCE_V1, ["s1", "s2"])),
      idempotencyKey: "approve-source-v1",
    });
    assert.equal(approve.status, 200, await approve.text());
    // Amendment before planning starts: v2 appends the operational section
    // with byte-identical v1 sections.
    const afterApprove = served.runtime().projection();
    const predecessorId = afterApprove.planning!.source.currentManifestId;
    const predecessorDigest = afterApprove.planning!.source.manifestsById[predecessorId]!.artifactDigest;
    assert.equal(predecessorDigest, manifestV1.artifactDigest);
    const amend = await served.control("source-amendments", {
      ...t8SourceInput(T8_SOURCE_V2, t8LineSections(T8_SOURCE_V2, ["s1", "s2", "s3"])),
      predecessorManifestId: predecessorId,
      predecessorArtifactDigest: predecessorDigest,
      amendmentId: "amend-add-s3",
      rationale: "Add the operational test-coverage section.",
      impact: { addsSectionIds: ["s3"], retiresSectionIds: [], addsRequirementIds: [], retiresRequirementIds: [] },
      idempotencyKey: "amend-v2",
    });
    assert.equal(amend.status, 200, await amend.text());
    // The scenario binds the kernel's amended manifest (its id derives from
    // the amendment chain, never from a locally rebuilt guess).
    const kernelManifest = served.runtime().projection().planning!.source.manifestsById[
      served.runtime().projection().planning!.source.currentManifestId
    ]!;
    const pending = t8Scenario(runId, kernelManifest, "spine", "conditional_pending", "revision_1");
    const resolved = t8Scenario(runId, kernelManifest, "spine", "applicable", "revision_2");
    const { digest: _resolvedDigest, runId: _resolvedRun, createdAt: _resolvedCreated, ...resolvedRevision } = resolved.revision as unknown as { digest: string; runId: string; createdAt: string } & Record<string, unknown>;
    void _resolvedDigest;
    void _resolvedRun;
    void _resolvedCreated;
    scenarioRef.current = {
      manifest: kernelManifest,
      requirements: pending.requirements,
      phases: pending.phases,
      revision: pending.revision as unknown as { revisionId: string; digest: string } & Record<string, unknown>,
    };
    revisedRevisionRef.current = resolvedRevision;
    const ready = await t8StepUntil("ready", served.runtime, (projection) => projection.planning?.readiness === "ready", 300);
    assert.notEqual(ready.planning!.source.currentManifestId, predecessorId, "planning moved to the amended source");
    const currentManifest = ready.planning!.source.manifestsById[ready.planning!.source.currentManifestId]!;
    assert.equal(currentManifest.amendment?.priorManifestId, predecessorId, "the plan binds the amended source chain");
    assert.equal(currentManifest.artifactDigest, manifestV2.artifactDigest);
    assert.deepEqual(currentManifest.sections.map((section) => section.id), ["s1", "s2", "s3"]);
    assert.equal(ready.planning!.ledger?.requirements.length, 3);
    assert.equal(
      ready.planning!.ledger?.requirements.find((entry) => entry.id === "REQ-2")?.applicability.status,
      "conditional_pending",
      "the ledger records the conditional pending",
    );
    assert.equal(ready.planning!.plan?.currentRevisionId, "revision_2");
    const readyRevision = ready.planning!.plan!.revisionsById.revision_2!;
    assert.equal(readyRevision.requirements.find((entry) => entry.id === "REQ-2")?.applicability.status, "applicable");
    assert.equal(readyRevision.requirements.find((entry) => entry.id === "REQ-2")?.obligationKind, "conditional");
    assert.equal(Object.keys(ready.planning!.coverageRequests ?? {}).length, 1, "the resolved revision was reviewed");
    const start = await served.control("plan-start", {
      ...currentExplicitStartIdentity(ready),
      version: 1,
      ownerChoice: "execute",
      idempotencyKey: "explicit-start",
    });
    assert.equal(start.status, 200, await start.text());
    // Parallel disjoint dispatch: T-A and T-B are both dispatched before
    // either integrates, each in its own isolated worktree.
    await t8StepUntil(
      "parallel dispatch",
      served.runtime,
      (projection) => ["T-A", "T-B"].every((id) => {
        const status: string = projection.tasks[id]?.status ?? "";
        return status !== "" && status !== "planned" && status !== "integrated";
      }),
      300,
    );
    const assignedEvents = served.manager.events(runId).filter((event) =>
      event.type === "task.transitioned" && (event.payload as { status?: string }).status === "assigned");
    const assignedIds = assignedEvents.map((event) => (event.payload as { taskId?: string }).taskId);
    assert.ok(assignedIds.includes("T-A") && assignedIds.includes("T-B"), "both disjoint tasks are assigned");
    const firstIntegratedAt = served.manager.events(runId).findIndex((event) =>
      event.type === "task.transitioned" && (event.payload as { status?: string }).status === "integrated");
    const bothAssignedAt = Math.max(
      served.manager.events(runId).findIndex((event) =>
        event.type === "task.transitioned" && (event.payload as { taskId?: string }).taskId === "T-A" && (event.payload as { status?: string }).status === "assigned"),
      served.manager.events(runId).findIndex((event) =>
        event.type === "task.transitioned" && (event.payload as { taskId?: string }).taskId === "T-B" && (event.payload as { status?: string }).status === "assigned"),
    );
    assert.ok(firstIntegratedAt === -1 || bothAssignedAt < firstIntegratedAt, "both tasks are assigned before either integrates");
    const worktreeList = (await runGit({ cwd: project, args: ["worktree", "list", "--porcelain"] })).stdout;
    const worktreePaths = [...worktreeList.matchAll(/^worktree (.+)$/gm)].map((match) => match[1]!);
    const taskWorktrees = worktreePaths.filter((path) => path !== project);
    assert.ok(taskWorktrees.length >= 2, `each disjoint task runs in its own worktree (saw ${taskWorktrees.length})`);
    assert.equal(new Set(taskWorktrees).size, taskWorktrees.length, "task worktree paths are distinct");
    const taskBranches = [...worktreeList.matchAll(/^branch (.+)$/gm)].map((match) => match[1]!);
    assert.ok(taskBranches.length >= taskWorktrees.length, "each task worktree tracks its own branch");
    // Restart mid-validation behind an owner pause: the pause snapshot
    // carries the stop and the Architect notes, and the reopened run
    // resumes without duplicating work.
    await t8StepUntil("T-A submitted", served.runtime, (projection) => ["submitted", "architect_review"].includes(projection.tasks["T-A"]?.status ?? ""), 300);
    const pausedTask = served.runtime().projection().tasks["T-A"];
    const paused = await served.manager.pause(runId, "user", "pause:t8-spine-midrun");
    assert.equal(paused.status, "paused");
    const pauseEvents = served.manager.events(runId);
    const pauseSnapshots = t8SnapshotCommits(pauseEvents);
    const pauseSnapshot = pauseSnapshots[pauseSnapshots.length - 1]!;
    assert.equal(pauseSnapshot.payload.stopKind, "paused");
    const repoPath = t8IntegrationRepoPath(state);
    const pauseBody = await t8GitText(repoPath, ["show", `${String(pauseSnapshot.payload.commit)}:${HANDOFF_STATE_PATH}`]);
    assert.ok(pauseBody.includes("T-A"), "the pause snapshot names the in-flight work");
    assert.ok(pauseBody.includes(T8S_NOTES), "the pause snapshot carries the Architect notes");
    await served.close();
    served = await serve();
    const recovery = await served.manager.recover();
    assert.equal(recovery.failures.length, 0, JSON.stringify(recovery.failures));
    assert.equal(served.manager.events(runId).length, pauseEvents.length, "recovery replays the exact log");
    const resumedTask = served.manager.projection(runId).tasks["T-A"];
    assert.deepEqual(
      { status: resumedTask?.status, attempt: resumedTask?.attempt },
      { status: pausedTask?.status, attempt: pausedTask?.attempt },
      "the in-flight submission survives the restart unchanged",
    );
    await served.manager.resume(runId, "resume:t8-spine-midrun");
    const accepted = await t8StepUntil(
      "all accepted",
      served.runtime,
      (projection) => ["T-A", "T-B", "T-C"].every((id) => projection.delivery?.taskAcceptances[id] !== undefined),
      600,
    );
    // Corrected review: T-A needed a second attempt; the re-review approved.
    assert.equal(accepted.tasks["T-A"]?.attempt, 2);
    assert.ok(
      served.manager.events(runId).some((event) => event.type === "delivery.review_recorded" &&
        (event.payload as { satisfied?: boolean }).satisfied === false),
      "the first T-A review refused with the blocking finding",
    );
    assert.ok(
      Object.values(accepted.delivery?.reviewHistory ?? {}).flat().some((record) =>
        (record as { taskId?: string; satisfied?: boolean }).taskId === "T-A" &&
        (record as { satisfied?: boolean }).satisfied === false),
      "the refused review stays in history",
    );
    // Evidence checks: zero-selection, failing, reuse, invalidation.
    const evidence = new SqliteEvidenceStore(join(runRoot, "evidence.sqlite"), { readOnly: true });
    try {
      const recordsA = evidence.list({ runId, taskId: "T-A", limit: 100 });
      const commandRecordsA = recordsA.filter((record) => record.fact.kind === "command");
      assert.ok(commandRecordsA.length >= 3, `T-A recorded its probe, red, and green runs (saw ${commandRecordsA.length})`);
      const redProbe = commandRecordsA.find((record) => record.fact.kind === "command" && /tests-red/.test((record.fact as { label?: string }).label ?? ""));
      assert.ok(redProbe && redProbe.fact.kind === "command", "the deliberate failing check was recorded");
      assert.notEqual(redProbe.fact.kind === "command" ? redProbe.fact.exitCode : 0, 0, "the failing check genuinely failed");
      const artifacts = new ArtifactStore(join(state, "artifacts"));
      const zeroProbe = commandRecordsA.find((record) => record.fact.kind === "command" && /zero-probe/.test((record.fact as { label?: string }).label ?? ""));
      assert.ok(zeroProbe && zeroProbe.fact.kind === "command", "the zero-selection probe recorded");
      assert.equal(zeroProbe.fact.kind === "command" ? zeroProbe.fact.exitCode : -1, 0);
      if (zeroProbe.fact.kind === "command") {
        const probeStdout = (await artifacts.get(zeroProbe.fact.stdoutArtifactHash)).toString("utf8");
        assert.ok(probeStdout.includes("1..0"), "the probe selected zero tests (TAP empty plan)");
      }
      const submittedLinks = accepted.tasks["T-A"]?.criterionEvidenceLinks ?? [];
      assert.ok(!submittedLinks.some((link) => link.evidenceId === zeroProbe.id), "the submission never cites the zero-selection probe");
      const recordsB = evidence.list({ runId, taskId: "T-B", limit: 100 });
      const commandRecordsB = recordsB.filter((record) => record.fact.kind === "command" && record.fact.exitCode === 0);
      assert.ok(commandRecordsB.length >= 2, "T-B recorded both identical runs");
      const lastTwo = commandRecordsB.slice(-2);
      const green1 = lastTwo[0]!;
      const green2 = lastTwo[1]!;
      assert.equal(
        green2.fact.kind === "command" ? green2.fact.reused_from : undefined,
        green1.id,
        "the identical repeat reuses the first execution exactly (AR-4)",
      );
      assert.ok(green1.fact.kind === "command" && green2.fact.kind === "command");
      assert.equal(green2.fact.stdoutArtifactHash, green1.fact.stdoutArtifactHash, "reuse preserves the exact output bytes");
      const recordsC = evidence.list({ runId, taskId: "T-C", limit: 100 });
      const commandRecordsC = recordsC.filter((record) => record.fact.kind === "command" && record.fact.exitCode === 0);
      assert.ok(commandRecordsC.length >= 2, "T-C recorded before and after its related change");
      const afterChange = commandRecordsC[commandRecordsC.length - 1]!;
      assert.equal(afterChange.fact.kind === "command" ? afterChange.fact.reused_from : "unexpected", undefined, "the related change invalidates reuse: a fresh execution");
    } finally {
      evidence.close();
    }
    const handoffRequested = await t8StepUntil(
      "handoff requested",
      served.runtime,
      (projection) => projection.projectHandoff?.status === "requested",
      600,
    );
    assert.equal(handoffRequested.status, "paused");
    // Verdict/trace chain: source -> requirement -> task -> evidence, with
    // no omitted obligation and no open mandatory failure.
    const finalRevision = handoffRequested.planning!.plan!.revisionsById[handoffRequested.planning!.plan!.currentRevisionId]!;
    assert.equal(finalRevision.requirements.length, 3);
    for (const requirement of finalRevision.requirements) {
      assert.equal(requirement.applicability.status, "applicable", `${requirement.id} is resolved`);
      assert.ok(requirement.contributingTaskIds.length > 0, `${requirement.id} has contributing tasks`);
      for (const taskId of requirement.contributingTaskIds) {
        const acceptance = handoffRequested.delivery?.taskAcceptances[taskId];
        assert.ok(acceptance, `${requirement.id} is covered by accepted ${taskId}`);
        const review = handoffRequested.delivery?.reviews[taskId];
        assert.equal(review?.reviewId, acceptance.reviewId, `${taskId} acceptance cites its current review`);
        assert.equal(review?.satisfied, true, `${taskId} has a satisfied current review`);
        const boundary = handoffRequested.delivery?.boundaries[taskId]?.find((entry) => entry.boundaryId === acceptance.boundaryId);
        assert.equal(boundary?.passed, true, `${taskId} has a passed boundary`);
        assert.ok((boundary?.checks ?? []).length > 0, `${taskId} boundary ran checks`);
      }
      for (const condition of requirement.acceptanceConditions) {
        assert.ok(condition.description.length > 0, `${requirement.id} conditions are concrete`);
      }
    }
    assert.ok(
      Object.values(handoffRequested.delivery?.reviews ?? {}).every((review) => review.satisfied === true),
      "no open mandatory review failure remains",
    );
    assert.equal(handoffRequested.finalVerification?.current?.review?.status, "approved");
    const readiness = buildCompletionReadiness(handoffRequested);
    assert.equal(readiness.ready, true, `the final conjunction holds: ${JSON.stringify(readiness.issues)}`);
    // EP40: every recorded model pass carries its purpose and token cost.
    const manifests = served.manager.contextManifests(runId);
    assert.ok(manifests.length > 0, "the journey recorded context manifests");
    for (const manifest of manifests) {
      assert.ok(manifest.purpose.length > 0, "each pass records its purpose");
      assert.ok(manifest.estimatedTokens > 0, "each pass records its token cost");
    }
    const rollup = new Map<string, { passes: number; tokens: number }>();
    for (const manifest of manifests) {
      const entry = rollup.get(manifest.purpose) ?? { passes: 0, tokens: 0 };
      entry.passes += 1;
      entry.tokens += manifest.estimatedTokens;
      rollup.set(manifest.purpose, entry);
    }
    console.info(`T8-A1 context manifest rollup: ${JSON.stringify([...rollup.entries()].sort())}`);
    // AR-R31 final tree: product files plus the kernel snapshot and entry
    // lines, no spec copy on this run, no per-turn journals anywhere.
    const finalEvents = served.manager.events(runId);
    const finalSnapshots = t8SnapshotCommits(finalEvents);
    const handoffSnapshot = finalSnapshots[finalSnapshots.length - 1]!;
    assert.equal(handoffSnapshot.payload.stopKind, "completed");
    const handoffCommit = String(handoffSnapshot.payload.commit);
    const finalFiles = (await t8TreeFiles(repoPath, handoffCommit)).sort();
    assert.deepEqual(
      finalFiles,
      [".gitignore", "AGENTS.md", "CLAUDE.md", HANDOFF_STATE_PATH, "aiboard.config.json", "package.json", "src/a.mjs", "src/b.mjs", "src/c.mjs", "test/a.test.mjs", "test/b.test.mjs", "test/c.test.mjs"].sort(),
      "the handed-off tree is exactly baseline plus product modules plus the kernel handoff files",
    );
    for (const path of finalFiles) {
      assert.ok(
        !/(^|\/)(evidence|diary|diaries|progress|test-output|notes)(\/|$|\.)/i.test(path),
        `no diary/evidence file in the handed-off tree (got ${path})`,
      );
    }
    assert.ok(!finalFiles.some((path) => path.startsWith("docs/project/specs/")), "no spec copy on this run");
    const finalAgents = await t8GitText(repoPath, ["show", `${handoffCommit}:AGENTS.md`]);
    assert.ok(finalAgents.includes(V2_AGENTS_SECTION_BODY));
    const projectTreeBefore = await t8GitText(project, ["rev-parse", "HEAD^{tree}"]);
    const selected = await served.manager.selectProjectHandoff(runId, "keep_integration_branch", "handoff:t8-spine");
    assert.equal(selected.status, "completed");
    assert.equal(await t8GitText(project, ["rev-parse", "HEAD^{tree}"]), projectTreeBefore);
  } catch (error) {
    try {
      const projection = served?.runtime().projection();
      writeFileSync(join(tmpdir(), "t8a1-debug.json"), JSON.stringify({
        root,
        error: String(error),
        planning: projection?.planning ? {
          readiness: projection.planning.readiness,
          triage: projection.planningTriageDecision,
          manifest: projection.planning.source.currentManifestId,
          reads: projection.planning.sourceReadIndex,
          ledger: !!projection.planning.ledger,
          planRevision: projection.planning.plan?.currentRevisionId,
          reviews: projection.planning.coverageRequests,
        } : null,
        architectRequests: architect.requests.length,
        lastArchitectPreview: t8ToolPreview(architect.requests.at(-1), 3000),
        reviewerRequests: reviewer.requests.length,
        lastReviewerPreview: t8ToolPreview(reviewer.requests.at(-1), 2000),
        workerRequests: worker.requests.length,
        delivery: projection?.delivery,
        tail: served?.manager.events(runId).slice(-8),
      }, null, 2));
    } catch { /* debug never masks the original failure */ }
    throw error;
  } finally {
    await served?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
