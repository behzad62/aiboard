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
import {
  NativeDeliverableReviewRuntime,
  type DeliverableReviewInputs,
  type DeliveryDepthRunner,
} from "../src/native-deliverable-review.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import { RuntimeRouter, type AgentRuntimeCandidate } from "../src/runtime-router.js";
import {
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
  buildPlanningFixtureScenario,
  type PlanningFixtureScenario,
} from "./fixtures/planning-source-fixture.js";
import { commandEvidence } from "./support/evidence-fixtures.js";

/**
 * T6b repair cycle 3 (R3-B1): the delivery-boundary issue identity is per
 * task and per failing check (plus the failing test ids when known),
 * through one shared helper used by the kernel dispatch gate and the
 * Architect resolve tool — against real SQLite stores, an advancing clock,
 * the real kernel reducer, the real NativeDeliverableReviewRuntime tool
 * loop, and the real pump. Inverted from review-r3 PROBE-J3, which showed
 * unrelated tasks sharing one `delivery-boundary:<check>` budget, so
 * that after T1, T2 and T3 each failed once, T4's FIRST boundary failure
 * paused the run as exhausted.
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
  depth?: DeliveryDepthRunner;
  architectRuntimeId?: string;
  repairPlanLimit?: number;
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
    ...(options.repairPlanLimit !== undefined ? { repairPlanLimit: options.repairPlanLimit } : {}),
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

test("R3-B1: unrelated tasks' boundary failures charge per-task issues; no false exhaustion pause", async () => {
  // The run-level repair-plan budget is raised so the per-issue budget is
  // what is under test (four tasks x two checks each charge one cycle).
  const harness = createHarness({ repairPlanLimit: 12, boundaryOutcome: (taskId, call) => (!taskId.endsWith("-fix") && call === 1 ? "failed" : "passed") });
  const architect = (harness as unknown as { architect: { run: (request: ArchitectActionRequest) => Promise<void> } }).architect;
  const original = architect.run.bind(architect);
  architect.run = async (request: ArchitectActionRequest) => {
    if (request.reason.type !== "delivery_boundary_failed") return original(request);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (request as any).tools;
    const reason = request.reason as { taskId: string; boundaryId: string };
    const boundary = request.projection.delivery!.boundaries[reason.taskId]!.at(-1)!;
    const all = request.projection.repairIssues ?? {};
    for (const [id, issue] of Object.entries(all)) {
      if (!(issue as { rootCause: string }).rootCause.startsWith("delivery-boundary:")) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const decision = await tools.invoke({ type: "tool_call", callId: `dec-${reason.taskId}-${id}`, name: "record_repair_approach_decision", arguments: { issueId: id, approachId: `b-${reason.taskId}`, repeat: false, hypothesis: `fix ${reason.taskId}`, diagnosticSet: [], evidenceIds: boundary.checks.flatMap((c) => c.evidenceIds) } }, (request as any).context);
      assert.equal((decision as { isError?: boolean }).isError, false, `decision for ${(issue as { rootCause: string }).rootCause} accepted`);
    }
    const resolve = await tools.invoke({ type: "tool_call", callId: `res-${reason.taskId}`, name: "resolve_delivery_boundary_failure", arguments: {
      taskId: reason.taskId, boundaryId: reason.boundaryId, resolution: "repair_planned", rationale: "Fix the failing test.",
      revision: request.projection.planRevision + 1,
      tasks: [{ id: `${reason.taskId}-fix`, objective: `Fix ${reason.taskId}.`, dependencies: [], requiredCapabilities: ["code"], acceptanceCriteria: [{ id: "fix-1", text: "Tests pass." }] }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } }, (request as any).context);
    assert.equal((resolve as { isError?: boolean }).isError, false, `resolve for ${reason.taskId} dispatched`);
  };
  try {
    // T6b repair (R3-B1): four tasks each fail their boundary once and are
    // fixed. Acceptance of all four is the assertion: under the old
    // category-only identity T4's FIRST boundary failure paused the run as
    // exhausted (until throws on a pause before the condition). Final
    // verification afterwards is out of scope for this boundary regression.
    await harness.until((p) => ["T1", "T2", "T3", "T4"].every((taskId) => p.delivery?.taskAcceptances[taskId] !== undefined), 400);
    const p = harness.projection();
    assert.equal(p.status, "running");
    const issues = Object.values(p.repairIssues ?? {});
    assert.ok(issues.length >= 2, "boundary issues were opened and charged");
    for (const issue of issues) {
      assert.match(issue.rootCause, /^delivery-boundary:[^:]+:[^:]+/, `per-task identity, got ${issue.rootCause}`);
      assert.equal(issue.used, 1, `${issue.rootCause} charged exactly once`);
    }
    assert.ok(issues.every((issue) => issue.rootCause !== "delivery-boundary:build" && issue.rootCause !== "delivery-boundary:tests"), "no category-only identity remains");
    for (const taskId of ["T1", "T2", "T3", "T4"]) {
      assert.ok(p.delivery?.taskAcceptances[taskId] !== undefined, `${taskId} accepted`);
    }
  } finally {
    harness.close();
  }
});

test("R3-B1: one task's repeated boundary failures charge its own issue; the fourth pauses", async () => {
  const harness = createHarness({ boundaryOutcome: (taskId) => (taskId === "T1" ? "failed" : "passed") });
  // Only T1 flows; every other planned task stays cancelled.
  const planned = Object.keys(harness.projection().tasks);
  for (const taskId of planned) {
    if (taskId === "T1") continue;
    harness.scheduler.append(event("task.transitioned", `cancel:${taskId}`, { role: "architect", id: "architect" }, { taskId, status: "cancelled" }));
  }
  const observed: Array<{ round: number; decisionIsError?: boolean; resolveIsError?: boolean }> = [];
  let round = 0;
  const architect = (harness as unknown as { architect: { run: (request: ArchitectActionRequest) => Promise<void> } }).architect;
  const original = architect.run.bind(architect);
  architect.run = async (request: ArchitectActionRequest) => {
    if (request.reason.type !== "delivery_boundary_failed") return original(request);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (request as any).tools;
    const reason = request.reason as { taskId: string; boundaryId: string };
    assert.equal(reason.taskId, "T1");
    round += 1;
    const boundary = request.projection.delivery!.boundaries[reason.taskId]!.at(-1)!;
    const checkEvidence = [...new Set(boundary.checks.flatMap((c) => c.evidenceIds))];
    // Fresh diagnostic evidence every round: a repeat decision must cite
    // evidence NEW to every prior approach (R2-B3 still holds per issue).
    const diag = harness.evidence.record({ ...commandEvidence(`t6b-boundary-r3b1:T1:diag:${round}`, { label: "diag", exitCode: 0 }), runId: RUN_ID, taskId: "delivery:T1", actor: { role: "verifier", id: "t6b-boundary-diag" } });
    const all = request.projection.repairIssues ?? {};
    for (const [id, issue] of Object.entries(all)) {
      if (!(issue as { rootCause: string }).rootCause.startsWith("delivery-boundary:T1:")) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const decision = await tools.invoke({ type: "tool_call", callId: `dec-T1-${round}-${id}`, name: "record_repair_approach_decision", arguments: { issueId: id, approachId: `t1-b-${round}`, repeat: false, hypothesis: `fix T1 boundary round ${round}`, diagnosticSet: [diag.id], evidenceIds: [diag.id, ...checkEvidence] } }, (request as any).context);
      observed.push({ round, decisionIsError: (decision as { isError?: boolean }).isError });
      assert.equal((decision as { isError?: boolean }).isError, false, `round ${round}: decision accepted`);
    }
    const resolve = await tools.invoke({ type: "tool_call", callId: `res-T1-${round}`, name: "resolve_delivery_boundary_failure", arguments: {
      taskId: reason.taskId, boundaryId: reason.boundaryId, resolution: "repair_planned", rationale: "Fix the failing test.",
      revision: request.projection.planRevision + 1,
      tasks: [{ id: `T1-repair-${round}`, objective: `Fix T1 (round ${round}).`, dependencies: [], requiredCapabilities: ["code"], acceptanceCriteria: [{ id: "fix-1", text: "Tests pass." }] }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } }, (request as any).context);
    const resolveIsError = (resolve as { isError?: boolean }).isError;
    for (const entry of observed) if (entry.round === round) entry.resolveIsError = resolveIsError;
    assert.equal((resolve as { isError?: boolean }).isError, false, `round ${round}: resolve dispatched`);
  };
  try {
    await harness.until((p) => p.status === "paused" || p.status === "completed", 400);
    const p = harness.projection();
    // Three repair rounds dispatch against T1's own issues; the fourth
    // pauses on the exhausted per-task budget instead of retrying.
    assert.equal(round, 3, `three repair rounds dispatched, got ${round}`);
    assert.equal(p.status, "paused", `run pauses on exhaustion, got ${p.status}`);
    const t1Issues = Object.values(p.repairIssues ?? {}).filter((issue) => issue.rootCause.startsWith("delivery-boundary:T1:"));
    assert.equal(t1Issues.length, 2, `T1 owns its build and tests issues, got ${JSON.stringify(t1Issues.map((i) => i.rootCause))}`);
    for (const issue of t1Issues) assert.equal(issue.used, 3, `${issue.rootCause} used 3/3`);
    assert.match(p.pauseReason?.reason ?? "", /^repair_issue_paused:/);
    const pausedIssue = (p.pauseReason?.reason ?? "").replace("repair_issue_paused:", "");
    assert.ok(t1Issues.some((issue) => issue.issueId === pausedIssue), "the pause names T1's own issue");
    assert.ok(observed.every((entry) => entry.decisionIsError === false && entry.resolveIsError === false));
  } finally {
    harness.close();
  }
});

/**
 * T6b repair cycle 4 (R4-B1): a multi-member boundary dispatch validates
 * every member before charging any. Deciding one of two failed checks then
 * resolving must refuse with NOTHING charged; deciding the second then
 * resolving dispatches with each member charged once; retrying after a new
 * decision must never hit a charge-key idempotency conflict. Committed from
 * review-r4 PROBE-R4-PARTIAL, which is red on the cycle-3
 * check-and-charge-per-member order. Real SQLite stores, real kernel
 * reducer, real tools, real pump.
 */
test("R4-B1: partial member decisions refuse without charging; full decisions dispatch once; retry has no idempotency conflict", async () => {
  const harness = createHarness({ repairPlanLimit: 12, boundaryOutcome: (taskId, call) => (taskId === "T1" && call === 1 ? "failed" : "passed") });
  const observed: Record<string, unknown>[] = [];
  const architect = (harness as unknown as { architect: { run: (request: ArchitectActionRequest) => Promise<void> } }).architect;
  const evidenceStore = (harness as unknown as { evidence: SqliteEvidenceStore }).evidence;
  const original = architect.run.bind(architect);
  const state: {
    resolve1?: Record<string, unknown>;
    usedBuildAfter1?: number;
    usedTestsAfter1?: number;
    resolve2?: Record<string, unknown>;
    resolve3?: Record<string, unknown>;
  } = {};
  let turns = 0;
  architect.run = async (request: ArchitectActionRequest) => {
    if (request.reason.type !== "delivery_boundary_failed") return original(request);
    turns += 1;
    if (turns > 1) { observed.push({ turn: turns, note: "re-invoked" }); }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = (request as any).tools;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = (request as any).context;
    const reason = request.reason as { taskId: string; boundaryId: string };
    const boundary = request.projection.delivery!.boundaries[reason.taskId]!.at(-1)!;
    const all = Object.entries(request.projection.repairIssues ?? {}).filter(([, issue]) =>
      (issue as { rootCause: string }).rootCause.startsWith(`delivery-boundary:${reason.taskId}:`));
    const buildIssue = all.find(([, issue]) => (issue as { rootCause: string }).rootCause.includes(":build"))?.[0];
    const testsIssue = all.find(([, issue]) => (issue as { rootCause: string }).rootCause.includes(":tests"))?.[0];
    const checkEvidence = boundary.checks.flatMap((check) => check.evidenceIds);
    const resolveArgs = {
      taskId: reason.taskId, boundaryId: reason.boundaryId, resolution: "repair_planned", rationale: "Fix the failing checks.",
      revision: request.projection.planRevision + 1,
      tasks: [{ id: `${reason.taskId}-fix`, objective: `Fix ${reason.taskId}.`, dependencies: [], requiredCapabilities: ["code"], acceptanceCriteria: [{ id: "fix-1", text: "Checks pass." }] }],
    };
    const call = async (name: string, args: unknown, id: string) => {
      try {
        const out = await tools.invoke({ type: "tool_call", callId: id, name, arguments: args }, ctx);
        return { isError: (out as { isError?: boolean }).isError === true, text: JSON.stringify((out as { content?: unknown }).content).slice(0, 220) };
      } catch (error) { return { threw: (error as Error).message.slice(0, 220) }; }
    };
    const used = () => Object.fromEntries(Object.entries(harness.projection().repairIssues ?? {}).map(([id, issue]) => [id === buildIssue ? "build" : id === testsIssue ? "tests" : id, `${(issue as { used: number }).used}:${(issue as unknown as { approaches: Array<{ approachId: string; failed: boolean; dispatched: boolean }> }).approaches.map((a) => `${a.approachId}/f=${a.failed}/d=${a.dispatched}`).join("|")}`]));
    observed.push({ step: "issues", buildIssue: !!buildIssue, testsIssue: !!testsIssue });
    observed.push({ step: "decide-build", r: await call("record_repair_approach_decision", { issueId: buildIssue, approachId: "a-build", repeat: false, hypothesis: "fix build", diagnosticSet: [], evidenceIds: checkEvidence }, "d1") });
    state.resolve1 = await call("resolve_delivery_boundary_failure", resolveArgs, "r1");
    observed.push({ step: "resolve-1", r: state.resolve1, used: used() });
    const afterPartial = harness.projection().repairIssues ?? {};
    state.usedBuildAfter1 = (afterPartial[buildIssue!] as { used: number } | undefined)?.used;
    state.usedTestsAfter1 = (afterPartial[testsIssue!] as { used: number } | undefined)?.used;
    observed.push({ step: "decide-tests", r: await call("record_repair_approach_decision", { issueId: testsIssue, approachId: "a-tests", repeat: false, hypothesis: "fix tests", diagnosticSet: [], evidenceIds: checkEvidence }, "d2") });
    state.resolve2 = await call("resolve_delivery_boundary_failure", resolveArgs, "r2");
    observed.push({ step: "resolve-2", r: state.resolve2, used: used() });
    const fresh = evidenceStore.record({ ...commandEvidence("diag:fresh-build", { label: "diag", exitCode: 1 }), runId: RUN_ID, taskId: `delivery:${reason.taskId}`, actor: { role: "verifier", id: "delivery-check-runtime" } });
    observed.push({ step: "decide-build-again-fresh", r: await call("record_repair_approach_decision", { issueId: buildIssue, approachId: "a-build-2", repeat: false, hypothesis: "fix build differently", diagnosticSet: [], evidenceIds: [fresh.id] }, "d3") });
    state.resolve3 = await call("resolve_delivery_boundary_failure", resolveArgs, "r3");
    observed.push({ step: "resolve-3", r: state.resolve3, used: used() });
  };
  try {
    let error: string | undefined;
    try { await harness.until((p) => p.tasks["T1-fix"] !== undefined, 60); } catch (e) { error = (e as Error).message; }
    const p = harness.projection();
    console.log("PROBE-R4-PARTIAL", JSON.stringify({ observed, error, fix: p.tasks["T1-fix"] !== undefined, status: p.status, pause: p.pauseReason ?? null }, null, 1).slice(0, 4000));
    assert.equal(error, undefined, `run reaches the T1-fix dispatch, got: ${error}`);
    assert.equal((state.resolve1 as { isError?: boolean } | undefined)?.isError, true, "resolve with one of two decisions is refused");
    assert.equal(state.usedBuildAfter1, 0, "refused dispatch charges build nothing");
    assert.equal(state.usedTestsAfter1, 0, "refused dispatch charges tests nothing");
    assert.equal((state.resolve2 as { isError?: boolean } | undefined)?.isError, false, "resolve with both decisions dispatches");
    assert.ok(p.tasks["T1-fix"], "after both members hold a decision, the boundary repair is dispatchable");
    const issues = Object.values(p.repairIssues ?? {}).filter((issue) => issue.rootCause.startsWith("delivery-boundary:T1:"));
    assert.equal(issues.length, 2, "two member issues");
    for (const issue of issues) assert.equal(issue.used, 1, `${issue.rootCause} charged exactly once`);
    assert.ok(!JSON.stringify(state.resolve3).includes("idempotency conflict"), `retry after a new decision has no idempotency conflict, got ${JSON.stringify(state.resolve3).slice(0, 220)}`);
  } finally {
    harness.close();
  }
});
