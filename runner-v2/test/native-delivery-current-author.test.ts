import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
import { inspectEncodingDelta } from "../src/encoding-safety.js";
import {
  NativeDeliverableReviewRuntime,
  type DeliverableReviewInputs,
  type DeliveryDepthRunner,
} from "../src/native-deliverable-review.js";
import { ProviderHealthRegistry } from "../src/provider-health.js";
import { reviewChangeSetId, reviewRunnerSignals } from "../src/review-integrity.js";
import { RuntimeRouter, type AgentRuntimeCandidate, type VerifierSelectionInput } from "../src/runtime-router.js";
import {
  currentExplicitStartIdentity,
  rebuildSchedulerProjection,
  reduceSchedulerEvent,
  type NewSchedulerEvent,
  type SchedulerActorRole,
  type SchedulerEventType,
  type SchedulerProjection,
} from "../src/scheduler-store.js";
import { SqliteAgentSessionStore } from "../src/sqlite-agent-session-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { captureSubmissionScopeIdentity } from "../src/submission-scope-capture.js";
import { bindSubmissionScope } from "../src/submission-scope-contracts.js";
import { inspectSubmissionScope } from "../src/submission-guard.js";
import { localSubmissionClaim } from "../src/submission-guard-git.js";
import type { WorkerAssignment, WorkerOutcome, WorkerRuntimeDriver } from "../src/task-scheduler.js";
import { parseValidationScope } from "../src/validation-scope.js";
import { canonicalModelIdentity } from "../src/verifier-contracts.js";
import { commandEvidence } from "./support/evidence-fixtures.js";
import {
  buildPlanningFixtureScenario,
  FIXTURE_AMENDED_TEXT,
  type PlanningFixtureScenario,
} from "./fixtures/planning-source-fixture.js";

/**
 * T8 production repair: the deliverable reviewer must be selected with the
 * CURRENT submission's authors excluded, even though the kernel records them
 * only on the later delivery.review_started event. On a first review the
 * durable author map is empty, so a current worker that is also in the
 * verifier pool (E3/V1/V2 factory configs do this deliberately) was selected
 * as distinct_model and the kernel correctly refused it, pausing the run.
 *
 * Real SQLite stores, the real kernel reducer, the real
 * NativeDeliverableReviewRuntime tool loop and the real pump drive this test;
 * the approved-source and diff bytes are real immutable ArtifactStore
 * content. Patterns mirror delivery-acceptance (policy v1 submission) and
 * the E3 product journey (mixed author/verifier pool, forgery negatives).
 */

const RUN_ID = "run-native-delivery-current-author";

function event(type: SchedulerEventType | string, key: string, actor: { role: SchedulerActorRole; id: string }, payload: Record<string, unknown>): NewSchedulerEvent {
  return { runId: RUN_ID, type: type as SchedulerEventType, occurredAt: "2026-10-08T00:00:00.000Z", actor, idempotencyKey: key, payload };
}

function planningInputs(fixture: PlanningFixtureScenario): NewSchedulerEvent[] {
  return [
    event("project_docs.policy_configured", "project-docs-policy", { role: "runner", id: "build-runtime" }, { version: 2 }),
    event("run.initialized", "run-initialized", { role: "runner", id: "build-runtime" }, { testIntegrityPolicyVersion: 1, submissionScopePolicyVersion: 1, reviewIntegrityPolicyVersion: 1, encodingSafetyPolicyVersion: 1, reviewEvidencePolicyVersion: 1, validationScopePolicyVersion: 1, objective: "Prove current-author reviewer exclusion." }),
    event("planning.policy_configured", "planning-policy", { role: "runner", id: "build-runtime" }, { version: 1 }),
    event("run.policy_configured", "policy", { role: "runner", id: "build-runtime" }, { runPolicy: "finish" }),
    event("planning.source_registered", "source", { role: "user", id: "owner" }, { manifest: fixture.priorManifest }),
    event("planning.source_amended", "source-amendment", { role: "user", id: "owner" }, { manifest: fixture.manifest }),
    event("request.triaged", "triage", { role: "architect", id: "architect" }, { decision: "build", rationale: "Prove the exclusion." }),
    event("planning.ledger_persisted", "ledger", { role: "architect", id: "architect" }, { id: "ledger", requirements: fixture.requirements, phases: fixture.phases, nonNormativeSections: [] }),
    ...fixture.manifest.sections.map((section) => event("planning.source_section_read", `read:${section.id}`, { role: "architect", id: "architect" }, { manifestId: fixture.manifest.manifestId, manifestDigest: fixture.manifest.artifactDigest, sectionId: section.id, sectionDigest: section.digest, readAt: "2026-10-08T00:00:01.000Z" })),
    event("planning.plan_drafted", "plan", { role: "architect", id: "architect" }, { revision: fixture.revision, expectedRevisionId: null, expectedDigest: null }),
    event("planning.coverage_review_requested", "coverage-request", { role: "architect", id: "architect" }, { reviewId: fixture.coverageReview.id, planRevisionId: fixture.revision.revisionId, planRevisionDigest: fixture.revision.digest, sourceManifestId: fixture.manifest.manifestId, requestedAt: "2026-10-08T00:00:02.000Z" }),
    event("planning.coverage_obligations_recorded", "coverage-obligations", { role: "verifier", id: "coverage-reviewer" }, { reviewId: fixture.coverageReview.id, sourceManifestId: fixture.manifest.manifestId, sourceManifestDigest: fixture.manifest.artifactDigest, obligations: fixture.coverageReview.derivedObligations, sectionCoverage: fixture.manifest.sections.map((section) => ({ sectionId: section.id, obligationIds: fixture.coverageReview.derivedObligations.map((obligation) => obligation.id) })), recordedAt: "2026-10-08T00:00:03.000Z" }),
    event("planning.coverage_plan_delivered", "coverage-plan", { role: "runner", id: "build-runtime" }, { reviewId: fixture.coverageReview.id, planRevisionId: fixture.revision.revisionId, planRevisionDigest: fixture.revision.digest, sourceManifestId: fixture.manifest.manifestId, deliveredAt: "2026-10-08T00:00:04.000Z" }),
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

// E3-shaped identities: the failed coauthor, the successful current author,
// a canonical alias of the failed coauthor, and the independent reviewer.
// Every author/alias outranks the independent reviewer, exactly the
// production trap: without current-author exclusion the router returns the
// current worker as distinct_model.
const CANDIDATES: AgentRuntimeCandidate[] = [
  { runtimeId: "arch:architect", providerId: "arch", modelId: "architect", capabilities: ["code"], priority: 1 },
  { runtimeId: "workA:workerA", providerId: "workA", modelId: "workerA", capabilities: ["code"], priority: 2 },
  { runtimeId: "workB:workerB", providerId: "workB", modelId: "workerB", capabilities: ["code"], priority: 3 },
  { runtimeId: "aliasA:clone", providerId: "aliasA", modelId: "Acme/WorkerA", capabilities: ["code"], priority: 4 },
  { runtimeId: "rev:reviewer", providerId: "rev", modelId: "reviewer", capabilities: ["code"], priority: 5 },
];

const FAILED_COAUTHOR = "workA:workerA";
const CURRENT_AUTHOR = "workB:workerB";
const COAUTHOR_ALIAS = "aliasA:clone";
const INDEPENDENT_REVIEWER = "rev:reviewer";

// The verifier pool deliberately mixes authors and verifiers, like the E3
// factory config: the current worker and its alias are eligible candidates.
const REVIEWER_POOL = [FAILED_COAUTHOR, CURRENT_AUTHOR, COAUTHOR_ALIAS, INDEPENDENT_REVIEWER];

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

const FEATURE_BASELINE = "export const a = 1;\nexport const b = 2;\n";
const FEATURE_CANDIDATE = "export const a = 1;\nexport const b = 3;\nexport const c = a + b;\n";
const FEATURE_ADDED_LINES = ["export const b = 3;", "export const c = a + b;"];

type Pass = "obligations" | "findings" | "verdict";

class ScriptedReviewer implements AgentModel {
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    const system = request.messages.find((message) => message.role === "system");
    const pass = (system?.id.replace("delivery-", "").replace("-system", "") ?? "findings") as Pass;
    const text = request.messages.filter((message) => typeof message.content === "string").map((message) => message.content as string).join("\n");
    const toolResults = request.messages.filter((message) => message.role === "tool");
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
    if (!toolResults.some((message) => (message.content as { toolName?: string }).toolName === "fs.read")) {
      return call("fs.read", { path: "src/feature.ts" });
    }
    const claimIds = [...text.matchAll(/"id":\s*"(claim:[^"]+)"/g)].map((match) => match[1]!);
    return call("submit_deliverable_verdict", {
      summary: "Reviewed against the criteria.",
      satisfied: !/"severity":\s*"blocking"/.test(text.split("Your durably recorded findings:")[1]?.split("The worker's report")[0] ?? ""),
      claimVerdicts: [...new Set(claimIds)].map((claimId) => ({ claimId, status: "verified", rationale: "Checked.", citations: [{ path: "src/feature.ts", line: 1 }] })),
    });
  }
}

interface Harness {
  root: string;
  scheduler: SqliteSchedulerStore;
  evidence: SqliteEvidenceStore;
  artifacts: ArtifactStore;
  sessions: SqliteAgentSessionStore;
  runtime: BuildRuntime;
  review: NativeDeliverableReviewRuntime;
  verifierSelections: VerifierSelectionInput[];
  projection(): SchedulerProjection;
  close(): void;
}

/**
 * Records the durable post-failover state for attempt 1: the failed
 * coauthor workA was assigned first, then the successful current author
 * workB. The kernel appends both to workerAssignmentHistory["T1:1"] while
 * workerAssignments["T1:1"] names workB. (Failover mechanics themselves are
 * proven by the E3 factory failover journey; this models its durable
 * outcome at the actual review caller.)
 */
class FailoverWorkers implements WorkerRuntimeDriver {
  constructor(private readonly harness: Harness) {}
  async run(assignment: WorkerAssignment): Promise<WorkerOutcome> {
    const { task, attempt } = assignment;
    for (const [runtimeId, suffix] of [[FAILED_COAUTHOR, "a"], [CURRENT_AUTHOR, "b"]] as const) {
      const candidate = CANDIDATES.find((entry) => entry.runtimeId === runtimeId)!;
      this.harness.scheduler.append(event("worker.runtime_assigned", `runtime:${task.id}:${attempt}:${suffix}`, { role: "runner", id: "runtime-router" }, { taskId: task.id, attempt, runtimeId, sessionId: `session:${task.id}:${attempt}:${suffix}`, modelIdentity: canonicalModelIdentity(candidate.modelId) }));
    }
    const links: CriterionEvidenceLink[] = (task.acceptanceCriteria ?? []).map((criterion) => {
      const record = this.harness.evidence.record({ ...commandEvidence(`${task.id}:${criterion.id}:${attempt}`, { label: criterion.id }), runId: RUN_ID, taskId: task.id, attempt, actor: { role: "worker", id: assignment.workerId } });
      return { criterionId: criterion.id, evidenceId: record.id, artifactHashes: ["a".repeat(64)], taskId: task.id, attempt };
    });
    const live = rebuildSchedulerProjection(this.harness.scheduler.readRun(RUN_ID));
    const baselineRevision = live.tasks[task.id]!.workspaceBaselineRevision!;
    const taskRevision = createHash("sha256").update(`${RUN_ID}\0${task.id}\0${attempt}`).digest("hex");
    const changeSetId = reviewChangeSetId(RUN_ID, task.id, taskRevision);
    const scopeIdentity = captureSubmissionScopeIdentity(live, { runId: RUN_ID, taskId: task.id, attempt, workerId: assignment.workerId, sessionId: `session:${task.id}:${attempt}:b`, workspacePath: assignment.workspacePath, baselineRevision });
    assert.ok(scopeIdentity, "the new-policy run captures submission scope authority");
    const claimedPaths = localSubmissionClaim(scopeIdentity.claim, assignment.workspacePath).writableSurfaces.filter((surface) => surface !== "." && !surface.startsWith("resource:"));
    const submissionFiles = (claimedPaths.length > 0 ? claimedPaths : ["src/feature.ts"]).map((path) => ({ path, added: false }));
    const scopeFindings = inspectSubmissionScope(submissionFiles.map((file) => ({ ...file, addedLines: [] as string[] })), localSubmissionClaim(scopeIdentity.claim, assignment.workspacePath));
    assert.equal(scopeFindings.length, 0, "the fixture change stays inside its durable claim");
    const submissionScope = bindSubmissionScope(scopeIdentity, changeSetId, taskRevision, scopeFindings, submissionFiles);
    const reviewSignals = { version: 1 as const, runId: RUN_ID, taskId: task.id, baselineRevision, taskRevision, changeSetId, signals: reviewRunnerSignals(submissionFiles, new Map<string, string>(submissionFiles.map((file) => [file.path, FEATURE_CANDIDATE] as [string, string]))) };
    const featureEncoding = inspectEncodingDelta(submissionFiles[0]!.path, Buffer.from(FEATURE_BASELINE, "utf8"), Buffer.from(FEATURE_CANDIDATE, "utf8"), FEATURE_ADDED_LINES);
    assert.ok(featureEncoding, "the feature change is a text delta");
    const encodingSubmission = { version: 1 as const, runId: RUN_ID, taskId: task.id, baselineRevision, taskRevision, changeSetId, files: [featureEncoding] };
    const validationScope = parseValidationScope({
      changed: submissionFiles.map((file) => file.path),
      verified: [`criterion evidence links recorded for ${(task.acceptanceCriteria ?? []).map((criterion) => criterion.id).join(", ") || "no criteria"}`],
      testsRun: [],
      notRun: [{ what: "package test script", why: "the fixture worker records evidence without executing commands; delivery boundary checks run the suite" }],
    });
    return { type: "submitted", changeSetId, submissionScope, reviewSignals, encodingSubmission, validationScope, criterionEvidenceLinks: links };
  }
}

class TestArchitect implements ArchitectRuntimeDriver {
  constructor(private readonly harness: Harness) {}
  async run(request: ArchitectActionRequest): Promise<void> {
    const store = this.harness.scheduler;
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
    throw new Error(`Unexpected Architect reason ${request.reason.type}.`);
  }
}

async function createHarness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-current-author-"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const scheduler = new SqliteSchedulerStore(join(root, "scheduler.sqlite"), { evidenceStore: evidence, artifacts });
  const sessions = new SqliteAgentSessionStore(join(root, "sessions.sqlite"), artifacts);
  const ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
  let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 9, 8, 0, 0, 0, tick++ * 10)).toISOString();
  const scenario = fixtureScenario();
  for (const input of planningInputs(scenario)) scheduler.append(input);
  {
    const startIdentity = currentExplicitStartIdentity(rebuildSchedulerProjection(scheduler.readRun(RUN_ID)));
    assert.ok(startIdentity, "the seeded ready plan has an exact owner-start identity");
    scheduler.append(event("planning.execution_authorized", "owner-start:1", { role: "user", id: "local-user" }, {
      authorization: { ...startIdentity, version: 1, ownerChoice: "execute" },
    }));
  }
  // The pump verifies the current source artifact authority from real
  // bytes: the exact fixture bytes hash to the manifest digest. No
  // verifySync stub stands in for stored content anywhere in this file.
  const stored = await artifacts.put(Buffer.from(FIXTURE_AMENDED_TEXT, "utf8"), "text/plain", "approved source");
  assert.equal(stored.hash, scenario.manifest.artifactDigest, "the stored source bytes are the manifest authority");
  const router = new RuntimeRouter({ health: new ProviderHealthRegistry(), candidates: CANDIDATES });
  const verifierSelections: VerifierSelectionInput[] = [];
  const reviewer = new ScriptedReviewer();
  const workspaceRoot = join(root, "review-workspace");
  const harness = { root, scheduler, evidence, artifacts, sessions, verifierSelections } as unknown as Harness;
  const review = new NativeDeliverableReviewRuntime({
    store: scheduler,
    architectRuntimeId: "arch:architect",
    router: {
      selectVerifier: (input: VerifierSelectionInput) => {
        verifierSelections.push(structuredClone(input));
        return router.selectVerifier(input);
      },
    },
    candidates: CANDIDATES,
    models: new Map(CANDIDATES.map((candidate) => [candidate.runtimeId, reviewer])),
    reviewerRuntimeIds: REVIEWER_POOL,
    sessions,
    ledger,
    artifacts,
    evidenceStore: evidence,
    loadInputs: async ({ task, projection }): Promise<DeliverableReviewInputs> => {
      const diffText = `${DIFF}\n# ${task.id} attempt ${task.attempt}`;
      const diff = await artifacts.put(Buffer.from(diffText), "text/x-diff", "diff");
      const criteria = (task.acceptanceCriteria ?? []).map((criterion) => ({ id: criterion.id, text: criterion.text }));
      return {
        taskId: task.id,
        attempt: task.attempt,
        changeSetId: task.changeSetId!,
        baselineRevision: task.workspaceBaselineRevision!,
        taskRevision: task.submissionScope!.taskRevision,
        diffArtifactHash: diff.hash,
        diffText,
        changedPaths: ["src/feature.ts"],
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
    depth: {
      run: async () => {
        throw new Error("No high-tier depth runner in this harness.");
      },
    } as unknown as DeliveryDepthRunner,
    clock,
  });
  const runtime = new BuildRuntime({
    runId: RUN_ID,
    store: scheduler,
    workerDriver: new FailoverWorkers(harness),
    architectDriver: new TestArchitect(harness),
    integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: `01${"f".repeat(38)}` }) } as IntegrationRuntimeDriver,
    deliveryReview: review,
    deliveryBoundary: { check: async () => { throw new Error("no boundary in the current-author harness"); } } as unknown as DeliveryBoundaryDriver,
    maxConcurrency: 1,
    workspaceFor: async (task, attempt) => ({ path: join(root, "work", task.id), workspaceId: `workspace:${task.id}:${attempt}`, baselineRevision: rebuildSchedulerProjection(scheduler.readRun(RUN_ID)).integrationRevision ?? "0".repeat(40) }),
    clock,
    evidenceStore: evidence,
    architectId: "arch:architect",
    artifacts,
  });
  Object.assign(harness, {
    runtime,
    review,
    projection: () => rebuildSchedulerProjection(scheduler.readRun(RUN_ID)),
    close: () => {
      scheduler.close();
      evidence.close();
      sessions.close();
      ledger.close();
      rmSync(root, { recursive: true, force: true });
    },
  });
  return harness;
}

async function stepUntilSubmitted(harness: Harness): Promise<SchedulerProjection> {
  for (let step = 0; step < 120; step += 1) {
    const projection = harness.projection();
    if (projection.tasks.T1?.status === "submitted") return projection;
    if (projection.status === "paused" || projection.status === "failed") {
      throw new Error(`Run ${projection.status} before submission: ${JSON.stringify(projection.pauseReason)}`);
    }
    await harness.runtime.step();
  }
  throw new Error("Submission not reached");
}

test("current attempt authors are excluded from distinct_model reviewer selection", async () => {
  const harness = await createHarness();
  try {
    const submitted = await stepUntilSubmitted(harness);
    // The first review starts with no durable author map at all: the
    // kernel records authors only on delivery.review_started.
    const preAuthorKeys = Object.keys(submitted.delivery?.authorModelIdentities ?? {});
    assert.equal(submitted.delivery, undefined, "no delivery state exists before the first review");
    assert.deepEqual(preAuthorKeys, []);
    // The current attempt carries a failed prior coauthor plus the
    // successful current author, exactly the E3 failover durable shape.
    const history = submitted.runtime.workerAssignmentHistory?.["T1:1"] ?? [];
    assert.deepEqual(history.map((entry) => entry.runtimeId), [FAILED_COAUTHOR, CURRENT_AUTHOR]);
    assert.equal(history[0]?.modelIdentity, "workera");
    assert.equal(history[1]?.modelIdentity, "workerb");
    assert.equal(submitted.runtime.workerAssignments["T1:1"]?.runtimeId, CURRENT_AUTHOR);
    assert.equal(canonicalModelIdentity("Acme/WorkerA"), "workera", "the alias shares the failed coauthor identity");
    // Every author/alias outranks the independent reviewer and is an
    // eligible pool candidate, so only current-author exclusion can
    // select the independent reviewer.
    const priorityOf = (runtimeId: string): number => CANDIDATES.find((candidate) => candidate.runtimeId === runtimeId)!.priority;
    assert.deepEqual([...REVIEWER_POOL].sort(), [COAUTHOR_ALIAS, FAILED_COAUTHOR, CURRENT_AUTHOR, INDEPENDENT_REVIEWER].sort());
    assert.ok(priorityOf(FAILED_COAUTHOR) < priorityOf(INDEPENDENT_REVIEWER));
    assert.ok(priorityOf(CURRENT_AUTHOR) < priorityOf(INDEPENDENT_REVIEWER));
    assert.ok(priorityOf(COAUTHOR_ALIAS) < priorityOf(INDEPENDENT_REVIEWER));

    const result = await harness.review.review({ runId: RUN_ID, taskId: "T1" });
    assert.equal(result.status, "reviewed", `expected a completed review, got ${JSON.stringify(result)}`);
    assert.equal(result.status === "reviewed" ? result.runtimeId : undefined, INDEPENDENT_REVIEWER);
    assert.equal(result.status === "reviewed" ? result.independence : undefined, "distinct_model");
    assert.equal(result.status === "reviewed" ? result.replayed : undefined, false);
    // The caller passed the current attempt authors to the router even
    // though the durable map was empty when selection ran.
    assert.ok(harness.verifierSelections.length >= 1, "the router was consulted");
    assert.deepEqual([...harness.verifierSelections[0]!.acceptedChangeAuthorRuntimeIds].sort(), [FAILED_COAUTHOR, CURRENT_AUTHOR].sort());

    const reviewed = harness.projection();
    const durable = reviewed.delivery?.reviews.T1;
    assert.equal(durable?.reviewerRuntimeId, INDEPENDENT_REVIEWER);
    assert.equal(durable?.independence, "distinct_model");
    assert.equal(durable?.authorRuntimeId, CURRENT_AUTHOR);
    assert.equal(reviewed.delivery?.authorModelIdentities[FAILED_COAUTHOR], "workera");
    assert.equal(reviewed.delivery?.authorModelIdentities[CURRENT_AUTHOR], "workerb");
    assert.equal(durable?.stage, "completed");
  } finally {
    harness.close();
  }
});

test("kernel still refuses forged distinct_model reviewers for current authors and aliases", async () => {
  const harness = await createHarness();
  try {
    await stepUntilSubmitted(harness);
    const result = await harness.review.review({ runId: RUN_ID, taskId: "T1" });
    assert.equal(result.status, "reviewed", `expected a completed review, got ${JSON.stringify(result)}`);
    const events = harness.scheduler.readRun(RUN_ID);
    const requestedIndex = events.findIndex((entry) => entry.type === "delivery.review_requested");
    assert.ok(requestedIndex > 0, "a review was requested");
    const requested = events[requestedIndex]!;
    const beforeRequest = rebuildSchedulerProjection(events.slice(0, requestedIndex));
    // Same-runtime forgery, failed-coauthor forgery and canonical-alias
    // forgery all stay impossible as distinct_model.
    for (const [runtimeId, modelIdentity] of [[CURRENT_AUTHOR, "workerb"], [FAILED_COAUTHOR, "workera"], [COAUTHOR_ALIAS, "workera"]] as const) {
      assert.throws(
        () => reduceSchedulerEvent(beforeRequest, { ...requested, payload: { ...requested.payload, reviewerRuntimeId: runtimeId, reviewerModelIdentity: modelIdentity, independence: "distinct_model" } }),
        /Self-review is impossible/,
        `${runtimeId} must stay refused as distinct_model`,
      );
    }
  } finally {
    harness.close();
  }
});
