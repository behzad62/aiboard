import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CriterionEvidenceLink } from "../src/acceptance-contracts.js";
import { validateSelectedCommandEvidenceBinding } from "../src/delivery-acceptance.js";
import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import {
  BuildRuntime,
  type ArchitectActionRequest,
  type ArchitectRuntimeDriver,
  type DeliveryBoundaryDriver,
  type IntegrationRuntimeDriver,
} from "../src/build-runtime.js";
import {
  NativeDeliverableReviewRuntime,
  type DeliverableReviewInputs,
  type DeliveryDepthRunner,
} from "../src/native-deliverable-review.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import { RuntimeRouter, type AgentRuntimeCandidate } from "../src/runtime-router.js";
import {
  currentExplicitStartIdentity,
  readyPlanIdentity,
  rebuildSchedulerProjection,
  type NewSchedulerEvent,
  type SchedulerActorRole,
  type SchedulerEventType,
  type SchedulerProjection,
} from "../src/scheduler-store.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import type { WorkerAssignment, WorkerOutcome, WorkerRuntimeDriver } from "../src/task-scheduler.js";
import { testIntegrityPinDigest, type TestIntegrityBinding } from "../src/test-integrity.js";
import type { TaskValidationMandates } from "../src/task-validation-policy.js";
import {
  buildPlanningFixtureScenario,
  FIXTURE_AMENDED_TEXT,
  type PlanningFixtureScenario,
} from "./fixtures/planning-source-fixture.js";
import { commandEvidence } from "./support/evidence-fixtures.js";

/**
 * IV-2 (CD-23/EP16) kernel tests: tampered `selected` records fail closed,
 * coherent selected records flow through the real pump, legacy full
 * records replay unchanged, scope-aware test integrity holds at the
 * kernel, and EP16 mandates steer the production task-acceptance path.
 * Real SQLite stores, the real kernel reducer, the real review runtime
 * tool loop, and stub execution drivers with genuine evidence records.
 */

const RUN_ID = "run-iv2-kernel";

type BoundaryInput = Parameters<DeliveryBoundaryDriver["check"]>[0];
type BoundaryOutput = Awaited<ReturnType<DeliveryBoundaryDriver["check"]>>;

interface BoundaryStubContext {
  evidence: SqliteEvidenceStore;
  artifacts: ArtifactStore;
  projection(): SchedulerProjection;
}

function event(type: SchedulerEventType | string, key: string, actor: { role: SchedulerActorRole; id: string }, payload: Record<string, unknown>): NewSchedulerEvent {
  return { runId: RUN_ID, type: type as SchedulerEventType, occurredAt: "2026-09-25T00:00:00.000Z", actor, idempotencyKey: key, payload };
}

function planningInputs(fixture: PlanningFixtureScenario, testIntegrityPolicy: boolean): NewSchedulerEvent[] {
  // T7b/W1 shape: the docs policy stamp plus planning policy precede the
  // source chain. Test-integrity runs activate through the real
  // `run.initialized` prefix (docs first, then init carrying only the
  // test-integrity version — no other policy is activated); the
  // `run.policy_configured` payload never carried policy versions.
  const head = testIntegrityPolicy
    ? [
      event("project_docs.policy_configured", "docs-policy", { role: "runner", id: "build-runtime" }, { version: 1 }),
      event("run.initialized", "run-init", { role: "runner", id: "build-runtime" }, { testIntegrityPolicyVersion: 1 }),
      event("planning.policy_configured", "planning-policy", { role: "runner", id: "build-runtime" }, { version: 1 }),
      event("run.policy_configured", "policy", { role: "runner", id: "build-runtime" }, { runPolicy: "finish" }),
    ]
    : [
      event("run.policy_configured", "policy", { role: "runner", id: "build-runtime" }, { runPolicy: "finish" }),
      event("planning.policy_configured", "planning-policy", { role: "runner", id: "build-runtime" }, { version: 1 }),
      event("project_docs.policy_configured", "docs-policy", { role: "runner", id: "build-runtime" }, { version: 1 }),
    ];
  return [
    ...head,
    event("planning.source_registered", "source", { role: "user", id: "owner" }, { manifest: fixture.priorManifest }),
    event("planning.source_amended", "source-amendment", { role: "user", id: "owner" }, { manifest: fixture.manifest }),
    event("request.triaged", "triage", { role: "architect", id: "architect" }, { decision: "build", rationale: "Build the fixture." }),
    event("planning.ledger_persisted", "ledger", { role: "architect", id: "architect" }, { id: "ledger", requirements: fixture.requirements, phases: fixture.phases, nonNormativeSections: [] }),
    ...fixture.manifest.sections.map((section) => event("planning.source_section_read", `read:${section.id}`, { role: "architect", id: "architect" }, { manifestId: fixture.manifest.manifestId, manifestDigest: fixture.manifest.artifactDigest, sectionId: section.id, sectionDigest: section.digest, readAt: "2026-09-25T00:00:01.000Z" })),
    event("planning.plan_drafted", "plan", { role: "architect", id: "architect" }, { revision: fixture.revision, expectedRevisionId: null, expectedDigest: null }),
    event("planning.coverage_review_requested", "coverage-request", { role: "architect", id: "architect" }, { reviewId: fixture.coverageReview.id, planRevisionId: fixture.revision.revisionId, planRevisionDigest: fixture.revision.digest, sourceManifestId: fixture.manifest.manifestId, requestedAt: "2026-09-25T00:00:02.000Z" }),
    event("planning.coverage_obligations_recorded", "coverage-obligations", { role: "verifier", id: "coverage-reviewer" }, { reviewId: fixture.coverageReview.id, sourceManifestId: fixture.manifest.manifestId, sourceManifestDigest: fixture.manifest.artifactDigest, obligations: fixture.coverageReview.derivedObligations, sectionCoverage: fixture.manifest.sections.map((section) => ({ sectionId: section.id, obligationIds: fixture.coverageReview.derivedObligations.map((obligation) => obligation.id) })), recordedAt: "2026-09-25T00:00:03.000Z" }),
    event("planning.coverage_plan_delivered", "coverage-plan", { role: "runner", id: "build-runtime" }, { reviewId: fixture.coverageReview.id, planRevisionId: fixture.revision.revisionId, planRevisionDigest: fixture.revision.digest, sourceManifestId: fixture.manifest.manifestId, deliveredAt: "2026-09-25T00:00:04.000Z" }),
    event("planning.coverage_review_recorded", "coverage-review", { role: "verifier", id: "coverage-reviewer" }, { review: fixture.coverageReview }),
    event("planning.plan_ready", "ready", { role: "runner", id: "build-runtime" }, { hostCapabilities: fixture.hostCapabilities }),
  ];
}

function fixtureScenario(): PlanningFixtureScenario {
  const base = buildPlanningFixtureScenario();
  return {
    ...base,
    manifest: {
      ...base.manifest,
      amendment: {
        ...base.manifest.amendment!,
        recordedImpact: { addsSectionIds: ["s8"], retiresSectionIds: ["s7"], addsRequirementIds: [], retiresRequirementIds: ["REQ-RETIRED"] },
      },
    },
  };
}

const DIFF = [
  "diff --git a/src/feature.ts b/src/feature.ts",
  "--- a/src/feature.ts",
  "+++ b/src/feature.ts",
  "@@ -1,2 +1,3 @@",
  " export const a = 1;",
  "-export const b = 2;",
  "+export const b = 3;",
  "+export const c = a + b;",
].join("\n");

type Pass = "obligations" | "findings" | "verdict";

class ScriptedReviewer implements AgentModel {
  readonly requests: Array<{ pass: Pass; sessionId: string; text: string; toolResults: number }> = [];
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const system = request.messages.find((message) => message.role === "system");
    const pass = (system?.id.replace("delivery-", "").replace("-system", "") ?? "findings") as Pass;
    const text = request.messages.filter((message) => typeof message.content === "string").map((message) => message.content as string).join("\n");
    const toolResults = request.messages.filter((message) => message.role === "tool");
    this.requests.push({ pass, sessionId: request.sessionId, text, toolResults: toolResults.length });
    const call = (name: string, args: unknown): ModelTurn => ({
      blocks: [{ type: "tool_call", callId: `${pass}-${name}-${toolResults.length}-${request.messages.length}`, name, arguments: args }],
      stopReason: "tool_calls",
    });
    if (pass === "obligations") {
      return call("record_deliverable_obligations", { obligations: [{ id: "obl-1", description: "The behavior must match every criterion." }] });
    }
    if (pass === "findings") {
      if (!toolResults.some((message) => (message.content as { toolName?: string }).toolName === "fs.read")) {
        return call("fs.read", { path: "src/feature.ts" });
      }
      return call("record_deliverable_findings", { findings: [] });
    }
    const claimIds = [...text.matchAll(/"id": "(claim:[^"]+)"/g)].map((match) => match[1]!);
    return call("submit_deliverable_verdict", {
      summary: "Reviewed against the criteria.",
      satisfied: true,
      claimVerdicts: [...new Set(claimIds)].map((claimId) => ({ claimId, status: "verified", rationale: "Checked." })),
    });
  }
}

class TestWorkers implements WorkerRuntimeDriver {
  constructor(private readonly harness: Iv2Harness, private readonly authorRuntimeId: string) {}
  async run(assignment: WorkerAssignment): Promise<WorkerOutcome> {
    const { task, attempt } = assignment;
    this.harness.scheduler.append(event("worker.runtime_assigned", `runtime:${task.id}:${attempt}`, { role: "runner", id: "runtime-router" }, { taskId: task.id, attempt, runtimeId: this.authorRuntimeId, sessionId: `session:${task.id}:${attempt}` }));
    const links: CriterionEvidenceLink[] = (task.acceptanceCriteria ?? []).map((criterion) => {
      const record = this.harness.evidence.record({ ...commandEvidence(`${task.id}:${criterion.id}:${attempt}`, { label: criterion.id }), runId: RUN_ID, taskId: task.id, attempt, actor: { role: "worker", id: assignment.workerId } });
      return { criterionId: criterion.id, evidenceId: record.id, artifactHashes: ["a".repeat(64)], taskId: task.id, attempt };
    });
    return { type: "submitted", changeSetId: `changeset:${task.id}:${attempt}`, criterionEvidenceLinks: links };
  }
}

class StoreArchitect implements ArchitectRuntimeDriver {
  constructor(private readonly scheduler: SqliteSchedulerStore) {}
  async run(request: ArchitectActionRequest): Promise<void> {
    const store = this.scheduler;
    if (request.reason.type === "review_required") {
      const task = request.projection.tasks[request.reason.taskId]!;
      const links = task.criterionEvidenceLinks ?? [];
      store.append(event("review.decided", `review:${task.id}:${task.attempt}`, { role: "architect", id: "architect" }, {
        taskId: task.id,
        decision: "approved",
        summary: "Architect review.",
        evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
        criterionVerdicts: (task.acceptanceCriteria ?? []).map((criterion) => ({ criterionId: criterion.id, verdict: "satisfied", rationale: "Judged.", evidenceIds: links.filter((link) => link.criterionId === criterion.id).map((link) => link.evidenceId), artifactHashes: ["a".repeat(64)] })),
      }));
      return;
    }
    if (request.reason.type === "integration_approval_required") {
      store.append(event("task.transitioned", `integrate:${request.reason.taskId}:${request.projection.tasks[request.reason.taskId]!.attempt}`, { role: "architect", id: "architect" }, { taskId: request.reason.taskId, status: "integrating" }));
      return;
    }
    if (request.reason.type === "delivery_boundary_failed") {
      store.append(event("delivery.boundary_failure_resolved", `boundary-resolution:${request.reason.boundaryId}:${request.reason.resolutionGeneration}`, { role: "architect", id: "architect" }, {
        taskId: request.reason.taskId,
        boundaryId: request.reason.boundaryId,
        resolutionGeneration: request.reason.resolutionGeneration,
        resolution: "recheck",
        rationale: "Recheck once.",
      }));
      return;
    }
    throw new Error(`Unexpected Architect reason ${request.reason.type}.`);
  }
}

class TestIntegration implements IntegrationRuntimeDriver {
  private revision = 0;
  async integrate(): Promise<{ status: "integrated"; integrationRevision: string }> {
    this.revision += 1;
    return { status: "integrated", integrationRevision: `${String(this.revision).padStart(2, "0")}${"f".repeat(38)}` };
  }
}

interface Iv2HarnessOptions {
  changedPaths?: (taskId: string, attempt: number) => string[];
  depth?: DeliveryDepthRunner;
  boundaryCheck: (input: BoundaryInput, ctx: BoundaryStubContext) => Promise<BoundaryOutput>;
  validationMandates?: TaskValidationMandates;
  testIntegrityPolicy?: boolean;
}

interface Iv2Harness {
  root: string;
  scheduler: SqliteSchedulerStore;
  evidence: SqliteEvidenceStore;
  artifacts: ArtifactStore;
  sessions: SqliteAgentSessionStore;
  runtime: BuildRuntime;
  reviewer: ScriptedReviewer;
  review: NativeDeliverableReviewRuntime;
  seenBoundaryInputs: BoundaryInput[];
  projection(): SchedulerProjection;
  until(predicate: (projection: SchedulerProjection) => boolean, maxSteps?: number): Promise<string[]>;
  close(): void;
}

const DEFAULT_CANDIDATES: AgentRuntimeCandidate[] = [
  { runtimeId: "architect-runtime", providerId: "architect", modelId: "architect-model", capabilities: ["code"], priority: 1 },
  { runtimeId: "author-runtime", providerId: "author", modelId: "author-model", capabilities: ["code"], priority: 2 },
  { runtimeId: "reviewer-runtime", providerId: "reviewer", modelId: "reviewer-model", capabilities: ["code"], priority: 3 },
];

async function createHarness(options: Iv2HarnessOptions): Promise<Iv2Harness> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-iv2-kernel-"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const scheduler = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore: evidence, artifacts });
  const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 8, 25, 0, 0, 0, tick++ * 10)).toISOString();
  const scenario = fixtureScenario();
  for (const input of planningInputs(scenario, options.testIntegrityPolicy === true)) scheduler.append(input);
  // T7b: the ready plan waits for its explicit owner start. The test acts as
  // owner through the genuine authorization event, covering the kernel's own
  // current ready identity (mirrors w1-review-economics; no authority is
  // seeded or invented: the identity is read from the real projection).
  const startIdentity = currentExplicitStartIdentity(rebuildSchedulerProjection(scheduler.readRun(RUN_ID)));
  assert.ok(startIdentity, "the fixture plan is ready with a complete start identity");
  scheduler.append(event("planning.execution_authorized", "iv2-owner-start", { role: "user", id: "local-user" }, {
    authorization: { ...startIdentity!, version: 1, ownerChoice: "execute" },
  }));
  // The pump verifies the current source artifact authority from the real
  // bytes: the exact fixture bytes hash to the manifest digest.
  const stored = await artifacts.put(Buffer.from(FIXTURE_AMENDED_TEXT, "utf8"), "text/plain", "iv2 approved source");
  assert.equal(stored.hash, scenario.manifest.artifactDigest, "the stored source bytes are the manifest authority");
  const router = new RuntimeRouter({ health: new ProviderHealthRegistry(), candidates: DEFAULT_CANDIDATES });
  const reviewer = new ScriptedReviewer();
  const workspaceRoot = join(root, "review-workspace");
  const harness = { root, scheduler, evidence, artifacts, sessions, reviewer } as unknown as Iv2Harness;
  const review = new NativeDeliverableReviewRuntime({
    store: scheduler,
    architectRuntimeId: "architect-runtime",
    router,
    candidates: DEFAULT_CANDIDATES,
    models: new Map(DEFAULT_CANDIDATES.map((candidate) => [candidate.runtimeId, reviewer])),
    reviewerRuntimeIds: ["reviewer-runtime"],
    sessions,
    artifacts,
    evidenceStore: evidence,
    loadInputs: async ({ task, projection }): Promise<DeliverableReviewInputs> => {
      const diff = await artifacts.put(Buffer.from(`${DIFF}\n# ${task.id} attempt ${task.attempt}`), "text/x-diff", "diff");
      const changedPaths = options.changedPaths?.(task.id, task.attempt) ?? ["src/feature.ts"];
      const criteria = (task.acceptanceCriteria ?? []).map((criterion) => ({ id: criterion.id, text: criterion.text }));
      return {
        taskId: task.id,
        attempt: task.attempt,
        changeSetId: task.changeSetId!,
        baselineRevision: "b".repeat(40),
        taskRevision: "c".repeat(40),
        diffArtifactHash: diff.hash,
        diffText: `${DIFF}\n# ${task.id} attempt ${task.attempt}`,
        changedPaths,
        objective: task.objective,
        criteria,
        workerSummary: `Worker summary for ${task.id}`,
        unresolvedConcerns: [],
        claims: [
          ...criteria.map((criterion) => ({ id: `claim:${criterion.id}`, text: `Criterion ${criterion.id} is satisfied.`, evidenceIds: (task.criterionEvidenceLinks ?? []).map((link) => link.evidenceId) })),
          { id: "claim:summary", text: `Worker summary for ${task.id}`, evidenceIds: [] },
        ],
        authorRuntimeId: projection.runtime.workerAssignments[`${task.id}:${task.attempt}`]!.runtimeId,
      };
    },
    workspace: {
      create: async () => {
        mkdirSync(join(workspaceRoot, "src"), { recursive: true });
        writeFileSync(join(workspaceRoot, "src", "feature.ts"), "export const b = 3;\n");
        return { path: workspaceRoot };
      },
      cleanup: async () => rmSync(workspaceRoot, { recursive: true, force: true }),
    },
    depth: options.depth ?? {
      run: async () => {
        throw new Error("No high-tier depth runner in this harness.");
      },
    },
    clock,
  });
  const seenBoundaryInputs: BoundaryInput[] = [];
  Object.assign(harness, { seenBoundaryInputs });
  const boundary: DeliveryBoundaryDriver = {
    check: async (input) => {
      seenBoundaryInputs.push(input);
      return options.boundaryCheck(input, {
        evidence,
        artifacts,
        projection: () => rebuildSchedulerProjection(scheduler.readRun(RUN_ID)),
      });
    },
  };
  const runtime = new BuildRuntime({
    runId: RUN_ID,
    store: scheduler,
    workerDriver: new TestWorkers(harness, "author-runtime"),
    architectDriver: new StoreArchitect(scheduler),
    integrationDriver: new TestIntegration(),
    deliveryReview: review,
    deliveryBoundary: boundary,
    maxConcurrency: 1,
    workspaceFor: async (task) => join(root, "work", task.id),
    clock,
    evidenceStore: evidence,
    artifacts,
    architectId: "architect-runtime",
    ...(options.validationMandates ? { validationMandates: options.validationMandates } : {}),
  });
  Object.assign(harness, {
    runtime,
    review,
    projection: () => rebuildSchedulerProjection(scheduler.readRun(RUN_ID)),
    until: async (predicate: (projection: SchedulerProjection) => boolean, maxSteps = 120) => {
      const actions: string[] = [];
      for (let step = 0; step < maxSteps; step += 1) {
        if (predicate(harness.projection())) return actions;
        const result = await runtime.step();
        actions.push(result.action ?? result.status);
        if (result.status === "paused") {
          if (predicate(harness.projection())) return actions;
          throw new Error(`Run paused (${harness.projection().pauseReason?.reason}) before the condition: ${actions.slice(-12).join(",")}`);
        }
      }
      if (!predicate(harness.projection())) throw new Error(`Condition not reached: ${actions.slice(-12).join(",")}`);
      return actions;
    },
    close: () => {
      scheduler.close();
      evidence.close();
      sessions.close();
      rmSync(root, { recursive: true, force: true });
    },
  });
  return harness;
}

/** A real JUnit report stored as a durable artifact, as the runner records it. */
async function junitReport(artifacts: ArtifactStore, passed: number, failed: number) {
  const cases = Array.from({ length: passed + failed }, (_, index) => index < passed ? `<testcase name="t${index}"/>` : `<testcase name="t${index}"><failure message="x"/></testcase>`).join("");
  const xml = `<?xml version="1.0"?><testsuites tests="${passed + failed}" failures="${failed}" errors="0" skipped="0"><testsuite name="s" tests="${passed + failed}" failures="${failed}" errors="0" skipped="0">${cases}</testsuite></testsuites>`;
  const artifact = await artifacts.put(Buffer.from(xml), "application/xml", "fixture junit");
  return {
    status: failed > 0 ? "failed" as const : "passed" as const,
    runner: "node --test",
    format: "junit" as const,
    path: ".aiboard-report-fixture.xml",
    artifactHash: artifact.hash,
    counts: { selected: passed + failed, passed, failed, skipped: 0 },
  };
}

const accepted = (taskId: string) => (projection: SchedulerProjection) => projection.delivery?.taskAcceptances[taskId] !== undefined;

async function passedChecks(
  ctx: BoundaryStubContext,
  input: BoundaryInput,
  testsArgs: string[],
  passed: number,
): Promise<BoundaryOutput["checks"]> {
  const call = `${input.taskId}:${input.boundaryId}:${input.attempt}`;
  const report = await junitReport(ctx.artifacts, passed, 0);
  const checks: BoundaryOutput["checks"] = [];
  for (const checkId of ["build", "tests"] as const) {
    // F2: the durable evidence carries the exact argv the check claims, as
    // the audited executor records it; selected coherence binds the two.
    const args = checkId === "tests" ? testsArgs : ["run", "build"];
    const record = ctx.evidence.record({ ...commandEvidence(`boundary:${call}:${checkId}`, { label: checkId, exitCode: 0, command: "npm", args: [...args] }), runId: RUN_ID, taskId: `delivery:${input.taskId}`, actor: { role: "verifier", id: "delivery-check-runtime" } });
    checks.push({
      checkId,
      command: "npm",
      args: [...args],
      evidenceIds: [record.id],
      exitCode: 0,
      outcome: "passed",
      ...(checkId === "tests" ? { report } : {}),
    });
  }
  return checks;
}

const fullGoodCheck = async (input: BoundaryInput, ctx: BoundaryStubContext): Promise<BoundaryOutput> => ({
  changedFiles: ["src/feature.ts"],
  executedScope: "full_test_script",
  selection: { rung: "full_suite", selectedTests: ["test/x.test.mjs"] },
  checks: await passedChecks(ctx, input, ["run", "test"], 2),
});

const NARROW_ARGS = ["run", "test", "--", "test/x.test.mjs"];

const tamperedCases: Array<{ name: string; pattern: RegExp; outcome: (input: BoundaryInput, ctx: BoundaryStubContext) => Promise<BoundaryOutput> }> = [
  {
    name: "full_suite rung with selected scope",
    pattern: /rung/,
    outcome: async (input, ctx) => ({
      changedFiles: ["src/feature.ts"],
      executedScope: "selected",
      selection: { rung: "full_suite", selectedTests: ["test/x.test.mjs"], widened: false, wideningReasons: [] },
      checks: await passedChecks(ctx, input, NARROW_ARGS, 2),
    }),
  },
  {
    name: "empty selectedTests with selected scope",
    pattern: /no selected tests/,
    outcome: async (input, ctx) => ({
      changedFiles: ["src/feature.ts"],
      executedScope: "selected",
      selection: { rung: "module_graph", selectedTests: [], widened: false, wideningReasons: [] },
      checks: await passedChecks(ctx, input, ["run", "test"], 2),
    }),
  },
  {
    name: "executed argv not naming the selected tests",
    pattern: /does not name/,
    outcome: async (input, ctx) => ({
      changedFiles: ["src/feature.ts"],
      executedScope: "selected",
      selection: { rung: "module_graph", selectedTests: ["test/x.test.mjs"], widened: false, wideningReasons: [] },
      checks: await passedChecks(ctx, input, ["run", "test"], 2),
    }),
  },
  {
    name: "widened selection with selected scope",
    pattern: /widen/,
    outcome: async (input, ctx) => ({
      changedFiles: ["src/feature.ts"],
      executedScope: "selected",
      selection: { rung: "module_graph", selectedTests: ["test/x.test.mjs"], widened: true, wideningReasons: ["lockfile package-lock.json"] },
      checks: await passedChecks(ctx, input, NARROW_ARGS, 2),
    }),
  },
  {
    name: "unknown scope value",
    pattern: /invalid/,
    outcome: async (input, ctx) => ({
      changedFiles: ["src/feature.ts"],
      executedScope: "bogus" as unknown as BoundaryOutput["executedScope"],
      selection: { rung: "full_suite", selectedTests: ["test/x.test.mjs"] },
      checks: await passedChecks(ctx, input, ["run", "test"], 2),
    }),
  },
];

for (const tampered of tamperedCases) {
  test(`IV-2 kernel rejects tampered selected boundary: ${tampered.name}`, async () => {
    const harness = await createHarness({ boundaryCheck: tampered.outcome });
    try {
      await assert.rejects(harness.until(accepted("T1")), tampered.pattern);
      assert.equal(harness.projection().delivery?.boundaries?.["T1"]?.length ?? 0, 0, "no tampered boundary is recorded");
    } finally {
      harness.close();
    }
  });
}

test("IV-2 kernel accepts a coherent selected boundary through the pump", async () => {
  const harness = await createHarness({
    boundaryCheck: async (input, ctx) => ({
      changedFiles: ["src/feature.ts"],
      executedScope: "selected",
      selection: { rung: "module_graph", selectedTests: ["test/x.test.mjs"], widened: false, wideningReasons: [] },
      checks: await passedChecks(ctx, input, NARROW_ARGS, 2),
    }),
  });
  try {
    await harness.until(accepted("T1"));
    const boundary = harness.projection().delivery!.boundaries!["T1"]!.at(-1)!;
    assert.equal(boundary.executedScope, "selected");
    assert.equal(boundary.selection.rung, "module_graph");
    assert.deepEqual(boundary.selection.selectedTests, ["test/x.test.mjs"]);
    assert.equal(boundary.selection.widened, false);
    assert.equal(boundary.passed, true);
  } finally {
    harness.close();
  }
});

test("IV-2 legacy full_test_script records without widening fields replay unchanged", async () => {
  const harness = await createHarness({ boundaryCheck: fullGoodCheck });
  try {
    await harness.until(accepted("T1"));
    const boundary = harness.projection().delivery!.boundaries!["T1"]!.at(-1)!;
    assert.equal(boundary.executedScope, "full_test_script");
    assert.ok(!("widened" in boundary.selection), "legacy shape carries no widening fields");
    assert.ok(!("wideningReasons" in boundary.selection), "legacy shape carries no widening fields");
  } finally {
    harness.close();
  }
});

function selectedDepthStub(tamper: boolean): { depth: DeliveryDepthRunner; ref: { current?: Iv2Harness } } {
  const ref: { current?: Iv2Harness } = {};
  const depth: DeliveryDepthRunner = {
    run: async (input) => {
      const harness = ref.current!;
      // F2: the durable evidence carries the exact argv the depth record
      // claims, as the audited executor records it.
      const tests = harness.evidence.record({ ...commandEvidence(`affected:${input.reviewId}`, { label: "tests", exitCode: 0, command: "npm", args: [...NARROW_ARGS] }), runId: RUN_ID, taskId: `delivery:${input.taskId}`, actor: { role: "verifier", id: input.reviewerRuntimeId } });
      const probe = harness.evidence.record({ ...commandEvidence(`probe:${input.reviewId}`, { label: "probe", exitCode: 1 }), runId: RUN_ID, taskId: `delivery:${input.taskId}`, actor: { role: "verifier", id: input.reviewerRuntimeId } });
      return {
        affectedTests: {
          executedScope: "selected",
          selectionRung: tamper ? "full_suite" : "module_graph",
          changedFiles: [...input.changedFiles],
          selectedTests: ["test/x.test.mjs"],
          widened: false,
          wideningReasons: [],
          fullSuiteCount: 3,
          command: "npm",
          args: [...NARROW_ARGS],
          evidenceIds: [tests.id],
          exitCode: 0,
          outcome: "passed",
          report: await junitReport(harness.artifacts, 2, 0),
        },
        probe: { rung: "builtin_mutator", mutantsGenerated: 1, mutantsExecuted: 1, mutantsCaught: 1, survivors: [], partial: false, evidenceIds: [probe.id], notes: [] },
      };
    },
  };
  return { depth, ref };
}

test("IV-2 kernel rejects tampered selected depth evidence (high tier)", async () => {
  const { depth, ref } = selectedDepthStub(true);
  const harness = await createHarness({
    changedPaths: () => ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
    depth,
    boundaryCheck: fullGoodCheck,
  });
  ref.current = harness;
  try {
    await assert.rejects(harness.until(accepted("T1")), /delivery_review_suspended:turn_limit/);
    assert.equal(harness.projection().delivery?.boundaries?.["T1"]?.length ?? 0, 0, "rejection lands at findings, before any boundary");
  } finally {
    harness.close();
  }
});

test("IV-2 kernel accepts coherent selected depth evidence (high tier)", async () => {
  const { depth, ref } = selectedDepthStub(false);
  const harness = await createHarness({
    changedPaths: () => ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"],
    depth,
    boundaryCheck: fullGoodCheck,
  });
  ref.current = harness;
  try {
    await harness.until(accepted("T1"));
    const review = harness.projection().delivery!.reviews["T1"]!;
    assert.equal(review.risk!.tier, "high");
    assert.equal(review.depth!.affectedTests!.executedScope, "selected");
    assert.equal(review.depth!.affectedTests!.widened, false);
  } finally {
    harness.close();
  }
});

test("IV-2 kernel refuses selected boundary argv that the cited command evidence did not run (F2)", async () => {
  const harness = await createHarness({
    boundaryCheck: async (input, ctx) => {
      // Self-reported selected argv naming the tests, but the durable
      // command evidence actually ran the whole script.
      const call = `${input.taskId}:${input.boundaryId}:${input.attempt}`;
      const report = await junitReport(ctx.artifacts, 2, 0);
      const tests = ctx.evidence.record({ ...commandEvidence(`boundary:${call}:tests`, { label: "tests", exitCode: 0, command: "npm", args: ["run", "test"] }), runId: RUN_ID, taskId: `delivery:${input.taskId}`, actor: { role: "verifier", id: "delivery-check-runtime" } });
      const build = ctx.evidence.record({ ...commandEvidence(`boundary:${call}:build`, { label: "build", exitCode: 0, command: "npm", args: ["run", "build"] }), runId: RUN_ID, taskId: `delivery:${input.taskId}`, actor: { role: "verifier", id: "delivery-check-runtime" } });
      return {
        changedFiles: ["src/feature.ts"],
        executedScope: "selected",
        selection: { rung: "module_graph", selectedTests: ["test/x.test.mjs"], widened: false, wideningReasons: [] },
        checks: [
          { checkId: "build", command: "npm", args: ["run", "build"], evidenceIds: [build.id], exitCode: 0, outcome: "passed" },
          { checkId: "tests", command: "npm", args: [...NARROW_ARGS], evidenceIds: [tests.id], exitCode: 0, outcome: "passed", report },
        ],
      };
    },
  });
  try {
    await assert.rejects(harness.until(accepted("T1")), /different command/);
    assert.equal(harness.projection().delivery?.boundaries?.["T1"]?.length ?? 0, 0, "no mismatched boundary is recorded");
  } finally {
    harness.close();
  }
});

test("IV-2 kernel selected-depth evidence binding rejects self-reported argv that durable evidence did not run (F2)", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-iv2-depth-binding-"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  try {
    const tests = evidence.record({
      ...commandEvidence("affected:depth-binding", { label: "tests", exitCode: 0, command: "npm", args: ["run", "test"] }),
      runId: RUN_ID,
      taskId: "delivery:T1",
      actor: { role: "verifier", id: "reviewer-runtime" },
    });
    assert.throws(
      () => validateSelectedCommandEvidenceBinding({
        runId: RUN_ID,
        type: "delivery.findings_recorded",
        payload: {
          taskId: "T1",
          depth: {
            affectedTests: {
              executedScope: "selected",
              command: "npm",
              args: [...NARROW_ARGS],
              evidenceIds: [tests.id],
            },
          },
        },
      }, evidence),
      /different command/,
    );
  } finally {
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("IV-2 default packet acceptance never forces the full suite while final stays pending", async () => {
  const harness = await createHarness({ boundaryCheck: fullGoodCheck });
  try {
    await harness.until(accepted("T1"));
    assert.ok(harness.seenBoundaryInputs.length >= 1);
    for (const input of harness.seenBoundaryInputs) assert.equal(input.forceFullSuite, false);
    assert.equal(harness.projection().finalVerification, undefined);
  } finally {
    harness.close();
  }
});

test("IV-2 explicit full-suite-now mandate forces full execution", async () => {
  const harness = await createHarness({
    boundaryCheck: fullGoodCheck,
    validationMandates: {
      sourceMandates: [{ id: "mandate_full", gate: "full_suite", scope: "affected", source: "source", description: "Release gate requires the full suite." }],
      projectMandates: [],
    },
  });
  try {
    await harness.until(accepted("T1"));
    assert.ok(harness.seenBoundaryInputs.length >= 1);
    for (const input of harness.seenBoundaryInputs) assert.equal(input.forceFullSuite, true);
  } finally {
    harness.close();
  }
});

test("IV-2 final-scoped full-suite mandate stays deferred for packets", async () => {
  const harness = await createHarness({
    boundaryCheck: fullGoodCheck,
    validationMandates: {
      sourceMandates: [{ id: "mandate_full", gate: "full_suite", scope: "final", source: "source", description: "Release gate requires the full suite." }],
      projectMandates: [],
    },
  });
  try {
    await harness.until(accepted("T1"));
    assert.ok(harness.seenBoundaryInputs.length >= 1);
    for (const input of harness.seenBoundaryInputs) assert.equal(input.forceFullSuite, false);
  } finally {
    harness.close();
  }
});

test("IV-2 conflicting mandates fail closed instead of picking a scope", async () => {
  const harness = await createHarness({
    boundaryCheck: fullGoodCheck,
    validationMandates: {
      sourceMandates: [{ id: "dup", gate: "gate", scope: "affected", source: "source", description: "d" }],
      projectMandates: [{ id: "dup", gate: "gate", scope: "final", source: "project", description: "d" }],
    },
  });
  try {
    await assert.rejects(harness.until(accepted("T1")), /conflict/);
    assert.equal(harness.projection().delivery?.boundaries?.["T1"]?.length ?? 0, 0);
  } finally {
    harness.close();
  }
});

const INTEGRITY_INITIAL_REVISION = "i".repeat(40);

function integrityPin(revision: string) {
  return { revision, commands: [{ executable: "npm", args: ["run", "test"] }], configDigest: "c".repeat(64) };
}

async function recordIntegrityBaseline(harness: Iv2Harness, executed: number): Promise<void> {
  harness.scheduler.append(event("delivery.test_integrity_initialized", "integrity-init", { role: "runner", id: "build-runtime" }, { revision: INTEGRITY_INITIAL_REVISION, architectActorId: "architect-runtime" }));
  // The kernel's initial-baseline authority rule requires the baseline's own
  // completed verifier command evidence at the immutable baseline revision,
  // under the exact `delivery:<taskId>` task with an initial-tests key.
  const record = harness.evidence.record({
    ...commandEvidence("integrity:baseline", { label: "baseline", exitCode: 0, repositoryRevision: INTEGRITY_INITIAL_REVISION }),
    runId: RUN_ID,
    taskId: "delivery:T1",
    actor: { role: "verifier", id: "delivery-check-runtime" },
    idempotencyKey: "test-integrity:T1:initial-tests:baseline",
  });
  const report = await junitReport(harness.artifacts, executed, 0);
  harness.scheduler.append(event("delivery.test_integrity_baseline_recorded", "integrity-baseline", { role: "runner", id: "build-runtime" }, { taskId: "T1", kind: "executed_report", pin: integrityPin(INTEGRITY_INITIAL_REVISION), evidenceIds: [record.id], report }));
}

function integrityBoundaryCheck(
  scope: "full_test_script" | "selected",
  reportPassed: number,
  guard: "passed" | "failed",
): (input: BoundaryInput, ctx: BoundaryStubContext) => Promise<BoundaryOutput> {
  return async (input, ctx) => {
    const projection = ctx.projection();
    const ready = readyPlanIdentity(projection)!;
    const review = projection.delivery!.reviews[input.taskId]!;
    const baseline = projection.testIntegrity!.baseline!;
    if (baseline.kind !== "executed_report") throw new Error("integrity fixture baseline missing");
    const candidatePin = { ...baseline.pin, revision: input.integrationRevision };
    const candidateExecuted = reportPassed;
    const binding: TestIntegrityBinding = {
      taskId: input.taskId,
      integrationRevision: input.integrationRevision,
      planRevisionId: ready.revisionId,
      planDigest: ready.digest,
      baselineRevision: baseline.pin.revision,
      submissionAttempt: review.submissionAttempt,
      changeSetId: review.changeSetId,
      baselinePinDigest: baseline.pinDigest,
      candidatePinDigest: testIntegrityPinDigest(candidatePin),
    };
    const checks = await passedChecks(ctx, input, scope === "selected" ? NARROW_ARGS : ["run", "test"], reportPassed);
    const guardRecord = ctx.evidence.record({ ...commandEvidence(`integrity:guard:${input.taskId}:${input.attempt}`, { label: "test_integrity", exitCode: guard === "passed" ? 0 : 1 }), runId: RUN_ID, taskId: `delivery:${input.taskId}`, actor: { role: "verifier", id: "delivery-check-runtime" } });
    checks.push({ checkId: "test_integrity", command: "integrity", args: ["guard"], evidenceIds: [guardRecord.id], exitCode: guard === "passed" ? 0 : 1, outcome: guard });
    return {
      changedFiles: ["src/feature.ts"],
      executedScope: scope,
      selection: scope === "selected"
        ? { rung: "module_graph", selectedTests: ["test/x.test.mjs"], widened: false, wideningReasons: [] }
        : { rung: "full_suite", selectedTests: ["test/x.test.mjs"] },
      checks,
      testIntegrity: {
        version: 1,
        taskId: binding.taskId,
        integrationRevision: binding.integrationRevision,
        planRevisionId: binding.planRevisionId,
        planDigest: binding.planDigest,
        baselineRevision: binding.baselineRevision,
        baselinePinDigest: binding.baselinePinDigest,
        submissionAttempt: binding.submissionAttempt,
        changeSetId: binding.changeSetId,
        candidatePinDigest: binding.candidatePinDigest,
        candidatePin,
        candidateExecuted,
      },
    };
  };
}

test("IV-2 kernel: intentional selected execution is not flagged as suite_shrank", async () => {
  const harness = await createHarness({ testIntegrityPolicy: true, boundaryCheck: integrityBoundaryCheck("selected", 4, "passed") });
  try {
    await recordIntegrityBaseline(harness, 10);
    await harness.until(accepted("T1"));
    const boundary = harness.projection().delivery!.boundaries!["T1"]!.at(-1)!;
    assert.equal(boundary.executedScope, "selected");
    const guard = boundary.checks.find((check) => check.checkId === "test_integrity")!;
    assert.equal(guard.outcome, "passed");
    assert.equal(guard.exitCode, 0);
    assert.equal(boundary.passed, true);
  } finally {
    harness.close();
  }
});

test("IV-2 kernel: a genuine full-script shrink with a passing guard is refused", async () => {
  const harness = await createHarness({ testIntegrityPolicy: true, boundaryCheck: integrityBoundaryCheck("full_test_script", 4, "passed") });
  try {
    await recordIntegrityBaseline(harness, 10);
    await assert.rejects(harness.until(accepted("T1")), /must match kernel recomputation/);
    assert.equal(harness.projection().delivery?.boundaries?.["T1"]?.length ?? 0, 0);
  } finally {
    harness.close();
  }
});

test("IV-2 kernel: a genuine full-script shrink with a failing guard blocks acceptance", async () => {
  const harness = await createHarness({ testIntegrityPolicy: true, boundaryCheck: integrityBoundaryCheck("full_test_script", 4, "failed") });
  try {
    await recordIntegrityBaseline(harness, 10);
    for (let step = 0; step < 40; step += 1) {
      const result = await harness.runtime.step().catch((error: unknown) => ({ status: "failed" as const, error: String(error) }));
      if (result.status === "paused") break;
    }
    const projection = harness.projection();
    assert.equal(projection.delivery?.taskAcceptances["T1"], undefined);
    const boundary = projection.delivery!.boundaries!["T1"]!.at(-1)!;
    assert.equal(boundary.passed, false);
    const guard = boundary.checks.find((check) => check.checkId === "test_integrity")!;
    assert.equal(guard.outcome, "failed");
    assert.equal(guard.exitCode, 1);
    assert.ok(boundary.testIntegrity, "the kernel validated the identity-bound integrity record");
  } finally {
    harness.close();
  }
});

test("IV-2 kernel: an ordinary task stays selected but the task closing its phase runs full (F4)", async () => {
  const harness = await createHarness({
    boundaryCheck: async (input, ctx) => {
      // The stub honors the pump's scope decision, as the production
      // driver does: forced boundaries run the whole script, and milestone
      // gates fall back to full when no slow tier exists (R2-F1).
      const scope = input.forceFullSuite === true || input.validationTierInput?.isMilestoneGate === true ? "full_test_script" : "selected";
      return {
        changedFiles: ["src/feature.ts"],
        executedScope: scope,
        selection: scope === "selected"
          ? { rung: "module_graph", selectedTests: ["test/x.test.mjs"], widened: false, wideningReasons: [] }
          : { rung: "full_suite", selectedTests: ["test/x.test.mjs"] },
        checks: await passedChecks(ctx, input, scope === "selected" ? NARROW_ARGS : ["run", "test"], 2),
      };
    },
  });
  try {
    // BP1 contributes T1, T2, T4 and requires combined tests; T2 and T4
    // both follow T1, so whichever runs last closes the phase.
    await harness.until((projection) =>
      accepted("T1")(projection) && accepted("T2")(projection) && accepted("T4")(projection), 300);
    const flagByTask = new Map(harness.seenBoundaryInputs.map((input) => [input.taskId, input.forceFullSuite] as const));
    assert.equal(flagByTask.get("T1"), false, "the first task keeps its narrow selection");
    const closers = harness.seenBoundaryInputs.filter((input) => input.taskId === "T2" || input.taskId === "T4");
    assert.equal(closers.length, 2);
    assert.equal(closers[0]!.forceFullSuite, false, "the middle task keeps its narrow selection");
    assert.equal(closers[1]!.forceFullSuite, false, "explicit full stays separate from the milestone gate (R2-F1)");
    assert.equal(closers[1]!.validationTierInput?.isMilestoneGate, true, "the last contributing task closing BP1 reports the milestone gate");
    const scopeOf = (taskId: string): string =>
      harness.projection().delivery!.boundaries![taskId]!.at(-1)!.executedScope;
    assert.equal(scopeOf("T1"), "selected");
    assert.equal(scopeOf(closers[0]!.taskId), "selected");
    assert.equal(scopeOf(closers[1]!.taskId), "full_test_script");
  } finally {
    harness.close();
  }
});

test("IV-2 kernel: a selected acceptance preserves the trusted full-suite baseline (F3)", async () => {
  const harness = await createHarness({
    testIntegrityPolicy: true,
    boundaryCheck: async (input, ctx) =>
      input.taskId === "T2"
        ? integrityBoundaryCheck("full_test_script", 5, "passed")(input, ctx)
        : integrityBoundaryCheck("selected", 2, "passed")(input, ctx),
  });
  try {
    await recordIntegrityBaseline(harness, 100);
    await harness.until(accepted("T1"));
    const afterSelected = harness.projection().testIntegrity?.baseline;
    assert.equal(afterSelected?.kind, "executed_report");
    if (afterSelected?.kind !== "executed_report") throw new Error("trusted baseline missing after selected acceptance");
    assert.equal(afterSelected.executed, 100, "a selected acceptance of 2 must not replace the full baseline of 100");
    assert.deepEqual(afterSelected.report.counts, { selected: 100, passed: 100, failed: 0, skipped: 0 });
    // A later full suite shrunk to 5 is still detected against the
    // preserved full baseline and refused as suite_shrank.
    await assert.rejects(harness.until(accepted("T2")), /must match kernel recomputation/);
    assert.equal(harness.projection().delivery?.boundaries?.["T2"]?.length ?? 0, 0, "the shrunk full boundary is refused, not recorded");
  } finally {
    harness.close();
  }
});
