import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentModel,
  AgentModelRequest,
  ModelTurn,
  ToolCallBlock,
  ToolExecutionOutput,
} from "../src/agent-contracts.js";
import { runAgentLoop } from "../src/agent-loop.js";
import {
  ANSWER_REVIEW_ID,
  BuildRuntime,
  type ArchitectActionRequest,
  type ArchitectRuntimeDriver,
} from "../src/build-runtime.js";
import { createArchitectTools } from "../src/architect-tools.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { SqliteContextManifestStore } from "../src/sqlite-context-manifest-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import {
  NativeArchitectRuntime,
  type ArchitectCommandWorkspaceProvider,
} from "../src/native-architect-runtime.js";
import type { OneShotCommandExecutor } from "../src/one-shot-command-executor.js";
import { createPlanningTools } from "../src/planning-tools.js";
import { renderPlanningStatus } from "../src/agent-prompts.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import {
  NativeAnswerReviewRuntime,
  SchedulerAnswerReviewAuthority,
  createAnswerReviewBroker,
  createRecordAnswerReviewFindingsTool,
  createRequestTriageTools,
  createSubmitAnswerReviewVerdictTool,
  type AnswerReviewDriver,
  type NativeAnswerReviewResult,
} from "../src/request-triage.js";
import {
  assertRoleToolSurface,
  roleToolSurface,
} from "../src/role-capabilities.js";
import { RuntimeRouter, type AgentRuntimeCandidate } from "../src/runtime-router.js";
import {
  buildCompletionReadiness,
  hasAnswerReviewVerdict,
  isAnsweredRun,
  isPlanningState,
  nextAnswerReviewId,
  readyPlanIdentity,
  rebuildSchedulerProjection,
  reduceSchedulerEvent,
  type NewSchedulerEvent,
  type SchedulerEvent,
  type SchedulerProjection,
  type SchedulerStore,
} from "../src/scheduler-store.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SkillCatalog } from "../src/skill-catalog.js";
import { SqliteProjectMemoryStore } from "../src/sqlite-project-memory.js";
import { ToolRegistry } from "../src/tool-registry.js";
import type {
  WorkerAssignment,
  WorkerOutcome,
  WorkerRuntimeDriver,
} from "../src/task-scheduler.js";
import { buildPlanningFixtureScenario } from "./fixtures/planning-source-fixture.js";
import {
  CLAUDE_POINTER_LINE,
  DEFAULT_AGENTS_SECTION_BODY,
  DEFAULT_README_TEMPLATE,
  DEFAULT_STATE_TEMPLATE,
} from "../src/project-docs.js";

/**
 * T9: request triage and the answer path.
 *
 * Durable behavior runs against the real SQLite scheduler store with an
 * advancing clock — never an in-memory fake — because earlier tasks hid
 * crashes behind fakes.
 */

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

const BASE_MS = Date.parse("2026-09-24T00:00:00.000Z");

function advancingClock() {
  let now = BASE_MS;
  return () => new Date(now += 1000).toISOString();
}

function projectionOf(store: SchedulerStore, runId: string): SchedulerProjection {
  return rebuildSchedulerProjection(store.readRun(runId));
}

function seedNewPolicy(
  store: SchedulerStore,
  runId: string,
  clock: () => string,
  runPolicy: "finish" | "plan_only" = "finish",
): void {
  // Production order: docs policy first (the runtime constructor dedups it
  // by key), then run policy, then planning policy during run creation.
  store.append({
    runId,
    type: "project_docs.policy_configured",
    occurredAt: clock(),
    actor: { role: "runner", id: "build-runtime" },
    idempotencyKey: "project-docs-policy",
    payload: { version: 1 },
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

function seedTriage(
  store: SchedulerStore,
  runId: string,
  clock: () => string,
  decision: "answer" | "build" | "clarify",
  key = "triage:1",
): void {
  store.append({
    runId,
    type: "request.triaged",
    occurredAt: clock(),
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: key,
    payload: { decision, rationale: `Seed triage to ${decision}.` },
  });
}

function seedAnswer(
  store: SchedulerStore,
  runId: string,
  clock: () => string,
  addressedParts: string[] = ["Why the build fails", "How to fix it"],
): SchedulerEvent {
  return store.append({
    runId,
    type: "request.answered",
    occurredAt: clock(),
    actor: { role: "architect", id: "architect_1" },
    idempotencyKey: `answer:${addressedParts.length}`,
    payload: {
      answerText: "The build fails because the cache key omits the lockfile; add it.",
      addressedParts,
    },
  });
}

/** Fixture scenario with the amendment's recorded impact scoped (T2 pattern), so retirements validate. */
function scopedFixture() {
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

function entryPointDocs(): { path: string; content: string }[] {
  return [
    { path: "docs/project/README.md", content: DEFAULT_README_TEMPLATE },
    { path: "AGENTS.md", content: DEFAULT_AGENTS_SECTION_BODY },
    { path: "CLAUDE.md", content: CLAUDE_POINTER_LINE },
    { path: "docs/project/STATE.md", content: DEFAULT_STATE_TEMPLATE },
  ];
}

/** Direct durable entry-point docs (requested + committed) through the real store. */
function seedEntryPointDocs(store: SchedulerStore, runId: string, clock: () => string): void {
  let index = 0;
  for (const write of entryPointDocs()) {
    index += 1;
    const requestId = `project-doc:${index}:${write.path}`;
    store.append({
      runId,
      type: "project_doc.requested",
      occurredAt: clock(),
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: requestId,
      payload: {
        requestId,
        path: write.path,
        contentArtifactHash: createHash("sha256").update(write.content, "utf8").digest("hex"),
        contentBytes: Buffer.byteLength(write.content, "utf8"),
        summary: `Write ${write.path}`,
      },
    });
    store.append({
      runId,
      type: "project_doc.committed",
      occurredAt: clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: `project-doc-committed:${requestId}`,
      payload: {
        requestId,
        path: write.path,
        commit: createHash("sha256").update(`commit:${requestId}`).digest("hex").slice(0, 40),
        parent: createHash("sha256").update(`parent:${requestId}`).digest("hex").slice(0, 40),
        head: createHash("sha256").update(`head:${requestId}`).digest("hex").slice(0, 40),
        readme: true,
        agentsMarkedSection: true,
        claudePointer: true,
      },
    });
  }
}

/** Deterministic project-docs port: durable shapes without a git checkout. */
function stubProjectDocsPort() {
  return {
    commit: async (input: { writes: { path: string; content: string }[]; summary: string; runId: string; requestId: string }) => ({
      commit: createHash("sha256").update(`commit:${input.requestId}`).digest("hex").slice(0, 40),
      parent: createHash("sha256").update(`parent:${input.requestId}`).digest("hex").slice(0, 40),
      head: createHash("sha256").update(`head:${input.requestId}`).digest("hex").slice(0, 40),
      entryPoint: { readme: true, agentsMarkedSection: true, claudePointer: true, agentsMarkedSectionV2: false, claudePointerV2: false },
    }),
    relateRevision: async () => "equal_to_tip" as const,
    readHandoffSnapshotFile: async () => {
      throw new Error("request-triage stubs never reach the handoff snapshot read");
    },
    readIntegrationTipFile: async () => {
      throw new Error("request-triage stubs never reach the integration tip read");
    },
    findTrackedFileWithDigest: async () => {
      throw new Error("request-triage stubs never reach the tracked file search");
    },
    findHandoffSnapshotCommit: async () => {
      throw new Error("request-triage stubs never reach the handoff snapshot lookup");
    },
    readIntegrationBaselineRevision: async () => {
      throw new Error("request-triage stubs never reach the baseline revision read");
    },
    canStageSpecPath: async () => {
      throw new Error("request-triage stubs never reach the spec stageability check");
    },
    commitHandoffSnapshot: async (input: { writes: { path: string; content: string }[]; summary: string; runId: string; snapshotKey: string }) => ({
      commit: createHash("sha256").update(`snapshot:${input.snapshotKey}`).digest("hex").slice(0, 40),
      parent: createHash("sha256").update(`parent:${input.snapshotKey}`).digest("hex").slice(0, 40),
      head: createHash("sha256").update(`head:${input.snapshotKey}`).digest("hex").slice(0, 40),
      entryPoint: { readme: false, agentsMarkedSection: false, claudePointer: false, agentsMarkedSectionV2: false, claudePointerV2: false },
    }),
  };
}

async function invoke(
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
  return await request.tools.invoke(call, request.context);
}

async function invokeMustSucceed(
  request: ArchitectActionRequest,
  name: string,
  args: unknown,
  callSuffix = "1",
): Promise<ToolExecutionOutput> {
  const output = await invoke(request, name, args, callSuffix);
  assert.equal(output.isError, false, `${name}: ${JSON.stringify(output.error)}`);
  return output;
}

function outputJson(output: ToolExecutionOutput): Record<string, unknown> & { payload?: Record<string, unknown> } {
  const block = output.content.find((entry) => entry.type === "json");
  assert.ok(block && block.type === "json");
  return block.value as Record<string, unknown> & { payload?: Record<string, unknown> };
}

class ScriptedModel implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  constructor(private readonly turns: ModelTurn[], private readonly label = "scripted") {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push({
      ...request,
      messages: structuredClone(request.messages),
      tools: structuredClone(request.tools),
    });
    const turn = this.turns.shift();
    if (!turn) throw new Error(`Unexpected ${this.label} model call.`);
    return structuredClone(turn);
  }
}

let callCounter = 0;
function toolCallTurn(name: string, args: unknown): ModelTurn {
  callCounter += 1;
  return {
    blocks: [{
      type: "tool_call",
      callId: `call-${callCounter}`,
      name,
      arguments: args,
    }],
    stopReason: "tool_calls",
  };
}

/** Recursive project tree hash (sorted relative paths plus bytes). */
function hashTree(root: string): string {
  const hash = createHash("sha256");
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      const relative = prefix ? `${prefix}/${entry}` : entry;
      if (statSync(full).isDirectory()) {
        walk(full, relative);
      } else {
        hash.update(relative);
        hash.update(readFileSync(full));
      }
    }
  };
  walk(root, "");
  return hash.digest("hex");
}

const CANDIDATES: AgentRuntimeCandidate[] = [
  { runtimeId: "openai:architect", providerId: "openai", modelId: "architect", capabilities: ["code"], priority: 0 },
  { runtimeId: "google:reviewer", providerId: "google", modelId: "reviewer", capabilities: ["code"], priority: 1 },
  { runtimeId: "fallback:reviewer", providerId: "fallback", modelId: "fallback-reviewer", capabilities: ["code"], priority: 2 },
];

function answerReviewHarness(
  name: string,
  turns: ModelTurn[],
  opts: {
    store: SchedulerStore;
    candidates?: readonly AgentRuntimeCandidate[];
    answerRuntimeIds?: readonly string[];
    clock?: () => string;
  },
) {
  const root = mkdtempSync(join(tmpdir(), `aiboard-t9-${name}-`));
  const clock = opts.clock ?? advancingClock();
  // Repair cycle 1 (N3b): the scheduler store is always the real SQLite
  // store — the in-memory fake hid crashes behind fakes.
  const store = opts.store;
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const contextManifests = new SqliteContextManifestStore(join(root, "context-manifests.sqlite"));
  const model = new ScriptedModel(turns, "answer reviewer");
  const harnessCandidates = opts?.candidates ?? CANDIDATES;
  const answerRuntimeIds = opts?.answerRuntimeIds ?? ["google:reviewer", "fallback:reviewer"];
  const router = new RuntimeRouter({
    candidates: harnessCandidates,
    health: new ProviderHealthRegistry({ clock: () => 1_000 }),
  });
  const authority = new SchedulerAnswerReviewAuthority(store);
  const runtime = new NativeAnswerReviewRuntime({
    router,
    candidates: harnessCandidates,
    models: new Map(harnessCandidates.map((candidate) => [candidate.runtimeId, model])),
    answerRuntimeIds: [...answerRuntimeIds],
    sessions,
    artifacts,
    evidenceStore,
    projectRoot: root,
    authority,
    contextManifests,
    recordContextPackText: true,
    clock,
  });
  return {
    root, store, artifacts, sessions, evidenceStore, contextManifests, model, router, authority, runtime, clock,
    close: () => {
      sessions.close();
      evidenceStore.close();
      contextManifests.close();
      store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function answerFindingsTurn(findings: { id: string; statement: string; severity: "blocking" | "non_blocking" }[]): ModelTurn {
  return toolCallTurn("record_answer_review_findings", { findings });
}

function answerVerdictTurn(
  summary: string,
  answerAccurate: boolean,
  priorFindingChecks?: { findingId: string; resolution: "resolved" | "outstanding"; rationale: string }[],
): ModelTurn {
  return toolCallTurn("submit_answer_review_verdict", {
    summary,
    answerAccurate,
    ...(priorFindingChecks !== undefined ? { priorFindingChecks } : {}),
  });
}

class CountingWorkerDriver implements WorkerRuntimeDriver {
  readonly assignments: string[] = [];
  async run(assignment: WorkerAssignment): Promise<WorkerOutcome> {
    this.assignments.push(assignment.task.id);
    return { type: "failed", reason: "must_not_dispatch" };
  }
}

class CountingAnswerReviewDriver implements AnswerReviewDriver {
  readonly calls: unknown[] = [];
  constructor(
    readonly candidateRuntimeIds: readonly string[] = ["google:reviewer"],
    private readonly result: NativeAnswerReviewResult = { status: "unavailable", reviewId: ANSWER_REVIEW_ID, reason: "unused" },
  ) {}
  async review(input: Parameters<AnswerReviewDriver["review"]>[0]): Promise<NativeAnswerReviewResult> {
    this.calls.push(input);
    return this.result;
  }
}

class CountingCoverageReviewDriver {
  readonly calls: unknown[] = [];
  readonly candidateRuntimeIds: readonly string[] = ["google:reviewer"];
  async review(input: unknown): Promise<{ status: "unavailable"; reviewId: string; reason: string }> {
    this.calls.push(input);
    return { status: "unavailable", reviewId: "coverage_1", reason: "unused" };
  }
}

/** Scripted pure-question Architect: triage → answer → entry-point docs → complete. */
class AnswerArchitectDriver implements ArchitectRuntimeDriver {
  readonly reasons: string[] = [];
  readonly turnTools: string[][] = [];
  readonly addressedInTurn: (readonly string[] | undefined)[] = [];
  private step = 0;
  async run(request: ArchitectActionRequest): Promise<void> {
    this.reasons.push(request.reason.type);
    this.turnTools.push(request.tools.definitions().map((tool) => tool.name).sort());
    const step = this.step++;
    if (request.reason.type === "completion_decision_required") {
      await invokeMustSucceed(request, "complete_run", { summary: "Answered." }, "complete");
      return;
    }
    if (step === 0) {
      await invokeMustSucceed(request, "record_triage", {
        decision: "answer",
        rationale: "The request is a pure question with no requested change.",
      }, "triage");
      return;
    }
    if (step === 1) {
      const output = await invokeMustSucceed(request, "record_answer", {
        answerText: "The build fails because the cache key omits the lockfile; add it to the key.",
        addressedParts: ["Why the build fails", "How to fix it"],
      }, "answer");
      this.addressedInTurn.push(outputJson(output).payload?.addressedParts as string[]);
      return;
    }
    for (const write of entryPointDocs()) {
      await invokeMustSucceed(request, "write_project_doc", {
        path: write.path,
        content: write.content,
        summary: `Write ${write.path}`,
      }, write.path);
    }
  }
}

test("T9 pure question completes with zero tasks, zero dispatches, no integration", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-answer-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_pure_question";
  const architect = new AnswerArchitectDriver();
  const workers = new CountingWorkerDriver();
  const answerReview = new CountingAnswerReviewDriver();
  const coverageReview = new CountingCoverageReviewDriver();
  const integrations: unknown[] = [];
  try {
    // Policies land during run creation, before the runtime stamps the rest.
    seedNewPolicy(store, runId, clock);
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
      projectDocs: stubProjectDocsPort(),
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
        integrationBranch: "aiboard/integration/run_t9_pure_question",
        appliedToProject: false,
      },
      "handoff:answer",
    );
    assert.equal(selected.status, "completed");

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
    assert.equal(answerReview.calls.length, 0);
    assert.equal(coverageReview.calls.length, 0);
    assert.equal(
      types.some((type) => type.startsWith("plan_critique.") && type !== "plan_critique.policy_configured"),
      false,
    );
    assert.equal(types.some((type) => type.startsWith("answer.review")), false);
    // Triage is the FIRST action: turn 1 offers record_triage and lands the
    // decision; the answer lists its addressed parts in the same turn.
    assert.deepEqual(architect.reasons, [
      "plan_required",
      "plan_required",
      "plan_required",
      "completion_decision_required",
    ]);
    assert.equal(architect.turnTools[0]?.includes("record_triage"), true);
    assert.deepEqual(architect.addressedInTurn, [["Why the build fails", "How to fix it"]]);
    assert.deepEqual(selected.requestAnswer?.addressedParts, ["Why the build fails", "How to fix it"]);
    // The pure answer still satisfies the STATE.md docs gate (AC-25).
    assert.ok(selected.projectDocs?.committed?.some((commit) => commit.path === "docs/project/STATE.md"));
    // Triage precedes every planning event in the durable log.
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

test("T9 answer-path mutation attempts are refused at every layer, never applied silently", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-refuse-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_t9_refuse";
  try {
    seedNewPolicy(store, runId, clock);
    seedTriage(store, runId, clock, "answer");
    seedAnswer(store, runId, clock);

    // Tool path: the answer turn omits mutation tools, and a forged invoke
    // of an un-omitted tool is refused with the precise error.
    const answerTools = createArchitectTools({
      store,
      clock,
      runPolicy: "finish",
      triageTools: true,
      answerPath: true,
      architectAction: { reason: { type: "plan_required" }, sequence: 0 },
    });
    const names = answerTools.map((tool) => tool.definition.name);
    for (const forbidden of [
      "plan_tasks", "revise_task", "reconcile_plan", "review_task",
      "request_integration", "plan_final_verification", "plan_verification_repairs",
      "plan_verifier_repairs", "resolve_plan_critique", "upgrade_acceptance_contract",
      "answer_guidance",
    ]) {
      assert.equal(names.includes(forbidden), false, `${forbidden} must not be offered`);
    }
    for (const required of ["ask_user", "complete_run", "record_triage", "record_answer", "convert_to_build"]) {
      assert.equal(names.includes(required), true, `${required} must be offered`);
    }
    // Forged invoke: build the tools without the answerPath omission and
    // call plan_tasks directly — the tool refuses before the reducer.
    const forged = createArchitectTools({
      store,
      clock,
      runPolicy: "finish",
      architectAction: { reason: { type: "plan_required" }, sequence: 0 },
    });
    const planTasks = forged.find((tool) => tool.definition.name === "plan_tasks")!;
    const forgedOutput = await planTasks.execute(
      {
        tasks: [{
          id: "T1",
          objective: "Sneak in work.",
          dependencies: [],
          requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "ac1", text: "Done." }],
        }],
      } as never,
      { runId, sessionId: "session_forged", actor: { role: "architect", id: "architect_1" }, workspacePath: root },
    );
    assert.equal(forgedOutput.isError, true);
    assert.equal(forgedOutput.error?.code, "answered_run");
    assert.match(forgedOutput.error?.message ?? "", /Answered runs cannot create tasks/);

    // Direct event path: every mutation is refused by the kernel.
    const directCases: { type: SchedulerEvent["type"]; payload: Record<string, unknown>; match: RegExp }[] = [
      {
        type: "plan.created",
        payload: {
          tasks: [{
            id: "T1",
            objective: "Sneak in work.",
            dependencies: [],
            requiredCapabilities: ["code"],
            acceptanceCriteria: [{ id: "ac1", text: "Done." }],
          }],
        },
        match: /Answered runs cannot create tasks/,
      },
      {
        // Zero tasks exist, so the kernel refuses before admission; the
        // answered admission guard itself is pinned by the synthetic
        // ready+answered projection test below.
        type: "task.transitioned",
        payload: { taskId: "T1", status: "assigned" },
        match: /Unknown task T1/,
      },
      {
        type: "integration.revision_advanced",
        payload: { integrationRevision: "c".repeat(40) },
        match: /Answered runs cannot advance integration/,
      },
      {
        type: "final_verification.generation_created",
        payload: { generationId: "gen_1", targetRevision: "c".repeat(40), taskId: "T1", attempt: 1 },
        match: /Answered runs have no final verification/,
      },
      {
        type: "planning.ledger_persisted",
        payload: { id: "ledger-1", requirements: [], phases: [], nonNormativeSections: [] },
        match: /requires a durable triage decision of build/,
      },
    ];
    for (const [index, attempt] of directCases.entries()) {
      assert.throws(
        () => store.append({
          runId,
          type: attempt.type,
          occurredAt: clock(),
          actor: attempt.type === "task.transitioned" || attempt.type === "integration.revision_advanced" ||
            attempt.type === "final_verification.generation_created"
            ? { role: "runner", id: "build-runtime" }
            : { role: "architect", id: "architect_1" },
          idempotencyKey: `forged:${index}`,
          payload: attempt.payload,
        }),
        attempt.match,
        attempt.type,
      );
    }

    // Replay path: the same forged events are refused when replayed.
    const valid = store.readRun(runId);
    for (const attempt of directCases) {
      const runnerOwned = attempt.type === "task.transitioned" ||
        attempt.type === "integration.revision_advanced" ||
        attempt.type === "final_verification.generation_created";
      assert.throws(
        () => rebuildSchedulerProjection([
          ...valid,
          {
            eventId: `replay_${attempt.type}`,
            runId,
            sequence: valid.length + 1,
            type: attempt.type,
            occurredAt: clock(),
            actor: runnerOwned
              ? { role: "runner", id: "build-runtime" }
              : { role: "architect", id: "architect_1" },
            idempotencyKey: `replay:${attempt.type}`,
            payload: attempt.payload,
          } as SchedulerEvent,
        ]),
        /Answered runs|triage decision of build|Unknown task/,
        `replay ${attempt.type}`,
      );
    }

    // Nothing was applied silently: still zero tasks, no integration, no plan.
    const after = projectionOf(store, runId);
    assert.equal(Object.keys(after.tasks).length, 0);
    assert.equal(after.integrationRevision, undefined);
    assert.equal(after.planning, undefined);
    assert.equal(isAnsweredRun(after), true);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 convert to build restores the normal planning flow explicitly", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-convert-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_t9_convert";
  const fixture = scopedFixture();
  try {
    seedNewPolicy(store, runId, clock);
    store.append({
      runId,
      type: "planning.source_registered",
      occurredAt: clock(),
      actor: { role: "user", id: "owner" },
      idempotencyKey: "source:base",
      payload: { manifest: fixture.priorManifest },
    });
    store.append({
      runId,
      type: "planning.source_amended",
      occurredAt: clock(),
      actor: { role: "user", id: "owner" },
      idempotencyKey: "source:amend-1",
      payload: { manifest: fixture.manifest },
    });
    seedTriage(store, runId, clock, "answer");
    seedAnswer(store, runId, clock);

    // Planning is refused on the answer path.
    const tools = createArchitectTools({
      store,
      clock,
      runPolicy: "finish",
      triageTools: true,
      planningTools: {},
      answerPath: true,
      architectAction: { reason: { type: "plan_required" }, sequence: 0 },
    });
    const convert = tools.find((tool) => tool.definition.name === "convert_to_build")!;
    const context = {
      runId,
      sessionId: "session_convert",
      actor: { role: "architect", id: "architect_1" } as const,
      workspacePath: root,
    };
    // Re-triage is refused once answered — conversion is the only way back.
    const retriage = tools.find((tool) => tool.definition.name === "record_triage")!;
    const retriaged = await retriage.execute(
      { decision: "build", rationale: "Change of mind." } as never,
      context,
    );
    assert.equal(retriaged.isError, true);
    assert.equal(retriaged.error?.code, "already_answered");

    const converted = await convert.execute({ reason: "The answer needs a code fix." } as never, context);
    assert.equal(converted.isError, false, JSON.stringify(converted.error));
    const Projection = projectionOf(store, runId);
    assert.equal(Projection.planningTriageDecision, "build");
    assert.deepEqual(Projection.requestTriage?.conversions, [{
      from: "answer",
      to: "build",
      reason: "The answer needs a code fix.",
      sequence: converted && !converted.isError
        ? (outputJson(converted).sequence as number)
        : -1,
    }]);
    // After conversion the run is in planning state again: the ledger persists.
    assert.equal(isPlanningState(Projection), true);
    assert.equal(isAnsweredRun(Projection), false);
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

test("T9 mixed request triages to build and plans normally", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-mixed-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_t9_mixed";
  const fixture = scopedFixture();
  try {
    seedNewPolicy(store, runId, clock);
    store.append({
      runId,
      type: "planning.source_registered",
      occurredAt: clock(),
      actor: { role: "user", id: "owner" },
      idempotencyKey: "source:base",
      payload: { manifest: fixture.priorManifest },
    });
    store.append({
      runId,
      type: "planning.source_amended",
      occurredAt: clock(),
      actor: { role: "user", id: "owner" },
      idempotencyKey: "source:amend-1",
      payload: { manifest: fixture.manifest },
    });
    const tools = createRequestTriageTools({ store, clock });
    const triage = tools.find((tool) => tool.definition.name === "record_triage")!;
    const context = {
      runId,
      sessionId: "session_mixed",
      actor: { role: "architect", id: "architect_1" } as const,
      workspacePath: root,
    };
    // A mixed explain-then-fix request routes to build, never answer.
    const decided = await triage.execute(
      { decision: "build", rationale: "Explains the cache, then fixes the key." } as never,
      context,
    );
    assert.equal(decided.isError, false, JSON.stringify(decided.error));
    assert.equal(projectionOf(store, runId).planningTriageDecision, "build");
    assert.equal(isPlanningState(projectionOf(store, runId)), true);

    const planning = createPlanningTools({ store, clock });
    const ledger = planning.find((tool) => tool.definition.name === "persist_planning_ledger")!;
    const persisted = await ledger.execute(
      { id: "ledger-1", requirements: fixture.requirements, phases: fixture.phases } as never,
      context,
    );
    assert.equal(persisted.isError, false, JSON.stringify(persisted.error));
    // The answer tool refuses on a build run.
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

test("T9 clarify pauses through ask_user and resumes back to triage", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-clarify-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_t9_clarify";
  const reasons: string[] = [];
  let step = 0;
  try {
    seedNewPolicy(store, runId, clock);
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Fix the thing.",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
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
            await invokeMustSucceed(request, "record_triage", {
              decision: "clarify",
              rationale: "The request names no thing to fix.",
            }, "triage");
          } else if (current === 1) {
            await invokeMustSucceed(request, "ask_user", {
              questionId: "q_clarify",
              version: 1,
              question: "Which thing should I fix?",
              decisionKind: "requirement_conflict",
              blocking: true,
            }, "ask");
          } else if (current === 2) {
            await invokeMustSucceed(request, "record_triage", {
              decision: "answer",
              rationale: "The user asked a pure question instead.",
            }, "retriage");
          } else {
            await invokeMustSucceed(request, "record_answer", {
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
    assert.equal(projectionOf(store, runId).planningTriageDecision, "clarify");
    const question = projectionOf(store, runId).architectQuestions["q_clarify"];
    assert.equal(question?.status, "open");

    runtime.answerArchitectQuestion({
      questionId: "q_clarify",
      expectedVersion: question!.version,
      answer: "Just explain the cache; no fix needed.",
      idempotencyKey: "answer:q_clarify",
    });
    // The resumed turn re-triages (plan_required matches the triage event),
    // then the answer path takes over with an answer turn.
    assert.equal((await runtime.step()).status, "progressed");
    assert.equal((await runtime.step()).status, "progressed");
    const after = projectionOf(store, runId);
    assert.equal(after.planningTriageDecision, "answer");
    assert.equal(after.architectQuestions["q_clarify"]?.resumeStatus, "consumed");
    assert.deepEqual(reasons, ["plan_required", "plan_required", "plan_required", "plan_required"]);
    assert.ok(store.readRun(runId).some((event) => event.type === "architect.question_resume_consumed"));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 legacy run still plans without triage", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-legacy-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_t9_legacy";
  try {
    store.append({
      runId,
      type: "run.policy_configured",
      occurredAt: clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "run-policy-configured",
      payload: { runPolicy: "finish" },
    });
    // Legacy turns offer no triage tools.
    const tools = createArchitectTools({
      store,
      clock,
      runPolicy: "finish",
      architectAction: { reason: { type: "plan_required" }, sequence: 0 },
    });
    const names = tools.map((tool) => tool.definition.name);
    assert.equal(names.includes("record_triage"), false);
    assert.equal(names.includes("plan_tasks"), true);

    // Legacy planning works exactly as before.
    const planTasks = tools.find((tool) => tool.definition.name === "plan_tasks")!;
    const planned = await planTasks.execute(
      {
        revision: 1,
        tasks: [{
          id: "T1",
          objective: "Legacy work.",
          dependencies: [],
          requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "ac1", text: "Done." }],
        }],
      } as never,
      {
        runId,
        sessionId: "session_legacy",
        actor: { role: "architect", id: "architect_1" },
        workspacePath: root,
      },
    );
    assert.equal(planned.isError, false, JSON.stringify(planned.error));
    assert.equal(projectionOf(store, runId).planRevision, 1);

    // Triage tools and events refuse on legacy runs.
    const triageTools = createRequestTriageTools({ store, clock });
    const triage = triageTools.find((tool) => tool.definition.name === "record_triage")!;
    const refused = await triage.execute(
      { decision: "answer", rationale: "Nope." } as never,
      {
        runId,
        sessionId: "session_legacy",
        actor: { role: "architect", id: "architect_1" },
        workspacePath: root,
      },
    );
    assert.equal(refused.isError, true);
    assert.equal(refused.error?.code, "triage_not_configured");
    assert.throws(
      () => store.append({
        runId,
        type: "request.triaged",
        occurredAt: clock(),
        actor: { role: "architect", id: "architect_1" },
        idempotencyKey: "triage:legacy",
        payload: { decision: "answer", rationale: "Nope." },
      }),
      /requires a durable planning policy stamp/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 plan_only run given a pure question is answered", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-planonly-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_planonly_answer";
  const workers = new CountingWorkerDriver();
  const reasons: string[] = [];
  let step = 0;
  try {
    seedNewPolicy(store, runId, clock, "plan_only");
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "How does the retry loop behave under cancellation?",
      runPolicy: "plan_only",
      store,
      clock,
      workerDriver: workers,
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      architectDriver: {
        run: async (request) => {
          reasons.push(request.reason.type);
          const current = step++;
          if (request.reason.type === "completion_decision_required") {
            await invokeMustSucceed(request, "complete_run", { summary: "Answered." }, "complete");
            return;
          }
          if (current === 0) {
            await invokeMustSucceed(request, "record_triage", {
              decision: "answer",
              rationale: "Pure behavior question; no plan needed.",
            }, "triage");
          } else if (current === 1) {
            await invokeMustSucceed(request, "record_answer", {
              answerText: "Cancellation aborts the loop after the in-flight attempt settles.",
              addressedParts: ["Retry behavior under cancellation"],
            }, "answer");
          } else {
            for (const write of entryPointDocs()) {
              await invokeMustSucceed(request, "write_project_doc", {
                path: write.path,
                content: write.content,
                summary: `Write ${write.path}`,
              }, write.path);
            }
          }
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      projectDocs: stubProjectDocsPort(),
    });
    const blocked = await runtime.runUntilBlocked(20);
    assert.equal(blocked.status, "paused");
    const selected = runtime.selectProjectHandoff(
      "keep_integration_branch",
      {
        integrationRevision: "no_integration",
        integrationBranch: "aiboard/integration/run_t9_planonly_answer",
        appliedToProject: false,
      },
      "handoff:planonly-answer",
    );
    assert.equal(selected.status, "completed");
    assert.equal(selected.planningTriageDecision, "answer");
    assert.equal(Object.keys(selected.tasks).length, 0);
    assert.equal(workers.assignments.length, 0);
    assert.equal(readyPlanIdentity(selected), undefined);
    assert.deepEqual(reasons, [
      "plan_required",
      "plan_required",
      "plan_required",
      "completion_decision_required",
    ]);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 answer review without opt-in is refused and never runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-nooptin-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_t9_no_optin";
  try {
    seedNewPolicy(store, runId, clock);
    seedTriage(store, runId, clock, "answer");
    seedAnswer(store, runId, clock);
    // Findings and verdicts without the user's opt-in are refused.
    for (const [type, payload, key] of [
      ["answer.review_findings_recorded", { reviewId: "answer_review_1", findings: [] }, "findings:no-optin"],
      ["answer.review_recorded", {
        id: "answer_review_1",
        reviewerRuntimeId: "google:reviewer",
        independence: "distinct_model",
        answerSequence: 5,
        findings: [],
        summary: "Looks fine.",
        answerAccurate: true,
      }, "verdict:no-optin"],
    ] as const) {
      assert.throws(
        () => store.append({
          runId,
          type,
          occurredAt: clock(),
          actor: { role: "verifier", id: "google:reviewer" },
          idempotencyKey: key,
          payload: { ...payload },
        }),
        /opt-in/,
        type,
      );
    }
    assert.equal(hasAnswerReviewVerdict(projectionOf(store, runId)), false);
    // ...and completion does not require a review that was never opted into.
    seedEntryPointDocs(store, runId, clock);
    const readiness = buildCompletionReadiness(projectionOf(store, runId));
    assert.equal(readiness.ready, true, JSON.stringify(readiness.issues));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 opted-in answer review runs once via selectVerifier with a durable verdict", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-optin-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_optin";
  const harness = answerReviewHarness(
    "optin",
    [
      answerFindingsTurn([]),
      answerVerdictTurn("The answer checks out against the cache code.", true),
    ],
    { store, clock },
  );
  const reviewCalls: unknown[] = [];
  let reviewResult: NativeAnswerReviewResult | undefined;
  const architect = new AnswerArchitectDriver();
  try {
    seedNewPolicy(store, runId, clock);
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Why does the build fail, and how do I fix it?",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: architect,
      architectId: "openai:architect",
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      projectDocs: stubProjectDocsPort(),
      answerReview: {
        candidateRuntimeIds: ["google:reviewer", "fallback:reviewer"],
        review: async (input) => {
          reviewCalls.push(input);
          reviewResult = await harness.runtime.review(input);
          return reviewResult;
        },
      },
    });
    // Triage + answer land first; the user opts in after reading the answer.
    assert.equal((await runtime.step()).status, "progressed");
    assert.equal((await runtime.step()).status, "progressed");
    assert.ok(projectionOf(store, runId).requestAnswer);
    store.append({
      runId,
      type: "answer.review_opted_in",
      occurredAt: clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "answer:optin",
      payload: {},
    });
    const blocked = await runtime.runUntilBlocked(20);
    assert.equal(blocked.status, "paused");
    const selected = runtime.selectProjectHandoff(
      "keep_integration_branch",
      {
        integrationRevision: "no_integration",
        integrationBranch: "aiboard/integration/run_t9_optin",
        appliedToProject: false,
      },
      "handoff:optin",
    );
    assert.equal(selected.status, "completed");

    // The review ran exactly once, chose a model distinct from the
    // Architect's through the shared selector, and recorded independence.
    assert.equal(reviewCalls.length, 1);
    const verdict = selected.answerReviews?.[ANSWER_REVIEW_ID];
    assert.ok(verdict);
    assert.equal(verdict.independence, "distinct_model");
    assert.equal(verdict.reviewerRuntimeId, "google:reviewer");
    assert.equal(verdict.answerAccurate, true);
    assert.equal(verdict.answerSequence, selected.requestAnswer?.sequence);
    assert.equal(hasAnswerReviewVerdict(selected), true);
    // Fresh sessions per pass, owned by the reviewer.
    assert.equal(harness.model.requests.length, 2);
    assert.equal(reviewResult?.status, "reviewed");
    if (reviewResult?.status !== "reviewed") throw new Error("unreachable");
    assert.notEqual(reviewResult.findingsSessionId, reviewResult.verdictSessionId);
    for (const sessionId of [reviewResult.findingsSessionId, reviewResult.verdictSessionId]) {
      const session = await harness.sessions.load(sessionId);
      assert.equal(session.actor.role, "verifier");
      assert.equal(session.actor.id, "google:reviewer");
      assert.equal(session.runId, runId);
    }
    // The first request of each pass carries only the pack messages.
    assert.deepEqual(
      harness.model.requests[0]!.messages.map((message) => message.role),
      ["system", "user"],
    );
    assert.deepEqual(
      harness.model.requests[1]!.messages.map((message) => message.role),
      ["system", "user"],
    );
  } finally {
    // The harness owns the shared store close; the run root still needs cleanup.
    harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 single-model answer review records fresh_context in a fresh session", async () => {
  // Repair cycle 1 (N3b): the real SQLite scheduler store, not the memory fake.
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-fresh-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_t9_fresh_context";
  const sentinel = "ARCHITECT-ONLY-SENTINEL-9c4e2a";
  const harness = answerReviewHarness(
    "fresh",
    [
      answerFindingsTurn([]),
      answerVerdictTurn("Accurate.", true),
    ],
    {
      store,
      clock,
      candidates: [
        { runtimeId: "openai:architect", providerId: "openai", modelId: "architect", capabilities: ["code"], priority: 0 },
      ],
      answerRuntimeIds: ["openai:architect"],
    },
  );
  try {
    seedNewPolicy(store, runId, clock);
    seedTriage(store, runId, clock, "answer");
    const answered = seedAnswer(store, runId, clock);
    store.append({
      runId,
      type: "answer.review_opted_in",
      occurredAt: clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "answer:optin",
      payload: {},
    });
    // An architect session with sentinel content shares the session store;
    // the fresh-context reviewer must never see it.
    await harness.sessions.create({
      sessionId: "architect-session-1",
      runId,
      actor: { role: "architect", id: "openai:architect" },
      occurredAt: clock(),
    });
    await harness.sessions.checkpoint("architect-session-1", {
      messages: [{ id: "a1", role: "assistant", content: sentinel }],
      turns: 1,
      seenCallIds: [],
    }, clock());

    const result = await harness.runtime.review({
      runId,
      reviewId: "answer_review_1",
      architectRuntimeId: "openai:architect",
      question: "Why does the build fail?",
      answerText: "The cache key omits the lockfile.",
      addressedParts: ["Why the build fails"],
      answerSequence: answered.sequence,
    });
    assert.equal(result.status, "reviewed");
    if (result.status !== "reviewed") throw new Error("unreachable");
    assert.equal(result.independence, "fresh_context");
    assert.equal(result.runtimeId, "openai:architect");
    assert.equal(result.review.independence, "fresh_context");
    // Both passes start from exactly the pack messages; no sentinel leaks.
    assert.equal(harness.model.requests.length, 2);
    for (const request of harness.model.requests) {
      assert.equal(request.messages.length, 2);
      assert.equal(JSON.stringify(request.messages).includes(sentinel), false);
    }
    assert.deepEqual(
      harness.model.requests[0]!.messages.map((message) => message.id),
      ["answer-findings-system", harness.model.requests[0]!.messages[1]!.id],
    );
    assert.ok(harness.model.requests[0]!.messages[1]!.id.startsWith("context:"));
  } finally {
    // The harness owns the shared store close; the run root still needs cleanup.
    harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 answer path makes no extra model pass by default", async () => {
  // Repair cycle 1 (N3a): every Architect action runs through the REAL agent
  // loop against the REAL tool registry — one tool call per model turn, the
  // lifecycle batch enforced — and the test counts real model calls.
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-nopass-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_no_extra_pass";
  const answerReview = new CountingAnswerReviewDriver();
  const coverageReview = new CountingCoverageReviewDriver();
  const criticCalls: unknown[] = [];
  const reasons: string[] = [];
  const loopStatuses: string[] = [];
  const model = new ScriptedModel([
    toolCallTurn("record_triage", {
      decision: "answer",
      rationale: "The request is a pure question with no requested change.",
    }),
    toolCallTurn("record_answer", {
      answerText: "The build fails because the cache key omits the lockfile; add it to the key.",
      addressedParts: ["Why the build fails", "How to fix it"],
    }),
    // The docs action writes all four entry-point docs — each alone in its
    // turn, like production — then completes in the same action: the docs
    // commit synchronously, so readiness holds for the final turn.
    ...entryPointDocs().map((write) => toolCallTurn("write_project_doc", {
      path: write.path,
      content: write.content,
      summary: `Write ${write.path}`,
    })),
    toolCallTurn("complete_run", { summary: "Answered." }),
  ], "architect");
  const architect: ArchitectRuntimeDriver = {
    run: async (request) => {
      reasons.push(request.reason.type);
      // One agent loop per Architect action, exactly like production: the
      // scripted model emits one tool call per turn and every loop must end
      // on a real lifecycle signal. Any extra model call throws.
      const result = await runAgentLoop({
        model,
        registry: request.tools,
        context: request.context,
        initialMessages: [
          { id: `system:${reasons.length}`, role: "system", content: "You are the test Architect." },
          { id: `action:${reasons.length}`, role: "user", content: `Act: ${request.reason.type}.` },
        ],
        maxTurns: 8,
      });
      loopStatuses.push(result.status);
    },
  };
  try {
    seedNewPolicy(store, runId, clock);
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Why does the build fail, and how do I fix it?",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: architect,
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      projectDocs: stubProjectDocsPort(),
      answerReview,
      coverageReview: coverageReview as never,
      // Even with an always-on critic configured, the answer path runs none.
      planCritic: {
        candidateRuntimeIds: ["google:reviewer"],
        mode: "always",
        stricterQualification: false,
        architectDeclaration: () => "low" as const,
        critique: async (input) => {
          criticCalls.push(input);
          throw new Error("must_not_critique");
        },
      },
    });
    const blocked = await runtime.runUntilBlocked(20);
    assert.equal(blocked.status, "paused");
    const selected = runtime.selectProjectHandoff(
      "keep_integration_branch",
      {
        integrationRevision: "no_integration",
        integrationBranch: "aiboard/integration/run_t9_no_extra_pass",
        appliedToProject: false,
      },
      "handoff:nopass",
    );
    assert.equal(selected.status, "completed");
    // Exactly 7 real Architect model calls — triage, answer, four doc
    // writes, completion — across 3 actions, each ending on a lifecycle
    // signal. No critic, coverage, or answer-review model pass ran.
    assert.equal(model.requests.length, 7);
    assert.equal(reasons.length, 3);
    assert.deepEqual(loopStatuses, ["architect_action", "architect_action", "architect_action"]);
    assert.equal(answerReview.calls.length, 0);
    assert.equal(coverageReview.calls.length, 0);
    assert.equal(criticCalls.length, 0);
    const types = store.readRun(runId).map((event) => event.type);
    assert.equal(types.some((type) => type.startsWith("answer.review")), false);
    assert.equal(types.some((type) => type.startsWith("planning.coverage_")), false);
    assert.equal(
      types.some((type) => type.startsWith("plan_critique.") && type !== "plan_critique.policy_configured"),
      false,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 under triage answer an Architect command runs in a disposable copy and the project hash is unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-cmd-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(project, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "app.ts"), "export const answer = 42;\n");
  writeFileSync(join(project, "notes.md"), "# notes\n");
  const before = hashTree(project);
  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
  const sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
  const evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
  const memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
  const runId = "run-t9-cmd-answer";
  const objective = "Why does the build fail?";
  const copyDir = join(root, "copy");
  const seen = { creates: 0, cleanups: 0, revisions: [] as string[] };
  const executed: { workingDirectory: string; executable: string }[] = [];
  try {
    scheduler.append({
      runId,
      type: "run.initialized",
      occurredAt: "2026-09-24T00:00:00.000Z",
      actor: { role: "runner", id: "test" },
      idempotencyKey: "init",
      payload: { objective },
    });
    seedNewPolicy(scheduler, runId, advancingClock());
    seedTriage(scheduler, runId, advancingClock(), "answer");
    assert.equal(isPlanningState(projectionOf(scheduler, runId)), false);

    const execution: OneShotCommandExecutor = {
      execute: async (request) => {
        executed.push({ workingDirectory: request.workingDirectory, executable: request.executable });
        writeFileSync(join(request.workingDirectory, "t9-marker.txt"), "answer-path command ran here");
        return {
          process: {
            logicalProcessId: "t9-test",
            outcome: "exited",
            exitCode: 0,
            finishedAt: "2026-09-24T00:00:01.000Z",
            output: [],
            cleanup: { state: "not_required" },
          },
          enforcement: "write_confinement_exact_grant",
          disclosure: "provider_specific_not_universal_boundary",
        };
      },
    };
    const candidate: AgentRuntimeCandidate = {
      runtimeId: "test:architect",
      providerId: "test",
      modelId: "architect",
      capabilities: ["code"],
      priority: 1,
    };
    const health = new ProviderHealthRegistry();
    const model = new ScriptedModel([
      toolCallTurn("run_evidence_command", { label: "inspect", command: "echo", args: ["hi"], cwd: "." }),
      { blocks: [], stopReason: "cancelled" },
    ]);
    const architect = new NativeArchitectRuntime({
      schedulerStore: scheduler,
      router: new RuntimeRouter({ candidates: [candidate], health }),
      health,
      candidates: [candidate],
      models: new Map([[candidate.runtimeId, model]]),
      initialRuntimeId: candidate.runtimeId,
      sessions,
      artifacts,
      skillCatalog: new SkillCatalog({ projectRoot: project }),
      memoryStore: memory,
      evidenceStore: evidence,
      projectId: "project-t9-cmd",
      projectRoot: project,
      objective,
      permissionProfile: "full",
      answerCommandRevision: "b".repeat(40),
      commandWorkspace: {
        workspaceKind: "independent-verifier",
        create: async (targetRevision: string) => {
          seen.creates += 1;
          seen.revisions.push(targetRevision);
          mkdirSync(copyDir, { recursive: true });
          return { path: copyDir };
        },
        cleanup: async () => {
          seen.cleanups += 1;
        },
      } satisfies ArchitectCommandWorkspaceProvider,
      execution,
    });
    await architect.run({
      runId,
      reason: { type: "plan_required" },
      projection: projectionOf(scheduler, runId),
      tools: new ToolRegistry(),
      context: {
        runId,
        sessionId: `architect:${runId}`,
        actor: { role: "architect", id: "architect" },
      },
    });

    // The command tool is listed on the answer path...
    const listed = (model.requests[0]?.tools ?? []).map((tool) => tool.name);
    assert.equal(listed.includes("run_evidence_command"), true);
    // ...runs exactly once, inside the disposable copy — never the project.
    assert.equal(seen.creates, 1);
    assert.deepEqual(seen.revisions, ["b".repeat(40)]);
    assert.equal(executed.length, 1);
    assert.equal(executed[0]!.workingDirectory, copyDir);
    assert.equal(readFileSync(join(copyDir, "t9-marker.txt"), "utf8"), "answer-path command ran here");
    assert.equal(hashTree(project), before);
  } finally {
    sessions.close();
    scheduler.close();
    evidence.close();
    memory.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 under build without a ready plan and under clarify commands stay refused", async () => {
  for (const decision of ["build", "clarify"] as const) {
    const root = mkdtempSync(join(tmpdir(), `aiboard-t9-cmd-${decision}-`));
    const project = join(root, "project");
    const state = join(root, "state");
    mkdirSync(project, { recursive: true });
    mkdirSync(state, { recursive: true });
    const artifacts = new ArtifactStore(join(state, "artifacts"));
    const scheduler = new SqliteSchedulerStore(join(state, "scheduler.sqlite"));
    const sessions = new SqliteAgentSessionStore(join(state, "sessions.sqlite"), artifacts);
    const evidence = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
    const memory = new SqliteProjectMemoryStore(join(state, "memory.sqlite"));
    const runId = `run-t9-cmd-${decision}`;
    const seen = { creates: 0 };
    try {
      scheduler.append({
        runId,
        type: "run.initialized",
        occurredAt: "2026-09-24T00:00:00.000Z",
        actor: { role: "runner", id: "test" },
        idempotencyKey: "init",
        payload: { objective: "Build the feature." },
      });
      seedNewPolicy(scheduler, runId, advancingClock());
      seedTriage(scheduler, runId, advancingClock(), decision);
      assert.equal(isPlanningState(projectionOf(scheduler, runId)), true);

      const candidate: AgentRuntimeCandidate = {
        runtimeId: "test:architect",
        providerId: "test",
        modelId: "architect",
        capabilities: ["code"],
        priority: 1,
      };
      const health = new ProviderHealthRegistry();
      const model = new ScriptedModel([
        toolCallTurn("run_evidence_command", { label: "sneak", command: "echo", args: ["hi"], cwd: "." }),
        { blocks: [], stopReason: "cancelled" },
      ]);
      const architect = new NativeArchitectRuntime({
        schedulerStore: scheduler,
        router: new RuntimeRouter({ candidates: [candidate], health }),
        health,
        candidates: [candidate],
        models: new Map([[candidate.runtimeId, model]]),
        initialRuntimeId: candidate.runtimeId,
        sessions,
        artifacts,
        skillCatalog: new SkillCatalog({ projectRoot: project }),
        memoryStore: memory,
        evidenceStore: evidence,
        projectId: `project-t9-cmd-${decision}`,
        projectRoot: project,
        objective: "Build the feature.",
        answerCommandRevision: "b".repeat(40),
        commandWorkspace: {
          workspaceKind: "independent-verifier",
          create: async () => {
            seen.creates += 1;
            return { path: join(root, "copy") };
          },
          cleanup: async () => undefined,
        } satisfies ArchitectCommandWorkspaceProvider,
      });
      await architect.run({
        runId,
        reason: { type: "plan_required" },
        projection: projectionOf(scheduler, runId),
        tools: new ToolRegistry(),
        context: {
          runId,
          sessionId: `architect:${runId}`,
          actor: { role: "architect", id: "architect" },
        },
      });
      // The T3a planning-state guard still owns these turns: the command
      // tool is not even listed, the call errors, and the answer-path base
      // revision never creates a copy.
      const listed = (model.requests[0]?.tools ?? []).map((tool) => tool.name);
      assert.equal(listed.includes("run_evidence_command"), false);
      const toolMessages = model.requests.flatMap((request) =>
        request.messages.filter((message) => message.role === "tool"),
      );
      assert.ok(toolMessages.length > 0);
      assert.equal(
        toolMessages.every((message) => JSON.stringify(message.content).includes('"isError":true')),
        true,
      );
      assert.equal(seen.creates, 0);
    } finally {
      sessions.close();
      scheduler.close();
      evidence.close();
      memory.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("T9 triage precedes planning: tools and the kernel refuse until triage is build", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-order-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_t9_ordering";
  const fixture = scopedFixture();
  const context = {
    runId,
    sessionId: "session_order",
    actor: { role: "architect", id: "architect_1" } as const,
    workspacePath: root,
  };
  try {
    seedNewPolicy(store, runId, clock);
    store.append({
      runId,
      type: "planning.source_registered",
      occurredAt: clock(),
      actor: { role: "user", id: "owner" },
      idempotencyKey: "source:base",
      payload: { manifest: fixture.priorManifest },
    });
    store.append({
      runId,
      type: "planning.source_amended",
      occurredAt: clock(),
      actor: { role: "user", id: "owner" },
      idempotencyKey: "source:amend-1",
      payload: { manifest: fixture.manifest },
    });

    // Tool path: plan-progressing planning tools refuse before triage; the
    // durable read stays available (triage turns may inspect the source).
    const planning = createPlanningTools({ store, clock });
    const ledger = planning.find((tool) => tool.definition.name === "persist_planning_ledger")!;
    const refused = await ledger.execute(
      { id: "ledger-1", requirements: fixture.requirements, phases: fixture.phases } as never,
      context,
    );
    assert.equal(refused.isError, true);
    assert.equal(refused.error?.code, "triage_required");
    const read = planning.find((tool) => tool.definition.name === "read_planning_source_section")!;
    const section = fixture.manifest.sections[0]!;
    const inspected = await read.execute(
      { sectionId: section.id, purpose: "triage the request" } as never,
      context,
    );
    // No source bytes are provisioned here, so the read fails later — the
    // point is the triage gate does not own it.
    assert.notEqual(inspected.error?.code, "triage_required");

    // Kernel path: planning progress is refused before triage, under
    // clarify, and on the answer path.
    const ledgerEvent = (key: string): NewSchedulerEvent => ({
      runId,
      type: "planning.ledger_persisted",
      occurredAt: clock(),
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: key,
      payload: { id: "ledger-1", requirements: fixture.requirements, phases: fixture.phases, nonNormativeSections: [] },
    });
    assert.throws(() => store.append(ledgerEvent("ledger:before-triage")), /requires a durable triage decision of build/);
    assert.throws(
      () => store.append({
        runId,
        type: "planning.plan_drafted",
        occurredAt: clock(),
        actor: { role: "architect", id: "architect_1" },
        idempotencyKey: "draft:before-triage",
        payload: { id: "plan-1" },
      }),
      /requires a durable triage decision of build/,
    );
    seedTriage(store, runId, clock, "clarify", "triage:clarify");
    assert.throws(() => store.append(ledgerEvent("ledger:clarify")), /requires a durable triage decision of build/);

    // Re-triage to build admits planning; the triage event precedes the
    // first planning progress event in the durable log.
    seedTriage(store, runId, clock, "build", "triage:build");
    const admitted = await ledger.execute(
      { id: "ledger-1", requirements: fixture.requirements, phases: fixture.phases } as never,
      context,
    );
    assert.equal(admitted.isError, false, JSON.stringify(admitted.error));
    const types = store.readRun(runId).map((event) => event.type);
    const triagedAt = types.indexOf("request.triaged");
    const ledgerAt = types.indexOf("planning.ledger_persisted");
    assert.ok(triagedAt >= 0 && ledgerAt > triagedAt);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 re-review records its own view before seeing prior findings (OA-10 #2)", async () => {
  // Repair cycle 1 (N3b): the real SQLite scheduler store, not the memory fake.
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-rereview-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_t9_rereview";
  const priorStatement = "PRIOR-FINDING-UNIQUE-77c1: the cache claim cites no source.";
  const harness = answerReviewHarness(
    "rereview",
    [
      answerFindingsTurn([{ id: "f-own", statement: "Own view: the fix steps are correct.", severity: "non_blocking" }]),
      answerVerdictTurn("Re-review agrees with reservations.", true, [
        { findingId: "f-prior", resolution: "outstanding", rationale: "Still uncited." },
      ]),
    ],
    { store, clock },
  );
  try {
    seedNewPolicy(store, runId, clock);
    seedTriage(store, runId, clock, "answer");
    const answered = seedAnswer(store, runId, clock);
    store.append({
      runId,
      type: "answer.review_opted_in",
      occurredAt: clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "answer:optin",
      payload: {},
    });
    // The prior review exists durably (first review, recorded directly).
    store.append({
      runId,
      type: "answer.review_findings_recorded",
      occurredAt: clock(),
      actor: { role: "verifier", id: "google:reviewer" },
      idempotencyKey: "answer:findings:answer_review_1",
      payload: {
        reviewId: "answer_review_1",
        findings: [{ id: "f-prior", statement: priorStatement, severity: "blocking" }],
      },
    });
    store.append({
      runId,
      type: "answer.review_recorded",
      occurredAt: clock(),
      actor: { role: "verifier", id: "google:reviewer" },
      idempotencyKey: "answer:verdict:answer_review_1",
      payload: {
        id: "answer_review_1",
        reviewerRuntimeId: "google:reviewer",
        independence: "distinct_model",
        answerSequence: answered.sequence,
        findings: [{ id: "f-prior", statement: priorStatement, severity: "blocking" }],
        summary: "First review.",
        answerAccurate: false,
      },
    });
    const prior = projectionOf(store, runId).answerReviews?.["answer_review_1"];
    assert.ok(prior);

    // A release before the own findings is refused.
    assert.throws(
      () => store.append({
        runId,
        type: "answer.review_prior_findings_released",
        occurredAt: clock(),
        actor: { role: "runner", id: "answer-review-runtime" },
        idempotencyKey: "answer:release:early",
        payload: { reviewId: "answer_review_2", priorReviewId: "answer_review_1" },
      }),
      /must record its own findings before prior findings are released/,
    );

    const result = await harness.runtime.review({
      runId,
      reviewId: "answer_review_2",
      architectRuntimeId: "openai:architect",
      question: "Why does the build fail?",
      answerText: "The cache key omits the lockfile.",
      addressedParts: ["Why the build fails"],
      answerSequence: answered.sequence,
      priorReview: prior,
    });
    assert.equal(result.status, "reviewed");
    if (result.status !== "reviewed") throw new Error("unreachable");

    // The own-view pass never saw the prior findings; the verdict pass did.
    assert.equal(harness.model.requests.length, 2);
    assert.equal(JSON.stringify(harness.model.requests[0]!.messages).includes(priorStatement), false);
    assert.equal(JSON.stringify(harness.model.requests[1]!.messages).includes(priorStatement), true);
    // The release landed between the own findings and the verdict.
    const events = store.readRun(runId);
    const findingsAt = events.findIndex((event) =>
      event.type === "answer.review_findings_recorded" &&
      (event.payload.reviewId as string) === "answer_review_2");
    const releaseAt = events.findIndex((event) =>
      event.type === "answer.review_prior_findings_released" &&
      (event.payload.reviewId as string) === "answer_review_2");
    const verdictAt = events.findIndex((event) =>
      event.type === "answer.review_recorded" &&
      (event.payload.id as string) === "answer_review_2");
    assert.ok(findingsAt >= 0 && releaseAt > findingsAt && verdictAt > releaseAt);
    // The verdict checks the prior finding.
    assert.deepEqual(result.review.priorFindingChecks, [
      { findingId: "f-prior", resolution: "outstanding", rationale: "Still uncited." },
    ]);

    // A verdict that skips a prior finding check is refused.
    store.append({
      runId,
      type: "answer.review_findings_recorded",
      occurredAt: clock(),
      actor: { role: "verifier", id: "google:reviewer" },
      idempotencyKey: "answer:findings:answer_review_3",
      payload: {
        reviewId: "answer_review_3",
        priorReviewId: "answer_review_1",
        findings: [{ id: "f-3", statement: "view", severity: "non_blocking" }],
      },
    });
    store.append({
      runId,
      type: "answer.review_prior_findings_released",
      occurredAt: clock(),
      actor: { role: "runner", id: "answer-review-runtime" },
      idempotencyKey: "answer:release:answer_review_3",
      payload: { reviewId: "answer_review_3", priorReviewId: "answer_review_1" },
    });
    assert.throws(
      () => store.append({
        runId,
        type: "answer.review_recorded",
        occurredAt: clock(),
        actor: { role: "verifier", id: "google:reviewer" },
        idempotencyKey: "answer:verdict:answer_review_3",
        payload: {
          id: "answer_review_3",
          reviewerRuntimeId: "google:reviewer",
          independence: "distinct_model",
          answerSequence: answered.sequence,
          findings: [{ id: "f-3", statement: "view", severity: "non_blocking" }],
          summary: "Skips the prior check.",
          answerAccurate: true,
          priorReviewId: "answer_review_1",
          priorFindingChecks: [],
        },
      }),
      /must check each prior finding exactly once/,
    );
  } finally {
    // The harness owns the shared store close; the run root still needs cleanup.
    harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 answered-run completion requires the answer, nothing spurious, and the docs gate", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-ready-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_t9_readiness";
  try {
    seedNewPolicy(store, runId, clock);
    seedTriage(store, runId, clock, "answer");
    // No answer yet: completion is not ready, and complete_run refuses.
    seedEntryPointDocs(store, runId, clock);
    const withoutAnswer = buildCompletionReadiness(projectionOf(store, runId));
    assert.equal(withoutAnswer.ready, false);
    assert.ok(withoutAnswer.issues.some((issue) => issue.includes("answer has not been recorded")));
    const tools = createArchitectTools({
      store,
      clock,
      runPolicy: "finish",
      triageTools: true,
      answerPath: true,
      architectAction: { reason: { type: "completion_decision_required" }, sequence: 0 },
    });
    const complete = tools.find((tool) => tool.definition.name === "complete_run")!;
    const context = {
      runId,
      sessionId: "session_ready",
      actor: { role: "architect", id: "architect_1" } as const,
      workspacePath: root,
    };
    const refused = await complete.execute({ summary: "Too early." } as never, context);
    assert.equal(refused.isError, true);
    assert.equal(refused.error?.code, "completion_not_ready");

    // Answer recorded: ready (docs were seeded above).
    seedAnswer(store, runId, clock);
    const ready = buildCompletionReadiness(projectionOf(store, runId));
    assert.equal(ready.ready, true, JSON.stringify(ready.issues));

    // The docs gate still applies beside the answer checks (G-3): a run
    // with an answer but no STATE.md is not ready.
    const undocumented = new SqliteSchedulerStore(join(root, "scheduler-nodocs.sqlite"));
    const runId2 = "run_t9_readiness_nodocs";
    try {
      seedNewPolicy(undocumented, runId2, clock);
      seedTriage(undocumented, runId2, clock, "answer");
      seedAnswer(undocumented, runId2, clock);
      const gated = buildCompletionReadiness(projectionOf(undocumented, runId2));
      assert.equal(gated.ready, false);
      assert.ok(gated.issues.some((issue) => issue.includes("STATE.md")));
    } finally {
      undocumented.close();
    }

    // Opt-in without a verdict blocks; a verdict unblocks.
    store.append({
      runId,
      type: "answer.review_opted_in",
      occurredAt: clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "answer:optin",
      payload: {},
    });
    const awaitingReview = buildCompletionReadiness(projectionOf(store, runId));
    assert.equal(awaitingReview.ready, false);
    assert.ok(awaitingReview.issues.some((issue) => issue.includes("opted-in answer review")));
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 answer-path and answer-review tool surfaces are exact", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-surface-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_surface";
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  try {
    seedNewPolicy(store, runId, clock);
    // The answer-path lifecycle registration is exact: questions,
    // completion, docs, the durable planning read, and triage tools —
    // nothing else. Repair cycle 1 (N5): the plan-progressing planning
    // tools always refuse on the answer path, so they are not offered.
    const answerTools = createArchitectTools({
      store,
      clock,
      runPolicy: "finish",
      triageTools: true,
      planningTools: {},
      answerPath: true,
      artifacts,
      architectAction: { reason: { type: "plan_required" }, sequence: 0 },
    });
    assert.deepEqual(
      answerTools.map((tool) => tool.definition.name).sort(),
      [
        "ask_user",
        "complete_run",
        "convert_to_build",
        "read_planning_source_section",
        "record_answer",
        "record_triage",
        "write_project_doc",
      ],
    );
    // The answer-review broker grants the read-only surface plus exactly one
    // lifecycle tool per pass.
    const findingsBroker = createAnswerReviewBroker({
      workspacePath: root,
      artifacts,
      evidenceStore,
      runId,
      clock,
      lifecycleTool: createRecordAnswerReviewFindingsTool({
        authority: new SchedulerAnswerReviewAuthority(store),
        runId,
        reviewId: "answer_review_1",
        runtimeId: "google:reviewer",
        sessionId: "answer:session",
        clock,
      }),
    });
    assertRoleToolSurface(
      "verifier",
      "answer",
      findingsBroker.definitions().map((definition) => definition.name),
    );
    assert.deepEqual(
      findingsBroker.definitions().map((definition) => definition.name).sort(),
      [...roleToolSurface("verifier", "answer").tools, "record_answer_review_findings"].sort(),
    );
    const verdictBroker = createAnswerReviewBroker({
      workspacePath: root,
      artifacts,
      evidenceStore,
      runId,
      clock,
      lifecycleTool: createSubmitAnswerReviewVerdictTool({
        authority: new SchedulerAnswerReviewAuthority(store),
        runId,
        reviewId: "answer_review_1",
        reviewerRuntimeId: "google:reviewer",
        independence: "distinct_model",
        answerSequence: 5,
        runtimeId: "google:reviewer",
        sessionId: "answer:session",
        clock,
      }),
    });
    assert.deepEqual(
      verdictBroker.definitions().map((definition) => definition.name).sort(),
      [...roleToolSurface("verifier", "answer").tools, "submit_answer_review_verdict"].sort(),
    );
  } finally {
    evidenceStore.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 zero-mutation guards refuse task creation and dispatch even with a ready plan", async () => {
  // Unreachable through valid events by construction (planning refuses under
  // answer): the synthetic ready+answered projection pins the guards as
  // load-bearing defense in depth — and is the prove-red target.
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-synth-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_t9_synthetic";
  const fixture = buildPlanningFixtureScenario();
  try {
    seedNewPolicy(store, runId, clock);
    seedTriage(store, runId, clock, "answer");
    seedAnswer(store, runId, clock);
    const answered = projectionOf(store, runId);
    // A ready planning projection from the shared fixture shape: readiness
    // ready with the identity fields the task-creation path reads.
    const readyPlanning = {
      source: {
        manifestsById: { [fixture.manifest.manifestId]: fixture.manifest },
        currentManifestId: fixture.manifest.manifestId,
        readsBySectionId: {},
      },
      ledger: { id: "ledger-1" },
      plan: { id: "plan-1", currentRevisionId: "rev_1", currentDigest: "digest_1" },
      coverage: {},
      assignment: { bindingsByTaskId: {}, claimedByTaskId: {} },
      validation: {},
      readiness: "ready",
      readyPlanRevisionId: fixture.revision.revisionId,
      readyPlanRevisionDigest: fixture.revision.digest,
      readySourceManifestId: fixture.manifest.manifestId,
      readyHostCapabilities: fixture.hostCapabilities,
    } as unknown as SchedulerProjection["planning"];
    const synthetic: SchedulerProjection = { ...answered, planning: readyPlanning };
    assert.ok(readyPlanIdentity(synthetic));

    const base = (type: SchedulerEvent["type"], payload: Record<string, unknown>): SchedulerEvent => ({
      eventId: `synth_${type}`,
      runId,
      sequence: answered.lastSequence + 1,
      type,
      occurredAt: clock(),
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: `synth:${type}`,
      payload,
    });
    // Task creation is refused even with a ready plan identity present.
    // (The payload is otherwise fully valid, so disabling the guard lets
    // the creation succeed — the prove-red target.)
    assert.throws(
      () => reduceSchedulerEvent(synthetic, base("plan.created", {
        revision: 1,
        tasks: [{
          id: "T1",
          objective: "Sneak in work.",
          dependencies: [],
          requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "ac1", text: "Done." }],
        }],
      })),
      /Answered runs cannot create tasks/,
    );
    // Dispatch is refused even with a ready plan identity and a bound task.
    const withTask: SchedulerProjection = {
      ...synthetic,
      planRevision: 1,
      tasks: {
        T1: {
          id: "T1",
          objective: "Sneak in work.",
          status: "planned",
          attempts: 0,
          dependencies: [],
          requiredCapabilities: ["code"],
        } as unknown as SchedulerProjection["tasks"][string],
      },
      readyPlanTaskBindings: { T1: { revisionId: "rev_1", digest: "digest_1" } },
    };
    assert.throws(
      () => reduceSchedulerEvent(withTask, {
        ...base("task.transitioned", { taskId: "T1", status: "assigned", attempt: 1 }),
        actor: { role: "runner", id: "build-runtime" },
      }),
      /Answered runs admit no workers/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Repair cycle 1: review-inverted regression tests (real SQLite store with an
// advancing clock, driven through the real pump).
// ---------------------------------------------------------------------------

test("T9 repair B1: a re-recorded answer after a verdict is not ready until re-reviewed", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-rereview-pump-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_rereview_pump";
  const harness = answerReviewHarness(
    "rereview-pump",
    [
      // First review: one blocking finding with an advisory inaccurate verdict.
      answerFindingsTurn([{ id: "f-prior", statement: "The fix steps cite no source.", severity: "blocking" }]),
      answerVerdictTurn("First review: the answer is unsupported.", false),
      // Pump-driven re-review: own view first, then the prior check.
      answerFindingsTurn([{ id: "f-own", statement: "Own view: the revised answer still lacks sources.", severity: "non_blocking" }]),
      answerVerdictTurn("Re-review agrees with reservations.", true, [
        { findingId: "f-prior", resolution: "outstanding", rationale: "Still uncited." },
      ]),
    ],
    { store, clock },
  );
  const reviewCalls: { reviewId: string; answerSequence: number; priorReviewId?: string }[] = [];
  let oneSequence = 0;
  let step = 0;
  const architect: ArchitectRuntimeDriver = {
    run: async (request) => {
      if (request.reason.type === "completion_decision_required") {
        await invokeMustSucceed(request, "complete_run", { summary: "Answered and reviewed." }, "complete");
        return;
      }
      const current = step++;
      if (current === 0) {
        await invokeMustSucceed(request, "record_triage", {
          decision: "answer",
          rationale: "The request is a pure question with no requested change.",
        }, "triage");
        return;
      }
      if (current === 1) {
        const output = await invokeMustSucceed(request, "record_answer", {
          answerText: "Answer ONE.",
          addressedParts: ["Why the build fails"],
        }, "answer-one");
        oneSequence = (outputJson(output) as unknown as { sequence: number }).sequence;
        return;
      }
      if (current === 2) {
        // The verdict for ONE is durable when TWO lands — the defect state.
        const before = projectionOf(store, runId);
        assert.equal(before.answerReviews?.["answer_review_1"]?.answerSequence, oneSequence);
        await invokeMustSucceed(request, "record_answer", {
          answerText: "Answer TWO (revised).",
          addressedParts: ["Why the build fails"],
        }, "answer-two");
        return;
      }
      for (const write of entryPointDocs()) {
        await invokeMustSucceed(request, "write_project_doc", {
          path: write.path,
          content: write.content,
          summary: `Write ${write.path}`,
        }, write.path);
      }
    },
  };
  try {
    seedNewPolicy(store, runId, clock);
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Why does the build fail?",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: architect,
      architectId: "openai:architect",
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      projectDocs: stubProjectDocsPort(),
      answerReview: {
        candidateRuntimeIds: ["google:reviewer", "fallback:reviewer"],
        review: async (input) => {
          reviewCalls.push({
            reviewId: input.reviewId,
            answerSequence: input.answerSequence,
            ...(input.priorReview ? { priorReviewId: input.priorReview.id } : {}),
          });
          return await harness.runtime.review(input);
        },
      },
    });
    assert.equal((await runtime.step()).status, "progressed"); // triage
    assert.equal((await runtime.step()).status, "progressed"); // answer ONE
    store.append({
      runId,
      type: "answer.review_opted_in",
      occurredAt: clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "answer:optin",
      payload: {},
    });
    const reviewed = await runtime.step();
    assert.equal(reviewed.status, "progressed");
    assert.equal(reviewed.action, "answer_review_recorded"); // review_1
    assert.equal(reviewCalls.length, 1);
    const answered = await runtime.step();
    assert.equal(answered.status, "progressed"); // answer TWO lands over the verdict
    // B1: the stale verdict does not satisfy readiness.
    const stale = buildCompletionReadiness(projectionOf(store, runId));
    assert.equal(stale.ready, false);
    assert.ok(
      stale.issues.some((issue) => issue.includes("does not cover the current answer")),
      JSON.stringify(stale.issues),
    );
    const rereviewed = await runtime.step();
    assert.equal(rereviewed.status, "progressed");
    assert.equal(rereviewed.action, "answer_review_recorded"); // review_2
    assert.equal(reviewCalls.length, 2);
    // The pump drove answer_review_2 against TWO with review_1 attached.
    assert.deepEqual(reviewCalls[0], { reviewId: "answer_review_1", answerSequence: oneSequence });
    const twoSequence = projectionOf(store, runId).requestAnswer?.sequence ?? 0;
    assert.notEqual(twoSequence, oneSequence);
    assert.deepEqual(reviewCalls[1], {
      reviewId: "answer_review_2",
      answerSequence: twoSequence,
      priorReviewId: "answer_review_1",
    });
    // OA-10 #2 ordering, kernel-enforced: own findings, then release, then verdict.
    const events = store.readRun(runId);
    const at = (type: string, id: string) => events.findIndex((event) =>
      event.type === type && ((event.payload.reviewId ?? event.payload.id) as string) === id);
    const findingsAt = at("answer.review_findings_recorded", "answer_review_2");
    const releaseAt = at("answer.review_prior_findings_released", "answer_review_2");
    const verdictAt = at("answer.review_recorded", "answer_review_2");
    assert.ok(findingsAt >= 0 && releaseAt > findingsAt && verdictAt > releaseAt);
    // The current verdict binds TWO; the run completes through the handoff.
    const done = projectionOf(store, runId);
    assert.equal(done.answerReviews?.["answer_review_2"]?.answerSequence, twoSequence);
    assert.equal(done.answerReviews?.["answer_review_2"]?.priorReviewId, "answer_review_1");
    const blocked = await runtime.runUntilBlocked(20);
    assert.equal(blocked.status, "paused");
    const selected = runtime.selectProjectHandoff(
      "keep_integration_branch",
      {
        integrationRevision: "no_integration",
        integrationBranch: `aiboard/integration/${runId}`,
        appliedToProject: false,
      },
      "handoff:rereview",
    );
    assert.equal(selected.status, "completed");
    assert.equal(selected.requestAnswer?.answerText, "Answer TWO (revised).");
  } finally {
    harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 repair B2: opt-in at the handoff pause resumes through review to completion", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-optin-handoff-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_optin_handoff";
  const harness = answerReviewHarness(
    "optin-handoff",
    [
      answerFindingsTurn([]),
      answerVerdictTurn("The answer checks out.", true),
    ],
    { store, clock },
  );
  const architect = new AnswerArchitectDriver();
  let reviewCount = 0;
  try {
    seedNewPolicy(store, runId, clock);
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Why does the build fail, and how do I fix it?",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: architect,
      architectId: "openai:architect",
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      projectDocs: stubProjectDocsPort(),
      answerReview: {
        candidateRuntimeIds: ["google:reviewer", "fallback:reviewer"],
        review: async (input) => {
          reviewCount += 1;
          return await harness.runtime.review(input);
        },
      },
    });
    const first = await runtime.runUntilBlocked(20);
    assert.equal(first.status, "paused");
    assert.equal(projectionOf(store, runId).projectHandoff?.status, "requested");
    const turnsBeforeResume = architect.reasons.length;
    // The user reads the answer, then opts in at the handoff pause.
    store.append({
      runId,
      type: "answer.review_opted_in",
      occurredAt: clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "answer:optin",
      payload: {},
    });
    // Selecting now is refused: the opted-in review has not run (readiness gate).
    assert.throws(
      () => runtime.selectProjectHandoff(
        "keep_integration_branch",
        {
          integrationRevision: "no_integration",
          integrationBranch: `aiboard/integration/${runId}`,
          appliedToProject: false,
        },
        "handoff:early",
      ),
      /opted-in answer review/,
    );
    // Resume: the review runs, then the pump waits for the selection WITHOUT
    // a second completion turn — no "no typed action" throw.
    store.append({
      runId,
      type: "run.resumed",
      occurredAt: clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "resumed:1",
      payload: {},
    });
    const afterResume = await runtime.runUntilBlocked(10);
    assert.equal(afterResume.status, "paused");
    assert.equal(afterResume.action, "project_handoff_requested");
    assert.equal(reviewCount, 1);
    assert.equal(architect.reasons.length, turnsBeforeResume);
    const selected = runtime.selectProjectHandoff(
      "keep_integration_branch",
      {
        integrationRevision: "no_integration",
        integrationBranch: `aiboard/integration/${runId}`,
        appliedToProject: false,
      },
      "handoff:late",
    );
    assert.equal(selected.status, "completed");
    assert.ok(selected.answerReviews?.[ANSWER_REVIEW_ID]);
    assert.equal(
      selected.answerReviews?.[ANSWER_REVIEW_ID]?.answerSequence,
      selected.requestAnswer?.sequence,
    );
  } finally {
    harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 repair B2: opt-in at creation is accepted and stays inert on build runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-optin-creation-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_optin_creation";
  const harness = answerReviewHarness(
    "optin-creation",
    [
      answerFindingsTurn([]),
      answerVerdictTurn("The answer checks out.", true),
    ],
    { store, clock },
  );
  const architect = new AnswerArchitectDriver();
  let reviewCount = 0;
  try {
    seedNewPolicy(store, runId, clock);
    // Opt-in at creation, before triage exists: accepted.
    store.append({
      runId,
      type: "answer.review_opted_in",
      occurredAt: clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "answer:optin",
      payload: {},
    });
    assert.ok(projectionOf(store, runId).answerReviewOptIn);
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Why does the build fail, and how do I fix it?",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: architect,
      architectId: "openai:architect",
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      projectDocs: stubProjectDocsPort(),
      answerReview: {
        candidateRuntimeIds: ["google:reviewer", "fallback:reviewer"],
        review: async (input) => {
          reviewCount += 1;
          return await harness.runtime.review(input);
        },
      },
    });
    const blocked = await runtime.runUntilBlocked(20);
    assert.equal(blocked.status, "paused");
    assert.equal(reviewCount, 1);
    const selected = runtime.selectProjectHandoff(
      "keep_integration_branch",
      {
        integrationRevision: "no_integration",
        integrationBranch: `aiboard/integration/${runId}`,
        appliedToProject: false,
      },
      "handoff:creation",
    );
    assert.equal(selected.status, "completed");
    assert.equal(
      selected.answerReviews?.[ANSWER_REVIEW_ID]?.answerSequence,
      selected.requestAnswer?.sequence,
    );
    // The same opt-in on a build run stays inert: readiness never consults it.
    const buildRunId = "run_t9_optin_build_inert";
    seedNewPolicy(store, buildRunId, clock);
    store.append({
      runId: buildRunId,
      type: "answer.review_opted_in",
      occurredAt: clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "answer:optin",
      payload: {},
    });
    seedTriage(store, buildRunId, clock, "build", "triage:build");
    const buildReadiness = buildCompletionReadiness(projectionOf(store, buildRunId));
    assert.ok(
      buildReadiness.issues.every((issue) => !issue.includes("answer review")),
      JSON.stringify(buildReadiness.issues),
    );
  } finally {
    harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 repair B3: user guidance on an answered run is acknowledged and the run proceeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-guidance-answer-"));
  const clock = advancingClock();
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore });
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_guidance_answer";
  const reasons: string[] = [];
  let step = 0;
  const architect: ArchitectRuntimeDriver = {
    run: async (request) => {
      reasons.push(request.reason.type);
      if (request.reason.type === "user_guidance_required") {
        const names = request.tools.definitions().map((tool) => tool.name);
        assert.ok(names.includes("acknowledge_user_guidance"), "the guidance turn offers the acknowledgement");
        // Repair cycle 2 (B3-r2): the answered run has no ready plan, so the
        // acknowledgement needs no evidence — the guidance folds into the
        // answer text. No fabricated evidence is seeded.
        await invokeMustSucceed(request, "acknowledge_user_guidance", {
          guidanceId: "g1",
          expectedVersion: 1,
          resolution: {
            type: "folded_into_planning",
            rationale: "The answered run has no plan; the guidance folds into the answer text.",
          },
        }, "ack");
        return;
      }
      if (request.reason.type === "completion_decision_required") {
        await invokeMustSucceed(request, "complete_run", { summary: "Answered." }, "complete");
        return;
      }
      const current = step++;
      if (current === 0) {
        await invokeMustSucceed(request, "record_triage", {
          decision: "answer",
          rationale: "The request is a pure question with no requested change.",
        }, "triage");
        return;
      }
      if (current === 1) {
        await invokeMustSucceed(request, "record_answer", {
          answerText: "The build fails because the cache key omits the lockfile; add it. Also see caching.",
          addressedParts: ["Why the build fails", "How to fix it"],
        }, "answer");
        return;
      }
      for (const write of entryPointDocs()) {
        await invokeMustSucceed(request, "write_project_doc", {
          path: write.path,
          content: write.content,
          summary: `Write ${write.path}`,
        }, write.path);
      }
    },
  };
  try {
    seedNewPolicy(store, runId, clock);
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Why does the build fail, and how do I fix it?",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: architect,
      architectId: "openai:architect",
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      evidenceStore,
      projectDocs: stubProjectDocsPort(),
    });
    assert.equal((await runtime.step()).status, "progressed"); // triage
    runtime.submitUserGuidance({
      guidanceId: "g1",
      text: "Also mention caching.",
      version: 1,
      idempotencyKey: "g1",
    });
    // A plan-reconciled acknowledgement is refused on answered runs: the
    // zero-mutation guarantee covers guidance acknowledgement too.
    assert.throws(
      () => store.append({
        runId,
        type: "user.guidance_acknowledged",
        occurredAt: clock(),
        actor: { role: "architect", id: "architect_1" },
        idempotencyKey: "guidance:ack:reconciled",
        payload: {
          guidanceId: "g1",
          expectedVersion: 1,
          resolution: {
            type: "plan_reconciled",
            rationale: "Sneak in work through guidance.",
            planReconciliation: {
              revision: 1,
              summary: "Add a task.",
              taskUpdates: [],
              newTasks: [{
                id: "T1",
                objective: "Sneak in work.",
                dependencies: [],
                requiredCapabilities: ["code"],
                acceptanceCriteria: [{ id: "ac1", text: "Done." }],
              }],
            },
          },
        },
      }),
      /Answered runs cannot reconcile the plan/,
    );
    const guided = await runtime.step();
    assert.equal(guided.status, "progressed");
    assert.equal(guided.action, "user_guidance_required");
    assert.deepEqual(reasons, ["plan_required", "user_guidance_required"]);
    assert.equal(projectionOf(store, runId).userGuidance["g1"]?.status, "acknowledged");
    const blocked = await runtime.runUntilBlocked(20);
    assert.equal(blocked.status, "paused");
    const selected = runtime.selectProjectHandoff(
      "keep_integration_branch",
      {
        integrationRevision: "no_integration",
        integrationBranch: `aiboard/integration/${runId}`,
        appliedToProject: false,
      },
      "handoff:guidance",
    );
    assert.equal(selected.status, "completed");
  } finally {
    evidenceStore.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 repair B3: user guidance on a planning-state run routes without planRevision", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-guidance-planning-"));
  const clock = advancingClock();
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore });
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_guidance_planning";
  const reasons: string[] = [];
  let step = 0;
  const architect: ArchitectRuntimeDriver = {
    run: async (request) => {
      reasons.push(request.reason.type);
      if (request.reason.type === "user_guidance_required") {
        // Repair cycle 2 (B3-r2): the run is in planning state with no
        // ready plan, so the acknowledgement needs no evidence — the
        // guidance folds into the plan still being drafted.
        await invokeMustSucceed(request, "acknowledge_user_guidance", {
          guidanceId: "g1",
          expectedVersion: 1,
          resolution: {
            type: "folded_into_planning",
            rationale: "Planning has not started; the guidance is noted for the plan.",
          },
        }, "ack");
        return;
      }
      const current = step++;
      if (current === 0) {
        await invokeMustSucceed(request, "record_triage", {
          decision: "build",
          rationale: "The request asks for a change.",
        }, "triage");
        return;
      }
      // After the acknowledgement the run proceeds: a planning turn that
      // asks the user blocks on the question — no guidance error, no throw.
      await invokeMustSucceed(request, "ask_user", {
        questionId: `q${current}`,
        version: current,
        decisionKind: "requirement_conflict",
        question: "Which scope should the plan cover?",
      }, `ask-${current}`);
    },
  };
  try {
    seedNewPolicy(store, runId, clock);
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Fix the thing.",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: architect,
      architectId: "openai:architect",
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      evidenceStore,
      projectDocs: stubProjectDocsPort(),
    });
    assert.equal((await runtime.step()).status, "progressed"); // triage to build
    assert.equal(projectionOf(store, runId).planRevision, 0);
    runtime.submitUserGuidance({
      guidanceId: "g1",
      text: "Prefer the minimal fix.",
      version: 1,
      idempotencyKey: "g1",
    });
    const guided = await runtime.step();
    assert.equal(guided.status, "progressed");
    assert.equal(guided.action, "user_guidance_required");
    assert.deepEqual(reasons, ["plan_required", "user_guidance_required"]);
    assert.equal(projectionOf(store, runId).userGuidance["g1"]?.status, "acknowledged");
    // The run proceeds past the acknowledgement with no pump error.
    const blocked = await runtime.runUntilBlocked(10);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.action, "architect_question_pending");
    assert.ok(projectionOf(store, runId).blockingArchitectQuestionId);
  } finally {
    evidenceStore.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 repair B3: the acknowledge tool is offered inline on new-policy plan_required turns", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-guidance-inline-"));
  const clock = advancingClock();
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore });
  const runId = "run_t9_guidance_inline";
  try {
    seedNewPolicy(store, runId, clock);
    seedTriage(store, runId, clock, "answer");
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Why?",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: { run: async () => {} },
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
    });
    runtime.submitUserGuidance({
      guidanceId: "g1",
      text: "Also mention caching.",
      version: 1,
      idempotencyKey: "g1",
    });
    // The triage/answer/planning turn offers the acknowledgement inline.
    const tools = createArchitectTools({
      store,
      clock,
      runPolicy: "finish",
      triageTools: true,
      answerPath: true,
      acknowledgeGuidanceAvailable: true,
      evidenceStore,
      architectAction: { reason: { type: "plan_required" }, sequence: 0 },
    });
    const names = tools.map((tool) => tool.definition.name);
    assert.ok(names.includes("acknowledge_user_guidance"));
    const ack = tools.find((tool) => tool.definition.name === "acknowledge_user_guidance")!;
    // Repair cycle 2 (B3-r2): the answered run has no ready plan, so the
    // inline acknowledgement needs no evidence.
    const output = await ack.execute(
      {
        guidanceId: "g1",
        expectedVersion: 1,
        resolution: {
          type: "folded_into_planning",
          rationale: "The answered run has no plan; the guidance folds into the answer text.",
        },
      } as never,
      { runId, sessionId: "session_inline", actor: { role: "architect", id: "architect_1" }, workspacePath: root },
    );
    assert.equal(output.isError, false, JSON.stringify(output.error));
    assert.equal(projectionOf(store, runId).userGuidance["g1"]?.status, "acknowledged");
    // Without pending guidance there is nothing to acknowledge inline.
    const acked = tools.find((tool) => tool.definition.name === "acknowledge_user_guidance")!;
    const refused = await acked.execute(
      {
        guidanceId: "g1",
        expectedVersion: 1,
        resolution: {
          type: "folded_into_planning",
          rationale: "Nothing pending.",
        },
      } as never,
      { runId, sessionId: "session_inline", actor: { role: "architect", id: "architect_1" }, workspacePath: root },
    );
    assert.equal(refused.isError, true);
    assert.equal(refused.error?.code, "wrong_pending_guidance");
    // A legacy run never gets the inline acknowledgement.
    const legacyTools = createArchitectTools({
      store,
      clock,
      runPolicy: "finish",
      acknowledgeGuidanceAvailable: true,
      architectAction: { reason: { type: "plan_required" }, sequence: 0 },
    });
    const legacyRunId = "run_t9_guidance_legacy";
    store.append({
      runId: legacyRunId,
      type: "run.policy_configured",
      occurredAt: clock(),
      actor: { role: "runner", id: "build-runtime" },
      idempotencyKey: "run-policy-configured",
      payload: { runPolicy: "finish" },
    });
    const legacyAck = legacyTools.find((tool) => tool.definition.name === "acknowledge_user_guidance")!;
    const legacyRefused = await legacyAck.execute(
      {
        guidanceId: "g1",
        expectedVersion: 1,
        resolution: {
          type: "no_plan_change",
          rationale: "Legacy must not ack inline.",
          evidenceIds: ["evidence-legacy"],
        },
      } as never,
      { runId: legacyRunId, sessionId: "session_legacy", actor: { role: "architect", id: "architect_1" }, workspacePath: root },
    );
    assert.equal(legacyRefused.isError, true);
    assert.equal(legacyRefused.error?.code, "wrong_architect_action");
  } finally {
    evidenceStore.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Repair cycle 2: B3-r2 (planning-state acknowledgement without evidence)
// and N-A (answer-review findings bound to the answer). Real SQLite store
// with an advancing clock, driven through the real pump; no seeded evidence
// anywhere in the B3-r2 tests.
// ---------------------------------------------------------------------------

test("T9 repair B3-r2: guidance before triage is acknowledged without evidence and triage proceeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-guidance-pretriage-"));
  const clock = advancingClock();
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore });
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_guidance_pretriage";
  const reasons: string[] = [];
  let triaged = false;
  const architect: ArchitectRuntimeDriver = {
    run: async (request) => {
      reasons.push(request.reason.type);
      if (request.reason.type === "user_guidance_required") {
        await invokeMustSucceed(request, "acknowledge_user_guidance", {
          guidanceId: "g1",
          expectedVersion: 1,
          resolution: {
            type: "folded_into_planning",
            rationale: "No triage yet; the guidance folds into the plan still being drafted.",
          },
        }, "ack");
        return;
      }
      if (!triaged) {
        await invokeMustSucceed(request, "record_triage", {
          decision: "build",
          rationale: "The request asks for a change.",
        }, "triage");
        triaged = true;
        return;
      }
      await invokeMustSucceed(request, "ask_user", {
        questionId: "q1",
        version: 1,
        decisionKind: "requirement_conflict",
        question: "Which scope should the plan cover?",
      }, "ask");
    },
  };
  try {
    seedNewPolicy(store, runId, clock);
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Fix the thing.",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: architect,
      architectId: "openai:architect",
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      evidenceStore,
      projectDocs: stubProjectDocsPort(),
    });
    // Guidance lands before any triage: the first pump turn routes to it.
    runtime.submitUserGuidance({
      guidanceId: "g1",
      text: "Prefer the minimal fix.",
      version: 1,
      idempotencyKey: "g1",
    });
    const guided = await runtime.step();
    assert.equal(guided.status, "progressed");
    assert.equal(guided.action, "user_guidance_required");
    assert.equal(projectionOf(store, runId).userGuidance["g1"]?.status, "acknowledged");
    // The run proceeds: the next turn triages.
    const triage = await runtime.step();
    assert.equal(triage.status, "progressed");
    assert.equal(projectionOf(store, runId).planningTriageDecision, "build");
    assert.deepEqual(reasons, ["user_guidance_required", "plan_required"]);
  } finally {
    evidenceStore.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 repair B3-r2: guidance under clarify is acknowledged without evidence and the run proceeds", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-guidance-clarify-"));
  const clock = advancingClock();
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore });
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_guidance_clarify";
  const reasons: string[] = [];
  let triaged = false;
  const architect: ArchitectRuntimeDriver = {
    run: async (request) => {
      reasons.push(request.reason.type);
      if (request.reason.type === "user_guidance_required") {
        await invokeMustSucceed(request, "acknowledge_user_guidance", {
          guidanceId: "g1",
          expectedVersion: 1,
          resolution: {
            type: "folded_into_planning",
            rationale: "Still clarifying; the guidance folds into the pending question.",
          },
        }, "ack");
        return;
      }
      if (!triaged) {
        await invokeMustSucceed(request, "record_triage", {
          decision: "clarify",
          rationale: "The request is unanswerable as stated.",
        }, "triage");
        triaged = true;
        return;
      }
      await invokeMustSucceed(request, "ask_user", {
        questionId: "q1",
        version: 1,
        decisionKind: "requirement_conflict",
        question: "Should this be explained or built?",
      }, "ask");
    },
  };
  try {
    seedNewPolicy(store, runId, clock);
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Do the thing with the stuff.",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: architect,
      architectId: "openai:architect",
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      evidenceStore,
      projectDocs: stubProjectDocsPort(),
    });
    assert.equal((await runtime.step()).status, "progressed"); // triage clarify
    runtime.submitUserGuidance({
      guidanceId: "g1",
      text: "Prefer an explanation.",
      version: 1,
      idempotencyKey: "g1",
    });
    const guided = await runtime.step();
    assert.equal(guided.status, "progressed");
    assert.equal(guided.action, "user_guidance_required");
    assert.equal(projectionOf(store, runId).userGuidance["g1"]?.status, "acknowledged");
    // The run proceeds past the acknowledgement with no pump error: the
    // clarify turn asks the user and blocks on the open question.
    const asking = await runtime.step();
    assert.equal(asking.status, "progressed");
    const blocked = await runtime.step();
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.action, "architect_question_pending");
    assert.equal(projectionOf(store, runId).blockingArchitectQuestionId, "q1");
    assert.deepEqual(reasons, ["plan_required", "user_guidance_required", "plan_required"]);
  } finally {
    evidenceStore.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 repair B3-r2: guidance on a plan_only answered run is acknowledged without evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-guidance-planonly-"));
  const clock = advancingClock();
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore });
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_guidance_planonly";
  const reasons: string[] = [];
  let step = 0;
  const architect: ArchitectRuntimeDriver = {
    run: async (request) => {
      reasons.push(request.reason.type);
      if (request.reason.type === "user_guidance_required") {
        await invokeMustSucceed(request, "acknowledge_user_guidance", {
          guidanceId: "g1",
          expectedVersion: 1,
          resolution: {
            type: "folded_into_planning",
            rationale: "A plan_only answer executes no commands; the guidance folds into the answer.",
          },
        }, "ack");
        return;
      }
      if (request.reason.type === "completion_decision_required") {
        await invokeMustSucceed(request, "complete_run", { summary: "Answered." }, "complete");
        return;
      }
      const current = step++;
      if (current === 0) {
        await invokeMustSucceed(request, "record_triage", {
          decision: "answer",
          rationale: "Pure behavior question; no plan needed.",
        }, "triage");
        return;
      }
      if (current === 1) {
        await invokeMustSucceed(request, "record_answer", {
          answerText: "Cancellation aborts the loop after the in-flight attempt settles.",
          addressedParts: ["Retry behavior under cancellation"],
        }, "answer");
        return;
      }
      // T9 repair cycle 3 (N-C): the fold postdates that answer, so
      // completion requires a new answer recorded after the acknowledgement
      // — one that folds the shutdown note in.
      if (current === 2) {
        await invokeMustSucceed(request, "record_answer", {
          answerText: "Cancellation aborts the loop after the in-flight attempt settles. On shutdown, pending attempts are discarded.",
          addressedParts: ["Retry behavior under cancellation"],
        }, "answer-two");
        return;
      }
      for (const write of entryPointDocs()) {
        await invokeMustSucceed(request, "write_project_doc", {
          path: write.path,
          content: write.content,
          summary: `Write ${write.path}`,
        }, write.path);
      }
    },
  };
  try {
    seedNewPolicy(store, runId, clock, "plan_only");
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "How does the retry loop behave under cancellation?",
      runPolicy: "plan_only",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: architect,
      architectId: "openai:architect",
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      evidenceStore,
      projectDocs: stubProjectDocsPort(),
    });
    assert.equal((await runtime.step()).status, "progressed"); // triage
    assert.equal((await runtime.step()).status, "progressed"); // answer
    // A plan_only answered run executes no commands (EP32), so it can mint
    // no evidence — the acknowledgement still succeeds without any.
    runtime.submitUserGuidance({
      guidanceId: "g1",
      text: "Also mention shutdown.",
      version: 1,
      idempotencyKey: "g1",
    });
    const guided = await runtime.step();
    assert.equal(guided.status, "progressed");
    assert.equal(guided.action, "user_guidance_required");
    assert.equal(projectionOf(store, runId).userGuidance["g1"]?.status, "acknowledged");
    const blocked = await runtime.runUntilBlocked(20);
    assert.equal(blocked.status, "paused");
    const selected = runtime.selectProjectHandoff(
      "keep_integration_branch",
      {
        integrationRevision: "no_integration",
        integrationBranch: `aiboard/integration/${runId}`,
        appliedToProject: false,
      },
      "handoff:planonly-guidance",
    );
    assert.equal(selected.status, "completed");
    // N-C: the completed answer is the post-fold re-answer, not the stale one.
    assert.ok(selected.requestAnswer?.answerText.includes("shutdown"));
  } finally {
    evidenceStore.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 repair B3-r2: folded_into_planning is refused once a ready plan exists (tool path and direct event)", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-guidance-ready-"));
  const clock = advancingClock();
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore });
  const runId = "run_t9_guidance_ready";
  const fixture = scopedFixture();
  const append = (type: NewSchedulerEvent["type"], idempotencyKey: string, actor: NewSchedulerEvent["actor"], payload: Record<string, unknown>) => store.append({
    runId,
    type: type as "request.triaged",
    occurredAt: clock(),
    actor,
    idempotencyKey,
    payload,
  });
  try {
    seedNewPolicy(store, runId, clock);
    // Mint a ready plan through the real planning flow: triage build, then
    // the ledger, reads, checkpoint, draft, coverage, and readiness.
    append("planning.source_registered", "source:base", { role: "user", id: "owner" }, { manifest: fixture.priorManifest });
    append("planning.source_amended", "source:amend-1", { role: "user", id: "owner" }, { manifest: fixture.manifest });
    seedTriage(store, runId, clock, "build", "triage:build");
    append("planning.ledger_persisted", "ledger:1", { role: "architect", id: "architect_1" }, {
      id: "ledger-1",
      requirements: fixture.requirements,
      phases: fixture.phases,
      nonNormativeSections: [],
    });
    for (const section of fixture.manifest.sections) {
      append("planning.source_section_read", `read:${section.id}`, { role: "architect", id: "architect_1" }, {
        manifestId: fixture.manifest.manifestId,
        manifestDigest: fixture.manifest.artifactDigest,
        sectionId: section.id,
        sectionDigest: section.digest,
        readAt: clock(),
      });
    }
    append("planning.checkpoint_recorded", "checkpoint:1", { role: "architect", id: "architect_1" }, {
      checkpoint: {
        id: "checkpoint-1",
        coveredSourceSectionIds: fixture.manifest.sections.map((section) => section.id),
        completedPlanningContractIds: ["requirement-ledger"],
        remainingWork: [],
        nextAction: "Draft the plan.",
        recordedAt: clock(),
      },
    });
    append("planning.plan_drafted", "plan:revision-1", { role: "architect", id: "architect_1" }, {
      revision: fixture.revision,
      expectedRevisionId: null,
      expectedDigest: null,
    });
    append("planning.coverage_review_requested", "coverage-request:1", { role: "architect", id: "architect_1" }, {
      reviewId: fixture.coverageReview.id,
      planRevisionId: fixture.revision.revisionId,
      planRevisionDigest: fixture.revision.digest,
      sourceManifestId: fixture.manifest.manifestId,
      requestedAt: clock(),
    });
    append("planning.coverage_obligations_recorded", "coverage-obligations:1", { role: "verifier", id: "reviewer" }, {
      reviewId: fixture.coverageReview.id,
      sourceManifestId: fixture.manifest.manifestId,
      sourceManifestDigest: fixture.manifest.artifactDigest,
      obligations: structuredClone(fixture.coverageReview.derivedObligations),
      sectionCoverage: fixture.manifest.sections.map((section) => ({
        sectionId: section.id,
        obligationIds: fixture.coverageReview.derivedObligations.map((obligation) => obligation.id),
      })),
      recordedAt: clock(),
    });
    append("planning.coverage_plan_delivered", "coverage-plan-delivered:1", { role: "runner", id: "runner" }, {
      reviewId: fixture.coverageReview.id,
      planRevisionId: fixture.revision.revisionId,
      planRevisionDigest: fixture.revision.digest,
      sourceManifestId: fixture.manifest.manifestId,
      deliveredAt: clock(),
    });
    append("planning.coverage_review_recorded", "coverage:1", { role: "verifier", id: "reviewer" }, {
      review: fixture.coverageReview,
    });
    append("planning.plan_ready", "ready:1", { role: "runner", id: "runner" }, {
      hostCapabilities: fixture.hostCapabilities,
    });
    assert.ok(readyPlanIdentity(projectionOf(store, runId)), "the fixture run has a ready plan");
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Fix the thing.",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: { run: async () => {} },
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
    });
    runtime.submitUserGuidance({
      guidanceId: "g1",
      text: "Prefer the minimal fix.",
      version: 1,
      idempotencyKey: "g1",
    });
    // Direct event: the kernel refuses the evidence-free resolution now that
    // a ready plan exists.
    assert.throws(
      () => store.append({
        runId,
        type: "user.guidance_acknowledged",
        occurredAt: clock(),
        actor: { role: "architect", id: "architect_1" },
        idempotencyKey: "guidance:ack:folded",
        payload: {
          guidanceId: "g1",
          expectedVersion: 1,
          resolution: {
            type: "folded_into_planning",
            rationale: "Too late: the plan is ready.",
          },
        },
      }),
      /requires no ready plan/,
    );
    // Tool path: the same refusal surfaces as a mechanical rejection.
    const tools = createArchitectTools({
      store,
      clock,
      runPolicy: "finish",
      triageTools: true,
      acknowledgeGuidanceAvailable: true,
      evidenceStore,
      architectAction: { reason: { type: "user_guidance_required", guidanceId: "g1", version: 1 }, sequence: 0 },
    });
    const ack = tools.find((tool) => tool.definition.name === "acknowledge_user_guidance")!;
    const refused = await ack.execute(
      {
        guidanceId: "g1",
        expectedVersion: 1,
        resolution: {
          type: "folded_into_planning",
          rationale: "Too late: the plan is ready.",
        },
      } as never,
      { runId, sessionId: "session_ready", actor: { role: "architect", id: "architect_1" }, workspacePath: root },
    );
    assert.equal(refused.isError, true);
    assert.equal(refused.error?.code, "mechanical_transition_rejected");
    assert.match(refused.error?.message ?? "", /requires no ready plan/);
    assert.equal(projectionOf(store, runId).userGuidance["g1"]?.status, "submitted");
    // The existing rules apply unchanged: no_plan_change still demands
    // current-run evidence (an unknown id fails the evidence check, not the
    // readiness gate).
    const noEvidence = await ack.execute(
      {
        guidanceId: "g1",
        expectedVersion: 1,
        resolution: {
          type: "no_plan_change",
          rationale: "Cites nothing durable.",
          evidenceIds: ["evidence_unknown"],
        },
      } as never,
      { runId, sessionId: "session_ready", actor: { role: "architect", id: "architect_1" }, workspacePath: root },
    );
    assert.equal(noEvidence.isError, true);
    assert.equal(noEvidence.error?.code, "invalid_guidance_evidence");
  } finally {
    evidenceStore.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 repair N-A: a verdict whose answerSequence is not the current answer is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-review-binding-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const runId = "run_t9_review_binding";
  try {
    seedNewPolicy(store, runId, clock);
    seedTriage(store, runId, clock, "answer");
    const answer = seedAnswer(store, runId, clock);
    store.append({
      runId,
      type: "answer.review_opted_in",
      occurredAt: clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "answer:optin",
      payload: {},
    });
    store.append({
      runId,
      type: "answer.review_findings_recorded",
      occurredAt: clock(),
      actor: { role: "verifier", id: "google:reviewer" },
      idempotencyKey: "answer:findings:answer_review_1",
      payload: { reviewId: "answer_review_1", findings: [] },
    });
    // The findings are bound to the answer the reviewer saw.
    assert.equal(
      projectionOf(store, runId).answerReviewFindings?.["answer_review_1"]?.answerSequence,
      answer.sequence,
    );
    // A verdict stamped with another answer's sequence is refused, even
    // though its findings match the durable record.
    assert.throws(
      () => store.append({
        runId,
        type: "answer.review_recorded",
        occurredAt: clock(),
        actor: { role: "verifier", id: "google:reviewer" },
        idempotencyKey: "answer:verdict:answer_review_1",
        payload: {
          id: "answer_review_1",
          reviewerRuntimeId: "google:reviewer",
          independence: "distinct_model",
          answerSequence: answer.sequence + 999,
          findings: [],
          summary: "Stale verdict.",
          answerAccurate: true,
        },
      }),
      /not the current answer/,
    );
    // The exact control: a verdict bound to the current answer is accepted.
    const recorded = store.append({
      runId,
      type: "answer.review_recorded",
      occurredAt: clock(),
      actor: { role: "verifier", id: "google:reviewer" },
      idempotencyKey: "answer:verdict:answer_review_1:retry",
      payload: {
        id: "answer_review_1",
        reviewerRuntimeId: "google:reviewer",
        independence: "distinct_model",
        answerSequence: answer.sequence,
        findings: [],
        summary: "Current verdict.",
        answerAccurate: true,
      },
    });
    assert.equal(recorded.type, "answer.review_recorded");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 repair N-A: findings formed on a superseded answer cannot back a verdict; the pump re-reviews fresh", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-review-stale-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_review_stale";
  const harness = answerReviewHarness(
    "review-stale",
    [
      answerFindingsTurn([{ id: "f-fresh", statement: "Own view: the revised answer cites the lockfile.", severity: "non_blocking" }]),
      answerVerdictTurn("Re-review: the revised answer is supported.", true),
    ],
    { store, clock },
  );
  const reviewCalls: { reviewId: string; answerSequence: number }[] = [];
  let step = 0;
  const architect: ArchitectRuntimeDriver = {
    run: async (request) => {
      if (request.reason.type === "completion_decision_required") {
        await invokeMustSucceed(request, "complete_run", { summary: "Answered and reviewed." }, "complete");
        return;
      }
      const current = step++;
      if (current === 0) {
        await invokeMustSucceed(request, "record_triage", {
          decision: "answer",
          rationale: "The request is a pure question with no requested change.",
        }, "triage");
        return;
      }
      await invokeMustSucceed(request, "record_answer", {
        answerText: "Answer ONE: the cache is stale.",
        addressedParts: ["Why the build fails"],
      }, "answer-one");
    },
  };
  try {
    seedNewPolicy(store, runId, clock);
    store.append({
      runId,
      type: "answer.review_opted_in",
      occurredAt: clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "answer:optin",
      payload: {},
    });
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Why does the build fail?",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: architect,
      architectId: "openai:architect",
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      projectDocs: stubProjectDocsPort(),
      answerReview: {
        candidateRuntimeIds: ["google:reviewer", "fallback:reviewer"],
        review: async (input) => {
          reviewCalls.push({ reviewId: input.reviewId, answerSequence: input.answerSequence });
          return await harness.runtime.review(input);
        },
      },
    });
    assert.equal((await runtime.step()).status, "progressed"); // triage
    assert.equal((await runtime.step()).status, "progressed"); // answer ONE
    const oneSequence = projectionOf(store, runId).requestAnswer?.sequence ?? 0;
    // The findings pass records its own view of ONE (as the review runtime
    // would), then the answer is revised before any verdict.
    harness.authority.recordFindings({
      runId,
      reviewId: "answer_review_1",
      findings: [{ id: "f-stale", statement: "Answer ONE blames a stale cache without evidence.", severity: "blocking" }],
      actor: { role: "verifier", id: "google:reviewer" },
      occurredAt: clock(),
    });
    assert.equal(
      projectionOf(store, runId).answerReviewFindings?.["answer_review_1"]?.answerSequence,
      oneSequence,
    );
    store.append({
      runId,
      type: "request.answered",
      occurredAt: clock(),
      actor: { role: "architect", id: "architect_1" },
      idempotencyKey: "answer:two",
      payload: {
        answerText: "Answer TWO: the cache key omits the lockfile.",
        addressedParts: ["Why the build fails"],
      },
    });
    const twoSequence = projectionOf(store, runId).requestAnswer?.sequence ?? 0;
    assert.notEqual(twoSequence, oneSequence);
    // The stale findings keep their id only while they describe the current
    // answer: the next review id skips answer_review_1.
    assert.equal(nextAnswerReviewId(projectionOf(store, runId)), "answer_review_2");
    // A verdict that reuses the superseded findings for the new answer is
    // refused even though its findings match the durable record.
    assert.throws(
      () => harness.authority.submitVerdict({
        runId,
        id: "answer_review_1",
        reviewerRuntimeId: "google:reviewer",
        independence: "distinct_model",
        answerSequence: twoSequence,
        findings: [{ id: "f-stale", statement: "Answer ONE blames a stale cache without evidence.", severity: "blocking" }],
        summary: "Stale verdict for the new answer.",
        answerAccurate: true,
        actor: { role: "verifier", id: "google:reviewer" },
        occurredAt: clock(),
      }),
      /superseded answer/,
    );
    // The pump re-reviews fresh: new id, own findings formed on TWO, and a
    // verdict bound to TWO.
    const rereviewed = await runtime.step();
    assert.equal(rereviewed.status, "progressed");
    assert.equal(rereviewed.action, "answer_review_recorded");
    assert.deepEqual(reviewCalls, [{ reviewId: "answer_review_2", answerSequence: twoSequence }]);
    const done = projectionOf(store, runId);
    assert.equal(done.answerReviews?.["answer_review_2"]?.answerSequence, twoSequence);
    assert.equal(done.answerReviewFindings?.["answer_review_2"]?.answerSequence, twoSequence);
    assert.equal(done.answerReviews?.["answer_review_1"], undefined);
  } finally {
    harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 repair N1: clarify without a user reply is refused; a reply unlocks re-clarify", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-clarify-bound-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_clarify_bound";
  let step = 0;
  const architect: ArchitectRuntimeDriver = {
    run: async (request) => {
      const current = step++;
      if (current === 0) {
        await invokeMustSucceed(request, "record_triage", {
          decision: "clarify",
          rationale: "The request is unanswerable as stated.",
        }, "triage-1");
        return;
      }
      if (current === 1) {
        // Re-triaging clarify without a user reply is refused — so the
        // turn asks the user instead, as a clarify triage must.
        const refused = await invoke(request, "record_triage", {
          decision: "clarify",
          rationale: "Still unclear, no question asked.",
        }, "triage-again");
        assert.equal(refused.isError, true);
        assert.equal(refused.error?.code, "clarify_without_question");
        await invokeMustSucceed(request, "ask_user", {
          questionId: "q1",
          version: 1,
          decisionKind: "requirement_conflict",
          question: "Should this be explained or built?",
        }, "ask-1");
        return;
      }
      if (current === 2) {
        // The user replied after the last triage: re-clarify is accepted.
        await invokeMustSucceed(request, "record_triage", {
          decision: "clarify",
          rationale: "The reply needs a follow-up.",
        }, "triage-2");
        return;
      }
      await invokeMustSucceed(request, "ask_user", {
        questionId: "q2",
        version: 2,
        decisionKind: "requirement_conflict",
        question: "Which part should I cover first?",
      }, "ask-2");
    },
  };
  try {
    seedNewPolicy(store, runId, clock);
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Do the thing with the stuff.",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: architect,
      architectId: "openai:architect",
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      projectDocs: stubProjectDocsPort(),
    });
    assert.equal((await runtime.step()).status, "progressed"); // clarify
    const asking = await runtime.step();
    assert.equal(asking.status, "progressed"); // refused re-clarify, asked q1
    const blocked = await runtime.step();
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.action, "architect_question_pending");
    runtime.answerArchitectQuestion({
      questionId: "q1",
      expectedVersion: 1,
      answer: "Explain only.",
      idempotencyKey: "ans:q1",
    });
    const resumed = await runtime.runUntilBlocked(10);
    assert.equal(resumed.status, "blocked");
    assert.equal(resumed.action, "architect_question_pending");
    const after = projectionOf(store, runId);
    assert.equal(
      store.readRun(runId).filter((event) => event.type === "request.triaged").length,
      2,
    );
    assert.equal(after.planningTriageDecision, "clarify");
    assert.equal(after.architectQuestions["q1"]?.resumeStatus, "consumed");
    assert.equal(after.blockingArchitectQuestionId, "q2");
    // The kernel refuses the same re-triage on the direct path too.
    const directRunId = "run_t9_clarify_direct";
    seedNewPolicy(store, directRunId, clock);
    seedTriage(store, directRunId, clock, "clarify", "triage:clarify");
    assert.throws(
      () => store.append({
        runId: directRunId,
        type: "request.triaged",
        occurredAt: clock(),
        actor: { role: "architect", id: "architect_1" },
        idempotencyKey: "triage:clarify-again",
        payload: { decision: "clarify", rationale: "No question asked." },
      }),
      /must ask the user/,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 repair N2: the owner can withdraw the answer-review opt-in", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-optout-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_optout";
  const architect = new AnswerArchitectDriver();
  try {
    seedNewPolicy(store, runId, clock);
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Why does the build fail, and how do I fix it?",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: architect,
      architectId: "openai:architect",
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      projectDocs: stubProjectDocsPort(),
      // No answer-review driver: the unavailable reviewer pauses with an
      // owner-visible reason instead of stalling silently.
    });
    assert.equal((await runtime.step()).status, "progressed"); // triage
    assert.equal((await runtime.step()).status, "progressed"); // answer
    store.append({
      runId,
      type: "answer.review_opted_in",
      occurredAt: clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "answer:optin",
      payload: {},
    });
    const gated = await runtime.step();
    assert.equal(gated.status, "paused");
    assert.equal(gated.action, "answer_reviewer_unavailable");
    assert.equal(
      projectionOf(store, runId).answerReviewUnavailable?.reason,
      "no_answer_review_driver",
    );
    assert.ok(
      buildCompletionReadiness(projectionOf(store, runId)).issues.some((issue) =>
        issue.includes("Answer review is unavailable: no_answer_review_driver")),
    );
    // The owner withdraws the opt-in: the gate clears with it.
    store.append({
      runId,
      type: "answer.review_opted_out",
      occurredAt: clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "answer:optout",
      payload: {},
    });
    assert.equal(projectionOf(store, runId).answerReviewOptIn, undefined);
    assert.equal(projectionOf(store, runId).answerReviewUnavailable, undefined);
    // Withdrawing twice is refused; opting back in starts clean.
    assert.throws(
      () => store.append({
        runId,
        type: "answer.review_opted_out",
        occurredAt: clock(),
        actor: { role: "user", id: "local-user" },
        idempotencyKey: "answer:optout-again",
        payload: {},
      }),
      /not opted in/,
    );
    store.append({
      runId,
      type: "answer.review_opted_in",
      occurredAt: clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "answer:optin-again",
      payload: {},
    });
    assert.ok(projectionOf(store, runId).answerReviewOptIn);
    assert.equal(projectionOf(store, runId).answerReviewUnavailable, undefined);
    store.append({
      runId,
      type: "answer.review_opted_out",
      occurredAt: clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "answer:optout-final",
      payload: {},
    });
    // Resume: the run completes with no review and no verdict.
    store.append({
      runId,
      type: "run.resumed",
      occurredAt: clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "resumed:1",
      payload: {},
    });
    const blocked = await runtime.runUntilBlocked(20);
    assert.equal(blocked.status, "paused");
    const selected = runtime.selectProjectHandoff(
      "keep_integration_branch",
      {
        integrationRevision: "no_integration",
        integrationBranch: `aiboard/integration/${runId}`,
        appliedToProject: false,
      },
      "handoff:optout",
    );
    assert.equal(selected.status, "completed");
    assert.equal(selected.answerReviews, undefined);
    assert.ok(
      store.readRun(runId).every((event) => event.type !== "answer.review_recorded"),
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 repair B4-r3: folded guidance after a passing review cannot ready until a post-fold planning turn and review", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-folded-swallow-"));
  const clock = advancingClock();
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore });
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_folded_swallow";
  const fixture = scopedFixture();
  const reasons: string[] = [];
  const coverageInputs: { reviewId: string; guidance: { id: string; text: string }[] }[] = [];
  const append = (type: NewSchedulerEvent["type"], idempotencyKey: string, actor: NewSchedulerEvent["actor"], payload: Record<string, unknown>) => store.append({
    runId,
    type: type as "request.triaged",
    occurredAt: clock(),
    actor,
    idempotencyKey,
    payload,
  });
  // A fresh passing review for one revision through the real kernel (the
  // stub coverage driver below reuses this for the post-fold review).
  const recordFreshPassingReview = (reviewId: string, revisionId: string, digest: string, keyPrefix: string) => {
    append("planning.coverage_obligations_recorded", `${keyPrefix}:obligations`, { role: "verifier", id: "reviewer" }, {
      reviewId,
      sourceManifestId: fixture.manifest.manifestId,
      sourceManifestDigest: fixture.manifest.artifactDigest,
      obligations: structuredClone(fixture.coverageReview.derivedObligations),
      sectionCoverage: fixture.manifest.sections.map((section) => ({
        sectionId: section.id,
        obligationIds: fixture.coverageReview.derivedObligations.map((obligation) => obligation.id),
      })),
      recordedAt: clock(),
    });
    append("planning.coverage_plan_delivered", `${keyPrefix}:delivered`, { role: "runner", id: "runner" }, {
      reviewId,
      planRevisionId: revisionId,
      planRevisionDigest: digest,
      sourceManifestId: fixture.manifest.manifestId,
      deliveredAt: clock(),
    });
    append("planning.coverage_review_recorded", `${keyPrefix}:recorded`, { role: "verifier", id: "reviewer" }, {
      review: {
        ...structuredClone(fixture.coverageReview),
        id: reviewId,
        planRevisionId: revisionId,
        planRevisionDigest: digest,
      },
    });
  };
  const architect: ArchitectRuntimeDriver = {
    run: async (request) => {
      reasons.push(request.reason.type);
      if (request.reason.type === "user_guidance_required") {
        await invokeMustSucceed(request, "acknowledge_user_guidance", {
          guidanceId: "g1",
          expectedVersion: 1,
          resolution: {
            type: "folded_into_planning",
            rationale: "No ready plan yet; the audit-log scope folds into the plan being readied.",
          },
        }, "ack");
        return;
      }
      if (request.reason.type === "plan_required") {
        // The Architect planning turn after the fold: revise the plan through
        // the real tool, with the folded guidance in context.
        const next = structuredClone(fixture.revision) as unknown as Record<string, unknown>;
        next.revisionId = "revision_2";
        delete next.digest;
        await invokeMustSucceed(request, "revise_planning_plan", {
          revision: next,
          expectedRevisionId: fixture.revision.revisionId,
          expectedDigest: fixture.revision.digest,
        }, "revise");
        return;
      }
      throw new Error(`unexpected architect reason ${request.reason.type}`);
    },
  };
  const coverageDriver = {
    candidateRuntimeIds: ["google:reviewer"],
    review: async (input: {
      reviewId: string;
      planRevision: { revisionId: string; digest: string };
      guidance: { id: string; text: string }[];
    }) => {
      coverageInputs.push({
        reviewId: input.reviewId,
        guidance: input.guidance.map((item) => ({ ...item })),
      });
      recordFreshPassingReview(input.reviewId, input.planRevision.revisionId, input.planRevision.digest, `cov:${input.reviewId}`);
      return { status: "reviewed", reviewId: input.reviewId } as never;
    },
  };
  try {
    seedNewPolicy(store, runId, clock);
    append("planning.source_registered", "source:base", { role: "user", id: "owner" }, { manifest: fixture.priorManifest });
    append("planning.source_amended", "source:amend-1", { role: "user", id: "owner" }, { manifest: fixture.manifest });
    seedTriage(store, runId, clock, "build", "triage:build");
    append("planning.ledger_persisted", "ledger:1", { role: "architect", id: "architect_1" }, {
      id: "ledger-1",
      requirements: fixture.requirements,
      phases: fixture.phases,
      nonNormativeSections: [],
    });
    for (const section of fixture.manifest.sections) {
      append("planning.source_section_read", `read:${section.id}`, { role: "architect", id: "architect_1" }, {
        manifestId: fixture.manifest.manifestId,
        manifestDigest: fixture.manifest.artifactDigest,
        sectionId: section.id,
        sectionDigest: section.digest,
        readAt: clock(),
      });
    }
    append("planning.checkpoint_recorded", "checkpoint:1", { role: "architect", id: "architect_1" }, {
      checkpoint: {
        id: "checkpoint-1",
        coveredSourceSectionIds: fixture.manifest.sections.map((section) => section.id),
        completedPlanningContractIds: ["requirement-ledger"],
        remainingWork: [],
        nextAction: "Draft the plan.",
        recordedAt: clock(),
      },
    });
    append("planning.plan_drafted", "plan:revision-1", { role: "architect", id: "architect_1" }, {
      revision: fixture.revision,
      expectedRevisionId: null,
      expectedDigest: null,
    });
    append("planning.coverage_review_requested", "coverage-request:1", { role: "architect", id: "architect_1" }, {
      reviewId: fixture.coverageReview.id,
      planRevisionId: fixture.revision.revisionId,
      planRevisionDigest: fixture.revision.digest,
      sourceManifestId: fixture.manifest.manifestId,
      requestedAt: clock(),
    });
    recordFreshPassingReview(fixture.coverageReview.id, fixture.revision.revisionId, fixture.revision.digest, "coverage:1");
    assert.equal(readyPlanIdentity(projectionOf(store, runId)), undefined, "reviewed but not ready yet");
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Fix the thing.",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: architect,
      architectId: "openai:architect",
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      evidenceStore,
      projectDocs: stubProjectDocsPort(),
      planningHostCapabilities: () => fixture.hostCapabilities,
      coverageReview: coverageDriver as never,
    });
    runtime.submitUserGuidance({
      guidanceId: "g1",
      text: "Also add an audit log entry for every login (new scope).",
      version: 1,
      idempotencyKey: "g1",
    });
    const acked = await runtime.step();
    assert.equal(acked.status, "progressed");
    const folded = projectionOf(store, runId).latestFoldedIntoPlanningAck;
    assert.ok(folded, "the fold is durably recorded");
    assert.equal(folded.guidanceId, "g1");
    // Kernel (a): plan_ready on the pre-fold review is refused even though
    // the review passes and nothing else changed.
    assert.throws(
      () => store.append({
        runId,
        type: "planning.plan_ready",
        occurredAt: clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: "ready:stale",
        payload: { hostCapabilities: fixture.hostCapabilities },
      }),
      /was requested before/,
    );
    // The R1 swallow state, pinned: the passing bound review and every
    // planning turn predate the fold, while the acknowledged guidance text
    // is visible in the Architect's planning status.
    const staleStatus = JSON.parse(renderPlanningStatus(projectionOf(store, runId))) as {
      acknowledgedGuidance: { id: string; text: string }[];
      boundReviewRequestedAfterFold: boolean | null;
      planningTurnRecordedAfterFold: boolean | null;
    };
    assert.ok(staleStatus.acknowledgedGuidance.some((entry) => entry.id === "g1" && entry.text.includes("audit log")));
    assert.equal(staleStatus.boundReviewRequestedAfterFold, false);
    assert.equal(staleStatus.planningTurnRecordedAfterFold, false);
    // Kernel (b) in isolation: a full review requested AND recorded after the
    // fold still does not satisfy readiness without an Architect planning
    // turn after the fold.
    append("planning.coverage_review_requested", "coverage-request:probe", { role: "architect", id: "architect_1" }, {
      reviewId: "coverage_probe",
      planRevisionId: fixture.revision.revisionId,
      planRevisionDigest: fixture.revision.digest,
      sourceManifestId: fixture.manifest.manifestId,
      requestedAt: clock(),
    });
    recordFreshPassingReview("coverage_probe", fixture.revision.revisionId, fixture.revision.digest, "coverage:probe");
    assert.throws(
      () => store.append({
        runId,
        type: "planning.plan_ready",
        occurredAt: clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: "ready:no-turn",
        payload: { hostCapabilities: fixture.hostCapabilities },
      }),
      /no Architect planning turn/,
    );
    // Pump: the post-fold bound review still goes back to the Architect
    // instead of making the plan ready — the pump attempts readiness, the
    // kernel refuses (b), and the visible gate records it. The turn then
    // revises the plan.
    const held = await runtime.step();
    assert.equal(held.status, "progressed");
    assert.equal(held.action, "plan_required");
    assert.deepEqual(reasons, ["user_guidance_required", "plan_required"]);
    assert.equal(projectionOf(store, runId).planning?.plan?.currentRevisionId, "revision_2");
    assert.equal(projectionOf(store, runId).planning?.coverageUnavailable?.reason, "plan_ready_blocked");
    assert.match(projectionOf(store, runId).planning?.coverageUnavailable?.detail ?? "", /no Architect planning turn/);
    // A new coverage review requested after the fold sees the guidance.
    const rev2 = projectionOf(store, runId).planning!.plan!;
    append("planning.coverage_review_requested", "coverage-request:2", { role: "architect", id: "architect_1" }, {
      reviewId: "coverage_2",
      planRevisionId: rev2.currentRevisionId,
      planRevisionDigest: rev2.currentDigest,
      sourceManifestId: fixture.manifest.manifestId,
      requestedAt: clock(),
    });
    const reviewed = await runtime.step();
    assert.equal(reviewed.status, "progressed");
    assert.equal(reviewed.action, "coverage_review_recorded");
    assert.equal(coverageInputs.length, 1);
    assert.equal(coverageInputs[0]!.reviewId, "coverage_2");
    assert.ok(coverageInputs[0]!.guidance.some((entry) => entry.text.includes("audit log")), JSON.stringify(coverageInputs[0]!.guidance));
    const ready = await runtime.step();
    assert.equal(ready.status, "progressed");
    assert.equal(ready.action, "plan_ready");
    assert.equal(readyPlanIdentity(projectionOf(store, runId))?.revisionId, "revision_2");
    assert.equal(coverageInputs.length, 1, "no second review was needed");
    const doneStatus = JSON.parse(renderPlanningStatus(projectionOf(store, runId))) as {
      boundReviewRequestedAfterFold: boolean | null;
      planningTurnRecordedAfterFold: boolean | null;
    };
    assert.equal(doneStatus.boundReviewRequestedAfterFold, true);
    assert.equal(doneStatus.planningTurnRecordedAfterFold, true);
  } finally {
    evidenceStore.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 repair B4-r3: the folded rule covers the re-planning window after a ready plan drops to not-ready", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-folded-replan-"));
  const clock = advancingClock();
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore });
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_folded_replan";
  const fixture = scopedFixture();
  const reasons: string[] = [];
  const coverageInputs: { reviewId: string; guidance: { id: string; text: string }[] }[] = [];
  const append = (type: NewSchedulerEvent["type"], idempotencyKey: string, actor: NewSchedulerEvent["actor"], payload: Record<string, unknown>) => store.append({
    runId,
    type: type as "request.triaged",
    occurredAt: clock(),
    actor,
    idempotencyKey,
    payload,
  });
  const recordFreshPassingReview = (reviewId: string, revisionId: string, digest: string, keyPrefix: string) => {
    append("planning.coverage_obligations_recorded", `${keyPrefix}:obligations`, { role: "verifier", id: "reviewer" }, {
      reviewId,
      sourceManifestId: fixture.manifest.manifestId,
      sourceManifestDigest: fixture.manifest.artifactDigest,
      obligations: structuredClone(fixture.coverageReview.derivedObligations),
      sectionCoverage: fixture.manifest.sections.map((section) => ({
        sectionId: section.id,
        obligationIds: fixture.coverageReview.derivedObligations.map((obligation) => obligation.id),
      })),
      recordedAt: clock(),
    });
    append("planning.coverage_plan_delivered", `${keyPrefix}:delivered`, { role: "runner", id: "runner" }, {
      reviewId,
      planRevisionId: revisionId,
      planRevisionDigest: digest,
      sourceManifestId: fixture.manifest.manifestId,
      deliveredAt: clock(),
    });
    append("planning.coverage_review_recorded", `${keyPrefix}:recorded`, { role: "verifier", id: "reviewer" }, {
      review: {
        ...structuredClone(fixture.coverageReview),
        id: reviewId,
        planRevisionId: revisionId,
        planRevisionDigest: digest,
      },
    });
  };
  let planTurns = 0;
  const architect: ArchitectRuntimeDriver = {
    run: async (request) => {
      reasons.push(request.reason.type);
      if (request.reason.type === "user_guidance_required") {
        await invokeMustSucceed(request, "acknowledge_user_guidance", {
          guidanceId: "g2",
          expectedVersion: 1,
          resolution: {
            type: "folded_into_planning",
            rationale: "The re-planning window has no ready plan; the scope folds into the next revision.",
          },
        }, "ack");
        return;
      }
      if (request.reason.type === "plan_required") {
        const turn = planTurns++;
        if (turn === 0) {
          // First planning turn after the fold: an explicit checkpoint
          // reviewed against the folded guidance (the plan is unchanged).
          await invokeMustSucceed(request, "record_planning_checkpoint", {
            checkpoint: {
              id: "checkpoint-2",
              coveredSourceSectionIds: fixture.manifest.sections.map((section) => section.id),
              completedPlanningContractIds: ["requirement-ledger"],
              remainingWork: [],
              nextAction: "Revise the plan against the folded audit-log guidance, then request a new coverage review.",
              recordedAt: clock(),
            },
          }, "checkpoint");
          return;
        }
        if (turn === 1) {
          // The checkpoint alone cannot unbind the stale review, so the
          // second turn revises the plan through the real tool.
          const next = structuredClone(fixture.revision) as unknown as Record<string, unknown>;
          next.revisionId = "revision_2";
          delete next.digest;
          await invokeMustSucceed(request, "revise_planning_plan", {
            revision: next,
            expectedRevisionId: fixture.revision.revisionId,
            expectedDigest: fixture.revision.digest,
          }, "revise");
          return;
        }
      }
      throw new Error(`unexpected architect turn ${request.reason.type}#${planTurns}`);
    },
  };
  const coverageDriver = {
    candidateRuntimeIds: ["google:reviewer"],
    review: async (input: {
      reviewId: string;
      planRevision: { revisionId: string; digest: string };
      guidance: { id: string; text: string }[];
    }) => {
      coverageInputs.push({
        reviewId: input.reviewId,
        guidance: input.guidance.map((item) => ({ ...item })),
      });
      recordFreshPassingReview(input.reviewId, input.planRevision.revisionId, input.planRevision.digest, `w:${input.reviewId}`);
      return { status: "reviewed", reviewId: input.reviewId } as never;
    },
  };
  try {
    seedNewPolicy(store, runId, clock);
    append("planning.source_registered", "source:base", { role: "user", id: "owner" }, { manifest: fixture.priorManifest });
    append("planning.source_amended", "source:amend-1", { role: "user", id: "owner" }, { manifest: fixture.manifest });
    seedTriage(store, runId, clock, "build", "triage:build");
    append("planning.ledger_persisted", "ledger:1", { role: "architect", id: "architect_1" }, {
      id: "ledger-1",
      requirements: fixture.requirements,
      phases: fixture.phases,
      nonNormativeSections: [],
    });
    for (const section of fixture.manifest.sections) {
      append("planning.source_section_read", `read:${section.id}`, { role: "architect", id: "architect_1" }, {
        manifestId: fixture.manifest.manifestId,
        manifestDigest: fixture.manifest.artifactDigest,
        sectionId: section.id,
        sectionDigest: section.digest,
        readAt: clock(),
      });
    }
    append("planning.checkpoint_recorded", "checkpoint:1", { role: "architect", id: "architect_1" }, {
      checkpoint: {
        id: "checkpoint-1",
        coveredSourceSectionIds: fixture.manifest.sections.map((section) => section.id),
        completedPlanningContractIds: ["requirement-ledger"],
        remainingWork: [],
        nextAction: "Draft the plan.",
        recordedAt: clock(),
      },
    });
    append("planning.plan_drafted", "plan:revision-1", { role: "architect", id: "architect_1" }, {
      revision: fixture.revision,
      expectedRevisionId: null,
      expectedDigest: null,
    });
    append("planning.coverage_review_requested", "coverage-request:1", { role: "architect", id: "architect_1" }, {
      reviewId: fixture.coverageReview.id,
      planRevisionId: fixture.revision.revisionId,
      planRevisionDigest: fixture.revision.digest,
      sourceManifestId: fixture.manifest.manifestId,
      requestedAt: clock(),
    });
    recordFreshPassingReview(fixture.coverageReview.id, fixture.revision.revisionId, fixture.revision.digest, "coverage:1");
    // Ready the plan first: no fold exists yet, so the kernel allows it.
    append("planning.plan_ready", "ready:1", { role: "runner", id: "runner" }, {
      hostCapabilities: fixture.hostCapabilities,
    });
    assert.ok(readyPlanIdentity(projectionOf(store, runId)), "the run starts from a ready plan");
    // A new coverage verdict drops readiness back to not-ready: the
    // re-planning window opens with the fresh review bound.
    append("planning.coverage_review_requested", "coverage-request:2", { role: "architect", id: "architect_1" }, {
      reviewId: "coverage_2",
      planRevisionId: fixture.revision.revisionId,
      planRevisionDigest: fixture.revision.digest,
      sourceManifestId: fixture.manifest.manifestId,
      requestedAt: clock(),
    });
    recordFreshPassingReview("coverage_2", fixture.revision.revisionId, fixture.revision.digest, "coverage:2");
    assert.equal(readyPlanIdentity(projectionOf(store, runId)), undefined, "the new verdict drops readiness");
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Fix the thing.",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: architect,
      architectId: "openai:architect",
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      evidenceStore,
      projectDocs: stubProjectDocsPort(),
      planningHostCapabilities: () => fixture.hostCapabilities,
      coverageReview: coverageDriver as never,
    });
    runtime.submitUserGuidance({
      guidanceId: "g2",
      text: "Also add an audit log entry for every login (new scope).",
      version: 1,
      idempotencyKey: "g2",
    });
    const acked = await runtime.step();
    assert.equal(acked.status, "progressed");
    assert.equal(projectionOf(store, runId).latestFoldedIntoPlanningAck?.guidanceId, "g2");
    // Kernel: readiness on the pre-fold review is refused in the window too.
    assert.throws(
      () => store.append({
        runId,
        type: "planning.plan_ready",
        occurredAt: clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: "ready:stale-window",
        payload: { hostCapabilities: fixture.hostCapabilities },
      }),
      /was requested before/,
    );
    // Pump mirror: the stale bound review returns the Architect as
    // plan_required WITHOUT attempting readiness (no gate) and WITHOUT
    // calling the reviewer; the turn records the guidance checkpoint.
    const held = await runtime.step();
    assert.equal(held.status, "progressed");
    assert.equal(held.action, "plan_required");
    assert.equal(coverageInputs.length, 0, "the stale review is never re-driven");
    assert.equal(projectionOf(store, runId).planning?.coverageUnavailable, undefined, "readiness was not attempted");
    assert.deepEqual(reasons, ["user_guidance_required", "plan_required"]);
    // The checkpoint alone cannot unbind the stale review: readiness is
    // still refused until a revision and a new review follow.
    assert.throws(
      () => store.append({
        runId,
        type: "planning.plan_ready",
        occurredAt: clock(),
        actor: { role: "runner", id: "build-runtime" },
        idempotencyKey: "ready:checkpoint-only",
        payload: { hostCapabilities: fixture.hostCapabilities },
      }),
      /was requested before/,
    );
    const revised = await runtime.step();
    assert.equal(revised.action, "plan_required");
    assert.equal(projectionOf(store, runId).planning?.plan?.currentRevisionId, "revision_2");
    const rev2 = projectionOf(store, runId).planning!.plan!;
    append("planning.coverage_review_requested", "coverage-request:3", { role: "architect", id: "architect_1" }, {
      reviewId: "coverage_3",
      planRevisionId: rev2.currentRevisionId,
      planRevisionDigest: rev2.currentDigest,
      sourceManifestId: fixture.manifest.manifestId,
      requestedAt: clock(),
    });
    const reviewed = await runtime.step();
    assert.equal(reviewed.action, "coverage_review_recorded");
    assert.equal(coverageInputs.length, 1);
    assert.equal(coverageInputs[0]!.reviewId, "coverage_3");
    assert.ok(coverageInputs[0]!.guidance.some((entry) => entry.text.includes("audit log")), JSON.stringify(coverageInputs[0]!.guidance));
    const ready = await runtime.step();
    assert.equal(ready.action, "plan_ready");
    assert.equal(readyPlanIdentity(projectionOf(store, runId))?.revisionId, "revision_2");
  } finally {
    evidenceStore.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("T9 repair N-C: folded guidance after the answer requires a new answer; the re-review sees the guidance", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t9-folded-answer-"));
  const clock = advancingClock();
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const runId = "run_t9_folded_answer";
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const harness = answerReviewHarness(
    "folded-answer",
    [
      answerFindingsTurn([{ id: "f-one", statement: "ONE is thin but accurate.", severity: "non_blocking" }]),
      answerVerdictTurn("ONE stands.", true),
      answerFindingsTurn([{ id: "f-two", statement: "TWO covers the folded caching note.", severity: "non_blocking" }]),
      answerVerdictTurn("TWO stands.", true, [
        { findingId: "f-one", resolution: "resolved", rationale: "TWO mentions caching." },
      ]),
    ],
    { store, clock },
  );
  const reviewCalls: { reviewId: string; answerSequence: number; guidance: { id: string; text: string }[] }[] = [];
  let planStep = 0;
  let oneSequence = 0;
  let twoSequence = 0;
  const architect: ArchitectRuntimeDriver = {
    run: async (request) => {
      if (request.reason.type === "completion_decision_required") {
        await invokeMustSucceed(request, "complete_run", { summary: "Answered and reviewed." }, "complete");
        return;
      }
      if (request.reason.type === "user_guidance_required") {
        await invokeMustSucceed(request, "acknowledge_user_guidance", {
          guidanceId: "g1",
          expectedVersion: 1,
          resolution: {
            type: "folded_into_planning",
            rationale: "The answered run has no plan; the caching note folds into the answer text.",
          },
        }, "ack");
        return;
      }
      const current = planStep++;
      if (current === 0) {
        await invokeMustSucceed(request, "record_triage", {
          decision: "answer",
          rationale: "The request is a pure question with no requested change.",
        }, "triage");
        return;
      }
      if (current === 1) {
        const output = await invokeMustSucceed(request, "record_answer", {
          answerText: "The build fails because the cache key omits the lockfile; add it.",
          addressedParts: ["Why the build fails", "How to fix it"],
        }, "answer-one");
        oneSequence = (outputJson(output) as unknown as { sequence: number }).sequence;
        return;
      }
      if (current === 2) {
        const output = await invokeMustSucceed(request, "record_answer", {
          answerText: "The build fails because the cache key omits the lockfile; add it. Also see caching.",
          addressedParts: ["Why the build fails", "How to fix it"],
        }, "answer-two");
        twoSequence = (outputJson(output) as unknown as { sequence: number }).sequence;
        return;
      }
      for (const write of entryPointDocs()) {
        await invokeMustSucceed(request, "write_project_doc", {
          path: write.path,
          content: write.content,
          summary: `Write ${write.path}`,
        }, write.path);
      }
    },
  };
  try {
    seedNewPolicy(store, runId, clock);
    const runtime = new BuildRuntime({
      runId,
      initialObjective: "Why does the build fail, and how do I fix it?",
      store,
      clock,
      workerDriver: new CountingWorkerDriver(),
      architectDriver: architect,
      architectId: "openai:architect",
      integrationDriver: {
        integrate: async () => {
          throw new Error("must_not_integrate");
        },
      },
      maxConcurrency: 1,
      workspaceFor: async () => {
        throw new Error("must_not_allocate");
      },
      artifacts,
      evidenceStore,
      projectDocs: stubProjectDocsPort(),
      answerReview: {
        candidateRuntimeIds: ["google:reviewer", "fallback:reviewer"],
        review: async (input) => {
          reviewCalls.push({
            reviewId: input.reviewId,
            answerSequence: input.answerSequence,
            guidance: [...(input.guidance ?? [])],
          });
          return await harness.runtime.review(input);
        },
      },
    });
    assert.equal((await runtime.step()).status, "progressed"); // triage
    assert.equal((await runtime.step()).status, "progressed"); // answer ONE
    assert.notEqual(oneSequence, 0);
    store.append({
      runId,
      type: "answer.review_opted_in",
      occurredAt: clock(),
      actor: { role: "user", id: "local-user" },
      idempotencyKey: "answer:optin",
      payload: {},
    });
    const reviewedOne = await runtime.step();
    assert.equal(reviewedOne.action, "answer_review_recorded");
    assert.equal(reviewCalls.length, 1);
    assert.deepEqual(reviewCalls[0], { reviewId: "answer_review_1", answerSequence: oneSequence, guidance: [] });
    runtime.submitUserGuidance({
      guidanceId: "g1",
      text: "Also mention caching.",
      version: 1,
      idempotencyKey: "g1",
    });
    const acked = await runtime.step();
    assert.equal(acked.status, "progressed");
    assert.equal(projectionOf(store, runId).latestFoldedIntoPlanningAck?.guidanceId, "g1");
    // Kernel (N-C): the folded acknowledgement postdates the recorded
    // answer, so completion requires a new answer — despite the verdict
    // that covers ONE.
    const stale = buildCompletionReadiness(projectionOf(store, runId));
    assert.equal(stale.ready, false);
    assert.ok(
      stale.issues.some((issue) => issue.includes("requires a new answer recorded after the acknowledgement")),
      JSON.stringify(stale.issues),
    );
    const held = await runtime.step();
    assert.equal(held.action, "plan_required");
    assert.notEqual(twoSequence, 0);
    assert.notEqual(twoSequence, oneSequence);
    // The pump re-reviews TWO with the prior review attached, and the
    // review input carries the acknowledged guidance.
    const rereviewed = await runtime.step();
    assert.equal(rereviewed.action, "answer_review_recorded");
    assert.equal(reviewCalls.length, 2);
    assert.equal(reviewCalls[1]!.reviewId, "answer_review_2");
    assert.equal(reviewCalls[1]!.answerSequence, twoSequence);
    assert.ok(
      reviewCalls[1]!.guidance.some((entry) => entry.text.includes("caching")),
      JSON.stringify(reviewCalls[1]!.guidance),
    );
    // The reviewer saw the folded guidance in its model-visible context.
    const seen = JSON.stringify(harness.model.requests.map((entry) => entry.messages));
    assert.ok(seen.includes("Also mention caching."), "the folded guidance reaches the reviewer");
    const blocked = await runtime.runUntilBlocked(20);
    assert.equal(blocked.status, "paused");
    const selected = runtime.selectProjectHandoff(
      "keep_integration_branch",
      {
        integrationRevision: "no_integration",
        integrationBranch: `aiboard/integration/${runId}`,
        appliedToProject: false,
      },
      "handoff:folded-answer",
    );
    assert.equal(selected.status, "completed");
    assert.equal(
      selected.requestAnswer?.answerText,
      "The build fails because the cache key omits the lockfile; add it. Also see caching.",
    );
  } finally {
    evidenceStore.close();
    harness.close();
    rmSync(root, { recursive: true, force: true });
  }
});
