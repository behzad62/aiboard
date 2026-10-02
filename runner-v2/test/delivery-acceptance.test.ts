import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CriterionEvidenceLink } from "../src/acceptance-contracts.js";
import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import {
  BuildRuntime,
  type ArchitectActionRequest,
  type ArchitectRuntimeDriver,
  type DeliveryBoundaryDriver,
  type IntegrationRuntimeDriver,
} from "../src/build-runtime.js";
import { assessDeliveryRisk, deliveryReviewId } from "../src/delivery-acceptance.js";
import { changedLinesFromDiff, loadDeliverableReviewInputs, submitTaskSummary } from "../src/delivery-execution.js";
import {
  NativeDeliverableReviewRuntime,
  type DeliverableReviewInputs,
  type DeliveryDepthRunner,
} from "../src/native-deliverable-review.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import { RuntimeRouter, type AgentRuntimeCandidate } from "../src/runtime-router.js";
import {
  buildCompletionReadiness,
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
import {
  buildFixtureCoverageReview,
  buildPlanningFixtureScenario,
  FIXTURE_PHASES,
  type PlanningFixtureScenario,
} from "./fixtures/planning-source-fixture.js";
import { renderPlanningStatus } from "../src/agent-prompts.js";
import { buildExecutionPlanRevision, computePlanReadiness } from "../src/planning-contracts.js";
import { commandEvidence } from "./support/evidence-fixtures.js";
import { seedCompletedDeliveryReview } from "./support/delivery-seed.js";

/**
 * T6a repair cycle 3 (controller): named tests for review r3 blockers B1-B10
 * against real SQLite stores, an advancing clock, the real kernel reducer,
 * the real NativeDeliverableReviewRuntime tool loop, and the real pump.
 * B9 (factory wiring) lives in native-delivery-factory.test.ts.
 */

const RUN_ID = "run-delivery-r3";

function event(type: SchedulerEventType | string, key: string, actor: { role: SchedulerActorRole; id: string }, payload: Record<string, unknown>): NewSchedulerEvent {
  return { runId: RUN_ID, type: type as SchedulerEventType, occurredAt: "2026-09-25T00:00:00.000Z", actor, idempotencyKey: key, payload };
}

function planningInputs(fixture: PlanningFixtureScenario): NewSchedulerEvent[] {
  return [
    event("run.policy_configured", "policy", { role: "runner", id: "build-runtime" }, { runPolicy: "finish" }),
    event("planning.policy_configured", "planning-policy", { role: "runner", id: "build-runtime" }, { version: 1 }),
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

interface ReviewerScript {
  inspect?: boolean;
  findings?: (context: string) => unknown[];
  claimStatus?: (claimId: string) => "verified" | "unverified";
  priorChecks?: (context: string) => unknown[] | undefined;
  failOnce?: Pass;
}

/**
 * Scripted reviewer model: decides from the pass's system message and the
 * conversation so far. It really calls tools, and tool results come back as
 * conversation messages (B5).
 */
class ScriptedReviewer implements AgentModel {
  readonly requests: Array<{ pass: Pass; sessionId: string; text: string; toolResults: number }> = [];
  private failed = false;
  constructor(private readonly script: ReviewerScript = {}) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const system = request.messages.find((message) => message.role === "system");
    const pass = (system?.id.replace("delivery-", "").replace("-system", "") ?? "findings") as Pass;
    const text = request.messages.filter((message) => typeof message.content === "string").map((message) => message.content as string).join("\n");
    const toolResults = request.messages.filter((message) => message.role === "tool");
    this.requests.push({ pass, sessionId: request.sessionId, text, toolResults: toolResults.length });
    if (this.script.failOnce === pass && !this.failed) {
      this.failed = true;
      throw Object.assign(new Error("fatal provider rejection"), { status: 400 });
    }
    const call = (name: string, args: unknown): ModelTurn => ({
      blocks: [{ type: "tool_call", callId: `${pass}-${name}-${toolResults.length}-${request.messages.length}`, name, arguments: args }],
      stopReason: "tool_calls",
    });
    if (pass === "obligations") {
      return call("record_deliverable_obligations", { obligations: [{ id: "obl-1", description: "The behavior must match every criterion." }] });
    }
    if (pass === "findings") {
      const lastTool = toolResults.at(-1)?.content as { isError?: boolean; toolName?: string } | undefined;
      if (this.script.inspect && !toolResults.some((message) => (message.content as { toolName?: string }).toolName === "fs.read")) {
        return call("fs.read", { path: "src/feature.ts" });
      }
      void lastTool;
      return call("record_deliverable_findings", { findings: this.script.findings?.(text) ?? [] });
    }
    const claimIds = [...text.matchAll(/"id": "(claim:[^"]+)"/g)].map((match) => match[1]!);
    const priorChecks = this.script.priorChecks?.(text);
    return call("submit_deliverable_verdict", {
      summary: "Reviewed against the criteria.",
      satisfied: claimIds.every((id) => (this.script.claimStatus?.(id) ?? "verified") === "verified") &&
        !/"severity": "blocking"/.test(text.split("Your durably recorded findings:")[1]?.split("The worker's report")[0] ?? ""),
      claimVerdicts: [...new Set(claimIds)].map((claimId) => ({ claimId, status: this.script.claimStatus?.(claimId) ?? "verified", rationale: "Checked." })),
      ...(priorChecks ? { priorFindingChecks: priorChecks } : {}),
    });
  }
}

class TestWorkers implements WorkerRuntimeDriver {
  constructor(private readonly harness: Harness, private readonly authorRuntimeId: string) {}
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

interface ArchitectScript {
  reject?: (taskId: string, attempt: number) => boolean;
  dispositions?: (request: ArchitectActionRequest) => Record<string, unknown>;
  boundary?: (request: ArchitectActionRequest) => Record<string, unknown>;
}

class TestArchitect implements ArchitectRuntimeDriver {
  readonly reasons: ArchitectActionRequest["reason"][] = [];
  constructor(private readonly harness: Harness, private readonly script: ArchitectScript = {}) {}
  async run(request: ArchitectActionRequest): Promise<void> {
    this.reasons.push(request.reason);
    const store = this.harness.scheduler;
    if (request.reason.type === "review_required") {
      const task = request.projection.tasks[request.reason.taskId]!;
      const links = task.criterionEvidenceLinks ?? [];
      const reject = this.script.reject?.(task.id, task.attempt) ?? false;
      store.append(event("review.decided", `review:${task.id}:${task.attempt}`, { role: "architect", id: "architect" }, {
        taskId: task.id,
        decision: reject ? "rejected" : "approved",
        summary: "Architect review.",
        evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
        ...(this.script.dispositions?.(request) ?? {}),
        criterionVerdicts: (task.acceptanceCriteria ?? []).map((criterion) => ({ criterionId: criterion.id, verdict: reject ? "unsatisfied" : "satisfied", rationale: "Judged.", evidenceIds: links.filter((link) => link.criterionId === criterion.id).map((link) => link.evidenceId), artifactHashes: ["a".repeat(64)] })),
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
        ...(this.script.boundary?.(request) ?? { resolution: "recheck", rationale: "Suspected flake; recheck once." }),
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

interface HarnessOptions {
  candidates?: AgentRuntimeCandidate[];
  reviewerRuntimeIds?: string[];
  authorRuntimeId?: string;
  reviewer?: ScriptedReviewer;
  architect?: ArchitectScript;
  changedPaths?: (taskId: string, attempt: number) => string[];
  boundaryOutcome?: (taskId: string, call: number) => "passed" | "failed" | "unknown";
  /** Simulates an interrupted boundary run on the first call for this task. */
  boundaryThrowsOnceFor?: string;
  loadInputsError?: string;
  defectClassesFor?: () => readonly string[];
  depth?: DeliveryDepthRunner;
  architectRuntimeId?: string;
}

interface Harness {
  root: string;
  scheduler: SqliteSchedulerStore;
  evidence: SqliteEvidenceStore;
  artifacts: ArtifactStore;
  sessions: SqliteAgentSessionStore;
  runtime: BuildRuntime;
  architect: TestArchitect;
  reviewer: ScriptedReviewer;
  review: NativeDeliverableReviewRuntime;
  boundaryCalls: string[];
  boundaryAttempts: string[];
  projection(): SchedulerProjection;
  until(predicate: (projection: SchedulerProjection) => boolean, maxSteps?: number): Promise<string[]>;
  close(): void;
}

const DEFAULT_CANDIDATES: AgentRuntimeCandidate[] = [
  { runtimeId: "architect-runtime", providerId: "architect", modelId: "architect-model", capabilities: ["code"], priority: 1 },
  { runtimeId: "author-runtime", providerId: "author", modelId: "author-model", capabilities: ["code"], priority: 2 },
  { runtimeId: "reviewer-runtime", providerId: "reviewer", modelId: "reviewer-model", capabilities: ["code"], priority: 3 },
];

function createHarness(options: HarnessOptions = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "aiboard-delivery-r3-"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const scheduler = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore: evidence, artifacts });
  const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 8, 25, 0, 0, 0, tick++ * 10)).toISOString();
  for (const input of planningInputs(fixtureScenario())) scheduler.append(input);
  const candidates = options.candidates ?? DEFAULT_CANDIDATES;
  const router = new RuntimeRouter({ health: new ProviderHealthRegistry(), candidates });
  const reviewer = options.reviewer ?? new ScriptedReviewer({ inspect: true });
  const workspaceRoot = join(root, "review-workspace");
  const boundaryCalls: string[] = [];
  const harness = { root, scheduler, evidence, artifacts, sessions, reviewer, boundaryCalls } as unknown as Harness;
  const review = new NativeDeliverableReviewRuntime({
    store: scheduler,
    architectRuntimeId: options.architectRuntimeId ?? "architect-runtime",
    router,
    candidates,
    models: new Map(candidates.map((candidate) => [candidate.runtimeId, reviewer])),
    reviewerRuntimeIds: options.reviewerRuntimeIds ?? ["reviewer-runtime"],
    sessions,
    artifacts,
    evidenceStore: evidence,
    loadInputs: async ({ task, projection }): Promise<DeliverableReviewInputs> => {
      if (options.loadInputsError) throw new Error(options.loadInputsError);
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
    ...(options.defectClassesFor ? { defectClassesFor: options.defectClassesFor } : {}),
  });
  const boundaryCount = new Map<string, number>();
  const boundaryAttempts: string[] = [];
  Object.assign(harness, { boundaryAttempts });
  const boundary: DeliveryBoundaryDriver = {
    check: async ({ taskId, integrationRevision, attempt }) => {
      const call = (boundaryCount.get(taskId) ?? 0) + 1;
      boundaryCount.set(taskId, call);
      boundaryCalls.push(`${taskId}@${integrationRevision}`);
      boundaryAttempts.push(`${taskId}#${attempt}`);
      if (options.boundaryThrowsOnceFor === taskId && call === 1) throw new Error("runner interrupted mid-boundary");
      const outcome = options.boundaryOutcome?.(taskId, call) ?? "passed";
      const passedReport = await junitReport(artifacts, 2, 0);
      const checks = (["build", "tests"] as const).map((checkId) => {
        const report = checkId === "tests"
          ? outcome === "passed"
            ? passedReport
            : { status: outcome, runner: "node --test", reason: "fixture outcome" } as const
          : undefined;
        if (outcome === "unknown") return { checkId, evidenceIds: [], exitCode: null, outcome: "unknown" as const, reason: "No command detected.", ...(report ? { report } : {}) };
        const exitCode = outcome === "passed" ? 0 : 1;
        const record = evidence.record({ ...commandEvidence(`boundary:${taskId}:${checkId}:${call}`, { label: checkId, exitCode }), runId: RUN_ID, taskId: `delivery:${taskId}`, actor: { role: "verifier", id: "delivery-check-runtime" } });
        return { checkId, command: "npm", args: ["run", checkId], evidenceIds: [record.id], exitCode, outcome, ...(report ? { report } : {}) };
      });
      return { changedFiles: ["src/feature.ts"], selection: { rung: "full_suite", selectedTests: ["test/feature.test.ts"] }, checks };
    },
  };
  const architect = new TestArchitect(harness, options.architect);
  const runtime = new BuildRuntime({
    runId: RUN_ID,
    store: scheduler,
    workerDriver: new TestWorkers(harness, options.authorRuntimeId ?? "author-runtime"),
    architectDriver: architect,
    integrationDriver: new TestIntegration(),
    deliveryReview: review,
    deliveryBoundary: boundary,
    maxConcurrency: 1,
    workspaceFor: async (task) => join(root, "work", task.id),
    clock,
    evidenceStore: evidence,
    architectId: options.architectRuntimeId ?? "architect-runtime",
  });
  Object.assign(harness, {
    runtime,
    architect,
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

test("B1: the reviewer sees the real diff, the worker's own report and claims, and nothing fabricated", async () => {
  const harness = createHarness();
  try {
    await harness.until(accepted("T1"));
    const passes = harness.reviewer.requests;
    const findings = passes.find((entry) => entry.pass === "findings")!;
    const verdict = passes.find((entry) => entry.pass === "verdict")!;
    assert.match(findings.text, /\+export const c = a \+ b;/);
    assert.doesNotMatch(findings.text, /Worker summary for T1/, "the findings pass must not see the worker report");
    assert.match(verdict.text, /Worker summary for T1/);
    assert.match(verdict.text, /claim:c1/);
    const review = harness.projection().delivery!.reviews.T1!;
    assert.equal(review.stage, "completed");
    assert.deepEqual(review.claims!.map((claim) => claim.id), ["claim:c1", "claim:summary"]);
    assert.ok(review.claims![0]!.evidenceIds.length > 0, "criterion claims cite the worker's real evidence ids");
    assert.equal(review.risk!.tier, "medium", "the tier is the T5 tier of the real change (source without test)");
  } finally {
    harness.close();
  }
});

test("reviewer requests resolve defect classes per review from the provider", async () => {
  const live: string[] = [];
  const harness = createHarness({ defectClassesFor: () => live });
  try {
    // Provided after the harness (and its review runtime) exists:
    // a construction-time snapshot would miss it.
    live.push("missing coverage");
    await harness.until(accepted("T1"));
    const texts = harness.reviewer.requests.map((entry) => entry.text).join("\n");
    assert.match(texts, /missing coverage/);
  } finally {
    harness.close();
  }
});

test("B1: unavailable inputs record no review and pause with a delivery reason (no placeholders)", async () => {
  const harness = createHarness({ loadInputsError: "Submitted change set is unavailable." });
  try {
    const actions = await harness.until(() => false, 40).catch((error: Error) => [error.message]);
    const projection = harness.projection();
    assert.equal(projection.status, "paused", actions.join(","));
    assert.equal(projection.pauseReason?.reason, "delivery_inputs_unavailable");
    assert.equal(Object.keys(projection.delivery?.reviews ?? {}).length, 0);
  } finally {
    harness.close();
  }
});

test("B1: durable input helpers read the diff artifact, the submit_task summary, and changed lines", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-delivery-inputs-"));
  try {
    const artifacts = new ArtifactStore(join(root, "artifacts"));
    const diff = await artifacts.put(Buffer.from(DIFF), "text/x-diff", "diff");
    const summary = submitTaskSummary([
      { role: "assistant", content: [{ type: "tool_call", name: "fs.write", arguments: {} }] },
      { role: "assistant", content: [{ type: "tool_call", name: "submit_task", arguments: { summary: " Added c. " } }] },
    ]);
    assert.equal(summary, "Added c.");
    const inputs = await loadDeliverableReviewInputs({
      task: { id: "T1", objective: "o", dependencies: [], status: "submitted", requiredCapabilities: ["code"], attempt: 1, changeSetId: "cs", acceptanceCriteria: [{ id: "c1", text: "works" }] },
      submission: {
        summary: summary!,
        authorRuntimeId: "author-runtime",
        changeSet: { id: "cs", runId: RUN_ID, taskId: "T1", baselineRevision: "b".repeat(40), taskRevision: "c".repeat(40), commits: [], changedPaths: ["src/feature.ts"], diffArtifactHash: diff.hash, evidenceArtifactHashes: [], criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: "ev-1", artifactHashes: ["a".repeat(64)] }], externalEffects: [], guidanceIds: [], memoryIds: [], unresolvedConcerns: ["none"] },
      },
      artifacts,
    });
    assert.equal(inputs.diffText, DIFF);
    assert.deepEqual(inputs.claims.map((claim) => [claim.id, claim.evidenceIds]), [["claim:c1", ["ev-1"]], ["claim:summary", []]]);
    assert.deepEqual([...changedLinesFromDiff(DIFF).entries()], [["src/feature.ts", [2, 3]]]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("B2/B5: a medium-tier reviewer must really inspect; a tool-less findings record is refused and the tool result is fed back", async () => {
  const reviewer = new ScriptedReviewer({ inspect: false });
  let attempts = 0;
  const original = reviewer.complete.bind(reviewer);
  reviewer.complete = async (request) => {
    const turn = await original(request);
    const block = turn.blocks[0];
    if (block?.type === "tool_call" && block.name === "record_deliverable_findings") {
      attempts += 1;
      const refused = request.messages.some((message) => message.role === "tool" && (message.content as { isError?: boolean }).isError);
      if (refused && !request.messages.some((message) => message.role === "tool" && (message.content as { toolName?: string }).toolName === "fs.read")) {
        return { blocks: [{ type: "tool_call", callId: `read-${request.messages.length}`, name: "fs.read", arguments: { path: "src/feature.ts" } }], stopReason: "tool_calls" };
      }
    }
    return turn;
  };
  const harness = createHarness({ reviewer });
  try {
    await harness.until(accepted("T1"));
    const review = harness.projection().delivery!.reviews.T1!;
    assert.equal(review.risk!.tier, "medium");
    assert.ok(review.depth!.inspectionToolCalls >= 1, "the recorded depth counts the real fs.read call");
    assert.ok(attempts >= 2, "the first tool-less findings call was refused by the kernel");
    const findingsRequests = reviewer.requests.filter((entry) => entry.pass === "findings" && entry.sessionId.startsWith("delivery:"));
    assert.ok(findingsRequests.some((entry) => entry.toolResults > 0), "tool results are returned to the reviewer");
  } finally {
    harness.close();
  }
});

test("B2: a high-tier review records runner-executed affected tests and probe with kernel-validated evidence; invented evidence is refused", async () => {
  const depthCalls: string[] = [];
  const harnessRef: { current?: Harness } = {};
  const depth: DeliveryDepthRunner = {
    run: async (input) => {
      depthCalls.push(input.workspacePath);
      const harness = harnessRef.current!;
      const tests = harness.evidence.record({ ...commandEvidence(`affected:${input.reviewId}`, { label: "tests", exitCode: 0 }), runId: RUN_ID, taskId: `delivery:${input.taskId}`, actor: { role: "verifier", id: input.reviewerRuntimeId } });
      const probe = harness.evidence.record({ ...commandEvidence(`probe:${input.reviewId}`, { label: "probe", exitCode: 1 }), runId: RUN_ID, taskId: `delivery:${input.taskId}`, actor: { role: "verifier", id: input.reviewerRuntimeId } });
      return {
        affectedTests: { executedScope: "full_test_script", selectionRung: "full_suite", changedFiles: [...input.changedFiles], selectedTests: ["test/feature.test.ts"], fullSuiteCount: 1, command: "npm", args: ["run", "test"], evidenceIds: [tests.id], exitCode: 0, outcome: "passed", report: await junitReport(harness.artifacts, 3, 0) },
        probe: { rung: "builtin_mutator", mutantsGenerated: 1, mutantsExecuted: 1, mutantsCaught: 1, survivors: [], partial: false, evidenceIds: [probe.id], notes: [] },
      };
    },
  };
  const harness = createHarness({ depth, changedPaths: () => ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"] });
  harnessRef.current = harness;
  try {
    await harness.until(accepted("T1"));
    const review = harness.projection().delivery!.reviews.T1!;
    assert.equal(review.risk!.tier, "high");
    assert.ok(review.obligations && review.obligations.length > 0, "obligations were recorded before the diff");
    assert.equal(review.depth!.affectedTests!.outcome, "passed");
    assert.equal(review.depth!.affectedTests!.report.counts?.passed, 3);
    assert.equal(review.depth!.probe!.mutantsCaught, 1);
    assert.equal(depthCalls.length, 1);
    const obligationsRequest = harness.reviewer.requests.find((entry) => entry.pass === "obligations")!;
    assert.doesNotMatch(obligationsRequest.text, /export const c/, "the obligations pass never sees the diff");

    // Invented evidence ids are refused at the durable boundary.
    const forged = harness.projection().delivery!.reviews.T1!;
    assert.ok(forged);
    assert.throws(() => harness.scheduler.append(event("delivery.findings_recorded", "forged-findings", { role: "verifier", id: "reviewer-runtime" }, {
      taskId: "T1", reviewId: forged.reviewId, sessionId: "delivery:forged", findings: [],
      depth: { inspectionToolCalls: 1, affectedTests: { executedScope: "full_test_script", selectionRung: "full_suite", changedFiles: ["src/a.ts"], selectedTests: [], fullSuiteCount: 0, command: "npm", args: [], evidenceIds: ["invented:repository:T1"], exitCode: 0, outcome: "unknown", report: { status: "unknown", runner: "node --test" } } },
    })), /missing or foreign evidence|out of order/);
  } finally {
    harness.close();
  }
});

test("B2: the kernel refuses medium-tier findings without a real inspection", async () => {
  const harness = createHarness();
  try {
    await harness.until((projection) => projection.tasks.T1?.status === "submitted" || projection.tasks.T3?.status === "submitted" || projection.tasks["T-INV"]?.status === "submitted", 40);
    const projection = harness.projection();
    const task = Object.values(projection.tasks).find((candidate) => candidate.status === "submitted")!;
    const runner = { role: "runner" as const, id: "delivery-review-runtime" };
    const reviewId = deliveryReviewId(task.id, task.attempt, 1);
    harness.scheduler.append(event("delivery.review_started", "k-start", runner, { taskId: task.id, reviewId, generation: 1, attempt: task.attempt, changeSetId: task.changeSetId, diffArtifactHash: "d".repeat(64), criteriaIds: ["c1"], authorRuntimeId: "author-runtime", authorModelIdentity: "author-model", architectRuntimeId: "architect-runtime", architectModelIdentity: "architect-model" }));
    const medium = { authorModelId: "author-model", changedFiles: ["src/feature.ts"], linesAdded: 3, linesRemoved: 1, attempts: task.attempt, acceptedFailuresUsed: false };
    const risk = assessDeliveryRisk(medium);
    assert.equal(risk.tier, "medium");
    harness.scheduler.append(event("delivery.review_requested", "k-req", runner, { taskId: task.id, reviewId, reviewerRuntimeId: "reviewer-runtime", reviewerModelIdentity: "reviewer-model", independence: "distinct_model", reviewTier: "medium", riskDigest: risk.digest, riskInput: medium }));
    harness.scheduler.append(event("delivery.criteria_and_diff_delivered", "k-diff", runner, { taskId: task.id, reviewId, diffArtifactHash: "d".repeat(64) }));
    assert.throws(() => harness.scheduler.append(event("delivery.findings_recorded", "k-find", { role: "verifier", id: "reviewer-runtime" }, { taskId: task.id, reviewId, sessionId: "delivery:k1", findings: [], depth: { inspectionToolCalls: 0 } })), /at least one real inspection/);
  } finally {
    harness.close();
  }
});

test("B3/B4: a failed boundary keeps the task integrated, routes to the Architect once, and never re-runs without a state change", async () => {
  const harness = createHarness({
    boundaryOutcome: (taskId, call) => (taskId === "T1" && call === 1 ? "failed" : "passed"),
  });
  try {
    await harness.until(accepted("T1"));
    const projection = harness.projection();
    const boundaries = projection.delivery!.boundaries.T1!;
    assert.equal(boundaries.length, 2);
    assert.equal(boundaries[0]!.passed, false);
    assert.equal(boundaries[0]!.resolution?.resolution, "recheck");
    assert.equal(boundaries[1]!.passed, true);
    assert.equal(harness.boundaryCalls.filter((call) => call.startsWith("T1@")).length, 2, "exactly one recheck after the Architect's grant");
    assert.equal(harness.architect.reasons.filter((reason) => reason.type === "delivery_boundary_failed").length, 1);
    assert.equal(projection.tasks.T1!.status, "integrated");
    // Without a state change the kernel refuses another run and an acceptance.
    assert.throws(() => harness.scheduler.append(event("delivery.boundary_checked", "again", { role: "runner", id: "build-runtime" }, { taskId: "T1", boundaryId: "boundary:T1:3", generation: 3, integrationRevision: projection.integrationRevision, changedFiles: [], selection: { rung: "full_suite", selectedTests: [] }, checks: [{ checkId: "tests", evidenceIds: [], exitCode: null, outcome: "unknown", reason: "x" }], passed: false })), /accepted|may not run/);
  } finally {
    harness.close();
  }
});

test("B3/B4: an unknown boundary is never accepted; a second failure needs repairs bound to the parent contract", async () => {
  const harness = createHarness({
    boundaryOutcome: (taskId) => (taskId === "T1" ? "unknown" : "passed"),
    architect: {
      boundary: (request) => {
        const reason = request.reason as { taskId: string; boundaryId: string };
        const boundaries = request.projection.delivery!.boundaries[reason.taskId]!;
        return boundaries.length === 1
          ? { resolution: "recheck", rationale: "Recheck once." }
          : { resolution: "repair_planned", rationale: "The test command is missing.", revision: request.projection.planRevision + 1, tasks: [{ id: "T1-fix", objective: "Add a test script.", dependencies: [], requiredCapabilities: ["code"], acceptanceCriteria: [{ id: "fix-1", text: "npm test runs." }] }] };
      },
    },
  });
  try {
    await harness.until((projection) => projection.tasks["T1-fix"] !== undefined, 150);
    const projection = harness.projection();
    assert.equal(projection.delivery?.taskAcceptances.T1, undefined, "unknown outcomes never accept");
    assert.equal(projection.tasks.T1!.status, "integrated");
    const repair = projection.tasks["T1-fix"]!;
    assert.equal(repair.kind, "verification_repair");
    assert.equal(repair.deliveryRepair?.sourceTaskId, "T1");
    assert.equal(projection.readyPlanTaskBindings?.["T1-fix"]?.contractId, "T1", "the repair binds to the parent contract");
    assert.equal(harness.boundaryCalls.filter((call) => call.startsWith("T1@")).length, 2);
    // A recheck is granted only once per integration revision.
    const last = projection.delivery!.boundaries.T1!.at(-1)!;
    assert.equal(last.resolution?.resolution, "repair_planned");
    // The kernel refuses acceptance on a boundary that did not pass.
    assert.throws(() => harness.scheduler.append(event("task.acceptance_recorded", "accept-failed", { role: "runner", id: "build-runtime" }, { taskId: "T1", reviewId: projection.delivery!.reviews.T1!.reviewId, boundaryId: last.boundaryId })), /passed boundary check/);
  } finally {
    harness.close();
  }
});

test("B6: the one-model setup completes a deliverable review on fresh_context sessions", async () => {
  const only: AgentRuntimeCandidate[] = [{ runtimeId: "solo-runtime", providerId: "solo", modelId: "solo-model", capabilities: ["code"], priority: 1 }];
  const harness = createHarness({ candidates: only, reviewerRuntimeIds: ["solo-runtime"], authorRuntimeId: "solo-runtime", architectRuntimeId: "solo-runtime" });
  try {
    await harness.until(accepted("T1"));
    const review = harness.projection().delivery!.reviews.T1!;
    assert.equal(review.independence, "fresh_context");
    assert.equal(review.reviewerRuntimeId, "solo-runtime");
    assert.equal(new Set(review.sessionIds).size, review.sessionIds.length, "every pass used its own new session");
    for (const sessionId of review.sessionIds) {
      assert.equal(harness.sessions.events(sessionId)[0]?.type, "session.created");
    }
  } finally {
    harness.close();
  }
});

test("B6: the kernel refuses a distinct_model reviewer that matches a change author or the Architect", async () => {
  const harness = createHarness();
  try {
    await harness.until((projection) => Object.values(projection.tasks).some((task) => task.status === "submitted"), 40);
    const task = Object.values(harness.projection().tasks).find((candidate) => candidate.status === "submitted")!;
    const runner = { role: "runner" as const, id: "delivery-review-runtime" };
    const reviewId = deliveryReviewId(task.id, task.attempt, 1);
    harness.scheduler.append(event("delivery.review_started", "b6-start", runner, { taskId: task.id, reviewId, generation: 1, attempt: task.attempt, changeSetId: task.changeSetId, diffArtifactHash: "d".repeat(64), criteriaIds: ["c1"], authorRuntimeId: "author-runtime", authorModelIdentity: "author-model", architectRuntimeId: "architect-runtime", architectModelIdentity: "architect-model" }));
    const input = { authorModelId: "author-model", changedFiles: ["src/feature.ts"], linesAdded: 3, linesRemoved: 1, attempts: task.attempt, acceptedFailuresUsed: false };
    const risk = assessDeliveryRisk(input);
    const request = (reviewerRuntimeId: string, reviewerModelIdentity: string, independence: string) => event("delivery.review_requested", `b6-${reviewerRuntimeId}-${reviewerModelIdentity}-${independence}`, runner, { taskId: task.id, reviewId, reviewerRuntimeId, reviewerModelIdentity, independence, reviewTier: risk.tier, riskDigest: risk.digest, riskInput: input });
    assert.throws(() => harness.scheduler.append(request("author-runtime", "author-model", "distinct_model")), /Self-review is impossible/);
    assert.throws(() => harness.scheduler.append(request("other-runtime", "author-model", "distinct_model")), /Self-review is impossible/);
    assert.throws(() => harness.scheduler.append(request("architect-runtime", "architect-model", "distinct_model")), /Self-review is impossible/);
    harness.scheduler.append(request("author-runtime", "author-model", "fresh_context"));
    assert.equal(harness.projection().delivery!.reviews[task.id]!.independence, "fresh_context");
  } finally {
    harness.close();
  }
});

test("B7: the Architect disposes of an unverified claim alone, independently of findings", async () => {
  const harness = createHarness({
    reviewer: new ScriptedReviewer({ inspect: true, claimStatus: (claimId) => (claimId === "claim:summary" ? "unverified" : "verified") }),
    architect: {
      dispositions: (request) => {
        const reason = request.reason as { delivery?: { unverifiedClaimIds: string[]; openFindingIds: string[] } };
        assert.ok(reason.delivery, "review_required carries the open delivery items");
        assert.deepEqual(reason.delivery.openFindingIds, []);
        return { claimDispositions: reason.delivery.unverifiedClaimIds.map((claimId) => ({ claimId, status: "verified", rationale: "Architect confirmed the summary against the diff." })) };
      },
    },
  });
  try {
    await harness.until(accepted("T1"));
    const review = harness.projection().delivery!.reviews.T1!;
    const summary = review.claimVerdicts!.find((verdict) => verdict.claimId === "claim:summary")!;
    assert.equal(summary.status, "unverified");
    assert.equal(summary.disposition?.status, "verified");
  } finally {
    harness.close();
  }
});

test("B7: approval without disposing of an unverified claim is refused by the kernel", async () => {
  const harness = createHarness({
    reviewer: new ScriptedReviewer({ inspect: true, claimStatus: (claimId) => (claimId === "claim:summary" ? "unverified" : "verified") }),
  });
  try {
    await assert.rejects(harness.until(accepted("T1"), 60), /unverified worker claims|Architect/);
  } finally {
    harness.close();
  }
});

test("B7: a blocking finding goes through reject and the fix re-review checks each prior finding after its own view", async () => {
  const harness = createHarness({
    reviewer: new ScriptedReviewer({
      inspect: true,
      findings: (context) => (/attempt 1/.test(context) ? [{ id: "f-1", category: "missing_coverage", severity: "blocking", claim: "c is not tested.", evidenceRefs: ["src/feature.ts:3"], defectClass: "missing coverage" }] : []),
      priorChecks: (context) => (/Prior review/.test(context) ? [{ findingId: "f-1", resolution: "resolved", rationale: "Attempt 2 adds the test." }] : undefined),
    }),
    architect: { reject: (_taskId, attempt) => attempt === 1 },
    changedPaths: () => ["src/feature.ts", "test/feature.test.ts"],
  });
  try {
    await harness.until(accepted("T1"), 200);
    const projection = harness.projection();
    const review = projection.delivery!.reviews.T1!;
    assert.equal(review.submissionAttempt, 2);
    assert.equal(review.priorReviewId, projection.delivery!.reviewHistory.T1![0]!.reviewId);
    assert.deepEqual(review.priorFindingChecks?.map((check) => check.findingId), ["f-1"], JSON.stringify({ review, history: projection.delivery!.reviewHistory.T1 }, null, 1).slice(0, 3000));
    const verdict = harness.reviewer.requests.filter((entry) => entry.pass === "verdict").at(-1)!;
    assert.match(verdict.text, /Prior review/);
    const findingsPass = harness.reviewer.requests.filter((entry) => entry.pass === "findings").at(-1)!;
    assert.doesNotMatch(findingsPass.text, /Prior review/, "prior findings are withheld until the own view is durable");
  } finally {
    harness.close();
  }
});

test("B8: the kernel refuses a high-tier diff before obligations and a tier that is not the recomputed T5 tier", async () => {
  const harness = createHarness();
  try {
    await harness.until((projection) => Object.values(projection.tasks).some((task) => task.status === "submitted"), 40);
    const task = Object.values(harness.projection().tasks).find((candidate) => candidate.status === "submitted")!;
    const runner = { role: "runner" as const, id: "delivery-review-runtime" };
    const reviewId = deliveryReviewId(task.id, task.attempt, 1);
    harness.scheduler.append(event("delivery.review_started", "b8-start", runner, { taskId: task.id, reviewId, generation: 1, attempt: task.attempt, changeSetId: task.changeSetId, diffArtifactHash: "d".repeat(64), criteriaIds: ["c1"], authorRuntimeId: "author-runtime", authorModelIdentity: "author-model", architectRuntimeId: "architect-runtime", architectModelIdentity: "architect-model" }));
    const high = { authorModelId: "author-model", changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"], linesAdded: 200, linesRemoved: 0, attempts: task.attempt, acceptedFailuresUsed: false };
    const risk = assessDeliveryRisk(high);
    assert.equal(risk.tier, "high");
    const base = { taskId: task.id, reviewId, reviewerRuntimeId: "reviewer-runtime", reviewerModelIdentity: "reviewer-model", independence: "distinct_model", riskDigest: risk.digest, riskInput: high };
    assert.throws(() => harness.scheduler.append(event("delivery.review_requested", "b8-low", runner, { ...base, reviewTier: "low" })), /deterministic T5 risk tier/);
    harness.scheduler.append(event("delivery.review_requested", "b8-high", runner, { ...base, reviewTier: "high" }));
    assert.throws(() => harness.scheduler.append(event("delivery.criteria_and_diff_delivered", "b8-diff", runner, { taskId: task.id, reviewId, diffArtifactHash: "d".repeat(64) })), /obligations must be recorded before the diff/);
    assert.throws(() => harness.scheduler.append(event("delivery.findings_recorded", "b8-find", { role: "verifier", id: "reviewer-runtime" }, { taskId: task.id, reviewId, sessionId: "delivery:b8", findings: [], depth: { inspectionToolCalls: 1 } })), /out of order/);
  } finally {
    harness.close();
  }
});

test("retry: a provider failure pauses with a delivery reason and resume opens a new durable generation with fresh sessions", async () => {
  const harness = createHarness({ reviewer: new ScriptedReviewer({ inspect: true, failOnce: "verdict" }) });
  try {
    const actions = await harness.until(() => false, 60).catch(() => [] as string[]);
    void actions;
    let projection = harness.projection();
    assert.equal(projection.status, "paused");
    assert.match(projection.pauseReason?.reason ?? "", /^delivery_/);
    const first = Object.values(projection.delivery!.reviews)[0]!;
    harness.scheduler.append(event("run.resumed", "resume-1", { role: "user", id: "owner" }, {}));
    await harness.until((current) => current.delivery!.reviews[first.taskId]!.stage === "completed", 40);
    projection = harness.projection();
    const second = projection.delivery!.reviews[first.taskId]!;
    assert.equal(second.generation, first.generation + 1);
    assert.equal(projection.delivery!.reviewHistory[first.taskId]![0]!.stage, "abandoned");
    for (const sessionId of second.sessionIds) assert.equal(first.sessionIds.includes(sessionId), false);
  } finally {
    harness.close();
  }
});

test("acceptance and phases: forged acceptance is refused, phase acceptance binds the plan revision, readiness stays honest", async () => {
  const harness = createHarness();
  try {
    await harness.until((projection) => ["T1", "T2", "T4"].every((id) => projection.delivery?.taskAcceptances[id]), 250);
    await harness.until((projection) => Object.keys(projection.delivery?.phaseAcceptances ?? {}).length > 0, 20);
    const projection = harness.projection();
    const phase = Object.values(projection.delivery!.phaseAcceptances).find((candidate) => candidate.phaseId === "BP1")!;
    assert.ok(phase, "BP1 is accepted once its tasks and exit checks pass");
    assert.equal(phase.planRevisionId, projection.planning!.plan!.currentRevisionId);
    assert.deepEqual(phase.exitChecks.map((check) => check.checkId), ["build", "tests"]);
    const readiness = buildCompletionReadiness(projection);
    assert.equal(readiness.ready, false);
    assert.ok(readiness.issues.some((issue) => /Phase BP2 lacks durable acceptance/.test(issue)));
    assert.ok(readiness.issues.some((issue) => /Phase BP2 requirement REQ-CONDITIONAL remains conditional_pending/.test(issue)), "readiness says why");
    const status = JSON.parse(renderPlanningStatus(projection)) as { unacceptedPhases: Array<{ phaseId: string; issues: string[] }> };
    const bp2 = status.unacceptedPhases.find((phase) => phase.phaseId === "BP2")!;
    assert.ok(bp2.issues.some((issue) => /REQ-CONDITIONAL remains conditional_pending/.test(issue)), "the Architect status names the reason");
    const t1 = projection.delivery!.taskAcceptances.T1!;
    assert.deepEqual(t1.requiredChecks.map((check) => `${check.kind}:${check.refId}`), ["criterion:c1", "integration_check:build", "integration_check:tests"]);
    assert.throws(() => harness.scheduler.append(event("task.acceptance_recorded", "forged", { role: "architect", id: "architect" }, { taskId: "T3", reviewId: "x", boundaryId: "y" })), /authority may record|accepted|integrated/);
  } finally {
    harness.close();
  }
});

test("seed helper: a completed review through the kernel satisfies approval gating", async () => {
  const harness = createHarness();
  try {
    await harness.until((projection) => Object.values(projection.tasks).some((task) => task.status === "submitted"), 40);
    const task = Object.values(harness.projection().tasks).find((candidate) => candidate.status === "submitted")!;
    const reviewId = seedCompletedDeliveryReview(harness.scheduler, RUN_ID, task.id, { authorRuntimeId: "author-runtime" });
    assert.equal(harness.projection().delivery!.reviews[task.id]!.reviewId, reviewId);
  } finally {
    harness.close();
  }
});

test("R4-B2: plan readiness refuses a phase exit-check word the runner cannot check, naming the word and the allowed words", () => {
  const fixture = fixtureScenario();
  const phases = FIXTURE_PHASES.map((phase) => phase.id === "BP1" ? { ...phase, requiredCombinedValidation: ["typecheck", "unit tests"] } : phase);
  const revision = buildExecutionPlanRevision({
    revisionId: fixture.revision.revisionId,
    runId: fixture.revision.runId,
    sourceManifestId: fixture.manifest.manifestId,
    sourceManifestDigest: fixture.manifest.artifactDigest,
    requirements: fixture.requirements,
    tasks: fixture.tasks,
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [...fixture.revision.planningDecisions],
    validationObligations: [...fixture.revision.validationObligations],
    createdAt: fixture.revision.createdAt,
  });
  const input = { manifest: fixture.manifest, coverageReview: buildFixtureCoverageReview(revision, fixture.manifest), amendmentHistory: [], hostCapabilities: fixture.hostCapabilities };
  const good = computePlanReadiness({ ...input, revision: fixture.revision, coverageReview: fixture.coverageReview });
  assert.equal(good.blockers.some((blocker) => /runner-checkable/.test(blocker)), false);
  const bad = computePlanReadiness({ ...input, revision });
  assert.equal(bad.ready, false);
  assert.ok(
    bad.blockers.some((blocker) => /Phase BP1 requiredCombinedValidation "unit tests" is not a runner-checkable validation; use only: build, compile, typecheck, type-check, tests, test, targeted-tests, affected-tests, unit-tests\./.test(blocker)),
    bad.blockers.join(" | "),
  );
});

test("R4-B2: the kernel refuses planning.plan_ready for a plan whose phase names an unmapped exit-check word", () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-delivery-r4b2-"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const scheduler = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore: evidence });
  try {
    const base = fixtureScenario();
    const phases = FIXTURE_PHASES.map((phase) => phase.id === "BP1" ? { ...phase, requiredCombinedValidation: ["lint"] } : phase);
    const revision = buildExecutionPlanRevision({
      revisionId: base.revision.revisionId,
      runId: base.revision.runId,
      sourceManifestId: base.manifest.manifestId,
      sourceManifestDigest: base.manifest.artifactDigest,
      requirements: base.requirements,
      tasks: base.tasks,
      phases,
      workflowPolicyVersion: 1,
      planningDecisions: [...base.revision.planningDecisions],
      validationObligations: [...base.revision.validationObligations],
      createdAt: base.revision.createdAt,
    });
    const fixture = { ...base, phases, revision, coverageReview: buildFixtureCoverageReview(revision, base.manifest) };
    const inputs = planningInputs(fixture);
    for (const input of inputs.slice(0, -1)) scheduler.append(input);
    assert.throws(() => scheduler.append(inputs.at(-1)!), /Phase BP1 requiredCombinedValidation "lint" is not a runner-checkable validation; use only: build/);
  } finally {
    scheduler.close();
    evidence.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("N-R4-2: cancelled boundary repairs hand the task back to the Architect with a new resolution generation", async () => {
  let cancelled = false;
  const harness = createHarness({
    boundaryOutcome: (taskId, call) => (taskId === "T1" && call === 1 ? "failed" : "passed"),
    architect: {
      boundary: (request) => {
        const reason = request.reason as { resolutionGeneration: number };
        return reason.resolutionGeneration === 1
          ? { resolution: "repair_planned", rationale: "Fix the failing test.", revision: request.projection.planRevision + 1, tasks: [{ id: "T1-fix", objective: "Fix the failing test.", dependencies: [], requiredCapabilities: ["code"], acceptanceCriteria: [{ id: "fix-1", text: "Tests pass." }] }] }
          : { resolution: "recheck", rationale: "The repair was cancelled; recheck once." };
      },
    },
  });
  try {
    await harness.until((projection) => projection.tasks["T1-fix"] !== undefined, 150);
    harness.scheduler.append(event("task.transitioned", "cancel-fix", { role: "architect", id: "architect" }, { taskId: "T1-fix", status: "cancelled" }));
    cancelled = true;
    await harness.until(accepted("T1"), 150);
    const projection = harness.projection();
    const boundaries = projection.delivery!.boundaries.T1!;
    assert.equal(boundaries[0]!.resolutionHistory?.[0]?.resolution, "repair_planned");
    assert.equal(boundaries[0]!.resolution?.resolution, "recheck");
    const generations = harness.architect.reasons
      .filter((reason) => reason.type === "delivery_boundary_failed")
      .map((reason) => (reason as { resolutionGeneration: number }).resolutionGeneration);
    assert.deepEqual(generations, [1, 2], "exactly one hand-back after the repair was cancelled");
  } finally {
    void cancelled;
    harness.close();
  }
});

test("N-R4-3: an interrupted boundary run retries under a fresh durable attempt and records no spurious unknown", async () => {
  const harness = createHarness({ boundaryThrowsOnceFor: "T1" });
  try {
    await assert.rejects(harness.until(accepted("T1"), 150), /delivery_boundary_unavailable/);
    harness.scheduler.append(event("run.resumed", "resume-boundary", { role: "user", id: "owner" }, {}));
    await harness.until(accepted("T1"), 40);
    const projection = harness.projection();
    const boundaries = projection.delivery!.boundaries.T1!;
    assert.equal(boundaries.length, 1, "the interrupted attempt recorded no outcome");
    assert.equal(boundaries[0]!.attempt, 2);
    assert.equal(boundaries[0]!.passed, true);
    assert.deepEqual(harness.boundaryAttempts.filter((entry) => entry.startsWith("T1#")), ["T1#1", "T1#2"]);
    assert.equal(projection.delivery!.boundaryStarts![boundaries[0]!.boundaryId], 2);
  } finally {
    harness.close();
  }
});

test("real counts: the kernel refuses a passed tests result without this run's report of executed, non-failed tests", async () => {
  const harness = createHarness({ boundaryOutcome: (taskId) => (taskId === "T1" ? "failed" : "passed") });
  try {
    await harness.until((projection) => projection.delivery?.boundaries.T1 !== undefined, 150);
    const projection = harness.projection();
    const boundaryId = "boundary:T1:2";
    const revision = projection.integrationRevision;
    // Grant a recheck so a second boundary run is legal, then try forged passes.
    harness.scheduler.append(event("delivery.boundary_failure_resolved", "rc-recheck", { role: "architect", id: "architect" }, { taskId: "T1", boundaryId: "boundary:T1:1", resolutionGeneration: 1, resolution: "recheck", rationale: "Recheck." }));
    harness.scheduler.append(event("delivery.boundary_started", "rc-start", { role: "runner", id: "build-runtime" }, { taskId: "T1", boundaryId, attempt: 1, integrationRevision: revision }));
    const record = harness.evidence.record({ ...commandEvidence("rc-tests", { label: "tests", exitCode: 0 }), runId: RUN_ID, taskId: "delivery:T1", actor: { role: "verifier", id: "delivery-check-runtime" } });
    let checkCount = 0;
    const check = (report: unknown, outcome = "passed") => event("delivery.boundary_checked", `rc-check-${(checkCount += 1)}`, { role: "runner", id: "build-runtime" }, {
      taskId: "T1", boundaryId, generation: 2, attempt: 1, integrationRevision: revision, executedScope: "full_test_script",
      changedFiles: ["src/feature.ts"], selection: { rung: "full_suite", selectedTests: [] },
      checks: [{ checkId: "tests", command: "npm", args: ["run", "test"], evidenceIds: [record.id], exitCode: 0, outcome, ...(report === undefined ? {} : { report }) }],
      passed: outcome === "passed",
    });
    assert.throws(() => harness.scheduler.append(check(undefined)), /requires this run's test report/, "exit 0 alone never passes");
    assert.throws(() => harness.scheduler.append(check({ status: "unknown", runner: "node --test", reason: "no report" })), /outcome must follow/);
    const zero = { ...(await junitReport(harness.artifacts, 0, 0)), status: "passed" as const };
    assert.throws(() => harness.scheduler.append(check(zero)), /at least one executed and zero failed/, "zero executed tests never pass");
    const good = await junitReport(harness.artifacts, 2, 0);
    harness.scheduler.append(check(good));
    assert.equal(harness.projection().delivery!.boundaries.T1!.at(-1)!.passed, true);
  } finally {
    harness.close();
  }
});

test("R5-B1: node --test counts come from node's own summary; a suite without tests is not a test", async () => {
  const { nodeJunitSummary, reporterUnsupportedIn } = await import("../src/delivery-execution.js");
  const { testsOutcome } = await import("../src/delivery-acceptance.js");
  const describeOnly = '<testsuites>\n<testcase name="empty"/>\n<!-- tests 0 -->\n<!-- suites 1 -->\n<!-- pass 0 -->\n<!-- fail 0 -->\n<!-- cancelled 0 -->\n<!-- skipped 0 -->\n<!-- todo 0 -->\n</testsuites>';
  assert.deepEqual(nodeJunitSummary(describeOnly), { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0 });
  assert.equal(nodeJunitSummary('<testsuites><testcase name="x"/></testsuites>'), undefined, "no summary -> unknown");
  // N-R5-2: a runner without the JUnit reporter is unknown, not failed.
  assert.equal(reporterUnsupportedIn("TypeError [ERR_INVALID_ARG_VALUE]: The argument 'reporter' is invalid. Received 'junit'"), true);
  assert.equal(reporterUnsupportedIn("AssertionError: expected 1 to equal 2"), false);
  assert.equal(testsOutcome(1, { status: "unknown", runner: "node --test", reporterUnsupported: true }), "unknown");
  assert.equal(testsOutcome(1, { status: "unknown", runner: "node --test" }), "failed");
});

test("R6-B1: node's file-level entries for files without tests are not executed tests", async () => {
  const { nodeJunitTestCases } = await import("../src/delivery-execution.js");
  const checkout = process.platform === "win32" ? "C:\\work\\proj" : "/work/proj";
  const file = join(checkout, "test", "ok.test.mjs");
  const xml = `<testsuites>
<testcase name="${join("test", "ok.test.mjs")}" file="${file}"/>
<testcase name="ok.test.mjs" file="${file}"/>
<testcase name="value" classname="test" file="${file}"/>
<testcase name="fails" file="${file}"><failure message="x"/></testcase>
<!-- tests 4 --><!-- pass 3 --><!-- fail 1 -->
</testsuites>`;
  const cases = nodeJunitTestCases(xml, checkout);
  assert.deepEqual(cases.map((entry) => [entry.name.replaceAll("\\", "/"), entry.fileLevel, entry.failed]), [
    ["test/ok.test.mjs", true, false],
    ["ok.test.mjs", true, false],
    ["value", false, false],
    ["fails", false, true],
  ]);
});

test("N-R7-1: file-level entries named relative to a sibling cwd (../, ./) are recognised", async () => {
  const { nodeJunitTestCases } = await import("../src/delivery-execution.js");
  const checkout = process.platform === "win32" ? "C:\\work\\proj" : "/work/proj";
  const file = join(checkout, "test", "value.test.mjs");
  const sep = process.platform === "win32" ? "\\" : "/";
  const xml = `<testsuites>
<testcase name="..${sep}test${sep}value.test.mjs" file="${file}"/>
<testcase name="./test/value.test.mjs" file="${file}"/>
<testcase name="../../proj/test/value.test.mjs" file="${file}"/>
<testcase name="value" classname="test" file="${file}"/>
<!-- tests 4 --><!-- pass 4 --><!-- fail 0 -->
</testsuites>`;
  assert.deepEqual(nodeJunitTestCases(xml, checkout).map((entry) => entry.fileLevel), [true, true, true, false]);
});

test("R6-B1 (fast guard): file-level entries are subtracted from node's summary counts", async () => {
  const { nodeJunitOutcome } = await import("../src/delivery-execution.js");
  const checkout = process.platform === "win32" ? "C:\\work\\proj" : "/work/proj";
  const file = join(checkout, "test", "value.test.mjs");
  const onlyFileLevel = `<testsuites><testcase name="${join("test", "value.test.mjs")}" file="${file}"/>
<!-- tests 1 --><!-- pass 1 --><!-- fail 0 --></testsuites>`;
  // No filter: a file with no test() call is not an executed test (N-R5-1).
  const noTest = nodeJunitOutcome(onlyFileLevel, checkout, false);
  assert.equal(noTest.status, "unknown");
  assert.deepEqual(noTest.counts, { selected: 0, passed: 0, failed: 0, skipped: 0 });
  assert.match(noTest.reason!, /1 file-level entries/);
  // A name filter that selected nothing.
  const filtered = nodeJunitOutcome(onlyFileLevel, checkout, true);
  assert.equal(filtered.status, "unknown");
  assert.equal(filtered.counts!.selected, 0);
  assert.match(filtered.reason!, /filters tests by name/);
  // A real test next to a file-level entry passes, and only the real test is counted.
  const mixed = nodeJunitOutcome(`<testsuites><testcase name="${join("test", "empty.test.mjs")}" file="${join(checkout, "test", "empty.test.mjs")}"/>
<testcase name="value" classname="test" file="${file}"/>
<!-- tests 2 --><!-- pass 2 --><!-- fail 0 --></testsuites>`, checkout, true);
  assert.equal(mixed.status, "passed");
  assert.deepEqual(mixed.counts, { selected: 1, passed: 1, failed: 0, skipped: 0 });
  // A failing test fails whatever the file-level entries are.
  const failing = nodeJunitOutcome(`<testsuites><testcase name="value" file="${file}"><failure message="x"/></testcase>
<!-- tests 1 --><!-- pass 0 --><!-- fail 1 --></testsuites>`, checkout, false);
  assert.equal(failing.status, "failed");
  assert.equal(nodeJunitOutcome("<testsuites/>", checkout, false).status, "unknown");
});

test("N-R8 (fast guard): a filtered run needs at least one real test case, even if the summary over-reports", async () => {
  const { nodeJunitOutcome } = await import("../src/delivery-execution.js");
  const checkout = process.platform === "win32" ? "C:\\work\\proj" : "/work/proj";
  const file = join(checkout, "test", "value.test.mjs");
  // The summary says 2 tests passed, but the only testcase is one file-level entry.
  const xml = `<testsuites><testcase name="${join("test", "value.test.mjs")}" file="${file}"/>
<!-- tests 2 --><!-- pass 2 --><!-- fail 0 --></testsuites>`;
  const filtered = nodeJunitOutcome(xml, checkout, true);
  assert.equal(filtered.status, "unknown", "a filtered run with no real test case is not a pass");
  assert.match(filtered.reason!, /filters tests by name/);
  assert.equal(nodeJunitOutcome(xml, checkout, false).status, "passed", "without a filter the node summary is trusted");
});

test("B7: reviewOutcomeByAuthor keeps the first review's defect on its original author", async () => {
  const { reviewOutcomeByAuthor } = await import("../src/delivery-acceptance.js");
  const finding = { id: "f-1", category: "missing_coverage", severity: "blocking" as const, claim: "c is not tested.", evidenceRefs: ["src/feature.ts:3"] };
  const outcomes = reviewOutcomeByAuthor([
    { reviewId: "r1", authorModelIdentity: "model-original", findings: [finding] },
    { reviewId: "r2", authorModelIdentity: "model-fixer", findings: [] },
  ]);
  assert.deepEqual(outcomes, [
    { modelId: "model-original", defectFound: true },
    { modelId: "model-fixer", defectFound: false },
  ]);
  // A repeated entry never double-counts, and a clean history stays clean.
  assert.deepEqual(
    reviewOutcomeByAuthor([
      { reviewId: "r1", authorModelIdentity: "m", findings: [] },
      { reviewId: "r1", authorModelIdentity: "m", findings: [] },
    ]),
    [{ modelId: "m", defectFound: false }],
  );
});

test("real counts: acceptedFailuresUsed on a fix re-review reflects an accepted evidence failure", async () => {
  const { taskAcceptedFailuresUsed } = await import("../src/delivery-acceptance.js");
  assert.equal(taskAcceptedFailuresUsed([]), false);
  assert.equal(taskAcceptedFailuresUsed([{ criterionVerdicts: [{ acceptedFailures: [] }] }]), false);
  assert.equal(taskAcceptedFailuresUsed([{ criterionVerdicts: [{}] }, { criterionVerdicts: [{ acceptedFailures: [{ evidenceId: "e" }] }] }]), true);
});

test("real counts: the report plan enables only real reporter flags and names unsupported runners", async () => {
  const { planTestReport } = await import("../src/delivery-execution.js");
  const root = mkdtempSync(join(tmpdir(), "aiboard-report-plan-"));
  try {
    const plan = (script: string, dependencies: Record<string, string> = {}, platform: NodeJS.Platform = "linux") => {
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: script }, devDependencies: dependencies }));
      return planTestReport({ checkoutPath: root, command: { label: "package tests", executable: "node", args: ["npm-cli.js", "run", "test"] }, reportName: "abc", platform });
    };
    const node = plan("tsc && node --test test/*.test.js");
    assert.equal(node.runner, "node --test");
    // R5-B3: flags go through NODE_OPTIONS, so explicit globs cannot swallow them.
    assert.deepEqual(node.command!.args, ["npm-cli.js", "run", "test"]);
    // N-R6-2: an absolute, double-quoted, forward-slash destination.
    const destination = join(root, ".aiboard-report-abc.xml").replaceAll("\\", "/");
    assert.equal(node.command!.environment!.NODE_OPTIONS, `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination="${destination}"`);
    assert.equal(node.filtered, false);
    assert.equal(plan("node --test --test-name-pattern=value").filtered, true);
    assert.equal(plan("node --test --test-only").filtered, true);
    // N-R6-1: shell syntax the splitter does not model is refused (reviewer's shapes).
    assert.match(plan("node --test failing.mjs '|| node --test test/value.test.mjs '", {}, "win32").unsupported!, /shell character "'"/, "cmd.exe does not treat ' as a quote");
    assert.match(plan('node --test failing.mjs \\" || node --test ok.mjs # \\"').unsupported!, /shell character "\\"/);
    assert.match(plan("node --test $(node --test failing.mjs >/dev/null) ok.mjs").unsupported!, /shell character "\$"/);
    assert.match(plan("node --test `node --test failing.mjs` ok.mjs").unsupported!, /shell character "`"/);
    assert.match(plan("! node --test failing.mjs && node --test").unsupported!, /shell character "!"/);
    assert.match(plan("node --test ^& node --test", {}, "win32").unsupported!, /shell character "\^"/);
    assert.equal(plan("cd test && node --test").runner, "node --test", "plain && chains keep working");
    // R7-B1: tsx --test runs node's own test runner, so it gets the same NODE_OPTIONS report plan.
    for (const script of ["tsx --test", "tsx --test test/*.test.ts", "tsx.cmd --test", "npx tsx --test"]) {
      const tsx = plan(script);
      assert.equal(tsx.unsupported, undefined, script);
      assert.equal(tsx.runner, "node --test", script);
      assert.match(tsx.command!.environment!.NODE_OPTIONS!, /--test-reporter=junit --test-reporter-destination="/, script);
    }
    assert.equal(plan("tsx --test --test-name-pattern=value").filtered, true);
    assert.match(plan("tsx src/cli.ts").unsupported!, /not a test runner/, "tsx without --test is not a test runner");
    assert.equal("NODE_TEST_CONTEXT" in node.command!.environment!, true, "the child never inherits NODE_TEST_CONTEXT");
    assert.equal(node.command!.environment!.NODE_TEST_CONTEXT, undefined);
    // R5-B2: only && chains are judged.
    assert.match(plan("node --test failing.mjs || node --test").unsupported!, /joins commands with "\|\|"/);
    assert.match(plan("node --test a.mjs; node --test").unsupported!, /joins commands with ";"/);
    assert.match(plan("node --test | tee out.txt").unsupported!, /joins commands with "\|"/);
    assert.match(plan("node --test & node --test").unsupported!, /joins commands with "&"/);
    assert.equal(plan('echo "a || b" && node --test').runner, "node --test", "separators inside double quotes are not separators");
    assert.match(plan("node --test --test-reporter=dot").unsupported!, /own --test-reporter/);
    const withAmbient = (ambientNodeOptions: string) => {
      writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
      return planTestReport({ checkoutPath: root, command: { label: "package tests", executable: "node", args: ["npm-cli.js", "run", "test"] }, reportName: "abc", ambientNodeOptions });
    };
    assert.match(withAmbient("--max-old-space-size=4096").command!.environment!.NODE_OPTIONS!, /^--max-old-space-size=4096 --test-reporter=spec /, "the project's NODE_OPTIONS is kept");
    assert.match(withAmbient("--test-reporter=tap").unsupported!, /environment's NODE_OPTIONS sets its own --test-reporter/);
    assert.equal(plan("vitest run").command!.args.includes("--outputFile.junit=.aiboard-report-abc.xml"), true);
    assert.equal(plan("pytest -q").command!.args.at(-1), "--junitxml=.aiboard-report-abc.xml");
    assert.match(plan("jest").unsupported!, /jest-junit/);
    assert.match(plan("node -e 0").unsupported!, /not a test runner/);
    assert.equal(plan("mocha", { "mocha-junit-reporter": "1.0.0" }).runner, "mocha");
    assert.match(plan("go test ./...").unsupported!, /go test -json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
